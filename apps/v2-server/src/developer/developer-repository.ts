import {
  developerAttemptSchema,
  developerReportRecordSchema,
  runtimeEventSchema,
  type DeveloperAttempt,
  type DeveloperReportRecord,
  type ManagedWorkspace,
  type WorkerExecutionStructuredOutputRuntimeEvent,
} from '@mesh/v2-contracts';
import { z } from 'zod';

import type { V2Database } from '../db/database.js';
import { canonicalJson } from '../storage/canonical-json.js';

type AttemptRow = {
  id: string;
  project_id: string;
  task_id: string;
  ordinal: number;
  lifecycle: string;
  revision: number;
  delivery_plan_id: string;
  delivery_plan_revision: number;
  intent_revision: number;
  ledger_revision: number;
  task_contract_revision: number;
  task_current_revision: number;
  requirement_revisions_json: string;
  base_commit: string;
  profile_id: string;
  profile_revision: number;
  assignment_json: string;
  controlling_execution_id: string | null;
  attention_json: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
};

type WorkspaceRow = {
  attempt_id: string;
  repository_path: string;
  repository_identity: string;
  branch: string;
  path: string;
  base_commit: string;
  lifecycle: string;
  ownership_token: string;
  observed_head: string | null;
  observed_dirty: number | null;
  failure_json: string | null;
  revision: number;
  workspace_json: string;
  created_at: string;
  updated_at: string;
};

type ReportRow = {
  id: string;
  attempt_id: string;
  execution_id: string;
  report_json: string;
  recorded_at: string;
};

type RuntimeEventRow = {
  id: string;
  project_id: string;
  execution_id: string;
  diagnostic_id: string;
  sequence: number;
  adapter_cursor: number;
  occurred_at: string;
  type: string;
  payload_json: string;
};

const outputReceiptSchema = z
  .strictObject({
    runtimeEventId: z.string().uuid(),
    projectId: z.string().uuid(),
    attemptId: z.string().uuid(),
    executionId: z.string().uuid(),
    outputDigest: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(['accepted', 'rejected']),
    rejectionReason: z.string().trim().min(1).max(4096).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if ((value.status === 'rejected') !== (value.rejectionReason !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['rejectionReason'],
        message: 'Rejected output receipts require a rejection reason',
      });
    }
  });

export type DeveloperOutputReceipt = z.infer<typeof outputReceiptSchema>;

type OutputReceiptRow = {
  runtime_event_id: string;
  project_id: string;
  attempt_id: string;
  execution_id: string;
  output_digest: string;
  status: 'accepted' | 'rejected';
  rejection_reason: string | null;
  created_at: string;
};

const linkInputSchema = z.strictObject({
  attemptId: z.string().uuid(),
  executionId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
});

export class DeveloperAttemptConflictError extends Error {
  readonly code = 'developer_attempt_conflict' as const;

  constructor() {
    super('Developer attempt already controls task');
  }
}

const parseJson = (value: string): unknown => JSON.parse(value);

export class DeveloperRepository {
  constructor(private readonly database: V2Database) {}

  attempt(id: string): DeveloperAttempt | undefined {
    const row = this.database
      .prepare('SELECT * FROM developer_attempts WHERE id = ?')
      .get(id) as AttemptRow | undefined;
    return row ? this.toAttempt(row) : undefined;
  }

  attemptsForProject(projectId: string): readonly DeveloperAttempt[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM developer_attempts
         WHERE project_id = ? ORDER BY created_at, ordinal, id`,
      )
      .all(projectId) as AttemptRow[];
    return rows.map((row) => this.toAttempt(row));
  }

  reportsForProject(projectId: string): readonly DeveloperReportRecord[] {
    const rows = this.database
      .prepare(
        `SELECT r.* FROM developer_reports r
         JOIN developer_attempts a ON a.id = r.attempt_id
         WHERE a.project_id = ?
         ORDER BY a.created_at, a.ordinal, r.ordinal`,
      )
      .all(projectId) as ReportRow[];
    return rows.map((row) => this.toReport(row));
  }

  outputReceipt(runtimeEventId: string): DeveloperOutputReceipt | undefined {
    const row = this.database
      .prepare(
        'SELECT * FROM developer_output_receipts WHERE runtime_event_id = ?',
      )
      .get(runtimeEventId) as OutputReceiptRow | undefined;
    return row ? this.toOutputReceipt(row) : undefined;
  }

  unreceiptedStructuredOutputs(): readonly WorkerExecutionStructuredOutputRuntimeEvent[] {
    const rows = this.database
      .prepare(
        `SELECT e.* FROM runtime_events e
         JOIN developer_attempt_executions a ON a.execution_id = e.execution_id
         LEFT JOIN developer_output_receipts r ON r.runtime_event_id = e.id
         WHERE e.type = 'worker_execution.structured_output'
           AND r.runtime_event_id IS NULL
         ORDER BY e.project_id, e.sequence, e.id`,
      )
      .all() as RuntimeEventRow[];
    return rows.map((row) => {
      const event = runtimeEventSchema.parse({
        id: row.id,
        projectId: row.project_id,
        executionId: row.execution_id,
        diagnosticId: row.diagnostic_id,
        sequence: row.sequence,
        adapterCursor: row.adapter_cursor,
        occurredAt: row.occurred_at,
        type: row.type,
        payload: parseJson(row.payload_json),
      });
      if (event.type !== 'worker_execution.structured_output') {
        throw new Error(
          'Developer output recovery selected a non-output event',
        );
      }
      return event;
    });
  }

  nonterminalAttempts(): readonly DeveloperAttempt[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM developer_attempts
         WHERE lifecycle NOT IN ('completed', 'blocked', 'attention_required')
         ORDER BY created_at, ordinal, id`,
      )
      .all() as AttemptRow[];
    return rows.map((row) => this.toAttempt(row));
  }

  reserveAttemptInTransaction(input: DeveloperAttempt): DeveloperAttempt {
    this.assertTransaction();
    const attempt = developerAttemptSchema.parse(input);
    this.assertReservation(attempt);
    const previous = this.database
      .prepare(
        `SELECT COALESCE(MAX(ordinal), 0) AS ordinal
         FROM developer_attempts WHERE project_id = ? AND task_id = ?`,
      )
      .get(attempt.projectId, attempt.taskId) as { ordinal: number };
    if (attempt.ordinal !== previous.ordinal + 1) {
      throw new Error('Developer attempt ordinal is not monotonic');
    }

    try {
      this.database
        .prepare(
          `INSERT INTO developer_attempts (
            id, project_id, task_id, ordinal, lifecycle, revision,
            delivery_plan_id, delivery_plan_revision, intent_revision,
            ledger_revision, task_contract_revision, task_current_revision,
            requirement_revisions_json, base_commit, profile_id, profile_revision,
            assignment_json, controlling_execution_id, attention_json,
            created_at, updated_at, ended_at
          ) VALUES (
            @id, @projectId, @taskId, @ordinal, @lifecycle, @revision,
            @deliveryPlanId, @deliveryPlanRevision, @intentRevision,
            @ledgerRevision, @taskContractRevision, @taskCurrentRevision,
            @requirementRevisionsJson, @baseCommit, @profileId, @profileRevision,
            @assignmentJson, NULL, NULL, @createdAt, @updatedAt, NULL
          )`,
        )
        .run(this.attemptValues(attempt));
    } catch (error) {
      if (
        error instanceof Error &&
        /developer_attempts\.project_id, developer_attempts\.task_id/i.test(
          error.message,
        )
      ) {
        throw new DeveloperAttemptConflictError();
      }
      throw error;
    }

    this.database
      .prepare(
        `INSERT INTO developer_workspaces (
          attempt_id, repository_path, repository_identity, branch, path,
          base_commit, lifecycle, ownership_token, observed_head, observed_dirty,
          failure_json, revision, workspace_json, created_at, updated_at
        ) VALUES (
          @attemptId, @repositoryPath, @repositoryIdentity, @branch, @path,
          @baseCommit, @lifecycle, @ownershipToken, @observedHead, @observedDirty,
          @failureJson, @revision, @workspaceJson, @createdAt, @updatedAt
        )`,
      )
      .run(this.workspaceValues(attempt.workspace));
    this.database
      .prepare(
        `INSERT INTO developer_workspace_operations (
          attempt_id, ordinal, kind, state, request_json, observation_json,
          created_at, updated_at
        ) VALUES (?, 1, 'create', 'creating', ?, NULL, ?, ?)`,
      )
      .run(
        attempt.id,
        canonicalJson(attempt.workspace),
        attempt.createdAt,
        attempt.updatedAt,
      );
    return attempt;
  }

  transitionAttemptInTransaction(
    input: DeveloperAttempt,
    expectedRevision: number,
  ): DeveloperAttempt {
    this.assertTransaction();
    const next = developerAttemptSchema.parse(input);
    const current = this.requireAttempt(next.id);
    if (
      current.revision !== expectedRevision ||
      next.revision !== expectedRevision + 1
    ) {
      throw new Error('Developer attempt revision conflict');
    }
    if (
      canonicalJson(next.workspace) !== canonicalJson(current.workspace) ||
      canonicalJson(next.executionIds) !==
        canonicalJson(current.executionIds) ||
      canonicalJson(next.reportIds) !== canonicalJson(current.reportIds)
    ) {
      throw new Error('Developer attempt transition changes child projection');
    }
    if (
      next.controllingExecutionId !== null &&
      !current.executionIds.includes(next.controllingExecutionId)
    ) {
      throw new Error('Developer attempt controlling execution must be linked');
    }
    const unchanged = developerAttemptSchema.parse({
      ...next,
      lifecycle: current.lifecycle,
      revision: current.revision,
      attention: current.attention,
      updatedAt: current.updatedAt,
      endedAt: current.endedAt,
    });
    if (canonicalJson(unchanged) !== canonicalJson(current)) {
      throw new Error('Developer attempt transition changes frozen state');
    }
    const changed = this.database
      .prepare(
        `UPDATE developer_attempts SET
          lifecycle = @lifecycle, revision = @revision,
          controlling_execution_id = @controllingExecutionId,
          attention_json = @attentionJson, updated_at = @updatedAt,
          ended_at = @endedAt
         WHERE id = @id AND revision = @expectedRevision`,
      )
      .run({
        ...this.attemptValues(next),
        expectedRevision,
      });
    if (changed.changes !== 1)
      throw new Error('Developer attempt revision conflict');
    return this.requireAttempt(next.id);
  }

  recordWorkspaceObservationInTransaction(
    input: ManagedWorkspace,
    expectedRevision: number,
  ): ManagedWorkspace {
    this.assertTransaction();
    const next = developerAttemptSchema.shape.workspace.parse(input);
    const current = this.requireAttempt(next.attemptId).workspace;
    if (
      current.revision !== expectedRevision ||
      next.revision !== expectedRevision + 1
    ) {
      throw new Error('Developer workspace revision conflict');
    }
    const immutable = {
      ...next,
      lifecycle: current.lifecycle,
      observedHead: current.observedHead,
      observedDirty: current.observedDirty,
      failure: current.failure,
      revision: current.revision,
      updatedAt: current.updatedAt,
    };
    if (canonicalJson(immutable) !== canonicalJson(current)) {
      throw new Error('Developer workspace observation changes frozen state');
    }
    const changed = this.database
      .prepare(
        `UPDATE developer_workspaces SET
          repository_path = @repositoryPath, repository_identity = @repositoryIdentity,
          branch = @branch, path = @path, base_commit = @baseCommit,
          lifecycle = @lifecycle, ownership_token = @ownershipToken,
          observed_head = @observedHead, observed_dirty = @observedDirty,
          failure_json = @failureJson, revision = @revision,
          workspace_json = @workspaceJson, updated_at = @updatedAt
         WHERE attempt_id = @attemptId AND revision = @expectedRevision`,
      )
      .run({ ...this.workspaceValues(next), expectedRevision });
    if (changed.changes !== 1)
      throw new Error('Developer workspace revision conflict');
    const state =
      next.lifecycle === 'ready'
        ? 'succeeded'
        : next.lifecycle === 'attention_required'
          ? 'attention_required'
          : 'creating';
    this.database
      .prepare(
        `UPDATE developer_workspace_operations SET
          state = ?, observation_json = ?, updated_at = ?
         WHERE attempt_id = ? AND ordinal = 1`,
      )
      .run(state, canonicalJson(next), next.updatedAt, next.attemptId);
    return next;
  }

  linkExecutionInTransaction(input: {
    attemptId: string;
    executionId: string;
    expectedRevision: number;
    updatedAt: string;
  }): DeveloperAttempt {
    this.assertTransaction();
    const link = linkInputSchema.parse(input);
    const current = this.requireAttempt(link.attemptId);
    if (current.revision !== link.expectedRevision) {
      throw new Error('Developer attempt revision conflict');
    }
    const ordinal = (
      this.database
        .prepare(
          `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
           FROM developer_attempt_executions WHERE attempt_id = ?`,
        )
        .get(current.id) as { ordinal: number }
    ).ordinal;
    this.database
      .prepare(
        `INSERT INTO developer_attempt_executions (
          attempt_id, project_id, execution_id, ordinal, linked_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        current.id,
        current.projectId,
        link.executionId,
        ordinal,
        link.updatedAt,
      );
    const changed = this.database
      .prepare(
        `UPDATE developer_attempts SET
          controlling_execution_id = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        link.executionId,
        current.revision + 1,
        link.updatedAt,
        current.id,
        current.revision,
      );
    if (changed.changes !== 1)
      throw new Error('Developer attempt revision conflict');
    return this.requireAttempt(current.id);
  }

  insertReportInTransaction(
    input: DeveloperReportRecord,
  ): DeveloperReportRecord {
    this.assertTransaction();
    const report = developerReportRecordSchema.parse(input);
    const attempt = this.requireAttempt(report.report.attemptId);
    if (
      report.report.taskId !== attempt.taskId ||
      report.report.taskContractRevision !== attempt.taskContractRevision ||
      !attempt.executionIds.includes(report.report.executionId)
    ) {
      throw new Error('Developer report does not match persisted attempt');
    }
    const ordinal = (
      this.database
        .prepare(
          `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
           FROM developer_reports WHERE attempt_id = ?`,
        )
        .get(attempt.id) as { ordinal: number }
    ).ordinal;
    this.database
      .prepare(
        `INSERT INTO developer_reports (
          id, attempt_id, execution_id, ordinal, report_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        attempt.id,
        report.report.executionId,
        ordinal,
        canonicalJson(report.report),
        report.recordedAt,
      );
    return report;
  }

  recordOutputReceiptInTransaction(
    input: DeveloperOutputReceipt,
  ): DeveloperOutputReceipt {
    this.assertTransaction();
    const receipt = outputReceiptSchema.parse(input);
    const existing = this.outputReceipt(receipt.runtimeEventId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        throw new Error(
          'Developer output receipt conflicts with prior receipt',
        );
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO developer_output_receipts (
          runtime_event_id, project_id, attempt_id, execution_id,
          output_digest, status, rejection_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.runtimeEventId,
        receipt.projectId,
        receipt.attemptId,
        receipt.executionId,
        receipt.outputDigest,
        receipt.status,
        receipt.rejectionReason,
        receipt.createdAt,
      );
    return receipt;
  }

  private toAttempt(row: AttemptRow): DeveloperAttempt {
    const workspaceRow = this.database
      .prepare('SELECT * FROM developer_workspaces WHERE attempt_id = ?')
      .get(row.id) as WorkspaceRow | undefined;
    if (!workspaceRow) throw new Error('Stored developer workspace is missing');
    const workspace = developerAttemptSchema.shape.workspace.parse(
      parseJson(workspaceRow.workspace_json),
    );
    const executionIds = (
      this.database
        .prepare(
          `SELECT execution_id FROM developer_attempt_executions
           WHERE attempt_id = ? ORDER BY ordinal`,
        )
        .all(row.id) as { execution_id: string }[]
    ).map(({ execution_id }) => execution_id);
    const reportIds = (
      this.database
        .prepare(
          `SELECT id FROM developer_reports WHERE attempt_id = ? ORDER BY ordinal`,
        )
        .all(row.id) as { id: string }[]
    ).map(({ id }) => id);
    const attempt = developerAttemptSchema.parse({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      ordinal: row.ordinal,
      lifecycle: row.lifecycle,
      revision: row.revision,
      deliveryPlanId: row.delivery_plan_id,
      deliveryPlanRevision: row.delivery_plan_revision,
      intentRevision: row.intent_revision,
      ledgerRevision: row.ledger_revision,
      taskContractRevision: row.task_contract_revision,
      taskCurrentRevision: row.task_current_revision,
      requirementRevisions: parseJson(row.requirement_revisions_json),
      baseCommit: row.base_commit,
      profileId: row.profile_id,
      profileRevision: row.profile_revision,
      assignment: parseJson(row.assignment_json),
      workspace,
      controllingExecutionId: row.controlling_execution_id,
      executionIds,
      reportIds,
      attention:
        row.attention_json === null ? null : parseJson(row.attention_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
    });
    if (
      canonicalJson(attempt.assignment) !== row.assignment_json ||
      canonicalJson(attempt.requirementRevisions) !==
        row.requirement_revisions_json ||
      canonicalJson(workspace) !== workspaceRow.workspace_json ||
      workspace.attemptId !== attempt.id ||
      workspace.repositoryPath !== workspaceRow.repository_path ||
      workspace.repositoryIdentity !== workspaceRow.repository_identity ||
      workspace.branch !== workspaceRow.branch ||
      workspace.path !== workspaceRow.path ||
      workspace.baseCommit !== workspaceRow.base_commit ||
      workspace.lifecycle !== workspaceRow.lifecycle ||
      workspace.ownershipToken !== workspaceRow.ownership_token ||
      workspace.observedHead !== workspaceRow.observed_head ||
      (workspace.observedDirty === null
        ? null
        : Number(workspace.observedDirty)) !== workspaceRow.observed_dirty ||
      canonicalJson(workspace.failure) !==
        canonicalJson(
          workspaceRow.failure_json === null
            ? null
            : parseJson(workspaceRow.failure_json),
        ) ||
      workspace.revision !== workspaceRow.revision ||
      workspace.createdAt !== workspaceRow.created_at ||
      workspace.updatedAt !== workspaceRow.updated_at ||
      attempt.assignment.attemptId !== attempt.id ||
      attempt.assignment.projectId !== attempt.projectId ||
      attempt.assignment.taskId !== attempt.taskId ||
      attempt.assignment.deliveryPlanId !== attempt.deliveryPlanId ||
      attempt.assignment.deliveryPlanRevision !==
        attempt.deliveryPlanRevision ||
      attempt.assignment.taskContractRevision !==
        attempt.taskContractRevision ||
      attempt.assignment.taskCurrentRevision !== attempt.taskCurrentRevision ||
      attempt.assignment.baseCommit !== attempt.baseCommit ||
      canonicalJson(attempt.assignment.requirementRevisions) !==
        canonicalJson(attempt.requirementRevisions) ||
      (attempt.controllingExecutionId !== null &&
        !attempt.executionIds.includes(attempt.controllingExecutionId))
    ) {
      throw new Error('Stored developer attempt is corrupt');
    }
    return attempt;
  }

  private toReport(row: ReportRow): DeveloperReportRecord {
    const report = developerReportRecordSchema.parse({
      id: row.id,
      report: parseJson(row.report_json),
      recordedAt: row.recorded_at,
    });
    if (canonicalJson(report.report) !== row.report_json) {
      throw new Error('Stored developer report is not canonical');
    }
    const attempt = this.requireAttempt(row.attempt_id);
    if (
      report.report.attemptId !== row.attempt_id ||
      report.report.executionId !== row.execution_id ||
      report.report.taskId !== attempt.taskId ||
      report.report.taskContractRevision !== attempt.taskContractRevision
    ) {
      throw new Error('Stored developer report is corrupt');
    }
    return report;
  }

  private toOutputReceipt(row: OutputReceiptRow): DeveloperOutputReceipt {
    return outputReceiptSchema.parse({
      runtimeEventId: row.runtime_event_id,
      projectId: row.project_id,
      attemptId: row.attempt_id,
      executionId: row.execution_id,
      outputDigest: row.output_digest,
      status: row.status,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
    });
  }

  private attemptValues(attempt: DeveloperAttempt) {
    return {
      ...attempt,
      requirementRevisionsJson: canonicalJson(attempt.requirementRevisions),
      assignmentJson: canonicalJson(attempt.assignment),
      attentionJson:
        attempt.attention === null ? null : canonicalJson(attempt.attention),
    };
  }

  private workspaceValues(workspace: ManagedWorkspace) {
    return {
      ...workspace,
      observedDirty:
        workspace.observedDirty === null
          ? null
          : Number(workspace.observedDirty),
      failureJson:
        workspace.failure === null ? null : canonicalJson(workspace.failure),
      workspaceJson: canonicalJson(workspace),
    };
  }

  private assertReservation(attempt: DeveloperAttempt): void {
    if (
      attempt.lifecycle !== 'reserved' ||
      attempt.revision !== 0 ||
      attempt.workspace.lifecycle !== 'creating' ||
      attempt.workspace.revision !== 0 ||
      attempt.controllingExecutionId !== null ||
      attempt.executionIds.length !== 0 ||
      attempt.reportIds.length !== 0 ||
      attempt.attention !== null ||
      attempt.endedAt !== null ||
      attempt.assignment.attemptId !== attempt.id ||
      attempt.assignment.projectId !== attempt.projectId ||
      attempt.assignment.taskId !== attempt.taskId ||
      attempt.assignment.deliveryPlanId !== attempt.deliveryPlanId ||
      attempt.assignment.deliveryPlanRevision !==
        attempt.deliveryPlanRevision ||
      attempt.assignment.taskContractRevision !==
        attempt.taskContractRevision ||
      attempt.assignment.taskCurrentRevision !== attempt.taskCurrentRevision ||
      attempt.assignment.baseCommit !== attempt.baseCommit ||
      attempt.workspace.attemptId !== attempt.id ||
      attempt.workspace.baseCommit !== attempt.baseCommit ||
      canonicalJson(attempt.assignment.requirementRevisions) !==
        canonicalJson(attempt.requirementRevisions)
    ) {
      throw new Error('Developer attempt reservation is inconsistent');
    }
  }

  private requireAttempt(id: string): DeveloperAttempt {
    const attempt = this.attempt(id);
    if (!attempt) throw new Error('Developer attempt was not found');
    return attempt;
  }

  private assertTransaction(): void {
    if (!this.database.inTransaction) {
      throw new Error('Developer repository transaction is not active');
    }
  }
}
