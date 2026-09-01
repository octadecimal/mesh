CREATE UNIQUE INDEX developer_attempts_project_attempt
  ON developer_attempts(project_id, id);

CREATE TABLE developer_start_reservations (
  attempt_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) > 0),
  command_type TEXT NOT NULL CHECK (command_type = 'developer_attempt.start'),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  board_json TEXT NOT NULL CHECK (json_valid(board_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  FOREIGN KEY (project_id, attempt_id)
    REFERENCES developer_attempts(project_id, id)
);

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

CREATE TRIGGER developer_start_claim_identity_is_immutable
BEFORE UPDATE OF attempt_id, project_id, idempotency_key, command_type, request_hash
ON developer_start_reservations
WHEN OLD.attempt_id <> NEW.attempt_id
  OR OLD.project_id <> NEW.project_id
  OR OLD.idempotency_key <> NEW.idempotency_key
  OR OLD.command_type <> NEW.command_type
  OR OLD.request_hash <> NEW.request_hash
BEGIN
  SELECT RAISE(ABORT, 'Developer start claim identity is immutable');
END;

CREATE TRIGGER command_result_identity_is_immutable
BEFORE UPDATE OF idempotency_key, command_type, request_hash ON command_results
WHEN OLD.idempotency_key <> NEW.idempotency_key
  OR OLD.command_type <> NEW.command_type
  OR OLD.request_hash <> NEW.request_hash
BEGIN
  SELECT RAISE(ABORT, 'Command result identity is immutable');
END;
