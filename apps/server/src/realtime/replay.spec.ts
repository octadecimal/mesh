import { describe, expect, it } from 'vitest';
import { idSchema, type SessionEvent } from '@mesh-session-platform/contracts';

import { ReplayService } from './replay.js';

const event = (sessionId: string, sequence: number): SessionEvent => ({
  protocolVersion: 1,
  id: idSchema.parse(`event-${sessionId}-${sequence}`),
  sessionId: idSchema.parse(sessionId),
  sequence,
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'message.user',
  payload: { text: String(sequence) },
});

describe('ReplayService', () => {
  it('replays only retained events after each supplied cursor', () => {
    const retained = {
      s1: [event('s1', 1), event('s1', 2), event('s1', 3)],
      s2: [event('s2', 1), event('s2', 2)],
    };
    const replay = new ReplayService({
      after: (sessionId) => retained[sessionId as keyof typeof retained] ?? [],
    });

    expect(replay.after({ s1: 1, s2: 2 })).toEqual({
      batches: [{ sessionId: 's1', events: [event('s1', 2), event('s1', 3)] }],
      highWaterBySession: { s1: 3, s2: 2 },
      resyncSessionIds: [],
    });
  });

  it('requires a snapshot when requested history is unavailable', () => {
    const replay = new ReplayService({
      after: () => [event('s1', 4), event('s1', 5)],
    });

    expect(replay.after({ s1: 1 })).toEqual({
      batches: [],
      highWaterBySession: { s1: 5 },
      resyncSessionIds: ['s1'],
    });
  });
});
