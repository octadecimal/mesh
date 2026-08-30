import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  approvedIntentLedgerSchema,
  ledgerRecordContentSchema,
  ledgerRecordRevisionSchema,
  ledgerRelationshipSchema,
  ledgerRevisionSchema,
  planningCycleSchema,
  planningCycleViewSchema,
  planningProposalSchema,
  planningQuestionSchema,
  planningTurnSchema,
  projectIntentContentSchema,
  projectIntentRevisionSchema,
  type ApprovedIntentLedger,
  type LedgerRecordContent,
  type LedgerRecordRevision,
  type LedgerRelationship,
  type PlanningCycle,
  type PlanningCycleView,
  type PlanningProposal,
  type PlanningQuestion,
  type PlanningTurn,
  type ProjectIntentRevision,
} from '@mesh/v2-contracts';

import type { V2Database } from '../db/database.js';
import { canonicalJson } from '../storage/canonical-json.js';

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

export type PlanningSnapshot = Readonly<{
  planningCycles: readonly PlanningCycleView[];
  planningHistoryTruncated: boolean;
  intentLedger: ApprovedIntentLedger | null;
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

  cycleView(id: string): PlanningCycleView | undefined {
    const cycle = this.cycle(id);
    if (!cycle) return undefined;
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
    const proposals = (
      this.database
        .prepare(
          'SELECT * FROM planning_proposals WHERE planning_cycle_id = ? ORDER BY revision',
        )
        .all(id) as ProposalRow[]
    ).map(toProposal);
    return planningCycleViewSchema.parse({
      cycle,
      turns,
      questions,
      proposals,
    });
  }

  planningSnapshot(projectId: string): PlanningSnapshot {
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
    return {
      planningCycles: rows.map((row) => this.requireCycleView(row.id)),
      planningHistoryTruncated: total > rows.length,
      intentLedger: this.approvedIntentLedger(projectId) ?? null,
    };
  }

  pendingLaunchTurns(): readonly PlanningTurn[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM planning_turns
           WHERE launch_state = 'launch_pending'
           ORDER BY created_at, id`,
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

  insertCycleInTransaction(input: PlanningCycle): PlanningCycle {
    this.assertTransaction();
    const cycle = planningCycleSchema.parse(input);
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
  ): readonly { key: string; recordId: string }[] {
    return this.database
      .prepare(
        `SELECT proposal_key AS key, record_id AS recordId
           FROM planning_proposal_records
           WHERE proposal_id = ? ORDER BY proposal_key`,
      )
      .all(proposalId) as { key: string; recordId: string }[];
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
      throw new Error('Planning canonical base conflict');
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
      throw new Error('Planning proposal omitted a canonical ledger member');
    }

    const records: LedgerRecordRevision[] = [];
    for (const member of proposal.records) {
      if (member.operation === 'reuse') {
        const existing = base.get(member.recordId);
        if (!existing || existing.revision !== member.expectedRevision) {
          throw new Error('Planning record revision conflict');
        }
        records.push(existing);
        continue;
      }
      const revision =
        member.operation === 'create' ? 1 : member.expectedRevision + 1;
      if (member.operation === 'revise') {
        const existing = base.get(member.recordId);
        if (
          !existing ||
          existing.revision !== member.expectedRevision ||
          existing.content.type !== member.content.type
        ) {
          throw new Error('Planning record revision conflict');
        }
      } else {
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
      this.insertRecordRevisionInTransaction(record);
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
    this.insertProjectIntentRevisionInTransaction(projectIntent);

    const ledger = ledgerRevisionSchema.parse({
      id: current?.ledger.id ?? randomUUID(),
      projectId: proposal.projectId,
      revision: (current?.ledger.revision ?? 0) + 1,
      proposalId: proposal.id,
      approvedBy: 'human',
      approvedAt,
    });
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

    const reservations = new Map(
      this.proposalRecordReservations(proposal.id).map(({ key, recordId }) => [
        key,
        recordId,
      ]),
    );
    const relationships = proposal.relationships.map((relationship) => {
      const endpoint = (value: typeof relationship.from) =>
        'recordId' in value
          ? value.recordId
          : reservations.get(value.proposalKey);
      const fromRecordId = endpoint(relationship.from);
      const toRecordId = endpoint(relationship.to);
      if (!fromRecordId || !toRecordId) {
        throw new Error('Planning relationship endpoint was not reserved');
      }
      return ledgerRelationshipSchema.parse({
        kind: relationship.kind,
        fromRecordId,
        toRecordId,
      });
    });
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
    return approvedIntentLedgerSchema.parse({
      projectIntent,
      ledger,
      records,
      relationships,
    });
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
