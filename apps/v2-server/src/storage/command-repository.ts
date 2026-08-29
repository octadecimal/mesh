import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  isoTimestampSchema,
  sha256DigestSchema,
  v2CommandResultSchema,
  v2CommandSchema,
  v2CommandTypeSchema,
  type V2Command,
  type V2CommandResult,
  type V2CommandType,
} from '@mesh/v2-contracts';

import type { V2Database } from '../db/database.js';
import { canonicalJson } from './canonical-json.js';

const storedCommandResultSchema = z
  .strictObject({
    idempotencyKey: z.string().trim().min(1).max(256),
    commandType: v2CommandTypeSchema,
    requestHash: sha256DigestSchema,
    result: v2CommandResultSchema,
    createdAt: isoTimestampSchema,
  })
  .superRefine((value, context) => {
    if (value.commandType !== value.result.commandType) {
      context.addIssue({
        code: 'custom',
        path: ['result', 'commandType'],
        message:
          'Stored result command type must match its request command type',
      });
    }
  });

export type StoredCommandResult = {
  idempotencyKey: string;
  commandType: V2CommandType;
  requestHash: string;
  result: V2CommandResult;
  createdAt: string;
};

type CommandResultRow = {
  idempotency_key: string;
  command_type: string;
  request_hash: string;
  result_json: string;
  created_at: string;
};

export class V2IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict' as const;

  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was used for a different request`);
    this.name = 'V2IdempotencyConflictError';
  }
}

export const hashV2Command = (command: V2Command): string =>
  createHash('sha256')
    .update(canonicalJson(v2CommandSchema.parse(command)))
    .digest('hex');

const toStoredResult = (row: CommandResultRow): StoredCommandResult =>
  storedCommandResultSchema.parse({
    idempotencyKey: row.idempotency_key,
    commandType: row.command_type,
    requestHash: row.request_hash,
    result: JSON.parse(row.result_json),
    createdAt: row.created_at,
  });

export class V2CommandRepository {
  private readonly select;
  private readonly insert;

  constructor(private readonly database: V2Database) {
    this.select = database.prepare(
      'SELECT * FROM command_results WHERE idempotency_key = ?',
    );
    this.insert = database.prepare(`
      INSERT INTO command_results (
        idempotency_key, command_type, request_hash, result_json, created_at
      ) VALUES (
        @idempotencyKey, @commandType, @requestHash, @resultJson, @createdAt
      )
    `);
  }

  find(
    idempotencyKey: string,
    expectedRequestHash?: string,
  ): StoredCommandResult | undefined {
    const row = this.select.get(idempotencyKey) as CommandResultRow | undefined;
    if (!row) return undefined;
    const stored = toStoredResult(row);
    if (
      expectedRequestHash !== undefined &&
      stored.requestHash !== sha256DigestSchema.parse(expectedRequestHash)
    ) {
      throw new V2IdempotencyConflictError(idempotencyKey);
    }
    return stored;
  }

  storeInTransaction(result: StoredCommandResult): void {
    if (!this.database.inTransaction) {
      throw new Error('Command result transaction is not active');
    }
    const parsed = storedCommandResultSchema.parse(result);
    const existing = this.find(parsed.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== parsed.requestHash) {
        throw new V2IdempotencyConflictError(parsed.idempotencyKey);
      }
      return;
    }
    this.insert.run({
      idempotencyKey: parsed.idempotencyKey,
      commandType: parsed.commandType,
      requestHash: parsed.requestHash,
      resultJson: canonicalJson(parsed.result),
      createdAt: parsed.createdAt,
    });
  }
}
