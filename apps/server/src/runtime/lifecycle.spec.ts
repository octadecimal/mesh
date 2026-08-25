import { describe, expect, it } from 'vitest';

import { InvalidSessionStateError, transition } from './lifecycle.js';

describe('session lifecycle', () => {
  it.each([
    ['idle', 'start', 'starting'],
    ['starting', 'driver_started', 'running'],
    ['running', 'permission_requested', 'waiting_for_approval'],
    ['waiting_for_approval', 'permission_resolved', 'running'],
    ['running', 'interrupt', 'interrupting'],
    ['interrupting', 'driver_stopped', 'interrupted'],
  ] as const)('%s + %s -> %s', (from, trigger, to) => {
    expect(transition(from, trigger)).toBe(to);
  });

  it('rejects an invalid transition without coercing the state', () => {
    expect(() => transition('completed', { type: 'start' })).toThrow(
      expect.objectContaining<Partial<InvalidSessionStateError>>({
        code: 'invalid_session_state',
        from: 'completed',
        trigger: 'start',
      }),
    );
  });
});
