import type {
  PermissionRequest,
  Session,
  SessionEvent,
  SessionSnapshot,
} from '@mesh-session-platform/contracts';

export type ConnectionHealth = 'connected' | 'degraded' | 'disconnected';

export type Notification = {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
};

export type MeshProjection = {
  projects: SessionSnapshot['projects'];
  workspaces: SessionSnapshot['workspaces'];
  sessions: Session[];
  events: SessionEvent[];
  pendingApprovals: SessionEvent[];
  lastSequenceBySession: Record<string, number>;
  layouts: SessionSnapshot['layouts'];
  selectedSessionId?: string;
  filters: Record<string, string>;
  promptDrafts: Record<string, string>;
  unreadSessionIds: Record<string, boolean>;
  connectionHealth: ConnectionHealth;
  notifications: Notification[];
};

export type ApplyEventResult =
  | { kind: 'duplicate' }
  | { kind: 'gap'; expected: number; received: number }
  | { kind: 'applied'; state: MeshProjection };

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
  return {
    kind: 'applied',
    state: {
      ...state,
      events,
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
  selectedSessionId: state.selectedSessionId,
  filters: state.filters,
  promptDrafts: state.promptDrafts,
  unreadSessionIds: state.unreadSessionIds,
  connectionHealth: state.connectionHealth,
  notifications: state.notifications,
});

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
