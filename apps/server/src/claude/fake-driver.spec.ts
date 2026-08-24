import { describe, expect, it } from 'vitest';

import { FakeClaudeSessionDriver } from './fake-driver.js';

describe('FakeClaudeSessionDriver', () => {
  it('emits queued events after being resumed and records session commands', async () => {
    const driver = new FakeClaudeSessionDriver();
    const session = await driver.create({ title: 'test' });
    const iterator = session.events()[Symbol.asyncIterator]();

    session.pause();
    session.enqueue({ kind: 'text_delta', text: 'queued' });
    const waiting = iterator.next();
    session.resumeEmission();

    await expect(waiting).resolves.toEqual({
      done: false,
      value: { kind: 'text_delta', text: 'queued' },
    });
    await session.sendPrompt('continue');
    await session.resolvePermission('permission-1', 'approve');

    expect(session.prompts).toEqual(['continue']);
    expect(session.permissionDecisions).toEqual([
      { requestId: 'permission-1', decision: 'approve' },
    ]);
  });

  it('simulates a subscription limit, streaming crash, and interruption acknowledgement', async () => {
    const driver = new FakeClaudeSessionDriver({ subscriptionLimit: 1 });
    await driver.create({ title: 'first' });
    await expect(driver.create({ title: 'second' })).rejects.toMatchObject({
      code: 'subscription_limit_reached',
    });

    const session = await new FakeClaudeSessionDriver().create({ title: 'crash' });
    const iterator = session.events()[Symbol.asyncIterator]();
    session.crash(new Error('stream failed'));
    await expect(iterator.next()).rejects.toThrow('stream failed');

    await session.interrupt();
    expect(session.interrupted).toBe(true);
  });
});
