import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPartials, reducePartials } from './partials.ts';
import { PM } from '../../../src/types.ts';
import type { MeshEvent } from '../../../src/types.ts';

function reduceAll(events: MeshEvent[]) {
  return events.reduce(reducePartials, emptyPartials());
}

test('successive deltas accumulate into one pending message', () => {
  const partials = reduceAll([
    { kind: 'delta', agent: PM, channel: 'text', text: 'par' },
    { kind: 'delta', agent: PM, channel: 'text', text: 'tial' },
  ]);

  assert.equal(partials[PM].text, 'partial');
});

test('the finished text clears the pending text it was streamed from', () => {
  const partials = reduceAll([
    { kind: 'delta', agent: PM, channel: 'text', text: 'partial' },
    { kind: 'text', agent: PM, role: 'assistant', text: 'partial answer' },
  ]);

  assert.equal(partials[PM].text, '');
});

test('a finished message clears only its own channel', () => {
  const partials = reduceAll([
    { kind: 'delta', agent: PM, channel: 'text', text: 'answer so far' },
    { kind: 'delta', agent: PM, channel: 'thinking', text: 'reasoning so far' },
    { kind: 'thinking', agent: PM, text: 'reasoning' },
  ]);

  assert.equal(partials[PM].thinking, '');
  assert.equal(partials[PM].text, 'answer so far');
});

test('a subagent streaming does not disturb the project manager', () => {
  const partials = reduceAll([
    { kind: 'delta', agent: PM, channel: 'text', text: 'dispatching' },
    { kind: 'delta', agent: 'toolu_1', channel: 'text', text: 'working' },
    { kind: 'text', agent: 'toolu_1', role: 'assistant', text: 'working on it' },
  ]);

  assert.equal(partials[PM].text, 'dispatching');
  assert.equal(partials['toolu_1'].text, '');
});

test('the end of a turn clears both channels', () => {
  const partials = reduceAll([
    { kind: 'delta', agent: PM, channel: 'text', text: 'half a sentence' },
    { kind: 'delta', agent: PM, channel: 'thinking', text: 'half a thought' },
    { kind: 'turn_end', agent: PM, isError: false, numTurns: 1, resultText: 'done' },
  ]);

  assert.equal(partials[PM].text, '');
  assert.equal(partials[PM].thinking, '');
});

test('an event that changes nothing returns the same state so React can skip a render', () => {
  const before = reduceAll([{ kind: 'delta', agent: PM, channel: 'text', text: 'streaming' }]);
  const after = reducePartials(before, { kind: 'tool_use', agent: PM, name: 'Bash', toolUseId: 't1', input: {} });

  assert.equal(after, before);
});
