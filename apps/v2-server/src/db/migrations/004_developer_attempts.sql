CREATE TABLE developer_attempts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'reserved', 'provisioning', 'active', 'completed', 'blocked',
    'interrupted', 'attention_required'
  )),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  delivery_plan_id TEXT NOT NULL,
  delivery_plan_revision INTEGER NOT NULL CHECK (delivery_plan_revision > 0),
  intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision > 0),
  task_contract_revision INTEGER NOT NULL CHECK (task_contract_revision > 0),
  task_current_revision INTEGER NOT NULL CHECK (task_current_revision > 0),
  requirement_revisions_json TEXT NOT NULL CHECK (
    length(requirement_revisions_json) > 0 AND json_valid(requirement_revisions_json)
  ),
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64) AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  assignment_json TEXT NOT NULL CHECK (
    length(assignment_json) > 0 AND json_valid(assignment_json)
  ),
  controlling_execution_id TEXT,
  attention_json TEXT CHECK (
    attention_json IS NULL OR (length(attention_json) > 0 AND json_valid(attention_json))
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0),
  UNIQUE (id, project_id),
  UNIQUE (project_id, task_id, ordinal),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id),
  FOREIGN KEY (delivery_plan_id, delivery_plan_revision, project_id)
    REFERENCES delivery_plan_revisions(delivery_plan_id, revision, project_id),
  FOREIGN KEY (project_id, intent_revision)
    REFERENCES project_intent_revisions(project_id, revision),
  FOREIGN KEY (project_id, ledger_revision)
    REFERENCES ledger_revisions(project_id, revision),
  FOREIGN KEY (task_id, task_contract_revision, project_id)
    REFERENCES task_revisions(task_id, revision, project_id),
  FOREIGN KEY (task_id, task_current_revision, project_id)
    REFERENCES task_revisions(task_id, revision, project_id),
  FOREIGN KEY (profile_id, profile_revision)
    REFERENCES worker_profile_revisions(profile_id, revision),
  FOREIGN KEY (controlling_execution_id, project_id)
    REFERENCES worker_executions(id, project_id),
  CHECK (
    (lifecycle IN ('completed', 'blocked', 'attention_required'))
      = (ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX developer_attempt_one_controlling_task
  ON developer_attempts(project_id, task_id)
  WHERE lifecycle IN ('reserved', 'provisioning', 'active', 'interrupted');

CREATE TABLE developer_workspaces (
  attempt_id TEXT PRIMARY KEY REFERENCES developer_attempts(id),
  repository_path TEXT NOT NULL CHECK (length(repository_path) > 0),
  repository_identity TEXT NOT NULL CHECK (length(repository_identity) > 0),
  branch TEXT NOT NULL CHECK (length(branch) > 0),
  path TEXT NOT NULL CHECK (length(path) > 0),
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64) AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('reserved', 'creating', 'ready', 'attention_required')
  ),
  ownership_token TEXT NOT NULL CHECK (length(ownership_token) > 0),
  observed_head TEXT CHECK (
    observed_head IS NULL OR (
      length(observed_head) IN (40, 64)
      AND observed_head NOT GLOB '*[^0-9a-f]*'
    )
  ),
  observed_dirty INTEGER CHECK (observed_dirty IN (0, 1)),
  failure_json TEXT CHECK (
    failure_json IS NULL OR (length(failure_json) > 0 AND json_valid(failure_json))
  ),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  workspace_json TEXT NOT NULL CHECK (
    length(workspace_json) > 0 AND json_valid(workspace_json)
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
);

CREATE TABLE developer_workspace_operations (
  attempt_id TEXT NOT NULL REFERENCES developer_attempts(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind = 'create'),
  state TEXT NOT NULL CHECK (state IN ('creating', 'succeeded', 'attention_required')),
  request_json TEXT NOT NULL CHECK (
    length(request_json) > 0 AND json_valid(request_json)
  ),
  observation_json TEXT CHECK (
    observation_json IS NULL OR (length(observation_json) > 0 AND json_valid(observation_json))
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  PRIMARY KEY (attempt_id, ordinal)
);

CREATE TABLE developer_attempt_executions (
  attempt_id TEXT NOT NULL REFERENCES developer_attempts(id),
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  linked_at TEXT NOT NULL CHECK (length(linked_at) > 0),
  PRIMARY KEY (attempt_id, ordinal),
  UNIQUE (attempt_id, execution_id),
  UNIQUE (execution_id),
  FOREIGN KEY (attempt_id, project_id)
    REFERENCES developer_attempts(id, project_id),
  FOREIGN KEY (execution_id, project_id)
    REFERENCES worker_executions(id, project_id)
);

CREATE TABLE developer_reports (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  report_json TEXT NOT NULL CHECK (
    length(report_json) > 0 AND json_valid(report_json)
  ),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) > 0),
  UNIQUE (attempt_id, ordinal),
  UNIQUE (execution_id),
  FOREIGN KEY (attempt_id, execution_id)
    REFERENCES developer_attempt_executions(attempt_id, execution_id)
);

CREATE TRIGGER developer_reports_immutable_insert
BEFORE INSERT ON developer_reports
WHEN EXISTS (
  SELECT 1 FROM developer_reports
  WHERE id = NEW.id
    OR execution_id = NEW.execution_id
    OR (attempt_id = NEW.attempt_id AND ordinal = NEW.ordinal)
)
BEGIN
  SELECT RAISE(ABORT, 'Developer reports are immutable');
END;

CREATE TRIGGER developer_reports_immutable_update
BEFORE UPDATE ON developer_reports
BEGIN
  SELECT RAISE(ABORT, 'Developer reports are immutable');
END;

CREATE TRIGGER developer_reports_immutable_delete
BEFORE DELETE ON developer_reports
BEGIN
  SELECT RAISE(ABORT, 'Developer reports are immutable');
END;

CREATE TABLE developer_output_receipts (
  runtime_event_id TEXT PRIMARY KEY CHECK (length(runtime_event_id) > 0),
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  output_digest TEXT NOT NULL CHECK (
    length(output_digest) = 64 AND output_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL OR length(rejection_reason) > 0
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  FOREIGN KEY (attempt_id, execution_id)
    REFERENCES developer_attempt_executions(attempt_id, execution_id),
  FOREIGN KEY (runtime_event_id, project_id, execution_id)
    REFERENCES runtime_events(id, project_id, execution_id),
  CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL))
);
