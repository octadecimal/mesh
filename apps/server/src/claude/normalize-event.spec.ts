import { describe, expect, it } from 'vitest';

import { normalizeDriverEvent } from './normalize-event.js';

describe('normalizeDriverEvent', () => {
  it('turns a text delta into an assistant message event draft', () => {
    expect(normalizeDriverEvent({ kind: 'text_delta', text: 'hello' })).toEqual(
      {
        kind: 'event',
        event: { type: 'message.assistant', payload: { text: 'hello' } },
      },
    );
  });

  it('quarantines an unsupported driver event without inventing a client event', () => {
    expect(
      normalizeDriverEvent({
        kind: 'future-sdk-kind',
        payload: { secret: false },
      }),
    ).toEqual({
      kind: 'unsupported',
      error: {
        code: 'unsupported_claude_capability',
        capability: 'future-sdk-kind',
      },
      raw: { kind: 'future-sdk-kind', payload: { secret: false } },
    });
  });

  it('quarantines malformed known events with their raw payload', () => {
    expect(normalizeDriverEvent({ kind: 'text_delta', text: 7 })).toEqual({
      kind: 'unsupported',
      error: {
        code: 'unsupported_claude_capability',
        capability: 'text_delta',
      },
      raw: { kind: 'text_delta', text: 7 },
    });
  });

  it('normalizes a subscription limit with reset metadata', () => {
    expect(
      normalizeDriverEvent({
        kind: 'limit',
        capability: 'five_hour',
        message: 'Claude subscription limit reached',
        resetAt: '2026-08-25T08:00:00.000Z',
      }),
    ).toEqual({
      kind: 'event',
      event: {
        type: 'session.error',
        payload: {
          code: 'subscription_limit',
          message: 'Claude subscription limit reached',
          details: {
            capability: 'five_hour',
            resetAt: '2026-08-25T08:00:00.000Z',
          },
        },
      },
    });
  });

  it('normalizes validated activity and usage while quarantining invalid metrics', () => {
    expect(
      normalizeDriverEvent({
        kind: 'activity',
        sourceEventId: 'sdk-progress',
        activity: {
          kind: 'tool_progress',
          summary: 'Read is running',
          elapsedSeconds: 1,
        },
      }),
    ).toMatchObject({ kind: 'event', event: { type: 'session.activity' } });
    expect(
      normalizeDriverEvent({
        kind: 'usage',
        sourceEventId: 'sdk-result',
        usage: { inputTokens: -1 },
      }),
    ).toMatchObject({ kind: 'unsupported', error: { capability: 'usage' } });
  });

  it('quarantines status events outside the lifecycle contract', () => {
    expect(
      normalizeDriverEvent({
        kind: 'status',
        from: 'running',
        to: 'future-state',
      }),
    ).toEqual({
      kind: 'unsupported',
      error: {
        code: 'unsupported_claude_capability',
        capability: 'status',
      },
      raw: { kind: 'status', from: 'running', to: 'future-state' },
    });
  });
});
