import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  sha256DigestSchema,
  startExecutionCommandSchema,
} from '@mesh/v2-contracts';
import { z } from 'zod';

import { inImmediateTransaction, type V2Database } from './database.js';
import {
  assertV2OrEmptyDatabase,
  V2_APPLICATION_ID,
} from './database-identity.js';

const foundationMigration = {
  version: 1,
  name: '001_foundation',
  sql: readFileSync(
    join(__dirname, 'migrations', '001_foundation.sql'),
    'utf8',
  ),
};

const intentLedgerMigration = {
  version: 2,
  name: '002_intent_ledger',
  sql: readFileSync(
    join(__dirname, 'migrations', '002_intent_ledger.sql'),
    'utf8',
  ),
};

const planningBoardMigration = {
  version: 3,
  name: '003_planning_board',
  sql: readFileSync(
    join(__dirname, 'migrations', '003_planning_board.sql'),
    'utf8',
  ),
};

const migrations = [
  foundationMigration,
  intentLedgerMigration,
  planningBoardMigration,
] as const;

type MigrationLedgerRow = { version: number; name: string };
type StartOperationRow = { request_json: string };

const startOperationRequestSchema = z.strictObject({
  version: z.literal('mesh.v2.execution-start/v1'),
  idempotencyKey: z.string().trim().min(1).max(256),
  requestHash: sha256DigestSchema,
  request: startExecutionCommandSchema,
});

const validateStartOperationRequests = (database: V2Database): void => {
  const rows = database
    .prepare(
      `SELECT request_json FROM execution_operations
       WHERE kind = 'start' ORDER BY id`,
    )
    .all() as StartOperationRow[];
  for (const row of rows) {
    startOperationRequestSchema.parse(JSON.parse(row.request_json));
  }
};

export class V2MigrationLedgerError extends Error {
  readonly code = 'migration_ledger_mismatch' as const;

  constructor(version: number, name: string) {
    super(`Unknown V2 migration ledger entry ${version}/${name}`);
    this.name = 'V2MigrationLedgerError';
  }
}

const validateMigrationLedger = (database: V2Database): void => {
  const hasLedger = database
    .prepare(
      `SELECT 1 FROM sqlite_schema
       WHERE type = 'table' AND name = 'v2_schema_migrations'`,
    )
    .get();
  if (!hasLedger) return;

  const rows = database
    .prepare('SELECT version, name FROM v2_schema_migrations ORDER BY version')
    .all() as MigrationLedgerRow[];
  for (const [index, row] of rows.entries()) {
    const expected = migrations[index];
    if (
      !expected ||
      row.version !== expected.version ||
      row.name !== expected.name
    ) {
      throw new V2MigrationLedgerError(row.version, row.name);
    }
  }
};

export const migrateV2Database = (database: V2Database): void => {
  assertV2OrEmptyDatabase(database);
  validateMigrationLedger(database);
  inImmediateTransaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS v2_schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version >= 0),
        name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
        applied_at TEXT NOT NULL CHECK (length(applied_at) > 0)
      )
    `);
    const hasMigration = database.prepare(
      'SELECT 1 FROM v2_schema_migrations WHERE version = ?',
    );
    const recordMigration = database.prepare(
      `INSERT INTO v2_schema_migrations (version, name, applied_at)
       VALUES (?, ?, ?)`,
    );

    for (const migration of migrations) {
      if (hasMigration.get(migration.version)) continue;
      if (migration.version === intentLedgerMigration.version) {
        validateStartOperationRequests(database);
      }
      database.exec(migration.sql);
      recordMigration.run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
    database.pragma(`application_id = ${V2_APPLICATION_ID}`);
  });
};
