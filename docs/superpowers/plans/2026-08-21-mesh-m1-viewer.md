# Mesh M1 — Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web application that spawns a long-lived Claude Code process, streams its output into a browser pane, and lets the user send messages back to it.

**Architecture:** A Node server owns one `claude` child process running in bidirectional stream-json mode. Raw NDJSON from the child is parsed into typed events, stamped, buffered, and pushed to the browser over Server-Sent Events. The browser posts user messages back over REST, and the server writes them to the child's stdin.

**Tech Stack:** Node 24 (native TypeScript type stripping, no server build step), `node --test` for tests, Vite and React for the frontend, Server-Sent Events for server-to-client streaming.

**Spec:** `docs/superpowers/specs/2026-08-21-mesh-design.md`

## Global Constraints

- Node 24 or later. The server runs `.ts` files directly; there is no server-side build step.
- **Never set `ANTHROPIC_API_KEY`.** The child process must inherit the subscription OAuth credential. The spawn environment explicitly deletes `ANTHROPIC_API_KEY`.
- The spawn environment also deletes `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, and `CLAUDE_CODE_ENTRYPOINT`, so a Mesh started from inside a Claude Code session does not confuse its child.
- `--bare` must never be used. It disables OAuth (`apiKeySource: none`).
- `--permission-mode bypassPermissions` must never be used. It is blocked by the local permission classifier.
- Server-to-client transport is Server-Sent Events. Not WebSocket.
- `.mesh/` is gitignored and lives at the target repository root.
- Every commit uses Conventional Commits, per `AGENTS.md`.
- Tests must not spawn a real `claude` process. They replay the recorded fixtures in `tests/fixtures/streams/`, which cost subscription quota to regenerate.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Shared event and config types. No logic. |
| `src/config.ts` | Read and write `.mesh/config.json`. Only module that touches that file. |
| `src/stream.ts` | Pure functions: split NDJSON into lines, parse, classify raw events into Mesh events. No I/O. |
| `src/supervisor.ts` | Own the child process: spawn, stdin, stdout, resume, stop. Emits classified events. |
| `src/bus.ts` | Stamp events with sequence and time, keep a bounded replay buffer, fan out to subscribers. |
| `src/api.ts` | HTTP: SSE stream, message POST, health. |
| `src/index.ts` | Entry point. Wires config, supervisor, bus, api. |
| `web/src/lib/panes.ts` | Pure grouping of Mesh events into panes. JSX-free so `node --test` can run it. |
| `web/src/App.tsx` | React shell: pane list, transcript, composer, quota badge. |
| `tests/stubs/fake-claude.mjs` | Stub binary that replays a fixture. Lets the supervisor be tested with no quota cost. |

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MeshConfig`, `loadConfig(repoRoot: string): Promise<MeshConfig>`, `saveConfig(repoRoot: string, config: MeshConfig): Promise<void>`, `DEFAULT_CONFIG`.

- [ ] **Step 1: Verify Node runs TypeScript directly**

Run: `node --version && echo 'const x: number = 1; console.log(x)' > /tmp/t.ts && node /tmp/t.ts`
Expected: prints a version of `v24.x` or later, then `1`. If it errors, stop and report — every later step assumes type stripping works.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "mesh",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test tests/ web/src/lib/",
    "dev:server": "node src/index.ts",
    "dev:web": "vite",
    "build:web": "vite build"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "^5.7.0",
    "vite": "^7.0.0"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

This is for the editor and for Vite. The server never compiles.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true
  },
  "include": ["src", "web/src", "tests"]
}
```

`erasableSyntaxOnly` matters: it stops anyone writing enums or parameter properties, which Node's type stripping cannot erase.

- [ ] **Step 4: Create `.gitignore`**

```gitignore
node_modules/
dist/
.mesh/
*.log
```

- [ ] **Step 5: Create `src/types.ts`**

```typescript
/** An agent's identity within one Claude Code process. */
export type AgentId = string;

/** The project manager is the top-level process, with no parent tool use. */
export const PM: AgentId = 'pm';

/** A raw stream-json line, before classification. */
export interface RawEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  [key: string]: unknown;
}

export interface TaskUsage {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

export type MeshEvent =
  | { kind: 'init'; agent: AgentId; sessionId: string; model: string; tools: string[] }
  | { kind: 'text'; agent: AgentId; role: 'assistant' | 'user'; text: string }
  | { kind: 'thinking'; agent: AgentId; text: string }
  | { kind: 'tool_use'; agent: AgentId; name: string; toolUseId: string; input: unknown }
  | { kind: 'tool_result'; agent: AgentId; toolUseId: string; isError: boolean }
  | {
      kind: 'task';
      agent: AgentId;
      taskId: string;
      status: 'started' | 'updated' | 'completed' | 'failed';
      subagentType?: string;
      description?: string;
      summary?: string;
      usage?: TaskUsage;
    }
  | { kind: 'roster'; agent: AgentId; taskIds: string[] }
  | { kind: 'quota'; agent: AgentId; status: string; rateLimitType: string; resetsAt: number }
  | { kind: 'turn_end'; agent: AgentId; isError: boolean; numTurns: number; resultText: string };

/** A Mesh event once the bus has ordered and timed it. */
export type StampedEvent = MeshEvent & { seq: number; ts: number };

export interface MeshConfig {
  /** Absolute path to the repository the agents work in. */
  targetRepo: string;
  /** Port the Mesh server listens on. */
  port: number;
  pm: {
    model: string;
    /** Set after the first run so restarts can --resume. */
    sessionId: string | null;
  };
}
```

- [ ] **Step 6: Write the failing test for config**

```typescript
// tests/config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../src/config.ts';

test('loadConfig creates a default config file when none exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const config = await loadConfig(dir);

  assert.equal(config.targetRepo, dir);
  assert.equal(config.port, 4317);
  assert.equal(config.pm.sessionId, null);
  assert.equal(typeof config.pm.model, 'string');

  const onDisk = JSON.parse(await readFile(join(dir, '.mesh', 'config.json'), 'utf8'));
  assert.equal(onDisk.port, 4317);
});

test('loadConfig returns the persisted config on a second call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  const first = await loadConfig(dir);
  first.pm.sessionId = 'abc-123';
  await saveConfig(dir, first);

  const second = await loadConfig(dir);
  assert.equal(second.pm.sessionId, 'abc-123');
});

test('loadConfig fills in keys missing from an older config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-'));
  await saveConfig(dir, { targetRepo: dir, port: 9999, pm: { model: 'claude-sonnet-5' } } as never);

  const config = await loadConfig(dir);
  assert.equal(config.port, 9999);
  assert.equal(config.pm.sessionId, null);
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `node --test tests/config.test.ts`
Expected: FAIL, cannot find module `../src/config.ts`.

- [ ] **Step 8: Implement `src/config.ts`**

```typescript
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeshConfig } from './types.ts';

const MESH_DIR = '.mesh';
const CONFIG_FILE = 'config.json';

export function defaultConfig(repoRoot: string): MeshConfig {
  return {
    targetRepo: repoRoot,
    port: 4317,
    pm: { model: 'claude-opus-5', sessionId: null },
  };
}

/**
 * Write atomically: a crash mid-write must not truncate the config.
 * The same temp-then-rename discipline applies to ticket files in M2.
 */
export async function saveConfig(repoRoot: string, config: MeshConfig): Promise<void> {
  const dir = join(repoRoot, MESH_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, CONFIG_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export async function loadConfig(repoRoot: string): Promise<MeshConfig> {
  const target = join(repoRoot, MESH_DIR, CONFIG_FILE);
  const fallback = defaultConfig(repoRoot);

  let stored: Partial<MeshConfig>;
  try {
    stored = JSON.parse(await readFile(target, 'utf8')) as Partial<MeshConfig>;
  } catch {
    await saveConfig(repoRoot, fallback);
    return fallback;
  }

  return {
    targetRepo: stored.targetRepo ?? fallback.targetRepo,
    port: stored.port ?? fallback.port,
    pm: {
      model: stored.pm?.model ?? fallback.pm.model,
      sessionId: stored.pm?.sessionId ?? null,
    },
  };
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `node --test tests/config.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json .gitignore src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: add project scaffold and mesh configuration"
```

---

### Task 2: NDJSON line splitting and parsing

**Files:**
- Create: `src/stream.ts`
- Test: `tests/stream-lines.test.ts`

**Interfaces:**
- Consumes: `RawEvent` from `src/types.ts`.
- Produces: `createLineSplitter(): (chunk: string) => string[]`, `parseLine(line: string): RawEvent | null`.

A single stdout chunk can end mid-line, and one chunk can hold several lines. The splitter holds the remainder between calls.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/stream-lines.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineSplitter, parseLine } from '../src/stream.ts';

test('splitter returns whole lines and buffers the remainder', () => {
  const split = createLineSplitter();
  assert.deepEqual(split('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(split('{"c":'), []);
  assert.deepEqual(split('3}\n'), ['{"c":3}']);
});

test('splitter ignores blank lines', () => {
  const split = createLineSplitter();
  assert.deepEqual(split('{"a":1}\n\n\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test('parseLine returns a typed event', () => {
  const event = parseLine('{"type":"assistant","parent_tool_use_id":null}');
  assert.equal(event?.type, 'assistant');
  assert.equal(event?.parent_tool_use_id, null);
});

test('parseLine returns null for malformed JSON rather than throwing', () => {
  assert.equal(parseLine('{not json'), null);
});

test('parseLine returns null for JSON without a type field', () => {
  assert.equal(parseLine('{"hello":"world"}'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/stream-lines.test.ts`
Expected: FAIL, cannot find module `../src/stream.ts`.

- [ ] **Step 3: Implement the splitter and parser**

```typescript
// src/stream.ts
import type { RawEvent } from './types.ts';

/**
 * Stateful line splitter. Child stdout arrives in arbitrary chunks, so the
 * tail of an incomplete line is held until the rest arrives.
 */
export function createLineSplitter(): (chunk: string) => string[] {
  let remainder = '';
  return (chunk: string): string[] => {
    const combined = remainder + chunk;
    const parts = combined.split('\n');
    remainder = parts.pop() ?? '';
    return parts.filter((line) => line.trim().length > 0);
  };
}

/** Parse one NDJSON line. Returns null for anything unusable. */
export function parseLine(line: string): RawEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.type !== 'string') return null;
  return candidate as RawEvent;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/stream-lines.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stream.ts tests/stream-lines.test.ts
git commit -m "feat: add ndjson line splitting and parsing"
```

---

### Task 3: Event classification and agent demultiplexing

**Files:**
- Modify: `src/stream.ts`
- Test: `tests/stream-classify.test.ts`

**Interfaces:**
- Consumes: `parseLine`, `RawEvent`, `MeshEvent`, `PM`.
- Produces: `agentOf(raw: RawEvent): AgentId`, `classify(raw: RawEvent): MeshEvent[]`.

`classify` returns zero or more events, because one assistant message can carry a thinking block and a tool use. Events Mesh does not care about — `hook_started`, `hook_response`, `thinking_tokens` — classify to an empty array.

Every subagent event carries `parent_tool_use_id`; the project manager's own events carry `null`. That single field is the whole demultiplexer.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/stream-classify.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/stream-classify.test.ts`
Expected: FAIL, `classify` is not exported from `src/stream.ts`.

- [ ] **Step 3: Implement `agentOf` and `classify`**

First replace the existing import line at the top of `src/stream.ts` with:

```typescript
import { PM } from './types.ts';
import type { AgentId, MeshEvent, RawEvent, TaskUsage } from './types.ts';
```

Then append the rest to the same file:

```typescript

/** Subagent events carry parent_tool_use_id; the PM's carry null or nothing. */
export function agentOf(raw: RawEvent): AgentId {
  const parent = raw.parent_tool_use_id;
  return typeof parent === 'string' && parent.length > 0 ? parent : PM;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

function blocksOf(raw: RawEvent): ContentBlock[] {
  const message = raw.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function usageOf(value: unknown): TaskUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const u = value as Record<string, unknown>;
  return {
    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : 0,
    tool_uses: typeof u.tool_uses === 'number' ? u.tool_uses : 0,
    duration_ms: typeof u.duration_ms === 'number' ? u.duration_ms : 0,
  };
}

function classifySystem(raw: RawEvent, agent: AgentId): MeshEvent[] {
  switch (raw.subtype) {
    case 'init':
      return [
        {
          kind: 'init',
          agent,
          sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
          model: typeof raw.model === 'string' ? raw.model : '',
          tools: Array.isArray(raw.tools) ? (raw.tools as string[]) : [],
        },
      ];

    case 'task_started':
      return [
        {
          kind: 'task',
          agent,
          taskId: String(raw.task_id ?? ''),
          status: 'started',
          subagentType: typeof raw.subagent_type === 'string' ? raw.subagent_type : undefined,
          description: typeof raw.description === 'string' ? raw.description : undefined,
        },
      ];

    case 'task_updated': {
      const patch = raw.patch as { status?: string } | undefined;
      return [
        {
          kind: 'task',
          agent,
          taskId: String(raw.task_id ?? ''),
          status: patch?.status === 'failed' ? 'failed' : 'updated',
        },
      ];
    }

    case 'task_notification':
      return [
        {
          kind: 'task',
          agent,
          taskId: String(raw.task_id ?? ''),
          status: raw.status === 'completed' ? 'completed' : 'failed',
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
          usage: usageOf(raw.usage),
        },
      ];

    case 'background_tasks_changed': {
      const tasks = Array.isArray(raw.tasks) ? (raw.tasks as { task_id?: unknown }[]) : [];
      return [{ kind: 'roster', agent, taskIds: tasks.map((t) => String(t.task_id ?? '')) }];
    }

    default:
      // hook_started, hook_response, thinking_tokens, task_progress: not shown.
      return [];
  }
}

export function classify(raw: RawEvent): MeshEvent[] {
  const agent = agentOf(raw);

  if (raw.type === 'system') return classifySystem(raw, agent);

  if (raw.type === 'rate_limit_event') {
    const info = raw.rate_limit_info as Record<string, unknown> | undefined;
    return [
      {
        kind: 'quota',
        agent,
        status: String(info?.status ?? 'unknown'),
        rateLimitType: String(info?.rateLimitType ?? 'unknown'),
        resetsAt: typeof info?.resetsAt === 'number' ? info.resetsAt : 0,
      },
    ];
  }

  if (raw.type === 'result') {
    return [
      {
        kind: 'turn_end',
        agent,
        isError: raw.is_error === true,
        numTurns: typeof raw.num_turns === 'number' ? raw.num_turns : 0,
        resultText: typeof raw.result === 'string' ? raw.result : '',
      },
    ];
  }

  if (raw.type === 'assistant' || raw.type === 'user') {
    const role = raw.type === 'assistant' ? 'assistant' : 'user';
    return blocksOf(raw).flatMap((block): MeshEvent[] => {
      if (block.type === 'text' && block.text) {
        return [{ kind: 'text', agent, role, text: block.text }];
      }
      if (block.type === 'thinking' && block.thinking) {
        return [{ kind: 'thinking', agent, text: block.thinking }];
      }
      if (block.type === 'tool_use') {
        return [
          {
            kind: 'tool_use',
            agent,
            name: block.name ?? 'unknown',
            toolUseId: block.id ?? '',
            input: block.input,
          },
        ];
      }
      if (block.type === 'tool_result') {
        return [
          {
            kind: 'tool_result',
            agent,
            toolUseId: block.tool_use_id ?? '',
            isError: block.is_error === true,
          },
        ];
      }
      return [];
    });
  }

  return [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/stream-classify.test.ts`
Expected: PASS, 8 tests.

If the count assertion in the third test fails, print the actual events with `console.dir(events, { depth: null })` and correct the expected number to match the fixture — the fixture is the source of truth, not the plan.

- [ ] **Step 5: Commit**

```bash
git add src/stream.ts tests/stream-classify.test.ts
git commit -m "feat: classify stream events and demultiplex by parent tool use"
```

---

### Task 4: Supervisor and the stub binary

**Files:**
- Create: `tests/stubs/fake-claude.mjs`
- Create: `src/supervisor.ts`
- Test: `tests/supervisor.test.ts`

**Interfaces:**
- Consumes: `MeshConfig`, `createLineSplitter`, `parseLine`, `classify`, `MeshEvent`.
- Produces: `class Supervisor` with `start(): Promise<void>`, `send(text: string): void`, `stop(): Promise<void>`, `onEvent(listener: (e: MeshEvent) => void): void`, and readonly `sessionId: string | null`.

The stub replays a fixture so tests never spawn a real `claude` and never cost quota. It also records the arguments it was called with, which is how `--resume` is tested.

- [ ] **Step 1: Write the stub binary**

```javascript
// tests/stubs/fake-claude.mjs
// Replays a recorded stream so the supervisor can be tested for free.
// FAKE_CLAUDE_FIXTURE: absolute path to an .ndjson recording.
// FAKE_CLAUDE_ARGS_OUT: optional path to write the received argv as JSON.
import { readFileSync, writeFileSync } from 'node:fs';

const fixture = process.env.FAKE_CLAUDE_FIXTURE;
const argsOut = process.env.FAKE_CLAUDE_ARGS_OUT;

if (argsOut) writeFileSync(argsOut, JSON.stringify(process.argv.slice(2)), 'utf8');

for (const line of readFileSync(fixture, 'utf8').split('\n')) {
  if (line.trim().length > 0) process.stdout.write(`${line}\n`);
}

// Stay alive so the supervisor can write to stdin, and exit when it closes.
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  writeFileSync(`${argsOut}.stdin`, chunk, { flag: 'a' });
});
process.stdin.on('end', () => process.exit(0));
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/supervisor.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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

  const supervisor = makeSupervisor(dir, argsOut);
  await supervisor.start();
  const childEnv = supervisor.spawnEnvForTest();
  await supervisor.stop();

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDECODE;

  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.CLAUDECODE, undefined);
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/supervisor.test.ts`
Expected: FAIL, cannot find module `../src/supervisor.ts`.

- [ ] **Step 4: Implement `src/supervisor.ts`**

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLineSplitter, parseLine, classify } from './stream.ts';
import type { MeshConfig, MeshEvent } from './types.ts';

/** Environment variables that must never reach the child process. */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
];

export interface SupervisorOptions {
  config: MeshConfig;
  /** Overridden in tests to point at the stub. */
  command?: string;
  /** Prepended to the generated flags. Used by tests to pass the stub path. */
  baseArgs?: string[];
  /** Extra environment for the child. Used by tests to configure the stub. */
  env?: Record<string, string>;
}

export class Supervisor {
  #child: ChildProcessWithoutNullStreams | null = null;
  #listeners: ((event: MeshEvent) => void)[] = [];
  #options: SupervisorOptions;
  #env: NodeJS.ProcessEnv = {};
  sessionId: string | null;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.sessionId = options.config.pm.sessionId;
  }

  onEvent(listener: (event: MeshEvent) => void): void {
    this.#listeners.push(listener);
  }

  /** Exposed so a test can assert the environment is scrubbed. */
  spawnEnvForTest(): NodeJS.ProcessEnv {
    return this.#env;
  }

  #buildArgs(): string[] {
    const args = [
      ...(this.#options.baseArgs ?? []),
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      this.#options.config.pm.model,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);
    return args;
  }

  #buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.#options.env ?? {}) };
    for (const key of STRIPPED_ENV) delete env[key];
    return env;
  }

  #emit(event: MeshEvent): void {
    if (event.kind === 'init' && event.sessionId) this.sessionId = event.sessionId;
    for (const listener of this.#listeners) listener(event);
  }

  async start(): Promise<void> {
    this.#env = this.#buildEnv();
    const child = spawn(this.#options.command ?? 'claude', this.#buildArgs(), {
      cwd: this.#options.config.targetRepo,
      env: this.#env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;

    const split = createLineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of split(chunk)) {
        const raw = parseLine(line);
        if (!raw) continue;
        for (const event of classify(raw)) this.#emit(event);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => process.stderr.write(`[claude] ${chunk}`));

    // Resolve once the child has produced its first output or exited, so the
    // caller knows the process is genuinely running.
    await new Promise<void>((resolve, reject) => {
      const done = () => resolve();
      child.stdout.once('data', done);
      child.once('exit', done);
      child.once('error', reject);
    });
  }

  send(text: string): void {
    if (!this.#child) throw new Error('supervisor not started');
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/supervisor.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/supervisor.ts tests/supervisor.test.ts tests/stubs/fake-claude.mjs
git commit -m "feat: add process supervisor with fixture-replaying test stub"
```

---

### Task 5: Event bus with replay buffer

**Files:**
- Create: `src/bus.ts`
- Test: `tests/bus.test.ts`

**Interfaces:**
- Consumes: `MeshEvent`, `StampedEvent`.
- Produces: `class EventBus` with `publish(event: MeshEvent): StampedEvent`, `subscribe(listener: (e: StampedEvent) => void): () => void`, `history(sinceSeq?: number): StampedEvent[]`.

A browser that reconnects must not lose the transcript, so the bus keeps a bounded buffer and replays from a sequence number.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/bus.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/bus.test.ts`
Expected: FAIL, cannot find module `../src/bus.ts`.

- [ ] **Step 3: Implement `src/bus.ts`**

```typescript
import type { MeshEvent, StampedEvent } from './types.ts';

const DEFAULT_BUFFER = 2000;

export class EventBus {
  #buffer: StampedEvent[] = [];
  #listeners = new Set<(event: StampedEvent) => void>();
  #seq = 0;
  #limit: number;

  constructor(limit: number = DEFAULT_BUFFER) {
    this.#limit = limit;
  }

  publish(event: MeshEvent): StampedEvent {
    this.#seq += 1;
    const stamped = { ...event, seq: this.#seq, ts: Date.now() } as StampedEvent;

    this.#buffer.push(stamped);
    if (this.#buffer.length > this.#limit) this.#buffer.shift();

    for (const listener of this.#listeners) {
      // One bad subscriber, typically a half-closed SSE response, must not
      // take down delivery to the others.
      try {
        listener(stamped);
      } catch {
        // Ignored deliberately.
      }
    }
    return stamped;
  }

  subscribe(listener: (event: StampedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  history(sinceSeq = 0): StampedEvent[] {
    return this.#buffer.filter((event) => event.seq > sinceSeq);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/bus.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bus.ts tests/bus.test.ts
git commit -m "feat: add event bus with bounded replay buffer"
```

---

### Task 6: HTTP API

**Files:**
- Create: `src/api.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `EventBus`, `StampedEvent`.
- Produces: `createServer(options: ApiOptions): http.Server` where `ApiOptions` is `{ bus: EventBus; onMessage: (text: string) => void }`.

Routes:

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/api/health` | `{"ok":true}` |
| `GET` | `/api/events` | SSE. Replays history, then streams. Honours `Last-Event-ID`. |
| `POST` | `/api/message` | Body `{"text":"..."}`. Calls `onMessage`. Returns 202. |

- [ ] **Step 1: Write the failing test**

```typescript
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
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    assert.ok(!text.includes('id: 1\n'), 'should not replay the acknowledged event');
    assert.match(text, /^id: 2$/m);
    await reader.cancel();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/api.test.ts`
Expected: FAIL, cannot find module `../src/api.ts`.

- [ ] **Step 3: Implement `src/api.ts`**

```typescript
import http from 'node:http';
import type { EventBus } from './bus.ts';
import type { StampedEvent } from './types.ts';

export interface ApiOptions {
  bus: EventBus;
  onMessage: (text: string) => void;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function frame(event: StampedEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function handleEvents(request: http.IncomingMessage, response: http.ServerResponse, bus: EventBus): void {
  const header = request.headers['last-event-id'];
  const since = Number.parseInt(Array.isArray(header) ? header[0] : (header ?? '0'), 10);

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  for (const event of bus.history(Number.isNaN(since) ? 0 : since)) {
    response.write(frame(event));
  }

  const unsubscribe = bus.subscribe((event) => response.write(frame(event)));

  // Comment frames keep intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => response.write(': ping\n\n'), 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on('close', cleanup);
  response.on('close', cleanup);
}

export function createServer(options: ApiOptions): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      handleEvents(request, response, options.bus);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/message') {
      void readBody(request).then((body) => {
        let text: unknown;
        try {
          text = (JSON.parse(body) as { text?: unknown }).text;
        } catch {
          sendJson(response, 400, { error: 'invalid json' });
          return;
        }
        if (typeof text !== 'string' || text.trim().length === 0) {
          sendJson(response, 400, { error: 'text is required' });
          return;
        }
        options.onMessage(text);
        sendJson(response, 202, { accepted: true });
      });
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/api.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts tests/api.test.ts
git commit -m "feat: add sse event stream and message endpoint"
```

---

### Task 7: Pane grouping helper

**Files:**
- Create: `web/src/lib/panes.ts`
- Test: `web/src/lib/panes.test.ts`

**Interfaces:**
- Consumes: `StampedEvent`, `PM` from `src/types.ts`.
- Produces: `groupIntoPanes(events: StampedEvent[]): Pane[]`, `latestQuota(events: StampedEvent[]): QuotaState | null`.

This file is deliberately free of JSX so `node --test` runs it directly. The React component in Task 8 renders whatever this returns.

- [ ] **Step 1: Write the failing test**

```typescript
// web/src/lib/panes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoPanes, latestQuota } from './panes.ts';
import { PM } from '../../../src/types.ts';
import type { StampedEvent } from '../../../src/types.ts';

let seq = 0;
function stamp(event: Omit<StampedEvent, 'seq' | 'ts'>): StampedEvent {
  seq += 1;
  return { ...event, seq, ts: seq } as StampedEvent;
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test web/src/lib/panes.test.ts`
Expected: FAIL, cannot find module `./panes.ts`.

- [ ] **Step 3: Implement `web/src/lib/panes.ts`**

```typescript
import { PM } from '../../../src/types.ts';
import type { AgentId, StampedEvent } from '../../../src/types.ts';

export interface Pane {
  agent: AgentId;
  title: string;
  events: StampedEvent[];
}

export interface QuotaState {
  status: string;
  rateLimitType: string;
  resetsAt: number;
}

/**
 * Subagent panes are keyed by parent_tool_use_id, but the human-readable name
 * only arrives on the PM's task_started event, which carries a different id.
 * Titles are therefore assigned in arrival order: the nth task started names
 * the nth distinct subagent pane.
 */
export function groupIntoPanes(events: StampedEvent[]): Pane[] {
  const byAgent = new Map<AgentId, StampedEvent[]>([[PM, []]]);
  const titles: string[] = [];

  for (const event of events) {
    if (event.kind === 'task' && event.status === 'started') {
      const label = event.subagentType ?? 'agent';
      titles.push(event.description ? `${label} · ${event.description}` : label);
    }
    const bucket = byAgent.get(event.agent);
    if (bucket) bucket.push(event);
    else byAgent.set(event.agent, [event]);
  }

  let subagentIndex = 0;
  return [...byAgent.entries()].map(([agent, agentEvents]) => {
    if (agent === PM) return { agent, title: 'Project manager', events: agentEvents };
    const title = titles[subagentIndex] ?? agent;
    subagentIndex += 1;
    return { agent, title, events: agentEvents };
  });
}

export function latestQuota(events: StampedEvent[]): QuotaState | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === 'quota') {
      return { status: event.status, rateLimitType: event.rateLimitType, resetsAt: event.resetsAt };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test web/src/lib/panes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/panes.ts web/src/lib/panes.test.ts
git commit -m "feat: add pane grouping for the viewer"
```

---

### Task 8: React frontend

**Files:**
- Create: `vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/useMeshEvents.ts`
- Create: `web/src/App.tsx`
- Create: `web/src/app.css`

**Interfaces:**
- Consumes: `groupIntoPanes`, `latestQuota`, `Pane`, `QuotaState`, `StampedEvent`.
- Produces: the browser application. Nothing later depends on it.

- [ ] **Step 1: Install dependencies**

Run: `npm install`
Expected: completes without error, `node_modules/` exists.

- [ ] **Step 2: Create `vite.config.ts`**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true },
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
```

- [ ] **Step 3: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mesh</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 5: Create `web/src/useMeshEvents.ts`**

```typescript
import { useEffect, useState } from 'react';
import type { StampedEvent } from '../../src/types.ts';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * EventSource reconnects on its own and replays Last-Event-ID, so the server
 * resends only what this client missed.
 */
export function useMeshEvents(): { events: StampedEvent[]; connection: ConnectionState } {
  const [events, setEvents] = useState<StampedEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const source = new EventSource('/api/events');

    source.onopen = () => setConnection('open');
    source.onerror = () => setConnection('closed');
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as StampedEvent;
      setEvents((previous) =>
        previous.some((existing) => existing.seq === event.seq) ? previous : [...previous, event],
      );
    };

    return () => source.close();
  }, []);

  return { events, connection };
}
```

- [ ] **Step 6: Create `web/src/App.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { useMeshEvents } from './useMeshEvents.ts';
import { groupIntoPanes, latestQuota } from './lib/panes.ts';
import type { StampedEvent } from '../../src/types.ts';

function EventLine({ event }: { event: StampedEvent }) {
  switch (event.kind) {
    case 'text':
      return <p className={`line text ${event.role}`}>{event.text}</p>;
    case 'thinking':
      return <p className="line thinking">{event.text}</p>;
    case 'tool_use':
      return <p className="line tool">{event.name}</p>;
    case 'tool_result':
      return <p className="line tool">{event.isError ? 'tool failed' : 'tool ok'}</p>;
    case 'task':
      return (
        <p className="line task">
          {event.subagentType ?? 'task'} {event.status}
          {event.summary ? `: ${event.summary}` : ''}
        </p>
      );
    case 'turn_end':
      return <hr className="turn" />;
    default:
      return null;
  }
}

export function App() {
  const { events, connection } = useMeshEvents();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const panes = useMemo(() => groupIntoPanes(events), [events]);
  const quota = useMemo(() => latestQuota(events), [events]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await fetch('/api/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app">
      <header>
        <strong>Mesh</strong>
        <span className={`status ${connection}`}>{connection}</span>
        {quota ? (
          <span className={`quota ${quota.status}`}>
            {quota.rateLimitType}: {quota.status}
            {quota.resetsAt ? ` · resets ${new Date(quota.resetsAt * 1000).toLocaleTimeString()}` : ''}
          </span>
        ) : null}
      </header>

      <main>
        {panes.map((pane) => (
          <section key={pane.agent} className="pane">
            <h2>{pane.title}</h2>
            <div className="transcript">
              {pane.events.map((event) => (
                <EventLine key={event.seq} event={event} />
              ))}
            </div>
          </section>
        ))}
      </main>

      <footer>
        <textarea
          value={draft}
          placeholder="Message the project manager"
          onChange={(change) => setDraft(change.target.value)}
          onKeyDown={(key) => {
            if (key.key === 'Enter' && !key.shiftKey) {
              key.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" onClick={() => void send()} disabled={sending}>
          Send
        </button>
      </footer>
    </div>
  );
}
```

- [ ] **Step 7: Create `web/src/app.css`**

```css
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 ui-monospace, monospace; background: #14161a; color: #d6d9de; }
.app { display: flex; flex-direction: column; height: 100vh; }
header { display: flex; gap: 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid #262a31; }
.status.open { color: #6fcf72; }
.status.closed { color: #e06c6c; }
.quota.allowed { color: #6fcf72; }
.quota { margin-left: auto; }
main { flex: 1; display: flex; gap: 12px; overflow-x: auto; padding: 12px; }
.pane { flex: 1 0 380px; display: flex; flex-direction: column; border: 1px solid #262a31; border-radius: 6px; overflow: hidden; }
.pane h2 { margin: 0; padding: 8px 12px; font-size: 13px; background: #1b1e24; }
.transcript { flex: 1; overflow-y: auto; padding: 8px 12px; }
.line { margin: 0 0 8px; white-space: pre-wrap; }
.line.thinking { color: #7c828c; font-style: italic; }
.line.tool, .line.task { color: #8fa8d0; }
.line.text.user { color: #e8c07d; }
hr.turn { border: 0; border-top: 1px dashed #2f343c; margin: 12px 0; }
footer { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid #262a31; }
textarea { flex: 1; height: 56px; resize: none; background: #1b1e24; color: inherit; border: 1px solid #2f343c; border-radius: 4px; padding: 8px; font: inherit; }
button { padding: 0 18px; background: #2f5bd0; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 8: Verify the frontend builds**

Run: `npm run build:web`
Expected: succeeds, `dist/web/index.html` exists. A TypeScript or CSS error here is a real bug — fix it before committing.

- [ ] **Step 9: Commit**

```bash
git add vite.config.ts web/index.html web/src/main.tsx web/src/useMeshEvents.ts web/src/App.tsx web/src/app.css
git commit -m "feat: add react viewer frontend"
```

---

### Task 9: Entry point and verification against the real CLI

**Files:**
- Create: `src/index.ts`
- Create: `README.md`
- Modify: `package.json` (add the `dev` script)

**Interfaces:**
- Consumes: `loadConfig`, `saveConfig`, `Supervisor`, `EventBus`, `createServer`.
- Produces: the runnable application.

- [ ] **Step 1: Implement `src/index.ts`**

```typescript
import { resolve } from 'node:path';
import { loadConfig, saveConfig } from './config.ts';
import { Supervisor } from './supervisor.ts';
import { EventBus } from './bus.ts';
import { createServer } from './api.ts';

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const config = await loadConfig(repoRoot);

const bus = new EventBus();
const supervisor = new Supervisor({ config });

supervisor.onEvent((event) => {
  bus.publish(event);
  // Persist the session id the first time we learn it, so a restart resumes.
  if (event.kind === 'init' && config.pm.sessionId !== event.sessionId) {
    config.pm.sessionId = event.sessionId;
    void saveConfig(repoRoot, config);
  }
});

await supervisor.start();

const server = createServer({ bus, onMessage: (text) => supervisor.send(text) });
server.listen(config.port, '127.0.0.1', () => {
  console.log(`mesh: watching ${repoRoot}`);
  console.log(`mesh: api on http://127.0.0.1:${config.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await supervisor.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
```

- [ ] **Step 2: Add the `dev` script to `package.json`**

Add to `scripts`:

```json
"dev": "node src/index.ts"
```

- [ ] **Step 3: Run the whole test suite**

Run: `npm test`
Expected: PASS. 37 tests across seven files, no real `claude` process spawned.

- [ ] **Step 4: Verify against the real CLI**

This step costs subscription quota. It is the only step in the plan that does.

Terminal one: `npm run dev`
Terminal two: `npm run dev:web`

Open `http://127.0.0.1:5173`. Confirm each of the following, and stop and report if any fails:

1. Header shows `open`.
2. A `Project manager` pane appears.
3. The quota badge shows `five_hour: allowed`.
4. Typing `Reply with exactly: MESH_OK` and pressing Enter produces `MESH_OK` in the pane.
5. A second message gets a reply in the same pane, proving the process is long-lived and context is retained.
6. `.mesh/config.json` now contains a non-null `pm.sessionId`.
7. Stopping the server with Ctrl+C and running `npm run dev` again resumes: the pane still answers questions about the earlier messages.

- [ ] **Step 5: Write `README.md`**

````markdown
# Mesh

A local viewer for a long-lived Claude Code process. The server owns one
`claude` child in bidirectional stream-json mode, classifies its output, and
streams it to a browser over Server-Sent Events.

This is milestone one of the design in
`docs/superpowers/specs/2026-08-21-mesh-design.md`. There is no board yet.

## Requirements

- Node 24 or later
- Claude Code logged in with a subscription (`claude` on `PATH`)

Mesh never sets `ANTHROPIC_API_KEY` and never uses pay-per-token API billing.

## Running

```bash
npm install
npm run dev        # server on 127.0.0.1:4317
npm run dev:web    # browser on 127.0.0.1:5173
```

Pass a path to watch a different repository: `npm run dev -- /path/to/repo`.

## Testing

```bash
npm test
```

Tests replay recorded streams from `tests/fixtures/streams/` and never spawn a
real `claude` process, so the suite costs no quota.

## Configuration

`.mesh/config.json` in the target repository. Created on first run and
gitignored. The project manager's session id is written there so restarts
resume the same conversation.
````

- [ ] **Step 6: Commit**

```bash
git add src/index.ts README.md package.json
git commit -m "feat: wire mesh entry point and document the viewer"
```

---

## What M1 deliberately excludes

Named so a reviewer does not treat them as omissions: the kanban board, ticket
storage, the state machine, the MCP tool surface, subagent dispatch, worktrees,
QA, orphan reconciliation, and the quota governor. All belong to M2 and later.

The viewer will display subagent panes correctly if the project manager happens
to spawn one, because classification and grouping already handle
`parent_tool_use_id`. Nothing in M1 causes that to happen.

## Prerequisites for the M2 plan

Answer these before M2 is planned. Both change its tasks.

1. **Does the CLI accept an HTTP MCP transport via `--mcp-config`?** Test:
   serve a trivial MCP endpoint, pass
   `--mcp-config '{"mcpServers":{"mesh":{"type":"http","url":"http://127.0.0.1:PORT/mcp"}}}'`,
   and check whether the tool appears in `system/init`'s `tools` array. If it
   does not, M2 needs a stdio bridge process and gains a task.
2. **Does `PostCompact` fire in headless mode?** If it does, re-priming the
   project manager after compaction is a hook. If not, Mesh must detect
   compaction from the stream itself, which is a separate task.
