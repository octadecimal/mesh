import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { V2Database } from '../db/database.js';
import { canonicalJson } from '../storage/canonical-json.js';

const operationSchema = z.strictObject({
  id: z.string().uuid(),
  executionId: z.string().uuid(),
  kind: z.enum(['start', 'interrupt']),
  state: z.enum(['pending', 'succeeded', 'failed', 'unknown']),
  request: z.unknown(),
  result: z.unknown().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ExecutionOperation = z.infer<typeof operationSchema>;

type OperationRow = {
  id: string;
  execution_id: string;
  kind: string;
  state: string;
  request_json: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
};

const toOperation = (row: OperationRow): ExecutionOperation =>
  operationSchema.parse({
    id: row.id,
    executionId: row.execution_id,
    kind: row.kind,
    state: row.state,
    request: JSON.parse(row.request_json),
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class OperationRepository {
  constructor(private readonly database: V2Database) {}

  get(id: string): ExecutionOperation | undefined {
    const row = this.database
      .prepare('SELECT * FROM execution_operations WHERE id = ?')
      .get(id) as OperationRow | undefined;
    return row ? toOperation(row) : undefined;
  }

  listForExecution(executionId: string): readonly ExecutionOperation[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM execution_operations WHERE execution_id = ? ORDER BY created_at, id',
        )
        .all(executionId) as OperationRow[]
    ).map(toOperation);
  }

  listPending(): readonly ExecutionOperation[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM execution_operations WHERE state = 'pending' ORDER BY created_at, id",
        )
        .all() as OperationRow[]
    ).map(toOperation);
  }

  createPendingInTransaction(input: {
    executionId: string;
    kind: 'start' | 'interrupt';
    request: unknown;
    createdAt: string;
  }): ExecutionOperation {
    if (!this.database.inTransaction)
      throw new Error('Operation transaction is not active');
    const operation = operationSchema.parse({
      id: randomUUID(),
      executionId: input.executionId,
      kind: input.kind,
      state: 'pending',
      request: input.request,
      result: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    this.database
      .prepare(
        `
      INSERT INTO execution_operations (
        id, execution_id, kind, state, request_json, result_json, created_at, updated_at
      ) VALUES (@id, @executionId, @kind, @state, @requestJson, NULL, @createdAt, @updatedAt)
    `,
      )
      .run({ ...operation, requestJson: canonicalJson(operation.request) });
    return operation;
  }

  finishInTransaction(
    id: string,
    state: 'succeeded' | 'failed' | 'unknown',
    result: unknown,
    updatedAt: string,
  ): ExecutionOperation {
    if (!this.database.inTransaction)
      throw new Error('Operation transaction is not active');
    const changed = this.database
      .prepare(
        `
      UPDATE execution_operations SET state = ?, result_json = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `,
      )
      .run(state, canonicalJson(result), updatedAt, id);
    if (changed.changes !== 1)
      throw new Error('Pending operation was not found');
    const operation = this.get(id);
    if (!operation) throw new Error('Finished operation was not found');
    return operation;
  }
}
