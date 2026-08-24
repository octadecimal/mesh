import { useEffect, useMemo, useRef } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewPanelProps,
} from 'dockview-react';
import type { SavedLayout } from '@mesh-session-platform/contracts';

import {
  installTwoGroupPolicy,
  reconcileDockview,
  restoreSavedLayout,
  serializeDockview,
  SESSION_COMPONENT,
  type DockviewLayoutSnapshot,
  type SessionPanelParams,
  type WorkspaceSession,
} from './layout-controller';

export { SESSION_COMPONENT, type SessionPanelParams } from './layout-controller';

function SessionPanel({ api, params }: IDockviewPanelProps<SessionPanelParams>) {
  return (
    <section className="session-panel" aria-label={`Session ${params.sessionId} panel`}>
      <button
        aria-label={`Close ${api.title ?? params.sessionId} panel`}
        onClick={() => api.close()}
      >
        Close
      </button>
      <p>Session {params.sessionId}</p>
    </section>
  );
}

const components = { [SESSION_COMPONENT]: SessionPanel };

export function SessionWorkspace({
  sessions,
  savedLayout,
  selectedSessionId,
  sidebar = { filter: '' },
  onSaveLayout,
  onCloseSession,
}: {
  sessions: WorkspaceSession[];
  savedLayout?: SavedLayout;
  selectedSessionId?: string;
  sidebar?: unknown;
  onSaveLayout?: (layout: DockviewLayoutSnapshot) => void;
  onCloseSession?: (sessionId: string) => void;
}) {
  const apiRef = useRef<DockviewApi | null>(null);
  const restoringRef = useRef(false);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const restoredLayoutIdRef = useRef<string | undefined>(undefined);
  const onSaveRef = useRef(onSaveLayout);
  const onCloseRef = useRef(onCloseSession);
  const sidebarRef = useRef(sidebar);
  const sessionsKey = useMemo(
    () => sessions.map(({ id, title }) => `${id}:${title}`).join('|'),
    [sessions],
  );

  onSaveRef.current = onSaveLayout;
  onCloseRef.current = onCloseSession;
  sidebarRef.current = sidebar;

  const scheduleSave = (api: DockviewApi) => {
    if (restoringRef.current || !onSaveRef.current) return;
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      onSaveRef.current?.(serializeDockview(api, sidebarRef.current));
    }, 300);
  };

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    restoringRef.current = true;
    if (restoredLayoutIdRef.current !== savedLayout?.id) {
      restoreSavedLayout(api, savedLayout, sessions, selectedSessionId);
      restoredLayoutIdRef.current = savedLayout?.id;
    } else {
      reconcileDockview(api, sessions, selectedSessionId);
    }
    restoringRef.current = false;
    scheduleSave(api);
  }, [sessionsKey, selectedSessionId, savedLayout?.id]);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  return (
    <main className="session-workspace" aria-label="Session workspace">
      <DockviewReact
        className="dockview-theme-dark"
        components={components}
        onReady={({ api }) => {
          apiRef.current = api;
          restoringRef.current = true;
          restoreSavedLayout(api, savedLayout, sessions, selectedSessionId);
          restoredLayoutIdRef.current = savedLayout?.id;
          restoringRef.current = false;

          installTwoGroupPolicy(api);
          api.onDidLayoutChange(() => scheduleSave(api));
          api.onDidRemovePanel((panel) => {
            if (!restoringRef.current) onCloseRef.current?.(panel.id);
          });
          scheduleSave(api);
        }}
      />
    </main>
  );
}
