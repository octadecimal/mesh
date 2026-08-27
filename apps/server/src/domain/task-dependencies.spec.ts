import {
  taskActorSchema,
  taskDependencySchema,
  taskSchema,
  type Task,
  type TaskDependency,
  type TaskLifecycleState,
} from '@mesh-session-platform/contracts';
import { describe, expect, it } from 'vitest';

import {
  incompletePrerequisiteIds,
  validateDependencyGraph,
} from './task-dependencies.js';

const timestamp = '2026-08-27T00:00:00.000Z';
const human = taskActorSchema.parse({ type: 'human', id: 'human-1' });

const task = (
  id: string,
  lifecycleState: TaskLifecycleState = 'backlog',
  projectId = 'project-1',
): Task =>
  taskSchema.parse({
    id,
    projectId,
    title: `Task ${id}`,
    description: 'A task description.',
    acceptanceCriteria: ['A criterion.'],
    priority: 'normal',
    rank: 'm',
    lifecycleState,
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }) as Task;

const edge = (
  taskId: string,
  prerequisiteTaskId: string,
  projectId = 'project-1',
): TaskDependency =>
  taskDependencySchema.parse({
    projectId,
    taskId,
    prerequisiteTaskId,
    createdBy: human,
    createdAt: timestamp,
  });

const capturedError = (operation: () => void): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
};

describe('task dependency policy', () => {
  it('rejects duplicate dependency edges', () => {
    expect(
      capturedError(() =>
        validateDependencyGraph({
          tasks: [task('a'), task('b')],
          dependencies: [edge('b', 'a'), edge('b', 'a')],
        }),
      ),
    ).toMatchObject({ code: 'task_dependency_conflict' });
  });

  it('rejects a task depending on itself', () => {
    expect(
      capturedError(() =>
        validateDependencyGraph({
          tasks: [task('a')],
          dependencies: [edge('a', 'a')],
        }),
      ),
    ).toMatchObject({ code: 'task_dependency_invalid' });
  });

  it('rejects dependency nodes that are not present in the graph', () => {
    expect(
      capturedError(() =>
        validateDependencyGraph({
          tasks: [task('a')],
          dependencies: [edge('a', 'missing')],
        }),
      ),
    ).toMatchObject({ code: 'task_dependency_invalid' });
  });

  it('rejects dependency nodes from another project', () => {
    expect(
      capturedError(() =>
        validateDependencyGraph({
          tasks: [task('a'), task('b', 'backlog', 'project-2')],
          dependencies: [edge('a', 'b')],
        }),
      ),
    ).toMatchObject({ code: 'task_dependency_invalid' });
  });

  it('rejects direct cycles', () => {
    expect(
      capturedError(() =>
        validateDependencyGraph({
          tasks: [task('a'), task('b')],
          dependencies: [edge('a', 'b'), edge('b', 'a')],
        }),
      ),
    ).toMatchObject({ code: 'task_dependency_cycle' });
  });

  it('rejects transitive cycles', () => {
    expect(
      capturedError(() =>
        validateDependencyGraph({
          tasks: [task('a'), task('b'), task('c')],
          dependencies: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
        }),
      ),
    ).toMatchObject({ code: 'task_dependency_cycle' });
  });

  it('rejects a currently cancelled prerequisite at proposal time', () => {
    expect(
      capturedError(() =>
        validateDependencyGraph({
          tasks: [task('a', 'cancelled'), task('b')],
          dependencies: [edge('b', 'a')],
        }),
      ),
    ).toMatchObject({ code: 'task_dependency_invalid' });
  });

  it('returns every incomplete direct prerequisite in code-unit ID order', () => {
    expect(
      incompletePrerequisiteIds(
        'dependent',
        [
          task('task-2', 'review'),
          task('done', 'done'),
          task('task-10', 'cancelled'),
          task('dependent'),
        ],
        [
          edge('dependent', 'task-2'),
          edge('dependent', 'done'),
          edge('dependent', 'task-10'),
        ],
      ),
    ).toEqual(['task-10', 'task-2']);
  });

  it('reports no incomplete prerequisites for a task without dependencies', () => {
    expect(incompletePrerequisiteIds('a', [task('a')], [])).toEqual([]);
  });
});
