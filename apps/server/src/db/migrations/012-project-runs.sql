CREATE TABLE project_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'draining', 'completed')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  concurrency INTEGER NOT NULL CHECK (concurrency > 0),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completion_reason TEXT,
  CHECK (
    (state IN ('running', 'paused', 'draining') AND completed_at IS NULL AND completion_reason IS NULL)
    OR
    (state = 'completed' AND completed_at IS NOT NULL AND completion_reason IS NOT NULL)
  )
);

CREATE TABLE project_run_items (
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
    (status IN ('completed', 'attention_required') AND claimed_at IS NOT NULL AND started_at IS NOT NULL AND attempt_id IS NOT NULL AND session_id IS NOT NULL)
    OR
    (status = 'not_started' AND started_at IS NULL AND attempt_id IS NULL AND session_id IS NULL)
  )
);

CREATE UNIQUE INDEX one_active_project_run
ON project_runs(project_id)
WHERE state IN ('running', 'paused', 'draining');

CREATE UNIQUE INDEX one_open_project_run_item_per_task
ON project_run_items(task_id)
WHERE status IN ('queued', 'launch_pending', 'active');

CREATE INDEX project_run_queue_order
ON project_run_items(run_id, queue_position, id);
