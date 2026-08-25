import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewPanelProps,
} from 'dockview-react';
import type { SavedLayout } from '@mesh-session-platform/contracts';
import type {
  Session,
  SessionEvent,
  Workspace,
} from '@mesh-session-platform/contracts';

import type { SessionPanelApi } from '../sessions/SessionPanel';
import { SessionPanel } from '../sessions/SessionPanel';

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

export {
  SESSION_COMPONENT,
  type SessionPanelParams,
} from './layout-controller';

type SessionWorkspaceContextValue = {
  sessions: WorkspaceSession[];
  workspaces: Workspace[];
  events: SessionEvent[];
  panelApi?: SessionPanelApi;
  auditAvailable: boolean;
  promptDrafts: Record<string, string>;
  onPromptDraftChange?: (sessionId: string, value: string) => void;
};

const SessionWorkspaceContext = createContext<
  SessionWorkspaceContextValue | undefined
>(undefined);

function DockviewSessionPanel({
  api,
  params,
}: IDockviewPanelProps<SessionPanelParams>) {
  const context = useContext(SessionWorkspaceContext);
  if (!context) throw new Error('Session workspace context is unavailable');
  const session = context.sessions.find(({ id }) => id === params.sessionId);
  const panelSession = sessionForPanel(
    session ?? {
      id: params.sessionId,
      title: api.title ?? params.sessionId,
    },
  );
  return (
    <section
      className="session-panel"
      aria-label={`Session ${params.sessionId} panel`}
    >
      <button
        className="panel-close"
        aria-label={`Close ${api.title ?? params.sessionId} panel`}
        onClick={() => api.close()}
      >
        Close
      </button>
      <SessionPanel
        session={panelSession}
        workspace={context.workspaces.find(
          (workspace) => workspace.id === panelSession.workspaceId,
        )}
        events={context.events.filter(
          (event) => event.sessionId === params.sessionId,
        )}
        api={context.panelApi}
        auditAvailable={context.auditAvailable}
        promptDraft={context.promptDrafts[params.sessionId] ?? ''}
        onPromptDraftChange={(value) =>
          context.onPromptDraftChange?.(params.sessionId, value)
        }
      />
    </section>
  );
}

const sessionForPanel = (session: WorkspaceSession): Session =>
  ({
    id: session.id,
    projectId: 'unknown-project',
    workspaceId: 'unknown-workspace',
    title: session.title,
    permissionMode: 'interactive',
    lifecycleState: 'idle',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...(session as Partial<Session>),
  }) as Session;

export function SessionWorkspace({
  sessions,
  savedLayout,
  selectedSessionId,
  sidebar = { filter: '' },
  onSaveLayout,
  onCloseSession,
  events = [],
  workspaces = [],
  api: panelApi,
  auditAvailable = true,
  promptDrafts = {},
  onPromptDraftChange,
  onNewSession,
  onResumeSession,
}: {
  sessions: WorkspaceSession[];
  savedLayout?: SavedLayout;
  selectedSessionId?: string;
  sidebar?: unknown;
  onSaveLayout?: (layout: DockviewLayoutSnapshot) => void;
  onCloseSession?: (sessionId: string) => void;
  events?: SessionEvent[];
  workspaces?: Workspace[];
  api?: SessionPanelApi;
  auditAvailable?: boolean;
  promptDrafts?: Record<string, string>;
  onPromptDraftChange?: (sessionId: string, value: string) => void;
  onNewSession?: () => void;
  onResumeSession?: () => void;
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
  const components = useMemo(
    () => ({
      [SESSION_COMPONENT]: DockviewSessionPanel,
    }),
    [],
  );

  onSaveRef.current = onSaveLayout;
  onCloseRef.current = onCloseSession;
  sidebarRef.current = sidebar;

  const scheduleSave = (api: DockviewApi) => {
    if (restoringRef.current || !onSaveRef.current) return;
    if (saveTimerRef.current !== undefined)
      window.clearTimeout(saveTimerRef.current);
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
      if (saveTimerRef.current !== undefined)
        window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  return (
    <main
      className="session-workspace"
      data-empty={sessions.length === 0}
      aria-label="Session workspace"
    >
      {sessions.length === 0 ? (
        <section
          className="workspace-empty"
          aria-labelledby="empty-workspace-title"
        >
          <span className="eyebrow">Local session runtime</span>
          <div className="empty-glyph" aria-hidden="true">
            M
          </div>
          <h2 id="empty-workspace-title">Start a Claude session</h2>
          <p>
            Open a shared folder or create an isolated Git worktree. Your
            workspace stays active even when this browser closes.
          </p>
          <div className="empty-actions">
            <button className="button button-primary" onClick={onNewSession}>
              Create your first session
            </button>
            <button
              className="button button-secondary"
              onClick={onResumeSession}
            >
              Resume Claude history
            </button>
          </div>
          <dl className="empty-details">
            <div>
              <dt>Local-first</dt>
              <dd>Loopback only</dd>
            </div>
            <div>
              <dt>Billing</dt>
              <dd>Claude subscription</dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd>Shared or isolated</dd>
            </div>
          </dl>
        </section>
      ) : null}
      <SessionWorkspaceContext.Provider
        value={{
          sessions,
          workspaces,
          events,
          panelApi,
          auditAvailable,
          promptDrafts,
          onPromptDraftChange,
        }}
      >
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
      </SessionWorkspaceContext.Provider>
    </main>
  );
}
