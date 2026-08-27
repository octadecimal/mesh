import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { AttemptRepair } from '@mesh-session-platform/contracts';

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
import {
  NodeProcessRunner,
  resolveGitExecutableAtStartup,
} from './platform/process-runner.js';
import { QaVerificationRunner } from './platform/qa-verification-runner.js';
import { resolveRepositoryIdentity } from './projects/repository-identity.js';
import { CommandRepository } from './repositories/command-repository.js';
import { DiagnosticRepository } from './repositories/diagnostic-repository.js';
import { DeveloperExecutionRepository } from './repositories/developer-execution-repository.js';
import { EventRepository } from './repositories/event-repository.js';
import { LayoutRepository } from './repositories/layout-repository.js';
import { ProjectEventRepository } from './repositories/project-event-repository.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { ProjectRunRepository } from './repositories/project-run-repository.js';
import { QaExecutionRepository } from './repositories/qa-execution-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { TaskAttemptRepository } from './repositories/task-attempt-repository.js';
import { TaskRepository } from './repositories/task-repository.js';
import { TaskTransitionRepository } from './repositories/task-transition-repository.js';
import { WorkspaceRepository } from './repositories/workspace-repository.js';
import { recoverInterruptedSessions } from './runtime/recovery.js';
import { SessionRegistry } from './runtime/session-registry.js';
import { AttemptService } from './tasks/attempt-service.js';
import { DeveloperCapabilityRegistry } from './tasks/developer-capability-registry.js';
import { DeveloperExecutionService } from './tasks/developer-execution-service.js';
import { DeveloperReworkService } from './tasks/developer-rework-service.js';
import { QaCapabilityRegistry } from './tasks/qa-capability-registry.js';
import { QaExecutionService } from './tasks/qa-execution-service.js';
import {
  reconcileTaskAttemptLaunchReservations,
  reconcileTaskAttempts,
} from './tasks/reconcile-attempts.js';
import { ReviewAutomationService } from './tasks/review-automation-service.js';
import { ProjectRunService } from './tasks/project-run-service.js';
import { createProjectRunPreflight } from './tasks/project-run-preflight.js';
import {
  createProjectRunWorkspacePlanner,
  projectRunWorkspaceRoot,
} from './tasks/project-run-workspace.js';
import { reconcileProjectRuns } from './tasks/reconcile-project-runs.js';
import { TaskService } from './tasks/task-service.js';

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
  const trustedGitExecutable = await resolveGitExecutableAtStartup({
    configuredPath: config.gitExecutable,
    pathValue: environment.PATH,
    workspaceRoot: config.baseDirectory,
  });
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const database = openDatabase(config.databasePath);
  migrate(database);
  recoverInterruptedSessions(database);

  const projects = new ProjectRepository(database);
  const projectRuns = new ProjectRunRepository(database);
  const tasks = new TaskRepository(database);
  const attempts = new TaskAttemptRepository(database);
  const transitions = new TaskTransitionRepository(database);
  const projectEvents = new ProjectEventRepository(database);
  const workspaces = new WorkspaceRepository(database);
  const sessions = new SessionRepository(database);
  const diagnostics = new DiagnosticRepository(database);
  const developerExecutions = new DeveloperExecutionRepository(database);
  const qaExecutions = new QaExecutionRepository(database);
  const events = new EventRepository(database, diagnostics);
  const layouts = new LayoutRepository(database);
  const commands = new CommandRepository(database);
  const originPolicy = createOriginPolicy(config.developmentOrigin);
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
  const capabilities = new DeveloperCapabilityRegistry();
  const qaCapabilities = new QaCapabilityRegistry();
  const roleServices: {
    reviewAutomation?: ReviewAutomationService;
    projectRuns?: ProjectRunService;
  } = {};
  const runDrains = new Map<string, Promise<void>>();
  const rerunRunDrains = new Set<string>();
  let pendingStoppedRuntimeReconciliation: SessionRegistry | undefined;
  let runDrainFailure: unknown;
  const requireReviewAutomation = (): ReviewAutomationService => {
    if (!roleServices.reviewAutomation) {
      throw new Error('Review automation service is not composed');
    }
    return roleServices.reviewAutomation;
  };
  const requireProjectRuns = (): ProjectRunService => {
    if (!roleServices.projectRuns) {
      throw new Error('Project run service is not composed');
    }
    return roleServices.projectRuns;
  };
  const runtimeRepairs: AttemptRepair[] = [];
  const projectCursors = () =>
    new Map(
      projects
        .list()
        .map(
          (project) =>
            [project.id, projectEvents.latestSequence(project.id)] as const,
        ),
    );
  const publishRecoveredEvents = (
    cursors: ReadonlyMap<string, number>,
    activeRegistry: SessionRegistry,
  ) => {
    for (const project of projects.list()) {
      for (const event of projectEvents.after(
        project.id,
        cursors.get(project.id) ?? 0,
      )) {
        activeRegistry.publisher.publishProject(event);
      }
    }
  };
  const failProjectRunAudit = (error: unknown) => {
    runDrainFailure ??= error;
    originPolicy.stopAccepting();
    registry.reportAuditFailure(error);
  };
  const scheduleRunDrains = (runIds: readonly string[]): void => {
    for (const runId of runIds) {
      if (!originPolicy.accepting) continue;
      if (runDrains.has(runId)) {
        rerunRunDrains.add(runId);
        continue;
      }
      const drain = Promise.resolve()
        .then(async () => {
          await requireProjectRuns().drainAvailableSlots(runId);
        })
        .catch((error: unknown) => failProjectRunAudit(error))
        .finally(() => {
          if (runDrains.get(runId) !== drain) return;
          runDrains.delete(runId);
          if (rerunRunDrains.delete(runId)) scheduleRunDrains([runId]);
          if (runDrains.size === 0 && pendingStoppedRuntimeReconciliation) {
            const activeRegistry = pendingStoppedRuntimeReconciliation;
            pendingStoppedRuntimeReconciliation = undefined;
            try {
              reconcileStoppedRuntime(activeRegistry);
            } catch {
              // The reconciliation path already tripped the central audit barrier.
            }
          }
        });
      runDrains.set(runId, drain);
    }
  };
  const settleRunDrains = async (): Promise<void> => {
    while (runDrains.size > 0) {
      await Promise.allSettled([...runDrains.values()]);
    }
    if (runDrainFailure) throw runDrainFailure;
  };
  function reconcileStoppedRuntime(activeRegistry: SessionRegistry): void {
    if (runDrains.size > 0) {
      pendingStoppedRuntimeReconciliation = activeRegistry;
      return;
    }
    const cursors = projectCursors();
    try {
      const result = reconcileTaskAttempts({
        database,
        projects,
        tasks,
        attempts,
        sessions,
        workspaces,
        diagnostics,
        developerExecutions,
        qaExecutions,
        qaCapabilities,
        projectEvents,
      });
      runtimeRepairs.splice(0, runtimeRepairs.length, ...result.repairs);
      reconcileTaskAttemptLaunchReservations(database);
      publishRecoveredEvents(cursors, activeRegistry);
      for (const taskId of new Set(
        result.repairs.map((repair) => repair.taskId),
      )) {
        void requireProjectRuns()
          .observeTaskOutcome(taskId)
          .catch((error: unknown) => failProjectRunAudit(error));
      }
    } catch (error) {
      failProjectRunAudit(error);
      throw error;
    }
  }
  const registry = new SessionRegistry({
    database,
    sessions,
    workspaces,
    events,
    diagnostics,
    driver,
    invalidateDeveloperCapability: (sessionId) => {
      capabilities.invalidateSession(sessionId);
      qaCapabilities.invalidateSession(sessionId);
      qaExecutionService.cancelRuntime(sessionId);
    },
    onRuntimeStopped: () => reconcileStoppedRuntime(registry),
  });
  const developerExecutionService = new DeveloperExecutionService({
    projects,
    tasks,
    attempts,
    developerExecutions,
    qaExecutions,
    transitions,
    projectEvents,
    commands,
    taskService,
    capabilities,
    publisher: registry.publisher,
  });
  const developerReworkService = new DeveloperReworkService({
    database,
    projects,
    tasks,
    attempts,
    sessions,
    diagnostics,
    developerExecutions,
    qaExecutions,
    transitions,
    projectEvents,
    commands,
    taskService,
    registry,
    capabilities,
    developerExecutionService,
    afterDeveloperSubmission: async (input) => {
      await requireReviewAutomation().afterDeveloperSubmission(input);
    },
    afterDeveloperBlocked: async (input) => {
      await requireProjectRuns().observeTaskOutcome(input.taskId);
    },
  });
  const pathOptions = { baseDirectory: config.baseDirectory };
  const processRunner = new NodeProcessRunner({ trustedGitExecutable });
  const resolveIdentity = (
    repositoryPath: string,
    identityPathOptions: typeof pathOptions,
  ) =>
    resolveRepositoryIdentity(
      repositoryPath,
      identityPathOptions,
      processRunner,
    );
  const git = new GitAdapter(processRunner, pathOptions);
  const attemptService = new AttemptService({
    database,
    projects,
    projectRuns,
    tasks,
    attempts,
    sessions,
    workspaces,
    diagnostics,
    developerExecutions,
    projectEvents,
    commands,
    taskService,
    registry,
    capabilities,
    developerReworkService,
    git,
    pathOptions,
    resolveIdentity,
    billingConflicts,
  });
  const runWorkspaceRoot = projectRunWorkspaceRoot(config.baseDirectory);
  const projectRunService = new ProjectRunService({
    database,
    projects,
    tasks,
    attempts,
    developerExecutions,
    projectRuns,
    projectEvents,
    commands,
    attemptService,
    preflight: createProjectRunPreflight({
      billingConflicts,
      resolveIdentity,
      pathOptions,
      workspaceRoot: runWorkspaceRoot,
      ensureWorkspaceRoot: (path) => mkdirSync(path, { recursive: true }),
    }),
    planWorkspace: createProjectRunWorkspacePlanner(config.baseDirectory),
    publisher: registry.publisher,
    canLaunch: () => originPolicy.accepting,
    maxConcurrency: config.projectRunMaxConcurrency,
    onAuditFailure: failProjectRunAudit,
    scheduleDrain: (runId) => scheduleRunDrains([runId]),
  });
  roleServices.projectRuns = projectRunService;
  const projectRunBoundary = {
    startRun: projectRunService.startRun.bind(projectRunService),
    pauseRun: projectRunService.pauseRun.bind(projectRunService),
    resumeRun: projectRunService.resumeRun.bind(projectRunService),
    stopRun: projectRunService.stopRun.bind(projectRunService),
    observeTaskOutcome:
      projectRunService.observeTaskOutcome.bind(projectRunService),
  } satisfies Pick<
    ProjectRunService,
    'startRun' | 'pauseRun' | 'resumeRun' | 'stopRun' | 'observeTaskOutcome'
  >;
  const qaExecutionService = new QaExecutionService({
    database,
    projects,
    tasks,
    transitions,
    attempts,
    sessions,
    workspaces,
    diagnostics,
    developerExecutions,
    qaExecutions,
    projectEvents,
    commands,
    attemptService,
    capabilities: qaCapabilities,
    registry,
    verificationRunner: new QaVerificationRunner(processRunner),
    billingConflicts,
    afterRejectedVerdict: async (input) => {
      await requireReviewAutomation().afterQaVerdict(input);
    },
    afterVerifiedVerdict: async (input) => {
      await projectRunBoundary.observeTaskOutcome(input.taskId);
    },
    afterInterruptedRepair: () => reconcileStoppedRuntime(registry),
  });
  roleServices.reviewAutomation = new ReviewAutomationService({
    database,
    commands,
    projects,
    tasks,
    attempts,
    developerExecutions,
    qaExecutions,
    projectEvents,
    qaExecutionService,
    developerReworkService,
    observeTaskOutcome: projectRunBoundary.observeTaskOutcome,
    publisher: registry.publisher,
  });
  const recoveryCursors = projectCursors();
  const reconciliation = reconcileTaskAttempts({
    database,
    projects,
    tasks,
    attempts,
    sessions,
    workspaces,
    diagnostics,
    developerExecutions,
    qaExecutions,
    qaCapabilities,
    projectEvents,
  });
  runtimeRepairs.push(...reconciliation.repairs);
  reconcileTaskAttemptLaunchReservations(database);
  const runReconciliation = reconcileProjectRuns({
    database,
    projects,
    tasks,
    attempts,
    sessions,
    workspaces,
    diagnostics,
    developerExecutions,
    qaExecutions,
    qaCapabilities,
    projectEvents,
    projectRuns,
    billingConflicts,
  });
  publishRecoveredEvents(recoveryCursors, registry);
  const app = buildApp({
    database,
    projects,
    tasks,
    taskService,
    attemptService,
    developerExecutionService,
    qaExecutionService,
    reviewAutomationService: roleServices.reviewAutomation,
    projectRunService: projectRunBoundary,
    attempts,
    transitions,
    projectEvents,
    projectRuns,
    projectRunMaxConcurrency: config.projectRunMaxConcurrency,
    developerExecutions,
    qaExecutions,
    repairs: runtimeRepairs,
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
    resolveIdentity,
    billingConflicts,
    originPolicy,
    webRoot: options.test?.webRoot ?? config.webRoot,
  });

  const lifecycle = createProcessLifecycle({
    stopAccepting: () => originPolicy.stopAccepting(),
    shutdownRuntime: async () => {
      let failure: unknown;
      try {
        await settleRunDrains();
      } catch (error) {
        failure = error;
      }
      try {
        await registry.shutdown();
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    },
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
    scheduleRunDrains(runReconciliation.launchableRunIds);
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
