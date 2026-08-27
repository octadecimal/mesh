ALTER TABLE project_run_items
ADD COLUMN task_automation_status TEXT NOT NULL DEFAULT 'disabled'
CHECK (task_automation_status IN ('disabled', 'enabled', 'paused'));
