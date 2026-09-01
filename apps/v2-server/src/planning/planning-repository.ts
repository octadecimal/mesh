import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  approvedDeliveryPlanMaterializationSchema,
  approvedDeliveryPlanSchema,
  approvedIntentLedgerSchema,
  boardViewSchema,
  boardFilterSchema,
  deliveryPlanProposalSchema,
  ledgerRecordIdSchema,
  ledgerRecordContentSchema,
  ledgerRecordRevisionSchema,
  ledgerRelationshipSchema,
  ledgerRevisionSchema,
  milestoneRevisionSchema,
  planningCycleSchema,
  planningCyclePurposeStateSchema,
  planningCycleViewSchema,
  planningProposalSchema,
  planningQuestionSchema,
  planningTurnSchema,
  projectSchema,
  projectIntentContentSchema,
  projectIntentRevisionSchema,
  taskRevisionSchema,
  taskDependencyRevisionSchema,
  type ApprovedDeliveryPlan,
  type ApprovedIntentLedger,
  type BoardFilter,
  type BoardTaskCard,
  type BoardView,
  type DeliveryPlanProposal,
  type LedgerRecordContent,
  type LedgerRecordRevision,
  type LedgerRelationship,
  type PlanningCycle,
  type PlanningCyclePurposeState,
  type PlanningCycleView,
  type PlanningProposal,
  type PlanningQuestion,
  type PlanningTurn,
  type PlanRequirementRef,
  type Project,
  type ProjectIntentRevision,
  type TaskRevision,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import { canonicalJson } from '../storage/canonical-json.js';
import { projectBoard } from './planning-board.js';

type CycleRow = {
  id: string;
  project_id: string;
  lifecycle: PlanningCycle['lifecycle'];
  revision: number;
  profile_id: string;
  profile_revision: number;
  base_project_intent_revision: number | null;
  base_ledger_revision: number | null;
  latest_proposal_revision: number;
  active_execution_id: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
};

type TurnRow = {
  id: string;
  project_id: string;
  planning_cycle_id: string;
  ordinal: number;
  actor: PlanningTurn['actor'];
  message: string;
  launch_state: PlanningTurn['launchState'];
  execution_id: string | null;
  created_at: string;
};

type QuestionRow = {
  id: string;
  project_id: string;
  planning_cycle_id: string;
  turn_id: string;
  key: string;
  prompt: string;
  rationale: string;
  choices_json: string | null;
};

type ProposalRow = {
  id: string;
  project_id: string;
  planning_cycle_id: string;
  revision: number;
  lifecycle: PlanningProposal['lifecycle'];
  base_project_intent_revision: number | null;
  base_ledger_revision: number | null;
  summary: string;
  project_intent_json: string;
  records_json: string;
  relationships_json: string;
  diff_json: string;
  created_by_turn_id: string;
  created_by_execution_id: string;
  rejection_feedback: string | null;
  created_at: string;
  decided_at: string | null;
};

type IntentRow = {
  id: string;
  project_id: string;
  revision: number;
  content_json: string;
  proposal_id: string;
  approved_by: 'human';
  approved_at: string;
};

type RecordRevisionRow = {
  record_id: string;
  project_id: string;
  revision: number;
  content_json: string;
  proposal_id: string;
  approved_by: 'human';
  approved_at: string;
};

type LedgerRow = {
  id: string;
  project_id: string;
  revision: number;
  proposal_id: string;
  approved_by: 'human';
  approved_at: string;
};

type ProvenanceRow = {
  turn_id: string;
  rationale: string;
};

type CyclePurposeRow = {
  planning_cycle_id: string;
  project_id: string;
  purpose: PlanningCyclePurposeState['purpose'];
  base_delivery_plan_id: string | null;
  base_delivery_plan_revision: number | null;
};

type DeliveryPlanProposalRow = {
  id: string;
  project_id: string;
  planning_cycle_id: string;
  revision: number;
  proposal_json: string;
  project_intent_id: string;
  project_intent_revision: number;
  ledger_id: string;
  ledger_revision: number;
  base_delivery_plan_id: string | null;
  base_delivery_plan_revision: number | null;
  created_by_turn_id: string;
  created_by_execution_id: string;
  created_at: string;
};

type ProposalDecisionRow = {
  proposal_id: string;
  planning_cycle_id: string;
  proposal_revision: number;
  project_id: string;
  kind: 'superseded' | 'approved' | 'rejected';
  reason: 'replacement_accepted' | 'cycle_abandoned' | null;
  successor_proposal_id: string | null;
  decided_by: 'human' | null;
  feedback: string | null;
  decided_at: string;
};

type DeliveryPlanRow = {
  delivery_plan_id: string;
  project_id: string;
  revision: number;
  project_intent_id: string;
  project_intent_revision: number;
  ledger_id: string;
  ledger_revision: number;
  base_delivery_plan_revision: number | null;
  proposal_id: string;
  plan_json: string;
  approved_by: 'human';
  approved_at: string;
};
type BoardFilterRow = {
  project_id: string;
  revision: number;
  filter_json: string;
  updated_at: string;
};
type TaskRevisionRow = {
  task_id: string;
  project_id: string;
  revision: number;
  contract_revision: number;
  revision_kind: TaskRevision['revisionKind'];
  lifecycle: TaskRevision['lifecycle'];
  milestone_id: string;
  revision_json: string;
};

type ProjectRow = {
  id: string;
  display_name: string;
  repository_identity: string;
  repository_path: string;
  git_common_directory: string;
  head_commit: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type PmOutputReceipt = Readonly<{
  executionId: string;
  projectId: string;
  planningCycleId: string;
  humanTurnId: string;
  runtimeEventId: string;
  outputDigest: string;
  status: 'accepted' | 'rejected';
  rejectionReason: string | null;
  createdAt: string;
}>;

const receiptSchema = z
  .strictObject({
    executionId: z.string().uuid(),
    projectId: z.string().uuid(),
    planningCycleId: z.string().uuid(),
    humanTurnId: z.string().uuid(),
    runtimeEventId: z.string().uuid(),
    outputDigest: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(['accepted', 'rejected']),
    rejectionReason: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    if ((value.status === 'rejected') !== (value.rejectionReason !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['rejectionReason'],
        message: 'Rejected receipts require one reason',
      });
    }
  });

const toCycle = (row: CycleRow): PlanningCycle =>
  planningCycleSchema.parse({
    id: row.id,
    projectId: row.project_id,
    lifecycle: row.lifecycle,
    revision: row.revision,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    baseProjectIntentRevision: row.base_project_intent_revision,
    baseLedgerRevision: row.base_ledger_revision,
    latestProposalRevision: row.latest_proposal_revision,
    activeExecutionId: row.active_execution_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  });

const toTurn = (row: TurnRow): PlanningTurn =>
  planningTurnSchema.parse({
    id: row.id,
    projectId: row.project_id,
    planningCycleId: row.planning_cycle_id,
    ordinal: row.ordinal,
    actor: row.actor,
    message: row.message,
    launchState: row.launch_state,
    executionId: row.execution_id,
    createdAt: row.created_at,
  });

const toQuestion = (row: QuestionRow): PlanningQuestion =>
  planningQuestionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    planningCycleId: row.planning_cycle_id,
    turnId: row.turn_id,
    key: row.key,
    prompt: row.prompt,
    rationale: row.rationale,
    ...(row.choices_json === null
      ? {}
      : { choices: JSON.parse(row.choices_json) }),
  });

const toProposal = (row: ProposalRow): PlanningProposal =>
  planningProposalSchema.parse({
    id: row.id,
    projectId: row.project_id,
    planningCycleId: row.planning_cycle_id,
    revision: row.revision,
    lifecycle: row.lifecycle,
    baseProjectIntentRevision: row.base_project_intent_revision,
    baseLedgerRevision: row.base_ledger_revision,
    summary: row.summary,
    projectIntent: JSON.parse(row.project_intent_json),
    records: JSON.parse(row.records_json),
    relationships: JSON.parse(row.relationships_json),
    diff: JSON.parse(row.diff_json),
    createdByTurnId: row.created_by_turn_id,
    createdByExecutionId: row.created_by_execution_id,
    rejectionFeedback: row.rejection_feedback,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  });

const withoutProvenance = <T extends { provenance: unknown }>(value: T) => {
  const { provenance: _provenance, ...content } = value;
  return content;
};

const approvedContent = (content: LedgerRecordContent): LedgerRecordContent =>
  content.type === 'requirement' && content.status === 'proposed'
    ? { ...content, status: 'approved' }
    : content;

export class PlanningProposalInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningProposalInvalidError';
  }
}

const assertUniqueProvenance = (
  provenance: readonly { turnId: string }[],
): void => {
  const turnIds = new Set<string>();
  for (const item of provenance) {
    if (turnIds.has(item.turnId)) {
      throw new PlanningProposalInvalidError(
        'Planning proposal contains duplicate provenance',
      );
    }
    turnIds.add(item.turnId);
  }
};

export type PlanningBoardSnapshot = Readonly<{
  planningCycles: readonly PlanningCycleView[];
  planningHistoryTruncated: boolean;
  intentLedger: ApprovedIntentLedger | null;
  deliveryPlan: ApprovedDeliveryPlan | null;
  board: ReturnType<typeof projectBoard>;
}>;

export type TaskExecutionAuthority = Readonly<{
  project: Project;
  deliveryPlan: ApprovedDeliveryPlan;
  intentRevision: number;
  ledgerRevision: number;
  task: TaskRevision;
  requirementRevisions: readonly PlanRequirementRef[];
  board: BoardView;
  card: BoardTaskCard;
}>;

export class PlanningRepository {
  constructor(private readonly database: V2Database) {}

  cycle(id: string): PlanningCycle | undefined {
    const row = this.database
      .prepare('SELECT * FROM planning_cycles WHERE id = ?')
      .get(id) as CycleRow | undefined;
    return row ? toCycle(row) : undefined;
  }

  turn(id: string): PlanningTurn | undefined {
    const row = this.database
      .prepare('SELECT * FROM planning_turns WHERE id = ?')
      .get(id) as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
  }

  activeCycle(projectId: string): PlanningCycle | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM planning_cycles
         WHERE project_id = ?
           AND lifecycle NOT IN ('approved', 'proposal_rejected', 'abandoned')`,
      )
      .get(projectId) as CycleRow | undefined;
    return row ? toCycle(row) : undefined;
  }

  private authenticateDeliveryPlanBase(
    projectId: string,
    deliveryPlanId: string,
    revision: number,
  ): void {
    const row = this.database
      .prepare(
        `SELECT r.*, p.project_id AS identity_project_id
         FROM delivery_plan_revisions r
         JOIN delivery_plans p ON p.id = r.delivery_plan_id
         WHERE r.delivery_plan_id = ? AND r.revision = ? AND r.project_id = ?`,
      )
      .get(deliveryPlanId, revision, projectId) as
      | (DeliveryPlanRow & { identity_project_id: string })
      | undefined;
    if (!row) throw new Error('Stored delivery plan base is corrupt');
    const stored = approvedDeliveryPlanSchema.parse(JSON.parse(row.plan_json));
    if (
      canonicalJson(stored) !== row.plan_json ||
      row.delivery_plan_id !== deliveryPlanId ||
      row.project_id !== projectId ||
      row.identity_project_id !== projectId ||
      row.revision !== revision ||
      stored.plan.id !== deliveryPlanId ||
      stored.plan.projectId !== projectId ||
      stored.plan.revision !== revision ||
      row.project_intent_id !== stored.plan.projectIntentId ||
      row.project_intent_revision !== stored.plan.projectIntentRevision ||
      row.ledger_id !== stored.plan.ledgerId ||
      row.ledger_revision !== stored.plan.ledgerRevision ||
      row.base_delivery_plan_revision !==
        stored.plan.baseDeliveryPlanRevision ||
      row.proposal_id !== stored.plan.proposalId ||
      row.approved_by !== stored.plan.approvedBy ||
      row.approved_at !== stored.plan.approvedAt
    ) {
      throw new Error('Stored delivery plan base is corrupt');
    }
  }

  cyclePurpose(id: string): PlanningCyclePurposeState | undefined {
    const row = this.database
      .prepare(
        `SELECT planning_cycle_id, project_id, purpose, base_delivery_plan_id,
          base_delivery_plan_revision
         FROM planning_cycle_purposes WHERE planning_cycle_id = ?`,
      )
      .get(id) as CyclePurposeRow | undefined;
    if (!row) return undefined;
    const cycle = this.cycle(id);
    if (!cycle || cycle.projectId !== row.project_id) {
      throw new Error('Stored planning cycle purpose is corrupt');
    }
    const purpose = planningCyclePurposeStateSchema.parse({
      planningCycleId: row.planning_cycle_id,
      purpose: row.purpose,
      baseDeliveryPlanId: row.base_delivery_plan_id,
      baseDeliveryPlanRevision: row.base_delivery_plan_revision,
    });
    if (
      purpose.baseDeliveryPlanId !== null &&
      purpose.baseDeliveryPlanRevision !== null
    ) {
      this.authenticateDeliveryPlanBase(
        row.project_id,
        purpose.baseDeliveryPlanId,
        purpose.baseDeliveryPlanRevision,
      );
    }
    return purpose;
  }

  cycleView(id: string): PlanningCycleView | undefined {
    const cycle = this.cycle(id);
    if (!cycle) return undefined;
    const purpose = this.cyclePurpose(id);
    if (!purpose) throw new Error('Stored planning cycle purpose is missing');
    const turns = (
      this.database
        .prepare(
          'SELECT * FROM planning_turns WHERE planning_cycle_id = ? ORDER BY ordinal',
        )
        .all(id) as TurnRow[]
    ).map(toTurn);
    const questions = (
      this.database
        .prepare(
          `SELECT * FROM planning_questions
           WHERE planning_cycle_id = ? ORDER BY turn_id, ordinal, id`,
        )
        .all(id) as QuestionRow[]
    ).map(toQuestion);
    const proposals =
      purpose.purpose === 'intent'
        ? (
            this.database
              .prepare(
                'SELECT * FROM planning_proposals WHERE planning_cycle_id = ? ORDER BY revision',
              )
              .all(id) as ProposalRow[]
          ).map(toProposal)
        : [];
    const deliveryPlanProposals =
      purpose.purpose === 'delivery_plan' ? this.deliveryPlanProposals(id) : [];
    return planningCycleViewSchema.parse({
      cycle,
      purpose: {
        kind: purpose.purpose,
        baseDeliveryPlanId: purpose.baseDeliveryPlanId,
        baseDeliveryPlanRevision: purpose.baseDeliveryPlanRevision,
      },
      turns,
      questions,
      proposals,
      deliveryPlanProposals,
    });
  }

  planningSnapshot(projectId: string): PlanningBoardSnapshot {
    return inImmediateTransaction(this.database, () =>
      this.planningSnapshotInTransaction(projectId),
    );
  }

  taskExecutionAuthority(
    projectId: string,
    taskId: string,
  ): TaskExecutionAuthority | undefined {
    return inImmediateTransaction(this.database, () =>
      this.taskExecutionAuthorityInTransaction(projectId, taskId),
    );
  }

  taskExecutionAuthorityInTransaction(
    projectId: string,
    taskId: string,
  ): TaskExecutionAuthority | undefined {
    const row = this.database
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined;
    if (!row) return undefined;
    const project = projectSchema.parse({
      id: row.id,
      displayName: row.display_name,
      repositoryIdentity: row.repository_identity,
      repositoryPath: row.repository_path,
      gitCommonDirectory: row.git_common_directory,
      headCommit: row.head_commit,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    const intentLedger = this.approvedIntentLedger(projectId);
    const deliveryPlan = this.approvedDeliveryPlan(projectId);
    const filter = this.boardFilter(projectId);
    if (!intentLedger || !deliveryPlan || !filter) return undefined;
    const currentTaskRevisions = this.currentTaskRevisions(deliveryPlan);
    const task = currentTaskRevisions.find(({ id }) => id === taskId);
    if (!task) return undefined;
    const board = this.projectPlanningBoard({
      projectId,
      intentLedger,
      deliveryPlan,
      currentTaskRevisions,
      filter,
    });
    const card = board.cards.find(({ taskId: id }) => id === taskId);
    if (!card) return undefined;
    const requirementRevisions = deliveryPlan.traces.flatMap((trace) =>
      trace.kind === 'task_satisfies' && trace.taskId === taskId
        ? [trace.requirement]
        : [],
    );
    return {
      project,
      deliveryPlan,
      intentRevision: deliveryPlan.plan.projectIntentRevision,
      ledgerRevision: deliveryPlan.plan.ledgerRevision,
      task,
      requirementRevisions,
      board,
      card,
    };
  }

  planningSnapshotInTransaction(projectId: string): PlanningBoardSnapshot {
    const rows = this.database
      .prepare(
        `SELECT * FROM planning_cycles
         WHERE project_id = ?
         ORDER BY
           CASE WHEN lifecycle NOT IN ('approved', 'proposal_rejected', 'abandoned')
             THEN 0 ELSE 1 END,
           updated_at DESC, id DESC
         LIMIT 20`,
      )
      .all(projectId) as CycleRow[];
    const total = (
      this.database
        .prepare(
          'SELECT COUNT(*) AS count FROM planning_cycles WHERE project_id = ?',
        )
        .get(projectId) as { count: number }
    ).count;
    const intentLedger = this.approvedIntentLedger(projectId) ?? null;
    const deliveryPlan = this.approvedDeliveryPlan(projectId) ?? null;
    const filter = this.boardFilter(projectId) ?? null;
    return {
      planningCycles: rows.map((row) => this.requireCycleView(row.id)),
      planningHistoryTruncated: total > rows.length,
      intentLedger,
      deliveryPlan,
      board: this.projectPlanningBoard({
        projectId,
        intentLedger,
        deliveryPlan,
        currentTaskRevisions:
          deliveryPlan === null ? [] : this.currentTaskRevisions(deliveryPlan),
        filter,
      }),
    };
  }

  private projectPlanningBoard(input: {
    projectId: string;
    intentLedger: ApprovedIntentLedger | null;
    deliveryPlan: ApprovedDeliveryPlan | null;
    currentTaskRevisions: readonly TaskRevision[];
    filter: BoardFilter | null;
  }): BoardView {
    if (
      input.intentLedger === null ||
      input.deliveryPlan === null ||
      input.filter === null
    ) {
      return projectBoard(input);
    }

    const records = new Map(
      input.intentLedger.records.map((record) => [
        `${record.recordId}:${record.revision}`,
        record,
      ]),
    );
    const loadRecord = (recordId: string, revision?: number) => {
      const row = this.database
        .prepare(
          `SELECT * FROM ledger_record_revisions
           WHERE project_id = ? AND record_id = ?
             AND (? IS NULL OR revision = ?)
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(input.projectId, recordId, revision ?? null, revision ?? null) as
        | RecordRevisionRow
        | undefined;
      if (!row) throw new Error('Historical requirement metadata is missing');
      const record = ledgerRecordRevisionSchema.parse({
        recordId: row.record_id,
        projectId: row.project_id,
        revision: row.revision,
        content: ledgerRecordContentSchema.parse(JSON.parse(row.content_json)),
        provenance: this.recordProvenance(row.record_id, row.revision),
        proposalId: row.proposal_id,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at,
      });
      if (record.content.type !== 'requirement')
        throw new Error('Historical requirement metadata is corrupt');
      records.set(`${record.recordId}:${record.revision}`, record);
    };
    for (const trace of input.deliveryPlan.traces) {
      const key = `${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
      if (!records.has(key)) {
        loadRecord(
          trace.requirement.recordId,
          trace.requirement.recordRevision,
        );
      }
    }
    for (const recordId of input.filter.requirementRecordIds) {
      if (![...records.values()].some((record) => record.recordId === recordId))
        loadRecord(recordId);
    }

    const historicalMilestones = input.filter.milestoneIds.flatMap(
      (milestoneId) => {
        if (input.deliveryPlan!.milestones.some(({ id }) => id === milestoneId))
          return [];
        const row = this.database
          .prepare(
            `SELECT * FROM milestone_revisions
             WHERE project_id = ? AND milestone_id = ?
             ORDER BY revision DESC LIMIT 1`,
          )
          .get(input.projectId, milestoneId) as
          | {
              milestone_id: string;
              project_id: string;
              revision: number;
              lifecycle: string;
              revision_json: string;
              proposal_id: string;
              delivery_plan_revision: number;
              approved_at: string;
            }
          | undefined;
        if (!row) throw new Error('Historical milestone metadata is missing');
        const milestone = milestoneRevisionSchema.parse(
          JSON.parse(row.revision_json),
        );
        if (
          canonicalJson(milestone) !== row.revision_json ||
          row.milestone_id !== milestone.id ||
          row.project_id !== milestone.projectId ||
          row.revision !== milestone.revision ||
          row.lifecycle !== milestone.lifecycle ||
          row.proposal_id !== milestone.proposalId ||
          row.delivery_plan_revision !== milestone.deliveryPlanRevision ||
          row.approved_at !== milestone.approvedAt
        ) {
          throw new Error('Historical milestone metadata is corrupt');
        }
        return [milestone];
      },
    );
    const historicalIds = new Set(historicalMilestones.map(({ id }) => id));
    const board = projectBoard({
      ...input,
      intentLedger: {
        ...input.intentLedger,
        records: [...records.values()],
      },
      deliveryPlan: {
        ...input.deliveryPlan,
        milestones: [...input.deliveryPlan.milestones, ...historicalMilestones],
      },
    });
    return boardViewSchema.parse({
      ...board,
      facets: {
        ...board.facets,
        milestones: board.facets.milestones.map((option) =>
          historicalIds.has(option.value)
            ? { ...option, historical: true }
            : option,
        ),
      },
    });
  }

  pendingLaunchTurns(): readonly PlanningTurn[] {
    return (
      this.database
        .prepare(
          `SELECT t.* FROM planning_turns t
           JOIN planning_cycles c ON c.id = t.planning_cycle_id
             AND c.project_id = t.project_id
           WHERE t.launch_state = 'launch_pending'
             AND c.lifecycle NOT IN ('approved', 'proposal_rejected', 'abandoned')
           ORDER BY t.created_at, t.id`,
        )
        .all() as TurnRow[]
    ).map(toTurn);
  }

  boundOpenTurns(): readonly PlanningTurn[] {
    return (
      this.database
        .prepare(
          `SELECT t.* FROM planning_turns t
           JOIN planning_cycles c ON c.id = t.planning_cycle_id
           WHERE t.launch_state = 'execution_bound'
             AND c.lifecycle IN ('execution_active', 'attention_required')
           ORDER BY t.created_at, t.id`,
        )
        .all() as TurnRow[]
    ).map(toTurn);
  }

  insertCycleInTransaction(
    input: PlanningCycle,
    purposeInput?: PlanningCyclePurposeState,
  ): PlanningCycle {
    this.assertTransaction();
    const cycle = planningCycleSchema.parse(input);
    const purpose = planningCyclePurposeStateSchema.parse(
      purposeInput ?? {
        planningCycleId: cycle.id,
        purpose: 'intent',
        baseDeliveryPlanId: null,
        baseDeliveryPlanRevision: null,
      },
    );
    if (purpose.planningCycleId !== cycle.id) {
      throw new Error('Planning cycle purpose does not match its cycle');
    }
    const currentIntent = this.approvedIntentLedger(cycle.projectId);
    if (
      (currentIntent?.projectIntent.revision ?? null) !==
        cycle.baseProjectIntentRevision ||
      (currentIntent?.ledger.revision ?? null) !== cycle.baseLedgerRevision
    ) {
      throw new Error('Planning cycle base is not current');
    }
    if (purpose.purpose === 'delivery_plan') {
      const currentPlan = this.approvedDeliveryPlan(cycle.projectId);
      if (
        (currentPlan?.plan.id ?? null) !== purpose.baseDeliveryPlanId ||
        (currentPlan?.plan.revision ?? null) !==
          purpose.baseDeliveryPlanRevision
      ) {
        throw new Error('Planning cycle delivery plan base is not current');
      }
    }
    this.database
      .prepare(
        `INSERT INTO planning_cycles (
          id, project_id, lifecycle, revision, profile_id, profile_revision,
          base_project_intent_revision, base_ledger_revision,
          latest_proposal_revision, active_execution_id,
          created_at, updated_at, ended_at
        ) VALUES (
          @id, @projectId, @lifecycle, @revision, @profileId, @profileRevision,
          @baseProjectIntentRevision, @baseLedgerRevision,
          @latestProposalRevision, @activeExecutionId,
          @createdAt, @updatedAt, @endedAt
        )`,
      )
      .run(cycle);
    const purposeChanged = this.database
      .prepare(
        `UPDATE planning_cycle_purposes SET
          purpose = ?, base_delivery_plan_id = ?,
          base_delivery_plan_revision = ?
         WHERE planning_cycle_id = ? AND project_id = ?`,
      )
      .run(
        purpose.purpose,
        purpose.baseDeliveryPlanId,
        purpose.baseDeliveryPlanRevision,
        cycle.id,
        cycle.projectId,
      );
    if (purposeChanged.changes !== 1) {
      throw new Error('Planning cycle purpose was not created');
    }
    return cycle;
  }

  updateCycleInTransaction(
    input: PlanningCycle,
    expectedRevision: number,
  ): PlanningCycle {
    this.assertTransaction();
    const cycle = planningCycleSchema.parse(input);
    const changed = this.database
      .prepare(
        `UPDATE planning_cycles SET
          lifecycle = @lifecycle,
          revision = @revision,
          latest_proposal_revision = @latestProposalRevision,
          active_execution_id = @activeExecutionId,
          updated_at = @updatedAt,
          ended_at = @endedAt
         WHERE id = @id AND project_id = @projectId AND revision = @expectedRevision`,
      )
      .run({ ...cycle, expectedRevision });
    if (changed.changes !== 1)
      throw new Error('Planning cycle revision conflict');
    return cycle;
  }

  insertTurnInTransaction(input: PlanningTurn): PlanningTurn {
    this.assertTransaction();
    const turn = planningTurnSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO planning_turns (
          id, project_id, planning_cycle_id, ordinal, actor, message,
          launch_state, execution_id, created_at
        ) VALUES (
          @id, @projectId, @planningCycleId, @ordinal, @actor, @message,
          @launchState, @executionId, @createdAt
        )`,
      )
      .run(turn);
    return turn;
  }

  bindTurnInTransaction(turnId: string, executionId: string): PlanningTurn {
    this.assertTransaction();
    const changed = this.database
      .prepare(
        `UPDATE planning_turns
         SET launch_state = 'execution_bound', execution_id = ?
         WHERE id = ? AND launch_state = 'launch_pending' AND execution_id IS NULL`,
      )
      .run(executionId, turnId);
    if (changed.changes !== 1)
      throw new Error('Pending planning turn was not found');
    const turn = this.turn(turnId);
    if (!turn) throw new Error('Bound planning turn was not found');
    return turn;
  }

  insertQuestionsInTransaction(
    questions: readonly PlanningQuestion[],
  ): readonly PlanningQuestion[] {
    this.assertTransaction();
    const insert = this.database.prepare(
      `INSERT INTO planning_questions (
        id, project_id, planning_cycle_id, turn_id, ordinal, key,
        prompt, rationale, choices_json
      ) VALUES (
        @id, @projectId, @planningCycleId, @turnId, @ordinal, @key,
        @prompt, @rationale, @choicesJson
      )`,
    );
    return questions.map((input, index) => {
      const question = planningQuestionSchema.parse(input);
      insert.run({
        ...question,
        ordinal: index + 1,
        choicesJson:
          question.choices === undefined
            ? null
            : canonicalJson(question.choices),
      });
      return question;
    });
  }

  insertProposalInTransaction(input: PlanningProposal): PlanningProposal {
    this.assertTransaction();
    const proposal = planningProposalSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO planning_proposals (
          id, project_id, planning_cycle_id, revision, lifecycle,
          base_project_intent_revision, base_ledger_revision, summary,
          project_intent_json, records_json, relationships_json, diff_json,
          created_by_turn_id, created_by_execution_id, rejection_feedback,
          created_at, decided_at
        ) VALUES (
          @id, @projectId, @planningCycleId, @revision, @lifecycle,
          @baseProjectIntentRevision, @baseLedgerRevision, @summary,
          @projectIntentJson, @recordsJson, @relationshipsJson, @diffJson,
          @createdByTurnId, @createdByExecutionId, @rejectionFeedback,
          @createdAt, @decidedAt
        )`,
      )
      .run({
        ...proposal,
        projectIntentJson: canonicalJson(proposal.projectIntent),
        recordsJson: canonicalJson(proposal.records),
        relationshipsJson: canonicalJson(proposal.relationships),
        diffJson: canonicalJson(proposal.diff),
      });
    const reserve = this.database.prepare(
      `INSERT INTO planning_proposal_records (
        proposal_id, proposal_key, record_id
      ) VALUES (?, ?, ?)`,
    );
    for (const record of proposal.records) {
      if (record.operation === 'create') {
        reserve.run(proposal.id, record.key, record.recordId);
      }
    }
    return proposal;
  }

  updateProposalInTransaction(input: PlanningProposal): PlanningProposal {
    this.assertTransaction();
    const proposal = planningProposalSchema.parse(input);
    const changed = this.database
      .prepare(
        `UPDATE planning_proposals
         SET lifecycle = @lifecycle,
             rejection_feedback = @rejectionFeedback,
             decided_at = @decidedAt
         WHERE id = @id AND project_id = @projectId
           AND planning_cycle_id = @planningCycleId`,
      )
      .run(proposal);
    if (changed.changes !== 1)
      throw new Error('Planning proposal was not found');
    return proposal;
  }

  proposal(id: string): PlanningProposal | undefined {
    const row = this.database
      .prepare('SELECT * FROM planning_proposals WHERE id = ?')
      .get(id) as ProposalRow | undefined;
    return row ? toProposal(row) : undefined;
  }

  proposalRecordReservations(
    proposalId: string,
  ): readonly { key: string; recordId: LedgerRecordRevision['recordId'] }[] {
    const rows = this.database
      .prepare(
        `SELECT proposal_key AS key, record_id AS recordId
           FROM planning_proposal_records
           WHERE proposal_id = ? ORDER BY proposal_key`,
      )
      .all(proposalId) as { key: string; recordId: string }[];
    return rows.map(({ key, recordId }) => ({
      key,
      recordId: ledgerRecordIdSchema.parse(recordId),
    }));
  }

  receipt(executionId: string): PmOutputReceipt | undefined {
    const row = this.database
      .prepare(
        `SELECT execution_id AS executionId, project_id AS projectId,
          planning_cycle_id AS planningCycleId, human_turn_id AS humanTurnId,
          runtime_event_id AS runtimeEventId, output_digest AS outputDigest,
          status, rejection_reason AS rejectionReason, created_at AS createdAt
         FROM pm_output_receipts WHERE execution_id = ?`,
      )
      .get(executionId);
    return row ? receiptSchema.parse(row) : undefined;
  }

  insertReceiptInTransaction(input: PmOutputReceipt): PmOutputReceipt {
    this.assertTransaction();
    const receipt = receiptSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO pm_output_receipts (
          execution_id, project_id, planning_cycle_id, human_turn_id,
          runtime_event_id, output_digest, status, rejection_reason, created_at
        ) VALUES (
          @executionId, @projectId, @planningCycleId, @humanTurnId,
          @runtimeEventId, @outputDigest, @status, @rejectionReason, @createdAt
        )`,
      )
      .run(receipt);
    return receipt;
  }

  insertProjectIntentRevisionInTransaction(
    input: ProjectIntentRevision,
  ): ProjectIntentRevision {
    this.assertTransaction();
    const intent = projectIntentRevisionSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO project_intent_revisions (
          id, project_id, revision, content_json, proposal_id,
          approved_by, approved_at
        ) VALUES (
          @id, @projectId, @revision, @contentJson, @proposalId,
          @approvedBy, @approvedAt
        )`,
      )
      .run({
        ...intent,
        contentJson: canonicalJson(withoutProvenance(intent.content)),
      });
    const insert = this.database.prepare(
      `INSERT INTO project_intent_provenance (
        project_intent_id, project_intent_revision, project_id,
        turn_id, ordinal, rationale
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    intent.content.provenance.forEach((provenance, index) =>
      insert.run(
        intent.id,
        intent.revision,
        intent.projectId,
        provenance.turnId,
        index + 1,
        provenance.rationale,
      ),
    );
    return intent;
  }

  applyApprovedProposalInTransaction(
    input: PlanningProposal,
    approvedAt: string,
  ): ApprovedIntentLedger {
    this.assertTransaction();
    const proposal = planningProposalSchema.parse(input);
    const current = this.approvedIntentLedger(proposal.projectId);
    if (
      proposal.baseProjectIntentRevision !==
        (current?.projectIntent.revision ?? null) ||
      proposal.baseLedgerRevision !== (current?.ledger.revision ?? null)
    ) {
      throw new PlanningProposalInvalidError(
        'Planning canonical base conflict',
      );
    }
    const base = new Map(
      (current?.records ?? []).map((record) => [record.recordId, record]),
    );
    const proposedExisting = new Set(
      proposal.records.flatMap((member) =>
        member.operation === 'create' ? [] : [member.recordId],
      ),
    );
    if ([...base.keys()].some((recordId) => !proposedExisting.has(recordId))) {
      throw new PlanningProposalInvalidError(
        'Planning proposal omitted a canonical ledger member',
      );
    }

    const assertOwnedProvenance = (
      provenance: readonly { turnId: string }[],
    ) => {
      assertUniqueProvenance(provenance);
      for (const item of provenance) {
        const turn = this.turn(item.turnId);
        if (
          !turn ||
          turn.projectId !== proposal.projectId ||
          turn.planningCycleId !== proposal.planningCycleId
        ) {
          throw new PlanningProposalInvalidError(
            'Planning proposal provenance is outside the cycle',
          );
        }
      }
    };
    assertOwnedProvenance(proposal.projectIntent.provenance);
    const reservations = new Map(
      this.proposalRecordReservations(proposal.id).map(({ key, recordId }) => [
        key,
        recordId,
      ]),
    );
    const records: LedgerRecordRevision[] = [];
    for (const member of proposal.records) {
      if (member.operation === 'reuse') {
        const existing = base.get(member.recordId);
        if (!existing || existing.revision !== member.expectedRevision) {
          throw new PlanningProposalInvalidError(
            'Planning record revision conflict',
          );
        }
        records.push(existing);
        continue;
      }
      assertOwnedProvenance(member.provenance);
      const revision =
        member.operation === 'create' ? 1 : member.expectedRevision + 1;
      if (member.operation === 'revise') {
        const existing = base.get(member.recordId);
        if (
          !existing ||
          existing.revision !== member.expectedRevision ||
          existing.content.type !== member.content.type
        ) {
          throw new PlanningProposalInvalidError(
            'Planning record revision conflict',
          );
        }
      } else if (reservations.get(member.key) !== member.recordId) {
        throw new PlanningProposalInvalidError(
          'Planning proposal record reservation does not match',
        );
      }
      const record = ledgerRecordRevisionSchema.parse({
        recordId: member.recordId,
        projectId: proposal.projectId,
        revision,
        content: approvedContent(member.content),
        provenance: member.provenance,
        proposalId: proposal.id,
        approvedBy: 'human',
        approvedAt,
      });
      records.push(record);
    }

    const projectIntent = projectIntentRevisionSchema.parse({
      id: current?.projectIntent.id ?? randomUUID(),
      projectId: proposal.projectId,
      revision: (current?.projectIntent.revision ?? 0) + 1,
      content: proposal.projectIntent,
      proposalId: proposal.id,
      approvedBy: 'human',
      approvedAt,
    });
    const ledger = ledgerRevisionSchema.parse({
      id: current?.ledger.id ?? randomUUID(),
      projectId: proposal.projectId,
      revision: (current?.ledger.revision ?? 0) + 1,
      proposalId: proposal.id,
      approvedBy: 'human',
      approvedAt,
    });
    const recordIds = new Set(records.map(({ recordId }) => recordId));
    const relationships = proposal.relationships.map((relationship) => {
      const endpoint = (value: typeof relationship.from) =>
        'recordId' in value
          ? value.recordId
          : reservations.get(value.proposalKey);
      const fromRecordId = endpoint(relationship.from);
      const toRecordId = endpoint(relationship.to);
      if (
        !fromRecordId ||
        !toRecordId ||
        !recordIds.has(fromRecordId) ||
        !recordIds.has(toRecordId)
      ) {
        throw new PlanningProposalInvalidError(
          'Planning relationship endpoint was not reserved',
        );
      }
      return ledgerRelationshipSchema.parse({
        kind: relationship.kind,
        fromRecordId,
        toRecordId,
      });
    });
    const approved = approvedIntentLedgerSchema.parse({
      projectIntent,
      ledger,
      records,
      relationships,
    });

    for (const member of proposal.records) {
      if (member.operation !== 'create') continue;
      this.database
        .prepare(
          `INSERT INTO ledger_records (
            id, project_id, type, created_proposal_id, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          member.recordId,
          proposal.projectId,
          member.content.type,
          proposal.id,
          approvedAt,
        );
    }
    for (const record of records) {
      const member = proposal.records.find(
        (candidate) =>
          candidate.operation !== 'reuse' &&
          candidate.recordId === record.recordId,
      );
      if (member) this.insertRecordRevisionInTransaction(record);
    }
    this.insertProjectIntentRevisionInTransaction(projectIntent);
    this.database
      .prepare(
        `INSERT INTO ledger_revisions (
          id, project_id, revision, proposal_id, approved_by, approved_at
        ) VALUES (@id, @projectId, @revision, @proposalId, @approvedBy, @approvedAt)`,
      )
      .run(ledger);
    const memberInsert = this.database.prepare(
      `INSERT INTO ledger_revision_members (
        ledger_id, ledger_revision, project_id, record_id, record_revision, ordinal
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    records.forEach((record, index) =>
      memberInsert.run(
        ledger.id,
        ledger.revision,
        ledger.projectId,
        record.recordId,
        record.revision,
        index + 1,
      ),
    );
    const relationshipInsert = this.database.prepare(
      `INSERT INTO ledger_revision_relationships (
        ledger_id, ledger_revision, project_id, ordinal,
        kind, from_record_id, to_record_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    relationships.forEach((relationship, index) =>
      relationshipInsert.run(
        ledger.id,
        ledger.revision,
        ledger.projectId,
        index + 1,
        relationship.kind,
        relationship.fromRecordId,
        relationship.toRecordId,
      ),
    );
    return approved;
  }

  insertDeliveryPlanProposalInTransaction(
    input: DeliveryPlanProposal,
  ): DeliveryPlanProposal {
    this.assertTransaction();
    const proposal = deliveryPlanProposalSchema.parse(input);
    if (proposal.decision.kind !== 'pending') {
      throw new PlanningProposalInvalidError(
        'New delivery plan proposals must be pending',
      );
    }
    const purpose = this.cyclePurpose(proposal.planningCycleId);
    if (
      purpose?.purpose !== 'delivery_plan' ||
      purpose.baseDeliveryPlanId !== proposal.base.deliveryPlan.id ||
      purpose.baseDeliveryPlanRevision !== proposal.base.deliveryPlan.revision
    ) {
      throw new PlanningProposalInvalidError(
        'Delivery plan proposal base does not match its cycle',
      );
    }
    const currentIntent = this.approvedIntentLedger(proposal.projectId);
    const currentPlan = this.approvedDeliveryPlan(proposal.projectId);
    if (
      !currentIntent ||
      currentIntent.projectIntent.id !== proposal.base.projectIntentId ||
      currentIntent.projectIntent.revision !==
        proposal.base.projectIntentRevision ||
      currentIntent.ledger.id !== proposal.base.ledgerId ||
      currentIntent.ledger.revision !== proposal.base.ledgerRevision ||
      (currentPlan?.plan.id ?? null) !== proposal.base.deliveryPlan.id ||
      (currentPlan?.plan.revision ?? null) !==
        proposal.base.deliveryPlan.revision
    ) {
      throw new PlanningProposalInvalidError(
        'Delivery plan proposal base is not current',
      );
    }
    const latest = this.database
      .prepare(
        `SELECT MAX(revision) AS revision FROM delivery_plan_proposals
         WHERE planning_cycle_id = ?`,
      )
      .get(proposal.planningCycleId) as { revision: number | null };
    if (proposal.revision !== (latest.revision ?? 0) + 1) {
      throw new PlanningProposalInvalidError(
        'Delivery plan proposal revision is not contiguous',
      );
    }
    this.database
      .prepare(
        `INSERT INTO delivery_plan_proposals (
          id, project_id, planning_cycle_id, revision, proposal_json,
          project_intent_id, project_intent_revision, ledger_id,
          ledger_revision, base_delivery_plan_id, base_delivery_plan_revision,
          created_by_turn_id, created_by_execution_id, created_at
        ) VALUES (
          @id, @projectId, @planningCycleId, @revision, @proposalJson,
          @projectIntentId, @projectIntentRevision, @ledgerId,
          @ledgerRevision, @baseDeliveryPlanId, @baseDeliveryPlanRevision,
          @createdByTurnId, @createdByExecutionId, @createdAt
        )`,
      )
      .run({
        ...proposal,
        proposalJson: canonicalJson(proposal),
        projectIntentId: proposal.base.projectIntentId,
        projectIntentRevision: proposal.base.projectIntentRevision,
        ledgerId: proposal.base.ledgerId,
        ledgerRevision: proposal.base.ledgerRevision,
        baseDeliveryPlanId: proposal.base.deliveryPlan.id,
        baseDeliveryPlanRevision: proposal.base.deliveryPlan.revision,
      });
    const insert = (
      table: string,
      idColumn: string,
      reservations: readonly { key: string; id: string }[],
    ) => {
      const statement = this.database.prepare(
        `INSERT INTO ${table} (proposal_id, proposal_key, ${idColumn})
         VALUES (?, ?, ?)`,
      );
      for (const reservation of reservations) {
        statement.run(proposal.id, reservation.key, reservation.id);
      }
    };
    insert(
      'delivery_plan_proposal_milestone_reservations',
      'milestone_id',
      proposal.reservations.milestones,
    );
    insert(
      'delivery_plan_proposal_task_reservations',
      'task_id',
      proposal.reservations.tasks,
    );
    insert(
      'delivery_plan_proposal_dependency_reservations',
      'dependency_id',
      proposal.reservations.dependencies,
    );
    const reservationMap = (values: readonly { key: string; id: string }[]) =>
      new Map(values.map(({ key, id }) => [key, id]));
    const milestoneReservations = reservationMap(
      proposal.reservations.milestones,
    );
    const taskReservations = reservationMap(proposal.reservations.tasks);
    const dependencyReservations = reservationMap(
      proposal.reservations.dependencies,
    );
    const identity = (member: {
      operation: string;
      key?: string;
      milestoneId?: string;
      taskId?: string;
      dependencyId?: string;
    }) =>
      member.operation === 'create'
        ? `proposal:${member.key}`
        : `canonical:${member.milestoneId ?? member.taskId ?? member.dependencyId}`;
    const refIdentity = (ref: {
      kind: string;
      key?: string;
      milestoneId?: string;
      taskId?: string;
    }) =>
      ref.kind === 'proposal'
        ? `proposal:${ref.key}`
        : `canonical:${ref.milestoneId ?? ref.taskId}`;
    const memberInsert = (table: string, columns: string) =>
      this.database.prepare(
        `INSERT INTO ${table} (
          proposal_id, project_id, proposal_revision, ordinal, ${columns}, member_json
        ) VALUES (?, ?, ?, ?, ${columns
          .split(',')
          .map(() => '?')
          .join(', ')}, ?)`,
      );
    const milestoneInsert = memberInsert(
      'delivery_plan_proposal_milestones',
      'identity_key, proposal_key, milestone_id',
    );
    proposal.proposedPlan.milestones.forEach((member, index) => {
      const key = member.operation === 'create' ? member.key : null;
      const id =
        member.operation === 'create'
          ? milestoneReservations.get(member.key)
          : member.milestoneId;
      if (!id)
        throw new PlanningProposalInvalidError(
          'Milestone reservation is missing',
        );
      milestoneInsert.run(
        proposal.id,
        proposal.projectId,
        proposal.revision,
        index + 1,
        identity(member),
        key,
        id,
        canonicalJson(member),
      );
    });
    const taskInsert = memberInsert(
      'delivery_plan_proposal_tasks',
      'identity_key, proposal_key, task_id, milestone_identity_key',
    );
    proposal.proposedPlan.tasks.forEach((member, index) => {
      const key = member.operation === 'create' ? member.key : null;
      const id =
        member.operation === 'create'
          ? taskReservations.get(member.key)
          : member.taskId;
      const milestoneRef =
        member.operation === 'reuse'
          ? null
          : refIdentity(member.content.milestone);
      if (!id)
        throw new PlanningProposalInvalidError('Task reservation is missing');
      taskInsert.run(
        proposal.id,
        proposal.projectId,
        proposal.revision,
        index + 1,
        identity(member),
        key,
        id,
        milestoneRef,
        canonicalJson(member),
      );
    });
    const dependencyInsert = memberInsert(
      'delivery_plan_proposal_dependencies',
      'identity_key, proposal_key, dependency_id, prerequisite_task_identity_key, dependent_task_identity_key',
    );
    proposal.proposedPlan.dependencies.forEach((member, index) => {
      const key = member.operation === 'create' ? member.key : null;
      const id =
        member.operation === 'create'
          ? dependencyReservations.get(member.key)
          : member.dependencyId;
      if (!id)
        throw new PlanningProposalInvalidError(
          'Dependency reservation is missing',
        );
      const prerequisite =
        member.operation === 'create' ? refIdentity(member.prerequisite) : null;
      const dependent =
        member.operation === 'create' ? refIdentity(member.dependent) : null;
      dependencyInsert.run(
        proposal.id,
        proposal.projectId,
        proposal.revision,
        index + 1,
        identity(member),
        key,
        id,
        prerequisite,
        dependent,
        canonicalJson(member),
      );
    });
    const traceInsert = this.database.prepare(
      `INSERT INTO delivery_plan_proposal_traces (
        proposal_id, project_id, proposal_revision, ordinal, kind,
        milestone_identity_key, task_identity_key,
        record_id, record_revision, trace_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    proposal.proposedPlan.traces.forEach((trace, index) => {
      const subject =
        trace.kind === 'milestone_covers'
          ? refIdentity(trace.milestone)
          : refIdentity(trace.task);
      traceInsert.run(
        proposal.id,
        proposal.projectId,
        proposal.revision,
        index + 1,
        trace.kind,
        trace.kind === 'milestone_covers' ? subject : null,
        trace.kind === 'task_satisfies' ? subject : null,
        trace.requirement.recordId,
        trace.requirement.recordRevision,
        canonicalJson(trace),
      );
    });
    return proposal;
  }

  deliveryPlanProposal(id: string): DeliveryPlanProposal | undefined {
    const row = this.database
      .prepare('SELECT * FROM delivery_plan_proposals WHERE id = ?')
      .get(id) as DeliveryPlanProposalRow | undefined;
    if (!row) return undefined;
    const stored = deliveryPlanProposalSchema.parse(
      JSON.parse(row.proposal_json),
    );
    const byKey = <T extends { key: string }>(values: readonly T[]) =>
      [...values].sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
    const sortedReservations = (reservations: {
      milestones: readonly { key: string; id: string }[];
      tasks: readonly { key: string; id: string }[];
      dependencies: readonly { key: string; id: string }[];
    }) => ({
      milestones: byKey(reservations.milestones),
      tasks: byKey(reservations.tasks),
      dependencies: byKey(reservations.dependencies),
    });
    if (
      canonicalJson(stored) !== row.proposal_json ||
      row.id !== stored.id ||
      row.project_id !== stored.projectId ||
      row.planning_cycle_id !== stored.planningCycleId ||
      row.revision !== stored.revision ||
      row.project_intent_id !== stored.base.projectIntentId ||
      row.project_intent_revision !== stored.base.projectIntentRevision ||
      row.ledger_id !== stored.base.ledgerId ||
      row.ledger_revision !== stored.base.ledgerRevision ||
      row.base_delivery_plan_id !== stored.base.deliveryPlan.id ||
      row.base_delivery_plan_revision !== stored.base.deliveryPlan.revision ||
      row.created_by_turn_id !== stored.createdByTurnId ||
      row.created_by_execution_id !== stored.createdByExecutionId ||
      row.created_at !== stored.createdAt ||
      canonicalJson(
        sortedReservations(this.deliveryPlanProposalReservations(id)),
      ) !== canonicalJson(sortedReservations(stored.reservations))
    ) {
      throw new Error('Stored delivery plan proposal is corrupt');
    }
    if (
      stored.base.deliveryPlan.id !== null &&
      stored.base.deliveryPlan.revision !== null
    ) {
      this.authenticateDeliveryPlanBase(
        stored.projectId,
        stored.base.deliveryPlan.id,
        stored.base.deliveryPlan.revision,
      );
    }
    const assertNormalized = (
      table: string,
      jsonColumn: 'member_json' | 'trace_json',
      expected: readonly Record<string, unknown>[],
    ) => {
      const rows = this.database
        .prepare(
          `SELECT * FROM ${table} WHERE proposal_id = ? ORDER BY ordinal`,
        )
        .all(id) as Record<string, unknown>[];
      if (
        rows.length !== expected.length ||
        rows.some((row, index) =>
          Object.entries(expected[index]).some(
            ([key, value]) => key !== 'canonical' && row[key] !== value,
          ),
        )
      ) {
        throw new Error('Stored delivery plan proposal members are corrupt');
      }
      for (const [index, row] of rows.entries()) {
        const canonical = expected[index].canonical;
        if (row[jsonColumn] !== canonical)
          throw new Error('Stored delivery plan proposal members are corrupt');
      }
    };
    const reservationId = (
      values: readonly { key: string; id: string }[],
      key: string,
    ) => values.find((value) => value.key === key)?.id;
    const identity = (member: {
      operation: string;
      key?: string;
      milestoneId?: string;
      taskId?: string;
      dependencyId?: string;
    }) =>
      member.operation === 'create'
        ? `proposal:${member.key}`
        : `canonical:${member.milestoneId ?? member.taskId ?? member.dependencyId}`;
    const refIdentity = (ref: {
      kind: string;
      key?: string;
      milestoneId?: string;
      taskId?: string;
    }) =>
      ref.kind === 'proposal'
        ? `proposal:${ref.key}`
        : `canonical:${ref.milestoneId ?? ref.taskId}`;
    assertNormalized(
      'delivery_plan_proposal_milestones',
      'member_json',
      stored.proposedPlan.milestones.map((member, index) => ({
        proposal_id: stored.id,
        project_id: stored.projectId,
        proposal_revision: stored.revision,
        ordinal: index + 1,
        identity_key: identity(member),
        proposal_key: member.operation === 'create' ? member.key : null,
        milestone_id:
          member.operation === 'create'
            ? reservationId(stored.reservations.milestones, member.key)
            : member.milestoneId,
        canonical: canonicalJson(member),
      })),
    );
    assertNormalized(
      'delivery_plan_proposal_tasks',
      'member_json',
      stored.proposedPlan.tasks.map((member, index) => ({
        proposal_id: stored.id,
        project_id: stored.projectId,
        proposal_revision: stored.revision,
        ordinal: index + 1,
        identity_key: identity(member),
        proposal_key: member.operation === 'create' ? member.key : null,
        task_id:
          member.operation === 'create'
            ? reservationId(stored.reservations.tasks, member.key)
            : member.taskId,
        milestone_identity_key:
          member.operation === 'reuse'
            ? null
            : refIdentity(member.content.milestone),
        canonical: canonicalJson(member),
      })),
    );
    assertNormalized(
      'delivery_plan_proposal_dependencies',
      'member_json',
      stored.proposedPlan.dependencies.map((member, index) => ({
        proposal_id: stored.id,
        project_id: stored.projectId,
        proposal_revision: stored.revision,
        ordinal: index + 1,
        identity_key: identity(member),
        proposal_key: member.operation === 'create' ? member.key : null,
        dependency_id:
          member.operation === 'create'
            ? reservationId(stored.reservations.dependencies, member.key)
            : member.dependencyId,
        prerequisite_task_identity_key:
          member.operation === 'create'
            ? refIdentity(member.prerequisite)
            : null,
        dependent_task_identity_key:
          member.operation === 'create' ? refIdentity(member.dependent) : null,
        canonical: canonicalJson(member),
      })),
    );
    assertNormalized(
      'delivery_plan_proposal_traces',
      'trace_json',
      stored.proposedPlan.traces.map((trace, index) => ({
        proposal_id: stored.id,
        project_id: stored.projectId,
        proposal_revision: stored.revision,
        ordinal: index + 1,
        kind: trace.kind,
        milestone_identity_key:
          trace.kind === 'milestone_covers'
            ? refIdentity(trace.milestone)
            : null,
        task_identity_key:
          trace.kind === 'task_satisfies' ? refIdentity(trace.task) : null,
        record_id: trace.requirement.recordId,
        record_revision: trace.requirement.recordRevision,
        canonical: canonicalJson(trace),
      })),
    );
    const decision = this.database
      .prepare(
        'SELECT * FROM delivery_plan_proposal_decisions WHERE proposal_id = ?',
      )
      .get(id) as ProposalDecisionRow | undefined;
    if (!decision) return stored;
    if (
      decision.proposal_id !== stored.id ||
      decision.planning_cycle_id !== stored.planningCycleId ||
      decision.proposal_revision !== stored.revision ||
      decision.project_id !== stored.projectId ||
      (decision.kind === 'superseded' &&
        (decision.decided_by !== null || decision.feedback !== null)) ||
      (decision.kind === 'approved' &&
        (decision.reason !== null ||
          decision.successor_proposal_id !== null ||
          decision.decided_by !== 'human' ||
          decision.feedback !== null)) ||
      (decision.kind === 'rejected' &&
        (decision.reason !== null ||
          decision.successor_proposal_id !== null ||
          decision.decided_by !== 'human' ||
          decision.feedback === null))
    ) {
      throw new Error('Stored delivery plan proposal decision is corrupt');
    }
    const projectedDecision =
      decision.kind === 'superseded'
        ? {
            kind: 'superseded' as const,
            reason: decision.reason,
            supersededByProposalId: decision.successor_proposal_id,
            decidedAt: decision.decided_at,
          }
        : decision.kind === 'approved'
          ? {
              kind: 'approved' as const,
              decidedBy: 'human' as const,
              decidedAt: decision.decided_at,
            }
          : {
              kind: 'rejected' as const,
              decidedBy: 'human' as const,
              feedback: decision.feedback,
              decidedAt: decision.decided_at,
            };
    const result = deliveryPlanProposalSchema.parse({
      ...stored,
      lifecycle: decision.kind,
      decision: projectedDecision,
    });
    if (
      decision.kind === 'superseded' &&
      decision.reason === 'replacement_accepted'
    ) {
      const successor = this.database
        .prepare(
          `SELECT project_id, planning_cycle_id, revision
           FROM delivery_plan_proposals WHERE id = ?`,
        )
        .get(decision.successor_proposal_id) as
        | { project_id: string; planning_cycle_id: string; revision: number }
        | undefined;
      if (
        !successor ||
        successor.project_id !== stored.projectId ||
        successor.planning_cycle_id !== stored.planningCycleId ||
        successor.revision !== stored.revision + 1
      ) {
        throw new Error('Stored delivery plan proposal decision is corrupt');
      }
    }
    if (
      decision.kind === 'superseded' &&
      decision.reason === 'cycle_abandoned'
    ) {
      const cycle = this.cycle(stored.planningCycleId);
      if (
        cycle?.lifecycle !== 'abandoned' ||
        cycle.endedAt !== decision.decided_at
      ) {
        throw new Error('Stored delivery plan proposal decision is corrupt');
      }
    }
    return result;
  }

  deliveryPlanProposals(cycleId: string): readonly DeliveryPlanProposal[] {
    const rows = this.database
      .prepare(
        `SELECT id FROM delivery_plan_proposals
         WHERE planning_cycle_id = ? ORDER BY revision`,
      )
      .all(cycleId) as { id: string }[];
    return rows.map(({ id }) => {
      const proposal = this.deliveryPlanProposal(id);
      if (!proposal)
        throw new Error('Stored delivery plan proposal is missing');
      return proposal;
    });
  }

  deliveryPlanProposalReservations(proposalId: string) {
    const read = (table: string, idColumn: string) =>
      this.database
        .prepare(
          `SELECT proposal_key AS key, ${idColumn} AS id
           FROM ${table} WHERE proposal_id = ? ORDER BY proposal_key`,
        )
        .all(proposalId) as { key: string; id: string }[];
    return {
      milestones: read(
        'delivery_plan_proposal_milestone_reservations',
        'milestone_id',
      ),
      tasks: read('delivery_plan_proposal_task_reservations', 'task_id'),
      dependencies: read(
        'delivery_plan_proposal_dependency_reservations',
        'dependency_id',
      ),
    };
  }

  settleDeliveryPlanProposalInTransaction(
    proposalId: string,
    decision: Exclude<DeliveryPlanProposal['decision'], { kind: 'pending' }>,
  ): DeliveryPlanProposal {
    this.assertTransaction();
    const proposal = this.deliveryPlanProposal(proposalId);
    if (!proposal || proposal.decision.kind !== 'pending') {
      throw new PlanningProposalInvalidError(
        'Pending delivery plan proposal was not found',
      );
    }
    if (
      decision.kind === 'superseded' &&
      decision.reason === 'replacement_accepted'
    ) {
      const successor = this.deliveryPlanProposal(
        decision.supersededByProposalId,
      );
      if (
        !successor ||
        successor.planningCycleId !== proposal.planningCycleId ||
        successor.revision !== proposal.revision + 1
      ) {
        throw new PlanningProposalInvalidError(
          'Replacement proposal must be the next same-cycle revision',
        );
      }
    }
    if (
      decision.kind === 'superseded' &&
      decision.reason === 'cycle_abandoned'
    ) {
      const cycle = this.cycle(proposal.planningCycleId);
      if (
        cycle?.lifecycle !== 'abandoned' ||
        cycle.endedAt !== decision.decidedAt
      ) {
        throw new PlanningProposalInvalidError(
          'Cycle-abandoned decision requires the matching abandoned cycle',
        );
      }
    }
    this.database
      .prepare(
        `INSERT INTO delivery_plan_proposal_decisions (
          proposal_id, planning_cycle_id, proposal_revision, project_id,
          kind, reason, successor_proposal_id, decided_by, feedback, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.planningCycleId,
        proposal.revision,
        proposal.projectId,
        decision.kind,
        decision.kind === 'superseded' ? decision.reason : null,
        decision.kind === 'superseded' ? decision.supersededByProposalId : null,
        decision.kind === 'approved' || decision.kind === 'rejected'
          ? 'human'
          : null,
        decision.kind === 'rejected' ? decision.feedback : null,
        decision.decidedAt,
      );
    const settled = this.deliveryPlanProposal(proposalId);
    if (!settled) throw new Error('Settled delivery plan proposal is missing');
    return settled;
  }

  applyApprovedDeliveryPlanInTransaction(
    proposalInput: DeliveryPlanProposal,
    deliveryPlanInput: ApprovedDeliveryPlan,
  ): ApprovedDeliveryPlan {
    this.assertTransaction();
    const proposal = this.deliveryPlanProposal(proposalInput.id);
    if (!proposal || proposal.decision.kind !== 'pending') {
      throw new PlanningProposalInvalidError(
        'Pending delivery plan proposal was not found',
      );
    }
    const current = this.approvedDeliveryPlan(proposal.projectId) ?? null;
    const deliveryPlan = approvedDeliveryPlanSchema.parse(deliveryPlanInput);
    approvedDeliveryPlanMaterializationSchema.parse({
      proposal,
      baseDeliveryPlan: current,
      deliveryPlan,
    });
    const currentIntent = this.approvedIntentLedger(proposal.projectId);
    if (
      !currentIntent ||
      currentIntent.projectIntent.id !== proposal.base.projectIntentId ||
      currentIntent.projectIntent.revision !==
        proposal.base.projectIntentRevision ||
      currentIntent.ledger.id !== proposal.base.ledgerId ||
      currentIntent.ledger.revision !== proposal.base.ledgerRevision
    ) {
      throw new PlanningProposalInvalidError(
        'Delivery plan canonical base conflict',
      );
    }
    const requirements = new Map(
      currentIntent.records.flatMap((record) =>
        record.content.type === 'requirement' &&
        record.content.status === 'approved'
          ? [[record.recordId, record.revision] as const]
          : [],
      ),
    );
    if (
      deliveryPlan.traces.some(
        (trace) =>
          requirements.get(trace.requirement.recordId) !==
          trace.requirement.recordRevision,
      )
    ) {
      throw new PlanningProposalInvalidError(
        'Delivery plan trace does not target the current approved ledger',
      );
    }

    if (current === null) {
      this.database
        .prepare(
          `INSERT INTO delivery_plans (
            id, project_id, created_proposal_id, created_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          deliveryPlan.plan.id,
          deliveryPlan.plan.projectId,
          proposal.id,
          deliveryPlan.plan.approvedAt,
        );
    }
    this.database
      .prepare(
        `INSERT INTO delivery_plan_revisions (
          delivery_plan_id, project_id, revision, project_intent_id,
          project_intent_revision, ledger_id, ledger_revision,
          base_delivery_plan_revision, proposal_id, plan_json,
          approved_by, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deliveryPlan.plan.id,
        deliveryPlan.plan.projectId,
        deliveryPlan.plan.revision,
        deliveryPlan.plan.projectIntentId,
        deliveryPlan.plan.projectIntentRevision,
        deliveryPlan.plan.ledgerId,
        deliveryPlan.plan.ledgerRevision,
        deliveryPlan.plan.baseDeliveryPlanRevision,
        proposal.id,
        canonicalJson(deliveryPlan),
        deliveryPlan.plan.approvedBy,
        deliveryPlan.plan.approvedAt,
      );

    const ensureIdentity = (
      table: 'milestones' | 'tasks',
      id: string,
      projectId: string,
      createdAt: string,
    ) => {
      const existing = this.database
        .prepare(`SELECT project_id FROM ${table} WHERE id = ?`)
        .get(id) as { project_id: string } | undefined;
      if (existing && existing.project_id !== projectId) {
        throw new PlanningProposalInvalidError(
          'Canonical identity crosses projects',
        );
      }
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO ${table} (
              id, project_id, created_proposal_id, created_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(id, projectId, proposal.id, createdAt);
      }
    };
    const milestoneMember = this.database.prepare(
      `INSERT INTO delivery_plan_revision_milestones (
        delivery_plan_id, delivery_plan_revision, project_id,
        milestone_id, milestone_revision, ordinal
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, milestone] of deliveryPlan.milestones.entries()) {
      ensureIdentity(
        'milestones',
        milestone.id,
        milestone.projectId,
        milestone.approvedAt,
      );
      if (milestone.proposalId === proposal.id) {
        this.database
          .prepare(
            `INSERT INTO milestone_revisions (
              milestone_id, project_id, revision, lifecycle, revision_json,
              proposal_id, delivery_plan_revision, approved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            milestone.id,
            milestone.projectId,
            milestone.revision,
            milestone.lifecycle,
            canonicalJson(milestone),
            proposal.id,
            milestone.deliveryPlanRevision,
            milestone.approvedAt,
          );
      }
      milestoneMember.run(
        deliveryPlan.plan.id,
        deliveryPlan.plan.revision,
        deliveryPlan.plan.projectId,
        milestone.id,
        milestone.revision,
        index + 1,
      );
    }
    const taskMember = this.database.prepare(
      `INSERT INTO delivery_plan_revision_tasks (
        delivery_plan_id, delivery_plan_revision, project_id,
        task_id, task_contract_revision, ordinal
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, task] of deliveryPlan.taskContracts.entries()) {
      ensureIdentity('tasks', task.id, task.projectId, task.createdAt);
      if (
        task.source.kind === 'plan' &&
        task.source.proposalId === proposal.id
      ) {
        this.insertTaskRevision(task);
      }
      taskMember.run(
        deliveryPlan.plan.id,
        deliveryPlan.plan.revision,
        deliveryPlan.plan.projectId,
        task.id,
        task.contractRevision,
        index + 1,
      );
    }
    const dependencyMember = this.database.prepare(
      `INSERT INTO delivery_plan_revision_dependencies (
        delivery_plan_id, delivery_plan_revision, project_id,
        dependency_id, dependency_revision
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const dependency of deliveryPlan.dependencies) {
      const existing = this.database
        .prepare('SELECT * FROM task_dependencies WHERE id = ?')
        .get(dependency.id) as
        | {
            project_id: string;
            prerequisite_task_id: string;
            dependent_task_id: string;
          }
        | undefined;
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO task_dependencies (
              id, project_id, prerequisite_task_id, dependent_task_id,
              created_proposal_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dependency.id,
            dependency.projectId,
            dependency.prerequisiteTaskId,
            dependency.dependentTaskId,
            proposal.id,
            dependency.approvedAt,
          );
      } else if (
        existing.project_id !== dependency.projectId ||
        existing.prerequisite_task_id !== dependency.prerequisiteTaskId ||
        existing.dependent_task_id !== dependency.dependentTaskId
      ) {
        throw new PlanningProposalInvalidError(
          'Dependency identity endpoints cannot change',
        );
      }
      if (dependency.proposalId === proposal.id) {
        this.database
          .prepare(
            `INSERT INTO task_dependency_revisions (
              dependency_id, project_id, revision, lifecycle, revision_json,
              proposal_id, delivery_plan_revision, approved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dependency.id,
            dependency.projectId,
            dependency.revision,
            dependency.lifecycle,
            canonicalJson(dependency),
            proposal.id,
            dependency.deliveryPlanRevision,
            dependency.approvedAt,
          );
      }
      dependencyMember.run(
        deliveryPlan.plan.id,
        deliveryPlan.plan.revision,
        deliveryPlan.plan.projectId,
        dependency.id,
        dependency.revision,
      );
    }
    const traceInsert = this.database.prepare(
      `INSERT INTO delivery_plan_revision_traces (
        delivery_plan_id, delivery_plan_revision, project_id, ordinal, kind,
        milestone_id, milestone_revision, task_id, task_contract_revision,
        record_id, record_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    deliveryPlan.traces.forEach((trace, index) =>
      traceInsert.run(
        deliveryPlan.plan.id,
        deliveryPlan.plan.revision,
        deliveryPlan.plan.projectId,
        index + 1,
        trace.kind,
        trace.kind === 'milestone_covers' ? trace.milestoneId : null,
        trace.kind === 'milestone_covers' ? trace.milestoneRevision : null,
        trace.kind === 'task_satisfies' ? trace.taskId : null,
        trace.kind === 'task_satisfies' ? trace.taskContractRevision : null,
        trace.requirement.recordId,
        trace.requirement.recordRevision,
      ),
    );
    this.settleDeliveryPlanProposalInTransaction(proposal.id, {
      kind: 'approved',
      decidedBy: 'human',
      decidedAt: deliveryPlan.plan.approvedAt,
    });
    if (!this.boardFilter(proposal.projectId)) {
      const defaultFilter = boardFilterSchema.parse({
        projectId: proposal.projectId,
        revision: 1,
        milestoneIds: [],
        taskLifecycles: ['pending', 'completed'],
        readiness: [],
        priorities: [],
        labels: [],
        requirementRecordIds: [],
        updatedAt: deliveryPlan.plan.approvedAt,
      });
      this.database
        .prepare(
          `INSERT INTO board_filters (
            project_id, revision, filter_json, updated_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          defaultFilter.projectId,
          defaultFilter.revision,
          canonicalJson(defaultFilter),
          defaultFilter.updatedAt,
        );
    }
    return deliveryPlan;
  }

  approvedDeliveryPlan(projectId: string): ApprovedDeliveryPlan | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM delivery_plan_revisions
         WHERE project_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectId) as DeliveryPlanRow | undefined;
    if (!row) return undefined;
    const plan = approvedDeliveryPlanSchema.parse(JSON.parse(row.plan_json));
    if (
      canonicalJson(plan) !== row.plan_json ||
      row.delivery_plan_id !== plan.plan.id ||
      row.project_id !== plan.plan.projectId ||
      row.revision !== plan.plan.revision ||
      row.project_intent_id !== plan.plan.projectIntentId ||
      row.project_intent_revision !== plan.plan.projectIntentRevision ||
      row.ledger_id !== plan.plan.ledgerId ||
      row.ledger_revision !== plan.plan.ledgerRevision ||
      row.base_delivery_plan_revision !== plan.plan.baseDeliveryPlanRevision ||
      row.proposal_id !== plan.plan.proposalId ||
      row.approved_by !== plan.plan.approvedBy ||
      row.approved_at !== plan.plan.approvedAt
    ) {
      throw new Error('Stored delivery plan revision is corrupt');
    }
    const identity = this.database
      .prepare(
        `SELECT p.*, r.proposal_id AS initial_proposal_id,
           r.approved_at AS initial_approved_at
         FROM delivery_plans p
         JOIN delivery_plan_revisions r
           ON r.delivery_plan_id = p.id AND r.revision = 1
         WHERE p.id = ?`,
      )
      .get(plan.plan.id) as
      | {
          id: string;
          project_id: string;
          created_proposal_id: string;
          created_at: string;
          initial_proposal_id: string;
          initial_approved_at: string;
        }
      | undefined;
    if (
      !identity ||
      identity.id !== plan.plan.id ||
      identity.project_id !== plan.plan.projectId ||
      identity.created_proposal_id !== identity.initial_proposal_id ||
      identity.created_at !== identity.initial_approved_at
    ) {
      throw new Error('Stored delivery plan identity is corrupt');
    }
    const milestoneRows = this.database
      .prepare(
        `SELECT m.delivery_plan_id,
            m.delivery_plan_revision AS member_delivery_plan_revision,
            m.project_id AS member_project_id, m.milestone_id AS member_id,
            m.milestone_revision AS member_revision, m.ordinal,
            r.*, i.project_id AS identity_project_id,
            i.created_proposal_id, i.created_at,
            initial.project_id AS initial_project_id,
            initial.revision AS initial_revision,
            initial.lifecycle AS initial_lifecycle,
            initial.proposal_id AS initial_proposal_id,
            initial.delivery_plan_revision AS initial_delivery_plan_revision,
            initial.approved_at AS initial_approved_at,
            initial.revision_json AS initial_revision_json
          FROM delivery_plan_revision_milestones m
          JOIN milestone_revisions r
            ON r.milestone_id = m.milestone_id
           AND r.revision = m.milestone_revision
          JOIN milestones i ON i.id = m.milestone_id
          JOIN milestone_revisions initial
            ON initial.milestone_id = i.id AND initial.revision = 1
         WHERE m.delivery_plan_id = ? AND m.delivery_plan_revision = ?
         ORDER BY m.ordinal`,
      )
      .all(plan.plan.id, plan.plan.revision) as Record<string, unknown>[];
    const taskRows = this.database
      .prepare(
        `SELECT m.delivery_plan_id,
            m.delivery_plan_revision AS member_delivery_plan_revision,
            m.project_id AS member_project_id, m.task_id AS member_id,
            m.task_contract_revision AS member_revision, m.ordinal,
            r.*, i.project_id AS identity_project_id,
            i.created_proposal_id, i.created_at,
            initial.project_id AS initial_project_id,
            initial.revision AS initial_revision,
            initial.contract_revision AS initial_contract_revision,
            initial.revision_kind AS initial_revision_kind,
            initial.lifecycle AS initial_lifecycle,
            initial.milestone_id AS initial_milestone_id,
            initial.revision_json AS initial_revision_json
         FROM delivery_plan_revision_tasks m
         JOIN task_revisions r
           ON r.task_id = m.task_id
          AND r.revision = m.task_contract_revision
          JOIN tasks i ON i.id = m.task_id
          JOIN task_revisions initial
            ON initial.task_id = i.id AND initial.revision = 1
         WHERE m.delivery_plan_id = ? AND m.delivery_plan_revision = ?
         ORDER BY m.ordinal`,
      )
      .all(plan.plan.id, plan.plan.revision) as Record<string, unknown>[];
    const dependencyRows = this.database
      .prepare(
        `SELECT m.delivery_plan_id,
            m.delivery_plan_revision AS member_delivery_plan_revision,
           m.project_id AS member_project_id, m.dependency_id AS member_id,
           m.dependency_revision AS member_revision,
            r.*, i.project_id AS identity_project_id,
            i.prerequisite_task_id, i.dependent_task_id,
            i.created_proposal_id, i.created_at,
            initial.project_id AS initial_project_id,
            initial.revision AS initial_revision,
            initial.lifecycle AS initial_lifecycle,
            initial.proposal_id AS initial_proposal_id,
            initial.delivery_plan_revision AS initial_delivery_plan_revision,
            initial.approved_at AS initial_approved_at,
            initial.revision_json AS initial_revision_json
         FROM delivery_plan_revision_dependencies m
         JOIN task_dependency_revisions r
           ON r.dependency_id = m.dependency_id
          AND r.revision = m.dependency_revision
          JOIN task_dependencies i ON i.id = m.dependency_id
          JOIN task_dependency_revisions initial
            ON initial.dependency_id = i.id AND initial.revision = 1
         WHERE m.delivery_plan_id = ? AND m.delivery_plan_revision = ?
         ORDER BY m.dependency_id`,
      )
      .all(plan.plan.id, plan.plan.revision) as Record<string, unknown>[];
    const milestones = milestoneRows.map((record, index) => {
      const revision = milestoneRevisionSchema.parse(
        JSON.parse(String(record.revision_json)),
      );
      const initialRevision = milestoneRevisionSchema.parse(
        JSON.parse(String(record.initial_revision_json)),
      );
      const expected = plan.milestones[index];
      if (
        !expected ||
        record.delivery_plan_id !== plan.plan.id ||
        record.member_delivery_plan_revision !== plan.plan.revision ||
        record.member_project_id !== plan.plan.projectId ||
        record.member_id !== expected.id ||
        record.member_revision !== expected.revision ||
        record.ordinal !== index + 1 ||
        record.milestone_id !== expected.id ||
        record.project_id !== expected.projectId ||
        record.revision !== expected.revision ||
        record.lifecycle !== expected.lifecycle ||
        record.proposal_id !== expected.proposalId ||
        record.delivery_plan_revision !== expected.deliveryPlanRevision ||
        record.approved_at !== expected.approvedAt ||
        record.identity_project_id !== expected.projectId ||
        initialRevision.id !== expected.id ||
        initialRevision.projectId !== expected.projectId ||
        initialRevision.revision !== 1 ||
        record.initial_project_id !== initialRevision.projectId ||
        record.initial_revision !== initialRevision.revision ||
        record.initial_lifecycle !== initialRevision.lifecycle ||
        record.initial_proposal_id !== initialRevision.proposalId ||
        record.initial_delivery_plan_revision !==
          initialRevision.deliveryPlanRevision ||
        record.initial_approved_at !== initialRevision.approvedAt ||
        record.created_proposal_id !== initialRevision.proposalId ||
        record.created_at !== initialRevision.approvedAt ||
        record.revision_json !== canonicalJson(revision) ||
        record.initial_revision_json !== canonicalJson(initialRevision)
      ) {
        throw new Error('Stored delivery plan members are corrupt');
      }
      return revision;
    });
    const tasks = taskRows.map((record, index) => {
      const revision = taskRevisionSchema.parse(
        JSON.parse(String(record.revision_json)),
      );
      const initialRevision = taskRevisionSchema.parse(
        JSON.parse(String(record.initial_revision_json)),
      );
      const expected = plan.taskContracts[index];
      if (
        !expected ||
        record.delivery_plan_id !== plan.plan.id ||
        record.member_delivery_plan_revision !== plan.plan.revision ||
        record.member_project_id !== plan.plan.projectId ||
        record.member_id !== expected.id ||
        record.member_revision !== expected.contractRevision ||
        record.ordinal !== index + 1 ||
        record.task_id !== expected.id ||
        record.project_id !== expected.projectId ||
        record.revision !== expected.revision ||
        record.contract_revision !== expected.contractRevision ||
        record.revision_kind !== expected.revisionKind ||
        record.lifecycle !== expected.lifecycle ||
        record.milestone_id !== expected.milestoneId ||
        record.identity_project_id !== expected.projectId ||
        initialRevision.id !== expected.id ||
        initialRevision.projectId !== expected.projectId ||
        initialRevision.revision !== 1 ||
        initialRevision.revisionKind !== 'plan_contract' ||
        initialRevision.source.kind !== 'plan' ||
        record.initial_project_id !== initialRevision.projectId ||
        record.initial_revision !== initialRevision.revision ||
        record.initial_contract_revision !== initialRevision.contractRevision ||
        record.initial_revision_kind !== initialRevision.revisionKind ||
        record.initial_lifecycle !== initialRevision.lifecycle ||
        record.initial_milestone_id !== initialRevision.milestoneId ||
        record.created_proposal_id !== initialRevision.source.proposalId ||
        record.created_at !== initialRevision.createdAt ||
        record.revision_json !== canonicalJson(revision) ||
        record.initial_revision_json !== canonicalJson(initialRevision)
      ) {
        throw new Error('Stored delivery plan members are corrupt');
      }
      return revision;
    });
    const expectedDependencies = [...plan.dependencies].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const dependencies = dependencyRows.map((record, index) => {
      const revision = taskDependencyRevisionSchema.parse(
        JSON.parse(String(record.revision_json)),
      );
      const initialRevision = taskDependencyRevisionSchema.parse(
        JSON.parse(String(record.initial_revision_json)),
      );
      const expected = expectedDependencies[index];
      if (
        !expected ||
        record.delivery_plan_id !== plan.plan.id ||
        record.member_delivery_plan_revision !== plan.plan.revision ||
        record.member_project_id !== plan.plan.projectId ||
        record.member_id !== expected.id ||
        record.member_revision !== expected.revision ||
        record.dependency_id !== expected.id ||
        record.project_id !== expected.projectId ||
        record.revision !== expected.revision ||
        record.lifecycle !== expected.lifecycle ||
        record.proposal_id !== expected.proposalId ||
        record.delivery_plan_revision !== expected.deliveryPlanRevision ||
        record.approved_at !== expected.approvedAt ||
        record.identity_project_id !== expected.projectId ||
        record.prerequisite_task_id !== expected.prerequisiteTaskId ||
        record.dependent_task_id !== expected.dependentTaskId ||
        initialRevision.id !== expected.id ||
        initialRevision.projectId !== expected.projectId ||
        initialRevision.revision !== 1 ||
        record.initial_project_id !== initialRevision.projectId ||
        record.initial_revision !== initialRevision.revision ||
        record.initial_lifecycle !== initialRevision.lifecycle ||
        record.initial_proposal_id !== initialRevision.proposalId ||
        record.initial_delivery_plan_revision !==
          initialRevision.deliveryPlanRevision ||
        record.initial_approved_at !== initialRevision.approvedAt ||
        record.created_proposal_id !== initialRevision.proposalId ||
        record.created_at !== initialRevision.approvedAt ||
        record.revision_json !== canonicalJson(revision) ||
        record.initial_revision_json !== canonicalJson(initialRevision)
      ) {
        throw new Error('Stored delivery plan members are corrupt');
      }
      return revision;
    });
    const traceRows = this.database
      .prepare(
        `SELECT delivery_plan_id, delivery_plan_revision, project_id, ordinal,
           kind, milestone_id, milestone_revision, task_id,
           task_contract_revision, record_id, record_revision
         FROM delivery_plan_revision_traces
         WHERE delivery_plan_id = ? AND delivery_plan_revision = ?
         ORDER BY ordinal`,
      )
      .all(plan.plan.id, plan.plan.revision) as {
      kind: 'milestone_covers' | 'task_satisfies';
      delivery_plan_id: string;
      delivery_plan_revision: number;
      project_id: string;
      ordinal: number;
      milestone_id: string | null;
      milestone_revision: number | null;
      task_id: string | null;
      task_contract_revision: number | null;
      record_id: string;
      record_revision: number;
    }[];
    const traces = traceRows.map((trace, index) => {
      if (
        trace.delivery_plan_id !== plan.plan.id ||
        trace.delivery_plan_revision !== plan.plan.revision ||
        trace.project_id !== plan.plan.projectId ||
        trace.ordinal !== index + 1
      ) {
        throw new Error('Stored delivery plan members are corrupt');
      }
      return trace.kind === 'milestone_covers'
        ? {
            kind: trace.kind,
            milestoneId: trace.milestone_id,
            milestoneRevision: trace.milestone_revision,
            requirement: {
              recordId: trace.record_id,
              recordRevision: trace.record_revision,
            },
          }
        : {
            kind: trace.kind,
            taskId: trace.task_id,
            taskContractRevision: trace.task_contract_revision,
            requirement: {
              recordId: trace.record_id,
              recordRevision: trace.record_revision,
            },
          };
    });
    if (
      canonicalJson(milestones) !== canonicalJson(plan.milestones) ||
      canonicalJson(tasks) !== canonicalJson(plan.taskContracts) ||
      canonicalJson(dependencies) !== canonicalJson(expectedDependencies) ||
      canonicalJson(traces) !== canonicalJson(plan.traces)
    ) {
      throw new Error('Stored delivery plan members are corrupt');
    }
    return plan;
  }

  boardFilter(projectId: string): BoardFilter | undefined {
    const row = this.database
      .prepare('SELECT * FROM board_filters WHERE project_id = ?')
      .get(projectId) as BoardFilterRow | undefined;
    if (!row) return undefined;
    const filter = boardFilterSchema.parse(JSON.parse(row.filter_json));
    if (
      row.filter_json !== canonicalJson(filter) ||
      row.project_id !== filter.projectId ||
      row.revision !== filter.revision ||
      row.updated_at !== filter.updatedAt
    ) {
      throw new Error('Stored Board filter is corrupt');
    }
    return filter;
  }

  replaceBoardFilterInTransaction(
    input: BoardFilter,
    expectedRevision: number,
  ): BoardFilter {
    this.assertTransaction();
    const filter = boardFilterSchema.parse(input);
    if (filter.revision !== expectedRevision + 1) {
      throw new Error('Board filter revision conflict');
    }
    const current = this.boardFilter(filter.projectId);
    if (!current || current.revision !== expectedRevision) {
      throw new Error('Board filter revision conflict');
    }
    const plan = this.approvedDeliveryPlan(filter.projectId);
    if (!plan) throw new Error('Approved delivery plan was not found');
    const milestoneIds = new Set([
      ...plan.milestones.map(({ id }) => id),
      ...current.milestoneIds,
    ]);
    if (filter.milestoneIds.some((id) => !milestoneIds.has(id))) {
      throw new Error('Board filter milestone is outside the current plan');
    }
    const ledger = this.approvedIntentLedger(filter.projectId);
    const requirementIds = new Set([
      ...(ledger?.records.flatMap((record) =>
        record.content.type === 'requirement' ? [record.recordId] : [],
      ) ?? []),
      ...current.requirementRecordIds,
    ]);
    if (filter.requirementRecordIds.some((id) => !requirementIds.has(id))) {
      throw new Error('Board filter requirement is outside the current ledger');
    }
    const currentLabels = new Set(
      plan.taskContracts.flatMap(({ labels }) => labels),
    );
    const historicalLabels = new Set(current.labels);
    if (
      filter.labels.some(
        (label) => !currentLabels.has(label) && !historicalLabels.has(label),
      )
    ) {
      throw new Error(
        'Board filter label is not current or previously selected',
      );
    }
    const changed = this.database
      .prepare(
        `UPDATE board_filters SET revision = ?, filter_json = ?, updated_at = ?
         WHERE project_id = ? AND revision = ?`,
      )
      .run(
        filter.revision,
        canonicalJson(filter),
        filter.updatedAt,
        filter.projectId,
        expectedRevision,
      );
    if (changed.changes !== 1)
      throw new Error('Board filter revision conflict');
    return filter;
  }

  appendOperationalTaskLifecycleInTransaction(input: {
    projectId: string;
    expectedDeliveryPlanRevision: number;
    taskId: string;
    expectedContractRevision: number;
    expectedCurrentRevision: number;
    lifecycle: 'pending' | 'completed';
    createdAt: string;
  }): TaskRevision {
    this.assertTransaction();
    const plan = this.approvedDeliveryPlan(input.projectId);
    const anchor = plan?.taskContracts.find(({ id }) => id === input.taskId);
    if (
      !plan ||
      plan.plan.revision !== input.expectedDeliveryPlanRevision ||
      !anchor ||
      anchor.contractRevision !== input.expectedContractRevision
    ) {
      throw new Error('Task lifecycle revision conflict');
    }
    const current = this.currentTaskRevision(
      input.taskId,
      input.expectedContractRevision,
    );
    if (!current || current.revision !== input.expectedCurrentRevision) {
      throw new Error('Task lifecycle revision conflict');
    }
    if (anchor.lifecycle === 'retired') {
      throw new Error(
        'Retired task contract cannot receive lifecycle revisions',
      );
    }
    if (current.lifecycle === input.lifecycle) {
      throw new Error('Task lifecycle transition is unchanged');
    }
    const next = taskRevisionSchema.parse({
      ...current,
      revision: current.revision + 1,
      revisionKind: 'operational_lifecycle',
      lifecycle: input.lifecycle,
      source: { kind: 'lifecycle', priorRevision: current.revision },
      createdAt: input.createdAt,
    });
    this.insertTaskRevision(next);
    return next;
  }

  appendTaskLifecycleRevisionInTransaction(input: {
    projectId: string;
    expectedDeliveryPlanRevision: number;
    taskId: string;
    expectedContractRevision: number;
    expectedCurrentRevision: number;
    lifecycle: 'pending' | 'completed';
    createdAt: string;
  }): TaskRevision {
    return this.appendOperationalTaskLifecycleInTransaction(input);
  }

  currentTaskRevisions(plan: ApprovedDeliveryPlan): readonly TaskRevision[] {
    return plan.taskContracts.map((anchor) => {
      const rows = this.database
        .prepare(
          `SELECT * FROM task_revisions
           WHERE task_id = ? AND contract_revision = ?
           ORDER BY revision`,
        )
        .all(anchor.id, anchor.revision) as TaskRevisionRow[];
      const revisions = rows.map((row) => this.parseTaskRevisionRow(row));
      if (
        revisions.length === 0 ||
        revisions[0].revision !== anchor.revision ||
        revisions[0].revisionKind !== 'plan_contract' ||
        revisions.some(
          (revision, index) =>
            revision.contractRevision !== anchor.revision ||
            revision.revision !== anchor.revision + index ||
            (index > 0 &&
              (revision.revisionKind !== 'operational_lifecycle' ||
                revision.source.kind !== 'lifecycle' ||
                revision.source.priorRevision !== revision.revision - 1)),
        )
      ) {
        throw new Error('Current task revision selection is incomplete');
      }
      return revisions.at(-1)!;
    });
  }

  private currentTaskRevision(
    taskId: string,
    contractRevision: number,
  ): TaskRevision | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM task_revisions
         WHERE task_id = ? AND contract_revision = ?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(taskId, contractRevision) as TaskRevisionRow | undefined;
    return row ? this.parseTaskRevisionRow(row) : undefined;
  }

  private parseTaskRevisionRow(row: TaskRevisionRow): TaskRevision {
    const revision = taskRevisionSchema.parse(JSON.parse(row.revision_json));
    if (
      row.revision_json !== canonicalJson(revision) ||
      row.task_id !== revision.id ||
      row.project_id !== revision.projectId ||
      row.revision !== revision.revision ||
      row.contract_revision !== revision.contractRevision ||
      row.revision_kind !== revision.revisionKind ||
      row.lifecycle !== revision.lifecycle ||
      row.milestone_id !== revision.milestoneId
    ) {
      throw new Error('Stored task revision is corrupt');
    }
    return revision;
  }

  private insertTaskRevision(revisionInput: TaskRevision): void {
    const revision = taskRevisionSchema.parse(revisionInput);
    this.database
      .prepare(
        `INSERT INTO task_revisions (
          task_id, project_id, revision, contract_revision, revision_kind,
          lifecycle, milestone_id, revision_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.id,
        revision.projectId,
        revision.revision,
        revision.contractRevision,
        revision.revisionKind,
        revision.lifecycle,
        revision.milestoneId,
        canonicalJson(revision),
      );
  }

  approvedIntentLedger(projectId: string): ApprovedIntentLedger | undefined {
    const intentRow = this.database
      .prepare(
        `SELECT * FROM project_intent_revisions
         WHERE project_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectId) as IntentRow | undefined;
    const ledgerRow = this.database
      .prepare(
        `SELECT * FROM ledger_revisions
         WHERE project_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(projectId) as LedgerRow | undefined;
    if (!intentRow && !ledgerRow) return undefined;
    if (!intentRow || !ledgerRow)
      throw new Error('Stored intent ledger is incomplete');
    const intentProvenance = this.intentProvenance(
      intentRow.id,
      intentRow.revision,
    );
    const projectIntent = projectIntentRevisionSchema.parse({
      id: intentRow.id,
      projectId: intentRow.project_id,
      revision: intentRow.revision,
      content: {
        ...projectIntentContentSchema
          .omit({ provenance: true })
          .parse(JSON.parse(intentRow.content_json)),
        provenance: intentProvenance,
      },
      proposalId: intentRow.proposal_id,
      approvedBy: intentRow.approved_by,
      approvedAt: intentRow.approved_at,
    });
    const ledger = ledgerRevisionSchema.parse({
      id: ledgerRow.id,
      projectId: ledgerRow.project_id,
      revision: ledgerRow.revision,
      proposalId: ledgerRow.proposal_id,
      approvedBy: ledgerRow.approved_by,
      approvedAt: ledgerRow.approved_at,
    });
    const recordRows = this.database
      .prepare(
        `SELECT r.* FROM ledger_revision_members m
         JOIN ledger_record_revisions r
           ON r.record_id = m.record_id AND r.revision = m.record_revision
         WHERE m.ledger_id = ? AND m.ledger_revision = ?
         ORDER BY m.ordinal`,
      )
      .all(ledger.id, ledger.revision) as RecordRevisionRow[];
    const records = recordRows.map((row) =>
      ledgerRecordRevisionSchema.parse({
        recordId: row.record_id,
        projectId: row.project_id,
        revision: row.revision,
        content: ledgerRecordContentSchema.parse(JSON.parse(row.content_json)),
        provenance: this.recordProvenance(row.record_id, row.revision),
        proposalId: row.proposal_id,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at,
      }),
    );
    const relationships = (
      this.database
        .prepare(
          `SELECT kind, from_record_id, to_record_id
           FROM ledger_revision_relationships
           WHERE ledger_id = ? AND ledger_revision = ? ORDER BY ordinal`,
        )
        .all(ledger.id, ledger.revision) as {
        kind: LedgerRelationship['kind'];
        from_record_id: string;
        to_record_id: string;
      }[]
    ).map((row) =>
      ledgerRelationshipSchema.parse({
        kind: row.kind,
        fromRecordId: row.from_record_id,
        toRecordId: row.to_record_id,
      }),
    );
    return approvedIntentLedgerSchema.parse({
      projectIntent,
      ledger,
      records,
      relationships,
    });
  }

  private insertRecordRevisionInTransaction(
    record: LedgerRecordRevision,
  ): void {
    this.database
      .prepare(
        `INSERT INTO ledger_record_revisions (
          record_id, project_id, revision, content_json,
          proposal_id, approved_by, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.recordId,
        record.projectId,
        record.revision,
        canonicalJson(record.content),
        record.proposalId,
        record.approvedBy,
        record.approvedAt,
      );
    const insert = this.database.prepare(
      `INSERT INTO ledger_record_revision_provenance (
        record_id, record_revision, project_id, turn_id, ordinal, rationale
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    record.provenance.forEach((provenance, index) =>
      insert.run(
        record.recordId,
        record.revision,
        record.projectId,
        provenance.turnId,
        index + 1,
        provenance.rationale,
      ),
    );
  }

  private intentProvenance(id: string, revision: number) {
    return (
      this.database
        .prepare(
          `SELECT turn_id, rationale FROM project_intent_provenance
           WHERE project_intent_id = ? AND project_intent_revision = ?
           ORDER BY ordinal`,
        )
        .all(id, revision) as ProvenanceRow[]
    ).map((row) => ({
      kind: 'conversation_turn' as const,
      turnId: row.turn_id,
      rationale: row.rationale,
    }));
  }

  private recordProvenance(recordId: string, revision: number) {
    return (
      this.database
        .prepare(
          `SELECT turn_id, rationale FROM ledger_record_revision_provenance
           WHERE record_id = ? AND record_revision = ? ORDER BY ordinal`,
        )
        .all(recordId, revision) as ProvenanceRow[]
    ).map((row) => ({
      kind: 'conversation_turn' as const,
      turnId: row.turn_id,
      rationale: row.rationale,
    }));
  }

  private requireCycleView(id: string): PlanningCycleView {
    const view = this.cycleView(id);
    if (!view) throw new Error(`Planning cycle ${id} was not found`);
    return view;
  }

  private assertTransaction(): void {
    if (!this.database.inTransaction) {
      throw new Error('Planning repository transaction is not active');
    }
  }
}
