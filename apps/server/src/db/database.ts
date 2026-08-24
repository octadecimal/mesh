import BetterSqlite3, { type Database as BetterSqliteDatabase } from 'better-sqlite3';

export type Database = BetterSqliteDatabase;

export const openDatabase = (path: string): Database => {
  const database = new BetterSqlite3(path);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  return database;
};
