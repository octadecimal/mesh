import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  idSchema,
  projectPlanBaseSchema,
  projectPlanDetailsSchema,
  projectPlanProposalInputSchema,
  projectPlanSchema,
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
import { PlanningRepository } from './repositories/planning-repository.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { ProjectRunRepository } from './repositories/project-run-repository.js';
import { QaExecutionRepository } from './repositories/qa-execution-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { TaskAttemptRepository } from './repositories/task-attempt-repository.js';
import { TaskRepository } from './repositories/task-repository.js';
import { WorkspaceRepository } from './repositories/workspace-repository.js';
import { EventPublisher } from './runtime/event-publisher.js';
import { ProjectRunService } from './tasks/project-run-service.js';
import {
  createProcessLifecycle,
  originFromAddress,
  selectClaudeDriver,
  startServer,
} from './main.js';

const now = '2026-08-25T12:00:00.000Z';

const seedRepositoryCommit = (
  gitExecutable: string,
  repositoryPath: string,
  cwd: string,
) => {
  writeFileSync(join(repositoryPath, '.mesh-test-base'), 'base\n');
  execFileSync(
    gitExecutable,
    ['-C', repositoryPath, 'add', '.mesh-test-base'],
    {
      cwd,
      windowsHide: true,
    },
  );
  execFileSync(
    gitExecutable,
    [
      '-C',
      repositoryPath,
      '-c',
      'user.name=Mesh Test',
      '-c',
      'user.email=mesh@example.invalid',
      'commit',
      '-m',
      'test base',
    ],
    { cwd, windowsHide: true },
  );
};

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

  const proposal = projectPlanProposalInputSchema.parse({
    tasks: [
      {
        key: 'foundation',
        title: 'Build the foundation',
        description: 'Create the smallest durable planning foundation.',
        acceptanceCriteria: ['The planning foundation is verified.'],
        priority: 'normal',
        labels: ['planning'],
        rationale: 'The remaining work depends on a durable foundation.',
        goalMapping: 'Provides the requested planning workflow.',
      },
    ],
    dependencies: [],
    assumptions: [],
    risks: [],
    exclusions: [],
  });

  const createPlanningFixture = async (suffix: string) => {
    const directory = mkdtempSync(join(tmpdir(), `mesh-main-pm-${suffix}-`));
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
    seedRepositoryCommit(trustedGitExecutable.path, repositoryPath, directory);
    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      new NodeProcessRunner({ trustedGitExecutable }),
    );
    const database = openDatabase(databasePath);
    migrate(database);
    const project = new ProjectRepository(database).create(
      projectSchema.parse({
        id: `project-pm-${suffix}`,
        displayName: `PM planning ${suffix}`,
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    database.close();
    return {
      databasePath,
      directory,
      project,
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
        MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
      },
    };
  };

  const startPlanningCommand = (
    projectId: string,
    expectedProjectRevision: number,
    idempotencyKey: string,
  ) => ({
    protocolVersion: 1,
    idempotencyKey,
    command: {
      type: 'project.plan.start',
      payload: {
        projectId,
        expectedProjectRevision,
        goal: 'Plan the milestone.',
        constraints: ['Use the shared repository.'],
        nonGoals: ['Do not change billing mode.'],
        actor: { type: 'human' as const, id: 'operator-pm' },
      },
    },
  });

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('shares planning persistence and accepts fake-driver proposals without external traffic', async () => {
    const fixture = await createPlanningFixture('proposal');
    const driver = new FakeClaudeSessionDriver({
      pmSteps: [{ type: 'pm.proposal', proposal }],
    });
    const running = await startServer({
      environment: fixture.environment,
      test: { driver, webRoot: fixture.directory },
    });
    try {
      const started = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: startPlanningCommand(
          fixture.project.id,
          fixture.project.revision,
          'start-pm-proposal',
        ),
      });
      expect(started.statusCode).toBe(200);
      expect(JSON.stringify(started.json())).not.toContain('capability');
      expect(driver.createdRequests).toHaveLength(1);
      expect(driver.createdRequests[0]?.role?.role).toBe('pm');
      await driver.drainPmSteps();

      const planId = started.json().result.plan.id as string;
      const details = await running.app.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/plans/${planId}`,
      });
      expect(details.statusCode).toBe(200);
      expect(projectPlanDetailsSchema.parse(details.json())).toMatchObject({
        plan: { id: planId, status: 'awaiting_review' },
        proposals: [{ ordinal: 1 }],
      });

      const observation = openDatabase(fixture.databasePath);
      try {
        expect(
          new PlanningRepository(observation).getDetails(planId),
        ).toMatchObject({
          plan: { id: planId, status: 'awaiting_review' },
          proposals: [{ ordinal: 1 }],
        });
      } finally {
        observation.close();
      }
    } finally {
      await running.close();
    }
  });

  it('invalidates the PM proposal capability when its session stops', async () => {
    const fixture = await createPlanningFixture('stop');
    const driver = new FakeClaudeSessionDriver({
      pmSteps: [{ type: 'pm.wait' }],
    });
    const publishedProjectEvents: Array<{
      projectId: string;
      sequence: number;
      type: string;
      payload: unknown;
    }> = [];
    const publishProject = EventPublisher.prototype.publishProject;
    const publishSpy = vi
      .spyOn(EventPublisher.prototype, 'publishProject')
      .mockImplementation(function (event) {
        publishedProjectEvents.push(event);
        publishProject.call(this, event);
      });
    const running = await startServer({
      environment: fixture.environment,
      test: { driver, webRoot: fixture.directory },
    });
    try {
      const started = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: startPlanningCommand(
          fixture.project.id,
          fixture.project.revision,
          'start-pm-stop',
        ),
      });
      expect(started.statusCode).toBe(200);
      const sessionId = started.json().result.session.id as string;
      const role = driver.createdRequests[0]?.role;
      if (!role || role.role !== 'pm') {
        throw new Error('Expected a PM runtime configuration');
      }
      const snapshot = await running.app.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/snapshot`,
      });
      const cursor = snapshot.json().cursor as number;
      const runtime = driver.createdSessions[0];
      if (!runtime) throw new Error('Expected a PM runtime');
      await runtime.close();
      await expect
        .poll(async () => {
          const snapshot = await running.app.inject({
            method: 'GET',
            url: '/api/snapshot',
          });
          return snapshot
            .json()
            .sessions?.find(
              (session: { id?: string }) => session.id === sessionId,
            )?.lifecycleState;
        })
        .toBe('interrupted');
      await expect(role.submitProposal(proposal)).rejects.toMatchObject({
        code: 'planning_capability_invalid',
      });
      await expect
        .poll(async () => {
          const details = await running.app.inject({
            method: 'GET',
            url: `/api/projects/${fixture.project.id}/plans/${started.json().result.plan.id}`,
          });
          return details.json().plan?.status;
        })
        .toBe('attention_required');
      await expect
        .poll(() =>
          publishedProjectEvents.find(
            (event) =>
              event.projectId === fixture.project.id &&
              event.sequence > cursor &&
              event.type === 'project.plan_changed' &&
              (event.payload as { plan?: { status?: string } }).plan?.status ===
                'attention_required',
          ),
        )
        .toMatchObject({
          projectId: fixture.project.id,
          sequence: cursor + 1,
          type: 'project.plan_changed',
        });
      expect(driver.createdRequests).toHaveLength(1);
    } finally {
      publishSpy.mockRestore();
      await running.close();
    }
  });

  it('reconciles planning only after generic interruption recovery and before acceptance', async () => {
    const fixture = await createPlanningFixture('restart');
    const database = openDatabase(fixture.databasePath);
    const workspace = new WorkspaceRepository(database).create(
      workspaceSchema.parse({
        id: 'workspace-pm-restart',
        projectId: fixture.project.id,
        type: 'shared',
        path: fixture.project.repositoryPath,
        cleanupState: 'active',
      }),
    );
    const session = new SessionRepository(database).create(
      sessionSchema.parse({
        id: 'session-pm-restart',
        projectId: fixture.project.id,
        workspaceId: workspace.id,
        title: 'Interrupted PM planning',
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const base = projectPlanBaseSchema.parse({
      id: 'base-pm-restart',
      planId: 'plan-pm-restart',
      ordinal: 1,
      repositoryIdentity: fixture.project.repositoryIdentity,
      tasks: [],
      dependencies: [],
      projectArchivedAt: null,
      projectRevision: fixture.project.revision,
      policyRevision: fixture.project.qaConfiguration.revision,
      createdAt: now,
    });
    new PlanningRepository(database).create({
      plan: projectPlanSchema.parse({
        id: 'plan-pm-restart',
        projectId: fixture.project.id,
        goal: 'Recover planning truth.',
        constraints: [],
        nonGoals: [],
        policyVersion: 'pm-readonly-v1',
        status: 'planning',
        revision: 1,
        currentBaseId: base.id,
        currentSessionId: session.id,
        latestProposalOrdinal: 0,
        feedback: [],
        attention: null,
        createdBy: { type: 'human', id: 'operator-pm' },
        createdAt: now,
        updatedAt: now,
        terminalAt: null,
        terminalBy: null,
        terminalReason: null,
      }),
      base,
      sessionId: session.id,
    });
    database.close();
    const driver = new FakeClaudeSessionDriver();

    const running = await startServer({
      environment: fixture.environment,
      test: { driver, webRoot: fixture.directory },
    });
    try {
      const response = await running.app.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/plans/plan-pm-restart`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        plan: {
          id: 'plan-pm-restart',
          status: 'attention_required',
          attention: { type: 'session_unavailable' },
        },
      });
      expect(driver.createdRequests).toEqual([]);

      const observation = openDatabase(fixture.databasePath);
      try {
        expect(
          new SessionRepository(observation).get(session.id),
        ).toMatchObject({
          lifecycleState: 'interrupted',
        });
        expect(
          observation
            .prepare(
              "SELECT COUNT(*) AS count FROM project_events WHERE project_id = ? AND type = 'project.plan_changed'",
            )
            .get(fixture.project.id),
        ).toEqual({ count: 1 });
      } finally {
        observation.close();
      }
    } finally {
      await running.close();
    }
  });

  it('trips the central barrier when stopped-PM reconciliation cannot persist its audit event', async () => {
    const fixture = await createPlanningFixture('reconcile-audit');
    const driver = new FakeClaudeSessionDriver({
      pmSteps: [{ type: 'pm.wait' }],
    });
    const running = await startServer({
      environment: fixture.environment,
      test: { driver, webRoot: fixture.directory },
    });
    let closeError: unknown;
    const previousExitCode = process.exitCode;
    try {
      const command = startPlanningCommand(
        fixture.project.id,
        fixture.project.revision,
        'start-pm-reconcile-audit',
      );
      const started = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: command,
      });
      expect(started.statusCode).toBe(200);

      const database = openDatabase(fixture.databasePath);
      database.exec(`
        CREATE TRIGGER fail_plan_reconciliation_event
        BEFORE INSERT ON project_events
        WHEN NEW.project_id = '${fixture.project.id}'
          AND NEW.type = 'project.plan_changed'
        BEGIN
          SELECT RAISE(FAIL, 'planning reconciliation audit failed');
        END;
      `);
      database.close();

      const runtime = driver.createdSessions[0];
      if (!runtime) throw new Error('Expected a PM runtime');
      await runtime.close();

      await expect
        .poll(async () => {
          const rejected = await running.app.inject({
            method: 'POST',
            url: '/api/commands',
            payload: {
              ...command,
              idempotencyKey: 'rejected-after-plan-reconciliation-audit',
            },
          });
          return rejected.statusCode;
        })
        .toBe(503);
    } finally {
      closeError = await running.close().catch((error: unknown) => error);
      process.exitCode = previousExitCode;
    }
    expect(closeError).toMatchObject({
      message: 'planning reconciliation audit failed',
    });

    const observation = openDatabase(fixture.databasePath);
    try {
      const planId = (
        observation
          .prepare('SELECT id FROM project_plans WHERE project_id = ?')
          .get(fixture.project.id) as { id: string }
      ).id;
      expect(new PlanningRepository(observation).get(planId)).toMatchObject({
        status: 'planning',
        attention: null,
      });
    } finally {
      observation.close();
    }
  });

  it('refuses planning when a pay-per-token billing override is present', async () => {
    const fixture = await createPlanningFixture('billing');
    const driver = new FakeClaudeSessionDriver();
    const running = await startServer({
      environment: {
        ...fixture.environment,
        ANTHROPIC_API_KEY: 'must-not-be-used',
      },
      test: { driver, webRoot: fixture.directory },
    });
    try {
      const response = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: startPlanningCommand(
          fixture.project.id,
          fixture.project.revision,
          'start-pm-billing-conflict',
        ),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'project_plan_billing_conflict' },
      });
      expect(driver.createdRequests).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it('refuses a stale project revision before planning runtime or driver effects', async () => {
    const fixture = await createPlanningFixture('stale');
    const driver = new FakeClaudeSessionDriver();
    const running = await startServer({
      environment: fixture.environment,
      test: { driver, webRoot: fixture.directory },
    });
    try {
      const response = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: startPlanningCommand(
          fixture.project.id,
          fixture.project.revision + 1,
          'start-pm-stale-project',
        ),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: 'project_revision_conflict',
          details: {
            project: {
              id: fixture.project.id,
              revision: fixture.project.revision,
            },
          },
        },
      });
      expect(driver.createdRequests).toEqual([]);
      expect(driver.createdSessions).toEqual([]);

      const observation = openDatabase(fixture.databasePath);
      try {
        expect(
          observation
            .prepare('SELECT COUNT(*) AS count FROM project_plans')
            .get(),
        ).toEqual({ count: 0 });
        expect(
          observation.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
        ).toEqual({ count: 0 });
      } finally {
        observation.close();
      }
    } finally {
      await running.close();
    }
  });

  it('routes planning audit failures through the central runtime barrier', async () => {
    const fixture = await createPlanningFixture('audit');
    const database = openDatabase(fixture.databasePath);
    database.exec(`
      CREATE TRIGGER fail_planning_event
      BEFORE INSERT ON project_events
      WHEN NEW.project_id = '${fixture.project.id}'
        AND NEW.type = 'project.plan_changed'
      BEGIN
        SELECT RAISE(FAIL, 'planning audit insert failed');
      END;
    `);
    database.close();
    const driver = new FakeClaudeSessionDriver();
    const running = await startServer({
      environment: fixture.environment,
      test: { driver, webRoot: fixture.directory },
    });
    let closeError: unknown;
    const previousExitCode = process.exitCode;
    try {
      const command = startPlanningCommand(
        fixture.project.id,
        fixture.project.revision,
        'start-pm-audit',
      );
      const failed = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: command,
      });
      const rejected = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: { ...command, idempotencyKey: 'rejected-after-pm-audit' },
      });
      expect(failed.statusCode).toBe(500);
      expect(rejected.statusCode).toBe(503);
      expect(driver.createdRequests).toEqual([]);
    } finally {
      closeError = await running.close().catch((error: unknown) => error);
      process.exitCode = previousExitCode;
    }
    expect(closeError).toMatchObject({
      message: 'planning audit insert failed',
    });
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

  it('reconciles project runs after attempts and drains only launchable work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-run-recovery-'));
    directories.push(directory);
    const databasePath = join(directory, 'mesh.sqlite');
    const trustedGitExecutable = await resolveGitExecutableAtStartup({
      pathValue: process.env.PATH,
      workspaceRoot: directory,
    });
    if (!trustedGitExecutable) {
      throw new Error('Expected an approved test Git executable');
    }
    const createRepository = async (name: string) => {
      const repositoryPath = join(directory, name);
      execFileSync(trustedGitExecutable.path, ['init', repositoryPath], {
        cwd: directory,
        windowsHide: true,
      });
      seedRepositoryCommit(
        trustedGitExecutable.path,
        repositoryPath,
        directory,
      );
      return resolveRepositoryIdentity(
        repositoryPath,
        { baseDirectory: directory },
        new NodeProcessRunner({ trustedGitExecutable }),
      );
    };
    const launchIdentity = await createRepository('launch-repository');
    const pausedIdentity = await createRepository('paused-repository');

    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const projectRuns = new ProjectRunRepository(database);
    const seedQueuedRun = (
      projectId: string,
      taskId: string,
      identity: Awaited<ReturnType<typeof resolveRepositoryIdentity>>,
      additionalTaskId?: string,
    ) => {
      const project = projects.create(
        projectSchema.parse({
          id: projectId,
          displayName: projectId,
          repositoryPath: identity.canonicalPath,
          repositoryIdentity: identity.repositoryIdentity,
          discoveredAt: now,
          discoveryMetadata: {},
        }),
      );
      const createTask = (id: string, rank: string) =>
        tasks.create(
          taskSchema.parse({
            id,
            projectId,
            title: `Launch ${id}`,
            description: 'Recover queued orchestration work.',
            acceptanceCriteria: ['The run launches once.'],
            priority: 'normal',
            rank,
            lifecycleState: 'ready',
            labels: [],
            notes: '',
            blocked: null,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }),
        );
      const runTasks = [
        createTask(taskId, 'a'),
        ...(additionalTaskId ? [createTask(additionalTaskId, 'b')] : []),
      ];
      return projectRuns.create({
        id: `run-${projectId}`,
        projectId,
        concurrency: 1,
        startedAt: now,
        items: runTasks.map((task, queuePosition) => ({
          id: `item-${task.id}`,
          taskId: task.id,
          taskRevision: task.revision,
          policyRevision: project.qaConfiguration.revision,
          taskAutomationStatus: task.reviewAutomation.status,
          taskAutomationGeneration: task.reviewAutomation.generation,
          queuePosition,
          launchIdempotencyKey: `launch-${task.id}`,
        })),
      });
    };
    seedQueuedRun(
      'project-launch',
      'task-launch',
      launchIdentity,
      'task-launch-next',
    );
    const pausedRun = seedQueuedRun(
      'project-paused',
      'task-paused',
      pausedIdentity,
    );
    projectRuns.changeState({
      runId: pausedRun.id,
      expectedRunRevision: pausedRun.revision,
      state: 'paused',
      pauseReason: 'operator_paused',
      occurredAt: '2026-08-25T12:01:00.000Z',
    });
    projects.create(
      projectSchema.parse({
        id: 'project-draining',
        displayName: 'Draining project',
        repositoryPath: join(directory, 'draining-repository'),
        repositoryIdentity: join(directory, 'draining-repository'),
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const drainingRun = projectRuns.create({
      id: 'run-draining',
      projectId: 'project-draining',
      concurrency: 1,
      startedAt: now,
      items: [],
    });
    projectRuns.changeState({
      runId: drainingRun.id,
      expectedRunRevision: drainingRun.revision,
      state: 'draining',
      occurredAt: '2026-08-25T12:01:00.000Z',
    });
    database.close();

    const driver = new FakeClaudeSessionDriver();
    const running = await startServer({
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
        MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
        MESH_PROJECT_RUN_MAX_CONCURRENCY: '3',
      },
      test: { driver, webRoot: directory },
    });
    try {
      await expect
        .poll(async () => {
          const response = await running.app.inject({
            method: 'GET',
            url: '/api/projects/project-launch/snapshot',
          });
          return response.json().runs?.[0]?.items?.[0]?.status;
        })
        .toBe('active');

      const launchSnapshot = await running.app.inject({
        method: 'GET',
        url: '/api/projects/project-launch/snapshot',
      });
      const pausedSnapshot = await running.app.inject({
        method: 'GET',
        url: '/api/projects/project-paused/snapshot',
      });
      const drainingSnapshot = await running.app.inject({
        method: 'GET',
        url: '/api/projects/project-draining/snapshot',
      });
      const drainingHistory = await running.app.inject({
        method: 'GET',
        url: '/api/projects/project-draining/history',
      });

      expect(driver.createdRequests).toHaveLength(1);
      expect(launchSnapshot.json()).toMatchObject({
        projectRunLimits: { maxConcurrency: 3 },
        runs: [
          {
            id: 'run-project-launch',
            state: 'running',
            items: [
              { id: 'item-task-launch', status: 'active' },
              { id: 'item-task-launch-next', status: 'queued' },
            ],
          },
        ],
      });
      expect(pausedSnapshot.json()).toMatchObject({
        runs: [
          {
            id: 'run-project-paused',
            state: 'paused',
            items: [{ id: 'item-task-paused', status: 'queued' }],
          },
        ],
      });
      expect(drainingSnapshot.json()).toMatchObject({
        runs: [
          {
            id: 'run-draining',
            state: 'completed',
            completionReason: 'stopped',
          },
        ],
      });
      expect(drainingHistory.json()).toMatchObject({
        projectId: 'project-draining',
        events: [
          {
            type: 'project.run_changed',
            payload: {
              run: {
                id: 'run-draining',
                state: 'completed',
                completionReason: 'stopped',
              },
            },
          },
        ],
      });
    } finally {
      await running.close();
    }
    expect(driver.createdRequests).toHaveLength(1);

    const recovered = openDatabase(databasePath);
    try {
      expect(
        recovered
          .prepare('SELECT state FROM project_runs WHERE id = ?')
          .get('run-draining'),
      ).toEqual({ state: 'completed' });
      expect(
        recovered
          .prepare(
            "SELECT COUNT(*) AS count FROM project_events WHERE project_id = ? AND type = 'project.run_changed'",
          )
          .get('project-draining'),
      ).toEqual({ count: 1 });
      expect(
        recovered
          .prepare('SELECT status FROM project_run_items WHERE id = ?')
          .get('item-task-launch-next'),
      ).toEqual({ status: 'queued' });
    } finally {
      recovered.close();
    }
  });

  it('waits for an in-flight run launch at shutdown and never claims the next item', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-run-shutdown-'));
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
    seedRepositoryCommit(trustedGitExecutable.path, repositoryPath, directory);
    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      new NodeProcessRunner({ trustedGitExecutable }),
    );
    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const projectRuns = new ProjectRunRepository(database);
    const project = projects.create(
      projectSchema.parse({
        id: 'project-run-shutdown',
        displayName: 'Run shutdown barrier',
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const runTasks = ['first', 'second'].map((suffix, index) =>
      tasks.create(
        taskSchema.parse({
          id: `task-run-shutdown-${suffix}`,
          projectId: project.id,
          title: `Shutdown ${suffix}`,
          description: 'Exercise shutdown during an in-flight run launch.',
          acceptanceCriteria: ['Shutdown preserves queued work.'],
          priority: 'normal',
          rank: index === 0 ? 'a' : 'b',
          lifecycleState: 'ready',
          labels: [],
          notes: '',
          blocked: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
    projectRuns.create({
      id: 'run-shutdown',
      projectId: project.id,
      concurrency: 2,
      startedAt: now,
      items: runTasks.map((task, queuePosition) => ({
        id: `item-${task.id}`,
        taskId: task.id,
        taskRevision: task.revision,
        policyRevision: project.qaConfiguration.revision,
        taskAutomationStatus: task.reviewAutomation.status,
        taskAutomationGeneration: task.reviewAutomation.generation,
        queuePosition,
        launchIdempotencyKey: `launch-${task.id}`,
      })),
    });
    database.close();

    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const driver = new FakeClaudeSessionDriver();
    const create = driver.create.bind(driver);
    const createSpy = vi
      .spyOn(driver, 'create')
      .mockImplementation(async (request) => {
        await launchGate;
        return create(request);
      });
    const running = await startServer({
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
        MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
        MESH_PROJECT_RUN_MAX_CONCURRENCY: '2',
      },
      test: { driver, webRoot: directory },
    });
    const startupSnapshot = await running.app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/snapshot`,
    });
    expect(startupSnapshot.json().runs?.[0]).toMatchObject({
      id: 'run-shutdown',
      state: 'running',
    });
    await expect
      .poll(async () => {
        const response = await running.app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/snapshot`,
        });
        const item = response.json().runs?.[0]?.items?.[0];
        return { status: item?.status, outcomeReason: item?.outcomeReason };
      })
      .toEqual({ status: 'launch_pending', outcomeReason: null });
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closing = running.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseLaunch();
    await closing;

    expect(driver.createdRequests).toHaveLength(1);
    const recovered = openDatabase(databasePath);
    try {
      expect(
        recovered
          .prepare(
            'SELECT id, status, outcome_reason AS outcomeReason FROM project_run_items WHERE run_id = ? ORDER BY queue_position',
          )
          .all('run-shutdown'),
      ).toEqual([
        {
          id: 'item-task-run-shutdown-first',
          status: 'attention_required',
          outcomeReason: 'developer_cycle_without_live_session',
        },
        {
          id: 'item-task-run-shutdown-second',
          status: 'queued',
          outcomeReason: null,
        },
      ]);
    } finally {
      recovered.close();
    }
  });

  it('coalesces outcome drains and defers stopped-runtime repair until the launch settles', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-run-coalescing-'));
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
    seedRepositoryCommit(trustedGitExecutable.path, repositoryPath, directory);
    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      new NodeProcessRunner({ trustedGitExecutable }),
    );
    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const project = projects.create(
      projectSchema.parse({
        id: 'project-run-coalescing',
        displayName: 'Run drain coalescing',
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const runTasks = ['blocked', 'stopped', 'pending', 'later'].map(
      (suffix, index) =>
        tasks.create(
          taskSchema.parse({
            id: `task-run-coalescing-${suffix}`,
            projectId: project.id,
            title: `Coalescing ${suffix}`,
            description:
              'Exercise a stopped runtime during an in-flight launch.',
            acceptanceCriteria: ['The run stays coherent across the race.'],
            priority: 'normal',
            rank: String.fromCharCode('a'.charCodeAt(0) + index),
            lifecycleState: 'ready',
            labels: [],
            notes: '',
            blocked: null,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }),
        ),
    );
    database.close();

    let releaseSecondLaunch!: () => void;
    const secondLaunchGate = new Promise<void>((resolve) => {
      releaseSecondLaunch = resolve;
    });
    let signalSecondLaunch!: () => void;
    const secondLaunchStarted = new Promise<void>((resolve) => {
      signalSecondLaunch = resolve;
    });
    let releaseThirdLaunch!: () => void;
    const thirdLaunchGate = new Promise<void>((resolve) => {
      releaseThirdLaunch = resolve;
    });
    let signalThirdLaunch!: () => void;
    const thirdLaunchStarted = new Promise<void>((resolve) => {
      signalThirdLaunch = resolve;
    });
    const driver = new FakeClaudeSessionDriver();
    const create = driver.create.bind(driver);
    let createCount = 0;
    const createSpy = vi
      .spyOn(driver, 'create')
      .mockImplementation(async (request) => {
        createCount += 1;
        if (createCount === 2) {
          signalSecondLaunch();
          await secondLaunchGate;
        }
        if (createCount === 3) {
          signalThirdLaunch();
          await thirdLaunchGate;
        }
        return create(request);
      });
    const observedStoppedItemStatuses: Array<string | undefined> = [];
    const drainAvailableSlots = ProjectRunService.prototype.drainAvailableSlots;
    const drainSpy = vi
      .spyOn(ProjectRunService.prototype, 'drainAvailableSlots')
      .mockImplementation(function (runId) {
        const observation = openDatabase(databasePath);
        try {
          const row = observation
            .prepare(
              'SELECT status FROM project_run_items WHERE run_id = ? AND task_id = ?',
            )
            .get(runId, 'task-run-coalescing-stopped') as
            | { status: string }
            | undefined;
          observedStoppedItemStatuses.push(row?.status);
        } finally {
          observation.close();
        }
        return drainAvailableSlots.call(this, runId);
      });
    const running = await startServer({
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
        MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
        MESH_PROJECT_RUN_MAX_CONCURRENCY: '2',
      },
      test: { driver, webRoot: directory },
    });
    try {
      const started = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: {
          protocolVersion: 1,
          idempotencyKey: 'start-run-coalescing',
          command: {
            type: 'project.run.start',
            payload: {
              projectId: project.id,
              concurrency: 2,
              expectedPolicyRevision: project.qaConfiguration.revision,
              expectedTasks: runTasks.map((task) => ({
                taskId: task.id,
                revision: task.revision,
                automationStatus: task.reviewAutomation.status,
                automationGeneration: task.reviewAutomation.generation,
              })),
              actor: { type: 'human', id: 'operator-run-coalescing' },
            },
          },
        },
      });
      expect(started.statusCode).toBe(200);
      await secondLaunchStarted;
      await vi.waitFor(() => expect(driver.createdSessions).toHaveLength(1));
      expect(drainSpy).toHaveBeenCalledOnce();

      const observation = openDatabase(databasePath);
      try {
        const workspaces = new WorkspaceRepository(observation).listByProject(
          project.id,
        );
        expect(workspaces).toHaveLength(2);
        expect(new Set(workspaces.map(({ path }) => path)).size).toBe(2);
        for (const workspace of workspaces) {
          expect(workspace).toMatchObject({
            type: 'worktree',
            owner: 'mesh',
            gitWorktreePath: workspace.path,
          });
          expect(
            relative(join(directory, '.mesh-project-runs'), workspace.path),
          ).not.toMatch(/^\.\./);
          const gitRoot = execFileSync(
            trustedGitExecutable.path,
            ['-C', workspace.path, 'rev-parse', '--show-toplevel'],
            { cwd: directory, encoding: 'utf8', windowsHide: true },
          ).trim();
          expect(realpathSync(gitRoot)).toBe(realpathSync(workspace.path));
        }
        expect(
          execFileSync(
            trustedGitExecutable.path,
            ['-C', repositoryPath, 'status', '--porcelain'],
            { cwd: directory, encoding: 'utf8', windowsHide: true },
          ),
        ).toBe('');
      } finally {
        observation.close();
      }

      await driver.markBlocked(0, {
        idempotencyKey: idSchema.parse('block-run-coalescing'),
        reason: 'A deterministic dependency is unavailable.',
        evidence: 'The fake dependency probe returned no result.',
        attemptedWork: 'Inspected the temporary repository and retried once.',
        suggestedHumanAction: 'Provide the deterministic dependency.',
        preserveWorkspace: true,
      });

      const deferred = await running.app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/snapshot`,
      });
      expect(deferred.statusCode).toBe(200);
      expect(deferred.json().runs?.[0]).toMatchObject({
        state: 'running',
        pauseReason: null,
        items: [
          {
            status: 'attention_required',
            outcomeReason: 'developer_blocked',
          },
          { status: 'launch_pending', outcomeReason: null },
          { status: 'queued', outcomeReason: null },
          { status: 'queued', outcomeReason: null },
        ],
      });
      expect(drainSpy).toHaveBeenCalledOnce();

      releaseSecondLaunch();
      await thirdLaunchStarted;
      await vi.waitFor(() => expect(driver.createdSessions).toHaveLength(2));
      const stoppedRuntime = driver.createdSessions[1];
      if (!stoppedRuntime) throw new Error('Expected the second runtime');
      stoppedRuntime.crash(new Error('deterministic runtime stop'));
      await expect
        .poll(async () => {
          const projectSnapshot = await running.app.inject({
            method: 'GET',
            url: `/api/projects/${project.id}/snapshot`,
          });
          const stoppedItem = projectSnapshot
            .json()
            .runs?.[0]?.items?.find(
              (item: { taskId?: string }) =>
                item.taskId === 'task-run-coalescing-stopped',
            );
          const attempt = projectSnapshot
            .json()
            .attempts?.find(
              (candidate: { id?: string }) =>
                candidate.id === stoppedItem?.attemptId,
            );
          const sessionSnapshot = await running.app.inject({
            method: 'GET',
            url: '/api/snapshot',
          });
          return sessionSnapshot
            .json()
            .sessions?.find(
              (session: { id?: string }) => session.id === attempt?.sessionId,
            )?.lifecycleState;
        })
        .toBe('interrupted');

      const stoppedDeferred = await running.app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/snapshot`,
      });
      expect(stoppedDeferred.json().runs?.[0]).toMatchObject({
        state: 'running',
        pauseReason: null,
        items: [
          {
            status: 'attention_required',
            outcomeReason: 'developer_blocked',
          },
          { status: 'active', outcomeReason: null },
          { status: 'launch_pending', outcomeReason: null },
          { status: 'queued', outcomeReason: null },
        ],
      });
      expect(drainSpy).toHaveBeenCalledOnce();

      releaseThirdLaunch();
      await expect
        .poll(async () => {
          const response = await running.app.inject({
            method: 'GET',
            url: `/api/projects/${project.id}/snapshot`,
          });
          const run = response.json().runs?.[0];
          return {
            state: run?.state,
            pauseReason: run?.pauseReason,
            items: run?.items?.map(
              (item: { status?: string; outcomeReason?: string | null }) => ({
                status: item.status,
                outcomeReason: item.outcomeReason,
              }),
            ),
          };
        })
        .toEqual({
          state: 'running',
          pauseReason: null,
          items: [
            {
              status: 'attention_required',
              outcomeReason: 'developer_blocked',
            },
            {
              status: 'attention_required',
              outcomeReason: 'developer_cycle_without_live_session',
            },
            { status: 'active', outcomeReason: null },
            { status: 'active', outcomeReason: null },
          ],
        });
      expect(observedStoppedItemStatuses).toEqual([
        'queued',
        'active',
        'attention_required',
      ]);

      const history = await running.app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/history?after=0`,
      });
      const events = history.json().events as Array<{
        payload?: {
          run?: { items?: Array<{ outcomeReason?: string | null }> };
        };
      }>;
      expect(
        events.flatMap(
          (event) =>
            event.payload?.run?.items?.map((item) => item.outcomeReason) ?? [],
        ),
      ).not.toContain('launch_outcome_unknown');
    } finally {
      releaseSecondLaunch();
      releaseThirdLaunch();
      try {
        await running.close();
      } finally {
        createSpy.mockRestore();
        drainSpy.mockRestore();
      }
    }
  });

  it('routes a trigger-based attempt audit failure through the central runtime barrier', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-drain-audit-'));
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
    seedRepositoryCommit(trustedGitExecutable.path, repositoryPath, directory);
    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      new NodeProcessRunner({ trustedGitExecutable }),
    );
    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const workspaces = new WorkspaceRepository(database);
    const project = projects.create(
      projectSchema.parse({
        id: 'project-drain-audit',
        displayName: 'Drain audit barrier',
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const workspace = workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-drain-audit',
        projectId: project.id,
        type: 'shared',
        path: identity.canonicalPath,
      }),
    );
    tasks.create(
      taskSchema.parse({
        id: 'task-drain-audit',
        projectId: project.id,
        title: 'Fail an attempt audit event',
        description: 'Exercise asynchronous attempt audit failure.',
        acceptanceCriteria: ['The central barrier becomes unavailable.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    database.exec(`
      CREATE TRIGGER fail_project_run_attempt_event
      BEFORE INSERT ON project_events
      WHEN NEW.project_id = 'project-drain-audit'
        AND NEW.type = 'task.developer_execution_changed'
      BEGIN
        SELECT RAISE(FAIL, 'project run attempt audit failed');
      END;
    `);
    database.close();

    const driver = new FakeClaudeSessionDriver();
    const running = await startServer({
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
        MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
      },
      test: { driver, webRoot: directory },
    });
    let closeError: unknown;
    const previousExitCode = process.exitCode;
    try {
      const session = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: {
          protocolVersion: 1,
          idempotencyKey: 'create-drain-audit-runtime',
          command: {
            type: 'session.create',
            payload: {
              projectId: project.id,
              workspaceId: workspace.id,
              title: 'Owned runtime',
              permissionMode: 'interactive',
            },
          },
        },
      });
      expect(session.statusCode).toBe(200);

      const started = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: {
          protocolVersion: 1,
          idempotencyKey: 'start-drain-audit-run',
          command: {
            type: 'project.run.start',
            payload: {
              projectId: project.id,
              concurrency: 1,
              expectedPolicyRevision: project.qaConfiguration.revision,
              expectedTasks: [
                {
                  taskId: 'task-drain-audit',
                  revision: 1,
                  automationStatus: 'disabled',
                  automationGeneration: 0,
                },
              ],
              actor: { type: 'human', id: 'operator-drain-audit' },
            },
          },
        },
      });
      expect(started.statusCode).toBe(200);
      await vi.waitFor(() =>
        expect(driver.createdSessions[0]?.interrupted).toBe(true),
      );

      const rejectedCommand = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: {
          protocolVersion: 1,
          idempotencyKey: 'rejected-after-drain-audit',
          command: {
            type: 'project.run.pause',
            payload: {
              runId: started.json().result.run.id,
              expectedRevision: started.json().result.run.revision,
              actor: { type: 'human', id: 'operator-drain-audit' },
            },
          },
        },
      });
      expect(rejectedCommand.statusCode).toBe(503);
    } finally {
      closeError = await running.close().catch((error: unknown) => error);
      process.exitCode = previousExitCode;
    }
    expect(closeError).toMatchObject({
      code: 'audit_unavailable',
      cause: expect.objectContaining({
        message: 'project run attempt audit failed',
      }),
    });
  });

  it('publishes runtime-stopped run reconciliation from durable project events', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-run-stopped-'));
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
    seedRepositoryCommit(trustedGitExecutable.path, repositoryPath, directory);
    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      new NodeProcessRunner({ trustedGitExecutable }),
    );
    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const project = projects.create(
      projectSchema.parse({
        id: 'project-runtime-stopped',
        displayName: 'Runtime stopped publication',
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    tasks.create(
      taskSchema.parse({
        id: 'task-runtime-stopped',
        projectId: project.id,
        title: 'Publish stopped recovery',
        description: 'Publish durable run reconciliation to live clients.',
        acceptanceCriteria: ['The recovered run event arrives live.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    database.close();

    const publishedProjectEvents: Array<{
      projectId: string;
      sequence: number;
      type: string;
      payload: unknown;
    }> = [];
    const publishProject = EventPublisher.prototype.publishProject;
    const publishSpy = vi
      .spyOn(EventPublisher.prototype, 'publishProject')
      .mockImplementation(function (event) {
        publishedProjectEvents.push(event);
        publishProject.call(this, event);
      });
    const driver = new FakeClaudeSessionDriver();
    const running = await startServer({
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
        MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
      },
      test: { driver, webRoot: directory },
    });
    try {
      const started = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: {
          protocolVersion: 1,
          idempotencyKey: 'start-runtime-stopped-run',
          command: {
            type: 'project.run.start',
            payload: {
              projectId: project.id,
              concurrency: 1,
              expectedPolicyRevision: project.qaConfiguration.revision,
              expectedTasks: [
                {
                  taskId: 'task-runtime-stopped',
                  revision: 1,
                  automationStatus: 'disabled',
                  automationGeneration: 0,
                },
              ],
              actor: { type: 'human', id: 'operator-runtime-stopped' },
            },
          },
        },
      });
      expect(started.statusCode).toBe(200);
      await expect
        .poll(async () => {
          const response = await running.app.inject({
            method: 'GET',
            url: `/api/projects/${project.id}/snapshot`,
          });
          return response.json().runs?.[0]?.items?.[0]?.status;
        })
        .toBe('active');
      const snapshot = await running.app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/snapshot`,
      });
      const cursor = snapshot.json().cursor as number;
      await vi.waitFor(() => expect(driver.createdSessions).toHaveLength(1));

      const runtime = driver.createdSessions[0];
      if (!runtime) throw new Error('Expected the project-run runtime');
      runtime.crash(new Error('runtime stopped'));

      await expect
        .poll(() =>
          publishedProjectEvents.find(
            (event) =>
              event.projectId === project.id &&
              event.sequence > cursor &&
              event.type === 'project.run_changed' &&
              (event.payload as { run?: { state?: string } }).run?.state ===
                'completed',
          ),
        )
        .toMatchObject({
          projectId: project.id,
          sequence: cursor + 3,
          type: 'project.run_changed',
          payload: {
            run: {
              state: 'completed',
              items: [
                {
                  status: 'attention_required',
                  outcomeReason: 'developer_cycle_without_live_session',
                },
              ],
            },
          },
        });
      const history = await running.app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/history?after=${cursor}`,
      });
      expect(history.json().events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'project.run_changed',
            payload: expect.objectContaining({
              run: expect.objectContaining({ state: 'completed' }),
            }),
          }),
        ]),
      );
    } finally {
      publishSpy.mockRestore();
      await running.close();
    }
  });

  it('stops accepting commands and socket upgrades after a run audit failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-main-run-audit-'));
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
    seedRepositoryCommit(trustedGitExecutable.path, repositoryPath, directory);
    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      new NodeProcessRunner({ trustedGitExecutable }),
    );
    const database = openDatabase(databasePath);
    migrate(database);
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const project = projects.create(
      projectSchema.parse({
        id: 'project-run-audit',
        displayName: 'Run audit barrier',
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    tasks.create(
      taskSchema.parse({
        id: 'task-run-audit',
        projectId: project.id,
        title: 'Trip the run audit barrier',
        description: '',
        acceptanceCriteria: ['Unsafe acceptance stops.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    database.exec(`
      CREATE TRIGGER fail_first_run_event
      BEFORE INSERT ON project_events
      WHEN NEW.project_id = 'project-run-audit'
        AND NEW.type = 'project.run_changed'
      BEGIN
        SELECT RAISE(FAIL, 'run audit insert failed');
      END;
    `);
    database.close();

    const running = await startServer({
      environment: {
        NODE_ENV: 'test',
        MESH_PORT: '0',
        MESH_DATA_DIR: directory,
        MESH_DATABASE_PATH: 'mesh.sqlite',
        MESH_WORKSPACE_ROOT: directory,
        MESH_GIT_EXECUTABLE: trustedGitExecutable.path,
      },
      test: { driver: new FakeClaudeSessionDriver(), webRoot: directory },
    });
    const command = {
      protocolVersion: 1,
      idempotencyKey: 'start-run-audit',
      command: {
        type: 'project.run.start',
        payload: {
          projectId: project.id,
          concurrency: 1,
          expectedPolicyRevision: project.qaConfiguration.revision,
          expectedTasks: [
            {
              taskId: 'task-run-audit',
              revision: 1,
              automationStatus: 'disabled',
              automationGeneration: 0,
            },
          ],
          actor: { type: 'human', id: 'operator-run-audit' },
        },
      },
    };
    let closeError: unknown;
    const previousExitCode = process.exitCode;
    try {
      const failed = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: command,
      });
      const rejectedCommand = await running.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: command,
      });
      const rejectedSocket = await running.app.inject({
        method: 'GET',
        url: '/api/socket',
        headers: {
          connection: 'upgrade',
          upgrade: 'websocket',
          origin: running.origin,
        },
      });

      expect(failed.statusCode).toBe(500);
      expect(rejectedCommand.statusCode).toBe(503);
      expect(rejectedSocket.statusCode).toBe(503);
    } finally {
      closeError = await running.close().catch((error: unknown) => error);
      process.exitCode = previousExitCode;
    }
    expect(closeError).toMatchObject({ message: 'run audit insert failed' });
  });
});
