import {
  idSchema,
  taskActorSchema,
  taskSchema,
  type Task,
  type TaskLifecycleState,
} from '@mesh-session-platform/contracts';
import { describe, expect, it } from 'vitest';

import {
  TaskBlockedError,
  TaskReadinessError,
  TaskTransitionInvalidError,
  TaskTransitionReasonRequiredError,
  TaskTransitionUnauthorizedError,
  allowedTaskTransitions,
  authorizeQaVerdict,
  authorizeTaskTransition,
  readinessProblems,
} from './task-lifecycle.js';

const timestamp = '2026-08-25T00:00:00.000Z';

const taskIn = (
  lifecycleState: TaskLifecycleState,
  overrides: Partial<Task> = {},
): Task =>
  taskSchema.parse({
    id: 'task-1',
    projectId: 'project-1',
    title: 'Implement task board',
    description: 'Build the task board lifecycle.',
    acceptanceCriteria: ['Transitions are authorized.'],
    priority: 'normal',
    rank: 'm',
    lifecycleState,
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }) as Task;

const human = taskActorSchema.parse({ type: 'human', id: 'human-1' });
const agent = taskActorSchema.parse({ type: 'agent', id: 'agent-1' });

const capturedError = (operation: () => void): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
};

describe('task lifecycle policy', () => {
  it.each([
    ['backlog', ['ready', 'cancelled']],
    ['ready', ['backlog', 'in_progress', 'cancelled']],
    ['in_progress', ['ready', 'review', 'cancelled']],
    ['review', ['in_progress', 'done', 'cancelled']],
    ['done', ['review']],
    ['cancelled', ['backlog']],
  ] as const)('lists explicit transitions from %s', (state, expected) => {
    expect(allowedTaskTransitions(taskIn(state))).toEqual(expected);
  });

  it('reports all fields required before a task is ready', () => {
    expect(
      readinessProblems({
        ...taskIn('backlog'),
        title: ' ',
        description: '',
        acceptanceCriteria: [],
        priority: undefined as never,
      } as Task),
    ).toEqual(['title', 'description', 'acceptanceCriteria', 'priority']);
  });

  it('rejects a transition to ready until required fields are complete', () => {
    expect(() =>
      authorizeTaskTransition({
        task: taskIn('backlog', { description: '', acceptanceCriteria: [] }),
        nextState: 'ready',
        actor: human,
      }),
    ).toThrow(TaskReadinessError);
  });

  it('reports incomplete prerequisites when moving from backlog to ready', () => {
    expect(
      capturedError(() =>
        authorizeTaskTransition({
          task: taskIn('backlog'),
          nextState: 'ready',
          actor: human,
          incompletePrerequisiteIds: ['task-10', 'task-2'],
        }),
      ),
    ).toMatchObject({
      problems: [
        { type: 'dependency_incomplete', taskId: 'task-10' },
        { type: 'dependency_incomplete', taskId: 'task-2' },
      ],
    });
  });

  it('rejects launching an incomplete or blocked task', () => {
    expect(() =>
      authorizeTaskTransition({
        task: taskIn('ready', { description: '' }),
        nextState: 'in_progress',
        actor: human,
      }),
    ).toThrow(TaskReadinessError);

    expect(() =>
      authorizeTaskTransition({
        task: taskIn('ready', {
          blocked: {
            reason: 'Waiting on API',
            actor: human,
            blockedAt: timestamp,
          },
        }),
        nextState: 'in_progress',
        actor: human,
      }),
    ).toThrow(TaskBlockedError);
  });

  it.each([
    ['ready', undefined],
    ['review', 'Acceptance criterion needs rework'],
  ] as const)(
    'rejects incomplete prerequisites for every legal transition from %s to in_progress',
    (lifecycleState, reason) => {
      expect(
        capturedError(() =>
          authorizeTaskTransition({
            task: taskIn(lifecycleState),
            nextState: 'in_progress',
            actor: human,
            reason,
            incompletePrerequisiteIds: ['prerequisite'],
          }),
        ),
      ).toMatchObject({
        problems: [{ type: 'dependency_incomplete', taskId: 'prerequisite' }],
      });
    },
  );

  it('rejects launching done and cancelled tasks', () => {
    for (const lifecycleState of ['done', 'cancelled'] as const) {
      expect(() =>
        authorizeTaskTransition({
          task: taskIn(lifecycleState),
          nextState: 'in_progress',
          actor: human,
        }),
      ).toThrow(TaskTransitionInvalidError);
    }
  });

  it('requires reasons for backward, cancellation, restoration, block, and unblock actions', () => {
    const requests = [
      { task: taskIn('ready'), nextState: 'backlog' as const },
      { task: taskIn('in_progress'), nextState: 'cancelled' as const },
      { task: taskIn('cancelled'), nextState: 'backlog' as const },
      { task: taskIn('backlog'), nextState: 'backlog' as const, blocked: true },
      {
        task: taskIn('backlog', {
          blocked: {
            reason: 'Waiting on API',
            actor: human,
            blockedAt: timestamp,
          },
        }),
        nextState: 'backlog' as const,
        blocked: false,
      },
    ];

    for (const request of requests) {
      expect(() =>
        authorizeTaskTransition({ ...request, actor: human }),
      ).toThrow(TaskTransitionReasonRequiredError);
    }
  });

  it('allows documented rework and restored work with human reasons', () => {
    expect(
      authorizeTaskTransition({
        task: taskIn('review'),
        nextState: 'in_progress',
        actor: human,
        reason: 'Acceptance criterion needs rework',
      }),
    ).toBeUndefined();
    expect(
      authorizeTaskTransition({
        task: taskIn('cancelled'),
        nextState: 'backlog',
        actor: human,
        reason: 'Work is relevant again',
      }),
    ).toBeUndefined();
  });

  it('does not mutate an already-active dependent when reopening its prerequisite', () => {
    const activeDependent = taskIn('in_progress', {
      id: idSchema.parse('dependent'),
    });
    const before = structuredClone(activeDependent);

    expect(
      authorizeTaskTransition({
        task: taskIn('done', { id: idSchema.parse('prerequisite') }),
        nextState: 'review',
        actor: human,
        reason: 'Reopen prerequisite for a correction',
      }),
    ).toBeUndefined();

    expect(activeDependent).toEqual(before);
  });

  it('permits only humans to move work into review or done', () => {
    expect(() =>
      authorizeTaskTransition({
        task: taskIn('in_progress'),
        nextState: 'review',
        actor: agent,
        reason: 'finished',
      }),
    ).toThrow(TaskTransitionUnauthorizedError);

    expect(() =>
      authorizeTaskTransition({
        task: taskIn('review'),
        nextState: 'done',
        actor: agent,
        reason: 'approved',
      }),
    ).toThrow(TaskTransitionUnauthorizedError);
  });

  it('permits a bound Developer policy only to submit its current work for review or block it', () => {
    expect(
      authorizeTaskTransition({
        task: taskIn('in_progress'),
        nextState: 'review',
        actor: agent,
        operation: 'developer_submit_review',
      }),
    ).toBeUndefined();
    expect(
      authorizeTaskTransition({
        task: taskIn('in_progress'),
        nextState: 'in_progress',
        actor: agent,
        blocked: true,
        reason: 'Blocked on an external dependency',
        operation: 'developer_mark_blocked',
      }),
    ).toBeUndefined();
  });

  it('rejects a Developer review submission while its task is blocked', () => {
    expect(() =>
      authorizeTaskTransition({
        task: taskIn('in_progress', {
          blocked: {
            reason: 'Waiting on a dependency',
            actor: human,
            blockedAt: timestamp,
          },
        }),
        nextState: 'review',
        actor: agent,
        operation: 'developer_submit_review',
      }),
    ).toThrow(TaskTransitionUnauthorizedError);
  });

  it('does not grant Developer policy authority to complete, unblock, or make unrelated transitions', () => {
    for (const request of [
      {
        task: taskIn('review'),
        nextState: 'done' as const,
        operation: 'developer_submit_review' as const,
      },
      {
        task: taskIn('in_progress'),
        nextState: 'ready' as const,
        operation: 'developer_submit_review' as const,
      },
      {
        task: taskIn('in_progress'),
        nextState: 'ready' as const,
        reason: 'Only a human may return work to ready',
      },
      {
        task: taskIn('in_progress', {
          blocked: { reason: 'Blocked', actor: human, blockedAt: timestamp },
        }),
        nextState: 'in_progress' as const,
        blocked: false,
        reason: 'Unblock',
        operation: 'developer_mark_blocked' as const,
      },
    ]) {
      expect(() =>
        authorizeTaskTransition({ ...request, actor: agent }),
      ).toThrow(TaskTransitionUnauthorizedError);
    }
  });

  it('authorizes only a QA agent to submit a verdict for an unblocked review task', () => {
    expect(
      authorizeQaVerdict({ task: taskIn('review'), actor: agent }),
    ).toBeUndefined();

    expect(() =>
      authorizeQaVerdict({ task: taskIn('review'), actor: human }),
    ).toThrow(TaskTransitionUnauthorizedError);
    expect(() =>
      authorizeQaVerdict({ task: taskIn('in_progress'), actor: agent }),
    ).toThrow(TaskTransitionInvalidError);
    expect(() =>
      authorizeQaVerdict({
        task: taskIn('review', {
          blocked: { reason: 'Blocked', actor: human, blockedAt: timestamp },
        }),
        actor: agent,
      }),
    ).toThrow(TaskBlockedError);
  });
});
