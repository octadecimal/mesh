import type { MeshProjection, PendingApproval } from './reducer';

export const selectSessionEvents = (state: MeshProjection, sessionId: string) =>
  state.events.filter((event) => event.sessionId === sessionId);

export const selectPendingApprovals = (state: MeshProjection): PendingApproval[] =>
  state.pendingApprovals.filter(
    (event): event is PendingApproval => event.type === 'permission.requested',
  );

export const selectUnreadSessionIds = (state: MeshProjection) =>
  Object.keys(state.unreadSessionIds).filter((id) => state.unreadSessionIds[id]);
