import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { createClaudeSdkFacade } from './claude/sdk-adapter.js';
import { SdkClaudeSessionDriver } from './claude/sdk-driver.js';
import type {
  ClaudeSessionDriver,
  DriverSession,
  ResumeClaudeSessionRequest,
  StartClaudeSessionRequest,
} from './claude/driver.js';
import {
  detectBillingOverrides,
  loadServerConfig,
  type BillingConflict,
} from './config.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { GitAdapter } from './platform/git.js';
import { NodeProcessRunner } from './platform/process-runner.js';
import { CommandRepository } from './repositories/command-repository.js';
import { DiagnosticRepository } from './repositories/diagnostic-repository.js';
import { EventRepository } from './repositories/event-repository.js';
import { LayoutRepository } from './repositories/layout-repository.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { WorkspaceRepository } from './repositories/workspace-repository.js';
import { recoverInterruptedSessions } from './runtime/recovery.js';
import { SessionRegistry } from './runtime/session-registry.js';

class BillingBlockedDriver implements ClaudeSessionDriver {
  constructor(private readonly conflicts: readonly BillingConflict[]) {}

  async discover(): Promise<[]> {
    return [];
  }

  async create(_request: StartClaudeSessionRequest): Promise<DriverSession> {
    throw this.error();
  }

  async resume(_request: ResumeClaudeSessionRequest): Promise<DriverSession> {
    throw this.error();
  }

  private error() {
    return {
      code: 'billing_configuration_conflict' as const,
      message: 'API billing environment variables must be removed before starting Claude',
      details: this.conflicts,
    };
  }
}

export const selectClaudeDriver = (
  conflicts: readonly BillingConflict[],
  createDriver: () => ClaudeSessionDriver,
): ClaudeSessionDriver =>
  conflicts.length > 0 ? new BillingBlockedDriver(conflicts) : createDriver();

export interface RunningServer {
  app: FastifyInstance;
  close(): Promise<void>;
}

export const startServer = async (): Promise<RunningServer> => {
  const config = loadServerConfig(process.env);
  const billingConflicts = detectBillingOverrides(process.env);
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const database = openDatabase(config.databasePath);
  migrate(database);
  recoverInterruptedSessions(database);

  const projects = new ProjectRepository(database);
  const workspaces = new WorkspaceRepository(database);
  const sessions = new SessionRepository(database);
  const diagnostics = new DiagnosticRepository(database);
  const events = new EventRepository(database, diagnostics);
  const layouts = new LayoutRepository(database);
  const commands = new CommandRepository(database);
  const driver = selectClaudeDriver(
    billingConflicts,
    () => new SdkClaudeSessionDriver(createClaudeSdkFacade()),
  );
  const registry = new SessionRegistry({
    database,
    sessions,
    workspaces,
    events,
    diagnostics,
    driver,
  });
  const pathOptions = { baseDirectory: config.baseDirectory };
  const app = buildApp({
    projects,
    workspaces,
    sessions,
    diagnostics,
    events,
    layouts,
    commands,
    registry,
    driver,
    git: new GitAdapter(new NodeProcessRunner(), pathOptions),
    pathOptions,
    billingConflicts,
  });

  let closing: Promise<void> | undefined;
  const onSignal = () => {
    void close();
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await app.close().catch(() => undefined);
      await registry.shutdown();
    })();
    return closing;
  };

  try {
    await app.listen({ host: config.host, port: config.port });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    return { app, close };
  } catch (error) {
    await close();
    throw error;
  }
};

if (require.main === module) {
  void startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
