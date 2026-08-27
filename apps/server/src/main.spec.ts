import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  projectSchema,
  qaExecutionCycleSchema,
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
import {
  NodeProcessRunner,
  resolveGitExecutableAtStartup,
} from './platform/process-runner.js';
import { resolveRepositoryIdentity } from './projects/repository-identity.js';
import { DeveloperExecutionRepository } from './repositories/developer-execution-repository.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { QaExecutionRepository } from './repositories/qa-execution-repository.js';
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
          availableTools: [],
          allowedTools: ['mcp__mesh_qa__submit_qa_verdict'],
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit'],
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

  it('captures the operator-approved Git path without resolving it in project context', () => {
    const configured =
      process.platform === 'win32'
        ? 'D:\\Portable\\Git\\bin\\git.exe'
        : '/nix/store/operator-git/bin/git';

    expect(
      loadServerConfig({ MESH_GIT_EXECUTABLE: `  ${configured}  ` })
        .gitExecutable,
    ).toBe(configured);
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

  it('retries one QA launch key after approved Git is restored', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-qa-git-'));
    directories.push(directory);
    const repositoryPath = join(directory, 'repository');
    const databasePath = join(directory, 'mesh.sqlite');
    const trustedGitExecutable = await resolveGitExecutableAtStartup({
      pathValue: process.env.PATH,
      workspaceRoot: directory,
    });
    if (!trustedGitExecutable) {
      throw new Error('Expected an approved test Git executable');
    }
    execFileSync(trustedGitExecutable.path, ['init', repositoryPath], {
      cwd: directory,
      windowsHide: true,
    });
    writeFileSync(join(repositoryPath, 'README.md'), 'submitted source\n');
    execFileSync(
      trustedGitExecutable.path,
      ['-C', repositoryPath, 'add', 'README.md'],
      { cwd: directory, windowsHide: true },
    );
    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      new NodeProcessRunner({ trustedGitExecutable }),
    );

    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const attempts = new TaskAttemptRepository(database);
    const workspaces = new WorkspaceRepository(database);
    const sessions = new SessionRepository(database);
    const developerExecutions = new DeveloperExecutionRepository(database);
    const actor = taskActorSchema.parse({
      type: 'human',
      id: 'operator-qa-git',
    });
    const project = projects.create(
      projectSchema.parse({
        id: 'project-qa-git',
        displayName: 'QA Git capability',
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        discoveredAt: now,
        discoveryMetadata: {},
        qaConfiguration: {
          instructions: {
            content: 'Verify the submitted source.',
            revision: 1,
            updatedAt: now,
            updatedBy: actor,
          },
          reviewPolicy: 'manual',
          revision: 1,
          updatedAt: now,
          updatedBy: actor,
        },
      }),
    );
    const task = tasks.create(
      taskSchema.parse({
        id: 'task-qa-git',
        projectId: project.id,
        title: 'Preserve QA launch retry',
        description: 'Approved Git can be repaired without a new command key.',
        acceptanceCriteria: ['The original launch key remains reusable.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'review',
        labels: [],
        notes: '',
        blocked: null,
        reviewAutomation: {
          status: 'enabled',
          generation: 1,
          rejectionCount: 0,
          pauseReason: null,
          updatedAt: now,
        },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const workspace = workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-qa-git',
        projectId: project.id,
        type: 'shared',
        path: identity.canonicalPath,
        cleanupState: 'active',
      }),
    );
    const developerSession = sessions.create(
      sessionSchema.parse({
        id: 'developer-session-qa-git',
        projectId: project.id,
        workspaceId: workspace.id,
        title: 'Developer submission',
        permissionMode: 'safe_auto',
        lifecycleState: 'completed',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-qa-git',
        taskId: task.id,
        sessionId: developerSession.id,
        ordinal: 1,
        role: 'developer',
        source: 'launched',
        actor,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
    );
    const developerCycle = developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'developer-cycle-qa-git',
        attemptId: attempt.id,
        ordinal: 1,
        mode: 'new',
        authorizedBy: actor,
        authorizationCommandId: 'developer-launch-qa-git',
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: task.revision,
          title: task.title,
          description: task.description,
          acceptanceCriteria: [
            {
              id: 'criterion-qa-git',
              text: task.acceptanceCriteria[0],
            },
          ],
        },
        workspaceId: workspace.id,
        permissionMode: developerSession.permissionMode,
        startedAt: now,
        endedAt: now,
        terminalDisposition: 'submitted_for_review',
        completionReportId: 'developer-report-qa-git',
        blockerReportId: null,
        terminalCommandId: 'developer-submit-qa-git',
        terminalEventId: 'developer-event-qa-git',
      }),
    );
    developerExecutions.appendCompletionReport(
      developerCompletionReportSchema.parse({
        id: 'developer-report-qa-git',
        cycleId: developerCycle.id,
        summary: 'Ready for QA.',
        criterionResults: [
          {
            criterionId: 'criterion-qa-git',
            status: 'met',
            evidence: 'Submitted source is tracked.',
          },
        ],
        verification: [],
        limitations: '',
        workspaceState: {
          summary: 'Tracked source is ready.',
          hasUncommittedChanges: true,
          commitsCreated: false,
        },
        reviewerNotes: null,
        createdAt: now,
      }),
    );
    database.close();

    const command = {
      protocolVersion: 1,
      idempotencyKey: 'qa-launch-git-retry',
      command: {
        type: 'task.qa.launch',
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          actor,
        },
      },
    };
    const baseEnvironment = {
      NODE_ENV: 'test',
      MESH_PORT: '0',
      MESH_DATA_DIR: directory,
      MESH_DATABASE_PATH: 'mesh.sqlite',
      MESH_WORKSPACE_ROOT: directory,
    };
    const unavailableDriver = new FakeClaudeSessionDriver();
    const unavailable = await startServer({
      environment: {
        ...baseEnvironment,
        MESH_GIT_EXECUTABLE: join(
          directory,
          process.platform === 'win32' ? 'git.exe' : 'git',
        ),
      },
      test: { driver: unavailableDriver, webRoot: directory },
    });
    try {
      const response = await unavailable.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: command,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          code: 'qa_verification_executable_unavailable',
          message: expect.stringContaining('MESH_GIT_EXECUTABLE'),
        },
      });
      expect(unavailableDriver.createdRequests).toEqual([]);
    } finally {
      await unavailable.close();
    }

    const afterUnavailable = openDatabase(databasePath);
    try {
      expect(
        afterUnavailable
          .prepare('SELECT COUNT(*) AS count FROM processed_commands')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        afterUnavailable
          .prepare('SELECT COUNT(*) AS count FROM sessions')
          .get(),
      ).toEqual({ count: 1 });
      expect(
        afterUnavailable
          .prepare('SELECT COUNT(*) AS count FROM qa_execution_cycles')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        afterUnavailable
          .prepare('SELECT COUNT(*) AS count FROM project_events')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      afterUnavailable.close();
    }

    const restoredDriver = new FakeClaudeSessionDriver();
    const restored = await startServer({
      environment: {
        ...baseEnvironment,
        MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
      },
      test: { driver: restoredDriver, webRoot: directory },
    });
    try {
      const response = await restored.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: command,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        commandType: 'task.qa.launch',
        result: {
          task: { id: task.id },
          attempt: { id: attempt.id },
          cycle: { workspaceId: workspace.id },
        },
      });
      expect(restoredDriver.createdRequests).toHaveLength(1);
    } finally {
      await restored.close();
    }

    const afterRestored = openDatabase(databasePath);
    try {
      expect(
        afterRestored
          .prepare(
            'SELECT state, COUNT(*) AS count FROM processed_commands GROUP BY state',
          )
          .all(),
      ).toEqual([{ state: 'completed', count: 1 }]);
      expect(
        afterRestored.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
      ).toEqual({ count: 2 });
      expect(
        afterRestored
          .prepare('SELECT COUNT(*) AS count FROM qa_execution_cycles')
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      afterRestored.close();
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

  it('reconciles active QA from durable state without starting or resuming a driver', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-qa-recovery-'));
    directories.push(directory);
    const databasePath = join(directory, 'mesh.sqlite');
    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const attempts = new TaskAttemptRepository(database);
    const workspaces = new WorkspaceRepository(database);
    const sessions = new SessionRepository(database);
    const qaExecutions = new QaExecutionRepository(database);
    const actor = taskActorSchema.parse({ type: 'human', id: 'operator-1' });
    projects.create(
      projectSchema.parse({
        id: 'project-qa-main',
        displayName: 'QA recovery project',
        repositoryPath: directory,
        repositoryIdentity: directory,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    tasks.create(
      taskSchema.parse({
        id: 'task-qa-main',
        projectId: 'project-qa-main',
        title: 'Reconcile QA',
        description: 'Do not replay outcome-unknown verification.',
        acceptanceCriteria: ['QA restart is explicit.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'review',
        labels: [],
        notes: '',
        blocked: null,
        reviewAutomation: {
          status: 'enabled',
          generation: 1,
          rejectionCount: 0,
          pauseReason: null,
          updatedAt: now,
        },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-qa-main',
        projectId: 'project-qa-main',
        type: 'worktree',
        path: join(directory, 'attempt'),
        gitBranch: 'attempt-main',
        gitWorktreePath: join(directory, 'attempt'),
        owner: 'mesh',
        cleanupState: 'active',
      }),
    );
    sessions.create(
      sessionSchema.parse({
        id: 'developer-session-main',
        projectId: 'project-qa-main',
        workspaceId: 'workspace-qa-main',
        title: 'Developer attempt',
        permissionMode: 'interactive',
        lifecycleState: 'completed',
        createdAt: now,
        updatedAt: now,
      }),
    );
    attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-qa-main',
        taskId: 'task-qa-main',
        sessionId: 'developer-session-main',
        ordinal: 1,
        source: 'launched',
        actor,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
    );
    sessions.create(
      sessionSchema.parse({
        id: 'qa-session-main',
        projectId: 'project-qa-main',
        workspaceId: 'workspace-qa-main',
        title: 'QA verification',
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    qaExecutions.createCycle(
      qaExecutionCycleSchema.parse({
        id: 'qa-cycle-main',
        taskId: 'task-qa-main',
        attemptId: 'attempt-qa-main',
        sessionId: 'qa-session-main',
        ordinal: 1,
        authorizedBy: actor,
        authorizationCommandId: 'start-qa-main',
        policyVersion: 'qa-policy-v1',
        qaInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: 'Reconcile QA',
          description: 'Do not replay outcome-unknown verification.',
          acceptanceCriteria: [
            { id: 'criterion-main', text: 'QA restart is explicit.' },
          ],
        },
        developerCompletionReportId: 'completion-main',
        workspaceId: 'workspace-qa-main',
        reviewPolicy: 'autonomous_review',
        reviewPolicyRevision: 1,
        automationGeneration: 1,
        rejectionOrdinal: 0,
        startedAt: now,
        endedAt: null,
        terminalDisposition: null,
        reportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      }),
    );
    database.close();

    const driver = new FakeClaudeSessionDriver();
    const running = await startServer({
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
      },
      test: { driver, webRoot: directory },
    });
    try {
      expect(driver.createdRequests).toEqual([]);
      expect(driver.resumedRequests).toEqual([]);
      const response = await running.app.inject({
        method: 'GET',
        url: '/api/projects/project-qa-main/snapshot',
      });
      expect(response.statusCode).toBe(200);
      const snapshot = response.json();
      expect(snapshot).toMatchObject({
        tasks: [
          {
            id: 'task-qa-main',
            lifecycleState: 'review',
            reviewAutomation: { status: 'paused' },
          },
        ],
        repairs: [
          {
            taskId: 'task-qa-main',
            attemptId: 'attempt-qa-main',
            sessionId: 'qa-session-main',
            reason: 'qa_cycle_without_trustworthy_outcome',
          },
        ],
      });

      const repair = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: {
          protocolVersion: 1,
          idempotencyKey: 'repair-qa-main',
          command: {
            type: 'task.qa.repair_interrupted',
            payload: {
              taskId: 'task-qa-main',
              cycleId: 'qa-cycle-main',
              expectedRevision: snapshot.tasks[0].revision,
              actor,
            },
          },
        },
      });
      expect(repair.statusCode).toBe(200);

      const reconnected = await running.app.inject({
        method: 'GET',
        url: '/api/projects/project-qa-main/snapshot',
      });
      expect(reconnected.statusCode).toBe(200);
      expect(reconnected.json()).toMatchObject({
        qaCycles: [
          {
            id: 'qa-cycle-main',
            terminalDisposition: 'interrupted',
          },
        ],
        repairs: [],
      });
    } finally {
      await running.close();
    }
  });
});
