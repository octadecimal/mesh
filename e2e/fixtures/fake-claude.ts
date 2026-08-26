import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { expect, test as base } from '@playwright/test';
import {
  sessionSnapshotSchema,
  type DeveloperBlockerReport,
  type DeveloperCompletionReport,
  type MutatingCommand,
  type SessionSnapshot,
} from '@mesh-session-platform/contracts';

// The fake is test-only infrastructure; production selection still rejects it.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { FakeClaudeSessionDriver } from '../../apps/server/src/claude/fake-driver.js';

const require = createRequire(__filename);
const builtMain = resolve('dist/apps/server/main.js');

type FakeDriverSessionControl = {
  interrupted: boolean;
  permissionDecisions: Array<{
    requestId: string;
    decision: 'approve' | 'deny';
  }>;
  enqueue(event: unknown): void;
};

type FakeClaudeSessionDriverControl = {
  createdRequests: unknown[];
  createdSessions: FakeDriverSessionControl[];
  resumedRequests: Array<{
    claudeResumeId: string;
    workspacePath?: string;
    permissionMode?: string;
  }>;
  submitForReview(
    index: number,
    report: DeveloperCompletionReport,
  ): Promise<void>;
  markBlocked(index: number, report: DeveloperBlockerReport): Promise<void>;
};

type RunningServer = {
  origin: string;
  close(): Promise<void>;
};

type StartServerOptions = {
  environment: Readonly<Record<string, string | undefined>>;
  test: { driver: FakeClaudeSessionDriverControl; webRoot: string };
};

type StartServer = (options?: StartServerOptions) => Promise<RunningServer>;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'ignore' });

const initializeRepository = (path: string) => {
  mkdirSync(path, { recursive: true });
  git(path, 'init');
  git(path, 'config', 'user.email', 'mesh-e2e@example.invalid');
  git(path, 'config', 'user.name', 'Mesh E2E');
  writeFileSync(join(path, 'README.md'), '# Mesh E2E\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', 'test fixture');
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000) => {
  await expect
    .poll(predicate, {
      timeout: timeoutMs,
      message: 'Timed out waiting for observable fake Claude state',
    })
    .toBe(true);
};

export type FakeClaudeHarness = {
  origin: string;
  repositoryPath: string;
  sharedPath: string;
  worktreePath: string;
  driver: FakeClaudeSessionDriverControl;
  snapshot(): Promise<SessionSnapshot>;
  projectId(): Promise<string>;
  discoverProject(): Promise<string>;
  command(command: MutatingCommand): Promise<{ status: number; body: any }>;
  discovery(): Promise<{ status: number; body: any }>;
  waitForCreated(count?: number): Promise<void>;
  waitForResumed(count?: number): Promise<void>;
  restart(options?: {
    billingConflict?: boolean;
    recoverSessionId?: string;
  }): Promise<void>;
};

const launchHarness = async (): Promise<{
  harness: FakeClaudeHarness;
  close(): Promise<void>;
}> => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'mesh-e2e-'));
  const repositoryPath = join(temporaryRoot, 'repository');
  const sharedPath = join(temporaryRoot, 'shared');
  const worktreePath = join(temporaryRoot, 'worktrees', 'acceptance');
  const dataDirectory = join(temporaryRoot, 'data');
  const databasePath = join(dataDirectory, 'mesh.sqlite');
  initializeRepository(repositoryPath);
  mkdirSync(sharedPath, { recursive: true });
  mkdirSync(join(temporaryRoot, 'worktrees'), { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });

  const driver = new FakeClaudeSessionDriver({
    discovered: [
      {
        claudeResumeId: 'discovered-resume-id',
        title: 'Discovered Claude session',
      },
    ],
  });
  const startServer = (require(builtMain) as { startServer: StartServer })
    .startServer;
  let server: RunningServer;

  const start = async (billingConflict = false) => {
    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      MESH_HOST: '127.0.0.1',
      MESH_PORT: '0',
      MESH_DATA_DIR: dataDirectory,
      MESH_DATABASE_PATH: 'mesh.sqlite',
      MESH_WORKSPACE_ROOT: temporaryRoot,
      ANTHROPIC_API_KEY: billingConflict ? 'forbidden-e2e-value' : undefined,
    };
    server = await startServer({
      environment,
      test: { driver, webRoot: resolve('dist/apps/web') },
    });
  };

  await start();

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${server.origin}${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  const post = (command: unknown) =>
    request('/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
  const envelope = (command: MutatingCommand) => ({
    protocolVersion: 1,
    idempotencyKey: randomUUID(),
    command,
  });
  const projectId = async () => {
    const project = (await request('/api/snapshot')).body.projects?.[0];
    if (!project?.id) throw new Error('No discovered E2E project is available');
    return project.id as string;
  };
  const discoverProject = async () => {
    const existing = (await request('/api/snapshot')).body.projects?.[0];
    if (!existing) {
      await post({
        protocolVersion: 1,
        type: 'projects.discover',
        payload: {},
      });
    }
    return projectId();
  };

  const harness: FakeClaudeHarness = {
    get origin() {
      return server.origin;
    },
    repositoryPath,
    sharedPath,
    worktreePath,
    driver,
    snapshot: async () =>
      sessionSnapshotSchema.parse((await request('/api/snapshot')).body),
    projectId,
    discoverProject,
    command: (command) => post(envelope(command)),
    discovery: async () =>
      post({
        protocolVersion: 1,
        type: 'sessions.discover',
        payload: { projectId: await discoverProject() },
      }),
    waitForCreated: (count = 1) =>
      waitUntil(() => driver.createdSessions.length >= count),
    waitForResumed: (count = 1) =>
      waitUntil(() => driver.resumedRequests.length >= count),
    restart: async ({ billingConflict = false, recoverSessionId } = {}) => {
      await server.close();
      if (recoverSessionId) {
        const database = new BetterSqlite3(databasePath);
        database
          .prepare(
            "UPDATE sessions SET lifecycle_state = 'running' WHERE id = ?",
          )
          .run(recoverSessionId);
        database.close();
      }
      await start(billingConflict);
    },
  };

  return {
    harness,
    close: async () => {
      await server.close();
      const root = resolve(temporaryRoot);
      if (
        !basename(root).startsWith('mesh-e2e-') ||
        !root.startsWith(resolve(tmpdir()))
      ) {
        throw new Error(`Refusing to remove unexpected E2E path: ${root}`);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export const test = base.extend<{ harness: FakeClaudeHarness }>({
  harness: async ({ browserName }, use) => {
    void browserName;
    const running = await launchHarness();
    try {
      await use(running.harness);
    } finally {
      await running.close();
    }
  },
});

export { expect };
