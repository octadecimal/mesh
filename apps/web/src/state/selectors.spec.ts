import type {
  ProjectRun,
  Task,
  TaskDependency,
} from '@mesh-session-platform/contracts';

import { createProjection, type MeshProjection } from './reducer';
import {
  selectActiveProjectRun,
  selectDependentTaskIds,
  selectEligibleRunPreview,
  selectProjectRuns,
  selectUnmetPrerequisiteCount,
  selectUnmetPrerequisiteIds,
} from './selectors';

const timestamp = '2026-08-27T00:00:00.000Z';
const projectId = 'project-1';

const projection = (
  overrides: Partial<MeshProjection> = {},
): MeshProjection => ({
  ...createProjection({
    protocolVersion: 1,
    projects: [],
    workspaces: [],
    sessions: [],
    events: [],
    pendingApprovals: [],
    lastSequenceBySession: {},
    layouts: [],
  }),
  ...overrides,
});

const run = (overrides: Partial<ProjectRun> = {}): ProjectRun => ({
  id: 'run-1',
  projectId,
  revision: 1,
  concurrency: 2,
  state: 'running',
  pauseReason: null,
  startedAt: timestamp,
  updatedAt: timestamp,
  completionReason: null,
  completedAt: null,
  items: [],
  ...overrides,
});

const task = (
  id: string,
  rank: string,
  overrides: Partial<Task> = {},
): Task => ({
  id,
  projectId,
  title: id,
  description: '',
  acceptanceCriteria: [],
  priority: 'normal',
  rank,
  lifecycleState: 'ready',
  labels: [],
  notes: '',
  blocked: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  reviewAutomation: {
    status: 'disabled',
    generation: 0,
    rejectionCount: 0,
    pauseReason: null,
    updatedAt: timestamp,
  },
  ...overrides,
});

const dependency = (
  taskId: string,
  prerequisiteTaskId: string,
): TaskDependency => ({
  projectId,
  taskId,
  prerequisiteTaskId,
  createdBy: { type: 'human', id: 'operator' },
  createdAt: timestamp,
});

describe('project run selectors', () => {
  it('preserves server-provided completed history order and finds the one active run', () => {
    const completed = {
      ...run({ id: 'run-completed' }),
      state: 'completed' as const,
      completionReason: 'queue_finished',
      completedAt: timestamp,
    };
    const active = run();
    const state = projection({
      projectRunsById: { [completed.id]: completed, [active.id]: active },
      projectRunIdsByProjectId: { [projectId]: [completed.id, active.id] },
    });

    expect(selectProjectRuns(state, projectId).map(({ id }) => id)).toEqual([
      completed.id,
      active.id,
    ]);
    expect(selectActiveProjectRun(state, projectId)).toEqual(active);
  });

  it('previews current eligible tasks in their frozen authorization order', () => {
    const state = projection({
      tasksById: {
        'task-b': task('task-b', 'b'),
        'task-a': task('task-a', 'a'),
        'task-a-later': task('task-a-later', 'a'),
        blocked: task('blocked', '0', { blocked: { reason: 'Waiting' } }),
        progress: task('progress', '0', { lifecycleState: 'in_progress' }),
      },
      attemptsById: {
        'attempt-task-b': {
          id: 'attempt-task-b',
          taskId: 'task-b',
          sessionId: 'session-1',
          ordinal: 1,
          source: 'launched',
          actor: { type: 'human', id: 'operator' },
          createdAt: timestamp,
          unlinkedAt: null,
          unlinkedBy: null,
          unlinkReason: null,
        },
      },
    });

    expect(
      selectEligibleRunPreview(state, projectId).map(({ id }) => id),
    ).toEqual(['task-a', 'task-a-later']);
  });

  it('excludes ready tasks whose projected prerequisites are not done', () => {
    const prerequisite = task('prerequisite', '0', {
      lifecycleState: 'in_progress',
    });
    const dependent = task('dependent', 'a');
    const state = projection({
      tasksById: {
        [prerequisite.id]: prerequisite,
        [dependent.id]: dependent,
      },
      dependenciesByTaskId: {
        [dependent.id]: [
          {
            projectId,
            taskId: dependent.id,
            prerequisiteTaskId: prerequisite.id,
            createdBy: { type: 'human', id: 'operator' },
            createdAt: timestamp,
          },
        ],
      },
    });

    expect(selectEligibleRunPreview(state, projectId)).toEqual([]);
    expect(
      selectEligibleRunPreview(
        {
          ...state,
          tasksById: {
            ...state.tasksById,
            [prerequisite.id]: {
              ...prerequisite,
              lifecycleState: 'done',
            },
          },
        },
        projectId,
      ).map(({ id }) => id),
    ).toEqual([dependent.id]);
  });

  it('matches the server code-unit ordering for case and supplementary Unicode', () => {
    const state = projection({
      tasksById: Object.fromEntries(
        [
          task('private-use', '\ue000'),
          task('emoji', '😀'),
          task('ascii', 'A'),
        ].map((candidate) => [candidate.id, candidate]),
      ),
    });

    expect(
      selectEligibleRunPreview(state, projectId).map(({ id }) => id),
    ).toEqual(['ascii', 'emoji', 'private-use']);
  });
});

describe('task dependency selectors', () => {
  it('selects unmet prerequisite IDs, counts, and dependent task IDs', () => {
    const prerequisiteA = task('task-a', 'a');
    const prerequisiteDone = task('task-done', 'b', {
      lifecycleState: 'done',
    });
    const dependent = task('task-b', 'c');
    const edgeA = dependency(dependent.id, prerequisiteA.id);
    const edgeDone = dependency(dependent.id, prerequisiteDone.id);
    const state = projection({
      tasksById: {
        [prerequisiteA.id]: prerequisiteA,
        [prerequisiteDone.id]: prerequisiteDone,
        [dependent.id]: dependent,
      },
      dependenciesByTaskId: {
        [dependent.id]: [edgeA, edgeDone],
      },
      dependentsByTaskId: {
        [prerequisiteA.id]: [edgeA],
        [prerequisiteDone.id]: [edgeDone],
      },
    });

    expect(selectUnmetPrerequisiteIds(state, dependent.id)).toEqual([
      prerequisiteA.id,
    ]);
    expect(selectUnmetPrerequisiteCount(state, dependent.id)).toBe(1);
    expect(selectDependentTaskIds(state, prerequisiteA.id)).toEqual([
      dependent.id,
    ]);
    expect(
      selectEligibleRunPreview(state, projectId).map(({ id }) => id),
    ).toEqual([prerequisiteA.id]);
  });

  it('treats a missing projected prerequisite as unmet', () => {
    const dependent = task('task-b', 'b');
    const state = projection({
      tasksById: { [dependent.id]: dependent },
      dependenciesByTaskId: {
        [dependent.id]: [dependency(dependent.id, 'missing-task')],
      },
    });

    expect(selectUnmetPrerequisiteIds(state, dependent.id)).toEqual([
      'missing-task',
    ]);
    expect(selectEligibleRunPreview(state, projectId)).toEqual([]);
  });
});
