import { afterEach, describe, expect, it } from 'vitest';
import {
  projectSchema,
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
import { reconcileTaskAttempts } from './reconcile-attempts.js';

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
