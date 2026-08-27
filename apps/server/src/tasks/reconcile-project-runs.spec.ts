import { afterEach, describe, expect, it } from 'vitest';

import {
  developerExecutionCycleSchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  workspaceSchema,
  type LifecycleState,
  type ProjectRunItem,
  type Task,
} from '@mesh-session-platform/contracts';

import { recoverInterruptedSessions } from '../runtime/recovery.js';
import { createTestRepositories } from '../test/create-test-database.js';
import {
  ProjectRunReconciliationError,
  reconcileProjectRuns,
} from './reconcile-project-runs.js';

const now = '2026-08-27T01:00:00.000Z';
const reconciledAt = '2026-08-27T01:01:00.000Z';
const human = taskActorSchema.parse({ type: 'human', id: 'operator-1' });

describe('reconcileProjectRuns', () => {
  const disposals: Array<() => void> = [];

  afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

  const setup = (taskCount = 1) => {
    const repositories = createTestRepositories();
    disposals.push(repositories.dispose);
    const project = repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project one',
        repositoryPath: 'C:/code/project-one',
        repositoryIdentity: 'repository-one',
        discoveredAt: now,
        discoveryMetadata: {},
        qaConfiguration: {
          instructions: {
            content: 'Verify the work.',
            revision: 1,
            updatedAt: now,
            updatedBy: human,
          },
          reviewPolicy: 'autonomous_review',
          revision: 1,
          updatedAt: now,
          updatedBy: human,
        },
      }),
    );
    const tasks = Array.from({ length: taskCount }, (_, index) =>
      repositories.tasks.create(
        taskSchema.parse({
          id: `task-${index + 1}`,
          projectId: project.id,
          title: `Task ${index + 1}`,
          description: '',
          acceptanceCriteria: [],
          priority: 'normal',
          rank: String.fromCharCode(97 + index),
          lifecycleState: 'ready',
          labels: [],
          notes: '',
          blocked: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          reviewAutomation: {
            status: 'enabled',
            generation: 1,
            rejectionCount: 0,
            pauseReason: null,
            updatedAt: now,
          },
        }),
      ),
    );
    const run = repositories.projectRuns.create({
      id: 'run-1',
      projectId: project.id,
      concurrency: 1,
      startedAt: now,
      items: tasks.map((task, queuePosition) => ({
        id: `item-${queuePosition + 1}`,
        taskId: task.id,
        taskRevision: task.revision,
        policyRevision: project.qaConfiguration.revision,
        taskAutomationGeneration: task.reviewAutomation.generation,
        queuePosition,
        launchIdempotencyKey: `run-1:${task.id}:launch`,
      })),
    });
    return { project, repositories, run, tasks };
  };

  const reconcile = (
    context: ReturnType<typeof setup>,
    billingConflicts: readonly { variable: string }[] = [],
  ) =>
    reconcileProjectRuns({
      ...context.repositories,
      billingConflicts,
      now: () => reconciledAt,
    });

  const claim = (context: ReturnType<typeof setup>) => {
    const current = context.repositories.projectRuns.get(context.run.id)!;
    const claimed = context.repositories.projectRuns.claimNext({
      runId: current.id,
      expectedRunRevision: current.revision,
      occurredAt: now,
    });
    if (!claimed) throw new Error('Expected claimed item');
    return claimed.item;
  };

  const updateTask = (
    context: ReturnType<typeof setup>,
    taskId: string,
    update: (task: Task) => Task,
  ) => {
    const current = context.repositories.tasks.get(taskId);
    if (!current) throw new Error('Expected task');
    const updated = context.repositories.tasks.update(
      update(current),
      current.revision,
    );
    if (!updated) throw new Error('Expected task update');
    return updated;
  };

  const launchEffect = (
    context: ReturnType<typeof setup>,
    item: ProjectRunItem,
    options: {
      sessionState?: LifecycleState;
      taskState?: Task['lifecycleState'];
      link?: boolean;
    } = {},
  ) => {
    const workspace = context.repositories.workspaces.create(
      workspaceSchema.parse({
        id: `workspace-${item.id}`,
        projectId: item.projectId,
        type: 'shared',
        path: context.project.repositoryPath,
      }),
    );
    const session = context.repositories.sessions.create(
      sessionSchema.parse({
        id: `session-${item.id}`,
        projectId: item.projectId,
        workspaceId: workspace.id,
        title: item.taskId,
        permissionMode: 'safe_auto',
        lifecycleState: options.sessionState ?? 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = context.repositories.attempts.createForTask(
      item.taskId,
      session.id,
      { type: 'project_run', runId: item.runId, runItemId: item.id },
      taskActorSchema.parse({
        type: 'system',
        id: `project-run:${item.runId}:${item.id}`,
      }),
      'developer',
    );
    if (options.taskState) {
      updateTask(context, item.taskId, (task) => ({
        ...task,
        lifecycleState: options.taskState!,
        updatedAt: now,
      }));
    }
    if (options.link) {
      const current = context.repositories.projectRuns.get(item.runId)!;
      context.repositories.projectRuns.linkLaunch({
        runId: current.id,
        itemId: item.id,
        expectedRunRevision: current.revision,
        attemptId: attempt.id,
        sessionId: session.id,
        occurredAt: now,
      });
    }
    return { attempt, session };
  };

  it('links a proven active launch from durable project-run provenance', () => {
    const context = setup();
    const item = claim(context);
    const { attempt, session } = launchEffect(context, item, {
      taskState: 'in_progress',
    });

    const result = reconcile(context);

    expect(result).toEqual({
      repairedItemIds: [item.id],
      pausedRunIds: [],
      launchableRunIds: [],
    });
    expect(
      context.repositories.projectRuns.get(context.run.id)?.items[0],
    ).toMatchObject({
      status: 'active',
      attemptId: attempt.id,
      sessionId: session.id,
    });
  });

  it('returns a proven effect-free launch for idempotent retry', () => {
    const context = setup();
    const item = claim(context);

    expect(reconcile(context)).toEqual({
      repairedItemIds: [],
      pausedRunIds: [],
      launchableRunIds: [context.run.id],
    });
    expect(
      context.repositories.projectRuns.get(context.run.id)?.items[0],
    ).toMatchObject({ id: item.id, status: 'launch_pending', attemptId: null });
  });

  it('does not attach an older unlinked attempt repair to a new launch claim', () => {
    const context = setup();
    const item = claim(context);
    const workspace = context.repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'historical-workspace',
        projectId: context.project.id,
        type: 'shared',
        path: context.project.repositoryPath,
      }),
    );
    const session = context.repositories.sessions.create(
      sessionSchema.parse({
        id: 'historical-session',
        projectId: context.project.id,
        workspaceId: workspace.id,
        title: 'Historical Developer',
        permissionMode: 'safe_auto',
        lifecycleState: 'interrupted',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const historical = context.repositories.attempts.createForTask(
      item.taskId,
      session.id,
      'launched',
      human,
      'developer',
    );
    context.repositories.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'historical-cycle',
        attemptId: historical.id,
        ordinal: 1,
        mode: 'new',
        authorizedBy: human,
        authorizationCommandId: 'historical-launch',
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: 'Historical task',
          description: '',
          acceptanceCriteria: [],
        },
        workspaceId: workspace.id,
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
    context.repositories.attempts.unlink(
      historical.id,
      human,
      'Superseded before the run.',
      now,
    );

    expect(reconcile(context)).toEqual({
      repairedItemIds: [],
      pausedRunIds: [],
      launchableRunIds: [context.run.id],
    });
    expect(
      context.repositories.projectRuns.get(context.run.id)?.items[0],
    ).toMatchObject({ status: 'launch_pending', outcomeReason: null });
  });

  it('closes a terminal task without consulting process or transcript state', () => {
    const context = setup();
    const item = claim(context);
    launchEffect(context, item, { taskState: 'done', link: true });

    expect(reconcile(context)).toEqual({
      repairedItemIds: [item.id],
      pausedRunIds: [],
      launchableRunIds: [],
    });
    expect(context.repositories.projectRuns.get(context.run.id)).toMatchObject({
      state: 'completed',
      completionReason: 'queue_finished',
      items: [
        expect.objectContaining({
          status: 'completed',
          outcomeReason: 'task_done',
        }),
      ],
    });
  });

  it('runs attempt reconciliation first and releases a known local repair', () => {
    const context = setup(2);
    const item = claim(context);
    launchEffect(context, item, {
      sessionState: 'interrupted',
      taskState: 'in_progress',
      link: true,
    });

    const result = reconcile(context);
    const events = context.repositories.projectEvents.after(
      context.project.id,
      0,
    );

    expect(result).toEqual({
      repairedItemIds: [item.id],
      pausedRunIds: [],
      launchableRunIds: [context.run.id],
    });
    expect(events.map(({ type }) => type)).toEqual([
      'task.attempt_repair_detected',
      'project.run_changed',
    ]);
    expect(context.repositories.projectRuns.get(context.run.id)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: item.id,
          status: 'attention_required',
          outcomeReason: 'task_in_progress_without_live_session',
        }),
        expect.objectContaining({ taskId: 'task-2', status: 'queued' }),
      ]),
    );
  });

  it('pauses when a recovered launch has an unknown outcome', () => {
    const context = setup();
    const item = claim(context);
    launchEffect(context, item, { sessionState: 'starting' });
    recoverInterruptedSessions(context.repositories.database);

    expect(reconcile(context)).toEqual({
      repairedItemIds: [],
      pausedRunIds: [context.run.id],
      launchableRunIds: [],
    });
    expect(context.repositories.projectRuns.get(context.run.id)).toMatchObject({
      state: 'paused',
      items: [expect.objectContaining({ status: 'launch_pending' })],
    });
  });

  it('pauses when persisted occupied capacity exceeds authorization', () => {
    const context = setup(2);
    context.repositories.database
      .prepare(
        "UPDATE project_run_items SET status = 'launch_pending', claimed_at = ? WHERE run_id = ?",
      )
      .run(now, context.run.id);

    expect(reconcile(context)).toEqual({
      repairedItemIds: [],
      pausedRunIds: [context.run.id],
      launchableRunIds: [],
    });
    expect(context.repositories.projectRuns.get(context.run.id)?.state).toBe(
      'paused',
    );
  });

  it('does not reopen or schedule a paused run', () => {
    const context = setup();
    const paused = context.repositories.projectRuns.changeState({
      runId: context.run.id,
      expectedRunRevision: context.run.revision,
      state: 'paused',
      occurredAt: now,
    });
    if (!paused) throw new Error('Expected paused run');

    expect(reconcile(context)).toEqual({
      repairedItemIds: [],
      pausedRunIds: [],
      launchableRunIds: [],
    });
    expect(context.repositories.projectRuns.get(context.run.id)).toEqual(
      paused,
    );
  });

  it('finishes a fully drained stopped run without launching work', () => {
    const context = setup();
    const stoppedItem = context.repositories.projectRuns.finishItem({
      runId: context.run.id,
      itemId: context.run.items[0]!.id,
      expectedRunRevision: context.run.revision,
      status: 'not_started',
      outcomeReason: 'stopped',
      occurredAt: now,
    });
    const draining = context.repositories.projectRuns.changeState({
      runId: context.run.id,
      expectedRunRevision: stoppedItem.revision,
      state: 'draining',
      occurredAt: now,
    });
    if (!draining) throw new Error('Expected draining run');

    expect(reconcile(context)).toEqual({
      repairedItemIds: [],
      pausedRunIds: [],
      launchableRunIds: [],
    });
    expect(context.repositories.projectRuns.get(context.run.id)).toMatchObject({
      state: 'completed',
      completionReason: 'stopped',
    });
  });

  it('never makes a stopped run resumable when its capacity is ambiguous', () => {
    const context = setup(2);
    context.repositories.database
      .prepare(
        "UPDATE project_run_items SET status = 'launch_pending', claimed_at = ? WHERE run_id = ?",
      )
      .run(now, context.run.id);
    const draining = context.repositories.projectRuns.changeState({
      runId: context.run.id,
      expectedRunRevision: context.run.revision,
      state: 'draining',
      occurredAt: now,
    });
    if (!draining) throw new Error('Expected draining run');

    try {
      reconcile(context);
      throw new Error('Expected ambiguous draining capacity');
    } catch (error) {
      expect(error).toMatchObject({ code: 'capacity_ambiguous' });
    }
    expect(context.repositories.projectRuns.get(context.run.id)?.state).toBe(
      'draining',
    );
  });

  it('is idempotent across duplicate startup reconciliation', () => {
    const context = setup();
    const item = claim(context);
    launchEffect(context, item, { taskState: 'done', link: true });

    const first = reconcile(context);
    const eventCount = context.repositories.projectEvents.after(
      context.project.id,
      0,
    ).length;
    const second = reconcile(context);

    expect(first.repairedItemIds).toEqual([item.id]);
    expect(second).toEqual({
      repairedItemIds: [],
      pausedRunIds: [],
      launchableRunIds: [],
    });
    expect(
      context.repositories.projectEvents.after(context.project.id, 0),
    ).toHaveLength(eventCount);
  });

  it('pauses project-wide repository and billing ambiguity', () => {
    const repositoryUnsafe = setup();
    repositoryUnsafe.repositories.projects.archive(
      repositoryUnsafe.project.id,
      now,
    );
    expect(reconcile(repositoryUnsafe).pausedRunIds).toEqual([
      repositoryUnsafe.run.id,
    ]);

    const billingUnsafe = setup();
    expect(
      reconcile(billingUnsafe, [{ variable: 'ANTHROPIC_API_KEY' }])
        .pausedRunIds,
    ).toEqual([billingUnsafe.run.id]);
  });

  it('fails closed with audit_failed when a repair event cannot persist', () => {
    const context = setup();
    const item = claim(context);
    launchEffect(context, item, { taskState: 'done', link: true });
    context.repositories.database.exec(`
      CREATE TRIGGER fail_project_run_reconcile_event
      BEFORE INSERT ON project_events
      BEGIN
        SELECT RAISE(FAIL, 'project run reconcile event failed');
      END;
    `);

    try {
      reconcile(context);
      throw new Error('Expected audit failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectRunReconciliationError);
      expect(error).toMatchObject({ code: 'audit_failed' });
    }
    expect(context.repositories.projectRuns.get(context.run.id)).toMatchObject({
      state: 'running',
      items: [expect.objectContaining({ status: 'active' })],
    });
  });
});
