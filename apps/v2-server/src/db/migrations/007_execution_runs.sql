DROP TRIGGER developer_start_claim_requires_unfinalized_key;
DROP TRIGGER developer_start_claim_blocks_conflicting_result;
DROP TRIGGER developer_start_claim_finalizes_with_result;
DROP TRIGGER command_result_identity_is_immutable;

CREATE TABLE command_results_v7 (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) > 0),
  command_type TEXT NOT NULL CHECK (command_type IN (
    'project.register', 'worker_profile.approve_revision',
    'worker_execution.start', 'worker_execution.interrupt',
    'planning_cycle.submit_turn', 'planning_proposal.approve',
    'planning_proposal.reject', 'planning_cycle.abandon',
    'planning_cycle.submit_plan_turn', 'plan_proposal.approve',
    'plan_proposal.reject', 'board_filter.set',
    'developer_attempt.start', 'developer_attempt.interrupt',
    'developer_attempt.replace_execution',
    'execution_run.start', 'execution_run.pause',
    'execution_run.resume', 'execution_run.stop'
  )),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);

INSERT INTO command_results_v7 (
  idempotency_key, command_type, request_hash, result_json, created_at
)
SELECT idempotency_key, command_type, request_hash, result_json, created_at
FROM command_results;

DROP TABLE command_results;
ALTER TABLE command_results_v7 RENAME TO command_results;

CREATE TRIGGER developer_start_claim_requires_unfinalized_key
BEFORE INSERT ON developer_start_reservations
WHEN EXISTS (
  SELECT 1 FROM command_results
  WHERE idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'Developer start idempotency key is already finalized');
END;

CREATE TRIGGER developer_start_claim_blocks_conflicting_result
BEFORE INSERT ON command_results
WHEN EXISTS (
  SELECT 1 FROM developer_start_reservations
  WHERE idempotency_key = NEW.idempotency_key
    AND (
      command_type <> NEW.command_type
      OR request_hash <> NEW.request_hash
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Developer start idempotency key is claimed');
END;

CREATE TRIGGER developer_start_claim_finalizes_with_result
AFTER INSERT ON command_results
WHEN EXISTS (
  SELECT 1 FROM developer_start_reservations
  WHERE idempotency_key = NEW.idempotency_key
    AND command_type = NEW.command_type
    AND request_hash = NEW.request_hash
)
BEGIN
  DELETE FROM developer_start_reservations
  WHERE idempotency_key = NEW.idempotency_key;
END;

CREATE TRIGGER command_result_identity_is_immutable
BEFORE UPDATE OF idempotency_key, command_type, request_hash ON command_results
WHEN OLD.idempotency_key <> NEW.idempotency_key
  OR OLD.command_type <> NEW.command_type
  OR OLD.request_hash <> NEW.request_hash
BEGIN
  SELECT RAISE(ABORT, 'Command result identity is immutable');
END;

CREATE TABLE execution_runs (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('running', 'paused', 'stopping', 'completed')
  ),
  completion_reason TEXT CHECK (
    completion_reason IS NULL OR completion_reason IN ('finished', 'stopped')
  ),
  aggregate_json TEXT NOT NULL CHECK (json_valid(aggregate_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0),
  UNIQUE (id, project_id),
  CHECK (
    (lifecycle = 'completed') =
      (completion_reason IS NOT NULL AND ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX one_nonterminal_execution_run_per_project
  ON execution_runs(project_id)
  WHERE lifecycle <> 'completed';

CREATE TABLE execution_run_items (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'waiting', 'launch_pending', 'active', 'completed',
    'attention_required', 'not_started'
  )),
  developer_attempt_id TEXT,
  aggregate_json TEXT NOT NULL CHECK (json_valid(aggregate_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0),
  UNIQUE (run_id, task_id),
  UNIQUE (run_id, ordinal),
  FOREIGN KEY (run_id, project_id) REFERENCES execution_runs(id, project_id),
  FOREIGN KEY (developer_attempt_id, project_id)
    REFERENCES developer_attempts(id, project_id),
  CHECK (
    (lifecycle IN ('completed', 'attention_required', 'not_started')) =
      (ended_at IS NOT NULL)
  )
);

CREATE TRIGGER execution_run_identity_is_immutable
BEFORE UPDATE OF id, project_id, created_at ON execution_runs
WHEN OLD.id <> NEW.id
  OR OLD.project_id <> NEW.project_id
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Execution run identity is immutable');
END;

CREATE TRIGGER execution_run_item_identity_is_immutable
BEFORE UPDATE OF id, run_id, project_id, task_id, ordinal, created_at
ON execution_run_items
WHEN OLD.id <> NEW.id
  OR OLD.run_id <> NEW.run_id
  OR OLD.project_id <> NEW.project_id
  OR OLD.task_id <> NEW.task_id
  OR OLD.ordinal <> NEW.ordinal
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Execution run item identity is immutable');
END;
