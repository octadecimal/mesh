ALTER TABLE task_attempt_launch_reservations
ADD COLUMN session_id TEXT REFERENCES sessions(id);
