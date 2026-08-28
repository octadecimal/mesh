import { afterEach, describe, expect, it } from 'vitest';

import {
  projectSchema,
  idSchema,
  taskActorSchema,
  taskDependencySchema,
  taskSchema,
  type TaskDependency,
} from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';
import { TaskDependencyRepository } from './task-dependency-repository.js';

const actor = () => taskActorSchema.parse({ type: 'human', id: 'operator-1' });

const seedProjectAndTasks = (
  repos: ReturnType<typeof createTestRepositories>,
  projectId: string,
  taskIds: readonly string[],
) => {
  repos.projects.create(
    projectSchema.parse({
      id: projectId,
      displayName: projectId,
      repositoryPath: `C:/code/${projectId}`,
      discoveredAt: '2026-08-27T00:00:00.000Z',
      discoveryMetadata: {},
    }),
  );
  for (const [index, id] of taskIds.entries()) {
    repos.tasks.create(
      taskSchema.parse({
        id,
        projectId,
        title: id,
        description: `${id} description`,
        acceptanceCriteria: ['It persists.'],
        priority: 'normal',
        rank: String(index),
        lifecycleState: 'backlog',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      }),
    );
  }
};

const edge = (overrides: Record<string, unknown> = {}): TaskDependency =>
  taskDependencySchema.parse({
    projectId: 'project-1',
    taskId: 'task-b',
    prerequisiteTaskId: 'task-a',
    createdBy: actor(),
    createdAt: '2026-08-27T00:01:00.000Z',
    ...overrides,
  });

describe('TaskDependencyRepository', () => {
  const repositories: Array<ReturnType<typeof createTestRepositories>> = [];

  afterEach(() => repositories.splice(0).forEach((repo) => repo.dispose()));

  it('creates and round-trips a dependency through both task directions', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedProjectAndTasks(repos, 'project-1', ['task-a', 'task-b']);
    const dependencies = new TaskDependencyRepository(repos.database);

    expect(dependencies.create(edge())).toEqual(edge());
    expect(dependencies.listPrerequisites('task-b')).toEqual([edge()]);
    expect(dependencies.listDependents('task-a')).toEqual([edge()]);
  });

  it('lets SQLite reject duplicate edges and returns ordered project and task views', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedProjectAndTasks(repos, 'project-1', [
      'task-a',
      'task-b',
      'task-c',
      'task-d',
    ]);
    const dependencies = new TaskDependencyRepository(repos.database);
    dependencies.create(edge({ createdAt: '2026-08-27T00:02:00.000Z' }));
    dependencies.create(
      edge({
        taskId: 'task-c',
        prerequisiteTaskId: 'task-a',
        createdAt: '2026-08-27T00:01:00.000Z',
      }),
    );
    dependencies.create(
      edge({ taskId: 'task-d', prerequisiteTaskId: 'task-c' }),
    );
    dependencies.create(
      edge({ taskId: 'task-d', prerequisiteTaskId: 'task-b' }),
    );

    expect(() => dependencies.create(edge())).toThrow();
    expect(
      dependencies.listByProject('project-1').map(({ taskId }) => taskId),
    ).toEqual(['task-b', 'task-c', 'task-d', 'task-d']);
    expect(
      dependencies.listDependents('task-a').map(({ taskId }) => taskId),
    ).toEqual(['task-b', 'task-c']);
    expect(
      dependencies
        .listPrerequisites('task-d')
        .map(({ prerequisiteTaskId }) => prerequisiteTaskId),
    ).toEqual(['task-b', 'task-c']);
  });

  it('isolates project queries and removes only the requested edge', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedProjectAndTasks(repos, 'project-1', ['task-a', 'task-b']);
    seedProjectAndTasks(repos, 'project-2', ['other-a', 'other-b']);
    const dependencies = new TaskDependencyRepository(repos.database);
    expect(() =>
      dependencies.create(edge({ prerequisiteTaskId: 'other-a' })),
    ).toThrow();
    dependencies.create(edge());
    dependencies.create(
      edge({
        projectId: 'project-2',
        taskId: 'other-b',
        prerequisiteTaskId: 'other-a',
      }),
    );

    expect(dependencies.listByProject('project-1')).toEqual([edge()]);
    expect(dependencies.remove('task-b', 'task-a')).toBe(true);
    expect(dependencies.remove('task-b', 'task-a')).toBe(false);
    expect(dependencies.listByProject('project-2')).toEqual([
      edge({
        projectId: 'project-2',
        taskId: 'other-b',
        prerequisiteTaskId: 'other-a',
      }),
    ]);
  });

  it('keeps previously appended project events when a dependency is removed', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedProjectAndTasks(repos, 'project-1', ['task-a', 'task-b']);
    const dependencies = new TaskDependencyRepository(repos.database);
    repos.projectEvents.append('project-1', {
      protocolVersion: 1,
      id: 'project-event-1',
      projectId: idSchema.parse('project-1'),
      occurredAt: '2026-08-27T00:00:00.000Z',
      type: 'project.changed',
      payload: { project: repos.projects.get('project-1')! },
    });
    dependencies.create(edge());

    dependencies.remove('task-b', 'task-a');

    expect(
      repos.projectEvents.after('project-1', 0).map(({ id }) => id),
    ).toEqual(['project-event-1']);
  });
});
