// tests/api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/api.ts';
import { EventBus } from '../src/bus.ts';
import { PM } from '../src/types.ts';
import type { AddressInfo } from 'node:net';

const sample = { kind: 'text', agent: PM, role: 'assistant', text: 'hi' } as const;

async function withServer(
  bus: EventBus,
  onMessage: (text: string) => void,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer({ bus, onMessage });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('health returns ok', async () => {
  await withServer(new EventBus(), () => {}, async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test('posting a message forwards the text and returns 202', async () => {
  const received: string[] = [];
  await withServer(new EventBus(), (text) => received.push(text), async (base) => {
    const response = await fetch(`${base}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'do the thing' }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(received, ['do the thing']);
  });
});

test('posting without text returns 400', async () => {
  await withServer(new EventBus(), () => {}, async (base) => {
    const response = await fetch(`${base}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  });
});

test('the event stream replays history then delivers live events', async () => {
  const bus = new EventBus();
  bus.publish(sample);

  await withServer(bus, () => {}, async (base) => {
    const response = await fetch(`${base}/api/events`);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';

    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };

    await readUntil('"seq":1');
    bus.publish({ kind: 'quota', agent: PM, status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1 });
    await readUntil('"seq":2');

    assert.match(text, /^id: 1$/m);
    assert.match(text, /"kind":"quota"/);
    await reader.cancel();
  });
});

test('Last-Event-ID skips events the client already has', async () => {
  const bus = new EventBus();
  bus.publish(sample);
  bus.publish(sample);

  await withServer(bus, () => {}, async (base) => {
    const response = await fetch(`${base}/api/events`, { headers: { 'last-event-id': '1' } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';

    // The stream contract does not guarantee "seq":2 arrives in the first
    // chunk read; accumulate until it shows up rather than assuming so.
    while (!text.includes('"seq":2')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    assert.ok(!text.includes('id: 1\n'), 'should not replay the acknowledged event');
    assert.match(text, /^id: 2$/m);
    await reader.cancel();
  });
});

test('an empty stream still flushes headers and an opening frame immediately', async () => {
  // With nothing in the replay buffer — the state right after a resume, since
  // the child stays silent until it is messaged — nothing used to be written
  // until the 15s heartbeat. Node holds headers back until the first write, so
  // the browser saw no response at all and EventSource.onopen never fired.
  await withServer(new EventBus(), () => {}, async (base) => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 3000);
    const started = Date.now();
    try {
      const response = await fetch(`${base}/api/events`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      const elapsed = Date.now() - started;

      assert.equal(response.status, 200);
      assert.ok(
        elapsed < 1000,
        `first byte took ${elapsed}ms; expected the stream to open immediately`,
      );
      assert.match(new TextDecoder().decode(value), /^:/, 'expected an opening comment frame');
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  });
});
