ALTER TABLE projects ADD COLUMN qa_instructions_content TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN qa_instructions_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN qa_instructions_updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN qa_instructions_updated_by_json TEXT;
ALTER TABLE projects ADD COLUMN qa_review_policy TEXT NOT NULL DEFAULT 'manual'
  CHECK (qa_review_policy IN ('manual', 'autonomous_review'));
ALTER TABLE projects ADD COLUMN qa_configuration_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN qa_configuration_updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN qa_configuration_updated_by_json TEXT;

UPDATE projects
SET qa_instructions_updated_at = updated_at,
    qa_configuration_updated_at = updated_at
WHERE qa_instructions_updated_at = '' OR qa_configuration_updated_at = '';

CREATE TABLE qa_execution_cycles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  review_policy TEXT NOT NULL CHECK (review_policy IN ('manual', 'autonomous_review')),
  automation_generation INTEGER NOT NULL CHECK (automation_generation >= 0),
  rejection_ordinal INTEGER NOT NULL CHECK (rejection_ordinal >= 0),
  disposition TEXT CHECK (disposition IN ('verified', 'rejected')),
  started_at TEXT NOT NULL,
  terminal_at TEXT,
  report_id TEXT,
  terminal_command_id TEXT,
  terminal_event_id TEXT,
  UNIQUE(attempt_id, ordinal),
  CHECK (
    (disposition IS NULL AND terminal_at IS NULL AND report_id IS NULL AND terminal_command_id IS NULL AND terminal_event_id IS NULL)
    OR
    (disposition IS NOT NULL AND terminal_at IS NOT NULL AND report_id IS NOT NULL AND terminal_command_id IS NOT NULL AND terminal_event_id IS NOT NULL)
  )
);

CREATE TABLE qa_reports (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL UNIQUE REFERENCES qa_execution_cycles(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE review_automation_actions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  source_cycle_id TEXT NOT NULL REFERENCES qa_execution_cycles(id) ON DELETE CASCADE,
  action_kind TEXT NOT NULL CHECK (action_kind IN ('launch_qa', 'resume_developer', 'complete_task', 'pause_automation')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'pending' AND error_code IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND error_code IS NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND error_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX qa_execution_cycles_attempt_ordinal
  ON qa_execution_cycles(attempt_id, ordinal, id);
CREATE INDEX qa_reports_cycle_id ON qa_reports(cycle_id);
CREATE UNIQUE INDEX qa_execution_cycles_terminal_report
  ON qa_execution_cycles(report_id)
  WHERE report_id IS NOT NULL;
CREATE INDEX review_automation_actions_pending
  ON review_automation_actions(status, created_at, id);
CREATE INDEX review_automation_actions_attempt
  ON review_automation_actions(attempt_id, created_at, id);

CREATE TRIGGER qa_execution_cycles_terminal_report_matches_cycle
BEFORE UPDATE OF disposition, report_id ON qa_execution_cycles
WHEN NEW.disposition IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM qa_reports
    WHERE id = NEW.report_id
      AND cycle_id = NEW.id
      AND json_extract(report_json, '$.disposition') = NEW.disposition
  ) THEN RAISE(ABORT, 'QA terminal report must match its cycle and disposition') END;
END;

CREATE TRIGGER qa_execution_cycles_terminal_report_matches_insert
BEFORE INSERT ON qa_execution_cycles
WHEN NEW.disposition IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM qa_reports
    WHERE id = NEW.report_id
      AND cycle_id = NEW.id
      AND json_extract(report_json, '$.disposition') = NEW.disposition
  ) THEN RAISE(ABORT, 'QA terminal report must match its cycle and disposition') END;
END;

CREATE TRIGGER qa_reports_immutable_update
BEFORE UPDATE ON qa_reports
BEGIN
  SELECT RAISE(ABORT, 'QA reports are immutable');
END;
CREATE TRIGGER qa_reports_immutable_delete
BEFORE DELETE ON qa_reports
BEGIN
  SELECT RAISE(ABORT, 'QA reports are immutable');
END;
