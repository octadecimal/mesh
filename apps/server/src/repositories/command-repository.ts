import { randomUUID } from 'node:crypto';

import type { Database } from '../db/database.js';

type CommandState = 'pending' | 'completed' | 'failed' | 'indeterminate';

type CommandRow = {
  state: CommandState;
  response_json: string | null;
};

const assertJsonSafe = (value: unknown, ancestors = new Set<object>()): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError('Command response must be JSON-safe');
  }
  if (typeof value !== 'object') throw new TypeError('Command response must be JSON-safe');
  if (ancestors.has(value)) throw new TypeError('Command response must be JSON-safe');
  if (Array.isArray(value)) {
    ancestors.add(value);
    for (const item of value) assertJsonSafe(item, ancestors);
    ancestors.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('Command response must be JSON-safe');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Command response must be JSON-safe');
  }
  ancestors.add(value);
  for (const property of Object.values(value)) assertJsonSafe(property, ancestors);
  ancestors.delete(value);
};

export class CommandReconciliationRequiredError extends Error {
  readonly code = 'command_reconciliation_required';

  constructor(
    readonly idempotencyKey: string,
    readonly state: Exclude<CommandState, 'completed'>,
  ) {
    super(`Command '${idempotencyKey}' is ${state} and requires reconciliation`);
    this.name = 'CommandReconciliationRequiredError';
  }
}

export class CommandRepository {
  private readonly selectByKey;
  private readonly reserve;
  private readonly complete;
  private readonly fail;

  constructor(private readonly database: Database) {
    this.selectByKey = database.prepare(
      'SELECT state, response_json FROM processed_commands WHERE idempotency_key = ?',
    );
    this.reserve = database.prepare(`
      INSERT INTO processed_commands (id, idempotency_key, state, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
    `);
    this.complete = database.prepare(`
      UPDATE processed_commands
      SET state = 'completed', response_json = ?, updated_at = ?
      WHERE idempotency_key = ? AND state = 'pending'
    `);
    this.fail = database.prepare(`
      UPDATE processed_commands
      SET state = ?, failure_json = ?, updated_at = ?
      WHERE idempotency_key = ? AND state = 'pending'
    `);
  }

  executeOnce<Response>(idempotencyKey: string, execute: () => Response): Response {
    const existing = this.reserveOrRead(idempotencyKey);
    if (existing) {
      return this.resolveExisting<Response>(idempotencyKey, existing);
    }

    let response: Response;
    try {
      response = execute();
    } catch (error) {
      this.markNonRetryable(idempotencyKey, 'failed', error);
      throw error;
    }

    let serialized: string;
    try {
      assertJsonSafe(response);
      serialized = JSON.stringify(response);
      if (serialized === undefined) {
        throw new TypeError('Command response must be JSON-serializable');
      }
    } catch (error) {
      this.markNonRetryable(idempotencyKey, 'indeterminate', error);
      throw error;
    }

    this.database.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = this.complete.run(serialized, new Date().toISOString(), idempotencyKey);
      if (result.changes !== 1) {
        const row = this.selectByKey.get(idempotencyKey) as CommandRow | undefined;
        this.database.exec('COMMIT');
        committed = true;
        if (!row) {
          throw new Error(`Command reservation disappeared for '${idempotencyKey}'`);
        }
        return this.resolveExisting<Response>(idempotencyKey, row);
      }
      this.database.exec('COMMIT');
      committed = true;
      return response;
    } catch (error) {
      if (!committed) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private reserveOrRead(idempotencyKey: string): CommandRow | undefined {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.selectByKey.get(idempotencyKey) as CommandRow | undefined;
      if (existing) {
        this.database.exec('COMMIT');
        return existing;
      }

      const now = new Date().toISOString();
      this.reserve.run(randomUUID(), idempotencyKey, now, now);
      this.database.exec('COMMIT');
      return undefined;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private resolveExisting<Response>(idempotencyKey: string, row: CommandRow): Response {
    if (row.state === 'completed') {
      if (row.response_json === null) {
        throw new Error(`Completed command '${idempotencyKey}' has no stored response`);
      }
      return JSON.parse(row.response_json) as Response;
    }
    throw new CommandReconciliationRequiredError(idempotencyKey, row.state);
  }

  private markNonRetryable(
    idempotencyKey: string,
    state: Extract<CommandState, 'failed' | 'indeterminate'>,
    error: unknown,
  ): void {
    const failure = error instanceof Error ? { message: error.message } : { message: String(error) };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.fail.run(state, JSON.stringify(failure), new Date().toISOString(), idempotencyKey);
      this.database.exec('COMMIT');
    } catch (markError) {
      this.database.exec('ROLLBACK');
      throw markError;
    }
  }
}
