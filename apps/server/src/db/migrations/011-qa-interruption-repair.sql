ALTER TABLE qa_execution_cycles ADD COLUMN interrupted_at TEXT;
ALTER TABLE qa_execution_cycles ADD COLUMN interruption_command_id TEXT;
ALTER TABLE qa_execution_cycles ADD COLUMN interruption_event_id TEXT;

CREATE INDEX qa_execution_cycles_interrupted
  ON qa_execution_cycles(interrupted_at, id)
  WHERE interrupted_at IS NOT NULL;
