import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLine, classify, agentOf } from '../src/stream.ts';
import { PM } from '../src/types.ts';
import type { MeshEvent } from '../src/types.ts';

async function loadFixture(name: string): Promise<MeshEvent[]> {
  const text = await readFile(new URL(`./fixtures/streams/${name}`, import.meta.url), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const raw = parseLine(line);
      return raw ? classify(raw) : [];
    });
}

test('agentOf maps a null parent to the project manager', () => {
  assert.equal(agentOf({ type: 'assistant', parent_tool_use_id: null }), PM);
  assert.equal(agentOf({ type: 'assistant' }), PM);
  assert.equal(agentOf({ type: 'assistant', parent_tool_use_id: 'toolu_9' }), 'toolu_9');
});

test('a simple turn yields init, assistant text, quota and turn_end', async () => {
  const events = await loadFixture('simple-turn.ndjson');
  const kinds = events.map((e) => e.kind);

  assert.ok(kinds.includes('init'));
  assert.ok(kinds.includes('quota'));
  assert.ok(kinds.includes('turn_end'));

  const text = events.find((e) => e.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.match(text.text, /PROBE_OK/);
  assert.equal(text.agent, PM);
});

test('hook and thinking_tokens noise is dropped', async () => {
  const events = await loadFixture('simple-turn.ndjson');
  // The fixture has six raw lines; two are hook noise that must not surface.
  assert.deepEqual(events.map((e) => e.kind), ['init', 'text', 'quota', 'turn_end']);
});

test('a multi-turn stream yields one turn_end per user message', async () => {
  const events = await loadFixture('multi-turn.ndjson');
  assert.equal(events.filter((e) => e.kind === 'turn_end').length, 2);
});

test('subagent events are attributed to their parent tool use, not the PM', async () => {
  const events = await loadFixture('subagent-conversation.ndjson');
  const agents = new Set(events.map((e) => e.agent));

  assert.ok(agents.has(PM));
  assert.ok(agents.size > 1, 'expected at least one subagent bucket');

  const subagentText = events.find((e) => e.kind === 'text' && e.agent !== PM);
  assert.ok(subagentText, 'subagent produced no text');
});

test('task lifecycle events carry ids, type and usage', async () => {
  const events = await loadFixture('subagent-conversation.ndjson');
  const tasks = events.filter((e) => e.kind === 'task');

  const started = tasks.find((t) => t.kind === 'task' && t.status === 'started');
  assert.ok(started && started.kind === 'task');
  assert.equal(started.subagentType, 'wordcounter');
  assert.ok(started.taskId.length > 0);

  const completed = tasks.find((t) => t.kind === 'task' && t.status === 'completed');
  assert.ok(completed && completed.kind === 'task');
  assert.ok(completed.usage);
  assert.equal(typeof completed.usage.total_tokens, 'number');
});

test('five concurrent subagents produce five distinct task ids', async () => {
  const events = await loadFixture('five-concurrent-worktrees.ndjson');
  const started = events.filter((e) => e.kind === 'task' && e.status === 'started');
  const ids = new Set(started.map((e) => (e.kind === 'task' ? e.taskId : '')));
  assert.equal(ids.size, 5);
});

test('roster events report the live background task list', async () => {
  const events = await loadFixture('five-concurrent-worktrees.ndjson');
  const rosters = events.filter((e) => e.kind === 'roster');
  const sizes = rosters.map((e) => (e.kind === 'roster' ? e.taskIds.length : -1));
  assert.ok(sizes.includes(5), `expected a roster of five, saw ${sizes.join(',')}`);
});
