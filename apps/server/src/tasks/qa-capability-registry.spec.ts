import { describe, expect, it } from 'vitest';

import { QaCapabilityInvalidError } from '@mesh-session-platform/contracts';

import {
  QaCapabilityRegistry,
  type QaCapabilityBinding,
} from './qa-capability-registry.js';

const binding: QaCapabilityBinding = {
  sessionId: 'qa-session-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
  cycleId: 'qa-cycle-1',
};

describe('QaCapabilityRegistry', () => {
  it('issues opaque unique tokens bound to one QA session, task, attempt, and cycle', () => {
    const registry = new QaCapabilityRegistry();
    const first = registry.issue(binding);
    const second = registry.issue(binding);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(binding.sessionId);
    expect(first).not.toContain(binding.taskId);
    expect(first).not.toContain(binding.attemptId);
    expect(first).not.toContain(binding.cycleId);
    expect(registry.resolve(first)).toEqual(binding);
    expect(registry.resolve(second)).toEqual(binding);
  });

  it('rejects an expired capability when its token is replayed', () => {
    const registry = new QaCapabilityRegistry();
    const token = registry.issue(binding);

    registry.invalidate(token);

    expect(() => registry.resolve(token)).toThrow(QaCapabilityInvalidError);
    expect(() => registry.resolve(token)).toThrow(
      'The QA capability is invalid.',
    );
  });

  it('keeps cross-session capability ownership separate', () => {
    const registry = new QaCapabilityRegistry();
    const current = registry.issue(binding);
    const other = registry.issue({ ...binding, sessionId: 'qa-session-2' });

    registry.invalidateSession(binding.sessionId);

    expect(() => registry.resolve(current)).toThrow(QaCapabilityInvalidError);
    expect(registry.resolve(other)).toEqual({
      ...binding,
      sessionId: 'qa-session-2',
    });
  });

  it.each([
    ['task', { taskId: 'task-2' }],
    ['attempt', { attemptId: 'attempt-2' }],
    ['cycle', { cycleId: 'qa-cycle-2' }],
  ] as const)(
    'keeps a token bound to its issued %s instead of a model-supplied alternative',
    (_name, override) => {
      const registry = new QaCapabilityRegistry();
      const token = registry.issue(binding);

      expect(registry.resolve(token)).toEqual(binding);
      expect(registry.resolve(token)).not.toMatchObject(override);
    },
  );

  it('rejects cross-session, wrong-task, wrong-attempt, and wrong-cycle tokens after their own invalidation', () => {
    const registry = new QaCapabilityRegistry();
    const tokens = [
      registry.issue({ ...binding, sessionId: 'qa-session-2' }),
      registry.issue({ ...binding, taskId: 'task-2' }),
      registry.issue({ ...binding, attemptId: 'attempt-2' }),
      registry.issue({ ...binding, cycleId: 'qa-cycle-2' }),
    ];

    for (const token of tokens) registry.invalidate(token);

    for (const token of tokens) {
      expect(() => registry.resolve(token)).toThrow(QaCapabilityInvalidError);
    }
  });

  it('starts empty after a restart represented by a fresh registry', () => {
    const registry = new QaCapabilityRegistry();
    const token = registry.issue(binding);
    const restarted = new QaCapabilityRegistry();

    expect(() => restarted.resolve(token)).toThrow(QaCapabilityInvalidError);
  });
});
