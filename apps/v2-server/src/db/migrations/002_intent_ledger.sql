CREATE TABLE command_results_v2 (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) > 0),
  command_type TEXT NOT NULL CHECK (command_type IN (
    'project.register', 'worker_profile.approve_revision',
    'worker_execution.start', 'worker_execution.interrupt',
    'planning_cycle.submit_turn', 'planning_proposal.approve',
    'planning_proposal.reject', 'planning_cycle.abandon'
  )),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);

INSERT INTO command_results_v2 (
  idempotency_key, command_type, request_hash, result_json, created_at
)
SELECT idempotency_key, command_type, request_hash, result_json, created_at
FROM command_results;

DROP TABLE command_results;
ALTER TABLE command_results_v2 RENAME TO command_results;

CREATE TABLE migration_002_start_operation_validation (
  marker INTEGER NOT NULL CHECK (marker = 1)
);

INSERT INTO migration_002_start_operation_validation (marker)
SELECT CASE
  WHEN json_type(request_json, '$.idempotencyKey') = 'text'
    AND length(json_extract(request_json, '$.idempotencyKey')) > 0
    AND json_type(request_json, '$.requestHash') = 'text'
    AND length(json_extract(request_json, '$.requestHash')) = 64
    AND json_extract(request_json, '$.requestHash') NOT GLOB '*[^0-9a-f]*'
  THEN 1
  ELSE NULL
END
FROM execution_operations
WHERE kind = 'start';

DROP TABLE migration_002_start_operation_validation;

CREATE UNIQUE INDEX execution_operations_start_request
  ON execution_operations(
    json_extract(request_json, '$.idempotencyKey'),
    json_extract(request_json, '$.requestHash')
  )
  WHERE kind = 'start';

CREATE TABLE planning_cycles (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'discovering', 'launch_pending', 'execution_active', 'awaiting_human',
    'awaiting_approval', 'attention_required', 'approved',
    'proposal_rejected', 'abandoned'
  )),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  base_project_intent_revision INTEGER CHECK (base_project_intent_revision > 0),
  base_ledger_revision INTEGER CHECK (base_ledger_revision > 0),
  latest_proposal_revision INTEGER NOT NULL CHECK (latest_proposal_revision >= 0),
  active_execution_id TEXT REFERENCES worker_executions(id),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0),
  UNIQUE (id, project_id),
  FOREIGN KEY (profile_id, profile_revision)
    REFERENCES worker_profile_revisions(profile_id, revision),
  CHECK ((base_project_intent_revision IS NULL) = (base_ledger_revision IS NULL)),
  CHECK ((lifecycle = 'execution_active') = (active_execution_id IS NOT NULL)),
  CHECK (
    (lifecycle IN ('approved', 'proposal_rejected', 'abandoned'))
      = (ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX planning_cycles_one_nonterminal
  ON planning_cycles(project_id)
  WHERE lifecycle NOT IN ('approved', 'proposal_rejected', 'abandoned');

CREATE TABLE planning_turns (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL,
  planning_cycle_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  actor TEXT NOT NULL CHECK (actor IN ('human', 'pm')),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 16384),
  launch_state TEXT CHECK (launch_state IN ('launch_pending', 'execution_bound')),
  execution_id TEXT REFERENCES worker_executions(id),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (planning_cycle_id, ordinal),
  UNIQUE (id, project_id),
  UNIQUE (id, planning_cycle_id, project_id),
  FOREIGN KEY (planning_cycle_id, project_id)
    REFERENCES planning_cycles(id, project_id),
  CHECK (
    (actor = 'human' AND launch_state IS NOT NULL)
    OR (actor = 'pm' AND launch_state IS NULL AND execution_id IS NOT NULL)
  ),
  CHECK (
    launch_state IS NULL
    OR (launch_state = 'launch_pending' AND execution_id IS NULL)
    OR (launch_state = 'execution_bound' AND execution_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX planning_turns_one_pending
  ON planning_turns(planning_cycle_id)
  WHERE launch_state = 'launch_pending';

CREATE TABLE planning_questions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL,
  planning_cycle_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  key TEXT NOT NULL CHECK (length(key) > 0),
  prompt TEXT NOT NULL CHECK (length(prompt) > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  choices_json TEXT CHECK (choices_json IS NULL OR json_valid(choices_json)),
  UNIQUE (planning_cycle_id, key),
  UNIQUE (planning_cycle_id, turn_id, ordinal),
  FOREIGN KEY (planning_cycle_id, project_id)
    REFERENCES planning_cycles(id, project_id),
  FOREIGN KEY (turn_id, planning_cycle_id, project_id)
    REFERENCES planning_turns(id, planning_cycle_id, project_id)
);

CREATE TABLE planning_proposals (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL,
  planning_cycle_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'awaiting_approval', 'superseded', 'approved', 'rejected'
  )),
  base_project_intent_revision INTEGER CHECK (base_project_intent_revision > 0),
  base_ledger_revision INTEGER CHECK (base_ledger_revision > 0),
  summary TEXT NOT NULL CHECK (length(summary) > 0),
  project_intent_json TEXT NOT NULL CHECK (json_valid(project_intent_json)),
  records_json TEXT NOT NULL CHECK (json_valid(records_json)),
  relationships_json TEXT NOT NULL CHECK (json_valid(relationships_json)),
  diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
  created_by_turn_id TEXT NOT NULL,
  created_by_execution_id TEXT NOT NULL REFERENCES worker_executions(id),
  rejection_feedback TEXT CHECK (
    rejection_feedback IS NULL OR length(rejection_feedback) > 0
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  decided_at TEXT CHECK (decided_at IS NULL OR length(decided_at) > 0),
  UNIQUE (planning_cycle_id, revision),
  UNIQUE (id, project_id),
  FOREIGN KEY (planning_cycle_id, project_id)
    REFERENCES planning_cycles(id, project_id),
  FOREIGN KEY (created_by_turn_id, planning_cycle_id, project_id)
    REFERENCES planning_turns(id, planning_cycle_id, project_id),
  CHECK ((base_project_intent_revision IS NULL) = (base_ledger_revision IS NULL)),
  CHECK ((lifecycle = 'awaiting_approval') = (decided_at IS NULL)),
  CHECK ((lifecycle = 'rejected') = (rejection_feedback IS NOT NULL))
);

CREATE TABLE planning_proposal_records (
  proposal_id TEXT NOT NULL REFERENCES planning_proposals(id),
  proposal_key TEXT NOT NULL CHECK (length(proposal_key) > 0),
  record_id TEXT NOT NULL CHECK (length(record_id) > 0),
  PRIMARY KEY (proposal_id, proposal_key),
  UNIQUE (proposal_id, record_id)
);

CREATE TABLE pm_output_receipts (
  execution_id TEXT PRIMARY KEY REFERENCES worker_executions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  planning_cycle_id TEXT NOT NULL,
  human_turn_id TEXT NOT NULL,
  runtime_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_events(id),
  output_digest TEXT NOT NULL CHECK (
    length(output_digest) = 64 AND output_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL OR length(rejection_reason) > 0
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  FOREIGN KEY (planning_cycle_id, project_id)
    REFERENCES planning_cycles(id, project_id),
  FOREIGN KEY (human_turn_id, planning_cycle_id, project_id)
    REFERENCES planning_turns(id, planning_cycle_id, project_id),
  CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL))
);

CREATE TABLE project_intent_revisions (
  id TEXT NOT NULL CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES planning_proposals(id),
  approved_by TEXT NOT NULL CHECK (approved_by = 'human'),
  approved_at TEXT NOT NULL CHECK (length(approved_at) > 0),
  PRIMARY KEY (id, revision),
  UNIQUE (project_id, revision),
  UNIQUE (id, revision, project_id)
);

CREATE TABLE project_intent_provenance (
  project_intent_id TEXT NOT NULL,
  project_intent_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  PRIMARY KEY (project_intent_id, project_intent_revision, turn_id),
  UNIQUE (project_intent_id, project_intent_revision, ordinal),
  FOREIGN KEY (project_intent_id, project_intent_revision, project_id)
    REFERENCES project_intent_revisions(id, revision, project_id),
  FOREIGN KEY (turn_id, project_id)
    REFERENCES planning_turns(id, project_id)
);

CREATE TABLE ledger_records (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL CHECK (type IN (
    'requirement', 'decision', 'assumption', 'question', 'risk'
  )),
  created_proposal_id TEXT NOT NULL REFERENCES planning_proposals(id),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (id, project_id)
);

CREATE TABLE ledger_record_revisions (
  record_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  proposal_id TEXT NOT NULL REFERENCES planning_proposals(id),
  approved_by TEXT NOT NULL CHECK (approved_by = 'human'),
  approved_at TEXT NOT NULL CHECK (length(approved_at) > 0),
  PRIMARY KEY (record_id, revision),
  UNIQUE (record_id, revision, project_id),
  FOREIGN KEY (record_id, project_id) REFERENCES ledger_records(id, project_id)
);

CREATE TABLE ledger_record_revision_provenance (
  record_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  PRIMARY KEY (record_id, record_revision, turn_id),
  UNIQUE (record_id, record_revision, ordinal),
  FOREIGN KEY (record_id, record_revision, project_id)
    REFERENCES ledger_record_revisions(record_id, revision, project_id),
  FOREIGN KEY (turn_id, project_id) REFERENCES planning_turns(id, project_id)
);

CREATE TABLE ledger_revisions (
  id TEXT NOT NULL CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES planning_proposals(id),
  approved_by TEXT NOT NULL CHECK (approved_by = 'human'),
  approved_at TEXT NOT NULL CHECK (length(approved_at) > 0),
  PRIMARY KEY (id, revision),
  UNIQUE (project_id, revision),
  UNIQUE (id, revision, project_id)
);

CREATE TABLE ledger_revision_members (
  ledger_id TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (ledger_id, ledger_revision, record_id),
  UNIQUE (ledger_id, ledger_revision, ordinal),
  UNIQUE (ledger_id, ledger_revision, record_id, project_id),
  FOREIGN KEY (ledger_id, ledger_revision, project_id)
    REFERENCES ledger_revisions(id, revision, project_id),
  FOREIGN KEY (record_id, record_revision, project_id)
    REFERENCES ledger_record_revisions(record_id, revision, project_id)
);

CREATE TABLE ledger_revision_relationships (
  ledger_id TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'refines', 'depends_on', 'conflicts_with', 'supersedes', 'duplicates',
    'constrains'
  )),
  from_record_id TEXT NOT NULL,
  to_record_id TEXT NOT NULL,
  PRIMARY KEY (ledger_id, ledger_revision, kind, from_record_id, to_record_id),
  UNIQUE (ledger_id, ledger_revision, ordinal),
  FOREIGN KEY (ledger_id, ledger_revision, from_record_id, project_id)
    REFERENCES ledger_revision_members(ledger_id, ledger_revision, record_id, project_id),
  FOREIGN KEY (ledger_id, ledger_revision, to_record_id, project_id)
    REFERENCES ledger_revision_members(ledger_id, ledger_revision, record_id, project_id),
  CHECK (from_record_id <> to_record_id),
  CHECK (
    kind NOT IN ('conflicts_with', 'duplicates')
    OR from_record_id < to_record_id
  )
);
