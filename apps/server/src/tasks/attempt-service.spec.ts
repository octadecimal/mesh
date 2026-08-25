import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  workspaceSchema,
  type Task,
} from '@mesh-session-platform/contracts';

import type { ClaudeSessionDriver } from '../claude/driver.js';
import type { GitAdapter } from '../platform/git.js';
import {
  FakeClaudeSessionDriver,
  FakeDriverSession,
} from '../claude/fake-driver.js';
import { SessionRegistry } from '../runtime/session-registry.js';
import type { RepositoryIdentity } from '../projects/repository-identity.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { AttemptService } from './attempt-service.js';
import { TaskService } from './task-service.js';

const now = '2026-08-25T12:00:00.000Z';
const actor = taskActorSchema.parse({ type: 'human', id: 'operator-1' });

describe('AttemptService', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const setup = (options?: {
    repositories?: Parameters<typeof createTestRepositories>[0];
    driver?: ClaudeSessionDriver;
    git?: Pick<GitAdapter, 'createWorktree'>;
    interrupt?: (sessionId: string) => Promise<void>;
  }) => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-attempt-service-'));
    const repositories = createTestRepositories(options?.repositories);
    const driver = options?.driver ?? new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    let nextId = 0;
    const createId = () => `generated-${++nextId}`;
    const taskService = new TaskService({
      ...repositories,
      now: () => now,
      createId,
    });
    const service = new AttemptService({
      ...repositories,
      taskService,
      registry: {
        create: (sessionId) => registry.create(sessionId),
        interrupt:
          options?.interrupt ?? ((sessionId) => registry.interrupt(sessionId)),
        publisher: registry.publisher,
      },
      git: options?.git,
      pathOptions: { baseDirectory: directory },
      resolveIdentity: async (path) =>
        ({
          canonicalPath: path,
          commonDirectory: path,
          repositoryIdentity: path,
        }) as RepositoryIdentity,
      now: () => now,
      createId,
    });
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project one',
        repositoryPath: directory,
        repositoryIdentity: 'repository-1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
      rmSync(directory, { force: true, recursive: true });
    });
    return { directory, driver, registry, repositories, service };
  };

  const seedTask = (
    repositories: ReturnType<typeof createTestRepositories>,
    overrides: Partial<Task> = {},
  ) =>
    repositories.tasks.create(
      taskSchema.parse({
        id: 'task-1',
        projectId: 'project-1',
        title: 'Implement attempt launch',
        description: 'Compose the existing session boundary safely.',
        acceptanceCriteria: ['Startup advances the task only after success.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }),
    );

  const launchInput = (directory: string) => ({
    commandId: 'attempt-launch-1',
    taskId: 'task-1',
    expectedRevision: 1,
    title: 'Attempt one',
    permissionMode: 'interactive' as const,
    workspace: { type: 'shared' as const, path: directory },
    actor,
  });

  const seedSession = (
    repositories: ReturnType<typeof createTestRepositories>,
    options: { projectId?: string; sessionId?: string } = {},
  ) => {
    const projectId = options.projectId ?? 'project-1';
    const sessionId = options.sessionId ?? 'session-1';
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: `workspace-${sessionId}`,
        projectId,
        type: 'shared',
        path: `C:/work/${projectId}`,
      }),
    );
    return repositories.sessions.create(
      sessionSchema.parse({
        id: sessionId,
        projectId,
        workspaceId: `workspace-${sessionId}`,
        title: 'Existing session',
        permissionMode: 'interactive',
        lifecycleState: 'interrupted',
        createdAt: now,
        updatedAt: now,
      }),
    );
  };

  const requireOnlyAttempt = (
    repositories: ReturnType<typeof createTestRepositories>,
  ) => {
    const [attempt] = repositories.attempts.listByTask('task-1');
    if (!attempt) throw new Error('Expected one task attempt');
    return attempt;
  };

  it('persists the launched attempt, starts its runtime, then audits in_progress', async () => {
    const { directory, driver, repositories, service } = setup();
    seedTask(repositories);

    const result = await service.launch(launchInput(directory));

    expect(result).toMatchObject({
      task: { id: 'task-1', lifecycleState: 'in_progress', revision: 2 },
      attempt: { taskId: 'task-1', ordinal: 1, source: 'launched' },
      session: { lifecycleState: 'running' },
    });
    expect((driver as FakeClaudeSessionDriver).createdRequests).toHaveLength(1);
    expect(repositories.attempts.listByTask('task-1')).toHaveLength(1);
    expect(
      repositories.projectEvents
        .after('project-1', 0)
        .map((event) => event.type),
    ).toEqual(['task.attempt_changed', 'task.transitioned']);
  });

  it('retains the session and attempt but leaves the task ready when startup fails', async () => {
    const unavailable = new Error('driver unavailable');
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => {
        throw unavailable;
      },
      resume: async () => new FakeDriverSession('unused'),
    };
    const { directory, repositories, service } = setup({ driver });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'attempt_start_failed',
    });

    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
    expect(repositories.attempts.listByTask('task-1')).toHaveLength(1);
    expect(repositories.sessions.listByProject('project-1')).toHaveLength(1);
    expect(
      repositories.diagnostics.list(requireOnlyAttempt(repositories).sessionId),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          stage: 'startup',
          outcome: 'failed',
        }),
      }),
    ]);
  });

  it.each([
    [
      'not ready',
      { lifecycleState: 'backlog' as const },
      'task_transition_invalid',
    ],
    [
      'blocked',
      {
        blocked: { reason: 'Waiting', actor, blockedAt: now },
      },
      'task_blocked',
    ],
  ])(
    'rejects a %s task before creating a session',
    async (_name, patch, code) => {
      const { directory, driver, repositories, service } = setup();
      seedTask(repositories, patch);

      await expect(
        service.launch(launchInput(directory)),
      ).rejects.toMatchObject({
        code,
      });

      expect(repositories.sessions.listByProject('project-1')).toEqual([]);
      expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
    },
  );

  it('rejects a stale revision before creating a session', async () => {
    const { directory, driver, repositories, service } = setup();
    seedTask(repositories, { revision: 2 });

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'task_revision_conflict',
    });

    expect(repositories.sessions.listByProject('project-1')).toEqual([]);
    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
  });

  it('does not start a runtime when the attempt audit transaction fails', async () => {
    const { directory, driver, repositories, service } = setup({
      repositories: { failProjectEventInsert: true },
    });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'audit_unavailable',
    });

    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
    expect(repositories.sessions.listByProject('project-1')).toEqual([]);
    expect(repositories.attempts.listByTask('task-1')).toEqual([]);
  });

  it('preserves a worktree when filesystem creation does not complete', async () => {
    const { directory, driver, repositories, service } = setup({
      git: {
        createWorktree: async () => {
          throw new Error('git worktree add failed');
        },
      },
    });
    seedTask(repositories);

    await expect(
      service.launch({
        ...launchInput(directory),
        workspace: {
          type: 'worktree',
          repositoryPath: directory,
          path: join(directory, 'attempt-worktree'),
          branch: 'attempt-branch',
          startPoint: 'HEAD',
        },
      }),
    ).rejects.toMatchObject({ code: 'workspace_preserved' });

    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
    expect(repositories.sessions.listByProject('project-1')).toEqual([]);
  });

  it('interrupts and diagnoses the runtime when the task transition audit fails', async () => {
    const { directory, driver, repositories, service } = setup({
      repositories: { failTaskTransitionInsert: true },
    });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'attempt_start_failed',
    });

    expect(
      (driver as FakeClaudeSessionDriver).createdSessions[0]?.interrupted,
    ).toBe(true);
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
    const attempt = requireOnlyAttempt(repositories);
    expect(repositories.diagnostics.list(attempt.sessionId)).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          stage: 'task_transition',
          cleanup: 'interrupted',
        }),
      }),
    );
  });

  it('requires reconciliation when post-start interruption cannot be proven', async () => {
    const { directory, repositories, service } = setup({
      repositories: { failTaskTransitionInsert: true },
      interrupt: async () => {
        throw new Error('interrupt outcome unknown');
      },
    });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'attempt_reconciliation_required',
    });

    const attempt = requireOnlyAttempt(repositories);
    expect(repositories.diagnostics.list(attempt.sessionId)).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          stage: 'task_transition',
          cleanup: 'unknown',
        }),
      }),
    );
  });

  it('links a same-repository session without changing task lifecycle', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);
    seedSession(repositories);

    const result = await service.link({
      commandId: 'attempt-link-1',
      taskId: 'task-1',
      expectedRevision: 1,
      sessionId: 'session-1',
      actor,
    });

    expect(result).toMatchObject({
      task: { lifecycleState: 'ready', revision: 1 },
      attempt: { sessionId: 'session-1', source: 'linked', ordinal: 1 },
    });
    expect(repositories.tasks.get('task-1')).toMatchObject({
      lifecycleState: 'ready',
      revision: 1,
    });
  });

  it('rejects cross-repository and already-linked sessions', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-2',
        displayName: 'Project two',
        repositoryPath: 'C:/different',
        repositoryIdentity: 'repository-2',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    seedSession(repositories, { projectId: 'project-2', sessionId: 'other' });

    await expect(
      service.link({
        commandId: 'attempt-link-cross',
        taskId: 'task-1',
        expectedRevision: 1,
        sessionId: 'other',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'session_repository_mismatch' });

    seedSession(repositories);
    repositories.attempts.createForTask('task-1', 'session-1', 'linked', actor);
    await expect(
      service.link({
        commandId: 'attempt-link-duplicate',
        taskId: 'task-1',
        expectedRevision: 1,
        sessionId: 'session-1',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'session_already_linked' });
  });

  it('requires an unlink reason and preserves both rows when relinking', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);
    seedSession(repositories);
    const first = await service.link({
      commandId: 'attempt-link-first',
      taskId: 'task-1',
      expectedRevision: 1,
      sessionId: 'session-1',
      actor,
    });

    await expect(
      service.unlink({
        commandId: 'attempt-unlink-empty',
        taskId: 'task-1',
        expectedRevision: 1,
        attemptId: first.attempt.id,
        reason: ' ',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_command' });

    const unlinked = await service.unlink({
      commandId: 'attempt-unlink-1',
      taskId: 'task-1',
      expectedRevision: 1,
      attemptId: first.attempt.id,
      reason: 'Linked to the wrong task',
      actor,
    });
    const second = await service.link({
      commandId: 'attempt-link-second',
      taskId: 'task-1',
      expectedRevision: 1,
      sessionId: 'session-1',
      actor,
    });

    expect(unlinked.attempt).toMatchObject({
      unlinkReason: 'Linked to the wrong task',
      unlinkedBy: actor,
    });
    expect(second.attempt.ordinal).toBe(2);
    expect(repositories.attempts.listByTask('task-1')).toEqual([
      unlinked.attempt,
      second.attempt,
    ]);
  });
});
