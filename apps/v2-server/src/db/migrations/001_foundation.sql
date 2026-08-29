CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  repository_identity TEXT NOT NULL UNIQUE CHECK (length(repository_identity) > 0),
  repository_path TEXT NOT NULL CHECK (length(repository_path) > 0),
  git_common_directory TEXT NOT NULL CHECK (length(git_common_directory) > 0),
  head_commit TEXT NOT NULL CHECK (
    length(head_commit) IN (40, 64)
    AND head_commit NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
);

CREATE TABLE worker_profiles (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL CHECK (length(name) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  approved_revision INTEGER CHECK (approved_revision >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  CHECK (
    (scope = 'global' AND project_id IS NULL)
    OR (scope = 'project' AND project_id IS NOT NULL)
  )
);

CREATE TABLE worker_profile_revisions (
  profile_id TEXT NOT NULL REFERENCES worker_profiles(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  source_yaml TEXT NOT NULL CHECK (length(source_yaml) > 0),
  normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
  base_profile_id TEXT REFERENCES worker_profiles(id),
  base_revision INTEGER CHECK (base_revision >= 0),
  approved_by TEXT NOT NULL CHECK (json_valid(approved_by)),
  approved_at TEXT NOT NULL CHECK (length(approved_at) > 0),
  digest TEXT NOT NULL CHECK (
    length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (profile_id, revision),
  FOREIGN KEY (base_profile_id, base_revision)
    REFERENCES worker_profile_revisions(profile_id, revision),
  CHECK ((base_profile_id IS NULL) = (base_revision IS NULL))
);

CREATE TABLE worker_executions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 0),
  assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json)),
  profile_snapshot_json TEXT NOT NULL CHECK (json_valid(profile_snapshot_json)),
  skill_requests_json TEXT NOT NULL CHECK (json_valid(skill_requests_json)),
  resolved_skills_json TEXT NOT NULL CHECK (json_valid(resolved_skills_json)),
  capability_snapshot_json TEXT NOT NULL CHECK (json_valid(capability_snapshot_json)),
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) > 0),
  model TEXT NOT NULL CHECK (length(model) > 0),
  native_handle TEXT CHECK (native_handle IS NULL OR length(native_handle) > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'created', 'starting', 'running', 'interrupting', 'completed', 'failed',
    'interrupted', 'attention_required'
  )),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  last_adapter_cursor INTEGER NOT NULL CHECK (last_adapter_cursor >= 0),
  last_runtime_sequence INTEGER NOT NULL CHECK (last_runtime_sequence >= 0),
  replacement_for_execution_id TEXT REFERENCES worker_executions(id),
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0),
  FOREIGN KEY (profile_id, profile_revision)
    REFERENCES worker_profile_revisions(profile_id, revision)
);

CREATE TABLE execution_operations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  execution_id TEXT NOT NULL REFERENCES worker_executions(id),
  kind TEXT NOT NULL CHECK (kind IN ('start', 'interrupt')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'unknown')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
);

CREATE TABLE command_results (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) > 0),
  command_type TEXT NOT NULL CHECK (command_type IN (
    'project.register', 'worker_profile.approve_revision',
    'worker_execution.start', 'worker_execution.interrupt'
  )),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);

CREATE TABLE event_streams (
  project_id TEXT NOT NULL REFERENCES projects(id),
  stream_kind TEXT NOT NULL CHECK (stream_kind IN ('domain', 'runtime')),
  high_water INTEGER NOT NULL CHECK (high_water >= 0),
  PRIMARY KEY (project_id, stream_kind)
);

CREATE TABLE domain_events (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) > 0),
  type TEXT NOT NULL CHECK (length(type) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (project_id, sequence)
);

CREATE TABLE raw_diagnostics (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  execution_id TEXT REFERENCES worker_executions(id),
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) > 0),
  adapter_cursor INTEGER CHECK (adapter_cursor >= 0),
  received_at TEXT NOT NULL CHECK (length(received_at) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);

CREATE TABLE runtime_events (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  execution_id TEXT NOT NULL REFERENCES worker_executions(id),
  diagnostic_id TEXT NOT NULL REFERENCES raw_diagnostics(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  adapter_cursor INTEGER NOT NULL CHECK (adapter_cursor >= 0),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) > 0),
  type TEXT NOT NULL CHECK (length(type) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (project_id, sequence),
  UNIQUE (execution_id, adapter_cursor)
);

CREATE UNIQUE INDEX worker_profiles_global_name
  ON worker_profiles(name)
  WHERE scope = 'global';

CREATE UNIQUE INDEX worker_profiles_project_name
  ON worker_profiles(project_id, name)
  WHERE scope = 'project';

CREATE UNIQUE INDEX execution_operations_pending
  ON execution_operations(execution_id, kind)
  WHERE state = 'pending';
