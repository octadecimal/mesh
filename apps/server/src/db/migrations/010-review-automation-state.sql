ALTER TABLE tasks ADD COLUMN review_automation_status TEXT NOT NULL DEFAULT 'disabled'
  CHECK (review_automation_status IN ('disabled', 'enabled', 'paused'));
ALTER TABLE tasks ADD COLUMN review_automation_generation INTEGER NOT NULL DEFAULT 0
  CHECK (review_automation_generation >= 0);
ALTER TABLE tasks ADD COLUMN review_automation_rejection_count INTEGER NOT NULL DEFAULT 0
  CHECK (review_automation_rejection_count >= 0);
ALTER TABLE tasks ADD COLUMN review_automation_pause_reason TEXT;
ALTER TABLE tasks ADD COLUMN review_automation_updated_at TEXT NOT NULL DEFAULT '';

UPDATE tasks
SET review_automation_updated_at = updated_at
WHERE review_automation_updated_at = '';

CREATE TABLE review_automation_actions_v2 (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  source_developer_cycle_id TEXT REFERENCES developer_execution_cycles(id) ON DELETE CASCADE,
  source_qa_cycle_id TEXT REFERENCES qa_execution_cycles(id) ON DELETE CASCADE,
  action_kind TEXT NOT NULL CHECK (action_kind IN ('launch_qa', 'resume_developer', 'complete_task', 'pause_automation')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((source_developer_cycle_id IS NULL) != (source_qa_cycle_id IS NULL)),
  CHECK (
    (status = 'pending' AND error_code IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND error_code IS NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND error_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

INSERT INTO review_automation_actions_v2 (
  id, idempotency_key, project_id, task_id, attempt_id,
  source_developer_cycle_id, source_qa_cycle_id, action_kind, generation,
  status, error_code, created_at, completed_at
)
SELECT
  id, idempotency_key, project_id, task_id, attempt_id,
  NULL, source_cycle_id, action_kind, generation,
  status, error_code, created_at, completed_at
FROM review_automation_actions;

CREATE INDEX review_automation_actions_v2_pending
  ON review_automation_actions_v2(status, created_at, id);
CREATE INDEX review_automation_actions_v2_attempt
  ON review_automation_actions_v2(attempt_id, created_at, id);
