import { describe, expect, it } from 'vitest';

import { normalizeDriverEvent } from './normalize-event.js';

describe('normalizeDriverEvent', () => {
  it('turns a text delta into an assistant message event draft', () => {
    expect(normalizeDriverEvent({ kind: 'text_delta', text: 'hello' })).toEqual({
      kind: 'event',
      event: { type: 'message.assistant', payload: { text: 'hello' } },
    });
  });

  it('quarantines an unsupported driver event without inventing a client event', () => {
    expect(
      normalizeDriverEvent({ kind: 'future-sdk-kind', payload: { secret: false } }),
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

  it('quarantines status events outside the lifecycle contract', () => {
    expect(normalizeDriverEvent({ kind: 'status', from: 'running', to: 'future-state' })).toEqual({
      kind: 'unsupported',
      error: {
        code: 'unsupported_claude_capability',
        capability: 'status',
      },
      raw: { kind: 'status', from: 'running', to: 'future-state' },
    });
  });
});
