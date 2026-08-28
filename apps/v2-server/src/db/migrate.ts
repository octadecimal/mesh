import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  inImmediateTransaction,
  V2_APPLICATION_ID,
  type V2Database,
} from './database.js';

const foundationMigration = {
  version: 1,
  name: '001_foundation',
  sql: readFileSync(
    join(__dirname, 'migrations', '001_foundation.sql'),
    'utf8',
  ),
};

const migrations = [foundationMigration] as const;

export const migrateV2Database = (database: V2Database): void => {
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
