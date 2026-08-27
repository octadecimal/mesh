import type {
  AttemptRepair,
  DeveloperBlockerReport,
  DeveloperCompletionReport,
  DeveloperExecutionCycle,
  DeveloperReviewFeedback,
  PermissionRequest,
  Project,
  ProjectEvent,
  ProjectSnapshot,
  QaExecutionCycle,
  QaReport,
  ReviewAutomationAction,
  ReviewAutomationState,
  Session,
  SessionEvent,
  SessionSnapshot,
  Task,
  TaskAttempt,
  TaskTransition,
} from '@mesh-session-platform/contracts';

export type ConnectionHealth = 'connected' | 'degraded' | 'disconnected';

export type Notification = {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
};

export type ReviewAutomationProjection = ReviewAutomationState & {
  actions: ReviewAutomationAction[];
};

export type MeshProjection = {
  projects: SessionSnapshot['projects'];
  projectsById: Record<string, Project>;
  tasksById: Record<string, Task>;
  attemptsById: Record<string, TaskAttempt>;
  transitionsByTaskId: Record<string, TaskTransition[]>;
  repairsByProjectId: Record<string, AttemptRepair[]>;
  developerCyclesByAttemptId: Record<string, DeveloperExecutionCycle[]>;
  developerCompletionReportsByCycleId: Record<
    string,
    DeveloperCompletionReport
  >;
  developerBlockerReportsByCycleId: Record<string, DeveloperBlockerReport>;
  developerReviewFeedbackByCycleId: Record<string, DeveloperReviewFeedback>;
  qaCyclesByAttemptId: Record<string, QaExecutionCycle[]>;
  qaReportsByCycleId: Record<string, QaReport>;
  reviewAutomationByTaskId: Record<string, ReviewAutomationProjection>;
  projectCursors: Record<string, number>;
  workspaces: SessionSnapshot['workspaces'];
  sessions: Session[];
  events: SessionEvent[];
  pendingApprovals: SessionEvent[];
  lastSequenceBySession: Record<string, number>;
  layouts: SessionSnapshot['layouts'];
  selectedSessionId?: string;
  filters: Record<string, string>;
  promptDrafts: Record<string, string>;
  streamingAssistantTextBySession: Record<string, string>;
  unreadSessionIds: Record<string, boolean>;
  connectionHealth: ConnectionHealth;
  notifications: Notification[];
};

export type ApplyEventResult =
  | { kind: 'duplicate' }
  | { kind: 'gap'; expected: number; received: number }
  | { kind: 'applied'; state: MeshProjection };

export type ApplyProjectEventResult =
  | { kind: 'duplicate' }
  | { kind: 'gap'; expected: number; received: number }
  | { kind: 'applied'; state: MeshProjection };

const byId = <Value extends { id: string }>(items: readonly Value[]) =>
  Object.fromEntries(items.map((item) => [item.id, item])) as Record<
    string,
    Value
  >;

const pendingApprovals = (events: readonly SessionEvent[]) => {
  const pending = new Map<string, SessionEvent>();
  for (const event of events) {
    if (event.type === 'permission.requested')
      pending.set(event.payload.permissionId, event);
    if (event.type === 'permission.resolved')
      pending.delete(event.payload.permissionId);
  }
  return [...pending.values()];
};

const sessionsAfter = (sessions: readonly Session[], event: SessionEvent) => {
  if (event.type !== 'session.status') return [...sessions];
  return sessions.map((session) =>
    session.id === event.sessionId
      ? {
          ...session,
          lifecycleState: event.payload.to,
          updatedAt: event.occurredAt,
        }
      : session,
  );
};

export const createProjection = (
  snapshot: SessionSnapshot,
): MeshProjection => ({
  projects: snapshot.projects,
  projectsById: byId(snapshot.projects),
  tasksById: {},
  attemptsById: {},
  transitionsByTaskId: {},
  repairsByProjectId: {},
  developerCyclesByAttemptId: {},
  developerCompletionReportsByCycleId: {},
  developerBlockerReportsByCycleId: {},
  developerReviewFeedbackByCycleId: {},
  qaCyclesByAttemptId: {},
  qaReportsByCycleId: {},
  reviewAutomationByTaskId: {},
  projectCursors: Object.fromEntries(
    snapshot.projects.map((project) => [project.id, 0]),
  ),
  workspaces: snapshot.workspaces,
  sessions: snapshot.sessions,
  events: snapshot.events,
  pendingApprovals:
    snapshot.pendingApprovals.length > 0
      ? snapshot.pendingApprovals
      : pendingApprovals(snapshot.events),
  lastSequenceBySession: { ...snapshot.lastSequenceBySession },
  layouts: snapshot.layouts,
  filters: {},
  promptDrafts: {},
  streamingAssistantTextBySession: {},
  unreadSessionIds: {},
  connectionHealth: 'disconnected',
  notifications: [],
});

export const applyEvent = (
  state: MeshProjection,
  event: SessionEvent,
): ApplyEventResult => {
  const cursor = state.lastSequenceBySession[event.sessionId] ?? 0;
  if (event.sequence <= cursor) return { kind: 'duplicate' };
  if (event.sequence !== cursor + 1) {
    return { kind: 'gap', expected: cursor + 1, received: event.sequence };
  }

  const events = [...state.events, event];
  const streamingAssistantTextBySession = {
    ...state.streamingAssistantTextBySession,
  };
  if (
    event.type === 'message.assistant' ||
    event.type === 'session.error' ||
    event.type === 'session.status'
  ) {
    delete streamingAssistantTextBySession[event.sessionId];
  }
  return {
    kind: 'applied',
    state: {
      ...state,
      events,
      streamingAssistantTextBySession,
      sessions: sessionsAfter(state.sessions, event),
      pendingApprovals: pendingApprovals(events),
      lastSequenceBySession: {
        ...state.lastSequenceBySession,
        [event.sessionId]: event.sequence,
      },
      unreadSessionIds:
        state.selectedSessionId === event.sessionId
          ? state.unreadSessionIds
          : { ...state.unreadSessionIds, [event.sessionId]: true },
    },
  };
};

export const replaceSnapshot = (
  state: MeshProjection,
  snapshot: SessionSnapshot,
): MeshProjection => ({
  ...createProjection(snapshot),
  tasksById: state.tasksById,
  attemptsById: state.attemptsById,
  transitionsByTaskId: state.transitionsByTaskId,
  repairsByProjectId: state.repairsByProjectId,
  developerCyclesByAttemptId: state.developerCyclesByAttemptId,
  developerCompletionReportsByCycleId:
    state.developerCompletionReportsByCycleId,
  developerBlockerReportsByCycleId: state.developerBlockerReportsByCycleId,
  developerReviewFeedbackByCycleId: state.developerReviewFeedbackByCycleId,
  qaCyclesByAttemptId: state.qaCyclesByAttemptId,
  qaReportsByCycleId: state.qaReportsByCycleId,
  reviewAutomationByTaskId: state.reviewAutomationByTaskId,
  projectCursors: Object.fromEntries(
    snapshot.projects.map((project) => [
      project.id,
      state.projectCursors[project.id] ?? 0,
    ]),
  ),
  selectedSessionId: state.selectedSessionId,
  filters: state.filters,
  promptDrafts: state.promptDrafts,
  unreadSessionIds: state.unreadSessionIds,
  connectionHealth: state.connectionHealth,
  notifications: state.notifications,
});

const projectsAfter = (projects: readonly Project[], project: Project) => {
  const index = projects.findIndex(({ id }) => id === project.id);
  if (index === -1) return [...projects, project];
  return projects.map((existing) =>
    existing.id === project.id ? project : existing,
  );
};

const repairKey = (repair: AttemptRepair) =>
  `${repair.taskId}\u0000${repair.attemptId}\u0000${repair.sessionId}\u0000${repair.reason}`;

const transitionsByTask = (transitions: readonly TaskTransition[]) =>
  transitions.reduce<Record<string, TaskTransition[]>>((result, transition) => {
    result[transition.taskId] = [
      ...(result[transition.taskId] ?? []),
      transition,
    ];
    return result;
  }, {});

const cyclesByAttempt = (cycles: readonly DeveloperExecutionCycle[]) =>
  cycles.reduce<Record<string, DeveloperExecutionCycle[]>>((result, cycle) => {
    result[cycle.attemptId] = [...(result[cycle.attemptId] ?? []), cycle];
    return result;
  }, {});

const qaCyclesByAttempt = (cycles: readonly QaExecutionCycle[]) =>
  cycles.reduce<Record<string, QaExecutionCycle[]>>((result, cycle) => {
    result[cycle.attemptId] = [...(result[cycle.attemptId] ?? []), cycle];
    return result;
  }, {});

const byCycleId = <Value extends { cycleId: string }>(
  items: readonly Value[],
) =>
  Object.fromEntries(items.map((item) => [item.cycleId, item])) as Record<
    string,
    Value
  >;

const upsertById = <Value extends { id: string }>(
  items: readonly Value[],
  value: Value,
) =>
  items.some(({ id }) => id === value.id)
    ? items.map((item) => (item.id === value.id ? value : item))
    : [...items, value];

const automationByTask = (
  tasks: readonly Task[],
  actions: readonly ReviewAutomationAction[],
) => {
  const actionsByTaskId = actions.reduce<
    Record<string, ReviewAutomationAction[]>
  >((result, action) => {
    result[action.taskId] = [...(result[action.taskId] ?? []), action];
    return result;
  }, {});
  return Object.fromEntries(
    tasks.map((task) => [
      task.id,
      { ...task.reviewAutomation, actions: actionsByTaskId[task.id] ?? [] },
    ]),
  ) as Record<string, ReviewAutomationProjection>;
};

export const replaceProjectSnapshot = (
  state: MeshProjection,
  snapshot: ProjectSnapshot,
): MeshProjection => {
  const developerCycles = snapshot.developerCycles ?? [];
  const developerCompletionReports = snapshot.developerCompletionReports ?? [];
  const developerBlockerReports = snapshot.developerBlockerReports ?? [];
  const developerReviewFeedback = snapshot.developerReviewFeedback ?? [];
  const qaCycles = snapshot.qaCycles ?? [];
  const qaReports = snapshot.qaReports ?? [];
  const reviewAutomationActions = snapshot.reviewAutomationActions ?? [];
  const replacedTaskIds = new Set<string>([
    ...Object.values(state.tasksById)
      .filter((task) => task.projectId === snapshot.project.id)
      .map((task) => task.id),
    ...snapshot.tasks.map((task) => task.id),
  ]);
  const tasksById = Object.fromEntries(
    Object.entries(state.tasksById).filter(
      ([taskId]) => !replacedTaskIds.has(taskId),
    ),
  ) as Record<string, Task>;
  const attemptsById = Object.fromEntries(
    Object.entries(state.attemptsById).filter(
      ([, attempt]) => !replacedTaskIds.has(attempt.taskId),
    ),
  ) as Record<string, TaskAttempt>;
  const replacedAttemptIds = new Set<string>([
    ...Object.values(state.attemptsById)
      .filter((attempt) => replacedTaskIds.has(attempt.taskId))
      .map((attempt) => attempt.id),
    ...snapshot.attempts.map((attempt) => attempt.id),
  ]);
  const replacedCycleIds = new Set<string>([
    ...Object.entries(state.developerCyclesByAttemptId)
      .filter(([attemptId]) => replacedAttemptIds.has(attemptId))
      .flatMap(([, cycles]) => cycles.map((cycle) => cycle.id)),
    ...developerCycles.map((cycle) => cycle.id),
  ]);
  const replacedQaCycleIds = new Set<string>([
    ...Object.entries(state.qaCyclesByAttemptId)
      .filter(([attemptId]) => replacedAttemptIds.has(attemptId))
      .flatMap(([, cycles]) => cycles.map((cycle) => cycle.id)),
    ...qaCycles.map((cycle) => cycle.id),
  ]);
  const developerCyclesByAttemptId = Object.fromEntries(
    Object.entries(state.developerCyclesByAttemptId).filter(
      ([attemptId]) => !replacedAttemptIds.has(attemptId),
    ),
  ) as Record<string, DeveloperExecutionCycle[]>;
  const developerCompletionReportsByCycleId = Object.fromEntries(
    Object.entries(state.developerCompletionReportsByCycleId).filter(
      ([cycleId]) => !replacedCycleIds.has(cycleId),
    ),
  ) as Record<string, DeveloperCompletionReport>;
  const developerBlockerReportsByCycleId = Object.fromEntries(
    Object.entries(state.developerBlockerReportsByCycleId).filter(
      ([cycleId]) => !replacedCycleIds.has(cycleId),
    ),
  ) as Record<string, DeveloperBlockerReport>;
  const developerReviewFeedbackByCycleId = Object.fromEntries(
    Object.entries(state.developerReviewFeedbackByCycleId).filter(
      ([, feedback]) => !replacedCycleIds.has(feedback.cycleId),
    ),
  ) as Record<string, DeveloperReviewFeedback>;
  const qaCyclesByAttemptId = Object.fromEntries(
    Object.entries(state.qaCyclesByAttemptId).filter(
      ([attemptId]) => !replacedAttemptIds.has(attemptId),
    ),
  ) as Record<string, QaExecutionCycle[]>;
  const qaReportsByCycleId = Object.fromEntries(
    Object.entries(state.qaReportsByCycleId).filter(
      ([cycleId]) => !replacedQaCycleIds.has(cycleId),
    ),
  ) as Record<string, QaReport>;
  const reviewAutomationByTaskId = Object.fromEntries(
    Object.entries(state.reviewAutomationByTaskId).filter(
      ([taskId]) => !replacedTaskIds.has(taskId),
    ),
  ) as Record<string, ReviewAutomationProjection>;
  const transitionsByTaskId = Object.fromEntries(
    Object.entries(state.transitionsByTaskId).filter(
      ([taskId]) => !replacedTaskIds.has(taskId),
    ),
  ) as Record<string, TaskTransition[]>;

  return {
    ...state,
    projects: projectsAfter(state.projects, snapshot.project),
    projectsById: {
      ...state.projectsById,
      [snapshot.project.id]: snapshot.project,
    },
    tasksById: { ...tasksById, ...byId(snapshot.tasks) },
    attemptsById: { ...attemptsById, ...byId(snapshot.attempts) },
    transitionsByTaskId: {
      ...transitionsByTaskId,
      ...transitionsByTask(snapshot.transitions),
    },
    repairsByProjectId: {
      ...state.repairsByProjectId,
      [snapshot.project.id]: snapshot.repairs,
    },
    developerCyclesByAttemptId: {
      ...developerCyclesByAttemptId,
      ...cyclesByAttempt(developerCycles),
    },
    developerCompletionReportsByCycleId: {
      ...developerCompletionReportsByCycleId,
      ...byCycleId(developerCompletionReports),
    },
    developerBlockerReportsByCycleId: {
      ...developerBlockerReportsByCycleId,
      ...byCycleId(developerBlockerReports),
    },
    developerReviewFeedbackByCycleId: {
      ...developerReviewFeedbackByCycleId,
      ...byId(developerReviewFeedback),
    },
    qaCyclesByAttemptId: {
      ...qaCyclesByAttemptId,
      ...qaCyclesByAttempt(qaCycles),
    },
    qaReportsByCycleId: {
      ...qaReportsByCycleId,
      ...byCycleId(qaReports),
    },
    reviewAutomationByTaskId: {
      ...reviewAutomationByTaskId,
      ...automationByTask(snapshot.tasks, reviewAutomationActions),
    },
    projectCursors: {
      ...state.projectCursors,
      [snapshot.project.id]: snapshot.cursor,
    },
  };
};

export const applyProjectEvent = (
  state: MeshProjection,
  event: ProjectEvent,
): ApplyProjectEventResult => {
  const cursor = state.projectCursors[event.projectId] ?? 0;
  if (event.sequence <= cursor) return { kind: 'duplicate' };
  if (event.sequence !== cursor + 1) {
    return { kind: 'gap', expected: cursor + 1, received: event.sequence };
  }

  let next: MeshProjection = {
    ...state,
    projectCursors: {
      ...state.projectCursors,
      [event.projectId]: event.sequence,
    },
  };

  if (
    event.type === 'project.changed' ||
    event.type === 'project.developer_instructions_changed' ||
    event.type === 'project.qa_configuration_changed'
  ) {
    next = {
      ...next,
      projects: projectsAfter(next.projects, event.payload.project),
      projectsById: {
        ...next.projectsById,
        [event.payload.project.id]: event.payload.project,
      },
    };
  }

  if (
    event.type === 'task.changed' ||
    event.type === 'task.block_changed' ||
    event.type === 'task.rank_changed' ||
    event.type === 'task.transitioned'
  ) {
    next = {
      ...next,
      tasksById: {
        ...next.tasksById,
        [event.payload.task.id]: event.payload.task,
      },
    };
  }

  if (event.type === 'task.transitioned') {
    const transitions =
      next.transitionsByTaskId[event.payload.transition.taskId] ?? [];
    next = {
      ...next,
      transitionsByTaskId: {
        ...next.transitionsByTaskId,
        [event.payload.transition.taskId]: transitions.some(
          ({ id }) => id === event.payload.transition.id,
        )
          ? transitions
          : [...transitions, event.payload.transition],
      },
    };
  }

  if (event.type === 'task.attempt_changed') {
    next = {
      ...next,
      attemptsById: {
        ...next.attemptsById,
        [event.payload.attempt.id]: event.payload.attempt,
      },
    };
  }

  if (event.type === 'task.attempt_repair_detected') {
    const repairs = next.repairsByProjectId[event.projectId] ?? [];
    next = {
      ...next,
      repairsByProjectId: {
        ...next.repairsByProjectId,
        [event.projectId]: repairs.some(
          (repair) => repairKey(repair) === repairKey(event.payload.repair),
        )
          ? repairs
          : [...repairs, event.payload.repair],
      },
    };
  }

  if (event.type === 'task.developer_execution_changed') {
    const cycles =
      next.developerCyclesByAttemptId[event.payload.cycle.attemptId] ?? [];
    const cyclesForAttempt = cycles.some(
      ({ id }) => id === event.payload.cycle.id,
    )
      ? cycles.map((cycle) =>
          cycle.id === event.payload.cycle.id ? event.payload.cycle : cycle,
        )
      : [...cycles, event.payload.cycle];
    next = {
      ...next,
      tasksById: {
        ...next.tasksById,
        [event.payload.task.id]: event.payload.task,
      },
      attemptsById: {
        ...next.attemptsById,
        [event.payload.attempt.id]: event.payload.attempt,
      },
      developerCyclesByAttemptId: {
        ...next.developerCyclesByAttemptId,
        [event.payload.cycle.attemptId]: cyclesForAttempt,
      },
      developerCompletionReportsByCycleId: event.payload.completionReport
        ? {
            ...next.developerCompletionReportsByCycleId,
            [event.payload.completionReport.cycleId]:
              event.payload.completionReport,
          }
        : next.developerCompletionReportsByCycleId,
      developerBlockerReportsByCycleId: event.payload.blockerReport
        ? {
            ...next.developerBlockerReportsByCycleId,
            [event.payload.blockerReport.cycleId]: event.payload.blockerReport,
          }
        : next.developerBlockerReportsByCycleId,
      developerReviewFeedbackByCycleId: event.payload.reviewFeedback
        ? {
            ...next.developerReviewFeedbackByCycleId,
            [event.payload.reviewFeedback.id]: event.payload.reviewFeedback,
          }
        : next.developerReviewFeedbackByCycleId,
    };
  }

  if (event.type === 'task.qa_execution_changed') {
    const cycles =
      next.qaCyclesByAttemptId[event.payload.cycle.attemptId] ?? [];
    next = {
      ...next,
      tasksById: {
        ...next.tasksById,
        [event.payload.task.id]: event.payload.task,
      },
      attemptsById: {
        ...next.attemptsById,
        [event.payload.attempt.id]: event.payload.attempt,
      },
      qaCyclesByAttemptId: {
        ...next.qaCyclesByAttemptId,
        [event.payload.cycle.attemptId]: upsertById(
          cycles,
          event.payload.cycle,
        ),
      },
      qaReportsByCycleId: event.payload.report
        ? {
            ...next.qaReportsByCycleId,
            [event.payload.report.cycleId]: event.payload.report,
          }
        : next.qaReportsByCycleId,
      repairsByProjectId:
        event.payload.cycle.terminalDisposition === 'interrupted'
          ? {
              ...next.repairsByProjectId,
              [event.projectId]: (
                next.repairsByProjectId[event.projectId] ?? []
              ).filter(
                (repair) =>
                  !(
                    repair.taskId === event.payload.task.id &&
                    repair.attemptId === event.payload.attempt.id &&
                    (repair.reason === 'review_automation_action_incomplete' ||
                      (repair.sessionId === event.payload.cycle.sessionId &&
                        [
                          'qa_cycle_without_trustworthy_outcome',
                          'qa_session_workspace_mismatch',
                        ].includes(repair.reason)))
                  ),
              ),
            }
          : next.repairsByProjectId,
    };
  }

  if (event.type === 'task.review_automation_changed') {
    const current = next.reviewAutomationByTaskId[event.payload.task.id];
    const action = event.payload.action;
    const actions = action
      ? upsertById(current?.actions ?? [], action)
      : (current?.actions ?? []);
    next = {
      ...next,
      tasksById: {
        ...next.tasksById,
        [event.payload.task.id]: event.payload.task,
      },
      reviewAutomationByTaskId: {
        ...next.reviewAutomationByTaskId,
        [event.payload.task.id]: {
          ...event.payload.automation,
          actions,
        },
      },
      repairsByProjectId:
        action?.status === 'failed'
          ? {
              ...next.repairsByProjectId,
              [event.projectId]: (
                next.repairsByProjectId[event.projectId] ?? []
              ).filter(
                (repair) =>
                  !(
                    repair.reason === 'review_automation_action_incomplete' &&
                    repair.taskId === action.taskId &&
                    repair.attemptId === action.attemptId
                  ),
              ),
            }
          : next.repairsByProjectId,
    };
  }

  return { kind: 'applied', state: next };
};

export const diagnosticNotification = (message: string): Notification => ({
  id: globalThis.crypto?.randomUUID?.() ?? `diagnostic-${Date.now()}`,
  level: 'error',
  message,
});

export type PendingApproval = Extract<
  SessionEvent,
  { type: 'permission.requested' }
> & {
  payload: PermissionRequest;
};
