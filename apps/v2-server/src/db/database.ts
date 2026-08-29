import BetterSqlite3, {
  type Database as BetterSqliteDatabase,
} from 'better-sqlite3';

import { migrateV2Database } from './migrate.js';
export {
  V2_APPLICATION_ID,
  V2DatabaseIdentityError,
} from './database-identity.js';

export type V2Database = BetterSqliteDatabase;

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
