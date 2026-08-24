import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { migrate } from '../db/migrate.js';
import { openDatabase } from '../db/database.js';
import { CommandRepository } from '../repositories/command-repository.js';
import { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import { EventRepository } from '../repositories/event-repository.js';
import { LayoutRepository } from '../repositories/layout-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { SessionRepository } from '../repositories/session-repository.js';
import { WorkspaceRepository } from '../repositories/workspace-repository.js';

export const createTestRepositories = (options?: {
  failDiagnosticInsert?: boolean;
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  migrate(database);

  if (options?.failDiagnosticInsert) {
    database.exec(`
      CREATE TRIGGER fail_diagnostic_insert
      BEFORE INSERT ON raw_diagnostics
      BEGIN
        SELECT RAISE(FAIL, 'diagnostic insert failed');
      END;
    `);
  }

  return {
    database,
    projects: new ProjectRepository(database),
    workspaces: new WorkspaceRepository(database),
    sessions: new SessionRepository(database),
    diagnostics: new DiagnosticRepository(database),
    events: new EventRepository(database),
    layouts: new LayoutRepository(database),
    commands: new CommandRepository(database),
    dispose: () => {
      database.close();
      rmSync(directory, { force: true, recursive: true });
    },
  };
};
