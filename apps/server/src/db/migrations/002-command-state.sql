CREATE TABLE processed_commands_next (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'indeterminate')),
  response_json TEXT,
  failure_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO processed_commands_next (
  id, idempotency_key, state, response_json, failure_json, created_at, updated_at
)
SELECT id, idempotency_key, 'completed', response_json, NULL, created_at, created_at
FROM processed_commands;

DROP TABLE processed_commands;
ALTER TABLE processed_commands_next RENAME TO processed_commands;
