import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Database } from './database.js';

const initialMigration = {
  id: '001-initial',
  sql: readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'),
};
const commandStateMigration = {
  id: '002-command-state',
  sql: readFileSync(
    join(__dirname, 'migrations', '002-command-state.sql'),
    'utf8',
  ),
};
const taskBoardStorageMigration = {
  id: '003-task-board-storage',
  sql: readFileSync(
    join(__dirname, 'migrations', '003-task-board-storage.sql'),
    'utf8',
  ),
};
const projectEventStreamsMigration = {
  id: '004-project-event-streams',
  sql: readFileSync(
    join(__dirname, 'migrations', '004-project-event-streams.sql'),
    'utf8',
  ),
};
const taskAttemptSafetyMigration = {
  id: '005-task-attempt-safety',
  sql: readFileSync(
    join(__dirname, 'migrations', '005-task-attempt-safety.sql'),
    'utf8',
  ),
};
const taskAttemptLaunchRecoveryMigration = {
  id: '006-task-attempt-launch-recovery',
  sql: readFileSync(
    join(__dirname, 'migrations', '006-task-attempt-launch-recovery.sql'),
    'utf8',
  ),
};
const developerExecutionMigration = {
  id: '007-developer-execution',
  sql: readFileSync(
    join(__dirname, 'migrations', '007-developer-execution.sql'),
    'utf8',
  ),
};
const developerCycleTaskTitleMigration = {
  id: '008-developer-cycle-task-title',
  sql: readFileSync(
    join(__dirname, 'migrations', '008-developer-cycle-task-title.sql'),
    'utf8',
  ),
};
const qaExecutionMigration = {
  id: '009-qa-execution',
  sql: readFileSync(
    join(__dirname, 'migrations', '009-qa-execution.sql'),
    'utf8',
  ),
};
const reviewAutomationStateMigration = {
  id: '010-review-automation-state',
  sql: readFileSync(
    join(__dirname, 'migrations', '010-review-automation-state.sql'),
    'utf8',
  ),
};

const migrations = [
  initialMigration,
  commandStateMigration,
  taskBoardStorageMigration,
  projectEventStreamsMigration,
  taskAttemptSafetyMigration,
  taskAttemptLaunchRecoveryMigration,
  developerExecutionMigration,
  developerCycleTaskTitleMigration,
  qaExecutionMigration,
  reviewAutomationStateMigration,
];

export const migrate = (database: Database): void => {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const hasMigration = database.prepare(
      'SELECT 1 FROM schema_migrations WHERE id = ?',
    );
    const recordMigration = database.prepare(
      'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
    );

    for (const migration of migrations) {
      if (hasMigration.get(migration.id)) {
        continue;
      }
      database.exec(migration.sql);
      recordMigration.run(migration.id, new Date().toISOString());
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};
