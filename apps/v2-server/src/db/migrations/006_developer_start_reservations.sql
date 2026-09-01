CREATE TABLE developer_start_reservations (
  attempt_id TEXT PRIMARY KEY REFERENCES developer_attempts(id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) > 0),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);
