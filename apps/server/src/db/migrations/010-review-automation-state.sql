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

CREATE TRIGGER review_automation_actions_v2_insert_legacy
AFTER INSERT ON review_automation_actions_v2
WHEN NEW.source_qa_cycle_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO review_automation_actions (
    id, idempotency_key, project_id, task_id, attempt_id, source_cycle_id,
    action_kind, generation, status, error_code, created_at, completed_at
  ) VALUES (
    NEW.id, NEW.idempotency_key, NEW.project_id, NEW.task_id, NEW.attempt_id,
    NEW.source_qa_cycle_id, NEW.action_kind, NEW.generation, NEW.status,
    NEW.error_code, NEW.created_at, NEW.completed_at
  );
END;

CREATE TRIGGER review_automation_actions_v2_update_legacy
AFTER UPDATE OF status, error_code, completed_at ON review_automation_actions_v2
WHEN NEW.source_qa_cycle_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM review_automation_actions
    WHERE id = NEW.id
      AND (
        status IS NOT NEW.status
        OR error_code IS NOT NEW.error_code
        OR completed_at IS NOT NEW.completed_at
      )
  )
BEGIN
  UPDATE review_automation_actions
  SET status = NEW.status,
      error_code = NEW.error_code,
      completed_at = NEW.completed_at
  WHERE id = NEW.id;
END;

CREATE TRIGGER review_automation_actions_legacy_insert_v2
AFTER INSERT ON review_automation_actions
BEGIN
  INSERT OR IGNORE INTO review_automation_actions_v2 (
    id, idempotency_key, project_id, task_id, attempt_id,
    source_developer_cycle_id, source_qa_cycle_id, action_kind, generation,
    status, error_code, created_at, completed_at
  ) VALUES (
    NEW.id, NEW.idempotency_key, NEW.project_id, NEW.task_id, NEW.attempt_id,
    NULL, NEW.source_cycle_id, NEW.action_kind, NEW.generation, NEW.status,
    NEW.error_code, NEW.created_at, NEW.completed_at
  );
END;

CREATE TRIGGER review_automation_actions_legacy_update_v2
AFTER UPDATE OF status, error_code, completed_at ON review_automation_actions
WHEN EXISTS (
  SELECT 1
  FROM review_automation_actions_v2
  WHERE id = NEW.id
    AND source_qa_cycle_id IS NOT NULL
    AND (
      status IS NOT NEW.status
      OR error_code IS NOT NEW.error_code
      OR completed_at IS NOT NEW.completed_at
    )
)
BEGIN
  UPDATE review_automation_actions_v2
  SET status = NEW.status,
      error_code = NEW.error_code,
      completed_at = NEW.completed_at
  WHERE id = NEW.id AND source_qa_cycle_id IS NOT NULL;
END;

CREATE INDEX review_automation_actions_v2_pending
  ON review_automation_actions_v2(status, created_at, id);
CREATE INDEX review_automation_actions_v2_attempt
  ON review_automation_actions_v2(attempt_id, created_at, id);
