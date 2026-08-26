import { afterEach, describe, expect, it } from 'vitest';
import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  type ProjectEvent,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { openDatabase } from '../db/database.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { DeveloperCapabilityRegistry } from './developer-capability-registry.js';
import { DeveloperExecutionService } from './developer-execution-service.js';
import { TaskService } from './task-service.js';

const now = '2026-08-25T12:00:00.000Z';
const developer = taskActorSchema.parse({ type: 'agent', id: 'developer-1' });
const otherDeveloper = taskActorSchema.parse({
  type: 'agent',
  id: 'developer-2',
});
const human = taskActorSchema.parse({ type: 'human', id: 'operator-1' });

describe('DeveloperExecutionService', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => cleanups.splice(0).forEach((dispose) => dispose()));

  const setup = (options?: {
    repositories?: Parameters<typeof createTestRepositories>[0];
    publisher?: { publishProject: (event: ProjectEvent) => void };
  }) => {
    const repositories = createTestRepositories(options?.repositories);
    cleanups.push(repositories.dispose);
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project',
        repositoryPath: 'C:/project',
        repositoryIdentity: 'repository-1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const task = repositories.tasks.create(
      taskSchema.parse({
        id: 'task-1',
        projectId: 'project-1',
        title: 'Outcome',
        description: 'Persist a developer outcome.',
        acceptanceCriteria: [
          'Every criterion is accounted for.',
          'Every outcome is durable.',
        ],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'in_progress',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-1',
        projectId: task.projectId,
        type: 'shared',
        path: 'C:/project',
        cleanupState: 'active',
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 'session-1',
        projectId: task.projectId,
        workspaceId: 'workspace-1',
        title: 'Developer outcome',
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = repositories.attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-1',
        taskId: task.id,
        sessionId: 'session-1',
        ordinal: 1,
        source: 'launched',
        actor: developer,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: 'developer',
      }),
    );
    const cycle = repositories.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'cycle-1',
        attemptId: attempt.id,
        ordinal: 1,
        mode: 'new',
        authorizedBy: developer,
        authorizationCommandId: 'command-launch',
        policyVersion: '1',
        projectInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: task.revision,
          title: task.title,
          description: task.description,
          acceptanceCriteria: [
            { id: 'criterion-1', text: task.acceptanceCriteria[0] },
            { id: 'criterion-2', text: task.acceptanceCriteria[1] },
          ],
        },
        workspaceId: 'workspace-1',
        permissionMode: 'safe_auto',
        startedAt: now,
        endedAt: null,
        terminalDisposition: null,
        completionReportId: null,
        blockerReportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      }),
    );
    const capabilities = new DeveloperCapabilityRegistry();
    const capability = capabilities.issue({
      sessionId: attempt.sessionId,
      attemptId: attempt.id,
      taskId: task.id,
      cycleId: cycle.id,
      agentActor: developer,
    });
    let nextId = 0;
    const createId = () => `generated-${++nextId}`;
    const taskService = new TaskService({
      ...repositories,
      now: () => now,
      createId,
    });
    const service = new DeveloperExecutionService({
      ...repositories,
      taskService,
      capabilities,
      publisher: options?.publisher,
      now: () => now,
      createId,
    });
    return {
      repositories,
      service,
      capabilities,
      capability,
      task,
      attempt,
      cycle,
    };
  };

  const completion = (
    cycleId = 'cycle-1',
    criterionResults = [
      {
        criterionId: 'criterion-1',
        status: 'met' as const,
        evidence: 'Implemented and tested.',
      },
      {
        criterionId: 'criterion-2',
        status: 'met' as const,
        evidence: 'Persisted atomically.',
      },
    ],
  ) =>
    developerCompletionReportSchema.parse({
      id: 'report-1',
      cycleId,
      summary: 'Completed.',
      criterionResults,
      verification: [],
      limitations: '',
      workspaceState: {
        summary: 'Clean.',
        hasUncommittedChanges: false,
        commitsCreated: true,
      },
      reviewerNotes: null,
      createdAt: now,
    });

  const blocker = (cycleId = 'cycle-1') =>
    developerBlockerReportSchema.parse({
      id: 'blocker-1',
      cycleId,
      reason: 'Dependency unavailable.',
      evidence: 'Service returned 503.',
      attemptedWork: 'Retried safely.',
      suggestedHumanAction: 'Restore the dependency.',
      preserveWorkspace: true,
      createdAt: now,
    });

  it('atomically submits a complete review outcome, then invalidates its capability', () => {
    const { service, repositories, capabilities, capability, task, cycle } =
      setup();

    const result = service.submitForReview({
      commandId: 'command-review',
      capability,
      expectedRevision: 1,
      report: completion(),
      actor: developer,
    });

    expect(result).toMatchObject({
      task: { lifecycleState: 'review', blocked: null, revision: 2 },
      cycle: {
        endedAt: now,
        terminalDisposition: 'submitted_for_review',
        completionReportId: 'report-1',
      },
      report: completion(),
      transition: {
        previousState: 'in_progress',
        nextState: 'review',
        commandId: 'command-review',
      },
      event: { type: 'task.developer_execution_changed', sequence: 1 },
    });
    expect(repositories.tasks.get(task.id)).toEqual(result.task);
    expect(repositories.developerExecutions.getCycle(cycle.id)).toEqual(
      result.cycle,
    );
    expect(repositories.projectEvents.after(task.projectId, 0)).toEqual([
      result.event,
    ]);
    expect(() => capabilities.resolve(capability)).toThrow();
  });

  it('blocks only the current assigned task without changing its lifecycle state', () => {
    const { service, capability } = setup();

    const result = service.markBlocked({
      commandId: 'command-block',
      capability,
      expectedRevision: 1,
      report: blocker(),
      actor: developer,
    });

    expect(result).toMatchObject({
      task: {
        lifecycleState: 'in_progress',
        blocked: { reason: 'Dependency unavailable.', actor: developer },
        revision: 2,
      },
      cycle: { terminalDisposition: 'blocked', blockerReportId: 'blocker-1' },
      event: { type: 'task.developer_execution_changed' },
    });
  });

  it('rejects a review outcome when the persisted task is not in progress', () => {
    const { service, repositories, capability, task } = setup();
    repositories.database
      .prepare("UPDATE tasks SET lifecycle_state = 'review' WHERE id = ?")
      .run(task.id);

    expect(() =>
      service.submitForReview({
        commandId: 'command-wrong-state',
        capability,
        expectedRevision: 1,
        report: completion(),
        actor: developer,
      }),
    ).toThrow();
    expect(repositories.projectEvents.after(task.projectId, 0)).toEqual([]);
  });

  it('rejects a review outcome when the persisted task is blocked', () => {
    const { service, repositories, capability, task } = setup();
    repositories.database
      .prepare('UPDATE tasks SET blocked_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          reason: 'Dependency unavailable.',
          actor: developer,
          blockedAt: now,
        }),
        task.id,
      );

    expect(() =>
      service.submitForReview({
        commandId: 'command-blocked-review',
        capability,
        expectedRevision: 1,
        report: completion(),
        actor: developer,
      }),
    ).toThrow();
    expect(repositories.projectEvents.after(task.projectId, 0)).toEqual([]);
  });

  it('publishes only after the outcome is durably observable', () => {
    let observed:
      | {
          task: { lifecycle_state: string; revision: number };
          cycle: {
            ended_at: string | null;
            terminal_disposition: string | null;
            completion_report_id: string | null;
            terminal_event_id: string | null;
          };
          report: { id: string; cycle_id: string };
          event: { id: string; type: string; payload_json: string };
        }
      | undefined;
    const { service, repositories, capability, task, cycle } = setup({
      publisher: {
        publishProject: (event) => {
          if (!observerDatabase)
            throw new Error('Observer database unavailable');
          observed = {
            task: observerDatabase
              .prepare(
                'SELECT lifecycle_state, revision FROM tasks WHERE id = ?',
              )
              .get(task.id) as { lifecycle_state: string; revision: number },
            cycle: observerDatabase
              .prepare(
                `
                SELECT ended_at, terminal_disposition, completion_report_id, terminal_event_id
                FROM developer_execution_cycles WHERE id = ?
              `,
              )
              .get(cycle.id) as {
              ended_at: string | null;
              terminal_disposition: string | null;
              completion_report_id: string | null;
              terminal_event_id: string | null;
            },
            report: observerDatabase
              .prepare(
                'SELECT id, cycle_id FROM developer_completion_reports WHERE id = ?',
              )
              .get('report-1') as { id: string; cycle_id: string },
            event: observerDatabase
              .prepare(
                'SELECT id, type, payload_json FROM project_events WHERE id = ?',
              )
              .get(event.id) as {
              id: string;
              type: string;
              payload_json: string;
            },
          };
        },
      },
    });
    const observerDatabase = openDatabase(repositories.path);

    const result = service.submitForReview({
      commandId: 'command-publish',
      capability,
      expectedRevision: 1,
      report: completion(),
      actor: developer,
    });
    observerDatabase.close();

    expect(observed).toEqual({
      task: { lifecycle_state: 'review', revision: 2 },
      cycle: {
        ended_at: now,
        terminal_disposition: 'submitted_for_review',
        completion_report_id: 'report-1',
        terminal_event_id: result.event.id,
      },
      report: { id: 'report-1', cycle_id: cycle.id },
      event: {
        id: result.event.id,
        type: 'task.developer_execution_changed',
        payload_json: JSON.stringify(result.event.payload),
      },
    });
    expect(
      (result.event.payload as { completionReport: unknown }).completionReport,
    ).toEqual(result.report);
  });

  it('rejects mismatched actors, reports, stale attempts, wrong state, and incomplete or duplicate criterion coverage', () => {
    const { service, repositories, capability, task } = setup();
    const invalid =
      (report = completion()) =>
      () =>
        service.submitForReview({
          commandId: 'command-invalid',
          capability,
          expectedRevision: 1,
          report,
          actor: otherDeveloper,
        });
    expect(invalid()).toThrow();
    expect(() =>
      service.submitForReview({
        commandId: 'command-cycle',
        capability,
        expectedRevision: 1,
        report: completion('cycle-other'),
        actor: developer,
      }),
    ).toThrow();
    expect(() =>
      service.submitForReview({
        commandId: 'command-coverage',
        capability,
        expectedRevision: 1,
        report: completion('cycle-1', [
          {
            criterionId: 'criterion-1',
            status: 'met',
            evidence: 'Only one criterion.',
          },
        ]),
        actor: developer,
      }),
    ).toThrow();
    expect(() =>
      service.submitForReview({
        commandId: 'command-duplicate-coverage',
        capability,
        expectedRevision: 1,
        report: completion('cycle-1', [
          { criterionId: 'criterion-1', status: 'met', evidence: 'One.' },
          { criterionId: 'criterion-1', status: 'met', evidence: 'Two.' },
        ]),
        actor: developer,
      }),
    ).toThrow();
    repositories.attempts.unlink('attempt-1', developer, 'Replaced', now);
    expect(() =>
      service.submitForReview({
        commandId: 'command-attempt',
        capability,
        expectedRevision: 1,
        report: completion(),
        actor: developer,
      }),
    ).toThrow();
    expect(repositories.tasks.get(task.id)).toEqual(task);
    expect(repositories.projectEvents.after(task.projectId, 0)).toEqual([]);
  });

  it('rejects capabilities bound to a different server-side session or task', () => {
    const { service, capabilities } = setup();
    const wrongSession = capabilities.issue({
      sessionId: 'session-other',
      attemptId: 'attempt-1',
      taskId: 'task-1',
      cycleId: 'cycle-1',
      agentActor: developer,
    });
    const wrongTask = capabilities.issue({
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      taskId: 'task-other',
      cycleId: 'cycle-1',
      agentActor: developer,
    });

    expect(() =>
      service.submitForReview({
        commandId: 'command-wrong-session',
        capability: wrongSession,
        expectedRevision: 1,
        report: completion(),
        actor: developer,
      }),
    ).toThrow();
    expect(() =>
      service.submitForReview({
        commandId: 'command-wrong-task',
        capability: wrongTask,
        expectedRevision: 1,
        report: completion(),
        actor: developer,
      }),
    ).toThrow();
  });

  it('rolls back every durable mutation and retains capability when event persistence fails', () => {
    const { service, repositories, capabilities, capability, task, cycle } =
      setup({ repositories: { failProjectEventInsert: true } });

    expect(() =>
      service.submitForReview({
        commandId: 'command-review',
        capability,
        expectedRevision: 1,
        report: completion(),
        actor: developer,
      }),
    ).toThrow('project event insert failed');

    expect(repositories.tasks.get(task.id)).toEqual(task);
    expect(repositories.developerExecutions.getCycle(cycle.id)).toEqual(cycle);
    expect(repositories.transitions.listByTask(task.id)).toEqual([]);
    expect(repositories.projectEvents.after(task.projectId, 0)).toEqual([]);
    expect(capabilities.resolve(capability).cycleId).toBe(cycle.id);
  });

  it('returns the original durable review outcome for a duplicate command', () => {
    const { service, capability } = setup();
    const input = {
      commandId: 'command-review',
      capability,
      expectedRevision: 1,
      report: completion(),
      actor: developer,
    };

    expect(service.submitForReview(input)).toEqual(
      service.submitForReview(input),
    );
  });

  it('lets only a human accept review and replays the audited transition', async () => {
    const { service, repositories, task } = setup();
    repositories.database
      .prepare("UPDATE tasks SET lifecycle_state = 'review' WHERE id = ?")
      .run(task.id);

    await expect(
      service.accept({
        commandId: 'command-accept-agent',
        taskId: task.id,
        expectedRevision: 1,
        actor: developer,
      }),
    ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });

    const input = {
      commandId: 'command-accept',
      taskId: task.id,
      expectedRevision: 1,
      actor: human,
    };
    const accepted = await service.accept(input);
    const duplicate = await service.accept(input);

    expect(accepted).toMatchObject({
      task: { lifecycleState: 'done', revision: 2 },
      transition: {
        previousState: 'review',
        nextState: 'done',
        actor: human,
      },
      event: { type: 'task.transitioned' },
    });
    expect(duplicate).toEqual(accepted);
    expect(repositories.transitions.listByTask(task.id)).toHaveLength(1);
  });
});
