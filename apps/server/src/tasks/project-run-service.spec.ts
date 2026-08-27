import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  workspaceSchema,
  type Project,
  type Task,
  type TaskActor,
} from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';
import { ProjectRunService } from './project-run-service.js';

const now = '2026-08-27T00:00:00.000Z';
const human = taskActorSchema.parse({ type: 'human', id: 'operator-1' });
const agent = taskActorSchema.parse({ type: 'agent', id: 'agent-1' });

const disposals: Array<() => void> = [];

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
  failProjectEventInsert?: boolean;
  maxConcurrency?: number;
}) => {
  const repositories = createTestRepositories({
    failProjectEventInsert: options?.failProjectEventInsert,
  });
  disposals.push(repositories.dispose);
  const project = repositories.projects.create(createProject());
  const publisher = { publishProject: vi.fn() };
  let id = 0;
  const service = new ProjectRunService({
    ...repositories,
    publisher,
    maxConcurrency: options?.maxConcurrency,
    now: () => now,
    createId: () => `generated-${++id}`,
  });
  return { repositories, project, publisher, service };
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
) => service.startRun({ projectId, concurrency, actor, idempotencyKey });

describe('ProjectRunService startRun', () => {
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

  it('rolls back membership and does not publish when audit persistence fails', () => {
    const { repositories, project, publisher, service } = setup({
      failProjectEventInsert: true,
    });
    repositories.tasks.create(createTask(project.id, 'task-1'));

    expect(() => startRun(service, project.id)).toThrow(
      'project event insert failed',
    );
    expect(repositories.projectRuns.listByProject(project.id)).toEqual([]);
    expect(publisher.publishProject).not.toHaveBeenCalled();
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

    expect(paused.run).toMatchObject({ state: 'paused', revision: 2 });
    expect(resumed.run).toMatchObject({ state: 'running', revision: 3 });
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
      'launched',
      human,
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
});
