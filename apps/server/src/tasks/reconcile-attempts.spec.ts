import { afterEach, describe, expect, it } from 'vitest';
import {
  developerExecutionCycleSchema,
  projectSchema,
  rawDiagnosticSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  workspaceSchema,
  type LifecycleState,
  type TaskAttemptSource,
  type TaskLifecycleState,
} from '@mesh-session-platform/contracts';

import { recoverInterruptedSessions } from '../runtime/recovery.js';
import { createTestRepositories } from '../test/create-test-database.js';
import {
  reconcileTaskAttemptLaunchReservations,
  reconcileTaskAttempts,
} from './reconcile-attempts.js';

const now = '2026-08-25T12:00:00.000Z';
const actor = taskActorSchema.parse({ type: 'human', id: 'operator-1' });

describe('reconcileTaskAttempts', () => {
  const disposals: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  const setup = (options: {
    taskState: TaskLifecycleState;
    sessionState: LifecycleState;
    cleanupState?: 'active' | 'pending';
    source?: TaskAttemptSource;
    repositories?: Parameters<typeof createTestRepositories>[0];
  }) => {
    const repositories = createTestRepositories(options.repositories);
    disposals.push(repositories.dispose);
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project one',
        repositoryPath: 'C:/work/project-1',
        repositoryIdentity: 'repository-1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.tasks.create(
      taskSchema.parse({
        id: 'task-1',
        projectId: 'project-1',
        title: 'Recover attempt state',
        description: 'Keep task outcomes under human control.',
        acceptanceCriteria: ['Restart state is explicit.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: options.taskState,
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
        projectId: 'project-1',
        type: 'worktree',
        path: 'C:/work/project-1/attempt',
        gitBranch: 'attempt-1',
        gitWorktreePath: 'C:/work/project-1/attempt',
        owner: 'mesh',
        cleanupState: options.cleanupState ?? 'active',
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 'session-1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        title: 'Attempt one',
        permissionMode: 'interactive',
        lifecycleState: options.sessionState,
        createdAt: now,
        updatedAt: now,
      }),
    );
    repositories.attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        ordinal: 1,
        source: options.source ?? 'launched',
        actor,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
    );
    return repositories;
  };

  const addAttempt = (
    repositories: ReturnType<typeof setup>,
    options: {
      ordinal: number;
      sessionId: string;
      sessionState: LifecycleState;
      source?: TaskAttemptSource;
    },
  ) => {
    const workspaceId = `workspace-${options.sessionId}`;
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: workspaceId,
        projectId: 'project-1',
        type: 'shared',
        path: `C:/work/project-1/${options.sessionId}`,
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: options.sessionId,
        projectId: 'project-1',
        workspaceId,
        title: `Attempt ${options.ordinal}`,
        permissionMode: 'interactive',
        lifecycleState: options.sessionState,
        createdAt: now,
        updatedAt: now,
      }),
    );
    repositories.attempts.create(
      taskAttemptSchema.parse({
        id: `attempt-${options.ordinal}`,
        taskId: 'task-1',
        sessionId: options.sessionId,
        ordinal: options.ordinal,
        source: options.source ?? 'launched',
        actor,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
    );
  };

  const reconcile = (repositories: ReturnType<typeof setup>) =>
    reconcileTaskAttempts({
      ...repositories,
      now: () => '2026-08-25T12:01:00.000Z',
    });

  it('releases a crash-stale reservation before attempt persistence', () => {
    const repositories = setup({
      taskState: 'ready',
      sessionState: 'completed',
    });
    repositories.database
      .prepare(
        'INSERT INTO task_attempt_launch_reservations (task_id, command_id, created_at) VALUES (?, ?, ?)',
      )
      .run('task-1', 'crashed-command', now);

    expect(reconcileTaskAttemptLaunchReservations(repositories.database)).toBe(
      1,
    );
    expect(
      repositories.database
        .prepare('SELECT task_id FROM task_attempt_launch_reservations')
        .all(),
    ).toEqual([]);
  });

  it('releases a recovered reservation after attempt persistence but preserves a live launch', () => {
    const repositories = setup({
      taskState: 'ready',
      sessionState: 'running',
    });
    repositories.database
      .prepare(
        'INSERT INTO task_attempt_launch_reservations (task_id, command_id, session_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('task-1', 'active-command', 'session-1', now);

    expect(reconcileTaskAttemptLaunchReservations(repositories.database)).toBe(
      0,
    );
    expect(
      repositories.database
        .prepare('SELECT task_id FROM task_attempt_launch_reservations')
        .all(),
    ).toHaveLength(1);

    recoverInterruptedSessions(repositories.database);

    expect(reconcileTaskAttemptLaunchReservations(repositories.database)).toBe(
      1,
    );
    expect(
      repositories.database
        .prepare('SELECT task_id FROM task_attempt_launch_reservations')
        .all(),
    ).toEqual([]);
  });

  it('repairs a recovered in-progress attempt without moving the task or workspace', () => {
    const repositories = setup({
      taskState: 'in_progress',
      sessionState: 'running',
      cleanupState: 'pending',
    });

    expect(recoverInterruptedSessions(repositories.database)).toBe(1);
    const first = reconcile(repositories);
    const second = reconcile(repositories);

    expect(repositories.sessions.get('session-1')?.lifecycleState).toBe(
      'interrupted',
    );
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe(
      'in_progress',
    );
    expect(repositories.workspaces.get('workspace-1')?.cleanupState).toBe(
      'pending',
    );
    expect(first.repairs).toEqual([
      {
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        reason: 'task_in_progress_without_live_session',
      },
    ]);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      projectId: 'project-1',
      type: 'task.attempt_repair_detected',
      payload: { repair: first.repairs[0] },
    });
    expect(second).toEqual({ repairs: first.repairs, events: [] });

    const repairDiagnostics = repositories.diagnostics
      .list('session-1')
      .filter(
        (diagnostic) =>
          typeof diagnostic.payload === 'object' &&
          diagnostic.payload !== null &&
          'kind' in diagnostic.payload &&
          diagnostic.payload.kind === 'attempt_repair',
      );
    expect(repairDiagnostics).toHaveLength(1);
    expect(repairDiagnostics[0]?.normalizedEventId).toBeUndefined();
    expect(repositories.projectEvents.after('project-1', 0)).toEqual(
      first.events,
    );
  });

  it('records one repair for an open Developer cycle with a non-live canonical session', () => {
    const repositories = setup({
      taskState: 'in_progress',
      sessionState: 'completed',
    });
    const cycle = repositories.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'cycle-1',
        attemptId: 'attempt-1',
        ordinal: 1,
        mode: 'new',
        authorizedBy: actor,
        authorizationCommandId: 'launch-1',
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: 'Recover attempt state',
          description: 'Keep task outcomes under human control.',
          acceptanceCriteria: [
            { id: 'criterion-1', text: 'Restart state is explicit.' },
          ],
        },
        workspaceId: 'workspace-1',
        permissionMode: 'interactive',
        startedAt: now,
        endedAt: null,
        terminalDisposition: null,
        completionReportId: null,
        blockerReportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      }),
    );

    const first = reconcile(repositories);
    const second = reconcile(repositories);

    expect(first.repairs).toEqual([
      {
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        reason: 'developer_cycle_without_live_session',
      },
    ]);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      type: 'task.attempt_repair_detected',
      payload: { repair: first.repairs[0] },
    });
    expect(second).toEqual({ repairs: first.repairs, events: [] });
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe(
      'in_progress',
    );
    expect(repositories.developerExecutions.getCycle(cycle.id)).toEqual(cycle);
    expect(
      repositories.database
        .prepare('SELECT COUNT(*) AS count FROM developer_completion_reports')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      repositories.database
        .prepare('SELECT COUNT(*) AS count FROM developer_blocker_reports')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      repositories.diagnostics
        .list('session-1')
        .filter(
          ({ payload }) =>
            typeof payload === 'object' &&
            payload !== null &&
            'kind' in payload &&
            payload.kind === 'attempt_repair',
        ),
    ).toHaveLength(1);
  });

  it('reports an unknown startup after recovery while retaining the ready task', () => {
    const repositories = setup({
      taskState: 'ready',
      sessionState: 'starting',
    });

    recoverInterruptedSessions(repositories.database);
    const result = reconcile(repositories);

    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
    expect(result.repairs).toEqual([
      {
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        reason: 'startup_outcome_unknown',
      },
    ]);
  });

  it('does not treat a recovered linked session as an unknown startup', () => {
    const repositories = setup({
      taskState: 'ready',
      sessionState: 'running',
      source: 'linked',
    });

    recoverInterruptedSessions(repositories.database);

    expect(reconcile(repositories)).toEqual({ repairs: [], events: [] });
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
  });

  it('does not repair an in-progress task while any current attempt is live', () => {
    const repositories = setup({
      taskState: 'in_progress',
      sessionState: 'completed',
    });
    addAttempt(repositories, {
      ordinal: 2,
      sessionId: 'session-2',
      sessionState: 'running',
    });

    expect(reconcile(repositories)).toEqual({ repairs: [], events: [] });
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe(
      'in_progress',
    );
  });

  it('rolls back the diagnostic when the repair project event fails', () => {
    const repositories = setup({
      taskState: 'in_progress',
      sessionState: 'interrupted',
      repositories: { failProjectEventInsert: true },
    });

    expect(() => reconcile(repositories)).toThrow(
      'project event insert failed',
    );
    expect(repositories.diagnostics.list('session-1')).toEqual([]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([]);
    expect(repositories.projectEvents.latestSequence('project-1')).toBe(0);
  });

  it('backfills one repair event when a legacy diagnostic and event already exist', () => {
    const repositories = setup({
      taskState: 'in_progress',
      sessionState: 'interrupted',
    });
    const repair = {
      taskId: 'task-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      reason: 'task_in_progress_without_live_session' as const,
    };
    const attempt = repositories.attempts.listByTask('task-1')[0];
    if (!attempt) throw new Error('Expected seeded task attempt');
    const project = repositories.projects.list()[0];
    if (!project) throw new Error('Expected seeded project');
    repositories.diagnostics.insert(
      rawDiagnosticSchema.parse({
        id: `attempt-repair-diagnostic-${repair.attemptId}-${repair.reason}`,
        sessionId: repair.sessionId,
        capturedAt: now,
        payload: { kind: 'attempt_repair', repair },
      }),
    );
    repositories.projectEvents.append(project.id, {
      protocolVersion: 1,
      id: `attempt-repair-event-${repair.attemptId}-${repair.reason}`,
      projectId: project.id,
      occurredAt: now,
      type: 'task.attempt_changed',
      payload: { attempt },
    });

    const first = reconcile(repositories);
    const second = reconcile(repositories);
    const history = repositories.projectEvents.after('project-1', 0);

    expect(first.repairs).toEqual([repair]);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      id: `attempt-repair-event-v2-${repair.attemptId}-${repair.reason}`,
      type: 'task.attempt_repair_detected',
      payload: { repair },
    });
    expect(second).toEqual({ repairs: [repair], events: [] });
    expect(
      repositories.diagnostics
        .list('session-1')
        .filter(
          (diagnostic) =>
            typeof diagnostic.payload === 'object' &&
            diagnostic.payload !== null &&
            'kind' in diagnostic.payload &&
            diagnostic.payload.kind === 'attempt_repair',
        ),
    ).toHaveLength(1);
    expect(
      history.filter((event) => event.type === 'task.attempt_repair_detected'),
    ).toEqual(first.events);
    expect(history).toHaveLength(2);
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe(
      'in_progress',
    );
    expect(repositories.workspaces.get('workspace-1')?.cleanupState).toBe(
      'active',
    );
  });

  it('retains a ready task after a known failed startup without inventing a repair', () => {
    const repositories = setup({
      taskState: 'ready',
      sessionState: 'failed',
    });

    expect(reconcile(repositories)).toEqual({ repairs: [], events: [] });
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
  });

  it('leaves a task unchanged when its session completed', () => {
    const repositories = setup({
      taskState: 'ready',
      sessionState: 'completed',
    });

    expect(reconcile(repositories)).toEqual({ repairs: [], events: [] });
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
  });
});
