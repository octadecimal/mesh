import type {
  AttemptRepair,
  DeveloperBlockerReport,
  DeveloperCompletionReport,
  DeveloperExecutionCycle,
  DeveloperReviewFeedback,
  ProjectEvent,
  ProjectSnapshot,
  SessionEvent,
  SessionSnapshot,
  Task,
  TaskAttempt,
  TaskTransition,
} from '@mesh-session-platform/contracts';

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
});

describe('project projection', () => {
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
