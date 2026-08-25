import { afterEach, describe, expect, it } from 'vitest';
import {
  projectSchema,
  taskActorSchema,
  taskSchema,
  type Task,
} from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';
import { TaskService } from './task-service.js';

const now = '2026-08-25T12:00:00.000Z';
const human = taskActorSchema.parse({ type: 'human', id: 'human-1' });
const agent = taskActorSchema.parse({ type: 'agent', id: 'agent-1' });

describe('TaskService', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
  });

  const setup = (options?: Parameters<typeof createTestRepositories>[0]) => {
    const repositories = createTestRepositories(options);
    cleanups.push(repositories.dispose);
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Mesh',
        repositoryPath: 'C:/code/mesh',
        repositoryIdentity: 'repository-1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    let nextId = 0;
    const service = new TaskService({
      ...repositories,
      now: () => now,
      createId: () => `generated-${++nextId}`,
    });
    return { repositories, service };
  };

  const seedTask = (
    repositories: ReturnType<typeof createTestRepositories>,
    overrides: Partial<Omit<Task, 'id' | 'projectId'>> & {
      id?: string;
      projectId?: string;
    } = {},
  ) =>
    repositories.tasks.create(
      taskSchema.parse({
        id: 'task-1',
        projectId: 'project-1',
        title: 'Implement the task service',
        description: 'Persist task commands atomically.',
        acceptanceCriteria: ['Every mutation writes one project event.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'backlog',
        labels: ['server'],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }),
    );

  it('creates one canonical task and event and replays duplicate commands', async () => {
    const { repositories, service } = setup();
    const input = {
      commandId: 'command-create',
      projectId: 'project-1',
      title: 'Add durable task commands',
      actor: human,
    };

    const first = await service.create(input);
    const duplicate = await service.create(input);

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      task: {
        projectId: 'project-1',
        title: 'Add durable task commands',
        description: '',
        acceptanceCriteria: [],
        priority: 'normal',
        lifecycleState: 'backlog',
        revision: 1,
      },
      event: {
        projectId: 'project-1',
        sequence: 1,
        type: 'task.changed',
      },
    });
    expect(repositories.tasks.listByProject('project-1')).toEqual([first.task]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([
      first.event,
    ]);
  });

  it('edits the expected revision without adding transition history', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);

    const result = await service.edit({
      commandId: 'command-edit',
      taskId: 'task-1',
      expectedRevision: 1,
      patch: { title: 'Implement audited task commands', priority: 'high' },
      actor: human,
    });

    expect(result).toMatchObject({
      task: {
        title: 'Implement audited task commands',
        priority: 'high',
        revision: 2,
      },
      event: { sequence: 1, type: 'task.changed' },
    });
    expect(result.transition).toBeUndefined();
    expect(repositories.transitions.listByTask('task-1')).toEqual([]);
  });

  it('reorders independently of priority', async () => {
    const { repositories, service } = setup();
    seedTask(repositories, { priority: 'urgent', rank: 'm' });

    const result = await service.reorder({
      commandId: 'command-reorder',
      taskId: 'task-1',
      expectedRevision: 1,
      rank: 'a',
      actor: human,
    });

    expect(result).toMatchObject({
      task: { rank: 'a', priority: 'urgent', revision: 2 },
      event: { sequence: 1, type: 'task.rank_changed' },
    });
  });

  it('places an occupied target rank between its neighboring tasks', async () => {
    const { repositories, service } = setup();
    seedTask(repositories, {
      id: 'task-moving',
      rank: 'x',
      priority: 'urgent',
    });
    seedTask(repositories, { id: 'task-target', rank: 'm' });
    seedTask(repositories, { id: 'task-successor', rank: 't' });

    const result = await service.reorder({
      commandId: 'command-occupied-rank',
      taskId: 'task-moving',
      expectedRevision: 1,
      rank: 'm',
      actor: human,
    });

    expect(result.task).toMatchObject({ rank: 'mh', priority: 'urgent' });
    expect(
      repositories.tasks.listByProject('project-1').map((task) => task.id),
    ).toEqual(['task-target', 'task-moving', 'task-successor']);
  });

  it('keeps an available requested rank between its neighboring tasks', async () => {
    const { repositories, service } = setup();
    seedTask(repositories, { id: 'task-moving', rank: 'x' });
    seedTask(repositories, { id: 'task-predecessor', rank: 'm' });
    seedTask(repositories, { id: 'task-successor', rank: 't' });

    const result = await service.reorder({
      commandId: 'command-between-ranks',
      taskId: 'task-moving',
      expectedRevision: 1,
      rank: 'p',
      actor: human,
    });

    expect(result.task.rank).toBe('p');
    expect(
      repositories.tasks.listByProject('project-1').map((task) => task.id),
    ).toEqual(['task-predecessor', 'task-moving', 'task-successor']);
  });

  it('rebalances a dense column only when no rank exists between neighbors', async () => {
    const { repositories, service } = setup();
    seedTask(repositories, {
      id: 'task-moving',
      rank: 'x',
      priority: 'urgent',
    });
    seedTask(repositories, { id: 'task-predecessor', rank: 'a' });
    seedTask(repositories, { id: 'task-successor', rank: 'a0' });
    seedTask(repositories, { id: 'task-last', rank: 'z' });

    const result = await service.reorder({
      commandId: 'command-dense-ranks',
      taskId: 'task-moving',
      expectedRevision: 1,
      rank: 'a',
      actor: human,
    });

    const tasks = repositories.tasks.listByProject('project-1');
    expect(tasks.map((task) => [task.id, task.rank, task.revision])).toEqual([
      ['task-predecessor', '77777777', 2],
      ['task-moving', 'eeeeeeee', 2],
      ['task-successor', 'llllllll', 2],
      ['task-last', 'ssssssss', 2],
    ]);
    expect(result.task).toMatchObject({
      id: 'task-moving',
      rank: 'eeeeeeee',
      priority: 'urgent',
    });
    const events = repositories.projectEvents.after('project-1', 0);
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toEqual(result.event);
    expect(result.event).toMatchObject({
      sequence: 4,
      type: 'task.rank_changed',
      payload: { task: { id: 'task-moving' } },
    });
  });

  it('records block and unblock reasons as durable history', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);

    const blocked = await service.block({
      commandId: 'command-block',
      taskId: 'task-1',
      expectedRevision: 1,
      reason: 'Waiting for a dependency',
      actor: human,
    });
    const unblocked = await service.unblock({
      commandId: 'command-unblock',
      taskId: 'task-1',
      expectedRevision: 2,
      reason: 'Dependency delivered',
      actor: human,
    });

    expect(blocked).toMatchObject({
      task: {
        blocked: { reason: 'Waiting for a dependency', actor: human },
        revision: 2,
      },
      event: { sequence: 1, type: 'task.block_changed' },
      transition: {
        commandId: 'command-block',
        previousState: 'backlog',
        nextState: 'backlog',
        reason: 'Waiting for a dependency',
      },
    });
    expect(unblocked).toMatchObject({
      task: { blocked: null, revision: 3 },
      event: { sequence: 2, type: 'task.block_changed' },
      transition: {
        commandId: 'command-unblock',
        previousState: 'backlog',
        nextState: 'backlog',
        reason: 'Dependency delivered',
      },
    });
    expect(repositories.transitions.listByTask('task-1')).toHaveLength(2);
  });

  it('persists an authorized lifecycle transition and event together', async () => {
    const { repositories, service } = setup();
    seedTask(repositories, { lifecycleState: 'in_progress', revision: 2 });

    const result = await service.transition({
      commandId: 'command-transition',
      taskId: 'task-1',
      expectedRevision: 2,
      nextState: 'review',
      reason: 'Criteria satisfied',
      actor: human,
    });

    expect(result).toMatchObject({
      task: { lifecycleState: 'review', revision: 3 },
      event: { sequence: 1, type: 'task.transitioned' },
      transition: {
        commandId: 'command-transition',
        previousState: 'in_progress',
        nextState: 'review',
      },
    });
    expect(repositories.transitions.listByTask('task-1')).toEqual([
      result.transition,
    ]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([
      result.event,
    ]);
  });

  it('rejects stale revisions without mutating canonical state or audit rows', async () => {
    const { repositories, service } = setup();
    const task = seedTask(repositories);
    const input = {
      commandId: 'command-stale',
      taskId: task.id,
      expectedRevision: 2,
      patch: { notes: 'This must not be written.' },
      actor: human,
    };

    await expect(service.edit(input)).rejects.toMatchObject({
      code: 'task_revision_conflict',
      task,
    });
    const externallyUpdated = repositories.tasks.update(
      { ...task, notes: 'External update', updatedAt: now },
      1,
    );
    expect(externallyUpdated?.revision).toBe(2);
    await expect(service.edit(input)).rejects.toMatchObject({
      code: 'command_reconciliation_required',
      state: 'failed',
    });
    expect(repositories.tasks.get(task.id)).toEqual(externallyUpdated);
    expect(repositories.transitions.listByTask(task.id)).toEqual([]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([]);
  });

  it('rolls back task and history writes when project-event persistence fails', async () => {
    const { repositories, service } = setup({ failProjectEventInsert: true });
    const task = seedTask(repositories, { lifecycleState: 'ready' });
    const input = {
      commandId: 'command-audit-failure',
      taskId: task.id,
      expectedRevision: 1,
      nextState: 'in_progress' as const,
      actor: human,
    };

    await expect(service.transition(input)).rejects.toThrow(
      'project event insert failed',
    );
    expect(repositories.tasks.get(task.id)).toEqual(task);
    expect(repositories.transitions.listByTask(task.id)).toEqual([]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([]);
    repositories.database.exec('DROP TRIGGER fail_project_event_insert');
    await expect(service.transition(input)).rejects.toMatchObject({
      code: 'command_reconciliation_required',
      state: 'failed',
    });
    expect(repositories.tasks.get(task.id)).toEqual(task);
    expect(repositories.transitions.listByTask(task.id)).toEqual([]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([]);
  });

  it('keeps archived projects read-only and review human-only', async () => {
    const { repositories, service } = setup();
    const task = seedTask(repositories, { lifecycleState: 'in_progress' });

    await expect(
      service.transition({
        commandId: 'command-agent-review',
        taskId: task.id,
        expectedRevision: 1,
        nextState: 'review',
        actor: agent,
      }),
    ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });

    const project = repositories.projects.get('project-1');
    expect(project).toBeDefined();
    if (!project) throw new Error('Expected seeded project');
    repositories.projects.update(
      { ...project, archivedAt: now, updatedAt: now },
      project.revision,
    );
    await expect(
      service.edit({
        commandId: 'command-archived-edit',
        taskId: task.id,
        expectedRevision: 1,
        patch: { notes: 'Must remain read-only.' },
        actor: human,
      }),
    ).rejects.toMatchObject({ code: 'project_archived' });
    expect(repositories.tasks.get(task.id)).toEqual(task);
  });

  it('does not accept session completion as a task lifecycle transition', async () => {
    const { repositories, service } = setup();
    const task = seedTask(repositories, { lifecycleState: 'in_progress' });

    await expect(
      service.transition({
        commandId: 'command-session-completed',
        taskId: task.id,
        expectedRevision: 1,
        nextState: 'completed' as never,
        actor: human,
      }),
    ).rejects.toThrow();
    expect(repositories.tasks.get(task.id)).toEqual(task);
    expect(repositories.transitions.listByTask(task.id)).toEqual([]);
    expect(repositories.projectEvents.after('project-1', 0)).toEqual([]);
  });
});
