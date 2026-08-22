import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/bus.ts';
import { PM } from '../src/types.ts';

const sample = { kind: 'text', agent: PM, role: 'assistant', text: 'hi' } as const;

test('publish stamps events with an increasing sequence', () => {
  const bus = new EventBus();
  assert.equal(bus.publish(sample).seq, 1);
  assert.equal(bus.publish(sample).seq, 2);
});

test('subscribers receive stamped events and can unsubscribe', () => {
  const bus = new EventBus();
  const seen: number[] = [];
  const unsubscribe = bus.subscribe((e) => seen.push(e.seq));

  bus.publish(sample);
  unsubscribe();
  bus.publish(sample);

  assert.deepEqual(seen, [1]);
});

test('history replays everything after a sequence number', () => {
  const bus = new EventBus();
  bus.publish(sample);
  bus.publish(sample);
  bus.publish(sample);

  assert.equal(bus.history().length, 3);
  assert.deepEqual(bus.history(2).map((e) => e.seq), [3]);
});

test('the buffer is bounded but the sequence keeps climbing', () => {
  const bus = new EventBus(3);
  for (let i = 0; i < 10; i += 1) bus.publish(sample);

  const history = bus.history();
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((e) => e.seq), [8, 9, 10]);
});

test('a throwing subscriber does not stop the others', () => {
  const bus = new EventBus();
  const seen: number[] = [];
  bus.subscribe(() => {
    throw new Error('boom');
  });
  bus.subscribe((e) => seen.push(e.seq));

  bus.publish(sample);
  assert.deepEqual(seen, [1]);
});
