import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attemptRepairSchema,
  developerBlockerReportSchema,
  developerExecutionCycleSchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSourceSchema,
  taskSchema,
  workspaceSchema,
  type Project,
  type Task,
  type TaskActor,
} from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';
import {
  AttemptReconciliationRequiredError,
  AttemptStartFailedError,
  type ProjectRunAttemptLaunchInput,
} from './attempt-service.js';
import { ProjectRunService } from './project-run-service.js';
import { selectEligibleRunTasks } from './project-run-policy.js';

const now = '2026-08-27T00:00:00.000Z';
const human = taskActorSchema.parse({ type: 'human', id: 'operator-1' });
const agent = taskActorSchema.parse({ type: 'agent', id: 'agent-1' });

const disposals: Array<() => void> = [];
const serviceRepositories = new WeakMap<
  ProjectRunService,
  ReturnType<typeof createTestRepositories>
>();

afterEach(() => {
  while (disposals.length > 0) disposals.pop()?.();
});

const createProject = (overrides: Partial<Project> = {}) =>
  projectSchema.parse({
    id: 'project-1',
    displayName: 'Project one',
    repositoryPath: 'C:/repo/project-one',
    discoveredAt: now,
    discoveryMetadata: {},
    qaConfiguration: {
      instructions: {
        content: 'Review every change.',
        revision: 1,
        updatedAt: now,
        updatedBy: null,
      },
      reviewPolicy: 'autonomous_review',
      revision: 7,
      updatedAt: now,
      updatedBy: null,
    },
    ...overrides,
  });

const createTask = (
  projectId: string,
  id: string,
  overrides: Partial<Task> = {},
) =>
  taskSchema.parse({
    id,
    projectId,
    title: id,
    description: '',
    acceptanceCriteria: [],
    priority: 'normal',
    rank: 'm',
    lifecycleState: 'ready',
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    reviewAutomation: {
      status: 'enabled',
      generation: 3,
      rejectionCount: 0,
      pauseReason: null,
      updatedAt: now,
    },
    ...overrides,
  });

const setup = (options?: {
  canLaunch?: () => boolean;
  failProjectEventInsert?: boolean;
  maxConcurrency?: number;
  onAuditFailure?: (error: unknown) => void;
  scheduleDrain?: (runId: string) => void;
  launchAttempt?: (input: ProjectRunAttemptLaunchInput) => Promise<{
    attempt: ReturnType<
      ReturnType<typeof createTestRepositories>['attempts']['createForTask']
    >;
    session: ReturnType<
      ReturnType<typeof createTestRepositories>['sessions']['create']
    >;
  }>;
}) => {
  const repositories = createTestRepositories({
    failProjectEventInsert: options?.failProjectEventInsert,
  });
  disposals.push(repositories.dispose);
  const project = repositories.projects.create(createProject());
  const publisher = { publishProject: vi.fn() };
  let id = 0;
  let launch = 0;
  const launchAttempt = vi.fn(
    options?.launchAttempt ??
      (async (input: ProjectRunAttemptLaunchInput) => {
        const task = repositories.tasks.get(input.taskId);
        if (!task) throw new Error('Expected launch task');
        const ordinal = ++launch;
        const workspace = repositories.workspaces.create(
          workspaceSchema.parse({
            id: `launch-workspace-${ordinal}`,
            projectId: task.projectId,
            type: 'shared',
            path: input.workspace.path,
          }),
        );
        const session = repositories.sessions.create(
          sessionSchema.parse({
            id: `launch-session-${ordinal}`,
            projectId: task.projectId,
            workspaceId: workspace.id,
            title: input.title,
            permissionMode: input.permissionMode,
            lifecycleState: 'running',
            createdAt: now,
            updatedAt: now,
          }),
        );
        const attempt = repositories.attempts.createForTask(
          task.id,
          session.id,
          taskAttemptSourceSchema.parse(input.source),
          taskActorSchema.parse({
            type: 'system',
            id: `project-run:${input.source.runId}:${input.source.runItemId}`,
          }),
          'developer',
        );
        return { attempt, session };
      }),
  );
  const service = new ProjectRunService({
    ...repositories,
    attemptService: { launchAttempt },
    publisher,
    canLaunch: options?.canLaunch,
    maxConcurrency: options?.maxConcurrency,
    onAuditFailure: options?.onAuditFailure,
    scheduleDrain: options?.scheduleDrain,
    now: () => now,
    createId: () => `generated-${++id}`,
  });
  serviceRepositories.set(service, repositories);
  return { launchAttempt, repositories, project, publisher, service };
};

const expectCode = (execute: () => unknown, code: string) => {
  try {
    execute();
    throw new Error(`Expected '${code}'`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
};

const startRun = (
  service: ProjectRunService,
  projectId: string,
  idempotencyKey = 'start-run-1',
  concurrency = 2,
  actor: TaskActor = human,
) => {
  const repositories = serviceRepositories.get(service);
  const project = repositories?.projects.get(projectId);
  if (!repositories || !project) throw new Error('Missing test repositories');
  const tasks = repositories.tasks.listByProject(projectId);
  const currentAttemptTaskIds = new Set(
    tasks
      .filter((task) =>
        repositories.attempts
          .listByTask(task.id)
          .some(({ unlinkedAt }) => unlinkedAt === null),
      )
      .map(({ id }) => id),
  );
  const expectedTasks = selectEligibleRunTasks({
    project,
    tasks,
    currentAttemptTaskIds,
  }).map(({ task }) => ({ taskId: task.id, revision: task.revision }));
  return service.startRun({
    projectId,
    concurrency,
    expectedTasks,
    actor,
    idempotencyKey,
  });
};

describe('ProjectRunService startRun', () => {
  it('rejects a changed eligible selection before creating a run', () => {
    const { repositories, project, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-a'));
    repositories.tasks.create(createTask(project.id, 'task-b'));

    expectCode(
      () =>
        service.startRun({
          projectId: project.id,
          concurrency: 1,
          expectedTasks: [
            { taskId: 'task-b', revision: 1 },
            { taskId: 'task-a', revision: 1 },
          ],
          actor: human,
          idempotencyKey: 'stale-preview',
        }),
      'project_run_stale',
    );
    expect(repositories.projectRuns.listByProject(project.id)).toEqual([]);
  });

  it('freezes eligible tasks in stable rank order with policy snapshots', () => {
    const { repositories, project, publisher, service } = setup();
    repositories.tasks.create(
      createTask(project.id, 'rank-b', { rank: 'b', revision: 4 }),
    );
    repositories.tasks.create(
      createTask(project.id, 'rank-a', {
        rank: 'a',
        revision: 2,
        reviewAutomation: {
          status: 'paused',
          generation: 9,
          rejectionCount: 2,
          pauseReason: 'operator_paused',
          updatedAt: now,
        },
      }),
    );
    repositories.tasks.create(
      createTask(project.id, 'blocked', {
        rank: '0',
        blocked: { reason: 'Wait', actor: human, blockedAt: now },
      }),
    );

    const outcome = startRun(service, project.id);

    expect(outcome.run.items.map(({ taskId }) => taskId)).toEqual([
      'rank-a',
      'rank-b',
    ]);
    expect(outcome.run.items).toEqual([
      expect.objectContaining({
        taskId: 'rank-a',
        taskRevision: 2,
        policyRevision: 7,
        taskAutomationGeneration: 9,
        queuePosition: 0,
        status: 'queued',
      }),
      expect.objectContaining({
        taskId: 'rank-b',
        taskRevision: 4,
        policyRevision: 7,
        taskAutomationGeneration: 3,
        queuePosition: 1,
        status: 'queued',
      }),
    ]);
    expect(repositories.projectRuns.get(outcome.run.id)).toEqual(outcome.run);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]).toMatchObject({
      type: 'project.run_changed',
      payload: { run: outcome.run },
    });
    expect(publisher.publishProject).toHaveBeenCalledOnce();
    expect(publisher.publishProject).toHaveBeenCalledWith(outcome.events[0]);
  });

  it('requires a human actor', () => {
    const { repositories, project, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-1'));

    expectCode(
      () => startRun(service, project.id, 'start-agent', 1, agent),
      'project_run_invalid',
    );
    expect(repositories.projectRuns.listByProject(project.id)).toEqual([]);
  });

  it('rejects empty membership and another active run', () => {
    const { repositories, project, service } = setup();

    expectCode(
      () => startRun(service, project.id, 'start-empty'),
      'project_run_empty',
    );

    repositories.tasks.create(createTask(project.id, 'task-1'));
    startRun(service, project.id, 'start-first');
    expectCode(
      () => startRun(service, project.id, 'start-conflict'),
      'project_run_conflict',
    );
  });

  it('enforces the configured concurrency cap, defaulting to four', () => {
    const defaultSetup = setup();
    defaultSetup.repositories.tasks.create(
      createTask(defaultSetup.project.id, 'task-default'),
    );
    expectCode(
      () =>
        startRun(
          defaultSetup.service,
          defaultSetup.project.id,
          'start-over-default',
          5,
        ),
      'project_run_concurrency_exceeded',
    );

    const configuredSetup = setup({ maxConcurrency: 2 });
    configuredSetup.repositories.tasks.create(
      createTask(configuredSetup.project.id, 'task-configured'),
    );
    expectCode(
      () =>
        startRun(
          configuredSetup.service,
          configuredSetup.project.id,
          'start-over-configured',
          3,
        ),
      'project_run_concurrency_exceeded',
    );
  });

  it('returns the original outcome for duplicate delivery without republishing', () => {
    const { repositories, project, publisher, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-1'));

    const first = startRun(service, project.id);
    const duplicate = startRun(service, project.id);

    expect(duplicate).toEqual(first);
    expect(repositories.projectRuns.listByProject(project.id)).toHaveLength(1);
    expect(repositories.projectEvents.after(project.id, 0)).toHaveLength(1);
    expect(publisher.publishProject).toHaveBeenCalledOnce();
  });

  it('schedules newly committed starts and resumes without replaying either side effect', () => {
    const repositoriesRef: {
      current?: ReturnType<typeof createTestRepositories>;
    } = {};
    const scheduled: Array<{
      inTransaction: boolean;
      runId: string;
      persistedEvents: number;
    }> = [];
    const context = setup({
      scheduleDrain: (runId) => {
        const repositories = repositoriesRef.current;
        if (!repositories) throw new Error('Repositories are unavailable');
        scheduled.push({
          inTransaction: repositories.database.inTransaction,
          runId,
          persistedEvents: repositories.projectEvents.after('project-1', 0)
            .length,
        });
      },
    });
    repositoriesRef.current = context.repositories;
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-scheduled'),
    );

    const started = startRun(
      context.service,
      context.project.id,
      'scheduled-start',
      1,
    );
    expect(
      startRun(context.service, context.project.id, 'scheduled-start', 1),
    ).toEqual(started);
    const paused = context.service.pauseRun({
      runId: started.run.id,
      expectedRevision: started.run.revision,
      actor: human,
      idempotencyKey: 'scheduled-pause',
    });
    const resumed = context.service.resumeRun({
      runId: paused.run.id,
      expectedRevision: paused.run.revision,
      actor: human,
      idempotencyKey: 'scheduled-resume',
    });
    expect(
      context.service.resumeRun({
        runId: paused.run.id,
        expectedRevision: paused.run.revision,
        actor: human,
        idempotencyKey: 'scheduled-resume',
      }),
    ).toEqual(resumed);

    expect(scheduled).toEqual([
      {
        inTransaction: false,
        runId: started.run.id,
        persistedEvents: 1,
      },
      {
        inTransaction: false,
        runId: started.run.id,
        persistedEvents: 3,
      },
    ]);
  });

  it('preserves the committed command outcome when scheduling throws', () => {
    const { repositories, project, service } = setup({
      scheduleDrain: () => {
        throw new Error('drain scheduling failed');
      },
    });
    repositories.tasks.create(createTask(project.id, 'task-1'));

    const outcome = startRun(service, project.id);

    expect(outcome.run).toMatchObject({
      projectId: project.id,
      state: 'running',
    });
    expect(repositories.projectEvents.after(project.id, 0)).toHaveLength(1);
  });

  it('rolls back membership and does not publish when audit persistence fails', () => {
    const onAuditFailure = vi.fn();
    const { repositories, project, publisher, service } = setup({
      failProjectEventInsert: true,
      onAuditFailure,
    });
    repositories.tasks.create(createTask(project.id, 'task-1'));

    expect(() => startRun(service, project.id)).toThrow(
      'project event insert failed',
    );
    expect(repositories.projectRuns.listByProject(project.id)).toEqual([]);
    expect(publisher.publishProject).not.toHaveBeenCalled();
    expect(onAuditFailure).toHaveBeenCalledOnce();
    expect(onAuditFailure.mock.calls[0]?.[0]).toMatchObject({
      message: 'project event insert failed',
    });
  });
});

describe('ProjectRunService controls', () => {
  it('pauses and resumes the same frozen run', () => {
    const { repositories, project, publisher, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-1'));
    const started = startRun(service, project.id, 'start-controls', 1);

    const paused = service.pauseRun({
      runId: started.run.id,
      expectedRevision: started.run.revision,
      actor: human,
      idempotencyKey: 'pause-run-1',
    });
    const resumed = service.resumeRun({
      runId: paused.run.id,
      expectedRevision: paused.run.revision,
      actor: human,
      idempotencyKey: 'resume-run-1',
    });

    expect(paused.run).toMatchObject({
      state: 'paused',
      pauseReason: 'operator_paused',
      revision: 2,
    });
    expect(resumed.run).toMatchObject({
      state: 'running',
      pauseReason: null,
      revision: 3,
    });
    expect(resumed.run.items).toEqual(started.run.items);
    expect(publisher.publishProject).toHaveBeenCalledTimes(3);
  });

  it('revalidates project safety before resume', () => {
    const { repositories, project, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-1'));
    const started = startRun(service, project.id, 'start-resume-safety', 1);
    const paused = service.pauseRun({
      runId: started.run.id,
      expectedRevision: started.run.revision,
      actor: human,
      idempotencyKey: 'pause-resume-safety',
    });
    repositories.projects.archive(project.id, now);

    expectCode(
      () =>
        service.resumeRun({
          runId: paused.run.id,
          expectedRevision: paused.run.revision,
          actor: human,
          idempotencyKey: 'resume-archived',
        }),
      'project_archived',
    );
    expect(repositories.projectRuns.get(paused.run.id)?.state).toBe('paused');
  });

  it('reports a stale run revision with the canonical code', () => {
    const { repositories, project, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-1'));
    const started = startRun(service, project.id, 'start-stale', 1);

    expectCode(
      () =>
        service.pauseRun({
          runId: started.run.id,
          expectedRevision: started.run.revision + 1,
          actor: human,
          idempotencyKey: 'pause-stale',
        }),
      'project_run_stale',
    );
  });

  it('reports an uncontrollable run state with the canonical code', () => {
    const { repositories, project, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-1'));
    const started = startRun(service, project.id, 'start-not-controllable', 1);

    const paused = service.pauseRun({
      runId: started.run.id,
      expectedRevision: started.run.revision,
      actor: human,
      idempotencyKey: 'pause-not-controllable',
    });
    expectCode(
      () =>
        service.pauseRun({
          runId: paused.run.id,
          expectedRevision: paused.run.revision,
          actor: human,
          idempotencyKey: 'pause-not-controllable-again',
        }),
      'project_run_not_controllable',
    );
  });

  it('returns a duplicate control outcome even after later state changes', () => {
    const { repositories, project, publisher, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-1'));
    const started = startRun(service, project.id, 'start-duplicate-control', 1);
    const firstPause = service.pauseRun({
      runId: started.run.id,
      expectedRevision: started.run.revision,
      actor: human,
      idempotencyKey: 'pause-duplicate',
    });
    service.resumeRun({
      runId: firstPause.run.id,
      expectedRevision: firstPause.run.revision,
      actor: human,
      idempotencyKey: 'resume-after-pause',
    });

    const duplicate = service.pauseRun({
      runId: started.run.id,
      expectedRevision: started.run.revision,
      actor: human,
      idempotencyKey: 'pause-duplicate',
    });

    expect(duplicate).toEqual(firstPause);
    expect(publisher.publishProject).toHaveBeenCalledTimes(3);
  });

  it('stops queued work atomically while active work keeps the run draining', () => {
    const { repositories, project, service } = setup();
    repositories.tasks.create(
      createTask(project.id, 'active-task', { rank: 'a' }),
    );
    repositories.tasks.create(
      createTask(project.id, 'queued-task', { rank: 'b' }),
    );
    const started = startRun(service, project.id, 'start-draining', 1);
    const claimed = repositories.projectRuns.claimNext({
      runId: started.run.id,
      expectedRunRevision: started.run.revision,
      occurredAt: now,
    });
    if (!claimed) throw new Error('Expected a claimed run item');
    const workspace = repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-1',
        projectId: project.id,
        type: 'shared',
        path: project.repositoryPath,
      }),
    );
    const session = repositories.sessions.create(
      sessionSchema.parse({
        id: 'session-1',
        projectId: project.id,
        workspaceId: workspace.id,
        title: 'Active Developer',
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = repositories.attempts.createForTask(
      claimed.item.taskId,
      session.id,
      {
        type: 'project_run',
        runId: claimed.run.id,
        runItemId: claimed.item.id,
      },
      taskActorSchema.parse({
        type: 'system',
        id: `project-run:${claimed.run.id}:${claimed.item.id}`,
      }),
      'developer',
    );
    const active = repositories.projectRuns.linkLaunch({
      runId: claimed.run.id,
      itemId: claimed.item.id,
      expectedRunRevision: claimed.run.revision,
      attemptId: attempt.id,
      sessionId: session.id,
      occurredAt: now,
    });

    const stopped = service.stopRun({
      runId: active.id,
      expectedRevision: active.revision,
      actor: human,
      idempotencyKey: 'stop-draining',
    });

    expect(stopped.run.state).toBe('draining');
    expect(stopped.run.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'active-task', status: 'active' }),
        expect.objectContaining({
          taskId: 'queued-task',
          status: 'not_started',
          outcomeReason: 'stopped',
        }),
      ]),
    );
  });

  it('completes a stopped run only when no slots are occupied', () => {
    const { repositories, project, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-a', { rank: 'a' }));
    repositories.tasks.create(createTask(project.id, 'task-b', { rank: 'b' }));
    const started = startRun(service, project.id, 'start-stop-complete', 2);

    const stopped = service.stopRun({
      runId: started.run.id,
      expectedRevision: started.run.revision,
      actor: human,
      idempotencyKey: 'stop-complete',
    });

    expect(stopped.run).toMatchObject({
      state: 'completed',
      completionReason: 'stopped',
      completedAt: now,
    });
    expect(
      stopped.run.items.every(({ status }) => status === 'not_started'),
    ).toBe(true);
  });

  it('rolls back a stop when its run event cannot be persisted', () => {
    const { repositories, project, publisher, service } = setup();
    repositories.tasks.create(createTask(project.id, 'task-1'));
    const started = startRun(service, project.id, 'start-stop-audit', 1);
    repositories.database.exec(`
      CREATE TRIGGER fail_run_control_event
      BEFORE INSERT ON project_events
      BEGIN
        SELECT RAISE(FAIL, 'run control event failed');
      END;
    `);

    expect(() =>
      service.stopRun({
        runId: started.run.id,
        expectedRevision: started.run.revision,
        actor: human,
        idempotencyKey: 'stop-audit-failure',
      }),
    ).toThrow('run control event failed');
    expect(repositories.projectRuns.get(started.run.id)).toEqual(started.run);
    expect(publisher.publishProject).toHaveBeenCalledOnce();
  });

  it.each(['pause', 'resume', 'stop'] as const)(
    'reports a %s audit-write failure without committing the control',
    (control) => {
      const onAuditFailure = vi.fn();
      const { repositories, project, service } = setup({ onAuditFailure });
      repositories.tasks.create(createTask(project.id, 'task-control-audit'));
      const started = startRun(
        service,
        project.id,
        `start-${control}-audit`,
        1,
      );
      const controlled =
        control === 'resume'
          ? service.pauseRun({
              runId: started.run.id,
              expectedRevision: started.run.revision,
              actor: human,
              idempotencyKey: 'prepare-resume-audit',
            }).run
          : started.run;
      repositories.database.exec(`
        CREATE TRIGGER fail_${control}_run_event
        BEFORE INSERT ON project_events
        BEGIN
          SELECT RAISE(FAIL, '${control} run audit failed');
        END;
      `);

      expect(() =>
        control === 'pause'
          ? service.pauseRun({
              runId: controlled.id,
              expectedRevision: controlled.revision,
              actor: human,
              idempotencyKey: 'pause-audit-failure',
            })
          : control === 'resume'
            ? service.resumeRun({
                runId: controlled.id,
                expectedRevision: controlled.revision,
                actor: human,
                idempotencyKey: 'resume-audit-failure',
              })
            : service.stopRun({
                runId: controlled.id,
                expectedRevision: controlled.revision,
                actor: human,
                idempotencyKey: 'stop-audit-failure-all-controls',
              }),
      ).toThrow(`${control} run audit failed`);
      expect(repositories.projectRuns.get(controlled.id)).toEqual(controlled);
      expect(onAuditFailure).toHaveBeenCalledOnce();
      expect(onAuditFailure.mock.calls[0]?.[0]).toMatchObject({
        message: `${control} run audit failed`,
      });
    },
  );
});

describe('ProjectRunService drainAvailableSlots', () => {
  it('durably claims before launch and links the successful attempt and session', async () => {
    const launchAttempt = vi.fn(async (input: ProjectRunAttemptLaunchInput) => {
      expect(context.repositories.database.inTransaction).toBe(false);
      expect(
        context.repositories.projectRuns
          .get(input.source.runId)
          ?.items.find(({ id }) => id === input.source.runItemId),
      ).toMatchObject({ status: 'launch_pending', attemptId: null });
      return setupLaunchResult(context.repositories, input, 1);
    });
    const context = setup({ launchAttempt });
    context.repositories.tasks.create(createTask(context.project.id, 'task-a'));
    const started = startRun(
      context.service,
      context.project.id,
      'start-launch',
      1,
    );

    const run = await context.service.drainAvailableSlots(started.run.id);

    expect(run.items[0]).toMatchObject({
      status: 'active',
      attemptId: expect.any(String),
      sessionId: 'launch-session-1',
    });
    expect(launchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        launchIdempotencyKey: started.run.items[0]?.launchIdempotencyKey,
        source: {
          type: 'project_run',
          runId: started.run.id,
          runItemId: started.run.items[0]?.id,
        },
      }),
    );
  });

  it('counts launch_pending against capacity', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launchAttempt = vi.fn(async (input: ProjectRunAttemptLaunchInput) => {
      await pending;
      return setupLaunchResult(context.repositories, input, 1);
    });
    const context = setup({ launchAttempt });
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-a', { rank: 'a' }),
    );
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-b', { rank: 'b' }),
    );
    const started = startRun(
      context.service,
      context.project.id,
      'start-capacity',
      1,
    );

    const firstDrain = context.service.drainAvailableSlots(started.run.id);
    await vi.waitFor(() => expect(launchAttempt).toHaveBeenCalledOnce());
    const observed = await context.service.drainAvailableSlots(started.run.id);

    expect(observed.items.map(({ status }) => status)).toEqual([
      'launch_pending',
      'queued',
    ]);
    const current = context.repositories.projectRuns.get(started.run.id)!;
    context.service.pauseRun({
      runId: current.id,
      expectedRevision: current.revision,
      actor: human,
      idempotencyKey: 'pause-capacity',
    });
    release();
    await firstDrain;
    expect(launchAttempt).toHaveBeenCalledOnce();
  });

  it('does not retry an arbitrary persisted launch_pending item', async () => {
    const context = setup();
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-retry'),
    );
    const started = startRun(
      context.service,
      context.project.id,
      'start-retry',
      1,
    );
    const claimed = context.repositories.projectRuns.claimNext({
      runId: started.run.id,
      expectedRunRevision: started.run.revision,
      occurredAt: now,
    });
    if (!claimed) throw new Error('Expected durable launch claim');

    await context.service.drainAvailableSlots(started.run.id);

    expect(context.launchAttempt).not.toHaveBeenCalled();
    expect(
      context.repositories.projectRuns.get(started.run.id)?.items[0],
    ).toMatchObject({
      status: 'launch_pending',
      attemptId: null,
      sessionId: null,
    });
  });

  it('does not launch when persisted occupancy exceeds run concurrency', async () => {
    const context = setup();
    context.repositories.tasks.create(
      createTask(context.project.id, 'over-capacity-a', { rank: 'a' }),
    );
    context.repositories.tasks.create(
      createTask(context.project.id, 'over-capacity-b', { rank: 'b' }),
    );
    const started = startRun(
      context.service,
      context.project.id,
      'start-over-capacity',
      1,
    );
    context.repositories.database
      .prepare(
        "UPDATE project_run_items SET status = 'launch_pending', claimed_at = ? WHERE run_id = ?",
      )
      .run(now, started.run.id);

    const observed = await context.service.drainAvailableSlots(started.run.id);

    expect(context.launchAttempt).not.toHaveBeenCalled();
    expect(observed.items.map(({ status }) => status)).toEqual([
      'launch_pending',
      'launch_pending',
    ]);
  });

  it('terminalizes a known startup failure and continues independent queued work', async () => {
    const launchAttempt = vi.fn(async (input: ProjectRunAttemptLaunchInput) => {
      if (input.taskId === 'task-a') {
        throw new AttemptStartFailedError(
          'failed-session',
          new Error('offline'),
        );
      }
      return setupLaunchResult(context.repositories, input, 2);
    });
    const context = setup({ launchAttempt });
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-a', { rank: 'a' }),
    );
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-b', { rank: 'b' }),
    );
    const started = startRun(
      context.service,
      context.project.id,
      'start-failure',
      1,
    );

    const run = await context.service.drainAvailableSlots(started.run.id);

    expect(run.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'task-a',
          status: 'attention_required',
          outcomeReason: 'attempt_start_failed',
        }),
        expect.objectContaining({ taskId: 'task-b', status: 'active' }),
      ]),
    );
  });

  it.each(['task_revision_conflict', 'task_transition_invalid'])(
    'treats the stable %s launch race as item-local',
    async (code) => {
      const launchAttempt = vi.fn(
        async (input: ProjectRunAttemptLaunchInput) => {
          if (input.taskId === 'task-a') throw { code };
          return setupLaunchResult(context.repositories, input, 2);
        },
      );
      const context = setup({ launchAttempt });
      context.repositories.tasks.create(
        createTask(context.project.id, 'task-a', { rank: 'a' }),
      );
      context.repositories.tasks.create(
        createTask(context.project.id, 'task-b', { rank: 'b' }),
      );
      const started = startRun(
        context.service,
        context.project.id,
        `start-${code}`,
        1,
      );

      const run = await context.service.drainAvailableSlots(started.run.id);

      expect(run.items.find(({ taskId }) => taskId === 'task-a')).toMatchObject(
        {
          status: 'attention_required',
          outcomeReason: code,
        },
      );
      expect(run.items.find(({ taskId }) => taskId === 'task-b')?.status).toBe(
        'active',
      );
    },
  );

  it('pauses the run when launch outcome is ambiguous', async () => {
    const context = setup({
      launchAttempt: async () => {
        throw new AttemptReconciliationRequiredError(
          'unknown-session',
          new Error('unknown'),
        );
      },
    });
    context.repositories.tasks.create(createTask(context.project.id, 'task-a'));
    const started = startRun(
      context.service,
      context.project.id,
      'start-ambiguous',
      1,
    );

    const run = await context.service.drainAvailableSlots(started.run.id);

    expect(run.state).toBe('paused');
    expect(run.items[0]?.status).toBe('launch_pending');
  });

  it('keeps duplicate concurrent drains within the authorized concurrency', async () => {
    const context = setup();
    for (const [id, rank] of [
      ['task-a', 'a'],
      ['task-b', 'b'],
      ['task-c', 'c'],
    ] as const) {
      context.repositories.tasks.create(
        createTask(context.project.id, id, { rank }),
      );
    }
    const started = startRun(
      context.service,
      context.project.id,
      'start-concurrent',
      2,
    );

    await Promise.all([
      context.service.drainAvailableSlots(started.run.id),
      context.service.drainAvailableSlots(started.run.id),
    ]);

    expect(context.repositories.attempts.listByTask('task-a')).toHaveLength(1);
    expect(context.repositories.attempts.listByTask('task-b')).toHaveLength(1);
    expect(context.repositories.attempts.listByTask('task-c')).toHaveLength(0);
  });

  it.each(['pause', 'stop'] as const)(
    '%s racing an already claimed launch prevents only future claims',
    async (control) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const launchAttempt = vi.fn(
        async (input: ProjectRunAttemptLaunchInput) => {
          await pending;
          return setupLaunchResult(context.repositories, input, 1);
        },
      );
      const context = setup({ launchAttempt });
      context.repositories.tasks.create(
        createTask(context.project.id, 'task-a', { rank: 'a' }),
      );
      context.repositories.tasks.create(
        createTask(context.project.id, 'task-b', { rank: 'b' }),
      );
      const started = startRun(
        context.service,
        context.project.id,
        `start-${control}`,
        1,
      );
      const draining = context.service.drainAvailableSlots(started.run.id);
      await vi.waitFor(() => expect(launchAttempt).toHaveBeenCalledOnce());
      const current = context.repositories.projectRuns.get(started.run.id)!;
      const outcome =
        control === 'pause'
          ? context.service.pauseRun({
              runId: current.id,
              expectedRevision: current.revision,
              actor: human,
              idempotencyKey: 'pause-race',
            })
          : context.service.stopRun({
              runId: current.id,
              expectedRevision: current.revision,
              actor: human,
              idempotencyKey: 'stop-race',
            });
      release();
      const run = await draining;

      expect(outcome.run.state).toBe(
        control === 'pause' ? 'paused' : 'draining',
      );
      expect(run.items.find(({ taskId }) => taskId === 'task-a')?.status).toBe(
        'active',
      );
      expect(run.items.find(({ taskId }) => taskId === 'task-b')?.status).toBe(
        control === 'pause' ? 'queued' : 'not_started',
      );
      expect(launchAttempt).toHaveBeenCalledOnce();
    },
  );

  it('does not claim another item after the launch gate closes during an in-flight launch', async () => {
    let accepting = true;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launchAttempt = vi.fn(async (input: ProjectRunAttemptLaunchInput) => {
      await pending;
      return setupLaunchResult(context.repositories, input, 1);
    });
    const context = setup({
      canLaunch: () => accepting,
      launchAttempt,
    });
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-a', { rank: 'a' }),
    );
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-b', { rank: 'b' }),
    );
    const started = startRun(
      context.service,
      context.project.id,
      'start-shutdown-gate',
      2,
    );
    const draining = context.service.drainAvailableSlots(started.run.id);
    await vi.waitFor(() => expect(launchAttempt).toHaveBeenCalledOnce());

    accepting = false;
    release();
    await draining;

    expect(launchAttempt).toHaveBeenCalledOnce();
    expect(
      context.repositories.projectRuns
        .get(started.run.id)
        ?.items.map(({ status }) => status),
    ).toEqual(['active', 'queued']);
  });

  it('does not launch or claim another item when claim audit persistence fails', async () => {
    const context = setup();
    context.repositories.tasks.create(createTask(context.project.id, 'task-a'));
    context.repositories.tasks.create(
      createTask(context.project.id, 'task-b', { rank: 'n' }),
    );
    const started = startRun(
      context.service,
      context.project.id,
      'start-audit',
      1,
    );
    context.repositories.database.exec(`
      CREATE TRIGGER fail_run_claim_event
      BEFORE INSERT ON project_events
      BEGIN
        SELECT RAISE(FAIL, 'run claim event failed');
      END;
    `);

    await expect(
      context.service.drainAvailableSlots(started.run.id),
    ).rejects.toThrow('run claim event failed');

    expect(context.launchAttempt).not.toHaveBeenCalled();
    expect(
      context.repositories.projectRuns
        .get(started.run.id)
        ?.items.map(({ status }) => status),
    ).toEqual(['queued', 'queued']);
  });
});

describe('ProjectRunService observeTaskOutcome', () => {
  const prepareActiveRun = async (
    context: ReturnType<typeof setup>,
    prefix: string,
  ) => {
    const firstTask = context.repositories.tasks.create(
      createTask(context.project.id, `${prefix}-first`, { rank: 'a' }),
    );
    const nextTask = context.repositories.tasks.create(
      createTask(context.project.id, `${prefix}-next`, { rank: 'b' }),
    );
    const started = startRun(
      context.service,
      context.project.id,
      `${prefix}-start`,
      1,
    );
    await context.service.drainAvailableSlots(started.run.id);
    return { firstTask, nextTask, runId: started.run.id };
  };

  const updateTask = (
    context: ReturnType<typeof setup>,
    taskId: string,
    update: (task: Task) => Task,
  ) => {
    const current = context.repositories.tasks.get(taskId);
    if (!current) throw new Error('Expected current task');
    const updated = context.repositories.tasks.update(
      update(current),
      current.revision,
    );
    if (!updated) throw new Error('Expected task update');
    return updated;
  };

  it('completes a done item and launches the next queued item', async () => {
    const context = setup();
    const { firstTask, nextTask, runId } = await prepareActiveRun(
      context,
      'done',
    );
    updateTask(context, firstTask.id, (task) => ({
      ...task,
      lifecycleState: 'done',
      updatedAt: now,
    }));

    await context.service.observeTaskOutcome(firstTask.id);

    expect(context.repositories.projectRuns.get(runId)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: firstTask.id,
          status: 'completed',
          outcomeReason: 'task_done',
        }),
        expect.objectContaining({ taskId: nextTask.id, status: 'active' }),
      ]),
    );
  });

  it('hands outcome continuation to the configured tracked drain scheduler', async () => {
    const scheduleDrain = vi.fn();
    const context = setup({ scheduleDrain });
    const { firstTask, nextTask, runId } = await prepareActiveRun(
      context,
      'tracked-outcome',
    );
    scheduleDrain.mockClear();
    updateTask(context, firstTask.id, (task) => ({
      ...task,
      lifecycleState: 'done',
      updatedAt: now,
    }));

    await context.service.observeTaskOutcome(firstTask.id);

    expect(scheduleDrain).toHaveBeenCalledOnce();
    expect(scheduleDrain).toHaveBeenCalledWith(runId);
    expect(context.repositories.projectRuns.get(runId)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: firstTask.id,
          status: 'completed',
        }),
        expect.objectContaining({ taskId: nextTask.id, status: 'queued' }),
      ]),
    );
  });

  it('terminalizes a durable Developer blocker and releases its slot', async () => {
    const context = setup();
    const { firstTask, nextTask, runId } = await prepareActiveRun(
      context,
      'blocked',
    );
    const attempt = context.repositories.attempts.listByTask(firstTask.id)[0];
    if (!attempt) throw new Error('Expected run attempt');
    const session = context.repositories.sessions.get(attempt.sessionId);
    if (!session) throw new Error('Expected run session');
    const blocker = developerBlockerReportSchema.parse({
      id: 'blocked-report',
      cycleId: 'blocked-cycle',
      reason: 'Dependency unavailable.',
      evidence: 'The dependency returned 503.',
      attemptedWork: 'Retried once.',
      suggestedHumanAction: 'Restore the dependency.',
      preserveWorkspace: true,
      createdAt: now,
    });
    context.repositories.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: blocker.cycleId,
        attemptId: attempt.id,
        ordinal: 1,
        mode: 'new',
        authorizedBy: agent,
        authorizationCommandId: 'blocked-launch',
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: firstTask.revision,
          title: firstTask.title,
          description: firstTask.description,
          acceptanceCriteria: [],
        },
        workspaceId: session.workspaceId,
        permissionMode: session.permissionMode,
        startedAt: now,
        endedAt: now,
        terminalDisposition: 'blocked',
        completionReportId: null,
        blockerReportId: blocker.id,
        terminalCommandId: 'blocked-command',
        terminalEventId: 'blocked-event',
      }),
    );
    context.repositories.developerExecutions.appendBlockerReport(blocker);
    updateTask(context, firstTask.id, (task) => ({
      ...task,
      blocked: { reason: blocker.reason, actor: agent, blockedAt: now },
      updatedAt: now,
    }));

    await context.service.observeTaskOutcome(firstTask.id);

    expect(context.repositories.projectRuns.get(runId)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: firstTask.id,
          status: 'attention_required',
          outcomeReason: 'developer_blocked',
        }),
        expect.objectContaining({ taskId: nextTask.id, status: 'active' }),
      ]),
    );
  });

  it('releases a manual-review boundary without trusting the trigger payload', async () => {
    const context = setup();
    context.repositories.projects.updateQaConfiguration(
      context.project.id,
      context.project.qaConfiguration.revision,
      {
        instructions: {
          content: context.project.qaConfiguration.instructions.content,
        },
        reviewPolicy: 'manual',
      },
      human,
    );
    const { firstTask, nextTask, runId } = await prepareActiveRun(
      context,
      'manual',
    );
    updateTask(context, firstTask.id, (task) => ({
      ...task,
      lifecycleState: 'review',
      updatedAt: now,
    }));

    await context.service.observeTaskOutcome(firstTask.id);

    expect(context.repositories.projectRuns.get(runId)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: firstTask.id,
          status: 'attention_required',
          outcomeReason: 'manual_review',
        }),
        expect.objectContaining({ taskId: nextTask.id, status: 'active' }),
      ]),
    );
  });

  it('releases disabled task automation as manual review under an autonomous project policy', async () => {
    const context = setup();
    const { firstTask, nextTask, runId } = await prepareActiveRun(
      context,
      'disabled-automation',
    );
    updateTask(context, firstTask.id, (task) => ({
      ...task,
      lifecycleState: 'review',
      reviewAutomation: {
        ...task.reviewAutomation,
        status: 'disabled',
        updatedAt: now,
      },
      updatedAt: now,
    }));

    await context.service.observeTaskOutcome(firstTask.id);

    expect(context.repositories.projectRuns.get(runId)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: firstTask.id,
          status: 'attention_required',
          outcomeReason: 'manual_review',
        }),
        expect.objectContaining({ taskId: nextTask.id, status: 'active' }),
      ]),
    );
  });

  it('releases the slot at the third autonomous QA rejection', async () => {
    const context = setup();
    const { firstTask, nextTask, runId } = await prepareActiveRun(
      context,
      'ceiling',
    );
    updateTask(context, firstTask.id, (task) => ({
      ...task,
      lifecycleState: 'review',
      reviewAutomation: {
        ...task.reviewAutomation,
        status: 'paused',
        rejectionCount: 3,
        pauseReason: 'Autonomous QA rejection ceiling reached.',
        updatedAt: now,
      },
      updatedAt: now,
    }));

    await context.service.observeTaskOutcome(firstTask.id);

    expect(context.repositories.projectRuns.get(runId)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: firstTask.id,
          status: 'attention_required',
          outcomeReason: 'qa_rejection_ceiling',
        }),
        expect.objectContaining({ taskId: nextTask.id, status: 'active' }),
      ]),
    );
  });

  it('pauses when the frozen QA policy revision no longer matches', async () => {
    const context = setup();
    const { firstTask, runId } = await prepareActiveRun(
      context,
      'policy-drift',
    );
    const project = context.repositories.projects.get(context.project.id);
    if (!project) throw new Error('Expected project');
    context.repositories.projects.updateQaConfiguration(
      project.id,
      project.qaConfiguration.revision,
      {
        instructions: {
          content: `${project.qaConfiguration.instructions.content} Updated.`,
        },
        reviewPolicy: project.qaConfiguration.reviewPolicy,
      },
      human,
    );
    updateTask(context, firstTask.id, (task) => ({
      ...task,
      lifecycleState: 'review',
      updatedAt: now,
    }));

    await context.service.observeTaskOutcome(firstTask.id);

    expect(context.repositories.projectRuns.get(runId)).toMatchObject({
      state: 'paused',
      items: [
        expect.objectContaining({
          taskId: firstTask.id,
          status: 'active',
          outcomeReason: null,
        }),
        expect.objectContaining({ status: 'queued' }),
      ],
    });
  });

  it('uses a durable task-local repair and releases its slot', async () => {
    const context = setup();
    const { firstTask, nextTask, runId } = await prepareActiveRun(
      context,
      'repair',
    );
    const item = context.repositories.projectRuns
      .get(runId)
      ?.items.find(({ taskId }) => taskId === firstTask.id);
    if (!item?.attemptId || !item.sessionId) {
      throw new Error('Expected linked run item');
    }
    const repair = attemptRepairSchema.parse({
      taskId: firstTask.id,
      attemptId: item.attemptId,
      sessionId: item.sessionId,
      reason: 'developer_cycle_without_live_session',
    });
    context.repositories.projectEvents.append(firstTask.projectId, {
      protocolVersion: 1,
      id: 'repair-event',
      projectId: firstTask.projectId,
      occurredAt: now,
      type: 'task.attempt_repair_detected',
      payload: { repair },
    });

    await context.service.observeTaskOutcome(firstTask.id);

    expect(context.repositories.projectRuns.get(runId)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: firstTask.id,
          status: 'attention_required',
          outcomeReason: repair.reason,
        }),
        expect.objectContaining({ taskId: nextTask.id, status: 'active' }),
      ]),
    );
  });

  it('ignores a task that is not part of the active run', async () => {
    const context = setup();
    const { nextTask, runId } = await prepareActiveRun(context, 'unrelated');
    const unrelated = context.repositories.tasks.create(
      createTask(context.project.id, 'unrelated-task'),
    );
    const before = context.repositories.projectRuns.get(runId);

    await context.service.observeTaskOutcome(unrelated.id);

    expect(context.repositories.projectRuns.get(runId)).toEqual(before);
    expect(
      context.repositories.projectRuns
        .get(runId)
        ?.items.find(({ taskId }) => taskId === nextTask.id)?.status,
    ).toBe('queued');
    expect(context.launchAttempt).toHaveBeenCalledOnce();
  });
});

const setupLaunchResult = (
  repositories: ReturnType<typeof createTestRepositories>,
  input: ProjectRunAttemptLaunchInput,
  ordinal: number,
) => {
  const task = repositories.tasks.get(input.taskId);
  if (!task) throw new Error('Expected launch task');
  const workspace = repositories.workspaces.create(
    workspaceSchema.parse({
      id: `launch-workspace-${ordinal}`,
      projectId: task.projectId,
      type: 'shared',
      path: input.workspace.path,
    }),
  );
  const session = repositories.sessions.create(
    sessionSchema.parse({
      id: `launch-session-${ordinal}`,
      projectId: task.projectId,
      workspaceId: workspace.id,
      title: input.title,
      permissionMode: input.permissionMode,
      lifecycleState: 'running',
      createdAt: now,
      updatedAt: now,
    }),
  );
  const attempt = repositories.attempts.createForTask(
    task.id,
    session.id,
    taskAttemptSourceSchema.parse(input.source),
    taskActorSchema.parse({
      type: 'system',
      id: `project-run:${input.source.runId}:${input.source.runItemId}`,
    }),
    'developer',
  );
  return { attempt, session };
};
