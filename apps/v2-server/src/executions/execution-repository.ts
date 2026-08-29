import {
  projectSchema,
  rawDiagnosticSchema,
  workerExecutionSchema,
  type Project,
  type RawDiagnostic,
  type ExecutionFailure,
  type WorkerExecution,
  type WorkerExecutionLifecycle,
} from '@mesh/v2-contracts';

import type { V2Database } from '../db/database.js';
import { inImmediateTransaction } from '../db/database.js';
import { canonicalJson } from '../storage/canonical-json.js';
import { assertLegalExecutionTransition } from './harness-adapter.js';

type ExecutionRow = {
  id: string;
  project_id: string;
  profile_id: string;
  profile_revision: number;
  assignment_json: string;
  profile_snapshot_json: string;
  skill_requests_json: string;
  resolved_skills_json: string;
  capability_snapshot_json: string;
  adapter_id: string;
  model: string;
  native_handle: string | null;
  lifecycle: string;
  revision: number;
  last_adapter_cursor: number;
  last_runtime_sequence: number;
  replacement_for_execution_id: string | null;
  failure_json: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
};

type RawDiagnosticRow = {
  id: string;
  project_id: string;
  execution_id: string | null;
  adapter_id: string;
  adapter_cursor: number | null;
  received_at: string;
  payload_json: string;
};

export type ExecutionAttentionDetail = Readonly<{
  execution: WorkerExecution;
  evidence: readonly RawDiagnostic[];
}>;

const toExecution = (row: ExecutionRow): WorkerExecution =>
  workerExecutionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    assignment: JSON.parse(row.assignment_json),
    profileSnapshot: JSON.parse(row.profile_snapshot_json),
    skillRequests: JSON.parse(row.skill_requests_json),
    resolvedSkills: JSON.parse(row.resolved_skills_json),
    capabilitySnapshot: JSON.parse(row.capability_snapshot_json),
    adapterId: row.adapter_id,
    model: row.model,
    nativeHandle: row.native_handle,
    lifecycle: row.lifecycle,
    revision: row.revision,
    lastAdapterCursor: row.last_adapter_cursor,
    lastRuntimeSequence: row.last_runtime_sequence,
    replacementForExecutionId: row.replacement_for_execution_id,
    failure: row.failure_json === null ? null : JSON.parse(row.failure_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  });

const values = (execution: WorkerExecution) => ({
  ...execution,
  assignmentJson: canonicalJson(execution.assignment),
  profileSnapshotJson: canonicalJson(execution.profileSnapshot),
  skillRequestsJson: canonicalJson(execution.skillRequests),
  resolvedSkillsJson: canonicalJson(execution.resolvedSkills),
  capabilitySnapshotJson: canonicalJson(execution.capabilitySnapshot),
  failureJson:
    execution.failure === null ? null : canonicalJson(execution.failure),
});

const terminal = new Set<WorkerExecutionLifecycle>([
  'completed',
  'failed',
  'interrupted',
]);

export class ExecutionRepository {
  constructor(private readonly database: V2Database) {}

  get(id: string): WorkerExecution | undefined {
    const row = this.database
      .prepare('SELECT * FROM worker_executions WHERE id = ?')
      .get(id) as ExecutionRow | undefined;
    return row ? toExecution(row) : undefined;
  }

  getProject(id: string): Project | undefined {
    const row = this.database
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as
      | {
          id: string;
          display_name: string;
          repository_identity: string;
          repository_path: string;
          git_common_directory: string;
          head_commit: string;
          revision: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? projectSchema.parse({
          id: row.id,
          displayName: row.display_name,
          repositoryIdentity: row.repository_identity,
          repositoryPath: row.repository_path,
          gitCommonDirectory: row.git_common_directory,
          headCommit: row.head_commit,
          revision: row.revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : undefined;
  }

  transaction<T>(work: () => T): T {
    return inImmediateTransaction(this.database, work);
  }

  list(projectId: string): readonly WorkerExecution[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM worker_executions WHERE project_id = ? ORDER BY created_at, id',
        )
        .all(projectId) as ExecutionRow[]
    ).map(toExecution);
  }

  listOpen(): readonly WorkerExecution[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM worker_executions WHERE lifecycle IN ('created','starting','running','interrupting') ORDER BY created_at, id",
        )
        .all() as ExecutionRow[]
    ).map(toExecution);
  }

  listAttentionDetails(
    projectId?: string,
  ): readonly ExecutionAttentionDetail[] {
    const rows = (
      projectId === undefined
        ? this.database
            .prepare(
              `SELECT * FROM worker_executions
             WHERE lifecycle = 'attention_required'
             ORDER BY created_at, id`,
            )
            .all()
        : this.database
            .prepare(
              `SELECT * FROM worker_executions
             WHERE lifecycle = 'attention_required' AND project_id = ?
             ORDER BY created_at, id`,
            )
            .all(projectId)
    ) as ExecutionRow[];
    return Object.freeze(
      rows.map((row) => {
        const execution = Object.freeze(toExecution(row));
        const evidenceRows = this.database
          .prepare(
            `SELECT * FROM raw_diagnostics
             WHERE execution_id = ? AND adapter_cursor IS NULL
             ORDER BY received_at,
               COALESCE(json_extract(payload_json, '$.operationOrder'), -1),
               id`,
          )
          .all(execution.id) as RawDiagnosticRow[];
        const evidence = Object.freeze(
          evidenceRows.map((diagnostic) =>
            Object.freeze(
              rawDiagnosticSchema.parse({
                id: diagnostic.id,
                projectId: diagnostic.project_id,
                executionId: diagnostic.execution_id,
                adapterId: diagnostic.adapter_id,
                adapterCursor: diagnostic.adapter_cursor,
                receivedAt: diagnostic.received_at,
                payload: JSON.parse(diagnostic.payload_json),
              }),
            ),
          ),
        );
        return Object.freeze({ execution, evidence });
      }),
    );
  }

  insertInTransaction(input: WorkerExecution): WorkerExecution {
    if (!this.database.inTransaction)
      throw new Error('Execution transaction is not active');
    const execution = workerExecutionSchema.parse(input);
    this.database
      .prepare(
        `
      INSERT INTO worker_executions (
        id, project_id, profile_id, profile_revision, assignment_json,
        profile_snapshot_json, skill_requests_json, resolved_skills_json,
        capability_snapshot_json, adapter_id, model, native_handle, lifecycle,
        revision, last_adapter_cursor, last_runtime_sequence,
        replacement_for_execution_id, failure_json, created_at, updated_at, ended_at
      ) VALUES (
        @id, @projectId, @profileId, @profileRevision, @assignmentJson,
        @profileSnapshotJson, @skillRequestsJson, @resolvedSkillsJson,
        @capabilitySnapshotJson, @adapterId, @model, @nativeHandle, @lifecycle,
        @revision, @lastAdapterCursor, @lastRuntimeSequence,
        @replacementForExecutionId, @failureJson, @createdAt, @updatedAt, @endedAt
      )
    `,
      )
      .run(values(execution));
    return execution;
  }

  updateInTransaction(
    input: WorkerExecution,
    expectedRevision: number,
  ): WorkerExecution {
    if (!this.database.inTransaction)
      throw new Error('Execution transaction is not active');
    const execution = workerExecutionSchema.parse(input);
    const result = this.database
      .prepare(
        `
      UPDATE worker_executions SET
        native_handle = @nativeHandle, lifecycle = @lifecycle,
        revision = @revision, last_adapter_cursor = @lastAdapterCursor,
        last_runtime_sequence = @lastRuntimeSequence,
        resolved_skills_json = @resolvedSkillsJson,
        capability_snapshot_json = @capabilitySnapshotJson,
        failure_json = @failureJson, updated_at = @updatedAt, ended_at = @endedAt
      WHERE id = @id AND revision = @expectedRevision
    `,
      )
      .run({ ...values(execution), expectedRevision });
    if (result.changes !== 1) throw new Error('Execution revision conflict');
    return execution;
  }

  transitionInTransaction(
    id: string,
    expectedRevision: number,
    lifecycle: WorkerExecutionLifecycle,
    updatedAt: string,
    changes: {
      nativeHandle?: string | null;
      failure?: ExecutionFailure | null;
    } = {},
  ): WorkerExecution {
    const current = this.get(id);
    if (!current) throw new Error('Execution was not found');
    if (current.revision !== expectedRevision)
      throw new Error('Execution revision conflict');
    assertLegalExecutionTransition(current.lifecycle, lifecycle);
    return this.updateInTransaction(
      {
        ...current,
        ...changes,
        lifecycle,
        revision: current.revision + 1,
        updatedAt,
        endedAt: terminal.has(lifecycle) ? updatedAt : null,
      },
      expectedRevision,
    );
  }
}
