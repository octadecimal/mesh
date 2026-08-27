import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  QaCapabilityInvalidError,
  idSchema,
  projectSchema,
  taskAttemptSchema,
  taskSchema,
  type StableTaskErrorCode,
} from '@mesh-session-platform/contracts';

import { FakeClaudeSessionDriver } from '../claude/fake-driver.js';
import { GitAdapter } from '../platform/git.js';
import { QaVerificationExecutableUnavailableError } from '../platform/qa-verification-runner.js';
import { SessionRegistry } from '../runtime/session-registry.js';
import { TaskService } from '../tasks/task-service.js';
import type { QaExecutionService } from '../tasks/qa-execution-service.js';
import {
  ProjectRunServiceError,
  type ProjectRunService,
} from '../tasks/project-run-service.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { buildApp } from '../app.js';

const now = '2026-08-24T00:00:00.000Z';
const id = (value: string) => idSchema.parse(value);

const setup = (options?: {
  createId?: () => string;
  billingConflicts?: readonly { variable: string }[];
  discovered?: Array<{ claudeResumeId: string; title?: string }>;
  createIds?: string[];
  useDatabaseDirectoryAsWorkspace?: boolean;
  withGit?: boolean;
  gitExitCode?: number;
  seedProject?: boolean;
  projectRunMaxConcurrency?: number;
  projectRunService?: Pick<
    ProjectRunService,
    | 'startRun'
    | 'pauseRun'
    | 'resumeRun'
    | 'stopRun'
    | 'drainAvailableSlots'
    | 'observeTaskOutcome'
  >;
  qaExecutionService?: Pick<
    QaExecutionService,
    'launch' | 'submitVerdict' | 'repairInterrupted'
  >;
}) => {
  const repositories = createTestRepositories();
  const workspacePath = options?.useDatabaseDirectoryAsWorkspace
    ? dirname(repositories.path)
    : 'C:/code/mesh';
  if (options?.seedProject !== false) {
    repositories.projects.create(
      projectSchema.parse({
        id: id('p1'),
        displayName: 'Mesh',
        repositoryPath: workspacePath,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.workspaces.create({
      id: id('w1'),
      projectId: id('p1'),
      type: 'shared',
      path: workspacePath,
      cleanupState: 'active',
    });
    repositories.sessions.create({
      id: id('s1'),
      projectId: id('p1'),
      workspaceId: id('w1'),
      title: 'Session',
      permissionMode: 'interactive',
      lifecycleState: 'idle',
      createdAt: now,
      updatedAt: now,
    });
  }
  const driver = new FakeClaudeSessionDriver({
    discovered: options?.discovered,
  });
  const gitCalls: Array<{
    executable: string;
    args: readonly string[];
    cwd: string;
  }> = [];
  const pathOptions = { baseDirectory: workspacePath };
  const git = options?.withGit
    ? new GitAdapter(
        {
          run: async (executable, args, runOptions) => {
            gitCalls.push({ executable, args, cwd: runOptions.cwd });
            return {
              exitCode: options.gitExitCode ?? 0,
              stdout: '',
              stderr: options.gitExitCode ? 'git failed' : '',
            };
          },
        },
        pathOptions,
      )
    : undefined;
  const createId =
    options?.createId ??
    (options?.createIds
      ? () => {
          const next = options.createIds?.shift();
          if (!next) throw new Error('No test ID was configured');
          return next;
        }
      : undefined);
  const registry = new SessionRegistry({
    ...repositories,
    driver,
    closeDatabase: () => undefined,
  });
  const taskService = new TaskService({
    ...repositories,
    ...(createId ? { createId } : {}),
    now: () => now,
  });
  return {
    repositories,
    driver,
    registry,
    gitCalls,
    workspacePath,
    app: buildApp({
      ...repositories,
      taskService,
      registry,
      driver,
      pathOptions,
      git,
      ...options,
      createId,
    }),
  };
};

describe('HTTP command routes', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('maps a rejected QA capability to the stable forbidden envelope', async () => {
    const fixture = setup({
      qaExecutionService: {
        launch: async () => {
          throw new Error('unused');
        },
        submitVerdict: () => {
          throw new QaCapabilityInvalidError();
        },
        repairInterrupted: () => {
          throw new Error('unused');
        },
      },
    });
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
      fixture.repositories.dispose();
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'qa-verdict-invalid-capability',
        command: {
          type: 'task.qa.submit_verdict',
          payload: {
            capability: 'invalid-qa-capability',
            expectedRevision: 2,
            report: {
              disposition: 'rejected',
              criterionResults: [
                {
                  criterionId: 'criterion-1',
                  status: 'failed',
                  evidence: 'Focused test failed.',
                },
              ],
              limitations: [],
              residualRisks: ['The change remains unverified.'],
            },
            actor: { type: 'agent', id: 'qa-agent-1' },
          },
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'qa_capability_invalid',
        message: 'The QA capability is invalid.',
      },
    });
  });

  it('maps every canonical project-run failure to its stable HTTP envelope', async () => {
    let currentCode: StableTaskErrorCode = 'project_run_invalid';
    const fail = () => {
      throw new ProjectRunServiceError(
        currentCode,
        `Project run failed with ${currentCode}`,
        { runId: 'run-1' },
      );
    };
    const fixture = setup({
      projectRunService: {
        startRun: fail,
        pauseRun: fail,
        resumeRun: fail,
        stopRun: fail,
        drainAvailableSlots: async () => fail(),
        observeTaskOutcome: async () => undefined,
      },
    });
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });
    const cases = [
      ['project_run_not_found', 404],
      ['project_run_revision_conflict', 409],
      ['project_run_invalid', 400],
      ['project_run_transition_invalid', 409],
      ['project_run_conflict', 409],
      ['project_run_empty', 422],
      ['project_run_stale', 409],
      ['project_run_concurrency_exceeded', 422],
      ['project_run_not_controllable', 409],
    ] as const satisfies ReadonlyArray<readonly [StableTaskErrorCode, number]>;

    for (const [code, statusCode] of cases) {
      currentCode = code;
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/commands',
        payload: {
          protocolVersion: 1,
          idempotencyKey: `command-${code}`,
          command: {
            type: 'project.run.start',
            payload: {
              projectId: 'p1',
              concurrency: 1,
              actor: { type: 'human', id: 'operator-run' },
            },
          },
        },
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: {
          code,
          message: `Project run failed with ${code}`,
          details: { runId: 'run-1' },
        },
      });
    }
  });

  it('maps a manual QA baseline without approved Git to service unavailable', async () => {
    const fixture = setup({
      qaExecutionService: {
        launch: async () => {
          throw new QaVerificationExecutableUnavailableError();
        },
        submitVerdict: () => {
          throw new Error('unused');
        },
        repairInterrupted: () => {
          throw new Error('unused');
        },
      },
    });
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
      fixture.repositories.dispose();
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'qa-launch-git-unavailable',
        command: {
          type: 'task.qa.launch',
          payload: {
            taskId: 'task-ready-for-qa',
            expectedRevision: 4,
            actor: { type: 'human', id: 'operator-1' },
          },
        },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'qa_verification_executable_unavailable',
        message: expect.stringContaining('MESH_GIT_EXECUTABLE'),
      },
    });
  });

  it('does not persist a project while discovering a fresh workspace', async () => {
    const fixture = setup({
      createId: () => 'project-fresh',
      seedProject: false,
      useDatabaseDirectoryAsWorkspace: true,
    });
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        type: 'projects.discover',
        payload: {},
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({
      projects: [],
      suggestions: [],
    });
    expect(fixture.repositories.projects.get('project-fresh')).toBeUndefined();
  });

  it('returns the original response for a repeated idempotency key', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
      fixture.repositories.dispose();
    });
    await fixture.registry.create('s1');

    const payload = {
      protocolVersion: 1,
      idempotencyKey: 'key-1',
      command: {
        type: 'session.prompt',
        payload: { sessionId: 's1', prompt: 'hello' },
      },
    };
    const first = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload,
    });
    const second = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(fixture.driver.createdRequests).toHaveLength(1);
    expect(fixture.driver.createdSessions[0]?.prompts).toEqual(['hello']);
  });

  it('keeps raw diagnostics out of the ordinary snapshot', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/snapshot',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('rawDiagnostics');
    expect(response.json().sessions).toHaveLength(1);
  });

  it('keeps archived sessions in snapshots while excluding explicitly deleted sessions', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });
    fixture.repositories.sessions.create({
      id: id('s2'),
      projectId: id('p1'),
      workspaceId: id('w1'),
      title: 'Delete me',
      permissionMode: 'interactive',
      lifecycleState: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    const archived = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'archive-snapshot',
        command: {
          type: 'session.archive',
          payload: { sessionId: 's1' },
        },
      },
    });
    const deleted = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'delete-snapshot',
        command: {
          type: 'session.delete',
          payload: { sessionId: 's2', confirmed: true },
        },
      },
    });

    const snapshot = (
      await fixture.app.inject({ method: 'GET', url: '/api/snapshot' })
    ).json();

    expect(archived.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(200);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ id: 's1', lifecycleState: 'archived' }),
    ]);
  });

  it('returns reconstruction projections without raw diagnostics', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });
    fixture.repositories.events.append(
      's1',
      {
        id: 'e1',
        occurredAt: now,
        type: 'permission.requested',
        payload: {
          permissionId: 'permission-1',
          toolCallId: 'tool-1',
          name: 'Bash',
          input: {},
          actions: ['approve', 'deny'],
        },
      },
      {
        id: id('d1'),
        sessionId: id('s1'),
        capturedAt: now,
        payload: { secretRawSdkShape: true },
      },
    );
    fixture.repositories.layouts.save({
      id: id('layout-1'),
      sessionId: id('s1'),
      dockview: { activePanel: 's1' },
      visiblePanels: ['s1'],
      updatedAt: now,
    });

    const snapshot = (
      await fixture.app.inject({ method: 'GET', url: '/api/snapshot' })
    ).json();

    expect(snapshot.pendingApprovals).toHaveLength(1);
    expect(snapshot.lastSequenceBySession).toEqual({ s1: 1 });
    expect(snapshot.layouts).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('secretRawSdkShape');
  });

  it('clamps event page limits and keeps diagnostics on the diagnostics-only endpoint', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });
    for (let index = 1; index <= 3; index += 1) {
      fixture.repositories.events.append(
        's1',
        {
          id: `e${index}`,
          occurredAt: now,
          type: 'message.user',
          payload: { text: String(index) },
        },
        {
          id: id(`d${index}`),
          sessionId: id('s1'),
          capturedAt: now,
          payload: { raw: index },
        },
      );
    }

    const history = await fixture.app.inject({
      method: 'GET',
      url: '/api/sessions/s1/events?after=1&limit=999',
    });
    const diagnostics = await fixture.app.inject({
      method: 'GET',
      url: '/api/sessions/s1/diagnostics?after=d1&limit=1',
    });

    expect(history.statusCode).toBe(200);
    expect(
      history
        .json()
        .events.map((event: { sequence: number }) => event.sequence),
    ).toEqual([2, 3]);
    expect(diagnostics.json().diagnostics).toHaveLength(1);
    expect(diagnostics.json().diagnostics[0].payload).toEqual({ raw: 2 });
  });

  it('validates command envelopes and maps them to a stable invalid_command error', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: { command: { type: 'session.prompt', payload: {} } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_command' },
    });
  });

  it('persists a created session before one driver start and warns on a shared-path collision', async () => {
    const fixture = setup({ createId: () => 's2', billingConflicts: [] });
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
      fixture.repositories.dispose();
    });
    await fixture.registry.create('s1');
    const payload = {
      protocolVersion: 1,
      idempotencyKey: 'create-key',
      command: {
        type: 'session.create',
        payload: {
          projectId: 'p1',
          workspaceId: 'w1',
          title: 'Second',
          permissionMode: 'interactive',
        },
      },
    };

    const first = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload,
    });
    const second = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(fixture.repositories.sessions.get('s2')?.lifecycleState).toBe(
      'running',
    );
    expect(fixture.driver.createdRequests).toHaveLength(2);
    expect(first.json().warnings).toContainEqual(
      expect.objectContaining({ code: 'shared_workspace_collision' }),
    );
  });

  it('resumes only from a stored Claude ID and refuses a second live-driver attachment', async () => {
    const fixture = setup({ billingConflicts: [] });
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
      fixture.repositories.dispose();
    });
    fixture.repositories.events.append(
      's1',
      {
        id: 'resume-ready',
        occurredAt: now,
        type: 'session.status',
        payload: { from: 'idle', to: 'interrupted' },
      },
      {
        id: id('resume-ready-raw'),
        sessionId: id('s1'),
        capturedAt: now,
        payload: {},
      },
      { lifecycleState: 'interrupted', claudeResumeId: 'claude-1' },
    );
    fixture.repositories.workspaces.create({
      id: id('w2'),
      projectId: id('p1'),
      type: 'shared',
      path: join(fixture.workspacePath, 'alternate'),
      cleanupState: 'active',
    });

    const command = (key: string) => ({
      protocolVersion: 1,
      idempotencyKey: key,
      command: {
        type: 'session.resume',
        payload: {
          sessionId: 's1',
          workspaceId: 'w2',
          permissionMode: 'safe_auto',
        },
      },
    });
    const first = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: command('resume-1'),
    });
    const second = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: command('resume-2'),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: 'invalid_session_state' },
    });
    expect(fixture.driver.resumedRequests).toHaveLength(1);
    expect(fixture.driver.resumedRequests[0]).toMatchObject({
      workspacePath: join(fixture.workspacePath, 'alternate'),
      permissionMode: 'safe_auto',
    });
    expect(fixture.repositories.sessions.get('s1')).toMatchObject({
      workspaceId: 'w2',
      permissionMode: 'safe_auto',
    });
  });

  it('requires deletion confirmation, preserves workspaces, and restores saved layout', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });
    const envelope = (key: string, command: unknown) => ({
      protocolVersion: 1,
      idempotencyKey: key,
      command,
    });
    const rejected = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: envelope('delete-no', {
        type: 'session.delete',
        payload: { sessionId: 's1', confirmed: false },
      }),
    });
    const layout = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: envelope('layout', {
        type: 'layout.save',
        payload: {
          id: 'layout-1',
          sessionId: 's1',
          dockview: {},
          visiblePanels: ['s1'],
          updatedAt: now,
        },
      }),
    });
    expect(fixture.repositories.layouts.get('layout-1')).toBeDefined();
    const archived = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: envelope('archive', {
        type: 'session.archive',
        payload: { sessionId: 's1' },
      }),
    });
    const deleted = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: envelope('delete-yes', {
        type: 'session.delete',
        payload: { sessionId: 's1', confirmed: true },
      }),
    });

    expect(rejected.statusCode).toBe(400);
    expect(layout.statusCode).toBe(200);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().warnings).toContainEqual(
      expect.objectContaining({ code: 'workspace_preserved' }),
    );
    expect(deleted.statusCode).toBe(200);
    expect(fixture.repositories.sessions.get('s1')).toBeUndefined();
    expect(fixture.repositories.workspaces.get('w1')).toBeDefined();
    expect(fixture.repositories.layouts.get('layout-1')).toBeUndefined();
  });

  it('refuses API-billing configuration before starting a driver', async () => {
    const fixture = setup({
      billingConflicts: [{ variable: 'ANTHROPIC_API_KEY' }],
    });
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'create-billed',
        command: {
          type: 'session.create',
          payload: {
            projectId: 'p1',
            workspaceId: 'w1',
            title: 'Blocked',
            permissionMode: 'interactive',
          },
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'billing_configuration_conflict' },
    });
    expect(fixture.driver.createdRequests).toHaveLength(0);
  });

  it('merges discovered Claude metadata into durable application sessions', async () => {
    const fixture = setup({
      discovered: [{ claudeResumeId: 'claude-discovered', title: 'Recovered' }],
      createId: () => 's-discovered',
    });
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        type: 'sessions.discover',
        payload: { projectId: 'p1' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.sessions).toContainEqual(
      expect.objectContaining({
        id: 's-discovered',
        claudeResumeId: 'claude-discovered',
        lifecycleState: 'interrupted',
      }),
    );
    expect(fixture.repositories.sessions.get('s-discovered')?.title).toBe(
      'Recovered',
    );
    expect(fixture.driver.createdRequests).toHaveLength(0);
  });

  it('canonicalizes and persists a shared workspace before one driver start', async () => {
    const fixture = setup({
      useDatabaseDirectoryAsWorkspace: true,
      createIds: ['w2', 's2'],
      billingConflicts: [],
    });
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
      fixture.repositories.dispose();
    });
    await fixture.registry.create('s1');
    const payload = {
      protocolVersion: 1,
      idempotencyKey: 'shared-create',
      command: {
        type: 'session.create',
        payload: {
          projectId: 'p1',
          title: 'Shared child',
          permissionMode: 'interactive',
          workspace: { type: 'shared', path: fixture.workspacePath },
        },
      },
    };

    const first = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload,
    });
    const second = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(fixture.repositories.workspaces.get('w2')).toMatchObject({
      type: 'shared',
      path: fixture.workspacePath,
    });
    expect(fixture.repositories.sessions.get('s2')?.lifecycleState).toBe(
      'running',
    );
    expect(fixture.driver.createdRequests).toHaveLength(2);
    expect(first.json().warnings).toContainEqual(
      expect.objectContaining({ code: 'shared_workspace_collision' }),
    );
  });

  it('creates and records a Mesh-owned worktree before starting the driver', async () => {
    const fixture = setup({
      useDatabaseDirectoryAsWorkspace: true,
      createIds: ['w2', 's2'],
      billingConflicts: [],
      withGit: true,
    });
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
      fixture.repositories.dispose();
    });
    const worktreePath = join(fixture.workspacePath, 'feature-worktree');

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'worktree-create',
        command: {
          type: 'session.create',
          payload: {
            projectId: 'p1',
            title: 'Worktree child',
            permissionMode: 'safe_auto',
            workspace: {
              type: 'worktree',
              repositoryPath: fixture.workspacePath,
              path: worktreePath,
              branch: 'feature/http',
              startPoint: 'main',
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.gitCalls).toContainEqual({
      executable: 'git',
      args: [
        '-C',
        fixture.workspacePath,
        'worktree',
        'add',
        '-b',
        'feature/http',
        worktreePath,
        'main',
      ],
      cwd: fixture.workspacePath,
    });
    expect(fixture.repositories.workspaces.get('w2')).toMatchObject({
      type: 'worktree',
      path: worktreePath,
      gitBranch: 'feature/http',
      gitWorktreePath: worktreePath,
      owner: 'mesh',
    });
    expect(fixture.repositories.sessions.get('s2')?.lifecycleState).toBe(
      'running',
    );
    expect(fixture.driver.createdRequests).toHaveLength(1);
  });

  it('reports worktree creation failure without starting a driver or persisting records', async () => {
    const fixture = setup({
      useDatabaseDirectoryAsWorkspace: true,
      createIds: ['w2', 's2'],
      billingConflicts: [],
      withGit: true,
      gitExitCode: 1,
    });
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'worktree-failed',
        command: {
          type: 'session.create',
          payload: {
            projectId: 'p1',
            title: 'Worktree child',
            permissionMode: 'interactive',
            workspace: {
              type: 'worktree',
              repositoryPath: fixture.workspacePath,
              path: join(fixture.workspacePath, 'failed-worktree'),
              branch: 'feature/fail',
              startPoint: 'main',
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'workspace_preserved' },
    });
    expect(fixture.repositories.workspaces.get('w2')).toBeUndefined();
    expect(fixture.repositories.sessions.get('s2')).toBeUndefined();
    expect(fixture.driver.createdRequests).toHaveLength(0);
  });

  it('removes only a confirmed stopped Mesh-owned worktree before deleting its session', async () => {
    const fixture = setup({
      useDatabaseDirectoryAsWorkspace: true,
      withGit: true,
    });
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });
    const worktreePath = join(fixture.workspacePath, 'owned-worktree');
    mkdirSync(worktreePath);
    fixture.repositories.workspaces.create({
      id: id('w2'),
      projectId: id('p1'),
      type: 'worktree',
      path: worktreePath,
      gitBranch: 'feature/delete',
      gitWorktreePath: worktreePath,
      owner: 'mesh',
      cleanupState: 'active',
    });
    fixture.repositories.sessions.create({
      id: id('s2'),
      projectId: id('p1'),
      workspaceId: id('w2'),
      title: 'Stopped',
      permissionMode: 'interactive',
      lifecycleState: 'interrupted',
      createdAt: now,
      updatedAt: now,
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'delete-worktree',
        command: {
          type: 'session.delete',
          payload: { sessionId: 's2', confirmed: true },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.repositories.sessions.get('s2')).toBeUndefined();
    expect(fixture.repositories.workspaces.get('w2')?.cleanupState).toBe(
      'cleaned',
    );
    expect(fixture.gitCalls.at(-1)).toEqual({
      executable: 'git',
      args: ['-C', fixture.workspacePath, 'worktree', 'remove', worktreePath],
      cwd: fixture.workspacePath,
    });
  });

  it('refuses to archive a session while its driver is live', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      await fixture.registry.shutdown();
      fixture.repositories.dispose();
    });
    await fixture.registry.create('s1');

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'archive-live',
        command: {
          type: 'session.archive',
          payload: { sessionId: 's1' },
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_session_state' },
    });
    expect(fixture.repositories.sessions.get('s1')?.lifecycleState).toBe(
      'running',
    );
  });

  it('returns only the selected project records and its latest event cursor', async () => {
    const fixture = setup({ projectRunMaxConcurrency: 6 });
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });
    fixture.repositories.projects.create(
      projectSchema.parse({
        id: id('p2'),
        displayName: 'Other',
        repositoryPath: 'C:/code/other',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    fixture.repositories.workspaces.create({
      id: id('w2'),
      projectId: id('p2'),
      type: 'shared',
      path: 'C:/code/other',
      cleanupState: 'active',
    });
    fixture.repositories.sessions.create({
      id: id('s2'),
      projectId: id('p2'),
      workspaceId: id('w2'),
      title: 'Other session',
      permissionMode: 'interactive',
      lifecycleState: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    const task = (taskId: string, projectId: string) =>
      taskSchema.parse({
        id: taskId,
        projectId,
        title: `Task ${taskId}`,
        description: '',
        acceptanceCriteria: [],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'backlog',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    const selectedTask = fixture.repositories.tasks.create(task('t1', 'p1'));
    const otherTask = fixture.repositories.tasks.create(task('t2', 'p2'));
    fixture.repositories.projectRuns.create({
      id: 'run-p1',
      projectId: 'p1',
      concurrency: 2,
      startedAt: now,
      items: [],
    });
    fixture.repositories.projectRuns.create({
      id: 'run-p2',
      projectId: 'p2',
      concurrency: 1,
      startedAt: now,
      items: [],
    });
    const actor = { type: 'human' as const, id: id('human-1') };
    fixture.repositories.attempts.create(
      taskAttemptSchema.parse({
        id: id('a1'),
        taskId: selectedTask.id,
        sessionId: id('s1'),
        ordinal: 1,
        source: 'linked',
        actor,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: null,
      }),
    );
    fixture.repositories.attempts.create(
      taskAttemptSchema.parse({
        id: id('a2'),
        taskId: otherTask.id,
        sessionId: id('s2'),
        ordinal: 1,
        source: 'linked',
        actor,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: null,
      }),
    );
    fixture.repositories.transitions.append({
      id: id('transition-1'),
      taskId: selectedTask.id,
      commandId: id('command-1'),
      previousState: 'backlog',
      nextState: 'ready',
      actor,
      reason: 'Ready',
      occurredAt: now,
    });
    fixture.repositories.transitions.append({
      id: id('transition-2'),
      taskId: otherTask.id,
      commandId: id('command-2'),
      previousState: 'backlog',
      nextState: 'ready',
      actor,
      reason: 'Ready',
      occurredAt: now,
    });
    const appendTaskEvent = (
      projectId: string,
      eventId: string,
      eventTask: typeof selectedTask,
    ) =>
      fixture.repositories.projectEvents.append(projectId, {
        protocolVersion: 1,
        id: id(eventId),
        projectId: id(projectId),
        occurredAt: now,
        type: 'task.changed',
        payload: { task: eventTask },
      });
    appendTaskEvent('p1', 'project-event-1', selectedTask);
    appendTaskEvent('p1', 'project-event-2', selectedTask);
    appendTaskEvent('p2', 'project-event-3', otherTask);

    const snapshot = await fixture.app.inject({
      method: 'GET',
      url: '/api/projects/p1/snapshot',
    });
    const history = await fixture.app.inject({
      method: 'GET',
      url: '/api/projects/p1/history?after=1',
    });

    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      project: { id: 'p1' },
      tasks: [{ id: 't1' }],
      attempts: [{ id: 'a1', taskId: 't1' }],
      transitions: [{ id: 'transition-1', taskId: 't1' }],
      repairs: [],
      runs: [{ id: 'run-p1', projectId: 'p1' }],
      projectRunLimits: { maxConcurrency: 6 },
      cursor: 2,
    });
    expect(JSON.stringify(snapshot.json())).not.toContain('t2');
    expect(JSON.stringify(snapshot.json())).not.toContain('a2');
    expect(JSON.stringify(snapshot.json())).not.toContain('transition-2');
    expect(JSON.stringify(snapshot.json())).not.toContain('run-p2');
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      projectId: 'p1',
      cursor: 2,
      events: [{ projectId: 'p1', sequence: 2 }],
    });
  });

  it('returns 404 for missing project reads and rejects negative history cursors', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });

    const missingSnapshot = await fixture.app.inject({
      method: 'GET',
      url: '/api/projects/missing/snapshot',
    });
    const missingHistory = await fixture.app.inject({
      method: 'GET',
      url: '/api/projects/missing/history',
    });
    const invalidCursor = await fixture.app.inject({
      method: 'GET',
      url: '/api/projects/p1/history?after=-1',
    });

    expect(missingSnapshot.statusCode).toBe(404);
    expect(missingSnapshot.json()).toMatchObject({
      error: { code: 'project_not_found' },
    });
    expect(missingHistory.statusCode).toBe(404);
    expect(missingHistory.json()).toMatchObject({
      error: { code: 'project_not_found' },
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toMatchObject({
      error: { code: 'invalid_command' },
    });
  });

  it('publishes a project event only after the task mutation is committed', async () => {
    const fixture = setup();
    cleanups.push(async () => {
      await fixture.app.close();
      fixture.repositories.dispose();
    });
    const observed: Array<{ sequence: number; persistedSequence: number }> = [];
    const unsubscribe = fixture.registry.publisher.subscribeProject(
      'p1',
      (event) => {
        observed.push({
          sequence: event.sequence,
          persistedSequence:
            fixture.repositories.projectEvents.latestSequence('p1'),
        });
      },
    );
    cleanups.push(unsubscribe);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/commands',
      payload: {
        protocolVersion: 1,
        idempotencyKey: 'task-create-1',
        command: {
          type: 'task.create',
          payload: {
            projectId: 'p1',
            title: 'Stream me',
            actor: { type: 'human', id: 'human-1' },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(observed).toEqual([{ sequence: 1, persistedSequence: 1 }]);
  });
});
