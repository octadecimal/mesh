CREATE TRIGGER sessions_preserve_task_attempt_history
BEFORE DELETE ON sessions
WHEN EXISTS (SELECT 1 FROM task_attempts WHERE session_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'session has task attempt history');
END;

CREATE TABLE task_attempt_launch_reservations (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
