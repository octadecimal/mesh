-- Forward path: this additive migration creates planning storage without
-- changing existing project, task, attempt, execution, run, or event rows.
-- Rollback compatibility: binaries through 016 ignore these new tables; a
-- physical down migration is intentionally unnecessary because no existing
-- table, column, or row is contracted or rewritten.

CREATE TABLE project_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
  non_goals_json TEXT NOT NULL CHECK (json_valid(non_goals_json)),
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'planning',
    'awaiting_review',
    'revising',
    'attention_required',
    'approved',
    'rejected',
    'cancelled'
  )),
  revision INTEGER NOT NULL CHECK (revision > 0),
  current_base_id TEXT NOT NULL,
  current_session_id TEXT,
  latest_proposal_ordinal INTEGER NOT NULL CHECK (latest_proposal_ordinal >= 0),
  attention_json TEXT CHECK (attention_json IS NULL OR json_valid(attention_json)),
  created_by_json TEXT NOT NULL CHECK (json_valid(created_by_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  terminal_by_json TEXT CHECK (terminal_by_json IS NULL OR json_valid(terminal_by_json)),
  terminal_reason TEXT
);

CREATE UNIQUE INDEX project_plans_one_nonterminal_per_project
ON project_plans(project_id)
WHERE status IN (
  'planning',
  'awaiting_review',
  'revising',
  'attention_required'
);

CREATE UNIQUE INDEX project_plans_id_project_id
ON project_plans(id, project_id);

CREATE UNIQUE INDEX sessions_id_project_id
ON sessions(id, project_id);

CREATE UNIQUE INDEX tasks_id_project_id
ON tasks(id, project_id);

CREATE TABLE project_plan_bases (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES project_plans(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  repository_identity TEXT NOT NULL,
  tasks_json TEXT NOT NULL CHECK (json_valid(tasks_json)),
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
  project_archived_at TEXT,
  project_revision INTEGER NOT NULL CHECK (project_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE(plan_id, ordinal)
);

CREATE UNIQUE INDEX project_plan_bases_id_plan_id
ON project_plan_bases(id, plan_id);

CREATE TABLE project_plan_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES project_plans(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capability_generation INTEGER NOT NULL CHECK (capability_generation > 0),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(session_id, plan_id),
  FOREIGN KEY (session_id, project_id)
    REFERENCES sessions(id, project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (plan_id, project_id)
    REFERENCES project_plans(id, project_id)
    ON DELETE CASCADE
);

CREATE TABLE project_plan_proposals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES project_plans(id) ON DELETE CASCADE,
  base_id TEXT NOT NULL REFERENCES project_plan_bases(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  capability_generation INTEGER NOT NULL CHECK (capability_generation > 0),
  session_id TEXT NOT NULL REFERENCES project_plan_sessions(session_id) ON DELETE RESTRICT,
  assumptions_json TEXT NOT NULL CHECK (json_valid(assumptions_json)),
  risks_json TEXT NOT NULL CHECK (json_valid(risks_json)),
  exclusions_json TEXT NOT NULL CHECK (json_valid(exclusions_json)),
  submitted_at TEXT NOT NULL,
  UNIQUE(plan_id, ordinal),
  UNIQUE(id, project_id),
  UNIQUE(id, plan_id),
  FOREIGN KEY (plan_id, project_id)
    REFERENCES project_plans(id, project_id)
    ON DELETE CASCADE,
  FOREIGN KEY (base_id, plan_id)
    REFERENCES project_plan_bases(id, plan_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (session_id, plan_id)
    REFERENCES project_plan_sessions(session_id, plan_id)
    ON DELETE RESTRICT
);

CREATE TABLE project_plan_proposal_tasks (
  proposal_id TEXT NOT NULL REFERENCES project_plan_proposals(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  labels_json TEXT NOT NULL CHECK (json_valid(labels_json)),
  rationale TEXT NOT NULL,
  goal_mapping TEXT NOT NULL,
  PRIMARY KEY (proposal_id, task_key),
  UNIQUE(proposal_id, ordinal)
);

CREATE TABLE project_plan_proposal_dependencies (
  proposal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  dependent_task_key TEXT NOT NULL,
  prerequisite_type TEXT NOT NULL CHECK (prerequisite_type IN ('proposal_task', 'existing_task')),
  prerequisite_task_key TEXT,
  prerequisite_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  PRIMARY KEY (proposal_id, ordinal),
  FOREIGN KEY (proposal_id, dependent_task_key)
    REFERENCES project_plan_proposal_tasks(proposal_id, task_key)
    ON DELETE CASCADE,
  FOREIGN KEY (proposal_id, prerequisite_task_key)
    REFERENCES project_plan_proposal_tasks(proposal_id, task_key)
    ON DELETE RESTRICT,
  FOREIGN KEY (proposal_id, project_id)
    REFERENCES project_plan_proposals(id, project_id)
    ON DELETE CASCADE,
  FOREIGN KEY (prerequisite_task_id, project_id)
    REFERENCES tasks(id, project_id)
    ON DELETE RESTRICT,
  CHECK (
    (prerequisite_type = 'proposal_task'
      AND prerequisite_task_key IS NOT NULL
      AND prerequisite_task_id IS NULL
      AND dependent_task_key <> prerequisite_task_key)
    OR
    (prerequisite_type = 'existing_task'
      AND prerequisite_task_key IS NULL
      AND prerequisite_task_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX project_plan_proposal_dependencies_local_pair
ON project_plan_proposal_dependencies(
  proposal_id,
  dependent_task_key,
  prerequisite_task_key
)
WHERE prerequisite_type = 'proposal_task';

CREATE UNIQUE INDEX project_plan_proposal_dependencies_existing_pair
ON project_plan_proposal_dependencies(
  proposal_id,
  dependent_task_key,
  prerequisite_task_id
)
WHERE prerequisite_type = 'existing_task';

CREATE TABLE project_plan_feedback (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES project_plans(id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES project_plan_proposals(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (proposal_id, plan_id)
    REFERENCES project_plan_proposals(id, plan_id)
    ON DELETE CASCADE
);

CREATE TABLE project_plan_task_mappings (
  proposal_id TEXT NOT NULL,
  proposal_task_key TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, proposal_task_key),
  FOREIGN KEY (proposal_id, proposal_task_key)
    REFERENCES project_plan_proposal_tasks(proposal_id, task_key)
    ON DELETE RESTRICT,
  FOREIGN KEY (proposal_id, project_id)
    REFERENCES project_plan_proposals(id, project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (task_id, project_id)
    REFERENCES tasks(id, project_id)
    ON DELETE RESTRICT
);

CREATE TABLE task_dependencies (
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  prerequisite_task_id TEXT NOT NULL REFERENCES tasks(id),
  created_by_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, prerequisite_task_id),
  FOREIGN KEY (task_id, project_id)
    REFERENCES tasks(id, project_id),
  FOREIGN KEY (prerequisite_task_id, project_id)
    REFERENCES tasks(id, project_id),
  CHECK (task_id <> prerequisite_task_id)
);

CREATE INDEX task_dependencies_project_task
ON task_dependencies(project_id, task_id, prerequisite_task_id);

CREATE TRIGGER project_plan_proposals_ordinal_immutable
BEFORE UPDATE OF ordinal ON project_plan_proposals
BEGIN
  SELECT RAISE(ABORT, 'project plan proposal ordinals are immutable');
END;

CREATE TRIGGER project_plan_proposal_tasks_key_immutable
BEFORE UPDATE OF task_key ON project_plan_proposal_tasks
BEGIN
  SELECT RAISE(ABORT, 'project plan proposal task keys are immutable');
END;
