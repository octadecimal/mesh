import type {
  AttemptRepair,
  PermissionRequest,
  Project,
  ProjectEvent,
  ProjectSnapshot,
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

export type MeshProjection = {
  projects: SessionSnapshot['projects'];
  projectsById: Record<string, Project>;
  tasksById: Record<string, Task>;
  attemptsById: Record<string, TaskAttempt>;
  transitionsByTaskId: Record<string, TaskTransition[]>;
  repairsByProjectId: Record<string, AttemptRepair[]>;
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

export const replaceProjectSnapshot = (
  state: MeshProjection,
  snapshot: ProjectSnapshot,
): MeshProjection => {
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

  if (event.type === 'project.changed') {
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
