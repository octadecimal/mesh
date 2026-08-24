import { randomUUID } from 'node:crypto';

import type { Database } from '../db/database.js';

type CommandRow = { response_json: string };

export class CommandRepository {
  private readonly selectByKey;
  private readonly insert;

  constructor(private readonly database: Database) {
    this.selectByKey = database.prepare(
      'SELECT response_json FROM processed_commands WHERE idempotency_key = ?',
    );
    this.insert = database.prepare(`
      INSERT INTO processed_commands (id, idempotency_key, response_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
  }

  executeOnce<Response>(idempotencyKey: string, execute: () => Response): Response {
    const existing = this.selectByKey.get(idempotencyKey) as CommandRow | undefined;
    if (existing) {
      return JSON.parse(existing.response_json) as Response;
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const lockedExisting = this.selectByKey.get(idempotencyKey) as CommandRow | undefined;
      if (lockedExisting) {
        this.database.exec('COMMIT');
        return JSON.parse(lockedExisting.response_json) as Response;
      }

      const response = execute();
      this.insert.run(
        randomUUID(),
        idempotencyKey,
        JSON.stringify(response),
        new Date().toISOString(),
      );
      this.database.exec('COMMIT');
      return response;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
