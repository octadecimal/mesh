import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import type {
  HarnessAdapter,
  ServerRealtimeMessage,
  V2Health,
} from '@mesh/v2-contracts';

import { loadV2ServerConfig } from './config.js';
import { openV2Database, type V2Database } from './db/database.js';
import { AuditBarrier } from './executions/audit-barrier.js';
import { ExecutionRepository } from './executions/execution-repository.js';
import { ExecutionRuntime } from './executions/execution-runtime.js';
import { FakeHarnessAdapter } from './executions/fake-harness.js';
import { OperationRepository } from './executions/operation-repository.js';
import { reconcileExecutions } from './executions/reconcile-executions.js';
import { createV2HttpApp } from './http/app.js';
import { createV2Snapshots } from './http/snapshots.js';
import {
  approveV2GitExecutable,
  createV2GitProcessRunner,
} from './platform/process-runner.js';
import { WorkerProfileService } from './profiles/profile-service.js';
import { ProjectRepository } from './projects/project-repository.js';
import { ProjectService } from './projects/project-service.js';
import { createRepositoryIdentityResolver } from './projects/repository-identity.js';
import { V2EventPublisher } from './realtime/event-publisher.js';
import { registerV2SocketHub, V2SocketHub } from './realtime/socket-hub.js';
import { V2CommandRepository } from './storage/command-repository.js';
import { V2EventStore } from './storage/event-store.js';

export type RunningV2Server = {
  origin: string;
  close(): Promise<void>;
  releaseFakeHold(): void;
};

export type StartV2ServerOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  test?: {
    adapter?: HarnessAdapter;
    webRoot?: string;
    onPublished?: (message: ServerRealtimeMessage) => void;
  };
};

export type V2ReadyLine = {
  type: 'mesh.v2.ready';
  origin: string;
};

const health = (barrier: AuditBarrier): V2Health => {
  const current = barrier.health();
  if (current.status === 'healthy') return { status: 'ok' };
  return {
    status: 'audit_barrier_tripped',
    error: {
      code: 'audit_barrier_tripped',
      message:
        current.diagnostics.at(-1)?.message ??
        'Audit persistence is unavailable.',
    },
  };
};

const publishCommittedSince = (
  projects: ProjectRepository,
  events: V2EventStore,
  publisher: V2EventPublisher,
  cursors: ReadonlyMap<string, { domain: number; runtime: number }>,
): void => {
  for (const project of projects.list()) {
    const before = cursors.get(project.id) ?? { domain: 0, runtime: 0 };
    for (const event of events.domainAfter(project.id, before.domain).events) {
      publisher.domain(event);
    }
    for (const event of events.runtimeAfter(project.id, before.runtime)
      .events) {
      publisher.runtime(event);
    }
  }
};

export const startV2Server = async (
  options: StartV2ServerOptions = {},
): Promise<RunningV2Server> => {
  const environment = options.environment ?? process.env;
  const config = loadV2ServerConfig(environment, homedir());
  const trustedGit = await approveV2GitExecutable({
    configuredPath: environment.MESH_V2_GIT_EXECUTABLE,
    pathValue: environment.PATH ?? environment.Path,
    workspaceRoot: config.workspaceRoot,
  });
  mkdirSync(dirname(config.databasePath), { recursive: true });

  let database: V2Database | undefined;
  let runtime: ExecutionRuntime | undefined;
  let hub: V2SocketHub | undefined;
  let app: ReturnType<typeof createV2HttpApp> | undefined;
  let accepting = false;
  try {
    database = openV2Database(config.databasePath);
    const projectsRepository = new ProjectRepository(database);
    const commands = new V2CommandRepository(database);
    const events = new V2EventStore(database);
    const publisher = new V2EventPublisher(options.test?.onPublished);
    const barrier = new AuditBarrier();
    const projects = new ProjectService({
      database,
      projects: projectsRepository,
      commands,
      events,
      resolveRepositoryIdentity: createRepositoryIdentityResolver({
        workspaceRoot: config.workspaceRoot,
        gitExecutable: trustedGit.path,
        processRunner: createV2GitProcessRunner(trustedGit),
      }),
      publish: (event) => publisher.domain(event),
    });
    const profiles = new WorkerProfileService({
      database,
      commands,
      events,
      projects: {
        exists: (projectId) => projectsRepository.get(projectId) !== undefined,
      },
      publishDomain: (event) => publisher.domain(event),
      now: () => new Date().toISOString(),
    });
    const executions = new ExecutionRepository(database);
    const operations = new OperationRepository(database);
    const adapter =
      options.test?.adapter ??
      new FakeHarnessAdapter({
        holdAfterAdapterCursor: config.testFakeHoldAfterAdapterCursor,
      });
    runtime = new ExecutionRuntime({
      database,
      commands,
      events,
      projects: projectsRepository,
      profiles,
      executions,
      operations,
      adapter,
      publisher: {
        domain: (event) => publisher.domain(event),
        runtime: (event) => publisher.runtime(event),
      },
      barrier,
      now: () => new Date().toISOString(),
    });

    const beforeReconciliation = new Map(
      projectsRepository
        .list()
        .map((project) => [project.id, events.cursors(project.id)] as const),
    );
    await reconcileExecutions({
      executions,
      operations,
      adapter,
      events,
      barrier,
      attach: (executionId, session) => runtime?.attach(executionId, session),
    });
    publishCommittedSince(
      projectsRepository,
      events,
      publisher,
      beforeReconciliation,
    );

    const allowedOrigins = new Set<string>();
    if (config.developmentOrigin) allowedOrigins.add(config.developmentOrigin);
    const snapshots = createV2Snapshots({
      projects: projectsRepository,
      profiles,
      executions,
      events,
      barrier,
    });
    app = createV2HttpApp(
      {
        allowedOrigins,
        isAccepting: () => accepting,
        health: () => health(barrier),
        projects,
        profiles,
        runtime,
        snapshots,
        events,
      },
      { webRoot: options.test?.webRoot ?? config.webRoot },
    );
    hub = new V2SocketHub({
      events,
      publisher,
      projectExists: (projectId) =>
        projectsRepository.get(projectId) !== undefined,
    });
    registerV2SocketHub(app, hub, {
      allowedOrigins,
      isAccepting: () => accepting,
    });
    const origin = await app.listen({ host: config.host, port: config.port });
    allowedOrigins.add(origin);
    accepting = true;

    let closePromise: Promise<void> | undefined;
    return {
      origin,
      close: () => {
        closePromise ??= (async () => {
          accepting = false;
          hub?.close();
          await app?.close();
          await runtime?.drain();
          await runtime?.close();
          database?.close();
        })();
        return closePromise;
      },
      releaseFakeHold: () => undefined,
    };
  } catch (error) {
    accepting = false;
    hub?.close();
    await app?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    database?.close();
    throw error;
  }
};

if (require.main === module) {
  void startV2Server()
    .then((server) => {
      const ready: V2ReadyLine = {
        type: 'mesh.v2.ready',
        origin: server.origin,
      };
      process.stdout.write(`${JSON.stringify(ready)}\n`);
      const shutdown = () => void server.close();
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
