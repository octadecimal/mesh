ALTER TABLE developer_execution_cycles
ADD COLUMN task_snapshot_title TEXT NOT NULL DEFAULT '';

UPDATE developer_execution_cycles
SET task_snapshot_title = COALESCE(
  (
    SELECT tasks.title
    FROM task_attempts
    JOIN tasks ON tasks.id = task_attempts.task_id
    WHERE task_attempts.id = developer_execution_cycles.attempt_id
  ),
  ''
)
WHERE task_snapshot_title = '';
