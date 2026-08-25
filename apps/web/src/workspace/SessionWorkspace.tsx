import { useEffect, useMemo, useRef } from 'react';
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

function DockviewSessionPanel({
  api,
  params,
  session,
  workspace,
  events,
  panelApi,
  auditAvailable,
  promptDraft,
  onPromptDraftChange,
}: IDockviewPanelProps<SessionPanelParams> & {
  session: Session;
  workspace?: Workspace;
  events: SessionEvent[];
  panelApi?: SessionPanelApi;
  auditAvailable: boolean;
  promptDraft: string;
  onPromptDraftChange: (value: string) => void;
}) {
  return (
    <section
      className="session-panel"
      aria-label={`Session ${params.sessionId} panel`}
    >
      <button
        aria-label={`Close ${api.title ?? params.sessionId} panel`}
        onClick={() => api.close()}
      >
        Close
      </button>
      <SessionPanel
        session={session}
        workspace={workspace}
        events={events}
        api={panelApi}
        auditAvailable={auditAvailable}
        promptDraft={promptDraft}
        onPromptDraftChange={onPromptDraftChange}
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
      [SESSION_COMPONENT]: (props: IDockviewPanelProps<SessionPanelParams>) => {
        const session = sessions.find(
          ({ id }) => id === props.params.sessionId,
        );
        const panelSession = sessionForPanel(
          session ?? {
            id: props.params.sessionId,
            title: props.api.title ?? props.params.sessionId,
          },
        );
        return (
          <DockviewSessionPanel
            {...props}
            session={panelSession}
            workspace={workspaces.find(
              (workspace) => workspace.id === panelSession.workspaceId,
            )}
            events={events.filter(
              (event) => event.sessionId === props.params.sessionId,
            )}
            panelApi={panelApi}
            auditAvailable={auditAvailable}
            promptDraft={promptDrafts[props.params.sessionId] ?? ''}
            onPromptDraftChange={(value) =>
              onPromptDraftChange?.(props.params.sessionId, value)
            }
          />
        );
      },
    }),
    [
      sessions,
      workspaces,
      events,
      panelApi,
      auditAvailable,
      promptDrafts,
      onPromptDraftChange,
    ],
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
