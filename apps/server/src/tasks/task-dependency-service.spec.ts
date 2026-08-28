import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  workspaceSchema,
  type Task,
} from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';
import { TaskDependencyService } from './task-dependency-service.js';

const now = '2026-08-27T12:00:00.000Z';
const human = taskActorSchema.parse({ type: 'human', id: 'operator-1' });
const agent = taskActorSchema.parse({ type: 'agent', id: 'agent-1' });

describe('TaskDependencyService', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  const setup = (options?: {
    failProjectEventInsert?: boolean;
    failCommandCompleteFor?: string;
  }) => {
    const repositories = createTestRepositories(options);
    cleanups.push(repositories.dispose);
    const publisher = { publishProject: vi.fn() };
    const onAuditFailure = vi.fn();
    let nextId = 0;
    const service = new TaskDependencyService({
      ...repositories,
      publisher,
      onAuditFailure,
      now: () => now,
      createId: () => `dependency-event-${++nextId}`,
    });
    return { onAuditFailure, publisher, repositories, service };
  };

  const seedProject = (
    repositories: ReturnType<typeof createTestRepositories>,
    overrides: Record<string, unknown> = {},
  ) =>
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project one',
        repositoryPath: 'C:/repo/project-one',
        repositoryIdentity: 'repository-1',
        discoveredAt: now,
        discoveryMetadata: {},
        ...overrides,
      }),
    );

  const seedTask = (
    repositories: ReturnType<typeof createTestRepositories>,
    id: string,
    overrides: Record<string, unknown> = {},
  ) =>
    repositories.tasks.create(
      taskSchema.parse({
        id,
        projectId: 'project-1',
        title: id,
        description: `${id} description`,
        acceptanceCriteria: ['The task is complete.'],
        priority: 'normal',
        rank: id,
        lifecycleState: 'backlog',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }),
    );

  const seedActiveAttempt = (
    repositories: ReturnType<typeof createTestRepositories>,
    task: Task,
  ) => {
    const workspace = repositories.workspaces.create(
      workspaceSchema.parse({
        id: `workspace-${task.id}`,
        projectId: task.projectId,
        type: 'shared',
        path: `C:/repo/${task.id}`,
      }),
    );
    const session = repositories.sessions.create(
      sessionSchema.parse({
        id: `session-${task.id}`,
        projectId: task.projectId,
        workspaceId: workspace.id,
        title: task.title,
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    return repositories.attempts.createForTask(
      task.id,
      session.id,
      'launched',
      human,
      'developer',
    );
  };

  const addInput = (overrides: Record<string, unknown> = {}) => ({
    projectId: 'project-1',
    taskId: 'dependent',
    prerequisiteTaskId: 'prerequisite',
    expectedTaskRevision: 1,
    actor: human,
    commandId: 'dependency-add-1',
    ...overrides,
  });

  it('commits the edge, revision, command result, and complete event before publishing once', async () => {
    const { publisher, repositories, service } = setup();
    seedProject(repositories);
    seedTask(repositories, 'prerequisite');
    const dependent = seedTask(repositories, 'dependent');
    const publicationSnapshots: Array<Record<string, unknown>> = [];
    publisher.publishProject.mockImplementation((event) => {
      publicationSnapshots.push({
        transactionOpen: repositories.database.inTransaction,
        taskRevision: repositories.tasks.get(dependent.id)?.revision,
        dependencies: repositories.dependencies.listPrerequisites(dependent.id),
        events: repositories.projectEvents.after('project-1', 0),
        command: repositories.commands.getExisting('dependency-add-1'),
        event,
      });
    });

    const first = await service.add(addInput());
    const duplicate = await service.add(addInput());

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      task: { id: dependent.id, revision: 2 },
      dependencies: [
        {
          projectId: 'project-1',
          taskId: dependent.id,
          prerequisiteTaskId: 'prerequisite',
          createdBy: human,
          createdAt: now,
        },
      ],
      event: {
        projectId: 'project-1',
        sequence: 1,
        type: 'task.dependencies_changed',
        payload: {
          taskId: dependent.id,
          taskRevision: 2,
          taskUpdatedAt: now,
        },
      },
    });
    expect(publicationSnapshots).toEqual([
      {
        transactionOpen: false,
        taskRevision: 2,
        dependencies: first.dependencies,
        events: [first.event],
        command: { found: true, response: first },
        event: first.event,
      },
    ]);
  });

  it.each([
    ['agent actor', { actor: agent }, 'task_dependency_invalid'],
    [
      'stale dependent revision',
      { expectedTaskRevision: 2 },
      'task_revision_conflict',
    ],
  ] as const)(
    'rejects %s without changing dependency truth',
    async (_name, override, code) => {
      const { onAuditFailure, repositories, service } = setup();
      seedProject(repositories);
      seedTask(repositories, 'prerequisite');
      const dependent = seedTask(repositories, 'dependent');

      await expect(service.add(addInput(override))).rejects.toMatchObject({
        code,
      });
      expect(repositories.tasks.get(dependent.id)).toEqual(dependent);
      expect(repositories.dependencies.listByProject('project-1')).toEqual([]);
      expect(repositories.projectEvents.after('project-1', 0)).toEqual([]);
      expect(onAuditFailure).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['in-progress dependent', { lifecycleState: 'in_progress' }],
    ['review dependent', { lifecycleState: 'review' }],
    ['done dependent', { lifecycleState: 'done' }],
    ['cancelled dependent', { lifecycleState: 'cancelled' }],
  ] as const)('rejects an %s', async (_name, dependentOverride) => {
    const { repositories, service } = setup();
    seedProject(repositories);
    seedTask(repositories, 'prerequisite');
    const dependent = seedTask(repositories, 'dependent', dependentOverride);

    await expect(service.add(addInput())).rejects.toMatchObject({
      code: 'task_dependency_invalid',
    });
    expect(repositories.tasks.get(dependent.id)).toEqual(dependent);
  });

  it('rejects a dependent with an active attempt', async () => {
    const { repositories, service } = setup();
    seedProject(repositories);
    seedTask(repositories, 'prerequisite');
    const dependent = seedTask(repositories, 'dependent', {
      lifecycleState: 'ready',
    });
    seedActiveAttempt(repositories, dependent);

    await expect(service.add(addInput())).rejects.toMatchObject({
      code: 'task_dependency_invalid',
    });
    expect(repositories.dependencies.listByProject('project-1')).toEqual([]);
  });

  it('rejects foreign, cancelled, self, duplicate, and cyclic edges through graph validation', async () => {
    const { repositories, service } = setup();
    seedProject(repositories);
    seedProject(repositories, {
      id: 'project-2',
      displayName: 'Project two',
      repositoryPath: 'C:/repo/project-two',
      repositoryIdentity: 'repository-2',
    });
    seedTask(repositories, 'prerequisite');
    seedTask(repositories, 'dependent');
    seedTask(repositories, 'cancelled', { lifecycleState: 'cancelled' });
    seedTask(repositories, 'foreign', { projectId: 'project-2' });

    await expect(
      service.add(
        addInput({ commandId: 'foreign', prerequisiteTaskId: 'foreign' }),
      ),
    ).rejects.toMatchObject({ code: 'task_dependency_invalid' });
    await expect(
      service.add(
        addInput({ commandId: 'cancelled', prerequisiteTaskId: 'cancelled' }),
      ),
    ).rejects.toMatchObject({ code: 'task_dependency_invalid' });
    await expect(
      service.add(
        addInput({
          commandId: 'self',
          prerequisiteTaskId: 'dependent',
        }),
      ),
    ).rejects.toMatchObject({ code: 'task_dependency_invalid' });

    await service.add(addInput());
    await expect(
      service.add(
        addInput({
          commandId: 'duplicate-edge',
          expectedTaskRevision: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: 'task_dependency_conflict' });
    await expect(
      service.add(
        addInput({
          commandId: 'cycle',
          taskId: 'prerequisite',
          prerequisiteTaskId: 'dependent',
        }),
      ),
    ).rejects.toMatchObject({ code: 'task_dependency_cycle' });
  });

  it('removes an edge with a revision bump and replays without another event or publication', async () => {
    const { publisher, repositories, service } = setup();
    seedProject(repositories);
    seedTask(repositories, 'prerequisite');
    seedTask(repositories, 'dependent');
    await service.add(addInput());
    const removeInput = {
      ...addInput(),
      expectedTaskRevision: 2,
      commandId: 'dependency-remove-1',
    };

    const first = await service.remove(removeInput);
    const duplicate = await service.remove(removeInput);

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      task: { id: 'dependent', revision: 3 },
      dependencies: [],
      event: {
        sequence: 2,
        type: 'task.dependencies_changed',
        payload: {
          taskId: 'dependent',
          taskRevision: 3,
          taskUpdatedAt: now,
          dependencies: [],
        },
      },
    });
    expect(repositories.dependencies.listByProject('project-1')).toEqual([]);
    expect(repositories.projectEvents.after('project-1', 0)).toHaveLength(2);
    expect(publisher.publishProject).toHaveBeenCalledTimes(2);
  });

  it('emits each authoritative revision when sequential mutations share a millisecond', async () => {
    const { repositories, service } = setup();
    seedProject(repositories);
    seedTask(repositories, 'prerequisite');
    seedTask(repositories, 'dependent');

    const added = await service.add(addInput());
    const removed = await service.remove({
      ...addInput(),
      expectedTaskRevision: added.task.revision,
      commandId: 'dependency-remove-same-millisecond',
    });

    expect([added.event.payload, removed.event.payload]).toEqual([
      expect.objectContaining({ taskRevision: 2, taskUpdatedAt: now }),
      expect.objectContaining({ taskRevision: 3, taskUpdatedAt: now }),
    ]);
  });

  it('applies human authority and active-attempt safety to removals', async () => {
    const { repositories, service } = setup();
    seedProject(repositories);
    seedTask(repositories, 'prerequisite');
    seedTask(repositories, 'dependent', { lifecycleState: 'ready' });
    const added = await service.add(addInput());

    await expect(
      service.remove({
        ...addInput(),
        expectedTaskRevision: added.task.revision,
        actor: agent,
        commandId: 'dependency-remove-agent',
      }),
    ).rejects.toMatchObject({ code: 'task_dependency_invalid' });
    seedActiveAttempt(repositories, added.task);
    await expect(
      service.remove({
        ...addInput(),
        expectedTaskRevision: added.task.revision,
        commandId: 'dependency-remove-active-attempt',
      }),
    ).rejects.toMatchObject({ code: 'task_dependency_invalid' });

    expect(repositories.tasks.get(added.task.id)).toEqual(added.task);
    expect(repositories.dependencies.listPrerequisites(added.task.id)).toEqual(
      added.dependencies,
    );
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([
      added.event,
    ]);
  });

  it('rolls back the edge and revision, trips audit handling, and never publishes when event persistence fails', async () => {
    const { onAuditFailure, publisher, repositories, service } = setup({
      failProjectEventInsert: true,
    });
    seedProject(repositories);
    seedTask(repositories, 'prerequisite');
    const dependent = seedTask(repositories, 'dependent');

    await expect(service.add(addInput())).rejects.toThrow(
      'project event insert failed',
    );
    expect(repositories.tasks.get(dependent.id)).toEqual(dependent);
    expect(repositories.dependencies.listByProject('project-1')).toEqual([]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([]);
    expect(publisher.publishProject).not.toHaveBeenCalled();
    expect(onAuditFailure).toHaveBeenCalledOnce();
    repositories.database.exec('DROP TRIGGER fail_project_event_insert');
    await expect(service.add(addInput())).rejects.toMatchObject({
      code: 'command_reconciliation_required',
      state: 'failed',
    });
  });

  it('rolls back every mutation and publication when command-result persistence fails', async () => {
    const { onAuditFailure, publisher, repositories, service } = setup({
      failCommandCompleteFor: 'dependency-add-1',
    });
    seedProject(repositories);
    seedTask(repositories, 'prerequisite');
    const dependent = seedTask(repositories, 'dependent');

    await expect(service.add(addInput())).rejects.toThrow(
      'command complete failed',
    );
    expect(repositories.tasks.get(dependent.id)).toEqual(dependent);
    expect(repositories.dependencies.listByProject('project-1')).toEqual([]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([]);
    expect(repositories.commands.getExisting('dependency-add-1')).toEqual({
      found: false,
    });
    expect(publisher.publishProject).not.toHaveBeenCalled();
    expect(onAuditFailure).toHaveBeenCalledOnce();
    expect(onAuditFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'command complete failed' }),
    );
  });

  it('reports incomplete prerequisites and all dependency-blocked tasks from current truth', async () => {
    const { repositories, service } = setup();
    seedProject(repositories);
    seedTask(repositories, 'done', { lifecycleState: 'done' });
    seedTask(repositories, 'incomplete');
    seedTask(repositories, 'dependent-a');
    seedTask(repositories, 'dependent-b');
    await service.add(
      addInput({
        taskId: 'dependent-a',
        prerequisiteTaskId: 'done',
        commandId: 'add-done',
      }),
    );
    await service.add(
      addInput({
        taskId: 'dependent-a',
        prerequisiteTaskId: 'incomplete',
        expectedTaskRevision: 2,
        commandId: 'add-incomplete-a',
      }),
    );
    await service.add(
      addInput({
        taskId: 'dependent-b',
        prerequisiteTaskId: 'incomplete',
        commandId: 'add-incomplete-b',
      }),
    );

    expect(service.incompletePrerequisiteIds('dependent-a')).toEqual([
      'incomplete',
    ]);
    expect(service.dependencyBlockedTaskIds('project-1')).toEqual(
      new Set(['dependent-a', 'dependent-b']),
    );
  });
});
