import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryInput = { options: { includePartialMessages?: boolean } };

const { query } = vi.hoisted(() => ({
  query: vi.fn((options: QueryInput) => {
    void options;
    return {
      async *[Symbol.asyncIterator]() {
        yield* [];
      },
      interrupt: async () => undefined,
      close: () => undefined,
    };
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: vi.fn(async () => []),
  query,
}));

import { createClaudeSdkFacade } from './sdk-adapter.js';

describe('createClaudeSdkFacade', () => {
  beforeEach(() => query.mockClear());

  it('requests partial SDK messages for live assistant text', () => {
    createClaudeSdkFacade().startQuery({
      title: 'Streaming',
      cwd: 'C:/code/mesh',
    });

    expect(query.mock.calls[0]?.[0].options.includePartialMessages).toBe(true);
  });
});
