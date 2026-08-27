import type { ProjectRun, Task } from '@mesh-session-platform/contracts';

import { createProjection, type MeshProjection } from './reducer';
import {
  selectActiveProjectRun,
  selectEligibleRunPreview,
  selectProjectRuns,
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
});
