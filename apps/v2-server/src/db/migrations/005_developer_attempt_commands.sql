CREATE TABLE command_results_v5 (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) > 0),
  command_type TEXT NOT NULL CHECK (command_type IN (
    'project.register', 'worker_profile.approve_revision',
    'worker_execution.start', 'worker_execution.interrupt',
    'planning_cycle.submit_turn', 'planning_proposal.approve',
    'planning_proposal.reject', 'planning_cycle.abandon',
    'planning_cycle.submit_plan_turn', 'plan_proposal.approve',
    'plan_proposal.reject', 'board_filter.set',
    'developer_attempt.start', 'developer_attempt.interrupt',
    'developer_attempt.replace_execution'
  )),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);

INSERT INTO command_results_v5 (
  idempotency_key, command_type, request_hash, result_json, created_at
)
SELECT idempotency_key, command_type, request_hash, result_json, created_at
FROM command_results;

DROP TABLE command_results;
ALTER TABLE command_results_v5 RENAME TO command_results;
