import { describe, expect, it } from 'vitest';
import { taskActorSchema } from '@mesh-session-platform/contracts';

import {
  DeveloperCapabilityInvalidError,
  DeveloperCapabilityRegistry,
  type DeveloperCapabilityBinding,
} from './developer-capability-registry.js';

const agentActor = taskActorSchema.parse({
  type: 'agent',
  id: 'developer-agent-1',
  displayName: 'Developer agent',
});

const binding: DeveloperCapabilityBinding = {
  sessionId: 'session-1',
  attemptId: 'attempt-1',
  taskId: 'task-1',
  cycleId: 'cycle-1',
  agentActor,
};

const otherBinding: DeveloperCapabilityBinding = {
  ...binding,
  sessionId: 'session-2',
  attemptId: 'attempt-2',
  taskId: 'task-2',
  cycleId: 'cycle-2',
};

describe('DeveloperCapabilityRegistry', () => {
  it('issues opaque unique tokens that resolve to their exact binding', () => {
    const registry = new DeveloperCapabilityRegistry();

    const first = registry.issue(binding);
    const second = registry.issue(binding);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(binding.sessionId);
    expect(first).not.toContain(binding.cycleId);
    expect(registry.resolve(first)).toEqual(binding);
    expect(registry.resolve(second)).toEqual(binding);
  });

  it('invalidates every capability in a terminal cycle', () => {
    const registry = new DeveloperCapabilityRegistry();
    const first = registry.issue(binding);
    const second = registry.issue({ ...binding, sessionId: 'session-2' });
    const unrelated = registry.issue(otherBinding);

    registry.invalidateCycle(binding.cycleId);

    expect(() => registry.resolve(first)).toThrow(DeveloperCapabilityInvalidError);
    expect(() => registry.resolve(second)).toThrow(DeveloperCapabilityInvalidError);
    expect(registry.resolve(unrelated)).toEqual(otherBinding);
  });

  it('invalidates every capability when its session stops', () => {
    const registry = new DeveloperCapabilityRegistry();
    const first = registry.issue(binding);
    const second = registry.issue({ ...binding, cycleId: 'cycle-3' });
    const unrelated = registry.issue(otherBinding);

    registry.invalidateSession(binding.sessionId);

    expect(() => registry.resolve(first)).toThrow(DeveloperCapabilityInvalidError);
    expect(() => registry.resolve(second)).toThrow(DeveloperCapabilityInvalidError);
    expect(registry.resolve(unrelated)).toEqual(otherBinding);
  });

  it('starts empty after a restart represented by a fresh registry', () => {
    const registry = new DeveloperCapabilityRegistry();
    const token = registry.issue(binding);
    const restarted = new DeveloperCapabilityRegistry();

    expect(() => restarted.resolve(token)).toThrow(DeveloperCapabilityInvalidError);
  });

  it('uses one indistinguishable error for invalid, expired, and mismatched tokens', () => {
    const registry = new DeveloperCapabilityRegistry();
    const expired = registry.issue(binding);
    registry.invalidateCycle(binding.cycleId);

    const errors = [
      captureError(() => registry.resolve('not-a-token')),
      captureError(() => registry.resolve(expired)),
      captureError(() => registry.resolve(expired + 'mismatch')),
    ];

    expect(errors.every((error) => error instanceof DeveloperCapabilityInvalidError)).toBe(true);
    expect(
      new Set(
        errors.map(
          (error) =>
            `${error.name}:${error.message}:${error instanceof DeveloperCapabilityInvalidError ? error.code : ''}`,
        ),
      ).size,
    ).toBe(1);
  });

  it('clears all capabilities', () => {
    const registry = new DeveloperCapabilityRegistry();
    const token = registry.issue(binding);

    registry.clear();

    expect(() => registry.resolve(token)).toThrow(DeveloperCapabilityInvalidError);
  });
});

const captureError = (operation: () => unknown): Error => {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected operation to throw');
};
