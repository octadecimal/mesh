CREATE TABLE project_run_items_014 (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES project_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  task_automation_generation INTEGER NOT NULL CHECK (task_automation_generation >= 0),
  queue_position INTEGER NOT NULL CHECK (queue_position >= 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'launch_pending', 'active', 'completed', 'attention_required', 'not_started')),
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
  launch_idempotency_key TEXT NOT NULL UNIQUE,
  claimed_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  outcome_reason TEXT,
  UNIQUE(run_id, queue_position),
  CHECK ((attempt_id IS NULL) = (session_id IS NULL)),
  CHECK (
    (status IN ('queued', 'launch_pending', 'active') AND outcome_reason IS NULL AND finished_at IS NULL)
    OR
    (status IN ('completed', 'attention_required', 'not_started') AND outcome_reason IS NOT NULL AND finished_at IS NOT NULL)
  ),
  CHECK (
    (status = 'queued' AND claimed_at IS NULL AND started_at IS NULL AND attempt_id IS NULL AND session_id IS NULL)
    OR
    (status = 'launch_pending' AND claimed_at IS NOT NULL AND started_at IS NULL AND attempt_id IS NULL AND session_id IS NULL)
    OR
    (status = 'active' AND claimed_at IS NOT NULL AND started_at IS NOT NULL AND attempt_id IS NOT NULL AND session_id IS NOT NULL)
    OR
    (status = 'completed' AND claimed_at IS NOT NULL AND started_at IS NOT NULL AND attempt_id IS NOT NULL AND session_id IS NOT NULL)
    OR
    (status = 'attention_required' AND claimed_at IS NOT NULL AND (
      (started_at IS NULL AND attempt_id IS NULL AND session_id IS NULL)
      OR
      (started_at IS NOT NULL AND attempt_id IS NOT NULL AND session_id IS NOT NULL)
    ))
    OR
    (status = 'not_started' AND started_at IS NULL AND attempt_id IS NULL AND session_id IS NULL)
  )
);

INSERT INTO project_run_items_014 (
  id, run_id, project_id, task_id, task_revision, policy_revision,
  task_automation_generation, queue_position, status, attempt_id, session_id,
  launch_idempotency_key, claimed_at, started_at, finished_at, outcome_reason
)
SELECT
  id, run_id, project_id, task_id, task_revision, policy_revision,
  task_automation_generation, queue_position, status, attempt_id, session_id,
  launch_idempotency_key, claimed_at, started_at, finished_at, outcome_reason
FROM project_run_items;

DROP TABLE project_run_items;
ALTER TABLE project_run_items_014 RENAME TO project_run_items;

CREATE UNIQUE INDEX one_open_project_run_item_per_task
ON project_run_items(task_id)
WHERE status IN ('queued', 'launch_pending', 'active');

CREATE INDEX project_run_queue_order
ON project_run_items(run_id, queue_position, id);
