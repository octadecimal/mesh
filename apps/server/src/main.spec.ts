import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { loadServerConfig } from './config.js';
import { FakeClaudeSessionDriver } from './claude/fake-driver.js';
import { migrate } from './db/migrate.js';
import { openDatabase } from './db/database.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { TaskAttemptRepository } from './repositories/task-attempt-repository.js';
import { TaskRepository } from './repositories/task-repository.js';
import { WorkspaceRepository } from './repositories/workspace-repository.js';
import {
  createProcessLifecycle,
  originFromAddress,
  selectClaudeDriver,
  startServer,
} from './main.js';

const now = '2026-08-25T12:00:00.000Z';

describe('server configuration', () => {
  it('permits fake-driver injection only in explicit test configuration', () => {
    const fakeDriver = new FakeClaudeSessionDriver();
    const createSdkDriver = vi.fn(() => new FakeClaudeSessionDriver());

    expect(
      selectClaudeDriver([], createSdkDriver, fakeDriver, {
        NODE_ENV: 'test',
      }),
    ).toBe(fakeDriver);
    expect(createSdkDriver).not.toHaveBeenCalled();
    expect(() =>
      selectClaudeDriver([], createSdkDriver, fakeDriver, {
        NODE_ENV: 'production',
      }),
    ).toThrow('Fake Claude driver is restricted to test configuration');
  });

  it('keeps the billing guard in front of both role starts and resumes', async () => {
    const driver = selectClaudeDriver(
      [{ variable: 'ANTHROPIC_API_KEY' }],
      () => new FakeClaudeSessionDriver(),
    );

    await expect(
      driver.create({
        title: 'QA',
        role: {
          role: 'qa',
          initialPrompt: 'Verify.',
          allowedTools: ['Read', 'mcp__mesh_qa__submit_qa_verdict'],
          disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
          controlServer: {
            name: 'mesh_qa',
            version: '1',
            tools: [],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'billing_configuration_conflict' });
    await expect(
      driver.resume({ claudeResumeId: 'resume-developer' }),
    ).rejects.toMatchObject({ code: 'billing_configuration_conflict' });
  });

  it('permits an ephemeral port only in explicit test configuration', () => {
    expect(loadServerConfig({ NODE_ENV: 'test', MESH_PORT: '0' }).port).toBe(0);
    expect(() =>
      loadServerConfig({ NODE_ENV: 'production', MESH_PORT: '0' }),
    ).toThrow('MESH_PORT must be an integer between 1 and 65535');
  });

  it('defaults to loopback and keeps runtime data outside the repository', () => {
    const repository = resolve('C:/code/mesh');
    const config = loadServerConfig({}, repository);

    expect(config.host).toBe('127.0.0.1');
    expect(relative(repository, config.databasePath).startsWith('..')).toBe(
      true,
    );
  });

  it.each(['0.0.0.0', '192.168.1.5', 'mesh.local', 'localhost', '127.999.0.1'])(
    'rejects non-loopback host %s',
    (host) => {
      expect(() => loadServerConfig({ MESH_HOST: host })).toThrow(
        'MESH_HOST must be a loopback address',
      );
    },
  );

  it('derives the exact browser origin from the actual listening address', () => {
    expect(
      originFromAddress({ address: '127.0.0.1', family: 'IPv4', port: 43210 }),
    ).toBe('http://127.0.0.1:43210');
    expect(
      originFromAddress({ address: '::1', family: 'IPv6', port: 43210 }),
    ).toBe('http://[::1]:43210');
    expect(() =>
      originFromAddress({ address: '0.0.0.0', family: 'IPv4', port: 43210 }),
    ).toThrow('Server listened on a non-loopback address');
  });

  it('allows only the explicit loopback Vite origin in development', () => {
    expect(
      loadServerConfig({ NODE_ENV: 'development' }).developmentOrigin,
    ).toBe('http://127.0.0.1:4200');
    expect(() =>
      loadServerConfig({ MESH_DEV_ORIGIN: 'http://192.168.1.5:4200' }),
    ).toThrow('MESH_DEV_ORIGIN must be an exact loopback HTTP origin');
    expect(
      loadServerConfig({
        NODE_ENV: 'production',
        MESH_DEV_ORIGIN: 'http://127.0.0.1:4200',
      }).developmentOrigin,
    ).toBeUndefined();
  });
});

describe('process lifecycle', () => {
  it('stops commands/upgrades before bounded runtime interruption and socket close', async () => {
    const order: string[] = [];
    const lifecycle = createProcessLifecycle({
      stopAccepting: () => order.push('stop'),
      shutdownRuntime: async () => {
        order.push('runtime');
      },
      closeSockets: async () => {
        order.push('sockets');
      },
      auditStatus: () => 'available',
      signalFailure: vi.fn(),
    });

    await lifecycle.shutdown();

    expect(order).toEqual(['stop', 'runtime', 'sockets']);
  });

  it('closes remaining resources and signals failure when persistence is untrusted', async () => {
    const closeSockets = vi.fn(async () => undefined);
    const signalFailure = vi.fn();
    const lifecycle = createProcessLifecycle({
      stopAccepting: vi.fn(),
      shutdownRuntime: async () => undefined,
      closeSockets,
      auditStatus: () => 'audit_unavailable',
      signalFailure,
    });

    await lifecycle.shutdown();

    expect(closeSockets).toHaveBeenCalledOnce();
    expect(signalFailure).toHaveBeenCalledWith(1);
  });
});

describe('production composition', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('recovers sessions before reconciling attempts and serves project state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-recovery-'));
    directories.push(directory);
    const databasePath = join(directory, 'mesh.sqlite');
    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const attempts = new TaskAttemptRepository(database);
    const workspaces = new WorkspaceRepository(database);
    const sessions = new SessionRepository(database);
    projects.create(
      projectSchema.parse({
        id: 'project-main',
        displayName: 'Main project',
        repositoryPath: directory,
        repositoryIdentity: directory,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    tasks.create(
      taskSchema.parse({
        id: 'task-main',
        projectId: 'project-main',
        title: 'Recover production composition',
        description: 'Exercise the real startup path.',
        acceptanceCriteria: ['Session recovery precedes attempt repair.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'in_progress',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-main',
        projectId: 'project-main',
        type: 'worktree',
        path: join(directory, 'attempt'),
        gitBranch: 'attempt-main',
        gitWorktreePath: join(directory, 'attempt'),
        owner: 'mesh',
        cleanupState: 'pending',
      }),
    );
    sessions.create(
      sessionSchema.parse({
        id: 'session-main',
        projectId: 'project-main',
        workspaceId: 'workspace-main',
        title: 'Main attempt',
        permissionMode: 'interactive',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-main',
        taskId: 'task-main',
        sessionId: 'session-main',
        ordinal: 1,
        source: 'launched',
        actor: taskActorSchema.parse({ type: 'human', id: 'operator-1' }),
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
    );
    database.close();

    const running = await startServer({
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
      },
      test: { driver: new FakeClaudeSessionDriver(), webRoot: directory },
    });
    try {
      const response = await running.app.inject({
        method: 'GET',
        url: '/api/projects/project-main/snapshot',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        tasks: [{ id: 'task-main', lifecycleState: 'in_progress' }],
        attempts: [{ id: 'attempt-main', sessionId: 'session-main' }],
        repairs: [
          {
            taskId: 'task-main',
            attemptId: 'attempt-main',
            sessionId: 'session-main',
            reason: 'task_in_progress_without_live_session',
          },
        ],
      });
    } finally {
      await running.close();
    }

    const recovered = openDatabase(databasePath);
    try {
      expect(
        recovered
          .prepare('SELECT lifecycle_state FROM sessions WHERE id = ?')
          .get('session-main'),
      ).toEqual({ lifecycle_state: 'interrupted' });
      expect(
        recovered
          .prepare('SELECT lifecycle_state FROM tasks WHERE id = ?')
          .get('task-main'),
      ).toEqual({ lifecycle_state: 'in_progress' });
      expect(
        recovered
          .prepare('SELECT cleanup_state FROM workspaces WHERE id = ?')
          .get('workspace-main'),
      ).toEqual({ cleanup_state: 'pending' });
      const diagnostics = recovered
        .prepare(
          'SELECT payload_json FROM raw_diagnostics WHERE session_id = ? ORDER BY captured_at, id',
        )
        .all('session-main') as Array<{ payload_json: string }>;
      expect(
        diagnostics.map((row) => JSON.parse(row.payload_json)),
      ).toContainEqual(
        expect.objectContaining({
          kind: 'attempt_repair',
          repair: expect.objectContaining({
            reason: 'task_in_progress_without_live_session',
          }),
        }),
      );
      expect(
        recovered.prepare('SELECT COUNT(*) AS count FROM project_events').get(),
      ).toEqual({ count: 1 });
    } finally {
      recovered.close();
    }
  });
});
