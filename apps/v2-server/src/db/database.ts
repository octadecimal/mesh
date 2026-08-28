import BetterSqlite3, {
  type Database as BetterSqliteDatabase,
} from 'better-sqlite3';

import { migrateV2Database } from './migrate.js';

export type V2Database = BetterSqliteDatabase;

export const V2_APPLICATION_ID = 1_297_494_528;

export class V2DatabaseIdentityError extends Error {
  readonly code = 'database_identity_mismatch' as const;

  constructor(applicationId: number) {
    super(
      `Refusing to open non-V2 database with SQLite application ID ${applicationId}`,
    );
    this.name = 'V2DatabaseIdentityError';
  }
}

const applicationId = (database: V2Database): number =>
  database.pragma('application_id', { simple: true }) as number;

const hasUserSchema = (database: V2Database): boolean =>
  (
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: number }
  ).count > 0;

export const inImmediateTransaction = <T>(
  database: V2Database,
  work: () => T,
): T => {
  if (database.inTransaction) {
    throw new Error('An immediate transaction is already active');
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
};

export const openV2Database = (path: string): V2Database => {
  const database = new BetterSqlite3(path);
  try {
    const identity = applicationId(database);
    const empty = !hasUserSchema(database);
    if (identity !== V2_APPLICATION_ID && !(identity === 0 && empty)) {
      throw new V2DatabaseIdentityError(identity);
    }

    migrateV2Database(database);
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.pragma('journal_mode = WAL');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};
