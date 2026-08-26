ALTER TABLE projects ADD COLUMN developer_instructions_content TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN developer_instructions_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN developer_instructions_updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN developer_instructions_updated_by_json TEXT;

UPDATE projects
SET developer_instructions_updated_at = updated_at
WHERE developer_instructions_updated_at = '';

CREATE TABLE developer_execution_cycles (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  mode TEXT NOT NULL CHECK (mode IN ('new', 'resume')),
  authorized_by_json TEXT NOT NULL CHECK (json_valid(authorized_by_json)),
  authorization_command_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  project_instructions_content TEXT NOT NULL,
  project_instructions_revision INTEGER NOT NULL CHECK (project_instructions_revision > 0),
  task_snapshot_revision INTEGER NOT NULL CHECK (task_snapshot_revision > 0),
  task_snapshot_title TEXT NOT NULL,
  task_snapshot_description TEXT NOT NULL,
  task_snapshot_acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(task_snapshot_acceptance_criteria_json)),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('interactive', 'safe_auto', 'inherit')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  terminal_disposition TEXT CHECK (terminal_disposition IN ('submitted_for_review', 'blocked')),
  completion_report_id TEXT,
  blocker_report_id TEXT,
  terminal_command_id TEXT,
  terminal_event_id TEXT,
  CHECK (terminal_disposition IS NULL OR ended_at IS NOT NULL)
);

CREATE TABLE developer_completion_reports (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES developer_execution_cycles(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  criterion_results_json TEXT NOT NULL CHECK (json_valid(criterion_results_json)),
  verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
  limitations TEXT NOT NULL,
  workspace_state_json TEXT NOT NULL CHECK (json_valid(workspace_state_json)),
  reviewer_notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE developer_blocker_reports (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES developer_execution_cycles(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  attempted_work TEXT NOT NULL,
  suggested_human_action TEXT NOT NULL,
  preserve_workspace INTEGER NOT NULL CHECK (preserve_workspace IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE developer_review_feedback (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES developer_execution_cycles(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rejection', 'unblock')),
  feedback TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  command_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX developer_execution_cycles_attempt_ordinal
  ON developer_execution_cycles(attempt_id, ordinal);
CREATE UNIQUE INDEX developer_execution_cycles_one_active_per_attempt
  ON developer_execution_cycles(attempt_id)
  WHERE ended_at IS NULL;
CREATE INDEX developer_execution_cycles_workspace
  ON developer_execution_cycles(workspace_id, ended_at);
CREATE INDEX developer_review_feedback_task
  ON developer_review_feedback(task_id, created_at, id);

CREATE TRIGGER developer_completion_reports_immutable_update
BEFORE UPDATE ON developer_completion_reports
BEGIN
  SELECT RAISE(ABORT, 'developer completion reports are immutable');
END;
CREATE TRIGGER developer_completion_reports_immutable_delete
BEFORE DELETE ON developer_completion_reports
BEGIN
  SELECT RAISE(ABORT, 'developer completion reports are immutable');
END;
CREATE TRIGGER developer_blocker_reports_immutable_update
BEFORE UPDATE ON developer_blocker_reports
BEGIN
  SELECT RAISE(ABORT, 'developer blocker reports are immutable');
END;
CREATE TRIGGER developer_blocker_reports_immutable_delete
BEFORE DELETE ON developer_blocker_reports
BEGIN
  SELECT RAISE(ABORT, 'developer blocker reports are immutable');
END;
CREATE TRIGGER developer_review_feedback_immutable_update
BEFORE UPDATE ON developer_review_feedback
BEGIN
  SELECT RAISE(ABORT, 'developer review feedback is immutable');
END;
CREATE TRIGGER developer_review_feedback_immutable_delete
BEFORE DELETE ON developer_review_feedback
BEGIN
  SELECT RAISE(ABORT, 'developer review feedback is immutable');
END;
