import {
  idSchema,
  isoTimestampSchema,
  projectPlanBaseSchema,
  projectPlanFeedbackSchema,
  projectPlanProposalInputSchema,
  projectPlanProposalSchema,
  projectPlanSchema,
  projectPlanSummarySchema,
  type ProjectPlan,
  type ProjectPlanAttention,
  type ProjectPlanBase,
  type ProjectPlanFeedback,
  type ProjectPlanProposal,
  type ProjectPlanStatus,
  type ProjectPlanSummary,
} from '@mesh-session-platform/contracts';
import type { z } from 'zod';

import type { Database } from '../db/database.js';

type PlanRow = {
  id: string;
  project_id: string;
  goal: string;
  constraints_json: string;
  non_goals_json: string;
  policy_version: string;
  status: string;
  revision: number;
  current_base_id: string;
  current_session_id: string | null;
  latest_proposal_ordinal: number;
  attention_json: string | null;
  created_by_json: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  terminal_by_json: string | null;
  terminal_reason: string | null;
};

type BaseRow = {
  id: string;
  plan_id: string;
  ordinal: number;
  repository_identity: string;
  tasks_json: string;
  dependencies_json: string;
  project_archived_at: string | null;
  project_revision: number;
  policy_revision: number;
  created_at: string;
};

type ProposalRow = {
  id: string;
  plan_id: string;
  base_id: string;
  ordinal: number;
  plan_revision: number;
  capability_generation: number;
  session_id: string;
  assumptions_json: string;
  risks_json: string;
  exclusions_json: string;
  submitted_at: string;
};

type ProposalTaskRow = {
  task_key: string;
  ordinal: number;
  title: string;
  description: string;
  acceptance_criteria_json: string;
  priority: string;
  labels_json: string;
  rationale: string;
  goal_mapping: string;
};

type ProposalDependencyRow = {
  ordinal: number;
  dependent_task_key: string;
  prerequisite_type: 'proposal_task' | 'existing_task';
  prerequisite_task_key: string | null;
  prerequisite_task_id: string | null;
};

type FeedbackRow = {
  id: string;
  plan_id: string;
  proposal_id: string | null;
  content: string;
  actor_json: string;
  created_at: string;
};

export type CreatePlanningCycleInput = {
  plan: ProjectPlan;
  base: ProjectPlanBase;
  sessionId: string;
};

export type CreatePlanBaseInput = Omit<
  z.input<typeof projectPlanBaseSchema>,
  'planId' | 'ordinal'
>;

export type AppendPlanProposalInput =
  z.input<typeof projectPlanProposalInputSchema> & {
  id: string;
  planId: string;
  expectedRevision: number;
  baseId: string;
  sessionId: string;
  submittedAt: string;
  };

export type AppendPlanFeedbackInput = Omit<
  z.input<typeof projectPlanFeedbackSchema>,
  'planId'
> & {
  planId: string;
  expectedRevision: number;
};

export type ProjectPlanUpdate = {
  status: ProjectPlanStatus;
  attention: ProjectPlanAttention | null;
  updatedAt: string;
  terminalAt: string | null;
  terminalBy: ProjectPlan['createdBy'] | null;
  terminalReason: string | null;
};

export type PlanTaskMapping = {
  proposalTaskKey: string;
  taskId: string;
  createdAt: string;
};

export type PlanSessionAssociation = {
  sessionId: string;
  planId: string;
  projectId: string;
  capabilityGeneration: number;
  startedAt: string;
  endedAt: string | null;
};

const assertExpectedRevision = (value: number): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('Expected plan revision must be a positive integer');
  }
  return value;
};

const toBase = (row: BaseRow): ProjectPlanBase =>
  projectPlanBaseSchema.parse({
    id: row.id,
    planId: row.plan_id,
    ordinal: row.ordinal,
    repositoryIdentity: row.repository_identity,
    tasks: JSON.parse(row.tasks_json),
    dependencies: JSON.parse(row.dependencies_json),
    projectArchivedAt: row.project_archived_at,
    projectRevision: row.project_revision,
    policyRevision: row.policy_revision,
    createdAt: row.created_at,
  });

const toFeedback = (row: FeedbackRow): ProjectPlanFeedback =>
  projectPlanFeedbackSchema.parse({
    id: row.id,
    planId: row.plan_id,
    proposalId: row.proposal_id,
    content: row.content,
    actor: JSON.parse(row.actor_json),
    createdAt: row.created_at,
  });

export class PlanningRepository {
  constructor(private readonly database: Database) {}

  create(input: CreatePlanningCycleInput): ProjectPlan {
    const value = projectPlanSchema.parse(input.plan);
    const initialBase = projectPlanBaseSchema.parse(input.base);
    const sessionId = idSchema.parse(input.sessionId);
    if (initialBase.planId !== value.id || initialBase.ordinal !== 1) {
      throw new TypeError('The initial base must be ordinal one for its plan');
    }
    if (value.currentBaseId !== initialBase.id) {
      throw new TypeError('The initial base must be the plan current base');
    }
    if (value.currentSessionId !== sessionId) {
      throw new TypeError('The initial session must be the plan current session');
    }
    if (value.revision !== 1) {
      throw new TypeError('A planning cycle must begin at revision one');
    }
    if (value.latestProposalOrdinal !== 0) {
      throw new TypeError('A planning cycle cannot have an initial proposal');
    }
    if (value.feedback.length !== 0) {
      throw new TypeError('A planning cycle cannot have initial feedback');
    }

    this.database.prepare(`
      INSERT INTO project_plans (
        id, project_id, goal, constraints_json, non_goals_json, policy_version,
        status, revision, current_base_id, current_session_id,
        latest_proposal_ordinal, attention_json, created_by_json, created_at,
        updated_at, terminal_at, terminal_by_json, terminal_reason
      ) VALUES (
        @id, @projectId, @goal, @constraintsJson, @nonGoalsJson, @policyVersion,
        @status, @revision, @currentBaseId, @currentSessionId,
        @latestProposalOrdinal, @attentionJson, @createdByJson, @createdAt,
        @updatedAt, @terminalAt, @terminalByJson, @terminalReason
      )
    `).run(this.planParameters(value));
    this.insertBase(initialBase);
    this.database.prepare(`
      INSERT INTO project_plan_sessions (
        session_id, plan_id, project_id, capability_generation, started_at, ended_at
      ) VALUES (?, ?, ?, 1, ?, NULL)
    `).run(sessionId, value.id, value.projectId, value.createdAt);
    return value;
  }

  get(planId: string): ProjectPlan | undefined {
    const row = this.selectPlan(planId);
    return row ? this.toPlan(row) : undefined;
  }

  getActiveByProject(projectId: string): ProjectPlan | undefined {
    const row = this.database.prepare(`
      SELECT * FROM project_plans
      WHERE project_id = ?
        AND status IN ('planning', 'awaiting_review', 'revising', 'attention_required')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(idSchema.parse(projectId)) as PlanRow | undefined;
    return row ? this.toPlan(row) : undefined;
  }

  listSummaries(
    projectId: string,
    options: { before?: string; limit: number },
  ): ProjectPlanSummary[] {
    const limit = options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new TypeError('Plan summary limit must be an integer from 1 to 20');
    }
    const id = idSchema.parse(projectId);
    const before = options.before ? idSchema.parse(options.before) : null;
    const rows = this.database.prepare(`
      SELECT id, project_id, goal, status, revision, latest_proposal_ordinal,
             created_at, updated_at, terminal_at
      FROM project_plans
      WHERE project_id = @projectId
        AND status IN ('approved', 'rejected', 'cancelled')
        AND (
          @before IS NULL OR (terminal_at, id) < (
            SELECT terminal_at, id FROM project_plans
            WHERE id = @before AND project_id = @projectId
          )
        )
      ORDER BY terminal_at DESC, id DESC
      LIMIT @limit
    `).all({ projectId: id, before, limit }) as Array<Pick<PlanRow,
      | 'id'
      | 'project_id'
      | 'goal'
      | 'status'
      | 'revision'
      | 'latest_proposal_ordinal'
      | 'created_at'
      | 'updated_at'
      | 'terminal_at'
    >>;
    return rows.map((row) =>
      projectPlanSummarySchema.parse({
        id: row.id,
        projectId: row.project_id,
        goal: row.goal,
        status: row.status,
        revision: row.revision,
        latestProposalOrdinal: row.latest_proposal_ordinal,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        terminalAt: row.terminal_at,
      }),
    );
  }

  getDetails(planId: string) {
    const row = this.selectPlan(planId);
    if (!row) return undefined;
    const feedback = this.listFeedback(row.id);
    return {
      plan: this.toPlan(row, feedback),
      bases: (this.database.prepare(
        'SELECT * FROM project_plan_bases WHERE plan_id = ? ORDER BY ordinal, id',
      ).all(row.id) as BaseRow[]).map(toBase),
      proposals: (this.database.prepare(
        'SELECT * FROM project_plan_proposals WHERE plan_id = ? ORDER BY ordinal, id',
      ).all(row.id) as ProposalRow[]).map((proposal) => this.toProposal(proposal)),
      feedback,
    };
  }

  appendBase(
    planId: string,
    expectedRevision: number,
    input: CreatePlanBaseInput,
  ): ProjectPlanBase {
    const id = idSchema.parse(planId);
    const revision = assertExpectedRevision(expectedRevision);
    const current = this.selectPlan(id);
    if (!current) throw new Error('Plan was not found');
    const ordinal = this.nextOrdinal('project_plan_bases', id);
    const base = projectPlanBaseSchema.parse({ ...input, planId: id, ordinal });
    const updated = this.database.prepare(`
      UPDATE project_plans
      SET current_base_id = @baseId, revision = revision + 1, updated_at = @updatedAt
      WHERE id = @planId AND revision = @expectedRevision
    `).run({
      baseId: base.id,
      updatedAt: base.createdAt,
      planId: id,
      expectedRevision: revision,
    });
    if (updated.changes !== 1) throw new Error('Plan revision conflict');
    this.insertBase(base);
    return base;
  }

  appendSession(
    planId: string,
    expectedRevision: number,
    sessionId: string,
    startedAt = new Date().toISOString(),
  ): ProjectPlan {
    const id = idSchema.parse(planId);
    const revision = assertExpectedRevision(expectedRevision);
    const parsedSessionId = idSchema.parse(sessionId);
    const current = this.selectPlan(id);
    if (!current) throw new Error('Plan was not found');
    const updatedAt = isoTimestampSchema.parse(startedAt);
    const next = projectPlanSchema.parse({
      ...this.toPlan(current),
      currentSessionId: parsedSessionId,
      revision: revision + 1,
      updatedAt,
    });
    const updated = this.database.prepare(`
      UPDATE project_plans
      SET current_session_id = @sessionId, revision = revision + 1, updated_at = @updatedAt
      WHERE id = @planId AND revision = @expectedRevision
    `).run({
      sessionId: parsedSessionId,
      updatedAt,
      planId: id,
      expectedRevision: revision,
    });
    if (updated.changes !== 1) throw new Error('Plan revision conflict');
    this.database.prepare(`
      UPDATE project_plan_sessions
      SET ended_at = ?
      WHERE plan_id = ? AND ended_at IS NULL
    `).run(updatedAt, id);
    this.database.prepare(`
      INSERT INTO project_plan_sessions (
        session_id, plan_id, project_id, capability_generation, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, NULL)
    `).run(
      parsedSessionId,
      id,
      current.project_id,
      this.nextCapabilityGeneration(id),
      updatedAt,
    );
    return next;
  }

  getSessionAssociation(
    planId: string,
    sessionId: string,
  ): PlanSessionAssociation | undefined {
    const row = this.database.prepare(`
      SELECT session_id, plan_id, project_id, capability_generation,
             started_at, ended_at
      FROM project_plan_sessions
      WHERE plan_id = ? AND session_id = ?
    `).get(idSchema.parse(planId), idSchema.parse(sessionId)) as
      | {
          session_id: string;
          plan_id: string;
          project_id: string;
          capability_generation: number;
          started_at: string;
          ended_at: string | null;
        }
      | undefined;
    return row
      ? {
          sessionId: row.session_id,
          planId: row.plan_id,
          projectId: row.project_id,
          capabilityGeneration: row.capability_generation,
          startedAt: row.started_at,
          endedAt: row.ended_at,
        }
      : undefined;
  }

  advanceSessionGeneration(
    planId: string,
    sessionId: string,
    startedAt: string,
  ): PlanSessionAssociation {
    const id = idSchema.parse(planId);
    const parsedSessionId = idSchema.parse(sessionId);
    const occurredAt = isoTimestampSchema.parse(startedAt);
    const plan = this.selectPlan(id);
    if (!plan || plan.current_session_id !== parsedSessionId) {
      throw new Error('Plan session is not current');
    }
    const generation = this.nextCapabilityGeneration(id);
    const updated = this.database.prepare(`
      UPDATE project_plan_sessions
      SET capability_generation = ?, started_at = ?, ended_at = NULL
      WHERE plan_id = ? AND session_id = ? AND ended_at IS NULL
    `).run(generation, occurredAt, id, parsedSessionId);
    if (updated.changes !== 1) throw new Error('Plan session is not active');
    const association = this.getSessionAssociation(id, parsedSessionId);
    if (!association) throw new Error('Plan session update disappeared');
    return association;
  }

  appendProposal(input: AppendPlanProposalInput): ProjectPlanProposal {
    const planId = idSchema.parse(input.planId);
    const expectedRevision = assertExpectedRevision(input.expectedRevision);
    const current = this.selectPlan(planId);
    if (!current) throw new Error('Plan was not found');
    const ordinal = this.nextOrdinal('project_plan_proposals', planId);
    const capability = this.database.prepare(`
      SELECT capability_generation FROM project_plan_sessions
      WHERE plan_id = ? AND session_id = ?
    `).get(planId, idSchema.parse(input.sessionId)) as
      | { capability_generation: number }
      | undefined;
    if (!capability) throw new Error('Plan session was not found');
    const proposal = projectPlanProposalSchema.parse({
      ...input,
      ordinal,
      planRevision: expectedRevision + 1,
      capabilityGeneration: capability.capability_generation,
    });
    const updated = this.database.prepare(`
      UPDATE project_plans
      SET latest_proposal_ordinal = @ordinal, revision = revision + 1, updated_at = @updatedAt
      WHERE id = @planId AND revision = @expectedRevision
    `).run({
      ordinal,
      updatedAt: proposal.submittedAt,
      planId,
      expectedRevision,
    });
    if (updated.changes !== 1) throw new Error('Plan revision conflict');
    this.database.prepare(`
      INSERT INTO project_plan_proposals (
        id, plan_id, base_id, project_id, ordinal, plan_revision,
        capability_generation, session_id, assumptions_json, risks_json,
        exclusions_json, submitted_at
      ) VALUES (
        @id, @planId, @baseId, @projectId, @ordinal, @planRevision,
        @capabilityGeneration, @sessionId, @assumptionsJson, @risksJson,
        @exclusionsJson, @submittedAt
      )
    `).run({
      ...proposal,
      projectId: current.project_id,
      assumptionsJson: JSON.stringify(proposal.assumptions),
      risksJson: JSON.stringify(proposal.risks),
      exclusionsJson: JSON.stringify(proposal.exclusions),
    });
    const insertTask = this.database.prepare(`
      INSERT INTO project_plan_proposal_tasks (
        proposal_id, task_key, ordinal, title, description,
        acceptance_criteria_json, priority, labels_json, rationale, goal_mapping
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [taskOrdinal, task] of proposal.tasks.entries()) {
      insertTask.run(
        proposal.id,
        task.key,
        taskOrdinal,
        task.title,
        task.description,
        JSON.stringify(task.acceptanceCriteria),
        task.priority,
        JSON.stringify(task.labels),
        task.rationale,
        task.goalMapping,
      );
    }
    const insertDependency = this.database.prepare(`
      INSERT INTO project_plan_proposal_dependencies (
        proposal_id, project_id, ordinal, dependent_task_key, prerequisite_type,
        prerequisite_task_key, prerequisite_task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [dependencyOrdinal, dependency] of proposal.dependencies.entries()) {
      insertDependency.run(
        proposal.id,
        current.project_id,
        dependencyOrdinal,
        dependency.dependentTaskKey,
        dependency.prerequisite.type,
        dependency.prerequisite.type === 'proposal_task'
          ? dependency.prerequisite.taskKey
          : null,
        dependency.prerequisite.type === 'existing_task'
          ? dependency.prerequisite.taskId
          : null,
      );
    }
    return proposal;
  }

  appendFeedback(input: AppendPlanFeedbackInput): ProjectPlanFeedback {
    const expectedRevision = assertExpectedRevision(input.expectedRevision);
    const feedback = projectPlanFeedbackSchema.parse(input);
    const updated = this.database.prepare(`
      UPDATE project_plans
      SET revision = revision + 1, updated_at = @updatedAt
      WHERE id = @planId AND revision = @expectedRevision
    `).run({
      planId: feedback.planId,
      expectedRevision,
      updatedAt: feedback.createdAt,
    });
    if (updated.changes !== 1) throw new Error('Plan revision conflict');
    this.database.prepare(`
      INSERT INTO project_plan_feedback (
        id, plan_id, proposal_id, content, actor_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      feedback.id,
      feedback.planId,
      feedback.proposalId,
      feedback.content,
      JSON.stringify(feedback.actor),
      feedback.createdAt,
    );
    return feedback;
  }

  update(
    planId: string,
    expectedRevision: number,
    update: ProjectPlanUpdate,
  ): ProjectPlan | undefined {
    const id = idSchema.parse(planId);
    const revision = assertExpectedRevision(expectedRevision);
    const current = this.get(id);
    if (!current) return undefined;
    const next = projectPlanSchema.parse({
      ...current,
      ...update,
      revision: revision + 1,
    });
    const result = this.database.prepare(`
      UPDATE project_plans
      SET status = @status, revision = @revision, attention_json = @attentionJson,
          updated_at = @updatedAt, terminal_at = @terminalAt,
          terminal_by_json = @terminalByJson, terminal_reason = @terminalReason
      WHERE id = @id AND revision = @expectedRevision
    `).run({
      ...this.planParameters(next),
      expectedRevision: revision,
    });
    return result.changes === 1 ? next : undefined;
  }

  recordApprovalMappings(
    planId: string,
    proposalId: string,
    mappings: readonly PlanTaskMapping[],
  ): void {
    const plan = idSchema.parse(planId);
    const proposal = idSchema.parse(proposalId);
    const row = this.database.prepare(`
      SELECT project_id FROM project_plan_proposals
      WHERE id = ? AND plan_id = ?
    `).get(proposal, plan) as { project_id: string } | undefined;
    if (!row) throw new Error('Plan proposal was not found');
    const insert = this.database.prepare(`
      INSERT INTO project_plan_task_mappings (
        proposal_id, proposal_task_key, project_id, task_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const mapping of mappings) {
      insert.run(
        proposal,
        idSchema.parse(mapping.proposalTaskKey),
        row.project_id,
        idSchema.parse(mapping.taskId),
        isoTimestampSchema.parse(mapping.createdAt),
      );
    }
  }

  private selectPlan(planId: string): PlanRow | undefined {
    return this.database.prepare('SELECT * FROM project_plans WHERE id = ?').get(
      idSchema.parse(planId),
    ) as PlanRow | undefined;
  }

  private toPlan(row: PlanRow, feedback = this.listFeedback(row.id)): ProjectPlan {
    return projectPlanSchema.parse({
      id: row.id,
      projectId: row.project_id,
      goal: row.goal,
      constraints: JSON.parse(row.constraints_json),
      nonGoals: JSON.parse(row.non_goals_json),
      policyVersion: row.policy_version,
      status: row.status,
      revision: row.revision,
      currentBaseId: row.current_base_id,
      currentSessionId: row.current_session_id,
      latestProposalOrdinal: row.latest_proposal_ordinal,
      feedback,
      attention: row.attention_json ? JSON.parse(row.attention_json) : null,
      createdBy: JSON.parse(row.created_by_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
      terminalBy: row.terminal_by_json ? JSON.parse(row.terminal_by_json) : null,
      terminalReason: row.terminal_reason,
    });
  }

  private toProposal(row: ProposalRow): ProjectPlanProposal {
    const tasks = (this.database.prepare(`
      SELECT * FROM project_plan_proposal_tasks
      WHERE proposal_id = ? ORDER BY ordinal, task_key
    `).all(row.id) as ProposalTaskRow[]).map((task) => ({
      key: task.task_key,
      title: task.title,
      description: task.description,
      acceptanceCriteria: JSON.parse(task.acceptance_criteria_json),
      priority: task.priority,
      labels: JSON.parse(task.labels_json),
      rationale: task.rationale,
      goalMapping: task.goal_mapping,
    }));
    const dependencies = (this.database.prepare(`
      SELECT * FROM project_plan_proposal_dependencies
      WHERE proposal_id = ? ORDER BY ordinal, dependent_task_key
    `).all(row.id) as ProposalDependencyRow[]).map((dependency) => ({
      dependentTaskKey: dependency.dependent_task_key,
      prerequisite:
        dependency.prerequisite_type === 'proposal_task'
          ? { type: 'proposal_task' as const, taskKey: dependency.prerequisite_task_key }
          : { type: 'existing_task' as const, taskId: dependency.prerequisite_task_id },
    }));
    return projectPlanProposalSchema.parse({
      id: row.id,
      planId: row.plan_id,
      baseId: row.base_id,
      ordinal: row.ordinal,
      planRevision: row.plan_revision,
      capabilityGeneration: row.capability_generation,
      sessionId: row.session_id,
      tasks,
      dependencies,
      assumptions: JSON.parse(row.assumptions_json),
      risks: JSON.parse(row.risks_json),
      exclusions: JSON.parse(row.exclusions_json),
      submittedAt: row.submitted_at,
    });
  }

  private listFeedback(planId: string): ProjectPlanFeedback[] {
    return (this.database.prepare(`
      SELECT * FROM project_plan_feedback
      WHERE plan_id = ? ORDER BY created_at, id
    `).all(planId) as FeedbackRow[]).map(toFeedback);
  }

  private nextOrdinal(table: 'project_plan_bases' | 'project_plan_proposals', planId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM ${table} WHERE plan_id = ?
    `).get(planId) as { ordinal: number };
    return row.ordinal;
  }

  private nextCapabilityGeneration(planId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(capability_generation), 0) + 1 AS generation
      FROM project_plan_sessions WHERE plan_id = ?
    `).get(planId) as { generation: number };
    return row.generation;
  }

  private insertBase(base: ProjectPlanBase): void {
    this.database.prepare(`
      INSERT INTO project_plan_bases (
        id, plan_id, ordinal, repository_identity, tasks_json, dependencies_json,
        project_archived_at, project_revision, policy_revision, created_at
      ) VALUES (
        @id, @planId, @ordinal, @repositoryIdentity, @tasksJson, @dependenciesJson,
        @projectArchivedAt, @projectRevision, @policyRevision, @createdAt
      )
    `).run({
      ...base,
      tasksJson: JSON.stringify(base.tasks),
      dependenciesJson: JSON.stringify(base.dependencies),
    });
  }

  private planParameters(plan: ProjectPlan) {
    return {
      ...plan,
      constraintsJson: JSON.stringify(plan.constraints),
      nonGoalsJson: JSON.stringify(plan.nonGoals),
      attentionJson: plan.attention ? JSON.stringify(plan.attention) : null,
      createdByJson: JSON.stringify(plan.createdBy),
      terminalByJson: plan.terminalBy ? JSON.stringify(plan.terminalBy) : null,
    };
  }
}
