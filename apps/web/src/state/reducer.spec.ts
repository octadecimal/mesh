import type {
  AttemptRepair,
  DeveloperBlockerReport,
  DeveloperCompletionReport,
  DeveloperExecutionCycle,
  DeveloperReviewFeedback,
  ProjectEvent,
  ProjectRun,
  ProjectSnapshot,
  QaExecutionCycle,
  QaReport,
  ReviewAutomationAction,
  SessionEvent,
  SessionSnapshot,
  Task,
  TaskAttempt,
  TaskDependency,
  TaskTransition,
} from '@mesh-session-platform/contracts';
import { projectEventSchema } from '@mesh-session-platform/contracts';

import {
  applyEvent,
  applyProjectEvent,
  createProjection,
  replaceProjectSnapshot,
  replaceSnapshot,
} from './reducer';
import { createResyncCoordinator } from './resync';
import { createMeshStore } from './store';

const timestamp = '2026-08-24T00:00:00.000Z';

const event = (sequence: number): SessionEvent => ({
  protocolVersion: 1,
  id: `event-${sequence}`,
  sessionId: 'session-1',
  sequence,
  occurredAt: timestamp,
  type: 'message.assistant',
  payload: { text: `message ${sequence}` },
});

const snapshot = (sequence = 3): SessionSnapshot => ({
  protocolVersion: 1,
  projects: [],
  workspaces: [],
  sessions: [],
  events: sequence === 0 ? [] : [event(sequence)],
  pendingApprovals: [],
  lastSequenceBySession: { 'session-1': sequence },
  layouts: [],
});

const project = {
  id: 'project-1',
  displayName: 'Project one',
  repositoryPath: 'C:/code/project-one',
  repositoryIdentity: 'project-one',
  discoveredAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  discoveryMetadata: {},
  revision: 1,
};

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  projectId: project.id,
  title: 'Task one',
  description: '',
  acceptanceCriteria: [],
  priority: 'normal',
  rank: 'a',
  lifecycleState: 'backlog',
  labels: [],
  notes: '',
  blocked: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  reviewAutomation: {
    status: 'disabled',
    generation: 0,
    rejectionCount: 0,
    pauseReason: null,
    updatedAt: timestamp,
  },
  ...overrides,
});

const attempt: TaskAttempt = {
  id: 'attempt-1',
  taskId: 'task-1',
  sessionId: 'session-1',
  ordinal: 1,
  source: 'launched',
  actor: { type: 'human', id: 'operator' },
  createdAt: timestamp,
  unlinkedAt: null,
  unlinkedBy: null,
  unlinkReason: null,
};

const transition: TaskTransition = {
  id: 'transition-1',
  taskId: 'task-1',
  commandId: 'command-1',
  previousState: 'backlog',
  nextState: 'ready',
  actor: { type: 'human', id: 'operator' },
  reason: null,
  occurredAt: timestamp,
};

const repair: AttemptRepair = {
  taskId: 'task-1',
  attemptId: 'attempt-1',
  sessionId: 'session-1',
  reason: 'startup_outcome_unknown',
};

const developerCycle: DeveloperExecutionCycle = {
  id: 'cycle-1',
  attemptId: attempt.id,
  ordinal: 1,
  mode: 'new',
  authorizedBy: { type: 'human', id: 'operator' },
  authorizationCommandId: 'command-developer-1',
  policyVersion: 'v1',
  projectInstructions: { content: 'Use tests.', revision: 1 },
  taskSnapshot: {
    revision: 1,
    title: 'Task one',
    description: '',
    acceptanceCriteria: [{ id: 'criterion-1', text: 'Complete the task.' }],
  },
  workspaceId: 'workspace-1',
  permissionMode: 'interactive',
  startedAt: timestamp,
  endedAt: null,
  terminalDisposition: null,
  completionReportId: null,
  blockerReportId: null,
  terminalCommandId: null,
  terminalEventId: null,
};

const completionReport: DeveloperCompletionReport = {
  id: 'completion-1',
  cycleId: developerCycle.id,
  summary: 'Completed.',
  criterionResults: [
    { criterionId: 'criterion-1', status: 'met', evidence: 'Completed.' },
  ],
  verification: [],
  limitations: '',
  workspaceState: {
    summary: 'Clean.',
    hasUncommittedChanges: false,
    commitsCreated: true,
  },
  reviewerNotes: null,
  createdAt: timestamp,
};

const blockerReport: DeveloperBlockerReport = {
  id: 'blocker-1',
  cycleId: developerCycle.id,
  reason: 'Blocked.',
  evidence: 'Evidence.',
  attemptedWork: 'Attempted.',
  suggestedHumanAction: 'Help.',
  preserveWorkspace: true,
  createdAt: timestamp,
};

const reviewFeedback: DeveloperReviewFeedback = {
  id: 'feedback-1',
  cycleId: developerCycle.id,
  taskId: task().id,
  kind: 'rejection',
  feedback: 'Please revise.',
  actor: { type: 'human', id: 'operator' },
  commandId: 'command-feedback-1',
  createdAt: timestamp,
};

const qaCycle: QaExecutionCycle = {
  id: 'qa-cycle-1',
  taskId: task().id,
  attemptId: attempt.id,
  sessionId: 'qa-session-1',
  ordinal: 1,
  authorizedBy: { type: 'human', id: 'operator' },
  authorizationCommandId: 'command-qa-1',
  policyVersion: 'qa-policy-v1',
  qaInstructions: { content: 'Verify reconnect.', revision: 1 },
  taskSnapshot: {
    revision: 1,
    title: 'Task one',
    description: '',
    acceptanceCriteria: [
      { id: 'criterion-1', text: 'Reconnect preserves QA history.' },
    ],
  },
  developerCompletionReportId: completionReport.id,
  workspaceId: 'workspace-1',
  reviewPolicy: 'autonomous_review',
  reviewPolicyRevision: 1,
  automationGeneration: 1,
  rejectionOrdinal: 0,
  startedAt: timestamp,
  endedAt: null,
  terminalDisposition: null,
  reportId: null,
  terminalCommandId: null,
  terminalEventId: null,
};

const qaReport: QaReport = {
  id: 'qa-report-1',
  cycleId: qaCycle.id,
  disposition: 'rejected',
  criterionResults: [
    {
      criterionId: 'criterion-1',
      status: 'failed',
      evidence: 'The reconnect assertion failed.',
    },
  ],
  verificationCommands: [{ command: 'pnpm test', outcome: 'failed' }],
  limitations: [],
  residualRisks: ['QA history could disappear after reconnect.'],
  workspaceBefore: 'clean',
  workspaceAfter: 'clean',
  createdAt: timestamp,
};

const automationAction: ReviewAutomationAction = {
  id: 'automation-action-1',
  idempotencyKey: 'task-1:attempt-1:qa-cycle-1:resume:1',
  projectId: project.id,
  taskId: task().id,
  attemptId: attempt.id,
  sourceCycleId: qaCycle.id,
  actionKind: 'resume_developer',
  generation: 1,
  status: 'pending',
  errorCode: null,
  createdAt: timestamp,
  completedAt: null,
};

const run = (overrides: Partial<ProjectRun> = {}): ProjectRun => ({
  id: 'run-1',
  projectId: project.id,
  revision: 1,
  concurrency: 2,
  state: 'running',
  startedAt: timestamp,
  updatedAt: timestamp,
  completionReason: null,
  completedAt: null,
  items: [
    {
      id: 'run-item-1',
      runId: 'run-1',
      projectId: project.id,
      taskId: task().id,
      taskRevision: 1,
      policyRevision: 1,
      taskAutomationGeneration: 0,
      queuePosition: 0,
      status: 'queued',
      outcomeReason: null,
      attemptId: null,
      sessionId: null,
      launchIdempotencyKey: 'run-1:run-item-1:launch',
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
  ...overrides,
});

const projectSnapshot = (
  overrides: Partial<ProjectSnapshot> = {},
): ProjectSnapshot => ({
  protocolVersion: 1,
  project,
  tasks: [task()],
  attempts: [attempt],
  transitions: [transition],
  repairs: [repair],
  developerCycles: [developerCycle],
  developerCompletionReports: [completionReport],
  developerBlockerReports: [blockerReport],
  developerReviewFeedback: [reviewFeedback],
  qaCycles: [qaCycle],
  qaReports: [qaReport],
  reviewAutomationActions: [automationAction],
  runs: [],
  dependencies: [],
  projectRunLimits: { maxConcurrency: 4 },
  cursor: 3,
  ...overrides,
});

const projectEvent = (sequence: number): ProjectEvent => ({
  protocolVersion: 1,
  id: `project-event-${sequence}`,
  projectId: project.id,
  sequence,
  occurredAt: timestamp,
  type: 'task.rank_changed',
  payload: { task: task({ rank: `rank-${sequence}` }) },
});

const dependency = (
  overrides: Partial<TaskDependency> = {},
): TaskDependency => ({
  projectId: project.id,
  taskId: task().id,
  prerequisiteTaskId: 'prerequisite',
  createdBy: { type: 'human', id: 'operator' },
  createdAt: timestamp,
  ...overrides,
});

describe('applyEvent', () => {
  it('reports duplicate, gap, then applied without changing the input projection', () => {
    const state = createProjection(snapshot());

    expect(applyEvent(state, event(3))).toEqual({ kind: 'duplicate' });
    expect(applyEvent(state, event(5))).toEqual({
      kind: 'gap',
      expected: 4,
      received: 5,
    });

    const applied = applyEvent(state, event(4));
    expect(applied.kind).toBe('applied');
    if (applied.kind === 'applied') {
      expect(applied.state.lastSequenceBySession['session-1']).toBe(4);
      expect(applied.state.events.map((item) => item.sequence)).toEqual([3, 4]);
    }
    expect(state.lastSequenceBySession['session-1']).toBe(3);
  });

  it('accumulates transient text and clears it when the durable reply arrives', () => {
    const store = createMeshStore(snapshot(0));

    store.appendAssistantDelta('session-1', 'Hel');
    store.appendAssistantDelta('session-1', 'lo');
    expect(store.state.streamingAssistantTextBySession['session-1'].get()).toBe(
      'Hello',
    );

    store.applyEvent(event(1));
    expect(
      store.state.streamingAssistantTextBySession['session-1'].get(),
    ).toBeUndefined();
  });

  it('clears transient text at every stale-stream boundary', () => {
    const store = createMeshStore(snapshot(0));
    const append = () =>
      store.appendAssistantDelta('session-1', 'unfinished response');
    const expectCleared = () =>
      expect(
        store.state.streamingAssistantTextBySession['session-1'].get(),
      ).toBeUndefined();

    append();
    store.applyEvent({
      ...event(1),
      type: 'session.error',
      payload: { code: 'driver_crashed', message: 'stopped' },
    });
    expectCleared();

    append();
    store.applyEvent({
      ...event(2),
      type: 'session.status',
      payload: { from: 'running', to: 'interrupted' },
    });
    expectCleared();

    append();
    store.replaceSnapshot(snapshot(2));
    expectCleared();

    append();
    store.setConnectionHealth('disconnected');
    expectCleared();
  });
});

describe('replaceSnapshot', () => {
  it('replaces canonical data while retaining prompt drafts and transient selections', () => {
    const current = {
      ...createProjection(snapshot()),
      selectedSessionId: 'session-1',
      promptDrafts: { 'session-1': 'keep this draft' },
      unreadSessionIds: { 'session-1': true },
    };
    const fresh = {
      ...snapshot(7),
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          title: 'Fresh session',
          permissionMode: 'interactive',
          lifecycleState: 'running',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    } satisfies SessionSnapshot;

    const next = replaceSnapshot(current, fresh);

    expect(next.sessions).toEqual(fresh.sessions);
    expect(next.lastSequenceBySession).toEqual({ 'session-1': 7 });
    expect(next.promptDrafts).toEqual({ 'session-1': 'keep this draft' });
    expect(next.selectedSessionId).toBe('session-1');
    expect(next.unreadSessionIds).toEqual({ 'session-1': true });
  });

  it('keeps project QA state independent from a session snapshot refresh', () => {
    const current = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot(),
    );

    const next = replaceSnapshot(current, snapshot(7));

    expect(next.qaCyclesByAttemptId).toEqual(current.qaCyclesByAttemptId);
    expect(next.qaReportsByCycleId).toEqual(current.qaReportsByCycleId);
    expect(next.reviewAutomationByTaskId).toEqual(
      current.reviewAutomationByTaskId,
    );
  });

  it('removes normalized runs for projects absent from a fresh session snapshot', () => {
    const current = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot({ runs: [run()] }),
    );

    const next = replaceSnapshot(current, snapshot(7));

    expect(next.projectRunsById).toEqual({});
    expect(next.projectRunIdsByProjectId).toEqual({});
    expect(next.projectRunMaxConcurrencyByProjectId).toEqual({});
  });
});

describe('project projection', () => {
  it('normalizes snapshot runs and replaces only the snapshotted project run history', () => {
    const completedRun: ProjectRun = {
      ...run({ id: 'run-completed' }),
      state: 'completed',
      completionReason: 'queue_finished',
      completedAt: timestamp,
    };
    const otherProject = { ...project, id: 'project-2' };
    const otherRun = run({
      id: 'run-other',
      projectId: otherProject.id,
      items: [
        {
          ...run().items[0],
          id: 'run-item-other',
          runId: 'run-other',
          projectId: otherProject.id,
          taskId: 'task-2',
        },
      ],
    });
    const withBothProjects = replaceProjectSnapshot(
      replaceProjectSnapshot(
        createProjection(snapshot()),
        projectSnapshot({ runs: [completedRun, run()] }),
      ),
      projectSnapshot({
        project: otherProject,
        tasks: [],
        attempts: [],
        transitions: [],
        repairs: [],
        developerCycles: [],
        developerCompletionReports: [],
        developerBlockerReports: [],
        developerReviewFeedback: [],
        qaCycles: [],
        qaReports: [],
        reviewAutomationActions: [],
        runs: [otherRun],
        projectRunLimits: { maxConcurrency: 3 },
      }),
    );

    const next = replaceProjectSnapshot(
      withBothProjects,
      projectSnapshot({
        runs: [run({ revision: 2 })],
        projectRunLimits: { maxConcurrency: 6 },
      }),
    );

    expect(next.projectRunsById).toMatchObject({
      'run-1': run({ revision: 2 }),
      'run-other': otherRun,
    });
    expect(next.projectRunsById['run-completed']).toBeUndefined();
    expect(next.projectRunIdsByProjectId).toEqual({
      [project.id]: ['run-1'],
      [otherProject.id]: ['run-other'],
    });
    expect(next.projectRunMaxConcurrencyByProjectId).toEqual({
      [project.id]: 6,
      [otherProject.id]: 3,
    });
  });

  it('upserts complete project run aggregates while preserving cursor replay rules', () => {
    const starting = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot({ runs: [] }),
    );
    const changed: ProjectEvent = {
      protocolVersion: 1,
      id: 'project-run-event-4',
      projectId: project.id,
      sequence: 4,
      occurredAt: timestamp,
      type: 'project.run_changed',
      payload: { run: run() },
    };

    expect(
      projectEventSchema.safeParse({
        ...changed,
        payload: { run: run({ projectId: 'project-2' }) },
      }).success,
    ).toBe(false);

    const applied = applyProjectEvent(starting, changed);

    expect(applied.kind).toBe('applied');
    if (applied.kind !== 'applied') return;
    expect(applied.state.projectRunsById['run-1']).toEqual(run());
    expect(applied.state.projectRunIdsByProjectId[project.id]).toEqual([
      'run-1',
    ]);
    expect(applyProjectEvent(applied.state, changed)).toEqual({
      kind: 'duplicate',
    });
    expect(
      applyProjectEvent(applied.state, { ...changed, sequence: 6 }),
    ).toEqual({ kind: 'gap', expected: 5, received: 6 });

    const updated = applyProjectEvent(applied.state, {
      ...changed,
      id: 'project-run-event-5',
      sequence: 5,
      payload: { run: run({ revision: 2, concurrency: 1 }) },
    });
    expect(updated.kind).toBe('applied');
    if (updated.kind === 'applied') {
      expect(updated.state.projectRunsById['run-1']).toEqual(
        run({ revision: 2, concurrency: 1 }),
      );
      expect(updated.state.projectRunIdsByProjectId[project.id]).toEqual([
        'run-1',
      ]);
    }
  });

  it('replaces QA records by stable identity for only the snapshotted project', () => {
    const otherProject = {
      ...project,
      id: 'project-2',
      displayName: 'Project two',
    };
    const otherTask = task({
      id: 'task-2',
      projectId: otherProject.id,
      reviewAutomation: {
        status: 'enabled',
        generation: 2,
        rejectionCount: 1,
        pauseReason: null,
        updatedAt: timestamp,
      },
    });
    const otherAttempt = { ...attempt, id: 'attempt-2', taskId: otherTask.id };
    const otherQaCycle = {
      ...qaCycle,
      id: 'qa-cycle-2',
      taskId: otherTask.id,
      attemptId: otherAttempt.id,
      sessionId: 'qa-session-2',
    };
    const otherQaReport = {
      ...qaReport,
      id: 'qa-report-2',
      cycleId: otherQaCycle.id,
    };
    const otherAction = {
      ...automationAction,
      id: 'automation-action-2',
      idempotencyKey: 'task-2:attempt-2:qa-cycle-2:resume:2',
      projectId: otherProject.id,
      taskId: otherTask.id,
      attemptId: otherAttempt.id,
      sourceCycleId: otherQaCycle.id,
      generation: 2,
    };
    const withBothProjects = replaceProjectSnapshot(
      replaceProjectSnapshot(createProjection(snapshot()), projectSnapshot()),
      projectSnapshot({
        project: otherProject,
        tasks: [otherTask],
        attempts: [otherAttempt],
        transitions: [],
        repairs: [],
        developerCycles: [],
        developerCompletionReports: [],
        developerBlockerReports: [],
        developerReviewFeedback: [],
        qaCycles: [otherQaCycle],
        qaReports: [otherQaReport],
        reviewAutomationActions: [otherAction],
      }),
    );
    const terminalCycle = {
      ...qaCycle,
      endedAt: timestamp,
      terminalDisposition: 'rejected' as const,
      reportId: qaReport.id,
      terminalCommandId: 'qa-verdict-1',
      terminalEventId: 'qa-event-1',
    };
    const completedAction = {
      ...automationAction,
      status: 'completed' as const,
      completedAt: timestamp,
    };

    const next = replaceProjectSnapshot(
      withBothProjects,
      projectSnapshot({
        tasks: [
          task({
            reviewAutomation: {
              status: 'paused',
              generation: 1,
              rejectionCount: 3,
              pauseReason: 'Human decision required.',
              updatedAt: timestamp,
            },
          }),
        ],
        qaCycles: [terminalCycle],
        qaReports: [qaReport],
        reviewAutomationActions: [completedAction],
      }),
    );

    expect(next.qaCyclesByAttemptId[attempt.id]).toEqual([terminalCycle]);
    expect(next.qaReportsByCycleId[qaCycle.id]).toEqual(qaReport);
    expect(next.reviewAutomationByTaskId[task().id]).toEqual({
      status: 'paused',
      generation: 1,
      rejectionCount: 3,
      pauseReason: 'Human decision required.',
      updatedAt: timestamp,
      actions: [completedAction],
    });
    expect(next.qaCyclesByAttemptId[otherAttempt.id]).toEqual([otherQaCycle]);
    expect(next.qaReportsByCycleId[otherQaCycle.id]).toEqual(otherQaReport);
    expect(next.reviewAutomationByTaskId[otherTask.id]).toEqual({
      ...otherTask.reviewAutomation,
      actions: [otherAction],
    });
  });

  it('replaces developer records for only the snapshotted project', () => {
    const otherProject = {
      ...project,
      id: 'project-2',
      displayName: 'Project two',
    };
    const otherTask = task({ id: 'task-2', projectId: otherProject.id });
    const otherAttempt = { ...attempt, id: 'attempt-2', taskId: otherTask.id };
    const otherCycle = {
      ...developerCycle,
      id: 'cycle-2',
      attemptId: otherAttempt.id,
    };
    const otherCompletion = {
      ...completionReport,
      id: 'completion-2',
      cycleId: otherCycle.id,
    };
    const otherBlocker = {
      ...blockerReport,
      id: 'blocker-2',
      cycleId: otherCycle.id,
    };
    const otherFeedback = {
      ...reviewFeedback,
      id: 'feedback-2',
      cycleId: otherCycle.id,
      taskId: otherTask.id,
    };
    const laterOtherFeedback = {
      ...otherFeedback,
      id: 'feedback-3',
      feedback: 'One more revision.',
    };
    const withBothProjects = replaceProjectSnapshot(
      replaceProjectSnapshot(createProjection(snapshot()), projectSnapshot()),
      projectSnapshot({
        project: otherProject,
        tasks: [otherTask],
        attempts: [otherAttempt],
        transitions: [],
        repairs: [],
        developerCycles: [otherCycle],
        developerCompletionReports: [otherCompletion],
        developerBlockerReports: [otherBlocker],
        developerReviewFeedback: [otherFeedback, laterOtherFeedback],
      }),
    );
    const freshCycle = { ...developerCycle, id: 'cycle-fresh' };

    const next = replaceProjectSnapshot(
      withBothProjects,
      projectSnapshot({
        developerCycles: [freshCycle],
        developerCompletionReports: [],
        developerBlockerReports: [],
        developerReviewFeedback: [],
      }),
    );

    expect(next.developerCyclesByAttemptId[attempt.id]).toEqual([freshCycle]);
    expect(
      next.developerCompletionReportsByCycleId[developerCycle.id],
    ).toBeUndefined();
    expect(next.developerCyclesByAttemptId[otherAttempt.id]).toEqual([
      otherCycle,
    ]);
    expect(next.developerCompletionReportsByCycleId[otherCycle.id]).toEqual(
      otherCompletion,
    );
    expect(next.developerBlockerReportsByCycleId[otherCycle.id]).toEqual(
      otherBlocker,
    );
    expect(next.developerReviewFeedbackByCycleId[otherFeedback.id]).toEqual(
      otherFeedback,
    );
    expect(
      next.developerReviewFeedbackByCycleId[laterOtherFeedback.id],
    ).toEqual(laterOtherFeedback);
  });

  it('replaces only one project snapshot while retaining session projection data', () => {
    const current = {
      ...createProjection(snapshot(3)),
      promptDrafts: { 'session-1': 'keep this draft' },
    };

    const next = replaceProjectSnapshot(current, projectSnapshot());

    expect(next.projectsById[project.id]).toEqual(project);
    expect(next.tasksById[task().id]).toEqual(task());
    expect(next.attemptsById[attempt.id]).toEqual(attempt);
    expect(next.transitionsByTaskId[task().id]).toEqual([transition]);
    expect(next.repairsByProjectId[project.id]).toEqual([repair]);
    expect(next.projectCursors[project.id]).toBe(3);
    expect(next.lastSequenceBySession).toEqual({ 'session-1': 3 });
    expect(next.events).toEqual([event(3)]);
    expect(next.promptDrafts).toEqual({ 'session-1': 'keep this draft' });
  });

  it('projects snapshot dependencies and replaces them from complete-set events', () => {
    const initial = dependency();
    const replacement = dependency({ prerequisiteTaskId: 'replacement' });
    const starting = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot({ dependencies: [initial] }),
    );

    expect(starting.dependenciesByTaskId[task().id]).toEqual([initial]);

    const applied = applyProjectEvent(starting, {
      protocolVersion: 1,
      id: 'project-event-4',
      projectId: project.id,
      sequence: 4,
      occurredAt: timestamp,
      type: 'task.dependencies_changed',
      payload: { taskId: task().id, dependencies: [replacement] },
    });

    expect(applied.kind).toBe('applied');
    if (applied.kind === 'applied') {
      expect(applied.state.dependenciesByTaskId[task().id]).toEqual([
        replacement,
      ]);
    }
  });

  it('orders project events and projects task, transition, attempt, and repair updates', () => {
    const starting = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot(),
    );
    const rankChanged = applyProjectEvent(starting, projectEvent(4));

    expect(rankChanged.kind).toBe('applied');
    if (rankChanged.kind !== 'applied') return;

    const projected = rankChanged.state;
    expect(projected.projectCursors[project.id]).toBe(4);
    expect(projected.tasksById[task().id].rank).toBe('rank-4');
    expect(applyProjectEvent(rankChanged.state, projectEvent(4))).toEqual({
      kind: 'duplicate',
    });
    expect(applyProjectEvent(rankChanged.state, projectEvent(6))).toEqual({
      kind: 'gap',
      expected: 5,
      received: 6,
    });

    const transitioned = applyProjectEvent(rankChanged.state, {
      protocolVersion: 1,
      id: 'project-event-5',
      projectId: project.id,
      sequence: 5,
      occurredAt: timestamp,
      type: 'task.transitioned',
      payload: { task: task({ lifecycleState: 'ready' }), transition },
    });
    expect(transitioned.kind).toBe('applied');
    if (transitioned.kind !== 'applied') return;
    const transitionProjection = transitioned.state;
    expect(transitionProjection.transitionsByTaskId[task().id]).toEqual([
      transition,
    ]);

    const attemptChanged = applyProjectEvent(transitioned.state, {
      protocolVersion: 1,
      id: 'project-event-6',
      projectId: project.id,
      sequence: 6,
      occurredAt: timestamp,
      type: 'task.attempt_changed',
      payload: { attempt: { ...attempt, unlinkedAt: timestamp } },
    });
    expect(attemptChanged.kind).toBe('applied');
    if (attemptChanged.kind !== 'applied') return;
    const attemptProjection = attemptChanged.state;
    expect(attemptProjection.attemptsById[attempt.id].unlinkedAt).toBe(
      timestamp,
    );

    const repairDetected = applyProjectEvent(attemptChanged.state, {
      protocolVersion: 1,
      id: 'project-event-7',
      projectId: project.id,
      sequence: 7,
      occurredAt: timestamp,
      type: 'task.attempt_repair_detected',
      payload: { repair },
    });
    expect(repairDetected.kind).toBe('applied');
    if (repairDetected.kind === 'applied') {
      expect(repairDetected.state.repairsByProjectId[project.id]).toEqual([
        repair,
      ]);
    }
  });

  it('orders developer events, updates instructions, and keeps duplicate and gap handling unchanged', () => {
    const starting = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot({
        developerCycles: [],
        developerCompletionReports: [],
        developerBlockerReports: [],
        developerReviewFeedback: [],
      }),
    );
    const developerChanged: ProjectEvent = {
      protocolVersion: 1,
      id: 'project-event-4',
      projectId: project.id,
      sequence: 4,
      occurredAt: timestamp,
      type: 'task.developer_execution_changed',
      payload: {
        task: task({ lifecycleState: 'review' }),
        attempt,
        cycle: developerCycle,
        completionReport,
        blockerReport,
        reviewFeedback,
      },
    };

    const applied = applyProjectEvent(starting, developerChanged);
    expect(applied.kind).toBe('applied');
    if (applied.kind !== 'applied') return;
    expect(applied.state.developerCyclesByAttemptId[attempt.id]).toEqual([
      developerCycle,
    ]);
    expect(
      applied.state.developerCompletionReportsByCycleId[developerCycle.id],
    ).toEqual(completionReport);
    expect(
      applied.state.developerBlockerReportsByCycleId[developerCycle.id],
    ).toEqual(blockerReport);
    expect(
      applied.state.developerReviewFeedbackByCycleId[reviewFeedback.id],
    ).toEqual(reviewFeedback);
    expect(applied.state.tasksById[task().id].lifecycleState).toBe('review');
    expect(applyProjectEvent(applied.state, developerChanged)).toEqual({
      kind: 'duplicate',
    });
    expect(
      applyProjectEvent(applied.state, { ...developerChanged, sequence: 6 }),
    ).toEqual({ kind: 'gap', expected: 5, received: 6 });

    const instructionsChanged = applyProjectEvent(applied.state, {
      protocolVersion: 1,
      id: 'project-event-5',
      projectId: project.id,
      sequence: 5,
      occurredAt: timestamp,
      type: 'project.developer_instructions_changed',
      payload: {
        project: {
          ...project,
          revision: 2,
          developerInstructions: {
            content: 'Use focused tests.',
            revision: 2,
            updatedAt: timestamp,
            updatedBy: { type: 'human', id: 'operator' },
          },
        },
      },
    });
    expect(instructionsChanged.kind).toBe('applied');
    if (instructionsChanged.kind === 'applied') {
      expect(
        instructionsChanged.state.projectsById[project.id].developerInstructions
          .content,
      ).toBe('Use focused tests.');
    }
  });

  it('projects ordered QA, configuration, and automation events by stable identity', () => {
    const starting = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot({
        qaCycles: [],
        qaReports: [],
        reviewAutomationActions: [],
      }),
    );
    const configuredProject = {
      ...project,
      revision: 2,
      qaConfiguration: {
        instructions: {
          content: 'Run the reconnect suite.',
          revision: 2,
          updatedAt: timestamp,
          updatedBy: { type: 'human' as const, id: 'operator' },
        },
        reviewPolicy: 'autonomous_review' as const,
        revision: 2,
        updatedAt: timestamp,
        updatedBy: { type: 'human' as const, id: 'operator' },
      },
    };
    const configured = applyProjectEvent(starting, {
      protocolVersion: 1,
      id: 'project-event-4',
      projectId: project.id,
      sequence: 4,
      occurredAt: timestamp,
      type: 'project.qa_configuration_changed',
      payload: { project: configuredProject },
    });
    expect(configured.kind).toBe('applied');
    if (configured.kind !== 'applied') return;
    expect(
      configured.state.projectsById[project.id].qaConfiguration.reviewPolicy,
    ).toBe('autonomous_review');

    const active = applyProjectEvent(configured.state, {
      protocolVersion: 1,
      id: 'project-event-5',
      projectId: project.id,
      sequence: 5,
      occurredAt: timestamp,
      type: 'task.qa_execution_changed',
      payload: {
        task: task({ lifecycleState: 'review' }),
        attempt,
        cycle: qaCycle,
        report: null,
      },
    });
    expect(active.kind).toBe('applied');
    if (active.kind !== 'applied') return;

    const terminalCycle = {
      ...qaCycle,
      endedAt: timestamp,
      terminalDisposition: 'rejected' as const,
      reportId: qaReport.id,
      terminalCommandId: 'qa-verdict-1',
      terminalEventId: 'qa-event-1',
    };
    const terminal = applyProjectEvent(active.state, {
      protocolVersion: 1,
      id: 'project-event-6',
      projectId: project.id,
      sequence: 6,
      occurredAt: timestamp,
      type: 'task.qa_execution_changed',
      payload: {
        task: task({ lifecycleState: 'review' }),
        attempt,
        cycle: terminalCycle,
        report: qaReport,
      },
    });
    expect(terminal.kind).toBe('applied');
    if (terminal.kind !== 'applied') return;
    expect(terminal.state.qaCyclesByAttemptId[attempt.id]).toEqual([
      terminalCycle,
    ]);
    expect(terminal.state.qaReportsByCycleId[qaCycle.id]).toEqual(qaReport);

    const pausedTask = task({
      reviewAutomation: {
        status: 'paused',
        generation: 1,
        rejectionCount: 3,
        pauseReason: 'Three rejections require a human decision.',
        updatedAt: timestamp,
      },
    });
    const failedAction = {
      ...automationAction,
      status: 'failed' as const,
      errorCode: 'resume_failed',
      completedAt: timestamp,
    };
    const paused = applyProjectEvent(terminal.state, {
      protocolVersion: 1,
      id: 'project-event-7',
      projectId: project.id,
      sequence: 7,
      occurredAt: timestamp,
      type: 'task.review_automation_changed',
      payload: {
        task: pausedTask,
        automation: pausedTask.reviewAutomation,
        action: automationAction,
      },
    });
    expect(paused.kind).toBe('applied');
    if (paused.kind !== 'applied') return;
    const actionUpdated = applyProjectEvent(paused.state, {
      protocolVersion: 1,
      id: 'project-event-8',
      projectId: project.id,
      sequence: 8,
      occurredAt: timestamp,
      type: 'task.review_automation_changed',
      payload: {
        task: pausedTask,
        automation: pausedTask.reviewAutomation,
        action: failedAction,
      },
    });
    expect(actionUpdated.kind).toBe('applied');
    if (actionUpdated.kind !== 'applied') return;
    expect(actionUpdated.state.reviewAutomationByTaskId[task().id]).toEqual({
      ...pausedTask.reviewAutomation,
      actions: [failedAction],
    });
    expect(
      applyProjectEvent(actionUpdated.state, {
        protocolVersion: 1,
        id: 'project-event-8',
        projectId: project.id,
        sequence: 8,
        occurredAt: timestamp,
        type: 'task.review_automation_changed',
        payload: {
          task: pausedTask,
          automation: pausedTask.reviewAutomation,
          action: failedAction,
        },
      }),
    ).toEqual({ kind: 'duplicate' });
    expect(
      applyProjectEvent(actionUpdated.state, {
        protocolVersion: 1,
        id: 'project-event-10',
        projectId: project.id,
        sequence: 10,
        occurredAt: timestamp,
        type: 'task.qa_execution_changed',
        payload: {
          task: pausedTask,
          attempt,
          cycle: terminalCycle,
          report: qaReport,
        },
      }),
    ).toEqual({ kind: 'gap', expected: 9, received: 10 });
  });

  it('clears every repaired QA warning and keeps it cleared after reconnect', () => {
    const qaRepairs: AttemptRepair[] = [
      'qa_cycle_without_trustworthy_outcome',
      'qa_session_workspace_mismatch',
      'review_automation_action_incomplete',
    ].map((reason) => ({
      taskId: task().id,
      attemptId: attempt.id,
      sessionId: qaCycle.sessionId,
      reason: reason as AttemptRepair['reason'],
    }));
    const starting = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot({ repairs: qaRepairs }),
    );
    const interruptedCycle: QaExecutionCycle = {
      ...qaCycle,
      endedAt: timestamp,
      terminalDisposition: 'interrupted',
      terminalCommandId: 'repair-qa-cycle-1',
      terminalEventId: 'project-event-4',
    };

    const repaired = applyProjectEvent(starting, {
      protocolVersion: 1,
      id: 'project-event-4',
      projectId: project.id,
      sequence: 4,
      occurredAt: timestamp,
      type: 'task.qa_execution_changed',
      payload: {
        task: task({ lifecycleState: 'review' }),
        attempt,
        cycle: interruptedCycle,
        report: null,
      },
    });

    expect(repaired.kind).toBe('applied');
    if (repaired.kind !== 'applied') return;
    expect(repaired.state.repairsByProjectId[project.id]).toEqual([]);

    const reconnected = replaceProjectSnapshot(
      repaired.state,
      projectSnapshot({
        repairs: [],
        qaCycles: [interruptedCycle],
        qaReports: [],
        cursor: 4,
      }),
    );
    expect(reconnected.repairsByProjectId[project.id]).toEqual([]);
  });

  it('clears an interrupted action repair across Developer and QA sessions', () => {
    const actionRepair: AttemptRepair = {
      taskId: task().id,
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      reason: 'review_automation_action_incomplete',
    };
    const unrelatedTaskRepair: AttemptRepair = {
      taskId: 'task-2',
      attemptId: 'attempt-2',
      sessionId: 'session-2',
      reason: 'review_automation_action_incomplete',
    };
    const unrelatedAttemptRepair: AttemptRepair = {
      taskId: task().id,
      attemptId: 'attempt-3',
      sessionId: 'session-3',
      reason: 'review_automation_action_incomplete',
    };
    const starting = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot({
        repairs: [actionRepair, unrelatedTaskRepair, unrelatedAttemptRepair],
      }),
    );
    const interruptedCycle: QaExecutionCycle = {
      ...qaCycle,
      endedAt: timestamp,
      terminalDisposition: 'interrupted',
      terminalCommandId: 'repair-qa-cycle-mismatched-session',
      terminalEventId: 'project-event-4',
    };

    const repaired = applyProjectEvent(starting, {
      protocolVersion: 1,
      id: 'project-event-4',
      projectId: project.id,
      sequence: 4,
      occurredAt: timestamp,
      type: 'task.qa_execution_changed',
      payload: {
        task: task({ lifecycleState: 'review' }),
        attempt,
        cycle: interruptedCycle,
        report: null,
      },
    });

    expect(repaired.kind).toBe('applied');
    if (repaired.kind !== 'applied') return;
    expect(repaired.state.repairsByProjectId[project.id]).toEqual([
      unrelatedTaskRepair,
      unrelatedAttemptRepair,
    ]);
  });

  it('clears an action repair when its failed automation event arrives', () => {
    const actionRepair: AttemptRepair = {
      taskId: task().id,
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      reason: 'review_automation_action_incomplete',
    };
    const unrelatedRepair: AttemptRepair = {
      taskId: task().id,
      attemptId: 'attempt-3',
      sessionId: 'session-3',
      reason: 'review_automation_action_incomplete',
    };
    const starting = replaceProjectSnapshot(
      createProjection(snapshot()),
      projectSnapshot({ repairs: [actionRepair, unrelatedRepair] }),
    );
    const failedAction: ReviewAutomationAction = {
      ...automationAction,
      status: 'failed',
      errorCode: 'qa_cycle_interrupted',
      completedAt: timestamp,
    };

    const repaired = applyProjectEvent(starting, {
      protocolVersion: 1,
      id: 'project-event-4',
      projectId: project.id,
      sequence: 4,
      occurredAt: timestamp,
      type: 'task.review_automation_changed',
      payload: {
        task: task({ lifecycleState: 'review' }),
        automation: task().reviewAutomation,
        action: failedAction,
      },
    });

    expect(repaired.kind).toBe('applied');
    if (repaired.kind !== 'applied') return;
    expect(repaired.state.repairsByProjectId[project.id]).toEqual([
      unrelatedRepair,
    ]);
  });
});

describe('createResyncCoordinator', () => {
  it('refreshes a gap from one snapshot fetch and retains the prompt draft', async () => {
    const store = createMeshStore(snapshot());
    store.state.promptDrafts.set({ 'session-1': 'keep this draft' });
    let requests = 0;
    const coordinator = createResyncCoordinator(
      {
        snapshot: async () => {
          requests += 1;
          return snapshot(7);
        },
      },
      store,
    );

    await Promise.all([
      coordinator.applyEvent(event(5)),
      coordinator.applyEvent(event(6)),
    ]);

    expect(requests).toBe(1);
    expect(store.state.lastSequenceBySession['session-1'].get()).toBe(7);
    expect(store.state.promptDrafts['session-1'].get()).toBe('keep this draft');
  });

  it('refreshes only the project that has an event gap', async () => {
    const store = createMeshStore(snapshot());
    const coordinator = createResyncCoordinator(
      {
        snapshot: async () => snapshot(9),
        projectSnapshot: async (projectId: string) =>
          projectSnapshot({
            project: { ...project, id: projectId },
            cursor: 7,
          }),
      },
      store,
    );

    await coordinator.applyProjectEvent(projectEvent(2));

    expect(store.state.lastSequenceBySession['session-1'].get()).toBe(3);
    expect(
      (
        store.state.get({ noproxy: true }) as unknown as {
          projectCursors: Record<string, number>;
        }
      ).projectCursors[project.id],
    ).toBe(7);
  });
});
