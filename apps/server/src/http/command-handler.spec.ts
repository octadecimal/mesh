import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import {
  developerExecutionCycleSchema,
  idSchema,
  projectSchema,
  sessionSchema,
  taskAttemptSchema,
  taskSchema,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { FakeClaudeSessionDriver } from '../claude/fake-driver.js';
import { SessionRegistry } from '../runtime/session-registry.js';
import { TaskService } from '../tasks/task-service.js';
import { AttemptService } from '../tasks/attempt-service.js';
import { DeveloperCapabilityRegistry } from '../tasks/developer-capability-registry.js';
import { DeveloperExecutionService } from '../tasks/developer-execution-service.js';
import { DeveloperReworkService } from '../tasks/developer-rework-service.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { executeCommand } from './command-handler.js';
import { toHttpError } from './errors.js';

const now = '2026-08-24T00:00:00.000Z';
const exec = promisify(execFile);

const runGit = async (cwd: string, ...args: string[]) => {
  await exec('git', args, { cwd, windowsHide: true });
};

describe('executeCommand', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const createRepository = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mesh-command-project-'));
    const repositoryPath = join(directory, 'repository');
    await runGit(directory, 'init', repositoryPath);
    await writeFile(join(repositoryPath, 'README.md'), 'repository\n');
    await runGit(repositoryPath, 'add', 'README.md');
    await runGit(
      repositoryPath,
      '-c',
      'user.name=Mesh Test',
      '-c',
      'user.email=mesh@example.test',
      'commit',
      '-m',
      'initial',
    );
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return { directory, repositoryPath };
  };

  const commandDependencies = (
    baseDirectory: string,
    createId: () => string = () => 'project-created',
  ) => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const capabilities = new DeveloperCapabilityRegistry();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) =>
        capabilities.invalidateSession(sessionId),
      closeDatabase: () => undefined,
    });
    const taskService = new TaskService({
      ...repositories,
      now: () => now,
      createId,
    });
    const developerExecutionService = new DeveloperExecutionService({
      ...repositories,
      taskService,
      capabilities,
      publisher: registry.publisher,
      now: () => now,
      createId,
    });
    const developerReworkService = new DeveloperReworkService({
      ...repositories,
      taskService,
      capabilities,
      developerExecutionService,
      registry,
      now: () => now,
      createId,
    });
    const pathOptions = { baseDirectory };
    const attemptService = new AttemptService({
      ...repositories,
      taskService,
      capabilities,
      developerReworkService,
      registry,
      pathOptions,
      now: () => now,
      createId,
    });
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    return {
      repositories,
      dependencies: {
        ...repositories,
        taskService,
        attemptService,
        developerExecutionService,
        registry,
        driver,
        pathOptions,
        now: () => now,
        createId,
      },
    };
  };

  const projectCommand = (idempotencyKey: string, command: unknown) => ({
    protocolVersion: 1,
    idempotencyKey,
    command,
  });

  it.each(['system', 'agent'] as const)(
    'rejects %s actors before project and task mutations',
    async (actorType) => {
      const { directory, repositoryPath } = await createRepository();
      const { repositories, dependencies } = commandDependencies(directory);
      repositories.projects.create(
        projectSchema.parse({
          id: 'p1',
          displayName: 'Original',
          repositoryPath,
          repositoryIdentity: 'repository-1',
          discoveredAt: now,
          discoveryMetadata: {},
        }),
      );
      const actor = { type: actorType, id: `${actorType}-1` };

      await expect(
        executeCommand(
          projectCommand(`rename-${actorType}`, {
            type: 'project.rename',
            payload: {
              projectId: 'p1',
              expectedRevision: 1,
              displayName: 'Unauthorized',
              actor,
            },
          }),
          dependencies,
        ),
      ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });
      await expect(
        executeCommand(
          projectCommand(`task-${actorType}`, {
            type: 'task.create',
            payload: { projectId: 'p1', title: 'Unauthorized', actor },
          }),
          dependencies,
        ),
      ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });
      expect(repositories.projects.get('p1')?.displayName).toBe('Original');
      expect(repositories.tasks.listByProject('p1')).toEqual([]);
    },
  );

  it.each(['system', 'agent'] as const)(
    'rejects %s actors from updating developer instructions',
    async (actorType) => {
      const { directory } = await createRepository();
      const { repositories, dependencies } = commandDependencies(directory);
      repositories.projects.create(
        projectSchema.parse({
          id: 'p1',
          displayName: 'Project',
          repositoryPath: directory,
          repositoryIdentity: 'repository-p1',
          discoveredAt: now,
          discoveryMetadata: {},
        }),
      );

      const error = await executeCommand(
        projectCommand(`instructions-${actorType}`, {
          type: 'project.developer_instructions.update',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            content: 'Do not mutate this project.',
            actor: { type: actorType, id: `${actorType}-1` },
          },
        }),
        dependencies,
      ).catch((caught: unknown) => caught);

      expect(toHttpError(error)).toMatchObject({
        statusCode: 400,
        body: { error: { code: 'invalid_command' } },
      });
      expect(
        repositories.projects.get('p1')?.developerInstructions.content,
      ).toBe('');
    },
  );

  it('updates developer instructions atomically before publishing and reuses the original response', async () => {
    const { directory } = await createRepository();
    const ids = ['instructions-event'];
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => ids.shift() ?? 'unexpected-id',
    );
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const publishedAfterPersistence: boolean[] = [];
    dependencies.registry.publisher.subscribeProject('p1', (event) => {
      publishedAfterPersistence.push(
        repositories.projectEvents
          .after('p1', 0)
          .some(({ id }) => id === event.id),
      );
    });
    const command = projectCommand('instructions-update', {
      type: 'project.developer_instructions.update',
      payload: {
        projectId: 'p1',
        expectedRevision: 1,
        content: 'Run the narrowest relevant checks.',
        actor: { type: 'human', id: 'operator' },
      },
    });

    const first = await executeCommand(command, dependencies);
    const duplicate = await executeCommand(command, dependencies);

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      commandType: 'project.developer_instructions.update',
      result: {
        id: 'p1',
        revision: 2,
        developerInstructions: {
          content: 'Run the narrowest relevant checks.',
          revision: 2,
          updatedAt: now,
          updatedBy: { type: 'human', id: 'operator' },
        },
      },
    });
    expect(repositories.projectEvents.after('p1', 0)).toEqual([
      expect.objectContaining({
        id: 'instructions-event',
        type: 'project.developer_instructions_changed',
      }),
    ]);
    expect(publishedAfterPersistence).toEqual([true]);
  });

  it('returns the current project for a stale developer-instruction revision', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );

    const error = await executeCommand(
      projectCommand('instructions-stale', {
        type: 'project.developer_instructions.update',
        payload: {
          projectId: 'p1',
          expectedRevision: 2,
          content: 'Stale content.',
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    ).catch((caught: unknown) => caught);

    expect(toHttpError(error)).toMatchObject({
      statusCode: 409,
      body: {
        error: {
          code: 'project_revision_conflict',
          details: {
            project: expect.objectContaining({ id: 'p1', revision: 1 }),
          },
        },
      },
    });
  });

  it.each(['system', 'agent'] as const)(
    'rejects %s actors from updating QA configuration',
    async (actorType) => {
      const { directory } = await createRepository();
      const { repositories, dependencies } = commandDependencies(directory);
      repositories.projects.create(
        projectSchema.parse({
          id: 'p1',
          displayName: 'Project',
          repositoryPath: directory,
          repositoryIdentity: 'repository-p1',
          discoveredAt: now,
          discoveryMetadata: {},
        }),
      );

      const error = await executeCommand(
        projectCommand(`qa-configuration-${actorType}`, {
          type: 'project.qa_configuration.update',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            content: 'Do not mutate this project.',
            reviewPolicy: 'autonomous_review',
            actor: { type: actorType, id: `${actorType}-1` },
          },
        }),
        dependencies,
      ).catch((caught: unknown) => caught);

      expect(toHttpError(error)).toMatchObject({
        statusCode: 400,
        body: { error: { code: 'invalid_command' } },
      });
      expect(repositories.projects.get('p1')?.qaConfiguration).toMatchObject({
        instructions: { content: '', revision: 1, updatedBy: null },
        reviewPolicy: 'manual',
        revision: 1,
        updatedBy: null,
      });
    },
  );

  it('updates QA configuration by its own revision before publishing and reuses the original response', async () => {
    const { directory } = await createRepository();
    const ids = ['qa-configuration-event'];
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => ids.shift() ?? 'unexpected-id',
    );
    const project = repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const renamedInstructions =
      repositories.projects.updateDeveloperInstructions(
        project.id,
        project.revision,
        {
          content: 'The project revision can change independently.',
          updatedAt: now,
          updatedBy: { type: 'human', id: 'operator' },
        },
      );
    if (!renamedInstructions) throw new Error('Expected project update');

    const publishedAfterPersistence: boolean[] = [];
    dependencies.registry.publisher.subscribeProject('p1', (event) => {
      publishedAfterPersistence.push(
        repositories.projectEvents
          .after('p1', 0)
          .some(({ id }) => id === event.id),
      );
    });
    const command = projectCommand('qa-configuration-update', {
      type: 'project.qa_configuration.update',
      payload: {
        projectId: 'p1',
        expectedRevision: 1,
        content: 'Run the focused server test before handoff.',
        reviewPolicy: 'autonomous_review',
        actor: { type: 'human', id: 'qa-operator', displayName: 'QA Operator' },
      },
    });

    const first = await executeCommand(command, dependencies);
    const duplicate = await executeCommand(command, dependencies);

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      commandType: 'project.qa_configuration.update',
      result: {
        id: 'p1',
        revision: 3,
        qaConfiguration: {
          instructions: {
            content: 'Run the focused server test before handoff.',
            revision: 2,
            updatedBy: {
              type: 'human',
              id: 'qa-operator',
              displayName: 'QA Operator',
            },
          },
          reviewPolicy: 'autonomous_review',
          revision: 2,
          updatedBy: {
            type: 'human',
            id: 'qa-operator',
            displayName: 'QA Operator',
          },
        },
      },
    });
    expect(repositories.projectEvents.after('p1', 0)).toEqual([
      expect.objectContaining({
        id: 'qa-configuration-event',
        type: 'project.qa_configuration_changed',
      }),
    ]);
    expect(publishedAfterPersistence).toEqual([true]);
  });

  it('returns the current project for a stale QA configuration revision', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
        qaConfiguration: {
          instructions: {
            content: 'Current configuration.',
            revision: 2,
            updatedAt: now,
            updatedBy: { type: 'human', id: 'operator' },
          },
          reviewPolicy: 'autonomous_review',
          revision: 2,
          updatedAt: now,
          updatedBy: { type: 'human', id: 'operator' },
        },
      }),
    );

    const error = await executeCommand(
      projectCommand('qa-configuration-stale', {
        type: 'project.qa_configuration.update',
        payload: {
          projectId: 'p1',
          expectedRevision: 1,
          content: 'Stale content.',
          reviewPolicy: 'manual',
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    ).catch((caught: unknown) => caught);

    expect(toHttpError(error)).toMatchObject({
      statusCode: 409,
      body: {
        error: {
          code: 'project_revision_conflict',
          details: {
            project: expect.objectContaining({
              id: 'p1',
              qaConfiguration: expect.objectContaining({ revision: 2 }),
            }),
          },
        },
      },
    });
  });

  it('rejects developer-instruction updates for archived projects', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
        archivedAt: now,
      }),
    );

    await expect(
      executeCommand(
        projectCommand('instructions-archived', {
          type: 'project.developer_instructions.update',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            content: 'Cannot update archived projects.',
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'project_archived' });
  });

  it('imports a Git repository once and reports the existing project for a duplicate identity', async () => {
    const { directory, repositoryPath } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    const linkedWorktreePath = join(directory, 'linked-worktree');
    await runGit(
      repositoryPath,
      'worktree',
      'add',
      '--detach',
      linkedWorktreePath,
      'HEAD',
    );

    const imported = await executeCommand(
      projectCommand('project-import', {
        type: 'project.import',
        payload: {
          repositoryPath,
          displayName: 'Imported repository',
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    );

    expect(imported.result).toMatchObject({
      id: 'project-created',
      displayName: 'Imported repository',
      repositoryPath,
    });
    expect(repositories.projects.list()).toHaveLength(1);
    await expect(
      executeCommand(
        projectCommand('project-import-duplicate', {
          type: 'project.import',
          payload: {
            repositoryPath: linkedWorktreePath,
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: 'repository_already_imported',
      details: { project: expect.objectContaining({ id: 'project-created' }) },
    });
  });

  it('rejects an import represented by duplicate upgraded legacy repository paths', async () => {
    const { directory, repositoryPath } = await createRepository();
    const linkedWorktreePath = join(directory, 'legacy-linked-worktree');
    await runGit(
      repositoryPath,
      'worktree',
      'add',
      '--detach',
      linkedWorktreePath,
      'HEAD',
    );
    const { repositories, dependencies } = commandDependencies(directory);
    for (const [id, legacyPath] of [
      ['legacy-main', repositoryPath],
      ['legacy-worktree', linkedWorktreePath],
    ] as const) {
      repositories.projects.create(
        projectSchema.parse({
          id,
          displayName: id,
          repositoryPath: legacyPath,
          repositoryIdentity: legacyPath,
          discoveredAt: now,
          discoveryMetadata: { source: 'workspace_root' },
        }),
      );
    }

    await expect(
      executeCommand(
        projectCommand('import-upgraded-legacy', {
          type: 'project.import',
          payload: {
            repositoryPath,
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: 'repository_already_imported',
      details: {
        project: expect.objectContaining({ id: 'legacy-main' }),
      },
    });
    const reconciledProjects = repositories.projects.list();
    expect(reconciledProjects.map((project) => project.id)).toEqual([
      'legacy-main',
      'legacy-worktree',
    ]);
    expect([
      ...new Set(
        reconciledProjects.map((project) => project.repositoryIdentity),
      ),
    ]).toHaveLength(1);
    expect(reconciledProjects.map((project) => project.revision)).toEqual([
      2, 2,
    ]);
  });

  it('returns Git repository suggestions without persisting a project', async () => {
    const { directory, repositoryPath } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);

    const discovered = await executeCommand(
      { protocolVersion: 1, type: 'projects.discover', payload: {} },
      dependencies,
    );

    expect(discovered.result).toEqual({
      projects: [],
      suggestions: [
        expect.objectContaining({
          displayName: 'repository',
          repositoryPath,
        }),
      ],
    });
    expect(repositories.projects.list()).toEqual([]);
  });

  it('refuses to archive a project with a running task attempt', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'w1',
        projectId: 'p1',
        type: 'shared',
        path: directory,
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 'Running attempt',
        permissionMode: 'interactive',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    repositories.tasks.create(
      taskSchema.parse({
        id: 't1',
        projectId: 'p1',
        title: 'Task',
        description: '',
        acceptanceCriteria: [],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'in_progress',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    repositories.attempts.create(
      taskAttemptSchema.parse({
        id: 'a1',
        taskId: 't1',
        sessionId: 's1',
        ordinal: 1,
        source: 'launched',
        actor: { type: 'human', id: 'operator' },
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
    );

    await expect(
      executeCommand(
        projectCommand('project-archive', {
          type: 'project.archive',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'project_has_running_attempt' });
    expect(repositories.projects.get('p1')?.archivedAt).toBeNull();
  });

  it('restores an archived project with the next revision', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
        archivedAt: now,
      }),
    );

    const restored = await executeCommand(
      projectCommand('project-restore', {
        type: 'project.restore',
        payload: {
          projectId: 'p1',
          expectedRevision: 1,
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    );

    expect(restored.result).toMatchObject({
      id: 'p1',
      archivedAt: null,
      revision: 2,
    });
  });

  it('routes task commands through the audited service and maps stale revisions', async () => {
    const { directory } = await createRepository();
    const ids = ['task-created', 'event-created'];
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => ids.shift() ?? 'unexpected-id',
    );
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const create = projectCommand('task-create-command', {
      type: 'task.create',
      payload: {
        projectId: 'p1',
        title: 'Add audited task commands',
        actor: { type: 'human', id: 'operator' },
      },
    });

    const first = await executeCommand(create, dependencies);
    const duplicate = await executeCommand(create, dependencies);

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      commandType: 'task.create',
      result: {
        task: { id: 'task-created', revision: 1 },
        event: { id: 'event-created', sequence: 1 },
        projectEventCursor: 1,
      },
    });
    expect(repositories.tasks.listByProject('p1')).toHaveLength(1);
    expect(repositories.projectEvents.after('p1', 0)).toHaveLength(1);

    const error = await executeCommand(
      projectCommand('task-edit-stale', {
        type: 'task.edit',
        payload: {
          taskId: 'task-created',
          expectedRevision: 2,
          patch: { notes: 'Must not overwrite canonical state.' },
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    ).catch((caught: unknown) => caught);
    expect(toHttpError(error)).toMatchObject({
      statusCode: 409,
      body: { error: { code: 'task_revision_conflict' } },
    });
    expect(repositories.tasks.get('task-created')?.revision).toBe(1);
  });

  it('routes attempt launch, unlink, and relink through the application saga', async () => {
    const { directory, repositoryPath } = await createRepository();
    let nextId = 0;
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => `attempt-generated-${++nextId}`,
    );
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath,
        repositoryIdentity: repositoryPath,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.tasks.create(
      taskSchema.parse({
        id: 't1',
        projectId: 'p1',
        title: 'Launch from the board',
        description: 'Start one audited attempt.',
        acceptanceCriteria: ['The task advances after startup.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const launch = projectCommand('attempt-launch-command', {
      type: 'task.attempt.launch',
      payload: {
        taskId: 't1',
        expectedRevision: 1,
        title: 'Attempt one',
        permissionMode: 'interactive',
        workspace: { type: 'shared', path: repositoryPath },
        actor: { type: 'human', id: 'operator' },
      },
    });

    const launched = await executeCommand(launch, dependencies);
    const duplicate = await executeCommand(launch, dependencies);

    expect(duplicate).toEqual(launched);
    expect(launched).toMatchObject({
      commandType: 'task.attempt.launch',
      result: {
        task: { id: 't1', lifecycleState: 'in_progress', revision: 2 },
        attempt: { ordinal: 1, source: 'launched' },
        session: { lifecycleState: 'running' },
        projectEventCursor: 2,
      },
    });
    const attemptId = (launched.result as { attempt: { id: string } }).attempt
      .id;
    const sessionId = (launched.result as { session: { id: string } }).session
      .id;

    await expect(
      executeCommand(
        projectCommand('attempt-unlink-command', {
          type: 'task.attempt.unlink',
          payload: {
            taskId: 't1',
            expectedRevision: 2,
            attemptId,
            reason: 'Correct the association',
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'invalid_command' });
    expect(sessionId).toBeTruthy();
    expect(repositories.attempts.listByTask('t1')).toHaveLength(1);
  });

  it('routes only a human Developer launch through the audited launch service', async () => {
    const { directory, repositoryPath } = await createRepository();
    let nextId = 0;
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => `developer-generated-${++nextId}`,
    );
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath,
        repositoryIdentity: repositoryPath,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.tasks.create(
      taskSchema.parse({
        id: 't1',
        projectId: 'p1',
        title: 'Launch a Developer',
        description: 'Start one policy-constrained Developer.',
        acceptanceCriteria: ['The execution cycle is durable.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const launch = projectCommand('developer-launch-command', {
      type: 'task.developer.launch',
      payload: {
        taskId: 't1',
        expectedRevision: 1,
        title: 'Developer attempt one',
        permissionMode: 'interactive',
        workspace: { type: 'shared', path: repositoryPath },
        actor: { type: 'human', id: 'operator' },
      },
    });

    await expect(
      executeCommand(
        projectCommand('developer-launch-agent', {
          type: 'task.developer.launch',
          payload: {
            ...(
              launch.command as {
                payload: Record<string, unknown>;
              }
            ).payload,
            actor: { type: 'agent', id: 'developer-agent' },
          },
        }),
        dependencies,
      ),
    ).rejects.toBeDefined();
    expect(repositories.attempts.listByTask('t1')).toEqual([]);

    const launched = await executeCommand(launch, dependencies);
    const duplicate = await executeCommand(launch, dependencies);

    expect(duplicate).toEqual(launched);
    expect(launched).toMatchObject({
      commandType: 'task.developer.launch',
      result: {
        task: { id: 't1', lifecycleState: 'in_progress', revision: 2 },
        attempt: { ordinal: 1, source: 'launched', role: 'developer' },
        cycle: { ordinal: 1, mode: 'new' },
        session: { lifecycleState: 'running' },
        projectEventCursor: 2,
      },
    });
    expect(repositories.developerExecutions.listByTask('t1')).toHaveLength(1);
  });

  it('routes human acceptance and both review and unblock recovery choices', async () => {
    const { directory, repositoryPath } = await createRepository();
    let nextId = 0;
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => `review-generated-${++nextId}`,
    );
    const human = { type: 'human' as const, id: idSchema.parse('operator') };
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath,
        repositoryIdentity: repositoryPath,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );

    const seed = (taskId: string, kind: 'rejection' | 'unblock') => {
      const task = repositories.tasks.create(
        taskSchema.parse({
          id: taskId,
          projectId: 'p1',
          title: `Recover ${taskId}`,
          description: 'Exercise the human recovery boundary.',
          acceptanceCriteria: ['Recovery remains audited.'],
          priority: 'normal',
          rank: taskId,
          lifecycleState: kind === 'rejection' ? 'review' : 'in_progress',
          labels: [],
          notes: '',
          blocked:
            kind === 'unblock'
              ? {
                  reason: 'Dependency unavailable.',
                  actor: human,
                  blockedAt: now,
                }
              : null,
          revision: 3,
          createdAt: now,
          updatedAt: now,
        }),
      );
      const workspaceId = `workspace-${taskId}`;
      const sessionId = `session-${taskId}`;
      repositories.workspaces.create(
        workspaceSchema.parse({
          id: workspaceId,
          projectId: task.projectId,
          type: 'shared',
          path: repositoryPath,
          cleanupState: 'active',
        }),
      );
      repositories.sessions.create(
        sessionSchema.parse({
          id: sessionId,
          claudeResumeId: `claude-${taskId}`,
          projectId: task.projectId,
          workspaceId,
          title: `Prior ${taskId}`,
          permissionMode: 'safe_auto',
          lifecycleState: 'completed',
          createdAt: now,
          updatedAt: now,
        }),
      );
      const attempt = repositories.attempts.createForTask(
        task.id,
        sessionId,
        'launched',
        human,
        'developer',
      );
      repositories.developerExecutions.createCycle(
        developerExecutionCycleSchema.parse({
          id: `cycle-${taskId}`,
          attemptId: attempt.id,
          ordinal: 1,
          mode: 'new',
          authorizedBy: human,
          authorizationCommandId: `launch-${taskId}`,
          policyVersion: 'developer-policy-v1',
          projectInstructions: { content: '', revision: 1 },
          taskSnapshot: {
            revision: 1,
            title: task.title,
            description: task.description,
            acceptanceCriteria: [
              { id: 'criterion-1', text: task.acceptanceCriteria[0] },
            ],
          },
          workspaceId,
          permissionMode: 'safe_auto',
          startedAt: now,
          endedAt: now,
          terminalDisposition:
            kind === 'rejection' ? 'submitted_for_review' : 'blocked',
          completionReportId: kind === 'rejection' ? `report-${taskId}` : null,
          blockerReportId: kind === 'unblock' ? `blocker-${taskId}` : null,
          terminalCommandId: `terminal-${taskId}`,
          terminalEventId: `event-${taskId}`,
        }),
      );
      return task;
    };

    const acceptedTask = seed('accept', 'rejection');
    const accepted = await executeCommand(
      projectCommand('accept-command', {
        type: 'task.developer.accept',
        payload: {
          taskId: acceptedTask.id,
          expectedRevision: acceptedTask.revision,
          actor: human,
        },
      }),
      dependencies,
    );
    expect(accepted).toMatchObject({
      commandType: 'task.developer.accept',
      result: { task: { lifecycleState: 'done' } },
    });

    for (const [type, taskId, kind] of [
      ['task.developer.reject_resume', 'reject-resume', 'rejection'],
      ['task.developer.reject_new', 'reject-new', 'rejection'],
      ['task.developer.unblock_resume', 'unblock-resume', 'unblock'],
      ['task.developer.unblock_new', 'unblock-new', 'unblock'],
    ] as const) {
      const task = seed(taskId, kind);
      const fresh = type.endsWith('_new');
      const command = projectCommand(`${taskId}-command`, {
        type,
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          feedback: `Human feedback for ${taskId}.`,
          ...(fresh
            ? {
                title: `Fresh ${taskId}`,
                permissionMode: 'interactive',
                workspace: { type: 'shared', path: repositoryPath },
              }
            : {}),
          actor: human,
        },
      });

      const result = await executeCommand(command, dependencies);
      expect(result).toMatchObject({
        commandType: type,
        result: {
          task: { lifecycleState: 'in_progress', blocked: null },
          feedback: { kind },
          cycle: { mode: fresh ? 'new' : 'resume' },
        },
      });
    }
  });

  it('does not decide an already-resolved permission request', async () => {
    const repositories = createTestRepositories();
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Mesh',
        repositoryPath: 'C:/code/mesh',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'w1',
        projectId: 'p1',
        type: 'shared',
        path: 'C:/code/mesh',
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 'Session',
        permissionMode: 'interactive',
        lifecycleState: 'idle',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    const taskService = new TaskService({ ...repositories, now: () => now });
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    await registry.create('s1');
    driver.createdSessions[0]?.enqueue({
      kind: 'permission_requested',
      permissionId: 'permission-1',
      name: 'Bash',
      input: {},
    });
    for (let attempts = 0; attempts < 20; attempts += 1) {
      if (
        repositories.events
          .after('s1', 0)
          .some((event) => event.type === 'permission.requested')
      )
        break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    repositories.events.append(
      's1',
      {
        id: 'permission-resolved',
        occurredAt: now,
        type: 'permission.resolved',
        payload: {
          permissionId: 'permission-1',
          decision: 'denied',
          resolvedAt: now,
        },
      },
      {
        id: idSchema.parse('raw-resolved'),
        sessionId: idSchema.parse('s1'),
        capturedAt: now,
        payload: {},
      },
    );

    await expect(
      executeCommand(
        {
          protocolVersion: 1,
          idempotencyKey: 'permission-key',
          command: {
            type: 'permission.decide',
            payload: { permissionId: 'permission-1', decision: 'approve' },
          },
        },
        {
          ...repositories,
          taskService,
          registry,
          driver,
          billingConflicts: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_session_state' });
    expect(driver.createdSessions[0]?.permissionDecisions).toEqual([]);
  });
});
