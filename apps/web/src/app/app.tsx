import { useEffect, useMemo, useRef, useState } from 'react';
import { useHookstate } from '@hookstate/core';
import {
  savedLayoutSchema,
  taskActorSchema,
  type MutatingCommand,
  type Project,
  type SavedLayout,
  type Session,
  type SessionSnapshot,
  type TaskActor,
  type Workspace,
} from '@mesh-session-platform/contracts';

import type { MeshApi } from '../api/client';
import type { MeshProjection } from '../state/reducer';
import {
  selectBoardAttention,
  selectEligibleRunPreview,
  selectPendingApprovals,
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
import { ProjectCreateDialog } from '../projects/ProjectCreateDialog';
import { DeveloperInstructions } from '../projects/DeveloperInstructions';
import { QaSettings } from '../projects/QaSettings';
import { TaskBoard } from '../tasks/TaskBoard';

type MeshStore = ReturnType<typeof createMeshStore>;
type AppCommand = { type: string; payload?: unknown };
type ProjectLoadError = {
  projectId: string;
  displayName: string;
  message: string;
};
const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
}) as Extract<TaskActor, { type: 'human' }>;

type AppProps = {
  projects?: Project[];
  workspaces?: Workspace[];
  sessions?: Session[];
  onCommand?: (command: AppCommand) => void;
  onSelectTask?: (taskId: string) => void;
  store?: MeshStore;
  api?: Pick<
    MeshApi,
    'command' | 'diagnostics' | 'discover' | 'projectSnapshot'
  > &
    Partial<
      Pick<
        MeshApi,
        'projectPlanDetails' | 'projectPlanHistory' | 'selectDirectory'
      >
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
  onSelectTask,
}: {
  store: MeshStore;
  api?: AppProps['api'];
  onCommand?: AppProps['onCommand'];
  onSelectTask?: AppProps['onSelectTask'];
}) {
  const projection = useHookstate(store.state).get({
    noproxy: true,
  }) as unknown as MeshProjection;
  const projects = selectProjects(projection);
  const workspaces = selectWorkspaces(projection);
  const sessions = selectSessions(projection);
  const selectedSessionId = selectSelectedSessionId(projection);
  const savedLayout = selectSavedLayout(projection);
  const unread = new Set(selectUnreadSessionIds(projection));
  const selected = sessions.find(({ id }) => id === selectedSessionId);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(
    selected?.projectId ?? projects[0]?.id,
  );
  const [view, setView] = useState<'plan' | 'board' | 'sessions' | 'settings'>(
    projects[0] ? 'plan' : 'sessions',
  );
  const [visitedProjectIds, setVisitedProjectIds] = useState<string[]>(
    activeProjectId ? [activeProjectId] : [],
  );
  const lastViewByProjectId = useRef<Record<string, typeof view>>({});
  const selectedSessionByProjectId = useRef<Record<string, string>>(
    selected?.projectId ? { [selected.projectId]: selected.id } : {},
  );
  const [sessionFiltersByProjectId, setSessionFiltersByProjectId] = useState<
    Record<string, string>
  >(
    activeProjectId
      ? { [activeProjectId]: selectSessionFilter(projection, savedLayout) }
      : {},
  );
  const [openTaskRequest, setOpenTaskRequest] = useState<{
    taskId: string;
    id: number;
  }>();
  const taskRequestId = useRef(0);
  const [projectImportOpen, setProjectImportOpen] = useState(false);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ProjectImportSuggestion[]>([]);
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [projectLoadTargetId, setProjectLoadTargetId] = useState<
    string | undefined
  >();
  const [projectLoadError, setProjectLoadError] = useState<
    ProjectLoadError | undefined
  >();
  const projectLoadId = useRef(0);
  const automaticallyLoadedProjectIds = useRef(new Set<string>());
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [resumeSessionOpen, setResumeSessionOpen] = useState(false);
  const [flowError, setFlowError] = useState<SessionFlowError>();
  const [collisionWarning, setCollisionWarning] = useState<string>();
  const [
    pendingDeveloperInstructionsByProjectId,
    setPendingDeveloperInstructionsByProjectId,
  ] = useState<Record<string, boolean>>({});
  const [pendingQaSettingsByProjectId, setPendingQaSettingsByProjectId] =
    useState<Record<string, boolean>>({});
  const workspaceById = new Map(
    workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const activeProject = projects.find(({ id }) => id === activeProjectId);
  const activeSessions = sessions.filter(
    (session) => session.projectId === activeProjectId,
  );
  const activeSelected =
    selected?.projectId === activeProjectId ? selected : undefined;
  const activeSavedLayout = activeSelected ? savedLayout : undefined;
  const filter = activeProjectId
    ? (sessionFiltersByProjectId[activeProjectId] ??
      selectSessionFilter(projection, activeSavedLayout))
    : selectSessionFilter(projection, savedLayout);
  const boardAttention = activeProjectId
    ? selectBoardAttention(projection, activeProjectId)
    : [];
  const readyCount = activeProjectId
    ? selectEligibleRunPreview(projection, activeProjectId).length
    : 0;
  const planAttention = Boolean(
    activeProjectId &&
      ['awaiting_review', 'attention_required'].includes(
        projection.activePlanByProjectId[activeProjectId]?.status ?? '',
      ),
  );
  const pendingSessionCount = selectPendingApprovals(projection).filter(
    (approval) =>
      sessions.find((session) => session.id === approval.sessionId)
        ?.projectId === activeProjectId,
  ).length;
  const projectLoadTarget = projects.find(
    ({ id }) => id === projectLoadTargetId,
  );
  useEffect(() => {
    if (!activeProjectId && projects[0]) {
      setActiveProjectId(projects[0].id);
      setVisitedProjectIds((current) =>
        current.includes(projects[0].id)
          ? current
          : [...current, projects[0].id],
      );
      setView('plan');
    }
    if (activeProjectId && !projects.some(({ id }) => id === activeProjectId))
      setActiveProjectId(projects[0]?.id);
  }, [activeProjectId, projects]);
  const navigate = (destination: typeof view) => {
    if (activeProjectId)
      lastViewByProjectId.current[activeProjectId] = destination;
    setView(destination);
    if (
      destination !== 'sessions' &&
      activeProjectId &&
      api?.projectSnapshot &&
      !automaticallyLoadedProjectIds.current.has(activeProjectId)
    )
      selectProject(activeProjectId);
  };
  const activateProject = (projectId: string, taskCount: number) => {
    setActiveProjectId(projectId);
    setVisitedProjectIds((current) =>
      current.includes(projectId) ? current : [...current, projectId],
    );
    setSessionFiltersByProjectId((current) =>
      projectId in current ? current : { ...current, [projectId]: '' },
    );
    const sessionId =
      selectedSessionByProjectId.current[projectId] ??
      sessions.find((session) => session.projectId === projectId)?.id;
    if (sessionId) store.selectSession(sessionId);
    setView(
      lastViewByProjectId.current[projectId] ??
        (taskCount > 0 ? 'board' : 'plan'),
    );
  };
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
  const submitProjectCommand = (command: MutatingCommand) => {
    onCommand?.({ type: command.type, payload: command.payload });
    return api ? api.command(command) : Promise.resolve(undefined);
  };
  const selectProject = (projectId: string) => {
    if (projectLoadTargetId)
      automaticallyLoadedProjectIds.current.delete(projectLoadTargetId);
    automaticallyLoadedProjectIds.current.add(projectId);
    const target = projects.find(({ id }) => id === projectId);
    const loadId = ++projectLoadId.current;
    setProjectLoadTargetId(projectId);
    setProjectLoadError(undefined);
    if (!api?.projectSnapshot) {
      activateProject(
        projectId,
        Object.values(projection.tasksById).filter(
          (task) => task.projectId === projectId,
        ).length,
      );
      setProjectLoadTargetId(undefined);
      return;
    }
    void api
      .projectSnapshot(projectId)
      .then((snapshot) => {
        if (loadId !== projectLoadId.current) return;
        store.replaceProjectSnapshot(snapshot);
        activateProject(projectId, snapshot.tasks.length);
        setProjectLoadTargetId(undefined);
      })
      .catch((caught: unknown) => {
        if (loadId !== projectLoadId.current) return;
        const failure = caught as { code?: string; message?: string };
        setProjectLoadError({
          projectId,
          displayName: target?.displayName ?? 'project',
          message: failure.message ?? 'The project board could not be loaded.',
        });
        setView(lastViewByProjectId.current[projectId] ?? 'board');
      });
  };
  useEffect(() => {
    if (
      !activeProjectId ||
      !api?.projectSnapshot ||
      automaticallyLoadedProjectIds.current.has(activeProjectId)
    )
      return;
    selectProject(activeProjectId);
  }, [activeProjectId]);
  const returnToSessions = () => {
    projectLoadId.current += 1;
    if (projectLoadTargetId)
      automaticallyLoadedProjectIds.current.delete(projectLoadTargetId);
    setProjectLoadTargetId(undefined);
    setProjectLoadError(undefined);
    navigate('sessions');
  };
  const openSession = (sessionId: string) => {
    projectLoadId.current += 1;
    if (projectLoadTargetId)
      automaticallyLoadedProjectIds.current.delete(projectLoadTargetId);
    store.selectSession(sessionId);
    const sessionProjectId = sessions.find(
      ({ id }) => id === sessionId,
    )?.projectId;
    if (sessionProjectId) {
      selectedSessionByProjectId.current[sessionProjectId] = sessionId;
      setActiveProjectId(sessionProjectId);
      setVisitedProjectIds((current) =>
        current.includes(sessionProjectId)
          ? current
          : [...current, sessionProjectId],
      );
      setSessionFiltersByProjectId((current) =>
        sessionProjectId in current
          ? current
          : { ...current, [sessionProjectId]: '' },
      );
      lastViewByProjectId.current[sessionProjectId] = 'sessions';
    }
    setProjectLoadTargetId(undefined);
    setProjectLoadError(undefined);
    setView('sessions');
  };
  const openLinkedTask = (taskId: string) => {
    const task = projection.tasksById[taskId];
    if (!task) return;
    setActiveProjectId(task.projectId);
    setVisitedProjectIds((current) =>
      current.includes(task.projectId) ? current : [...current, task.projectId],
    );
    lastViewByProjectId.current[task.projectId] = 'board';
    setOpenTaskRequest({ taskId, id: ++taskRequestId.current });
    setView('board');
  };
  const discoverSuggestions = () => {
    setDiscoveryError(undefined);
    if (!api?.discover) return;
    void api
      .discover({ protocolVersion: 1, type: 'projects.discover', payload: {} })
      .then((response) => {
        const result = response.result as {
          suggestions?: ProjectImportSuggestion[];
        };
        setSuggestions(result.suggestions ?? []);
      })
      .catch((caught: unknown) => {
        const failure = caught as { message?: string };
        setSuggestions([]);
        setDiscoveryError(
          failure.message ?? 'Repository discovery is unavailable.',
        );
      });
  };
  const openProjectImport = () => {
    setNewSessionOpen(false);
    setProjectImportOpen(true);
    discoverSuggestions();
  };
  const openProjectCreate = () => {
    setNewSessionOpen(false);
    setProjectCreateOpen(true);
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
  const createProject = async ({
    parentDirectory,
    name,
  }: {
    parentDirectory: string;
    name: string;
  }): Promise<ImportedProject> => {
    if (!api)
      throw new Error('Project creation is unavailable while disconnected.');
    const response = await api.command({
      type: 'project.create',
      payload: { parentDirectory, name, actor: operator },
    });
    return response.result as ImportedProject;
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
  const saveDeveloperInstructions = async ({
    content,
    expectedRevision,
  }: {
    content: string;
    expectedRevision: number;
  }) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    if (pendingDeveloperInstructionsByProjectId[projectId]) return;
    const command: MutatingCommand = {
      type: 'project.developer_instructions.update',
      payload: {
        projectId,
        expectedRevision,
        content,
        actor: operator,
      },
    };
    onCommand?.({ type: command.type, payload: command.payload });
    if (!api)
      throw new Error(
        'Developer instructions are unavailable while disconnected.',
      );
    setPendingDeveloperInstructionsByProjectId((current) => ({
      ...current,
      [projectId]: true,
    }));
    try {
      await api.command(command);
    } finally {
      setPendingDeveloperInstructionsByProjectId((current) => {
        const remaining = { ...current };
        delete remaining[projectId];
        return remaining;
      });
    }
  };
  const saveQaSettings = async ({
    content,
    reviewPolicy,
    expectedRevision,
  }: {
    content: string;
    reviewPolicy: Project['qaConfiguration']['reviewPolicy'];
    expectedRevision: number;
  }) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    if (pendingQaSettingsByProjectId[projectId]) return;
    const command: MutatingCommand = {
      type: 'project.qa_configuration.update',
      payload: {
        projectId,
        expectedRevision,
        content,
        reviewPolicy,
        actor: operator,
      },
    };
    onCommand?.({ type: command.type, payload: command.payload });
    if (!api)
      throw new Error('QA settings are unavailable while disconnected.');
    setPendingQaSettingsByProjectId((current) => ({
      ...current,
      [projectId]: true,
    }));
    try {
      await api.command(command);
    } finally {
      setPendingQaSettingsByProjectId((current) => {
        const remaining = { ...current };
        delete remaining[projectId];
        return remaining;
      });
    }
  };
  const projectPlanDetails = api?.projectPlanDetails?.bind(api);
  const projectPlanHistory = api?.projectPlanHistory?.bind(api);
  const linkedTasksBySessionId = Object.fromEntries([
    ...Object.values(projection.attemptsById)
      .filter(
        (attempt) =>
          attempt.unlinkedAt === null && projection.tasksById[attempt.taskId],
      )
      .map(
        (attempt) =>
          [attempt.sessionId, projection.tasksById[attempt.taskId]] as const,
      ),
    ...Object.values(projection.qaCyclesByAttemptId)
      .flat()
      .filter(
        (cycle) =>
          projection.attemptsById[cycle.attemptId]?.unlinkedAt === null &&
          projection.tasksById[cycle.taskId],
      )
      .map(
        (cycle) =>
          [cycle.sessionId, projection.tasksById[cycle.taskId]] as const,
      ),
  ]);

  return (
    <div className="app-shell">
      {view === 'sessions' ? (
        <SessionSidebar
          projects={activeProject ? [activeProject] : []}
          workspaces={workspaces}
          sessions={activeSessions}
          selectedSessionId={activeSelected?.id}
          filter={filter}
          unreadSessionIds={Object.fromEntries(
            sessions.map(({ id }) => [id, unread.has(id)]),
          )}
          onFilterChange={(value) => {
            if (activeProjectId)
              setSessionFiltersByProjectId((current) => ({
                ...current,
                [activeProjectId]: value,
              }));
            store.setFilter('sessions', value);
          }}
          onOpenSession={openSession}
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
      ) : null}
      <NewSessionDialog
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        projects={projects}
        collisionWarning={collisionWarning}
        error={flowError}
        onCreate={(command) => submit(command as MutatingCommand)}
        onImportProject={openProjectImport}
        onNewProject={openProjectCreate}
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
      <header className="project-navigation" aria-label="Project navigation">
        <div className="project-navigation-heading">
          <h1 className="project-navigation-brand">
            <span className="brand-mark" aria-hidden="true">
              M
            </span>
            Mesh
          </h1>
          <label>
            <span className="sr-only">Selected project</span>
            <select
              aria-label="Selected project"
              value={projectLoadTargetId ?? activeProjectId ?? ''}
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
        {projectLoadTarget && !projectLoadError ? (
          <p className="project-load-status" role="status">
            Loading {projectLoadTarget.displayName} project…
          </p>
        ) : null}
        <div
          className="project-navigation-actions"
          role="navigation"
          aria-label="Project destinations"
        >
          <button
            className="button button-ghost"
            aria-label="Plan"
            aria-current={view === 'plan' ? 'page' : undefined}
            disabled={!activeProject}
            onClick={() => activeProject && navigate('plan')}
          >
            Plan
            {planAttention ? (
              <span className="project-nav-badge" aria-hidden="true">
                !
              </span>
            ) : null}
          </button>
          <button
            className="button button-ghost"
            aria-label="Board"
            aria-current={view === 'board' ? 'page' : undefined}
            disabled={!activeProject}
            title={`${readyCount} ready to start`}
            onClick={() => activeProject && navigate('board')}
          >
            Board
            {boardAttention.length > 0 ? (
              <span className="project-nav-badge" aria-hidden="true">
                {boardAttention.length}
              </span>
            ) : null}
          </button>
          <button
            className="button button-ghost"
            aria-label="Sessions"
            aria-current={view === 'sessions' ? 'page' : undefined}
            onClick={returnToSessions}
          >
            Sessions
            {pendingSessionCount > 0 ? (
              <span className="project-nav-badge" aria-hidden="true">
                {pendingSessionCount}
              </span>
            ) : null}
          </button>
          <button
            className="button button-ghost"
            aria-current={view === 'settings' ? 'page' : undefined}
            disabled={!activeProject}
            onClick={() => activeProject && navigate('settings')}
          >
            Project settings
          </button>
        </div>
        <button className="button button-secondary" onClick={openProjectImport}>
          Import project
        </button>
        <button className="button button-secondary" onClick={openProjectCreate}>
          New project
        </button>
      </header>
      <div className="project-view">
        <div hidden={view !== 'sessions'}>
          <SessionWorkspace
            sessions={activeSessions}
            events={projection.events}
            workspaces={workspaces}
            api={api}
            auditAvailable={projection.connectionHealth === 'connected'}
            promptDrafts={projection.promptDrafts}
            streamingAssistantTextBySession={
              projection.streamingAssistantTextBySession
            }
            lastLiveActivityAtBySession={projection.lastLiveActivityAtBySession}
            connectionHealth={projection.connectionHealth}
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
            savedLayout={activeSavedLayout}
            selectedSessionId={activeSelected?.id}
            linkedTasksBySessionId={linkedTasksBySessionId}
            onOpenTask={openLinkedTask}
            sidebar={{ filter }}
            onSaveLayout={(layout) =>
              saveLayout(
                api,
                onCommand,
                activeSavedLayout,
                activeSelected,
                layout,
              )
            }
          />
        </div>
        {projectLoadError ? (
          <section
            className="project-board-boundary project-board-mobile-scroller"
            aria-label="Project board unavailable"
          >
            <div>
              <span className="eyebrow">Project board</span>
              <h2>Could not load {projectLoadError.displayName}</h2>
              <p className="notice notice-error" role="alert">
                {projectLoadError.message}
              </p>
              <div className="project-board-actions">
                <button
                  className="button button-primary"
                  onClick={() => selectProject(projectLoadError.projectId)}
                >
                  Retry project
                </button>
                <button
                  className="button button-ghost"
                  onClick={returnToSessions}
                >
                  Return to sessions
                </button>
              </div>
            </div>
          </section>
        ) : null}
        {visitedProjectIds.map((projectId) => {
          const project = projects.find(({ id }) => id === projectId);
          if (!project) return null;
          const current = projectId === activeProjectId;
          const visible =
            current &&
            view !== 'sessions' &&
            !projectLoadTargetId &&
            !projectLoadError;
          return (
            <section
              key={projectId}
              hidden={!visible}
              className={`project-board-boundary${project.archivedAt ? ' project-board-read-only' : ''}`}
              aria-label={`${project.displayName} board`}
              aria-describedby={
                project.archivedAt
                  ? `project-${project.id}-archived-description`
                  : undefined
              }
            >
              {project.archivedAt ? (
                <div className="project-board-archive-state">
                  <p id={`project-${project.id}-archived-description`}>
                    This project is read-only until restored.
                  </p>
                  {current ? (
                    <button
                      className="button button-primary"
                      onClick={restoreProject}
                    >
                      Restore project
                    </button>
                  ) : null}
                </div>
              ) : null}
              {view === 'settings' && current ? (
                <div className="project-settings-workspace">
                  <h2>Project settings</h2>
                  <DeveloperInstructions
                    key={project.id}
                    project={project}
                    disabled={
                      Boolean(project.archivedAt) ||
                      projection.connectionHealth !== 'connected' ||
                      !api
                    }
                    saving={Boolean(
                      pendingDeveloperInstructionsByProjectId[project.id],
                    )}
                    onSave={saveDeveloperInstructions}
                  />
                  <QaSettings
                    key={`${project.id}:qa`}
                    project={project}
                    disabled={
                      Boolean(project.archivedAt) ||
                      projection.connectionHealth !== 'connected' ||
                      !api
                    }
                    saving={Boolean(pendingQaSettingsByProjectId[project.id])}
                    onSave={saveQaSettings}
                  />
                </div>
              ) : null}
              <div hidden={view === 'settings'}>
                <TaskBoard
                  project={project}
                  projection={projection}
                  onCommand={submitProjectCommand}
                  onSelectTask={onSelectTask}
                  onOpenSession={openSession}
                  onOpenBoard={() => navigate('board')}
                  loadPlanDetails={projectPlanDetails}
                  loadPlanHistory={projectPlanHistory}
                  connected={
                    projection.connectionHealth === 'connected' && Boolean(api)
                  }
                  workspace={current && view === 'plan' ? 'plan' : 'board'}
                  visible={visible && view === 'board'}
                  openTaskRequest={current ? openTaskRequest : undefined}
                />
              </div>
            </section>
          );
        })}
      </div>
      <ProjectImportDialog
        open={projectImportOpen}
        onOpenChange={setProjectImportOpen}
        suggestions={suggestions}
        discoveryError={discoveryError}
        onBrowse={api?.selectDirectory?.bind(api)}
        onImport={importProject}
        onImported={openImportedProject}
      />
      <ProjectCreateDialog
        open={projectCreateOpen}
        onOpenChange={setProjectCreateOpen}
        onBrowse={api?.selectDirectory?.bind(api)}
        onCreate={createProject}
        onCreated={openImportedProject}
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
      onSelectTask={props.onSelectTask}
    />
  );
}

export default App;
