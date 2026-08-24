import { useMemo } from 'react';
import { useHookstate } from '@hookstate/core';
import {
  savedLayoutSchema,
  type MutatingCommand,
  type Project,
  type SavedLayout,
  type Session,
  type SessionSnapshot,
  type Workspace,
} from '@mesh-session-platform/contracts';

import type { MeshApi } from '../api/client';
import type { MeshProjection } from '../state/reducer';
import {
  selectProjects,
  savedLayoutMatchesSession,
  selectSavedLayout,
  selectSelectedSessionId,
  selectSessionFilter,
  selectSessions,
  selectUnreadSessionIds,
  selectWorkspaces,
} from '../state/selectors';
import { createMeshStore } from '../state/store';
import { SessionSidebar } from '../sessions/SessionSidebar';
import { SessionWorkspace } from '../workspace/SessionWorkspace';
import type { DockviewLayoutSnapshot } from '../workspace/layout-controller';

type MeshStore = ReturnType<typeof createMeshStore>;
type AppCommand = { type: string; payload?: unknown };

type AppProps = {
  projects?: Project[];
  workspaces?: Workspace[];
  sessions?: Session[];
  onCommand?: (command: AppCommand) => void;
  store?: MeshStore;
  api?: Pick<MeshApi, 'command' | 'diagnostics'>;
};

const snapshotFor = ({ projects = [], workspaces = [], sessions = [] }: AppProps): SessionSnapshot => ({
  protocolVersion: 1,
  projects,
  workspaces,
  sessions,
  events: [],
  pendingApprovals: [],
  lastSequenceBySession: {},
  layouts: [],
});

function saveLayout(
  api: AppProps['api'],
  onCommand: AppProps['onCommand'],
  saved: SavedLayout | undefined,
  selected: Session | undefined,
  layout: DockviewLayoutSnapshot,
) {
  const compatibleSaved =
    saved && selected && !savedLayoutMatchesSession(saved, selected)
      ? undefined
      : saved;
  const payload = savedLayoutSchema.parse({
    id: compatibleSaved?.id ?? `layout-${selected?.projectId ?? 'workspace'}`,
    projectId: compatibleSaved
      ? compatibleSaved.projectId
      : selected?.projectId,
    sessionId: compatibleSaved?.sessionId,
    workspaceId: compatibleSaved?.workspaceId,
    dockview: layout.dockview,
    sidebar: layout.sidebar,
    visiblePanels: layout.visiblePanels,
    updatedAt: new Date().toISOString(),
  });
  const command: MutatingCommand = { type: 'layout.save', payload };
  onCommand?.({ type: command.type, payload: command.payload });
  void api?.command(command);
}

function ConnectedApp({
  store,
  api,
  onCommand,
}: {
  store: MeshStore;
  api?: AppProps['api'];
  onCommand?: AppProps['onCommand'];
}) {
  const projection = useHookstate(store.state).get({
    noproxy: true,
  }) as unknown as MeshProjection;
  const projects = selectProjects(projection);
  const workspaces = selectWorkspaces(projection);
  const sessions = selectSessions(projection);
  const selectedSessionId = selectSelectedSessionId(projection);
  const savedLayout = selectSavedLayout(projection);
  const filter = selectSessionFilter(projection, savedLayout);
  const unread = new Set(selectUnreadSessionIds(projection));
  const selected = sessions.find(({ id }) => id === selectedSessionId);

  return (
    <div className="app-shell">
      <SessionSidebar
        projects={projects}
        workspaces={workspaces}
        sessions={sessions}
        filter={filter}
        unreadSessionIds={Object.fromEntries(
          sessions.map(({ id }) => [id, unread.has(id)]),
        )}
        onFilterChange={(value) => store.setFilter('sessions', value)}
        onOpenSession={store.selectSession}
        onNewSession={() => undefined}
      />
      <SessionWorkspace
        sessions={sessions}
        events={projection.events}
        workspaces={workspaces}
        api={api}
        auditAvailable={projection.connectionHealth === 'connected'}
        savedLayout={savedLayout}
        selectedSessionId={selectedSessionId}
        sidebar={{ filter }}
        onSaveLayout={(layout) =>
          saveLayout(api, onCommand, savedLayout, selected, layout)
        }
      />
      <p className="sr-only">Session platform</p>
    </div>
  );
}

export function App(props: AppProps = {}) {
  const fallbackStore = useMemo(() => createMeshStore(snapshotFor(props)), []);
  return (
    <ConnectedApp
      store={props.store ?? fallbackStore}
      api={props.api}
      onCommand={props.onCommand}
    />
  );
}

export default App;
