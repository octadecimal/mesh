import {
  executionRunItemSchema,
  executionRunSchema,
  executionRunViewSchema,
  type ExecutionRun,
  type ExecutionRunItem,
  type ExecutionRunView,
} from '@mesh/v2-contracts';

import type { V2Database } from '../db/database.js';
import { canonicalJson } from '../storage/canonical-json.js';

type RunRow = { id: string; aggregate_json: string };
type ItemRow = { aggregate_json: string };

export class ExecutionRunRevisionConflictError extends Error {
  readonly code = 'execution_run_revision_conflict' as const;

  constructor() {
    super('Execution run revision changed');
  }
}

export class ExecutionRunRepository {
  constructor(private readonly database: V2Database) {}

  view(runId: string): ExecutionRunView | undefined {
    const row = this.database
      .prepare('SELECT id, aggregate_json FROM execution_runs WHERE id = ?')
      .get(runId) as RunRow | undefined;
    return row ? this.toView(row) : undefined;
  }

  listForProject(projectId: string): readonly ExecutionRunView[] {
    const rows = this.database
      .prepare(
        `SELECT id, aggregate_json FROM execution_runs
         WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(projectId) as RunRow[];
    return rows.map((row) => this.toView(row));
  }

  nonterminal(): readonly ExecutionRunView[] {
    const rows = this.database
      .prepare(
        `SELECT id, aggregate_json FROM execution_runs
         WHERE lifecycle <> 'completed' ORDER BY project_id, created_at, id`,
      )
      .all() as RunRow[];
    return rows.map((row) => this.toView(row));
  }

  createInTransaction(input: ExecutionRunView): void {
    this.requireTransaction();
    const view = executionRunViewSchema.parse(input);
    this.insertRun(view.run);
    for (const item of view.items) this.insertItem(item);
  }

  replaceInTransaction(
    input: ExecutionRunView,
    expectedRevision: number,
  ): void {
    this.requireTransaction();
    const view = executionRunViewSchema.parse(input);
    const current = this.view(view.run.id);
    if (!current || current.run.revision !== expectedRevision) {
      throw new ExecutionRunRevisionConflictError();
    }
    if (
      current.run.projectId !== view.run.projectId ||
      canonicalJson(current.run.itemIds) !== canonicalJson(view.run.itemIds)
    ) {
      throw new Error('Execution run frozen identity cannot change');
    }
    for (const [index, item] of view.items.entries()) {
      const before = current.items[index];
      if (
        !before ||
        before.id !== item.id ||
        before.runId !== item.runId ||
        before.projectId !== item.projectId ||
        before.taskId !== item.taskId ||
        before.ordinal !== item.ordinal ||
        before.createdAt !== item.createdAt
      ) {
        throw new Error('Execution run item frozen identity cannot change');
      }
    }
    const changed = this.database
      .prepare(
        `UPDATE execution_runs SET
          revision = @revision, lifecycle = @lifecycle,
          completion_reason = @completionReason, aggregate_json = @aggregateJson,
          updated_at = @updatedAt, ended_at = @endedAt
         WHERE id = @id AND revision = @expectedRevision`,
      )
      .run({
        ...view.run,
        aggregateJson: canonicalJson(view.run),
        expectedRevision,
      });
    if (changed.changes !== 1) throw new ExecutionRunRevisionConflictError();
    const updateItem = this.database.prepare(
      `UPDATE execution_run_items SET
        revision = @revision, lifecycle = @lifecycle,
        developer_attempt_id = @developerAttemptId,
        aggregate_json = @aggregateJson, updated_at = @updatedAt,
        ended_at = @endedAt
       WHERE id = @id AND run_id = @runId`,
    );
    for (const item of view.items) {
      if (
        updateItem.run({
          ...item,
          aggregateJson: canonicalJson(item),
        }).changes !== 1
      ) {
        throw new Error('Execution run item was not found');
      }
    }
  }

  private toView(row: RunRow): ExecutionRunView {
    const run = executionRunSchema.parse(JSON.parse(row.aggregate_json));
    const items = (
      this.database
        .prepare(
          `SELECT aggregate_json FROM execution_run_items
           WHERE run_id = ? ORDER BY ordinal, id`,
        )
        .all(row.id) as ItemRow[]
    ).map((item) =>
      executionRunItemSchema.parse(JSON.parse(item.aggregate_json)),
    );
    return executionRunViewSchema.parse({ run, items });
  }

  private insertRun(run: ExecutionRun): void {
    this.database
      .prepare(
        `INSERT INTO execution_runs (
          id, project_id, revision, lifecycle, completion_reason,
          aggregate_json, created_at, updated_at, ended_at
        ) VALUES (
          @id, @projectId, @revision, @lifecycle, @completionReason,
          @aggregateJson, @createdAt, @updatedAt, @endedAt
        )`,
      )
      .run({ ...run, aggregateJson: canonicalJson(run) });
  }

  private insertItem(item: ExecutionRunItem): void {
    this.database
      .prepare(
        `INSERT INTO execution_run_items (
          id, run_id, project_id, task_id, ordinal, revision, lifecycle,
          developer_attempt_id, aggregate_json, created_at, updated_at, ended_at
        ) VALUES (
          @id, @runId, @projectId, @taskId, @ordinal, @revision, @lifecycle,
          @developerAttemptId, @aggregateJson, @createdAt, @updatedAt, @endedAt
        )`,
      )
      .run({ ...item, aggregateJson: canonicalJson(item) });
  }

  private requireTransaction(): void {
    if (!this.database.inTransaction) {
      throw new Error('Execution run mutation requires a transaction');
    }
  }
}
