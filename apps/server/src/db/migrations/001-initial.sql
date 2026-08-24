CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  discovery_metadata_json TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('shared', 'worktree')),
  path TEXT NOT NULL,
  git_branch TEXT,
  git_worktree_path TEXT,
  owner TEXT,
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('active', 'pending', 'cleaned'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  claude_resume_id TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('interactive', 'safe_auto', 'inherit')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('idle', 'starting', 'running', 'waiting_for_approval', 'interrupting', 'completed', 'failed', 'interrupted', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE TABLE raw_diagnostics (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  normalized_event_id TEXT REFERENCES session_events(id) ON DELETE SET NULL,
  captured_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE permission_requests (
  permission_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_call_id TEXT,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  requested_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE saved_layouts (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  dockview_json TEXT NOT NULL,
  sidebar_json TEXT,
  visible_panels_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE processed_commands (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_workspaces_project_id ON workspaces(project_id);
CREATE INDEX idx_sessions_project_id ON sessions(project_id);
CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX idx_sessions_archived ON sessions(lifecycle_state, updated_at);
CREATE INDEX idx_session_events_history ON session_events(session_id, sequence);
CREATE INDEX idx_raw_diagnostics_session_id ON raw_diagnostics(session_id, captured_at);
CREATE INDEX idx_permission_requests_pending ON permission_requests(session_id, status);
CREATE INDEX idx_saved_layouts_project_id ON saved_layouts(project_id);
