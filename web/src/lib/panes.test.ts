import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoPanes, latestQuota } from './panes.ts';
import { PM } from '../../../src/types.ts';
import type { MeshEvent, StampedEvent } from '../../../src/types.ts';

let seq = 0;
function stamp(event: MeshEvent): StampedEvent {
  seq += 1;
  return { ...event, seq, ts: seq };
}

test('the project manager always has a pane, even with no events', () => {
  const panes = groupIntoPanes([]);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].agent, PM);
  assert.equal(panes[0].title, 'Project manager');
});

test('events are grouped into a pane per agent', () => {
  const panes = groupIntoPanes([
    stamp({ kind: 'text', agent: PM, role: 'assistant', text: 'dispatching' }),
    stamp({ kind: 'text', agent: 'toolu_1', role: 'assistant', text: 'working' }),
    stamp({ kind: 'text', agent: 'toolu_1', role: 'assistant', text: 'done' }),
  ]);

  assert.equal(panes.length, 2);
  assert.equal(panes[0].agent, PM);
  assert.equal(panes[1].events.length, 2);
});

test('a subagent pane is titled from its task type once known', () => {
  const panes = groupIntoPanes([
    stamp({ kind: 'task', agent: PM, taskId: 't1', status: 'started', subagentType: 'dev', description: 'Add gauge' }),
    stamp({ kind: 'text', agent: 'toolu_1', role: 'assistant', text: 'working' }),
  ]);

  const subagent = panes.find((pane) => pane.agent === 'toolu_1');
  assert.ok(subagent);
  assert.equal(subagent.title, 'dev · Add gauge');
});

test('task events stay on the project manager pane', () => {
  const panes = groupIntoPanes([
    stamp({ kind: 'task', agent: PM, taskId: 't1', status: 'started', subagentType: 'dev' }),
  ]);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].events.length, 1);
});

test('latestQuota returns the most recent quota event', () => {
  const quota = latestQuota([
    stamp({ kind: 'quota', agent: PM, status: 'allowed', rateLimitType: 'five_hour', resetsAt: 100 }),
    stamp({ kind: 'quota', agent: PM, status: 'rejected', rateLimitType: 'five_hour', resetsAt: 200 }),
  ]);

  assert.equal(quota?.status, 'rejected');
  assert.equal(quota?.resetsAt, 200);
});

test('latestQuota returns null when nothing has arrived', () => {
  assert.equal(latestQuota([]), null);
});
