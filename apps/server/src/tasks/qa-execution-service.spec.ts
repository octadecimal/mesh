import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  projectSchema,
  qaExecutionCycleSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  workspaceSchema,
  type Task,
} from '@mesh-session-platform/contracts';

import type { RepositoryIdentity } from '../projects/repository-identity.js';
import { EventPublisher } from '../runtime/event-publisher.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { AttemptService } from './attempt-service.js';
import { DeveloperCapabilityRegistry } from './developer-capability-registry.js';
import { DeveloperExecutionService } from './developer-execution-service.js';
import { DeveloperReworkService } from './developer-rework-service.js';
import { QaCapabilityRegistry } from './qa-capability-registry.js';
import {
  QaExecutionService,
  type QaRuntimeConfiguration,
} from './qa-execution-service.js';
import { TaskService } from './task-service.js';

const now = '2026-08-26T12:00:00.000Z';
const humanActor = taskActorSchema.parse({ type: 'human', id: 'operator-1' });
const policyActor = taskActorSchema.parse({
  type: 'system',
  id: 'review-loop',
});

describe('QaExecutionService launch', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
  });

  const setup = (options?: {
    workspaceType?: 'shared' | 'worktree';
    reviewPolicy?: 'manual' | 'autonomous_review';
    task?: Partial<Task>;
    billingConflict?: boolean;
    startupFailure?: Error;
    repositoryIdentity?: 'matching' | 'mismatched' | 'ambiguous';
    missingDeveloperReport?: boolean;
  }) => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-qa-launch-'));
    const repositories = createTestRepositories();
    cleanups.push(() => {
      repositories.dispose();
      rmSync(directory, { force: true, recursive: true });
    });

    const project = repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project one',
        repositoryPath: directory,
        repositoryIdentity: 'repository-1',
        discoveredAt: now,
        discoveryMetadata: {},
        qaConfiguration: {
          instructions: {
            content: 'Run the focused server tests.',
            revision: 3,
            updatedAt: now,
            updatedBy: humanActor,
          },
          reviewPolicy: options?.reviewPolicy ?? 'manual',
          revision: 4,
          updatedAt: now,
          updatedBy: humanActor,
        },
      }),
    );
    const task = repositories.tasks.create(
      taskSchema.parse({
        id: 'task-1',
        projectId: project.id,
        title: 'Launch QA',
        description: 'Verify the Developer submission.',
        acceptanceCriteria: ['QA reuses the Developer workspace.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'review',
        labels: [],
        notes: '',
        blocked: null,
        revision: 3,
        createdAt: now,
        updatedAt: now,
        reviewAutomation: {
          status: 'enabled',
          generation: 2,
          rejectionCount: 1,
          pauseReason: null,
          updatedAt: now,
        },
        ...options?.task,
      }),
    );
    if (options?.reviewPolicy === 'autonomous_review') {
      const getPersistedTask = repositories.tasks.get.bind(repositories.tasks);
      vi.spyOn(repositories.tasks, 'get').mockImplementation((taskId) => {
        const persistedTask = getPersistedTask(taskId);
        return persistedTask?.id === task.id
          ? taskSchema.parse({
              ...persistedTask,
              reviewAutomation: task.reviewAutomation,
            })
          : persistedTask;
      });
    }
    const workspacePath =
      options?.workspaceType === 'worktree'
        ? join(directory, 'developer-worktree')
        : directory;
    const workspace = repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'developer-workspace',
        projectId: project.id,
        type: options?.workspaceType ?? 'shared',
        path: workspacePath,
        ...(options?.workspaceType === 'worktree'
          ? {
              gitBranch: 'mesh/developer',
              gitWorktreePath: workspacePath,
              owner: 'mesh',
            }
          : {}),
        cleanupState: 'active',
      }),
    );
    const developerSession = repositories.sessions.create(
      sessionSchema.parse({
        id: 'developer-session',
        projectId: project.id,
        workspaceId: workspace.id,
        title: 'Developer',
        permissionMode: 'safe_auto',
        lifecycleState: 'interrupted',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = repositories.attempts.createForTask(
      task.id,
      developerSession.id,
      'launched',
      humanActor,
      'developer',
    );
    const developerCycle = repositories.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'developer-cycle',
        attemptId: attempt.id,
        ordinal: 1,
        mode: 'new',
        authorizedBy: humanActor,
        authorizationCommandId: 'developer-launch',
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: task.title,
          description: task.description,
          acceptanceCriteria: [
            { id: 'criterion-1', text: task.acceptanceCriteria[0] },
          ],
        },
        workspaceId: workspace.id,
        permissionMode: developerSession.permissionMode,
        startedAt: now,
        endedAt: now,
        terminalDisposition: 'submitted_for_review',
        completionReportId: 'developer-report',
        blockerReportId: null,
        terminalCommandId: 'developer-submit',
        terminalEventId: 'developer-event',
      }),
    );
    const developerReport = developerCompletionReportSchema.parse({
      id: 'developer-report',
      cycleId: developerCycle.id,
      summary: 'Ready for QA.',
      criterionResults: [
        { criterionId: 'criterion-1', status: 'met', evidence: 'Test passed.' },
      ],
      verification: [
        { command: 'pnpm test', outcome: 'passed', output: 'pass' },
      ],
      limitations: '',
      workspaceState: {
        summary: 'Developer changes are present.',
        hasUncommittedChanges: false,
        commitsCreated: true,
      },
      reviewerNotes: null,
      createdAt: now,
    });
    if (!options?.missingDeveloperReport) {
      repositories.developerExecutions.appendCompletionReport(developerReport);
    }

    let nextId = 0;
    const createId = () => `qa-generated-${++nextId}`;
    const taskService = new TaskService({
      ...repositories,
      now: () => now,
      createId,
    });
    const developerCapabilities = new DeveloperCapabilityRegistry();
    const developerExecutionService = new DeveloperExecutionService({
      ...repositories,
      taskService,
      capabilities: developerCapabilities,
      now: () => now,
      createId,
    });
    const publisher = new EventPublisher();
    const developerReworkService = new DeveloperReworkService({
      ...repositories,
      taskService,
      capabilities: developerCapabilities,
      developerExecutionService,
      registry: {
        resume: async () => undefined,
        interrupt: async () => undefined,
        emergencyClose: async () => undefined,
        publisher,
      },
      now: () => now,
      createId,
    });
    const resolveIdentity = async (
      path: string,
    ): Promise<RepositoryIdentity> => {
      if (
        options?.repositoryIdentity === 'ambiguous' &&
        path === workspacePath
      ) {
        throw new Error('ambiguous repository identity');
      }
      return {
        canonicalPath: path,
        commonDirectory: directory,
        repositoryIdentity:
          options?.repositoryIdentity === 'mismatched' && path === workspacePath
            ? 'other-repository'
            : 'repository-identity',
      } as RepositoryIdentity;
    };
    const attemptService = new AttemptService({
      ...repositories,
      taskService,
      capabilities: developerCapabilities,
      developerReworkService,
      registry: {
        create: async () => undefined,
        interrupt: async () => undefined,
        publisher,
      },
      pathOptions: { baseDirectory: directory },
      resolveIdentity,
      now: () => now,
      createId,
    });
    const starts: Array<{
      sessionId: string;
      configuration: QaRuntimeConfiguration;
    }> = [];
    const durableAtStart: boolean[] = [];
    const create = vi.fn(
      async (sessionId: string, configuration: QaRuntimeConfiguration) => {
        starts.push({ sessionId, configuration });
        durableAtStart.push(
          repositories.sessions.get(sessionId) !== undefined &&
            repositories.qaExecutions
              .listCyclesForAttempts([attempt.id])
              .some((cycle) => cycle.sessionId === sessionId),
        );
        if (options?.startupFailure) throw options.startupFailure;
      },
    );
    const qaCapabilities = new QaCapabilityRegistry();
    const service = new QaExecutionService({
      ...repositories,
      attemptService,
      capabilities: qaCapabilities,
      registry: { create, interrupt: async () => undefined, publisher },
      billingConflicts: options?.billingConflict
        ? [{ variable: 'ANTHROPIC_API_KEY' }]
        : [],
      now: () => now,
      createId,
    });

    return {
      attempt,
      create,
      developerCycle,
      developerReport,
      developerSession,
      directory,
      durableAtStart,
      project,
      qaCapabilities,
      repositories,
      service,
      starts,
      task,
      workspace,
    };
  };

  const launchInput = (task: Task) => ({
    commandId: 'qa-launch-1',
    taskId: task.id,
    expectedRevision: task.revision,
    actor: humanActor,
    trigger: 'manual' as const,
  });

  it.each(['shared', 'worktree'] as const)(
    'launches manual QA in the exact %s Developer workspace',
    async (workspaceType) => {
      const context = setup({ workspaceType });

      const result = await context.service.launch(launchInput(context.task));

      expect(result).toMatchObject({
        task: { lifecycleState: 'review', revision: context.task.revision },
        attempt: { id: context.attempt.id },
        cycle: {
          attemptId: context.attempt.id,
          developerCompletionReportId: context.developerReport.id,
          workspaceId: context.workspace.id,
          reviewPolicy: 'manual',
          reviewPolicyRevision: 4,
          automationGeneration: 0,
          rejectionOrdinal: 0,
        },
        session: {
          workspaceId: context.developerSession.workspaceId,
          permissionMode: context.developerSession.permissionMode,
        },
      });
      expect(
        context.repositories.workspaces.listByProject('project-1'),
      ).toEqual([context.workspace]);
      expect(context.starts).toHaveLength(1);
      expect(context.durableAtStart).toEqual([true]);
      expect(context.starts[0]?.configuration).toMatchObject({
        role: 'qa',
        meshControls: ['submit_qa_verdict'],
        toolPolicy: {
          sourceRead: true,
          verificationCommands: true,
          sourceWrite: false,
        },
      });
      expect(context.starts[0]?.configuration.initialPrompt).toContain(
        context.workspace.path,
      );
      const start = context.starts[0];
      if (!start) throw new Error('Expected QA startup request');
      const binding = context.qaCapabilities.resolve(
        start.configuration.capability,
      );
      expect(binding).toEqual({
        sessionId: result.session.id,
        taskId: context.task.id,
        attemptId: context.attempt.id,
        cycleId: result.cycle.id,
      });
    },
  );

  it('launches only an enabled autonomous-review policy as a system actor', async () => {
    const context = setup({ reviewPolicy: 'autonomous_review' });

    const result = await context.service.launch({
      ...launchInput(context.task),
      actor: policyActor,
      trigger: 'autonomous_policy',
    });

    expect(result.cycle).toMatchObject({
      authorizedBy: policyActor,
      reviewPolicy: 'autonomous_review',
    });
  });

  it.each(['paused', 'disabled'] as const)(
    'rejects autonomous launch when task review automation is %s without side effects',
    async (status) => {
      const context = setup({
        reviewPolicy: 'autonomous_review',
        task: {
          reviewAutomation: {
            status,
            generation: 2,
            rejectionCount: 1,
            pauseReason:
              status === 'paused' ? 'Operator paused review automation.' : null,
            updatedAt: now,
          },
        },
      });
      const sessionsBefore = context.repositories.sessions.listByProject(
        context.project.id,
        { includeArchived: true },
      );
      const eventsBefore = context.repositories.projectEvents.after(
        context.project.id,
        0,
      );

      await expect(
        context.service.launch({
          ...launchInput(context.task),
          actor: policyActor,
          trigger: 'autonomous_policy',
        }),
      ).rejects.toMatchObject({ code: 'review_automation_paused' });

      expect(
        context.repositories.sessions.listByProject(context.project.id, {
          includeArchived: true,
        }),
      ).toEqual(sessionsBefore);
      expect(
        context.repositories.qaExecutions.listCyclesForAttempts([
          context.attempt.id,
        ]),
      ).toEqual([]);
      expect(
        context.repositories.projectEvents.after(context.project.id, 0),
      ).toEqual(eventsBefore);
      expect(context.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['manual', policyActor],
    ['autonomous_policy', humanActor],
  ] as const)(
    'rejects %s launch by the wrong actor kind',
    async (trigger, actor) => {
      const context = setup({ reviewPolicy: 'autonomous_review' });

      await expect(
        context.service.launch({
          ...launchInput(context.task),
          trigger,
          actor,
        }),
      ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });
      expect(context.create).not.toHaveBeenCalled();
    },
  );

  it('rejects autonomous launch when the project policy is manual', async () => {
    const context = setup();

    await expect(
      context.service.launch({
        ...launchInput(context.task),
        actor: policyActor,
        trigger: 'autonomous_policy',
      }),
    ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });
  });

  it('rejects manual launch when the project policy is autonomous-review', async () => {
    const context = setup({ reviewPolicy: 'autonomous_review' });

    await expect(
      context.service.launch(launchInput(context.task)),
    ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });
  });

  it.each([
    [
      'non-review task',
      { lifecycleState: 'in_progress' as const },
      'task_transition_invalid',
    ],
    [
      'blocked task',
      { blocked: { reason: 'Blocked.', actor: humanActor, blockedAt: now } },
      'task_blocked',
    ],
  ])('rejects a %s', async (_name, taskOverride, code) => {
    const context = setup({ task: taskOverride });

    await expect(
      context.service.launch(launchInput(context.task)),
    ).rejects.toMatchObject({
      code,
    });
    expect(context.create).not.toHaveBeenCalled();
  });

  it('rejects a stale task revision', async () => {
    const context = setup();

    await expect(
      context.service.launch({
        ...launchInput(context.task),
        expectedRevision: context.task.revision - 1,
      }),
    ).rejects.toMatchObject({ code: 'task_revision_conflict' });
  });

  it('rejects when the terminal Developer attempt is no longer current', async () => {
    const context = setup();
    context.repositories.sessions.create(
      sessionSchema.parse({
        id: 'newer-session',
        projectId: context.project.id,
        workspaceId: context.workspace.id,
        title: 'Newer Developer',
        permissionMode: 'safe_auto',
        lifecycleState: 'interrupted',
        createdAt: now,
        updatedAt: now,
      }),
    );
    context.repositories.attempts.createForTask(
      context.task.id,
      'newer-session',
      'launched',
      humanActor,
      'developer',
    );

    await expect(
      context.service.launch(launchInput(context.task)),
    ).rejects.toMatchObject({ code: 'developer_cycle_invalid' });
  });

  it('requires the terminal Developer completion report', async () => {
    const context = setup({ missingDeveloperReport: true });

    await expect(
      context.service.launch(launchInput(context.task)),
    ).rejects.toMatchObject({ code: 'developer_report_invalid' });
  });

  it('rejects any active Developer or QA role cycle', async () => {
    const developerActive = setup();
    developerActive.repositories.database
      .prepare(
        'UPDATE developer_execution_cycles SET ended_at = NULL, terminal_disposition = NULL, completion_report_id = NULL, terminal_command_id = NULL, terminal_event_id = NULL WHERE id = ?',
      )
      .run(developerActive.developerCycle.id);
    await expect(
      developerActive.service.launch(launchInput(developerActive.task)),
    ).rejects.toMatchObject({ code: 'qa_already_active' });

    const qaActive = setup();
    qaActive.repositories.sessions.create(
      sessionSchema.parse({
        id: 'existing-qa-session',
        projectId: qaActive.project.id,
        workspaceId: qaActive.workspace.id,
        title: 'Existing QA',
        permissionMode: 'safe_auto',
        lifecycleState: 'interrupted',
        createdAt: now,
        updatedAt: now,
      }),
    );
    qaActive.repositories.qaExecutions.createCycle(
      qaExecutionCycleSchema.parse({
        id: 'existing-qa-cycle',
        taskId: qaActive.task.id,
        attemptId: qaActive.attempt.id,
        sessionId: 'existing-qa-session',
        ordinal: 1,
        authorizedBy: humanActor,
        authorizationCommandId: 'prior-launch',
        policyVersion: 'qa-policy-v1',
        qaInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: qaActive.task.revision,
          title: qaActive.task.title,
          description: qaActive.task.description,
          acceptanceCriteria: [
            { id: 'criterion-1', text: qaActive.task.acceptanceCriteria[0] },
          ],
        },
        developerCompletionReportId: qaActive.developerReport.id,
        workspaceId: qaActive.workspace.id,
        reviewPolicy: 'manual',
        reviewPolicyRevision: 1,
        automationGeneration: 0,
        rejectionOrdinal: 0,
        startedAt: now,
        endedAt: null,
        terminalDisposition: null,
        reportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      }),
    );
    await expect(
      qaActive.service.launch(launchInput(qaActive.task)),
    ).rejects.toMatchObject({ code: 'qa_already_active' });
  });

  it.each(['mismatched', 'ambiguous'] as const)(
    'rejects a %s Developer workspace repository identity',
    async (repositoryIdentity) => {
      const context = setup({
        repositoryIdentity,
        workspaceType: 'worktree',
      });

      await expect(
        context.service.launch(launchInput(context.task)),
      ).rejects.toMatchObject({ code: 'unsafe_qa_workspace' });
      expect(context.create).not.toHaveBeenCalled();
    },
  );

  it('blocks QA startup when API billing configuration conflicts', async () => {
    const context = setup({ billingConflict: true });

    await expect(
      context.service.launch(launchInput(context.task)),
    ).rejects.toMatchObject({ code: 'billing_configuration_conflict' });
    expect(
      context.repositories.qaExecutions.listCyclesForAttempts([
        context.attempt.id,
      ]),
    ).toEqual([]);
  });

  it('retains durable QA truth and diagnostics when startup fails', async () => {
    const context = setup({ startupFailure: new Error('driver unavailable') });

    await expect(
      context.service.launch(launchInput(context.task)),
    ).rejects.toMatchObject({ code: 'review_automation_paused' });

    const [cycle] = context.repositories.qaExecutions.listCyclesForAttempts([
      context.attempt.id,
    ]);
    if (!cycle) throw new Error('Expected durable QA cycle');
    expect(cycle).toMatchObject({ endedAt: null, terminalDisposition: null });
    expect(context.repositories.tasks.get(context.task.id)).toMatchObject({
      lifecycleState: 'review',
      revision: context.task.revision,
    });
    expect(
      context.repositories.diagnostics.list(cycle.sessionId),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'qa_execution_launch',
          stage: 'startup',
          outcome: 'failed',
        }),
      }),
    );
    const start = context.starts[0];
    if (!start) throw new Error('Expected failed QA startup request');
    expect(() =>
      context.qaCapabilities.resolve(start.configuration.capability),
    ).toThrow();
  });

  it('returns the original result for a duplicate successful idempotency key', async () => {
    const context = setup();
    const input = launchInput(context.task);

    const first = await context.service.launch(input);
    const duplicate = await context.service.launch(input);

    expect(duplicate).toEqual(first);
    expect(context.create).toHaveBeenCalledTimes(1);
    expect(
      context.repositories.qaExecutions.listCyclesForAttempts([
        context.attempt.id,
      ]),
    ).toHaveLength(1);
  });
});
