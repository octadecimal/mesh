import type { SavedLayout, Session } from '@mesh-session-platform/contracts';

import type { MeshProjection, PendingApproval } from './reducer';

export const selectProjects = (state: MeshProjection) => state.projects;
export const selectWorkspaces = (state: MeshProjection) => state.workspaces;
export const selectSessions = (state: MeshProjection) => state.sessions;
export const selectSelectedSessionId = (state: MeshProjection) =>
  state.selectedSessionId;

const layoutSpecificity = ({
  projectId,
  workspaceId,
  sessionId,
}: SavedLayout) =>
  (projectId ? 1 : 0) + (workspaceId ? 2 : 0) + (sessionId ? 4 : 0);

export const savedLayoutMatchesSession = (
  layout: SavedLayout,
  session: Session,
) =>
  (!layout.projectId || layout.projectId === session.projectId) &&
  (!layout.workspaceId || layout.workspaceId === session.workspaceId) &&
  (!layout.sessionId || layout.sessionId === session.id);

export const selectSavedLayout = (
  state: MeshProjection,
): SavedLayout | undefined => {
  const selected = state.sessions.find(
    ({ id }) => id === state.selectedSessionId,
  );
  if (!selected) return state.layouts[0];

  return state.layouts
    .filter((layout) => savedLayoutMatchesSession(layout, selected))
    .reduce<
      SavedLayout | undefined
    >((best, layout) => (!best || layoutSpecificity(layout) > layoutSpecificity(best) ? layout : best), undefined);
};

export const selectSessionFilter = (
  state: MeshProjection,
  savedLayout?: SavedLayout,
) => {
  const savedSidebar = savedLayout?.sidebar;
  const savedFilter =
    typeof savedSidebar === 'object' &&
    savedSidebar !== null &&
    typeof (savedSidebar as { filter?: unknown }).filter === 'string'
      ? (savedSidebar as { filter: string }).filter
      : '';
  return state.filters.sessions ?? savedFilter;
};

export const selectSessionEvents = (state: MeshProjection, sessionId: string) =>
  state.events.filter((event) => event.sessionId === sessionId);

export const selectPendingApprovals = (
  state: MeshProjection,
): PendingApproval[] =>
  state.pendingApprovals.filter(
    (event): event is PendingApproval => event.type === 'permission.requested',
  );

export const selectUnreadSessionIds = (state: MeshProjection) =>
  Object.keys(state.unreadSessionIds).filter(
    (id) => state.unreadSessionIds[id],
  );
