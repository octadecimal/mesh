ALTER TABLE projects ADD COLUMN repository_identity TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN archived_at TEXT;

UPDATE projects
SET
  repository_identity = repository_path,
  revision = 1,
  created_at = discovered_at,
  updated_at = discovered_at;

CREATE UNIQUE INDEX projects_repository_identity
  ON projects(repository_identity);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  rank TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled')),
  labels_json TEXT NOT NULL CHECK (json_valid(labels_json)),
  notes TEXT NOT NULL,
  blocked_json TEXT NOT NULL CHECK (json_valid(blocked_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  source TEXT NOT NULL CHECK (source IN ('launched', 'linked')),
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  created_at TEXT NOT NULL,
  unlinked_at TEXT,
  unlinked_by_json TEXT CHECK (unlinked_by_json IS NULL OR json_valid(unlinked_by_json)),
  unlink_reason TEXT
);

CREATE TABLE task_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL UNIQUE,
  previous_state TEXT NOT NULL CHECK (previous_state IN ('backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled')),
  next_state TEXT NOT NULL CHECK (next_state IN ('backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled')),
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  reason TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE project_events (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);

CREATE UNIQUE INDEX task_attempts_one_current_task_per_session
  ON task_attempts(session_id)
  WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX task_attempts_task_ordinal
  ON task_attempts(task_id, ordinal);
CREATE UNIQUE INDEX project_events_sequence
  ON project_events(project_id, sequence);
CREATE UNIQUE INDEX project_events_id
  ON project_events(id);
CREATE INDEX tasks_board_order
  ON tasks(project_id, lifecycle_state, rank, id);
