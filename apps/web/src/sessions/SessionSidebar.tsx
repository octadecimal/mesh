import { useMemo, useState } from 'react';

type SidebarProject = { id: string; displayName: string };
type SidebarWorkspace = {
  id: string;
  projectId: string;
  type: 'shared' | 'worktree';
};
type SidebarSession = {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  lifecycleState: string;
  unreadCount?: number;
};

export function SessionSidebar({
  projects,
  workspaces,
  sessions,
  selectedSessionId,
  onOpenSession,
  onNewSession,
  onResumeSession,
  filter: controlledFilter,
  onFilterChange: controlledFilterChange,
  unreadSessionIds = {},
}: {
  projects: SidebarProject[];
  workspaces: SidebarWorkspace[];
  sessions: SidebarSession[];
  selectedSessionId?: string;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  onResumeSession?: () => void;
  filter?: string;
  onFilterChange?: (filter: string) => void;
  unreadSessionIds?: Record<string, boolean>;
}) {
  const [localFilter, setLocalFilter] = useState('');
  const filter = controlledFilter ?? localFilter;
  const onFilterChange = controlledFilterChange ?? setLocalFilter;
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const matching = (session: SidebarSession) =>
    session.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase());
  return (
    <aside className="session-sidebar" aria-label="Sessions">
      <header className="sidebar-brand">
        <div>
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <div>
            <h1>Mesh</h1>
            <p>Session cockpit</p>
          </div>
        </div>
      </header>
      <div className="sidebar-actions">
        <button className="button button-primary" onClick={onNewSession}>
          New session
        </button>
        <button
          className="button button-secondary"
          aria-label="Resume session"
          onClick={onResumeSession}
        >
          Resume
        </button>
      </div>
      <label className="search-field">
        <span>Filter sessions</span>
        <input
          type="search"
          aria-label="Filter sessions"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
        />
      </label>
      {projects.map((project) => {
        const projectSessions = sessions.filter(
          (session) => session.projectId === project.id && matching(session),
        );
        return (
          <section
            key={project.id}
            aria-label={`${project.displayName} sessions`}
          >
            <div className="project-heading">
              <h2>{project.displayName}</h2>
              <span>{projectSessions.length}</span>
            </div>
            {projectSessions.length === 0 ? (
              <p className="project-empty">No sessions yet</p>
            ) : null}
            {projectSessions.map((session) => {
              const workspace = workspaceById.get(session.workspaceId);
              const approvalRequired =
                session.lifecycleState === 'waiting_for_approval';
              return (
                <button
                  className="session-row"
                  data-selected={selectedSessionId === session.id}
                  aria-pressed={selectedSessionId === session.id}
                  key={session.id}
                  onClick={() => onOpenSession(session.id)}
                >
                  <span className="session-row-title">{session.title}</span>
                  <span className={`status status-${session.lifecycleState}`}>
                    {session.lifecycleState}
                  </span>
                  {session.unreadCount || unreadSessionIds[session.id] ? (
                    <span aria-label={`${session.unreadCount ?? 1} unread`}>
                      {session.unreadCount ?? 1}
                    </span>
                  ) : null}
                  <span className="workspace-badge">
                    {workspace?.type ?? 'shared'}
                  </span>
                  {approvalRequired ? (
                    <span aria-label="Approval required">Approval</span>
                  ) : null}
                </button>
              );
            })}
          </section>
        );
      })}
    </aside>
  );
}
