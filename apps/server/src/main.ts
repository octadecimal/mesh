import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp, createOriginPolicy } from './app.js';
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
  isLoopbackAddress,
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
import { ProjectEventRepository } from './repositories/project-event-repository.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { TaskAttemptRepository } from './repositories/task-attempt-repository.js';
import { TaskRepository } from './repositories/task-repository.js';
import { TaskTransitionRepository } from './repositories/task-transition-repository.js';
import { WorkspaceRepository } from './repositories/workspace-repository.js';
import { recoverInterruptedSessions } from './runtime/recovery.js';
import { SessionRegistry } from './runtime/session-registry.js';
import { TaskService } from './tasks/task-service.js';
import { AttemptService } from './tasks/attempt-service.js';

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
      message:
        'API billing environment variables must be removed before starting Claude',
      details: this.conflicts,
    };
  }
}

export const selectClaudeDriver = (
  conflicts: readonly BillingConflict[],
  createDriver: () => ClaudeSessionDriver,
  testDriver?: ClaudeSessionDriver,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ClaudeSessionDriver => {
  if (testDriver) {
    if (environment.NODE_ENV !== 'test') {
      throw new Error('Fake Claude driver is restricted to test configuration');
    }
    return conflicts.length > 0
      ? new BillingBlockedDriver(conflicts)
      : testDriver;
  }
  return conflicts.length > 0
    ? new BillingBlockedDriver(conflicts)
    : createDriver();
};

export interface RunningServer {
  app: FastifyInstance;
  origin: string;
  close(): Promise<void>;
}

export interface StartServerOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  test?: {
    driver: ClaudeSessionDriver;
    webRoot: string;
  };
}

export const originFromAddress = (
  address: AddressInfo | string | null,
): string => {
  if (!address || typeof address === 'string') {
    throw new Error('Server did not expose an IP listening address');
  }
  if (!isLoopbackAddress(address.address)) {
    throw new Error('Server listened on a non-loopback address');
  }
  const host =
    address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
};

type ProcessLifecycleDependencies = {
  stopAccepting(): void;
  shutdownRuntime(): Promise<void>;
  closeSockets(): Promise<void>;
  auditStatus(): 'available' | 'audit_unavailable';
  signalFailure(code: number): void;
};

export const createProcessLifecycle = (
  dependencies: ProcessLifecycleDependencies,
): { shutdown(): Promise<void> } => {
  let closing: Promise<void> | undefined;
  return {
    shutdown: () => {
      closing ??= (async () => {
        dependencies.stopAccepting();
        let failure: unknown;
        try {
          await dependencies.shutdownRuntime();
        } catch (error) {
          failure = error;
        }
        try {
          await dependencies.closeSockets();
        } catch (error) {
          failure ??= error;
        }
        if (failure || dependencies.auditStatus() === 'audit_unavailable') {
          dependencies.signalFailure(1);
        }
        if (failure) throw failure;
      })();
      return closing;
    },
  };
};

export const startServer = async (
  options: StartServerOptions = {},
): Promise<RunningServer> => {
  const environment = options.environment ?? process.env;
  const config = loadServerConfig(environment);
  const billingConflicts = detectBillingOverrides(environment);
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const database = openDatabase(config.databasePath);
  migrate(database);
  recoverInterruptedSessions(database);

  const projects = new ProjectRepository(database);
  const tasks = new TaskRepository(database);
  const attempts = new TaskAttemptRepository(database);
  const transitions = new TaskTransitionRepository(database);
  const projectEvents = new ProjectEventRepository(database);
  const workspaces = new WorkspaceRepository(database);
  const sessions = new SessionRepository(database);
  const diagnostics = new DiagnosticRepository(database);
  const events = new EventRepository(database, diagnostics);
  const layouts = new LayoutRepository(database);
  const commands = new CommandRepository(database);
  const taskService = new TaskService({
    database,
    projects,
    tasks,
    transitions,
    projectEvents,
    commands,
  });
  const driver = selectClaudeDriver(
    billingConflicts,
    () => new SdkClaudeSessionDriver(createClaudeSdkFacade()),
    options.test?.driver,
    environment,
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
  const git = new GitAdapter(new NodeProcessRunner(), pathOptions);
  const attemptService = new AttemptService({
    database,
    projects,
    tasks,
    attempts,
    sessions,
    workspaces,
    diagnostics,
    projectEvents,
    commands,
    taskService,
    registry,
    git,
    pathOptions,
    billingConflicts,
  });
  const originPolicy = createOriginPolicy(config.developmentOrigin);
  const app = buildApp({
    database,
    projects,
    tasks,
    taskService,
    attemptService,
    attempts,
    transitions,
    projectEvents,
    workspaces,
    sessions,
    diagnostics,
    events,
    layouts,
    commands,
    registry,
    driver,
    git,
    pathOptions,
    billingConflicts,
    originPolicy,
    webRoot: options.test?.webRoot ?? config.webRoot,
  });

  const lifecycle = createProcessLifecycle({
    stopAccepting: () => originPolicy.stopAccepting(),
    shutdownRuntime: () => registry.shutdown(),
    closeSockets: () => app.close(),
    auditStatus: () => registry.auditStatus,
    signalFailure: (code) => {
      process.exitCode = code;
    },
  });
  const onSignal = () => {
    void lifecycle.shutdown().catch(() => undefined);
  };
  const close = (): Promise<void> => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    return lifecycle.shutdown();
  };

  try {
    await app.listen({ host: config.host, port: config.port });
    const origin = originFromAddress(app.server.address());
    originPolicy.setServedOrigin(origin);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    return { app, origin, close };
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
