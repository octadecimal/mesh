import { afterEach, describe, expect, it } from 'vitest';
import {
  developerExecutionCycleSchema,
  idSchema,
  developerBlockerReportSchema,
  projectSchema,
  qaExecutionCycleSchema,
  qaReportSchema,
  rawDiagnosticSchema,
  reviewAutomationActionSchema,
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
import { QaCapabilityRegistry } from './qa-capability-registry.js';

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
    blocked?: boolean;
    automationStatus?: 'disabled' | 'enabled' | 'paused';
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
        blocked: options.blocked
          ? { reason: 'Waiting for input', actor, blockedAt: now }
          : null,
        reviewAutomation: {
          status: options.automationStatus ?? 'disabled',
          generation: 1,
          rejectionCount: 0,
          pauseReason:
            options.automationStatus === 'paused'
              ? 'Already paused for operator review.'
              : null,
          updatedAt: now,
        },
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

  const addQaCycle = (
    repositories: ReturnType<typeof setup>,
    options: {
      sessionId?: string;
      sessionState?: LifecycleState;
      sessionWorkspaceId?: string;
      terminal?: boolean;
    } = {},
  ) => {
    const sessionId = options.sessionId ?? 'qa-session-1';
    const sessionWorkspaceId = options.sessionWorkspaceId ?? 'workspace-1';
    if (!repositories.sessions.get(sessionId)) {
      repositories.sessions.create(
        sessionSchema.parse({
          id: sessionId,
          projectId: 'project-1',
          workspaceId: sessionWorkspaceId,
          title: 'QA cycle one',
          permissionMode: 'safe_auto',
          lifecycleState: options.sessionState ?? 'interrupted',
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    const active = repositories.qaExecutions.createCycle(
      qaExecutionCycleSchema.parse({
        id: 'qa-cycle-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sessionId,
        ordinal: 1,
        authorizedBy: actor,
        authorizationCommandId: 'start-qa-1',
        policyVersion: 'qa-policy-v1',
        qaInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: 'Recover attempt state',
          description: 'Keep task outcomes under human control.',
          acceptanceCriteria: [
            { id: 'criterion-1', text: 'Restart state is explicit.' },
          ],
        },
        developerCompletionReportId: 'completion-report-1',
        workspaceId: 'workspace-1',
        reviewPolicy: 'autonomous_review',
        reviewPolicyRevision: 1,
        automationGeneration: 1,
        rejectionOrdinal: 0,
        startedAt: now,
        endedAt: null,
        terminalDisposition: null,
        reportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      }),
    );
    if (!options.terminal) return active;

    const report = repositories.qaExecutions.insertReport(
      qaReportSchema.parse({
        id: 'qa-report-1',
        cycleId: active.id,
        disposition: 'verified',
        criterionResults: [
          {
            criterionId: 'criterion-1',
            status: 'passed',
            evidence: 'Focused restart test passed.',
          },
        ],
        verificationCommands: [{ command: 'pnpm test', outcome: 'passed' }],
        limitations: [],
        residualRisks: [],
        workspaceBefore: 'workspace-state-1',
        workspaceAfter: 'workspace-state-1',
        createdAt: now,
      }),
    );
    const completed = repositories.qaExecutions.completeCycle(active.id, {
      endedAt: now,
      terminalDisposition: 'verified',
      reportId: report.id,
      terminalCommandId: 'qa-verdict-1',
      terminalEventId: 'qa-event-1',
    });
    if (!completed) throw new Error('Expected QA cycle completion');
    return completed;
  };

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

  it('does not flag a normal terminal Developer blocker as an orphaned task', () => {
    const repositories = setup({
      taskState: 'in_progress',
      sessionState: 'interrupted',
      blocked: true,
    });
    const active = repositories.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'cycle-blocked',
        attemptId: 'attempt-1',
        ordinal: 1,
        mode: 'new',
        authorizedBy: actor,
        authorizationCommandId: 'launch-blocked',
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
    const blocker = developerBlockerReportSchema.parse({
      id: 'blocker-1',
      cycleId: active.id,
      reason: 'Waiting for input',
      evidence: 'Dependency is unavailable.',
      attemptedWork: 'Checked local inputs.',
      suggestedHumanAction: 'Provide the dependency.',
      preserveWorkspace: true,
      createdAt: now,
    });
    repositories.developerExecutions.appendBlockerReport(blocker);
    repositories.developerExecutions.closeCycle(active.id, {
      endedAt: now,
      terminalDisposition: 'blocked',
      completionReportId: null,
      blockerReportId: blocker.id,
      terminalCommandId: idSchema.parse('block-command'),
      terminalEventId: idSchema.parse('block-event'),
    });

    expect(reconcile(repositories)).toEqual({ repairs: [], events: [] });
  });

  it('records every orphan Developer cycle once when a task has multiple attempts', () => {
    const repositories = setup({
      taskState: 'in_progress',
      sessionState: 'completed',
    });
    addAttempt(repositories, {
      ordinal: 2,
      sessionId: 'session-2',
      sessionState: 'failed',
    });
    const cycle = (
      id: string,
      attemptId: string,
      ordinal: number,
      workspaceId: string,
    ) =>
      developerExecutionCycleSchema.parse({
        id,
        attemptId,
        ordinal,
        mode: 'new',
        authorizedBy: actor,
        authorizationCommandId: `launch-${ordinal}`,
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
        workspaceId,
        permissionMode: 'interactive',
        startedAt: `2026-08-25T12:0${ordinal}:00.000Z`,
        endedAt: null,
        terminalDisposition: null,
        completionReportId: null,
        blockerReportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      });
    repositories.developerExecutions.createCycle(
      cycle('cycle-1', 'attempt-1', 1, 'workspace-1'),
    );
    repositories.developerExecutions.createCycle(
      cycle('cycle-2', 'attempt-2', 1, 'workspace-session-2'),
    );

    const first = reconcile(repositories);
    const second = reconcile(repositories);

    const expectedRepairs = [
      {
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        reason: 'developer_cycle_without_live_session',
      },
      {
        taskId: 'task-1',
        attemptId: 'attempt-2',
        sessionId: 'session-2',
        reason: 'developer_cycle_without_live_session',
      },
    ] as const;
    expect(first.repairs).toEqual(expectedRepairs);
    expect(
      first.events.map((event) =>
        event.type === 'task.attempt_repair_detected'
          ? event.payload.repair
          : undefined,
      ),
    ).toEqual(expectedRepairs);
    expect(second).toEqual({ repairs: expectedRepairs, events: [] });
    expect(repositories.projectEvents.after('project-1', 0)).toHaveLength(2);
    expect(
      ['session-1', 'session-2'].map(
        (sessionId) =>
          repositories.diagnostics
            .list(sessionId)
            .filter(
              ({ payload }) =>
                typeof payload === 'object' &&
                payload !== null &&
                'kind' in payload &&
                payload.kind === 'attempt_repair',
            ).length,
      ),
    ).toEqual([1, 1]);
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

  it('preserves project-run provenance when startup outcome is unknown', () => {
    const repositories = setup({
      taskState: 'ready',
      sessionState: 'starting',
      source: {
        type: 'project_run',
        runId: idSchema.parse('run-1'),
        runItemId: idSchema.parse('item-1'),
      },
    });

    recoverInterruptedSessions(repositories.database);

    expect(reconcile(repositories).repairs).toEqual([
      {
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        reason: 'startup_outcome_unknown',
      },
    ]);
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

  it.each([
    ['interrupted', 'interrupted'],
    ['completed', 'completed'],
    ['missing', 'interrupted'],
  ] as const)(
    'reports an active QA cycle with a %s session without inventing a verdict',
    (condition, sessionState) => {
      const repositories = setup({
        taskState: 'review',
        sessionState: 'completed',
        automationStatus: 'enabled',
      });
      const cycle = addQaCycle(repositories, { sessionState });
      const capabilities = new QaCapabilityRegistry();
      const token = capabilities.issue({
        sessionId: cycle.sessionId,
        taskId: cycle.taskId,
        attemptId: cycle.attemptId,
        cycleId: cycle.id,
      });
      const sessions =
        condition === 'missing'
          ? {
              get: (sessionId: string) =>
                sessionId === cycle.sessionId
                  ? undefined
                  : repositories.sessions.get(sessionId),
            }
          : repositories.sessions;

      const first = reconcileTaskAttempts({
        ...repositories,
        sessions,
        qaExecutions: repositories.qaExecutions,
        workspaces: repositories.workspaces,
        qaCapabilities: capabilities,
        now: () => '2026-08-25T12:01:00.000Z',
      });
      const second = reconcileTaskAttempts({
        ...repositories,
        sessions,
        qaExecutions: repositories.qaExecutions,
        workspaces: repositories.workspaces,
        qaCapabilities: capabilities,
        now: () => '2026-08-25T12:02:00.000Z',
      });

      expect(first.repairs).toContainEqual({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sessionId: cycle.sessionId,
        reason: 'qa_cycle_without_trustworthy_outcome',
      });
      expect(
        first.events.filter(
          (event) => event.type === 'task.attempt_repair_detected',
        ),
      ).toHaveLength(1);
      expect(second.events).toEqual([]);
      expect(repositories.qaExecutions.getCycle(cycle.id)).toEqual(cycle);
      expect(
        repositories.qaExecutions.getReport('qa-report-1'),
      ).toBeUndefined();
      expect(repositories.tasks.get('task-1')).toMatchObject({
        lifecycleState: 'review',
        reviewAutomation: { status: 'paused' },
      });
      expect(() => capabilities.resolve(token)).toThrow(
        'The QA capability is invalid.',
      );
    },
  );

  it('reports a QA session bound to a different workspace and preserves both workspaces', () => {
    const repositories = setup({
      taskState: 'review',
      sessionState: 'completed',
      automationStatus: 'enabled',
    });
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-other',
        projectId: 'project-1',
        type: 'shared',
        path: 'C:/work/project-1/other',
      }),
    );
    const cycle = addQaCycle(repositories, {
      sessionState: 'running',
      sessionWorkspaceId: 'workspace-other',
    });

    const first = reconcileTaskAttempts({
      ...repositories,
      qaExecutions: repositories.qaExecutions,
      workspaces: repositories.workspaces,
      qaCapabilities: new QaCapabilityRegistry(),
      now: () => '2026-08-25T12:01:00.000Z',
    });
    const second = reconcileTaskAttempts({
      ...repositories,
      qaExecutions: repositories.qaExecutions,
      workspaces: repositories.workspaces,
      qaCapabilities: new QaCapabilityRegistry(),
      now: () => '2026-08-25T12:02:00.000Z',
    });

    expect(first.repairs).toContainEqual({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      sessionId: cycle.sessionId,
      reason: 'qa_session_workspace_mismatch',
    });
    expect(second.events).toEqual([]);
    expect(repositories.qaExecutions.getCycle(cycle.id)).toEqual(cycle);
    expect(repositories.workspaces.get('workspace-1')).toBeDefined();
    expect(repositories.workspaces.get('workspace-other')).toBeDefined();
  });

  it('lets a valid terminal QA report win over a completed session', () => {
    const repositories = setup({
      taskState: 'review',
      sessionState: 'completed',
      automationStatus: 'enabled',
    });
    const cycle = addQaCycle(repositories, {
      sessionState: 'completed',
      terminal: true,
    });

    expect(
      reconcileTaskAttempts({
        ...repositories,
        qaExecutions: repositories.qaExecutions,
        workspaces: repositories.workspaces,
        qaCapabilities: new QaCapabilityRegistry(),
      }),
    ).toEqual({ repairs: [], events: [] });
    expect(repositories.qaExecutions.getCycle(cycle.id)).toEqual(cycle);
    expect(repositories.qaExecutions.getReport('qa-report-1')).toMatchObject({
      disposition: 'verified',
    });
    expect(repositories.tasks.get('task-1')).toMatchObject({
      lifecycleState: 'review',
      reviewAutomation: { status: 'enabled' },
    });
  });

  it('treats an audited interrupted QA cycle as terminal without a verdict', () => {
    const repositories = setup({
      taskState: 'review',
      sessionState: 'completed',
      automationStatus: 'paused',
    });
    const active = addQaCycle(repositories, { sessionState: 'completed' });
    const interrupted = repositories.qaExecutions.interruptCycle(active.id, {
      endedAt: now,
      terminalCommandId: 'repair-qa-1',
      terminalEventId: 'repair-event-1',
    });
    if (!interrupted) throw new Error('Expected interrupted QA cycle');

    expect(
      reconcileTaskAttempts({
        ...repositories,
        qaExecutions: repositories.qaExecutions,
        workspaces: repositories.workspaces,
        qaCapabilities: new QaCapabilityRegistry(),
      }),
    ).toEqual({ repairs: [], events: [] });
    expect(repositories.qaExecutions.getReport('qa-report-1')).toBeUndefined();
    expect(repositories.qaExecutions.getCycle(active.id)).toEqual(interrupted);
  });

  it.each(['review', 'done'] as const)(
    'reports a pending automatic action when its target task is %s and never replays it',
    (taskState) => {
      const repositories = setup({
        taskState,
        sessionState: 'completed',
        automationStatus: 'enabled',
      });
      const cycle = addQaCycle(repositories, {
        sessionState: 'completed',
        terminal: true,
      });
      const action = repositories.qaExecutions.insertAutomationAction(
        reviewAutomationActionSchema.parse({
          id: 'automation-action-1',
          idempotencyKey: 'task-1:attempt-1:qa-cycle-1:complete_task:1',
          projectId: 'project-1',
          taskId: 'task-1',
          attemptId: 'attempt-1',
          sourceCycleId: cycle.id,
          actionKind: 'complete_task',
          generation: 1,
          status: 'pending',
          errorCode: null,
          createdAt: now,
          completedAt: null,
        }),
      );

      const first = reconcileTaskAttempts({
        ...repositories,
        qaExecutions: repositories.qaExecutions,
        workspaces: repositories.workspaces,
        qaCapabilities: new QaCapabilityRegistry(),
        now: () => '2026-08-25T12:01:00.000Z',
      });
      const second = reconcileTaskAttempts({
        ...repositories,
        qaExecutions: repositories.qaExecutions,
        workspaces: repositories.workspaces,
        qaCapabilities: new QaCapabilityRegistry(),
        now: () => '2026-08-25T12:02:00.000Z',
      });

      expect(first.repairs).toEqual([
        {
          taskId: 'task-1',
          attemptId: 'attempt-1',
          sessionId: cycle.sessionId,
          reason: 'review_automation_action_incomplete',
        },
      ]);
      expect(second).toEqual({ repairs: first.repairs, events: [] });
      expect(repositories.qaExecutions.listPendingAutomationActions()).toEqual([
        action,
      ]);
      expect(repositories.tasks.get('task-1')).toMatchObject({
        lifecycleState: taskState,
        reviewAutomation: { status: 'paused' },
      });
    },
  );
});
