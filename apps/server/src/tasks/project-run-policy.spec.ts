import { describe, expect, it } from 'vitest';

import {
  projectRunSchema,
  projectRunItemSchema,
  projectSchema,
  taskSchema,
  type ProjectRun,
  type ProjectRunItem,
  type Task,
} from '@mesh-session-platform/contracts';

import {
  occupiedSlots,
  planProjectRun,
  selectEligibleRunTasks,
} from './project-run-policy.js';

const now = '2026-08-27T00:00:00.000Z';

const project = projectSchema.parse({
  id: 'project-1',
  displayName: 'Scheduling project',
  repositoryPath: 'C:/repo',
  discoveredAt: now,
  discoveryMetadata: {},
  qaConfiguration: {
    instructions: {
      content: 'Review work.',
      revision: 1,
      updatedAt: now,
      updatedBy: null,
    },
    reviewPolicy: 'manual',
    revision: 7,
    updatedAt: now,
    updatedBy: null,
  },
});

const task = (id: string, overrides: Record<string, unknown> = {}): Task =>
  taskSchema.parse({
    id,
    projectId: project.id,
    title: id,
    description: '',
    acceptanceCriteria: [],
    priority: 'normal',
    rank: 'm',
    lifecycleState: 'ready',
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    reviewAutomation: {
      status: 'enabled',
      generation: 3,
      rejectionCount: 0,
      pauseReason: null,
      updatedAt: now,
    },
    ...overrides,
  });

const run = (overrides: Partial<ProjectRun> = {}): ProjectRun =>
  projectRunSchema.parse({
    id: 'run-1',
    projectId: project.id,
    state: 'running',
    revision: 1,
    concurrency: 2,
    completionReason: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    items: [],
    ...overrides,
  });

const item = (
  id: string,
  status: 'queued' | 'launch_pending' | 'active' = 'queued',
  queuePosition = 0,
): ProjectRunItem =>
  projectRunItemSchema.parse({
    id,
    runId: 'run-1',
    projectId: project.id,
    taskId: `task-${id}`,
    taskRevision: 1,
    policyRevision: 7,
    taskAutomationGeneration: 3,
    queuePosition,
    status,
    outcomeReason: null,
    attemptId: null,
    sessionId: null,
    launchIdempotencyKey: `run-1:${id}:launch`,
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
  });

describe('project run policy', () => {
  it('selects unblocked ready tasks in rank and task ID order with snapshots', () => {
    const eligible = selectEligibleRunTasks({
      project,
      tasks: [
        task('same-rank-b'),
        task('blocked', {
          blocked: {
            reason: 'Awaiting dependency',
            actor: { type: 'human', id: 'operator-1' },
            blockedAt: now,
          },
        }),
        task('lower-rank', { rank: 'a' }),
        task('same-rank-a'),
        task('not-ready', { lifecycleState: 'backlog' }),
      ],
      currentAttemptTaskIds: new Set(['not-ready']),
    });

    expect(eligible).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: 'lower-rank' }),
        policyRevision: 7,
        taskAutomationGeneration: 3,
      }),
      expect.objectContaining({
        task: expect.objectContaining({ id: 'same-rank-a' }),
      }),
      expect.objectContaining({
        task: expect.objectContaining({ id: 'same-rank-b' }),
      }),
    ]);
  });

  it('excludes ready tasks that already have a current attempt', () => {
    expect(
      selectEligibleRunTasks({
        project,
        tasks: [task('already-running'), task('available')],
        currentAttemptTaskIds: new Set(['already-running']),
      }).map(({ task: eligibleTask }) => eligibleTask.id),
    ).toEqual(['available']);
  });

  it('counts launch-pending and active items as occupied capacity', () => {
    expect(
      occupiedSlots(
        run({
          items: [
            item('queued', 'queued'),
            item('pending', 'launch_pending'),
            item('active', 'active'),
          ],
        }),
      ),
    ).toBe(2);
  });

  it('claims the first queued item by queue position and item ID when running below capacity', () => {
    expect(
      planProjectRun({
        run: run({
          items: [
            item('same-position-b', 'queued', 1),
            item('same-position-a', 'queued', 1),
            item('first', 'queued', 0),
          ],
        }),
      }),
    ).toEqual({ type: 'claim', itemId: 'first' });
  });

  it('breaks queued item position ties by item ID', () => {
    expect(
      planProjectRun({
        run: run({
          items: [
            item('same-position-b', 'queued'),
            item('later', 'queued', 1),
            item('same-position-a', 'queued'),
          ],
        }),
      }),
    ).toEqual({ type: 'claim', itemId: 'same-position-a' });
  });

  it('waits when a running run has no available capacity', () => {
    expect(
      planProjectRun({
        run: run({
          items: [item('pending', 'launch_pending'), item('active', 'active')],
        }),
      }),
    ).toEqual({ type: 'wait', reason: 'at_capacity' });
  });

  it.each([
    [
      'paused',
      run({ state: 'paused' }),
      { type: 'wait', reason: 'run_paused' },
    ],
    [
      'draining with active work',
      run({ state: 'draining', items: [item('active', 'active')] }),
      { type: 'wait', reason: 'draining' },
    ],
    [
      'draining without active work',
      run({ state: 'draining' }),
      { type: 'complete', reason: 'stopped' },
    ],
    [
      'completed',
      projectRunSchema.parse({
        ...run(),
        state: 'completed',
        completionReason: 'queue_finished',
        completedAt: now,
      }),
      { type: 'wait', reason: 'draining' },
    ],
  ] as const)(
    'returns the explicit %s action',
    (_name, currentRun, expected) => {
      expect(planProjectRun({ run: currentRun })).toEqual(expected);
    },
  );

  it('waits for occupied work or completes an exhausted running queue', () => {
    expect(
      planProjectRun({ run: run({ items: [item('active', 'active')] }) }),
    ).toEqual({ type: 'wait', reason: 'at_capacity' });
    expect(planProjectRun({ run: run() })).toEqual({
      type: 'complete',
      reason: 'queue_finished',
    });
  });
});
