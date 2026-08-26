import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { migrate } from '../db/migrate.js';
import { openDatabase } from '../db/database.js';
import { CommandRepository } from '../repositories/command-repository.js';
import { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import { EventRepository } from '../repositories/event-repository.js';
import { LayoutRepository } from '../repositories/layout-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import { SessionRepository } from '../repositories/session-repository.js';
import { ProjectEventRepository } from '../repositories/project-event-repository.js';
import { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { TaskTransitionRepository } from '../repositories/task-transition-repository.js';
import { WorkspaceRepository } from '../repositories/workspace-repository.js';

export const createTestRepositories = (options?: {
  failDiagnosticInsert?: boolean;
  failProjectEventInsert?: boolean;
  failTaskTransitionInsert?: boolean;
  failCommandCompleteFor?: string;
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-'));
  const path = join(directory, 'test.sqlite');
  const database = openDatabase(path);
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

  if (options?.failProjectEventInsert) {
    database.exec(`
      CREATE TRIGGER fail_project_event_insert
      BEFORE INSERT ON project_events
      BEGIN
        SELECT RAISE(FAIL, 'project event insert failed');
      END;
    `);
  }

  if (options?.failTaskTransitionInsert) {
    database.exec(`
      CREATE TRIGGER fail_task_transition_insert
      BEFORE INSERT ON task_transitions
      BEGIN
        SELECT RAISE(FAIL, 'task transition insert failed');
      END;
    `);
  }

  if (options?.failCommandCompleteFor) {
    const idempotencyKey = options.failCommandCompleteFor.replace(/'/g, "''");
    database.exec(`
      CREATE TRIGGER fail_command_complete_update
      BEFORE UPDATE OF state ON processed_commands
      WHEN NEW.state = 'completed' AND OLD.idempotency_key = '${idempotencyKey}'
      BEGIN
        SELECT RAISE(FAIL, 'command complete failed');
      END;
    `);
  }

  return {
    path,
    database,
    projects: new ProjectRepository(database),
    tasks: new TaskRepository(database),
    attempts: new TaskAttemptRepository(database),
    developerExecutions: new DeveloperExecutionRepository(database),
    qaExecutions: new QaExecutionRepository(database),
    transitions: new TaskTransitionRepository(database),
    projectEvents: new ProjectEventRepository(database),
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
