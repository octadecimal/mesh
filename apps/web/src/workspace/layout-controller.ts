import type {
  DockviewApi,
  DockviewGroupPanel,
  IDockviewGroupPanel,
  IDockviewPanel,
  SerializedDockview,
} from 'dockview-react';
import type { SavedLayout } from '@mesh-session-platform/contracts';

export const SESSION_COMPONENT = 'session';
export const MAX_VISIBLE_GROUPS = 2;

export type SessionPanelParams = { sessionId: string };
export type WorkspaceSession = { id: string; title: string };
export type DockviewLayoutSnapshot = Pick<
  SavedLayout,
  'dockview' | 'sidebar' | 'visiblePanels'
>;

const sessionIdFor = (panel: IDockviewPanel) => {
  const params = panel.params as SessionPanelParams | undefined;
  return typeof params?.sessionId === 'string' ? params.sessionId : undefined;
};

const tabTarget = (
  api: DockviewApi,
  excluded?: IDockviewGroupPanel,
): DockviewGroupPanel | undefined =>
  (api.activeGroup !== excluded ? api.activeGroup : undefined) ??
  api.groups.find((group) => group !== excluded);

export function enforceGroupLimit(api: DockviewApi): void {
  for (const extra of [...api.groups].slice(MAX_VISIBLE_GROUPS)) {
    const target = tabTarget(api, extra) ?? api.groups[0];
    if (!target || target === extra) continue;
    for (const panel of [...extra.panels]) {
      panel.api.moveTo({ group: target, position: 'center' });
    }
    if (api.groups.includes(extra) && extra.panels.length === 0) {
      api.removeGroup(extra);
    }
  }
}

export function pruneDeletedSessions(
  api: DockviewApi,
  sessionIds: ReadonlySet<string>,
): void {
  for (const panel of [...api.panels]) {
    const sessionId = sessionIdFor(panel);
    if (!sessionId || !sessionIds.has(sessionId)) api.removePanel(panel);
  }
}

export function openSessionPanel(
  api: DockviewApi,
  session: WorkspaceSession,
  options: { split?: boolean } = {},
): IDockviewPanel {
  const existing = api.getPanel(session.id);
  if (existing) {
    existing.api.setActive();
    return existing;
  }

  const referenceGroup = tabTarget(api);
  const maySplit = options.split && api.groups.length < MAX_VISIBLE_GROUPS;
  return api.addPanel<SessionPanelParams>({
    id: session.id,
    component: SESSION_COMPONENT,
    title: session.title,
    params: { sessionId: session.id },
    position: referenceGroup
      ? {
          referenceGroup,
          ...(maySplit ? { direction: 'right' as const } : {}),
        }
      : undefined,
  });
}

export function restoreSavedLayout(
  api: DockviewApi,
  saved: SavedLayout | undefined,
  sessions: WorkspaceSession[],
  selectedSessionId?: string,
): void {
  if (saved) {
    try {
      api.fromJSON(saved.dockview as SerializedDockview);
    } catch {
      api.clear();
    }
  } else {
    api.clear();
  }

  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  pruneDeletedSessions(api, new Set(sessionsById.keys()));
  enforceGroupLimit(api);

  const selected = selectedSessionId
    ? sessionsById.get(selectedSessionId)
    : undefined;
  if (selected) openSessionPanel(api, selected);
}

export function reconcileDockview(
  api: DockviewApi,
  sessions: WorkspaceSession[],
  selectedSessionId?: string,
): void {
  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  pruneDeletedSessions(api, new Set(sessionsById.keys()));
  enforceGroupLimit(api);
  const selected = selectedSessionId
    ? sessionsById.get(selectedSessionId)
    : undefined;
  if (selected) openSessionPanel(api, selected);
}

export function installTwoGroupPolicy(api: DockviewApi) {
  const drop = api.onWillDrop((event) => {
    if (event.position === 'center' || api.groups.length < MAX_VISIBLE_GROUPS)
      return;

    event.preventDefault();
    const transfer = event.getData?.();
    const sourceGroup = transfer ? api.getGroup(transfer.groupId) : undefined;
    const target = event.group ?? tabTarget(api, sourceGroup);
    if (!target) return;

    const panels = event.panel
      ? [event.panel]
      : sourceGroup
        ? [...sourceGroup.panels]
        : [];
    for (const panel of panels) {
      panel.api.moveTo({ group: target, position: 'center' });
    }
  });
  const group = api.onDidAddGroup(() => enforceGroupLimit(api));

  return {
    dispose() {
      drop.dispose();
      group.dispose();
    },
  };
}

export function serializeDockview(
  api: DockviewApi,
  sidebar: unknown,
): DockviewLayoutSnapshot {
  return {
    dockview: api.toJSON(),
    sidebar,
    visiblePanels: api.panels
      .map(sessionIdFor)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  };
}
