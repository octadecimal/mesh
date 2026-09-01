CREATE TABLE command_results_v3 (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) > 0),
  command_type TEXT NOT NULL CHECK (command_type IN (
    'project.register', 'worker_profile.approve_revision',
    'worker_execution.start', 'worker_execution.interrupt',
    'planning_cycle.submit_turn', 'planning_proposal.approve',
    'planning_proposal.reject', 'planning_cycle.abandon',
    'planning_cycle.submit_plan_turn', 'plan_proposal.approve',
    'plan_proposal.reject', 'board_filter.set'
  )),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
);

INSERT INTO command_results_v3 (
  idempotency_key, command_type, request_hash, result_json, created_at
)
SELECT idempotency_key, command_type, request_hash, result_json, created_at
FROM command_results;

DROP TABLE command_results;
ALTER TABLE command_results_v3 RENAME TO command_results;

CREATE TABLE planning_cycle_purposes (
  planning_cycle_id TEXT PRIMARY KEY REFERENCES planning_cycles(id),
  project_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('intent', 'delivery_plan')),
  base_delivery_plan_id TEXT,
  base_delivery_plan_revision INTEGER CHECK (base_delivery_plan_revision > 0),
  UNIQUE (planning_cycle_id, project_id),
  FOREIGN KEY (planning_cycle_id, project_id)
    REFERENCES planning_cycles(id, project_id),
  FOREIGN KEY (
    base_delivery_plan_id, base_delivery_plan_revision, project_id
  ) REFERENCES delivery_plan_revisions(
    delivery_plan_id, revision, project_id
  ),
  CHECK (
    (base_delivery_plan_id IS NULL) = (base_delivery_plan_revision IS NULL)
  ),
  CHECK (
    purpose = 'delivery_plan'
    OR (base_delivery_plan_id IS NULL AND base_delivery_plan_revision IS NULL)
  )
);

CREATE TRIGGER planning_cycles_default_purpose
AFTER INSERT ON planning_cycles
BEGIN
  INSERT INTO planning_cycle_purposes (
    planning_cycle_id, project_id, purpose,
    base_delivery_plan_id, base_delivery_plan_revision
  ) VALUES (NEW.id, NEW.project_id, 'intent', NULL, NULL);
END;

CREATE TABLE delivery_plan_proposals (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  planning_cycle_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  project_intent_id TEXT NOT NULL,
  project_intent_revision INTEGER NOT NULL CHECK (project_intent_revision > 0),
  ledger_id TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision > 0),
  base_delivery_plan_id TEXT,
  base_delivery_plan_revision INTEGER CHECK (base_delivery_plan_revision > 0),
  created_by_turn_id TEXT NOT NULL,
  created_by_execution_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (planning_cycle_id, revision),
  UNIQUE (id, project_id),
  UNIQUE (id, project_id, revision),
  UNIQUE (id, planning_cycle_id, revision),
  FOREIGN KEY (planning_cycle_id, project_id)
    REFERENCES planning_cycles(id, project_id),
  FOREIGN KEY (created_by_turn_id, planning_cycle_id, project_id)
    REFERENCES planning_turns(id, planning_cycle_id, project_id),
  FOREIGN KEY (created_by_execution_id, project_id)
    REFERENCES worker_executions(id, project_id),
  FOREIGN KEY (project_intent_id, project_intent_revision, project_id)
    REFERENCES project_intent_revisions(id, revision, project_id),
  FOREIGN KEY (ledger_id, ledger_revision, project_id)
    REFERENCES ledger_revisions(id, revision, project_id),
  FOREIGN KEY (
    base_delivery_plan_id, base_delivery_plan_revision, project_id
  ) REFERENCES delivery_plan_revisions(
    delivery_plan_id, revision, project_id
  ),
  CHECK (
    (base_delivery_plan_id IS NULL) = (base_delivery_plan_revision IS NULL)
  )
);

CREATE TABLE delivery_plan_proposal_decisions (
  proposal_id TEXT PRIMARY KEY REFERENCES delivery_plan_proposals(id),
  planning_cycle_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('superseded', 'approved', 'rejected')),
  reason TEXT CHECK (reason IN ('replacement_accepted', 'cycle_abandoned')),
  successor_proposal_id TEXT,
  decided_by TEXT CHECK (decided_by IS NULL OR decided_by = 'human'),
  feedback TEXT CHECK (feedback IS NULL OR length(feedback) > 0),
  decided_at TEXT NOT NULL CHECK (length(decided_at) > 0),
  UNIQUE (proposal_id, project_id),
  FOREIGN KEY (proposal_id, planning_cycle_id, proposal_revision)
    REFERENCES delivery_plan_proposals(id, planning_cycle_id, revision),
  FOREIGN KEY (successor_proposal_id, project_id)
    REFERENCES delivery_plan_proposals(id, project_id),
  CHECK (
    (kind = 'superseded' AND reason = 'replacement_accepted'
      AND successor_proposal_id IS NOT NULL AND decided_by IS NULL
      AND feedback IS NULL)
    OR (kind = 'superseded' AND reason = 'cycle_abandoned'
      AND successor_proposal_id IS NULL AND decided_by IS NULL
      AND feedback IS NULL)
    OR (kind = 'approved' AND reason IS NULL
      AND successor_proposal_id IS NULL AND decided_by = 'human'
      AND feedback IS NULL)
    OR (kind = 'rejected' AND reason IS NULL
      AND successor_proposal_id IS NULL AND decided_by = 'human'
      AND feedback IS NOT NULL)
  )
);

CREATE TABLE delivery_plan_proposal_milestone_reservations (
  proposal_id TEXT NOT NULL REFERENCES delivery_plan_proposals(id),
  proposal_key TEXT NOT NULL CHECK (length(proposal_key) > 0),
  milestone_id TEXT NOT NULL CHECK (length(milestone_id) > 0),
  PRIMARY KEY (proposal_id, proposal_key),
  UNIQUE (proposal_id, milestone_id),
  UNIQUE (proposal_id, proposal_key, milestone_id)
);

CREATE TABLE delivery_plan_proposal_task_reservations (
  proposal_id TEXT NOT NULL REFERENCES delivery_plan_proposals(id),
  proposal_key TEXT NOT NULL CHECK (length(proposal_key) > 0),
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  PRIMARY KEY (proposal_id, proposal_key),
  UNIQUE (proposal_id, task_id),
  UNIQUE (proposal_id, proposal_key, task_id)
);

CREATE TABLE delivery_plan_proposal_dependency_reservations (
  proposal_id TEXT NOT NULL REFERENCES delivery_plan_proposals(id),
  proposal_key TEXT NOT NULL CHECK (length(proposal_key) > 0),
  dependency_id TEXT NOT NULL CHECK (length(dependency_id) > 0),
  PRIMARY KEY (proposal_id, proposal_key),
  UNIQUE (proposal_id, dependency_id),
  UNIQUE (proposal_id, proposal_key, dependency_id)
);

CREATE TABLE delivery_plan_proposal_milestones (
  proposal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  identity_key TEXT NOT NULL CHECK (length(identity_key) > 0),
  proposal_key TEXT CHECK (proposal_key IS NULL OR length(proposal_key) > 0),
  milestone_id TEXT NOT NULL CHECK (length(milestone_id) > 0),
  member_json TEXT NOT NULL CHECK (json_valid(member_json)),
  PRIMARY KEY (proposal_id, identity_key),
  UNIQUE (proposal_id, ordinal),
  UNIQUE (proposal_id, milestone_id),
  FOREIGN KEY (proposal_id, project_id, proposal_revision)
    REFERENCES delivery_plan_proposals(id, project_id, revision),
  CHECK ((proposal_key IS NULL) = (identity_key NOT LIKE 'proposal:%'))
);

CREATE TABLE delivery_plan_proposal_tasks (
  proposal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  identity_key TEXT NOT NULL CHECK (length(identity_key) > 0),
  proposal_key TEXT CHECK (proposal_key IS NULL OR length(proposal_key) > 0),
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  milestone_identity_key TEXT CHECK (
    milestone_identity_key IS NULL OR length(milestone_identity_key) > 0
  ),
  member_json TEXT NOT NULL CHECK (json_valid(member_json)),
  PRIMARY KEY (proposal_id, identity_key),
  UNIQUE (proposal_id, ordinal),
  UNIQUE (proposal_id, task_id),
  FOREIGN KEY (proposal_id, project_id, proposal_revision)
    REFERENCES delivery_plan_proposals(id, project_id, revision),
  FOREIGN KEY (proposal_id, milestone_identity_key)
    REFERENCES delivery_plan_proposal_milestones(proposal_id, identity_key),
  CHECK ((proposal_key IS NULL) = (identity_key NOT LIKE 'proposal:%'))
);

CREATE TABLE delivery_plan_proposal_dependencies (
  proposal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  identity_key TEXT NOT NULL CHECK (length(identity_key) > 0),
  proposal_key TEXT CHECK (proposal_key IS NULL OR length(proposal_key) > 0),
  dependency_id TEXT NOT NULL CHECK (length(dependency_id) > 0),
  prerequisite_task_identity_key TEXT CHECK (
    prerequisite_task_identity_key IS NULL OR length(prerequisite_task_identity_key) > 0
  ),
  dependent_task_identity_key TEXT CHECK (
    dependent_task_identity_key IS NULL OR length(dependent_task_identity_key) > 0
  ),
  member_json TEXT NOT NULL CHECK (json_valid(member_json)),
  PRIMARY KEY (proposal_id, identity_key),
  UNIQUE (proposal_id, ordinal),
  UNIQUE (proposal_id, dependency_id),
  FOREIGN KEY (proposal_id, project_id, proposal_revision)
    REFERENCES delivery_plan_proposals(id, project_id, revision),
  FOREIGN KEY (proposal_id, prerequisite_task_identity_key)
    REFERENCES delivery_plan_proposal_tasks(proposal_id, identity_key),
  FOREIGN KEY (proposal_id, dependent_task_identity_key)
    REFERENCES delivery_plan_proposal_tasks(proposal_id, identity_key),
  CHECK (
    prerequisite_task_identity_key IS NULL
    OR prerequisite_task_identity_key <> dependent_task_identity_key
  ),
  CHECK ((proposal_key IS NULL) = (identity_key NOT LIKE 'proposal:%'))
);

CREATE TABLE delivery_plan_proposal_traces (
  proposal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN ('milestone_covers', 'task_satisfies')),
  milestone_identity_key TEXT,
  task_identity_key TEXT,
  record_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision > 0),
  trace_json TEXT NOT NULL CHECK (json_valid(trace_json)),
  PRIMARY KEY (proposal_id, ordinal),
  FOREIGN KEY (proposal_id, project_id, proposal_revision)
    REFERENCES delivery_plan_proposals(id, project_id, revision),
  FOREIGN KEY (proposal_id, milestone_identity_key)
    REFERENCES delivery_plan_proposal_milestones(proposal_id, identity_key),
  FOREIGN KEY (proposal_id, task_identity_key)
    REFERENCES delivery_plan_proposal_tasks(proposal_id, identity_key),
  FOREIGN KEY (record_id, record_revision, project_id)
    REFERENCES ledger_record_revisions(record_id, revision, project_id),
  CHECK (
    (kind = 'milestone_covers' AND milestone_identity_key IS NOT NULL
      AND task_identity_key IS NULL)
    OR (kind = 'task_satisfies' AND task_identity_key IS NOT NULL
      AND milestone_identity_key IS NULL)
  )
);

CREATE TABLE delivery_plans (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  created_proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (id, project_id),
  FOREIGN KEY (created_proposal_id, project_id)
    REFERENCES delivery_plan_proposals(id, project_id)
);

CREATE TABLE delivery_plan_revisions (
  delivery_plan_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  project_intent_id TEXT NOT NULL,
  project_intent_revision INTEGER NOT NULL CHECK (project_intent_revision > 0),
  ledger_id TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision > 0),
  base_delivery_plan_revision INTEGER CHECK (base_delivery_plan_revision > 0),
  proposal_id TEXT NOT NULL UNIQUE,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  approved_by TEXT NOT NULL CHECK (approved_by = 'human'),
  approved_at TEXT NOT NULL CHECK (length(approved_at) > 0),
  PRIMARY KEY (delivery_plan_id, revision),
  UNIQUE (project_id, revision),
  UNIQUE (delivery_plan_id, revision, project_id),
  FOREIGN KEY (delivery_plan_id, project_id)
    REFERENCES delivery_plans(id, project_id),
  FOREIGN KEY (proposal_id, project_id)
    REFERENCES delivery_plan_proposals(id, project_id),
  FOREIGN KEY (project_intent_id, project_intent_revision, project_id)
    REFERENCES project_intent_revisions(id, revision, project_id),
  FOREIGN KEY (ledger_id, ledger_revision, project_id)
    REFERENCES ledger_revisions(id, revision, project_id),
  CHECK (
    (revision = 1 AND base_delivery_plan_revision IS NULL)
    OR (revision > 1 AND base_delivery_plan_revision = revision - 1)
  )
);

INSERT INTO planning_cycle_purposes (
  planning_cycle_id, project_id, purpose,
  base_delivery_plan_id, base_delivery_plan_revision
)
SELECT id, project_id, 'intent', NULL, NULL FROM planning_cycles;

CREATE TABLE milestones (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (id, project_id),
  FOREIGN KEY (created_proposal_id, project_id)
    REFERENCES delivery_plan_proposals(id, project_id)
);

CREATE TABLE milestone_revisions (
  milestone_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retired')),
  revision_json TEXT NOT NULL CHECK (json_valid(revision_json)),
  proposal_id TEXT NOT NULL,
  delivery_plan_revision INTEGER NOT NULL CHECK (delivery_plan_revision > 0),
  approved_at TEXT NOT NULL CHECK (length(approved_at) > 0),
  PRIMARY KEY (milestone_id, revision),
  UNIQUE (milestone_id, revision, project_id),
  FOREIGN KEY (milestone_id, project_id) REFERENCES milestones(id, project_id),
  FOREIGN KEY (proposal_id, project_id)
    REFERENCES delivery_plan_proposals(id, project_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (id, project_id),
  FOREIGN KEY (created_proposal_id, project_id)
    REFERENCES delivery_plan_proposals(id, project_id)
);

CREATE TABLE task_revisions (
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
  revision_kind TEXT NOT NULL CHECK (
    revision_kind IN ('plan_contract', 'operational_lifecycle')
  ),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('pending', 'completed', 'retired')),
  milestone_id TEXT NOT NULL,
  revision_json TEXT NOT NULL CHECK (json_valid(revision_json)),
  PRIMARY KEY (task_id, revision),
  UNIQUE (task_id, revision, project_id),
  UNIQUE (task_id, contract_revision, revision),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id),
  FOREIGN KEY (milestone_id, project_id) REFERENCES milestones(id, project_id),
  FOREIGN KEY (task_id, contract_revision)
    REFERENCES task_revisions(task_id, revision),
  CHECK (
    (revision_kind = 'plan_contract' AND contract_revision = revision
      AND lifecycle IN ('pending', 'retired'))
    OR (revision_kind = 'operational_lifecycle'
      AND contract_revision < revision AND lifecycle IN ('pending', 'completed'))
  )
);

CREATE TABLE task_dependencies (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  prerequisite_task_id TEXT NOT NULL,
  dependent_task_id TEXT NOT NULL,
  created_proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (id, project_id),
  UNIQUE (project_id, prerequisite_task_id, dependent_task_id),
  FOREIGN KEY (prerequisite_task_id, project_id) REFERENCES tasks(id, project_id),
  FOREIGN KEY (dependent_task_id, project_id) REFERENCES tasks(id, project_id),
  FOREIGN KEY (created_proposal_id, project_id)
    REFERENCES delivery_plan_proposals(id, project_id),
  CHECK (prerequisite_task_id <> dependent_task_id)
);

CREATE TABLE task_dependency_revisions (
  dependency_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retired')),
  revision_json TEXT NOT NULL CHECK (json_valid(revision_json)),
  proposal_id TEXT NOT NULL,
  delivery_plan_revision INTEGER NOT NULL CHECK (delivery_plan_revision > 0),
  approved_at TEXT NOT NULL CHECK (length(approved_at) > 0),
  PRIMARY KEY (dependency_id, revision),
  UNIQUE (dependency_id, revision, project_id),
  FOREIGN KEY (dependency_id, project_id)
    REFERENCES task_dependencies(id, project_id),
  FOREIGN KEY (proposal_id, project_id)
    REFERENCES delivery_plan_proposals(id, project_id)
);

CREATE TABLE delivery_plan_revision_milestones (
  delivery_plan_id TEXT NOT NULL,
  delivery_plan_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  milestone_revision INTEGER NOT NULL CHECK (milestone_revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (delivery_plan_id, delivery_plan_revision, milestone_id),
  UNIQUE (delivery_plan_id, delivery_plan_revision, ordinal),
  FOREIGN KEY (delivery_plan_id, delivery_plan_revision, project_id)
    REFERENCES delivery_plan_revisions(delivery_plan_id, revision, project_id),
  FOREIGN KEY (milestone_id, milestone_revision, project_id)
    REFERENCES milestone_revisions(milestone_id, revision, project_id)
);

CREATE TABLE delivery_plan_revision_tasks (
  delivery_plan_id TEXT NOT NULL,
  delivery_plan_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_contract_revision INTEGER NOT NULL CHECK (task_contract_revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (delivery_plan_id, delivery_plan_revision, task_id),
  UNIQUE (delivery_plan_id, delivery_plan_revision, ordinal),
  FOREIGN KEY (delivery_plan_id, delivery_plan_revision, project_id)
    REFERENCES delivery_plan_revisions(delivery_plan_id, revision, project_id),
  FOREIGN KEY (task_id, task_contract_revision, project_id)
    REFERENCES task_revisions(task_id, revision, project_id)
);

CREATE TABLE delivery_plan_revision_dependencies (
  delivery_plan_id TEXT NOT NULL,
  delivery_plan_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  dependency_revision INTEGER NOT NULL CHECK (dependency_revision > 0),
  PRIMARY KEY (delivery_plan_id, delivery_plan_revision, dependency_id),
  FOREIGN KEY (delivery_plan_id, delivery_plan_revision, project_id)
    REFERENCES delivery_plan_revisions(delivery_plan_id, revision, project_id),
  FOREIGN KEY (dependency_id, dependency_revision, project_id)
    REFERENCES task_dependency_revisions(dependency_id, revision, project_id)
);

CREATE TABLE delivery_plan_revision_traces (
  delivery_plan_id TEXT NOT NULL,
  delivery_plan_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN ('milestone_covers', 'task_satisfies')),
  milestone_id TEXT,
  milestone_revision INTEGER,
  task_id TEXT,
  task_contract_revision INTEGER,
  record_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision > 0),
  PRIMARY KEY (delivery_plan_id, delivery_plan_revision, ordinal),
  UNIQUE (
    delivery_plan_id, delivery_plan_revision, kind,
    milestone_id, milestone_revision, task_id, task_contract_revision,
    record_id, record_revision
  ),
  FOREIGN KEY (delivery_plan_id, delivery_plan_revision, project_id)
    REFERENCES delivery_plan_revisions(delivery_plan_id, revision, project_id),
  FOREIGN KEY (record_id, record_revision, project_id)
    REFERENCES ledger_record_revisions(record_id, revision, project_id),
  FOREIGN KEY (milestone_id, milestone_revision, project_id)
    REFERENCES milestone_revisions(milestone_id, revision, project_id),
  FOREIGN KEY (task_id, task_contract_revision, project_id)
    REFERENCES task_revisions(task_id, revision, project_id),
  CHECK (
    (kind = 'milestone_covers' AND milestone_id IS NOT NULL
      AND milestone_revision IS NOT NULL AND task_id IS NULL
      AND task_contract_revision IS NULL)
    OR (kind = 'task_satisfies' AND task_id IS NOT NULL
      AND task_contract_revision IS NOT NULL AND milestone_id IS NULL
      AND milestone_revision IS NULL)
  )
);

CREATE UNIQUE INDEX delivery_plan_revision_milestone_trace_unique
ON delivery_plan_revision_traces (
  delivery_plan_id, delivery_plan_revision,
  milestone_id, milestone_revision, record_id, record_revision
)
WHERE kind = 'milestone_covers';

CREATE UNIQUE INDEX delivery_plan_revision_task_trace_unique
ON delivery_plan_revision_traces (
  delivery_plan_id, delivery_plan_revision,
  task_id, task_contract_revision, record_id, record_revision
)
WHERE kind = 'task_satisfies';

CREATE TABLE board_filters (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  filter_json TEXT NOT NULL CHECK (json_valid(filter_json)),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
);
