import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../src/supervisor.ts';
import type { MeshEvent } from '../src/types.ts';

const stub = fileURLToPath(new URL('./stubs/fake-claude.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/streams/simple-turn.ndjson', import.meta.url));

function makeSupervisor(dir: string, argsOut: string) {
  return new Supervisor({
    config: { targetRepo: dir, port: 0, pm: { model: 'claude-sonnet-5', sessionId: null } },
    command: process.execPath,
    baseArgs: [stub],
    env: { FAKE_CLAUDE_FIXTURE: fixture, FAKE_CLAUDE_ARGS_OUT: argsOut },
  });
}

test('supervisor emits classified events from the child stream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const supervisor = makeSupervisor(dir, join(dir, 'args.json'));
  const seen: MeshEvent[] = [];
  supervisor.onEvent((event) => seen.push(event));

  await supervisor.start();
  await supervisor.stop();

  assert.ok(seen.some((e) => e.kind === 'init'));
  assert.ok(seen.some((e) => e.kind === 'text'));
  assert.ok(seen.some((e) => e.kind === 'turn_end'));
});

test('supervisor captures the session id from the init event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const supervisor = makeSupervisor(dir, join(dir, 'args.json'));

  await supervisor.start();
  await supervisor.stop();

  assert.equal(supervisor.sessionId, '11111111-2222-3333-4444-555555555555');
});

test('supervisor never passes an API key and strips inherited session vars', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const argsOut = join(dir, 'args.json');
  process.env.ANTHROPIC_API_KEY = 'must-not-be-forwarded';
  process.env.CLAUDECODE = '1';

  try {
    const supervisor = makeSupervisor(dir, argsOut);
    await supervisor.start();
    const childEnv = supervisor.spawnEnvForTest();
    await supervisor.stop();

    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.CLAUDECODE, undefined);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDECODE;
  }
});

test('supervisor passes --resume when a session id is known', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const argsOut = join(dir, 'args.json');
  const supervisor = new Supervisor({
    config: { targetRepo: dir, port: 0, pm: { model: 'claude-sonnet-5', sessionId: 'prior-session' } },
    command: process.execPath,
    baseArgs: [stub],
    env: { FAKE_CLAUDE_FIXTURE: fixture, FAKE_CLAUDE_ARGS_OUT: argsOut },
  });

  await supervisor.start();
  await supervisor.stop();

  const argv: string[] = JSON.parse(await readFile(argsOut, 'utf8'));
  assert.ok(argv.includes('--resume'));
  assert.ok(argv.includes('prior-session'));
});

test('send writes a stream-json user message to child stdin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const argsOut = join(dir, 'args.json');
  const supervisor = makeSupervisor(dir, argsOut);

  await supervisor.start();
  supervisor.send('hello there');
  await supervisor.stop();

  const written = await readFile(`${argsOut}.stdin`, 'utf8');
  const message = JSON.parse(written.trim().split('\n')[0]);
  assert.equal(message.type, 'user');
  assert.equal(message.message.role, 'user');
  assert.equal(message.message.content[0].text, 'hello there');
});

test('a subagent init event does not clobber the PM session id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const argsOut = join(dir, 'args.json');
  // Hand-built, not one of the tracked fixtures: the recorded fixtures
  // happen not to contain a subagent init event, which is exactly the case
  // this guards against. Subagent init events stream through the same
  // stdout pipe tagged with their own parent_tool_use_id.
  const customFixture = join(dir, 'subagent-init.ndjson');
  const lines = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'pm-session-id',
      model: 'claude-sonnet-5',
      tools: [],
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'subagent-session-id',
      model: 'claude-sonnet-5',
      tools: [],
      parent_tool_use_id: 'toolu_01ABCDEF',
    }),
  ];
  await writeFile(customFixture, `${lines.join('\n')}\n`, 'utf8');

  const supervisor = new Supervisor({
    config: { targetRepo: dir, port: 0, pm: { model: 'claude-sonnet-5', sessionId: null } },
    command: process.execPath,
    baseArgs: [stub],
    env: { FAKE_CLAUDE_FIXTURE: customFixture, FAKE_CLAUDE_ARGS_OUT: argsOut },
  });

  await supervisor.start();
  await supervisor.stop();

  assert.equal(supervisor.sessionId, 'pm-session-id');
});

test('start rejects when the child exits before producing any stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const argsOut = join(dir, 'args.json');
  const supervisor = new Supervisor({
    config: { targetRepo: dir, port: 0, pm: { model: 'claude-sonnet-5', sessionId: null } },
    command: process.execPath,
    baseArgs: [stub],
    env: { FAKE_CLAUDE_FIXTURE: fixture, FAKE_CLAUDE_ARGS_OUT: argsOut, FAKE_CLAUDE_EXIT_CODE: '17' },
  });

  await assert.rejects(supervisor.start(), /exited with code 17/);
});
