import { useEffect, useMemo, useState } from 'react';
import { useHookstate } from '@hookstate/core';
import {
  savedLayoutSchema,
  taskActorSchema,
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
import {
  NewSessionDialog,
  type SessionFlowError,
} from '../sessions/NewSessionDialog';
import { ResumeSessionDialog } from '../sessions/ResumeSessionDialog';
import { SessionSidebar } from '../sessions/SessionSidebar';
import { SessionWorkspace } from '../workspace/SessionWorkspace';
import type { DockviewLayoutSnapshot } from '../workspace/layout-controller';
import {
  ProjectImportDialog,
  type ImportedProject,
  type ProjectImportSuggestion,
} from '../projects/ProjectImportDialog';

type MeshStore = ReturnType<typeof createMeshStore>;
type AppCommand = { type: string; payload?: unknown };
const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
});

type AppProps = {
  projects?: Project[];
  workspaces?: Workspace[];
  sessions?: Session[];
  onCommand?: (command: AppCommand) => void;
  store?: MeshStore;
  api?: Pick<
    MeshApi,
    'command' | 'diagnostics' | 'discover' | 'projectSnapshot'
  >;
};

const snapshotFor = ({
  projects = [],
  workspaces = [],
  sessions = [],
}: AppProps): SessionSnapshot => ({
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
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(
    selected?.projectId ?? projects[0]?.id,
  );
  const [view, setView] = useState<'board' | 'sessions'>('sessions');
  const [projectImportOpen, setProjectImportOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ProjectImportSuggestion[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [resumeSessionOpen, setResumeSessionOpen] = useState(false);
  const [flowError, setFlowError] = useState<SessionFlowError>();
  const [collisionWarning, setCollisionWarning] = useState<string>();
  const workspaceById = new Map(
    workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const activeProject = projects.find(({ id }) => id === activeProjectId);
  useEffect(() => {
    if (!activeProjectId && projects[0]) setActiveProjectId(projects[0].id);
    if (activeProjectId && !projects.some(({ id }) => id === activeProjectId))
      setActiveProjectId(projects[0]?.id);
  }, [activeProjectId, projects]);
  const submit = (command: MutatingCommand) => {
    onCommand?.({ type: command.type, payload: command.payload });
    const execute = api ? api.command(command) : Promise.resolve(undefined);
    void execute
      .then((response) => {
        const warning = response?.warnings.find((candidate) =>
          /collision|shared/i.test(candidate.code),
        );
        setCollisionWarning(warning?.message);
        setFlowError(undefined);
        if (command.type === 'session.create' && !warning)
          setNewSessionOpen(false);
        if (command.type === 'session.resume') setResumeSessionOpen(false);
      })
      .catch((caught: unknown) => {
        const failure = caught as { code?: string; message?: string };
        setFlowError({
          code: failure.code ?? 'unknown',
          message: failure.message,
        });
      });
  };
  const selectProject = (projectId: string) => {
    setActiveProjectId(projectId);
    setView('board');
    if (!api?.projectSnapshot) return;
    setProjectLoading(true);
    void api
      .projectSnapshot(projectId)
      .then((snapshot) => store.replaceProjectSnapshot(snapshot))
      .catch((caught: unknown) => {
        const failure = caught as { code?: string; message?: string };
        setFlowError({
          code: failure.code ?? 'unknown',
          message: failure.message ?? 'The project board could not be loaded.',
        });
      })
      .finally(() => setProjectLoading(false));
  };
  const discoverSuggestions = () => {
    if (!api?.discover) return;
    void api
      .discover({ protocolVersion: 1, type: 'projects.discover', payload: {} })
      .then((response) => {
        const result = response.result as {
          suggestions?: ProjectImportSuggestion[];
        };
        setSuggestions(result.suggestions ?? []);
      })
      .catch(() => setSuggestions([]));
  };
  const importProject = async ({
    repositoryPath,
    displayName,
  }: {
    repositoryPath: string;
    displayName?: string;
  }): Promise<ImportedProject> => {
    if (!api)
      throw new Error('Project import is unavailable while disconnected.');
    const response = await api.command({
      type: 'project.import',
      payload: {
        repositoryPath,
        displayName,
        actor: operator,
      },
    });
    return response.result as ImportedProject;
  };
  const openImportedProject = (project: ImportedProject) => {
    setProjectImportOpen(false);
    selectProject(project.id);
  };
  const restoreProject = () => {
    if (!activeProject) return;
    submit({
      type: 'project.restore',
      payload: {
        projectId: activeProject.id,
        expectedRevision: activeProject.revision,
        actor: operator,
      },
    });
  };

  return (
    <div className="app-shell">
      <SessionSidebar
        projects={projects}
        workspaces={workspaces}
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        filter={filter}
        unreadSessionIds={Object.fromEntries(
          sessions.map(({ id }) => [id, unread.has(id)]),
        )}
        onFilterChange={(value) => store.setFilter('sessions', value)}
        onOpenSession={(sessionId) => {
          store.selectSession(sessionId);
          setActiveProjectId(
            sessions.find(({ id }) => id === sessionId)?.projectId,
          );
          setView('sessions');
        }}
        onNewSession={() => {
          setFlowError(undefined);
          setCollisionWarning(undefined);
          setNewSessionOpen(true);
        }}
        onResumeSession={() => {
          setFlowError(undefined);
          setResumeSessionOpen(true);
        }}
      />
      <NewSessionDialog
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        projects={projects}
        collisionWarning={collisionWarning}
        error={flowError}
        onCreate={(command) => submit(command as MutatingCommand)}
      />
      <ResumeSessionDialog
        open={resumeSessionOpen}
        onOpenChange={setResumeSessionOpen}
        error={flowError}
        workspaces={workspaces}
        sessions={sessions.map((session) => {
          const workspace = workspaceById.get(session.workspaceId);
          return {
            id: session.id,
            projectId: session.projectId,
            workspaceId: session.workspaceId,
            title: session.title,
            claudeResumeId: session.claudeResumeId,
            lastPath: workspace?.path,
            applicationMatch: 'Matched Mesh session',
            permissionMode: session.permissionMode,
            workspaceType: workspace?.type,
          };
        })}
        onResume={(command) => submit(command as MutatingCommand)}
      />
      <aside className="project-navigation" aria-label="Project navigation">
        <div className="project-navigation-heading">
          <span className="eyebrow">Projects</span>
          <label>
            Selected project
            <select
              aria-label="Selected project"
              value={activeProjectId ?? ''}
              onChange={(event) => selectProject(event.target.value)}
            >
              {projects.length === 0 ? (
                <option value="">No projects</option>
              ) : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div
          className="project-navigation-actions"
          role="navigation"
          aria-label="Project destinations"
        >
          <button
            className="button button-ghost"
            aria-current={view === 'board' ? 'page' : undefined}
            disabled={!activeProject}
            onClick={() => activeProject && selectProject(activeProject.id)}
          >
            Board
          </button>
          <button
            className="button button-ghost"
            aria-current={view === 'sessions' ? 'page' : undefined}
            onClick={() => setView('sessions')}
          >
            Sessions
          </button>
        </div>
        <button
          className="button button-secondary"
          onClick={() => {
            setProjectImportOpen(true);
            discoverSuggestions();
          }}
        >
          Import repository
        </button>
      </aside>
      <div className="project-view">
        <div hidden={view === 'board' && Boolean(activeProject)}>
          <SessionWorkspace
            sessions={sessions}
            events={projection.events}
            workspaces={workspaces}
            api={api}
            auditAvailable={projection.connectionHealth === 'connected'}
            promptDrafts={projection.promptDrafts}
            streamingAssistantTextBySession={
              projection.streamingAssistantTextBySession
            }
            onPromptDraftChange={store.setPromptDraft}
            onNewSession={() => {
              setFlowError(undefined);
              setCollisionWarning(undefined);
              setNewSessionOpen(true);
            }}
            onResumeSession={() => {
              setFlowError(undefined);
              setResumeSessionOpen(true);
            }}
            savedLayout={savedLayout}
            selectedSessionId={selectedSessionId}
            sidebar={{ filter }}
            onSaveLayout={(layout) =>
              saveLayout(api, onCommand, savedLayout, selected, layout)
            }
          />
        </div>
        {view === 'board' && activeProject ? (
          <section
            className="project-board-boundary"
            aria-label={`${activeProject.displayName} board`}
            aria-readonly={activeProject.archivedAt ? 'true' : undefined}
          >
            <div>
              <span className="eyebrow">Project board</span>
              <h2>{activeProject.displayName}</h2>
              {projectLoading ? (
                <p role="status">Loading project board…</p>
              ) : null}
              {activeProject.archivedAt ? (
                <>
                  <p>This project is read-only until restored.</p>
                  <button
                    className="button button-primary"
                    onClick={restoreProject}
                  >
                    Restore project
                  </button>
                </>
              ) : (
                <p>Board tasks will appear here.</p>
              )}
            </div>
          </section>
        ) : null}
      </div>
      <ProjectImportDialog
        open={projectImportOpen}
        onOpenChange={setProjectImportOpen}
        suggestions={suggestions}
        onImport={importProject}
        onImported={openImportedProject}
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
