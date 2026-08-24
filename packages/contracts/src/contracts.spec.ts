import { describe, expect, it } from 'vitest';

import {
  commandEnvelopeSchema,
  sessionEventSchema,
  sessionSchema,
} from './index.js';

describe('session platform contracts', () => {
  it('rejects a mutating command without an idempotency key', () => {
    expect(() =>
      commandEnvelopeSchema.parse({
        type: 'session.prompt',
        payload: { sessionId: 's1', prompt: 'hi' },
      }),
    ).toThrow();
  });

  it('requires a positive per-session event sequence', () => {
    expect(() =>
      sessionEventSchema.parse({
        id: 'e1',
        sessionId: 's1',
        sequence: 0,
        occurredAt: '2026-08-23T00:00:00.000Z',
        type: 'session.status',
        payload: { from: 'idle', to: 'running' },
      }),
    ).toThrow();
  });

  it('accepts the complete lifecycle vocabulary', () => {
    for (const lifecycleState of [
      'idle',
      'starting',
      'running',
      'waiting_for_approval',
      'interrupting',
      'completed',
      'failed',
      'interrupted',
      'archived',
    ]) {
      expect(
        sessionSchema.parse({
          id: 's1',
          projectId: 'p1',
          workspaceId: 'w1',
          title: 'Session',
          permissionMode: 'interactive',
          lifecycleState,
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:00:00.000Z',
        }).lifecycleState,
      ).toBe(lifecycleState);
    }
  });
});
