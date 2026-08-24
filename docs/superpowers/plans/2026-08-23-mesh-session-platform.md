# Mesh Session Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local, durable Mesh session runtime and browser workspace for discovering, creating, resuming, controlling, and inspecting Claude Code sessions.

**Architecture:** An Nx TypeScript workspace separates versioned Zod contracts, a loopback-only Node/Fastify backend, and a React/Vite client. The backend owns SQLite persistence, Claude processes, Git worktrees, lifecycle transitions, permissions, and ordered event delivery; the browser rebuilds Hookstate projections from snapshots and WebSocket events while Dockview alone owns panel geometry.

**Tech Stack:** Nx, pnpm, TypeScript, React, Vite, dockview-react, Radix UI, Tailwind CSS, Hookstate, Fastify, WebSocket, SQLite (`better-sqlite3`), Zod, Vitest, Testing Library, Playwright, Claude Agent SDK.

**Spec:** `docs/superpowers/specs/2026-08-23-mesh-session-platform-design.md`

## Global Constraints

- This plan implements only sub-project 1, “Session runtime and workspace”; do not create task, board, PM, Developer, QA, delegation, rework, completion-orchestration, or automation-policy code.
- The initial projects are exactly `apps/web`, `apps/server`, and `packages/contracts`; extract additional libraries only after real reuse or ownership boundaries appear.
- The backend is the sole authority for Claude processes, session lifecycle, persistence, permissions, repository paths, and Git worktrees.
- The browser communicates only through versioned contracts over loopback HTTP and WebSocket and must be reconstructible from a snapshot plus ordered events.
- SQLite owns canonical application metadata, normalized events, diagnostics, approvals, and saved layouts; Claude Code owns native transcripts and Claude resume IDs.
- Every mutating command carries an idempotency key; every session event carries a stable session ID and monotonically increasing per-session sequence number.
- Persist normalized events before updating runtime projections or broadcasting them.
- Closing a browser panel hides it; only an explicit interrupt/stop command affects a running backend session.
- Support exactly `interactive`, `safe_auto`, and `inherit` permission modes, failing closed for unknown tools, unsupported SDK events, and ambiguous requests.
- Use the locally authenticated Claude Max subscription only. Mesh must not accept or configure an Anthropic API key and must refuse to launch sessions while known API-billing environment overrides are present.
- Target Windows first; keep filesystem, process, path, and Git behavior behind portable adapters and test Windows path semantics explicitly.
- Bind only to loopback, serve the browser from the backend, and accept HTTP origins and WebSocket upgrades only from the backend’s own local origin.
- Shared repositories are never automatically deleted or moved. Mesh-owned worktrees may be removed only when the session is stopped, the worktree is clean, and the user explicitly confirms.
- Preserve history and raw diagnostics until explicit deletion; archive only hides a session from normal views.
- Never replay a prompt automatically after restart or transport failure.
- Normal verification must not consume Claude subscription capacity; real SDK/authentication smoke tests are opt-in.

---

## Planned File Structure

The repository currently has no application workspace, so all product files below are new unless marked otherwise.

```text
.
├── package.json                         # pnpm scripts and pinned toolchain
├── pnpm-workspace.yaml                  # workspace package discovery
├── nx.json                              # Nx defaults, inputs, and aggregate targets
├── tsconfig.base.json                   # shared strict TypeScript settings and aliases
├── eslint.config.mjs                    # shared lint rules and boundary enforcement
├── .prettierignore / .prettierrc.json   # formatting policy
├── apps/
│   ├── server/
│   │   ├── project.json                 # serve/build/test/typecheck targets
│   │   ├── src/main.ts                  # process composition and shutdown only
│   │   ├── src/app.ts                   # Fastify composition and loopback policy
│   │   ├── src/config.ts                # paths, ports, timeouts, billing-env guard
│   │   ├── src/db/{database,migrate}.ts # SQLite connection and migrations
│   │   ├── src/db/migrations/001-initial.sql
│   │   ├── src/repositories/*.ts        # one repository per persisted aggregate
│   │   ├── src/platform/{paths,git}.ts  # portable filesystem/Git adapters
│   │   ├── src/claude/*.ts              # driver contract, SDK driver, fake, normalizer
│   │   ├── src/runtime/*.ts              # lifecycle, registry, event log, recovery
│   │   ├── src/http/*.ts                 # snapshots and command routes
│   │   ├── src/realtime/*.ts             # replayable WebSocket hub
│   │   └── src/**/*.spec.ts              # colocated unit/integration tests
│   └── web/
│       ├── project.json / vite.config.ts # browser build/test configuration
│       ├── src/main.tsx                  # browser entry
│       ├── src/app/App.tsx               # application shell
│       ├── src/api/{client,socket}.ts    # contract-safe transports
│       ├── src/state/{store,reducer}.ts  # Hookstate projection and event reducer
│       ├── src/workspace/*.tsx           # Dockview ownership and layout persistence
│       ├── src/sessions/*.tsx            # sidebar, panel, transcript, approvals, composer
│       ├── src/ui/*.tsx                  # thin Radix wrappers used by features
│       └── src/**/*.spec.tsx             # component/projection tests
├── packages/contracts/
│   ├── project.json
│   └── src/{domain,events,commands,http,realtime,index}.ts
├── e2e/
│   ├── project.json
│   ├── playwright.config.ts
│   ├── fixtures/fake-claude.ts
│   └── src/session-platform.spec.ts
└── docs/development/session-platform.md # local setup, gates, and opt-in smoke test
```

The contracts package contains transport/domain data only. Server repositories contain SQL but no HTTP concerns. Runtime services depend on repositories and the `ClaudeSessionDriver`, not on Fastify. Web feature folders own their rendering and tests; `state/reducer.ts` is the only event-to-client-projection transition point.

---

### Task 1: Establish the Nx TypeScript Workspace and Contract Package

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `nx.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`
- Create: `apps/server/project.json`, `apps/server/tsconfig.json`, `apps/server/tsconfig.app.json`, `apps/server/tsconfig.spec.json`
- Create: `apps/web/project.json`, `apps/web/tsconfig.json`, `apps/web/tsconfig.app.json`, `apps/web/tsconfig.spec.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `packages/contracts/project.json`, `packages/contracts/tsconfig.json`, `packages/contracts/tsconfig.lib.json`, `packages/contracts/tsconfig.spec.json`
- Create: `packages/contracts/src/domain.ts`, `packages/contracts/src/events.ts`, `packages/contracts/src/commands.ts`, `packages/contracts/src/http.ts`, `packages/contracts/src/realtime.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/contracts.spec.ts`

**Interfaces:**
- Consumes: Approved record names, lifecycle states, permission modes, commands, and event envelope from the spec.
- Produces: `Project`, `Workspace`, `Session`, `SessionEvent`, `RawDiagnostic`, `SavedLayout`, `CommandEnvelope<T>`, `SessionSnapshot`, `ServerMessage`, and their exported Zod schemas/inferred TypeScript types.

- [ ] **Step 1: Scaffold the workspace configuration and pin the approved dependencies**

Run the non-interactive generators, then normalize the generated files to the planned three-project layout:

```powershell
pnpm dlx create-nx-workspace@latest . --preset=apps --workspaceType=integrated --packageManager=pnpm --nxCloud=skip --interactive=false
pnpm nx add @nx/react
pnpm nx add @nx/node
pnpm nx g @nx/react:application apps/web --bundler=vite --style=css --unitTestRunner=vitest --e2eTestRunner=none --routing=false --interactive=false
pnpm nx g @nx/node:application apps/server --bundler=esbuild --unitTestRunner=vitest --e2eTestRunner=none --framework=none --interactive=false
pnpm nx g @nx/js:library packages/contracts --bundler=none --unitTestRunner=vitest --publishable=false --interactive=false
pnpm add zod @hookstate/core dockview-react @radix-ui/react-collapsible @radix-ui/react-dialog @radix-ui/react-scroll-area @radix-ui/react-select @radix-ui/react-tooltip fastify @fastify/static @fastify/websocket better-sqlite3 @anthropic-ai/claude-agent-sdk
pnpm add -D tailwindcss @tailwindcss/vite @testing-library/react @testing-library/user-event @testing-library/jest-dom @playwright/test @types/better-sqlite3
```

Set root scripts to `format`, `lint`, `typecheck`, `test`, `build`, `e2e`, and `verify`, where `verify` runs those gates through Nx and excludes the external smoke target.

- [ ] **Step 2: Write failing contract tests for stable identities, discriminants, and command idempotency**

```ts
import { describe, expect, it } from 'vitest';
import { commandEnvelopeSchema, sessionEventSchema, sessionSchema } from './index.js';

describe('session platform contracts', () => {
  it('rejects a mutating command without an idempotency key', () => {
    expect(() => commandEnvelopeSchema.parse({ type: 'session.prompt', payload: { sessionId: 's1', prompt: 'hi' } })).toThrow();
  });

  it('requires a positive per-session event sequence', () => {
    expect(() => sessionEventSchema.parse({ id: 'e1', sessionId: 's1', sequence: 0, occurredAt: '2026-08-23T00:00:00.000Z', type: 'session.status', payload: { from: 'idle', to: 'running' } })).toThrow();
  });

  it('accepts the complete lifecycle vocabulary', () => {
    for (const lifecycleState of ['idle', 'starting', 'running', 'waiting_for_approval', 'interrupting', 'completed', 'failed', 'interrupted', 'archived']) {
      expect(sessionSchema.parse({ id: 's1', projectId: 'p1', workspaceId: 'w1', title: 'Session', permissionMode: 'interactive', lifecycleState, createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z' }).lifecycleState).toBe(lifecycleState);
    }
  });
});
```

- [ ] **Step 3: Run the contract test and verify the package API does not exist yet**

Run: `pnpm nx test contracts --runInBand`

Expected: FAIL because `./index.js` does not export the schemas.

- [ ] **Step 4: Define the domain and transport schemas with explicit discriminated unions**

Implement branded non-empty IDs as strings at the wire boundary, ISO timestamps, `workspaceTypeSchema = z.enum(['shared', 'worktree'])`, `permissionModeSchema = z.enum(['interactive', 'safe_auto', 'inherit'])`, and the exact lifecycle enum from Step 2. Define event variants for `message.user`, `message.assistant`, `tool.requested`, `tool.completed`, `permission.requested`, `permission.resolved`, `session.status`, `session.error`, and `diagnostic.recorded`.

```ts
export const sessionEventSchema = z.discriminatedUnion('type', [
  event('message.user', z.object({ text: z.string() })),
  event('message.assistant', z.object({ text: z.string() })),
  event('tool.requested', z.object({ toolCallId: idSchema, name: z.string(), input: z.unknown() })),
  event('tool.completed', z.object({ toolCallId: idSchema, output: z.unknown(), isError: z.boolean() })),
  event('permission.requested', permissionRequestSchema),
  event('permission.resolved', permissionResolutionSchema),
  event('session.status', z.object({ from: lifecycleStateSchema, to: lifecycleStateSchema, reason: z.string().optional() })),
  event('session.error', capabilityErrorSchema),
  event('diagnostic.recorded', z.object({ diagnosticId: idSchema, normalizedEventId: idSchema.optional() })),
]);
```

Define command variants for discovery, create, resume, prompt, interrupt, permission decision, archive, delete, history, diagnostics, and layout save. Mutating variants are always wrapped by `{ idempotencyKey, command }`. Define `ServerMessage` as `snapshot`, `events`, `connection.health`, or `resync.required`.

- [ ] **Step 5: Run contract tests, type checking, and boundary checks**

Run: `pnpm nx test contracts && pnpm nx typecheck contracts && pnpm nx graph --file=tmp/nx-graph.json`

Expected: all contracts tests pass; the graph contains `web -> contracts` and `server -> contracts` with no `contracts -> app` edge.

- [ ] **Step 6: Commit the independently usable contract foundation**

```powershell
git add package.json pnpm-lock.yaml pnpm-workspace.yaml nx.json tsconfig.base.json eslint.config.mjs .prettierrc.json .prettierignore apps packages
git commit -m "feat: establish session platform contracts"
```

---

### Task 2: Create SQLite Migrations and Transactional Repositories

**Files:**
- Create: `apps/server/src/db/database.ts`, `apps/server/src/db/migrate.ts`, `apps/server/src/db/migrations/001-initial.sql`
- Create: `apps/server/src/repositories/project-repository.ts`, `workspace-repository.ts`, `session-repository.ts`, `event-repository.ts`, `diagnostic-repository.ts`, `layout-repository.ts`, `command-repository.ts`
- Create: `apps/server/src/repositories/repositories.spec.ts`, `apps/server/src/db/migrate.spec.ts`, `apps/server/src/test/create-test-database.ts`

**Interfaces:**
- Consumes: Contract records and event variants from Task 1.
- Produces: `openDatabase(path): Database`, `migrate(database): void`, repository classes, and `EventRepository.append(sessionId, draft, raw): SessionEvent` with atomic sequence allocation and diagnostic linkage.

- [ ] **Step 1: Write migration and repository tests against a temporary SQLite file**

```ts
it('appends normalized event and raw diagnostic atomically with consecutive sequence numbers', () => {
  const repos = createTestRepositories();
  seedSession(repos, 's1');
  const first = repos.events.append('s1', userMessage('one'), rawSdk({ kind: 'user' }));
  const second = repos.events.append('s1', assistantMessage('two'), rawSdk({ kind: 'assistant' }));
  expect([first.sequence, second.sequence]).toEqual([1, 2]);
  expect(repos.diagnostics.list('s1')).toHaveLength(2);
});

it('rolls back both records when diagnostic persistence fails', () => {
  const repos = createTestRepositories({ failDiagnosticInsert: true });
  seedSession(repos, 's1');
  expect(() => repos.events.append('s1', userMessage('one'), rawSdk({ kind: 'user' }))).toThrow();
  expect(repos.events.after('s1', 0)).toEqual([]);
});
```

- [ ] **Step 2: Run the repository tests and verify they fail before the schema exists**

Run: `pnpm nx test server --testPathPattern="(migrate|repositories)"`

Expected: FAIL with missing migration/repository modules.

- [ ] **Step 3: Implement the initial schema and migration ledger**

Create tables `schema_migrations`, `projects`, `workspaces`, `sessions`, `session_events`, `raw_diagnostics`, `permission_requests`, `saved_layouts`, and `processed_commands`. Enforce `UNIQUE(session_id, sequence)`, foreign keys, JSON payload text, and `processed_commands.idempotency_key` uniqueness. Store UTC ISO timestamps and add indexes for session history, pending approvals, project grouping, and archived filtering.

```sql
CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);
```

- [ ] **Step 4: Implement prepared-statement repositories and an atomic event transaction**

`EventRepository.append` must begin an immediate transaction, read `COALESCE(MAX(sequence), 0) + 1`, insert any raw diagnostic, insert the normalized event, update the session timestamp, commit, and only then return the parsed contract. `CommandRepository.executeOnce` stores the serialized response so a duplicate key returns the original response without invoking the callback again.

- [ ] **Step 5: Run migration, rollback, cascade, sequence, archive, and idempotency tests**

Run: `pnpm nx test server --testPathPattern="(migrate|repositories)" && pnpm nx typecheck server`

Expected: PASS, including a migration rerun against the same file and a failed write leaving no partial event.

- [ ] **Step 6: Commit persistence as a self-contained deliverable**

```powershell
git add apps/server/src/db apps/server/src/repositories apps/server/src/test
git commit -m "feat: persist session platform records"
```

---

### Task 3: Add Portable Path, Git Worktree, and Billing-Safety Adapters

**Files:**
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/platform/paths.ts`, `apps/server/src/platform/git.ts`, `apps/server/src/platform/process-runner.ts`
- Create: `apps/server/src/platform/paths.spec.ts`, `git.spec.ts`, `billing-environment.spec.ts`

**Interfaces:**
- Consumes: `Workspace` types and repository records from Tasks 1–2.
- Produces: `resolveWorkspacePath(input): Promise<AbsolutePath>`, `GitAdapter.createWorktree`, `GitAdapter.inspectWorktree`, `GitAdapter.removeOwnedWorktree`, `detectBillingOverrides(env): BillingConflict[]`, and injectable `ProcessRunner`.

- [ ] **Step 1: Write failing Windows/portable path and billing guard tests**

```ts
it.each([
  ['C:\\repo\\..\\repo\\src', 'C:\\repo\\src'],
  ['C:/repo/src', 'C:\\repo\\src'],
])('normalizes a Windows workspace path', async (input, expected) => {
  expect(await resolveWorkspacePath(input, win32TestFs())).toBe(expected);
});

it('reports API billing overrides without reading or returning secret values', () => {
  expect(detectBillingOverrides({ ANTHROPIC_API_KEY: 'secret' })).toEqual([{ variable: 'ANTHROPIC_API_KEY' }]);
});
```

- [ ] **Step 2: Run focused tests and verify adapter modules are missing**

Run: `pnpm nx test server --testPathPattern="(paths|git|billing-environment)"`

Expected: FAIL with unresolved imports.

- [ ] **Step 3: Implement canonical absolute-path validation and redacted billing detection**

Resolve relative input against an explicitly injected base directory, call realpath for existing folders, reject non-directories and NUL bytes, and return an opaque branded absolute path. Detect `ANTHROPIC_API_KEY` plus SDK-documented API-billing override variables in one named allowlist; return variable names only and never log values.

- [ ] **Step 4: Implement Git commands through an argv-only process boundary**

```ts
export interface ProcessRunner {
  run(executable: string, args: readonly string[], options: { cwd: string; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
```

Use `git -C <repo> worktree add -b <branch> <absolutePath> <startPoint>`, `git status --porcelain=v1`, and `git worktree remove <absolutePath>` as argv arrays. Before removal require: Mesh ownership in SQLite, no active session, clean porcelain output, exact canonical path match, and explicit `confirmed: true`. Return typed preservation reasons (`dirty`, `missing`, `ambiguous`, `not_owned`, `session_active`) without force removal.

- [ ] **Step 5: Exercise adapters against temporary repositories**

Run: `pnpm nx test server --testPathPattern="(paths|git|billing-environment)"`

Expected: PASS for paths containing spaces, dirty worktree preservation, ownership refusal, shared-folder non-removal, and successful clean owned-worktree removal.

- [ ] **Step 6: Commit the portable safety boundary**

```powershell
git add apps/server/src/config.ts apps/server/src/platform
git commit -m "feat: add portable workspace safety adapters"
```

---

### Task 4: Define the Claude Driver Boundary and Deterministic Fake

**Files:**
- Create: `apps/server/src/claude/driver.ts`, `fake-driver.ts`, `normalize-event.ts`, `permission-policy.ts`
- Create: `apps/server/src/claude/normalize-event.spec.ts`, `permission-policy.spec.ts`, `fake-driver.spec.ts`

**Interfaces:**
- Consumes: Permission modes, event payloads, and capability errors from contracts.
- Produces: `ClaudeSessionDriver`, `DriverSession`, `DriverEvent`, `normalizeDriverEvent`, `PermissionPolicy.decide`, and a scriptable `FakeClaudeSessionDriver` used by every normal test tier.

- [ ] **Step 1: Write failing driver-contract, normalization, and fail-closed tests**

```ts
it('quarantines an unsupported driver event without inventing a client event', () => {
  expect(normalizeDriverEvent({ kind: 'future-sdk-kind', payload: { secret: false } })).toEqual({
    kind: 'unsupported',
    error: { code: 'unsupported_claude_capability', capability: 'future-sdk-kind' },
    raw: { kind: 'future-sdk-kind', payload: { secret: false } },
  });
});

it('safe auto-approval requires an explicitly classified read-only tool', () => {
  expect(permissionPolicy('safe_auto').decide({ toolName: 'unknown', input: {} })).toEqual({ action: 'prompt' });
});
```

- [ ] **Step 2: Run the Claude boundary tests and verify the interfaces are absent**

Run: `pnpm nx test server --testPathPattern="(normalize-event|permission-policy|fake-driver)"`

Expected: FAIL with missing modules.

- [ ] **Step 3: Define a narrow async driver interface independent of SDK types**

```ts
export interface ClaudeSessionDriver {
  discover(request: DiscoverClaudeSessionsRequest): Promise<DiscoveredClaudeSession[]>;
  create(request: StartClaudeSessionRequest): Promise<DriverSession>;
  resume(request: ResumeClaudeSessionRequest): Promise<DriverSession>;
}

export interface DriverSession {
  readonly claudeResumeId: string | undefined;
  events(): AsyncIterable<DriverEvent>;
  sendPrompt(prompt: string): Promise<void>;
  resolvePermission(requestId: string, decision: 'approve' | 'deny'): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
```

Driver events contain no SDK imports and cover text deltas/completions, tool requests/results, permission requests, status, limit information, malformed input, and terminal errors.

- [ ] **Step 4: Implement total event normalization and permission policies**

Map every known driver variant to a typed contract event draft. For malformed/unknown variants return an unsupported result containing the raw object for diagnostics. Interactive always prompts; inherit delegates to the driver; safe-auto approves only the explicitly enumerated read-only tool/input shapes and prompts for everything else.

- [ ] **Step 5: Implement a controllable fake driver**

Allow tests to enqueue events, pause emission, expose recorded prompts/decisions, simulate subscription limits, throw during streaming, and acknowledge interruption. The fake must never import or call the real SDK.

- [ ] **Step 6: Run all boundary tests and commit**

Run: `pnpm nx test server --testPathPattern="(normalize-event|permission-policy|fake-driver)" && pnpm nx typecheck server`

```powershell
git add apps/server/src/claude
git commit -m "feat: define Claude session driver boundary"
```

---

### Task 5: Implement the Persist-Before-Broadcast Session Runtime

**Files:**
- Create: `apps/server/src/runtime/lifecycle.ts`, `session-runtime.ts`, `session-registry.ts`, `event-publisher.ts`, `recovery.ts`
- Create: `apps/server/src/runtime/lifecycle.spec.ts`, `session-runtime.spec.ts`, `recovery.spec.ts`

**Interfaces:**
- Consumes: Repositories from Task 2 and `ClaudeSessionDriver`/normalizer from Task 4.
- Produces: `transition(current, trigger): LifecycleState`, `SessionRegistry.create/resume/sendPrompt/interrupt/resolvePermission/shutdown`, `EventPublisher.subscribe`, and `recoverInterruptedSessions()`.

- [ ] **Step 1: Write a table-driven failing lifecycle test**

```ts
it.each([
  ['idle', 'start', 'starting'],
  ['starting', 'driver_started', 'running'],
  ['running', 'permission_requested', 'waiting_for_approval'],
  ['waiting_for_approval', 'permission_resolved', 'running'],
  ['running', 'interrupt', 'interrupting'],
  ['interrupting', 'driver_stopped', 'interrupted'],
] as const)('%s + %s -> %s', (from, trigger, to) => {
  expect(transition(from, trigger)).toBe(to);
});

it('rejects prompt submission outside idle/running', async () => {
  await expect(registry.sendPrompt('waiting-session', 'duplicate side effect')).rejects.toMatchObject({ code: 'invalid_session_state' });
});
```

- [ ] **Step 2: Run runtime tests and verify the lifecycle implementation is missing**

Run: `pnpm nx test server --testPathPattern="(lifecycle|session-runtime|recovery)"`

Expected: FAIL with unresolved runtime imports.

- [ ] **Step 3: Implement an exhaustive lifecycle transition function**

Represent triggers as a discriminated union and use an exhaustive `never` guard. Reject invalid transitions with `{ code: 'invalid_session_state', from, trigger }`; never silently coerce state.

- [ ] **Step 4: Implement one live driver per session and persistence ordering**

For each incoming driver event: normalize it, atomically persist raw diagnostic and normalized event, update the persisted session lifecycle, update the in-memory runtime view, then publish. On database failure set the registry write barrier, stop accepting prompts/decisions globally, interrupt drivers, and expose `audit_unavailable`. On driver crash preserve emitted events, persist `interrupted`, and keep the Claude resume ID.

- [ ] **Step 5: Implement restart and bounded shutdown recovery**

At startup atomically change persisted `starting`, `running`, `waiting_for_approval`, and `interrupting` sessions to `interrupted` with a recovery event. Do not instantiate drivers or replay prompts. Shutdown requests interruption for all live drivers, waits the configured bounded timeout, persists terminal truth where possible, then closes SQLite.

- [ ] **Step 6: Verify browser independence and failure behavior with the fake driver**

Run: `pnpm nx test server --testPathPattern="(lifecycle|session-runtime|recovery)"`

Expected: PASS for driver crash, malformed event quarantine, duplicate driver event suppression, disconnect with continued persistence, database failure barrier, restart reconciliation, and no automatic prompt replay.

- [ ] **Step 7: Commit the runtime core**

```powershell
git add apps/server/src/runtime
git commit -m "feat: add durable session runtime"
```

---

### Task 6: Expose Idempotent HTTP Commands and Snapshots

**Files:**
- Create: `apps/server/src/http/errors.ts`, `command-handler.ts`, `routes.ts`, `snapshots.ts`
- Create: `apps/server/src/http/routes.spec.ts`, `command-handler.spec.ts`
- Create: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: Contract schemas, repositories, workspace adapters, and `SessionRegistry`.
- Produces: `buildApp(dependencies): FastifyInstance`, `executeCommand(envelope): CommandResponse`, `GET /api/snapshot`, history/diagnostic pagination, and `POST /api/commands`.

- [ ] **Step 1: Write failing HTTP contract tests through Fastify injection**

```ts
it('returns the same response for a repeated idempotency key', async () => {
  const body = { idempotencyKey: 'key-1', command: { type: 'session.prompt', payload: { sessionId: 's1', prompt: 'hello' } } };
  const first = await app.inject({ method: 'POST', url: '/api/commands', payload: body });
  const second = await app.inject({ method: 'POST', url: '/api/commands', payload: body });
  expect(second.json()).toEqual(first.json());
  expect(fakeSession.prompts).toEqual(['hello']);
});

it('never returns raw diagnostics in the ordinary snapshot', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/snapshot' })).json()).not.toHaveProperty('rawDiagnostics');
});
```

- [ ] **Step 2: Run route tests and verify the app factory is missing**

Run: `pnpm nx test server --testPathPattern="(routes|command-handler)"`

Expected: FAIL with unresolved HTTP/app imports.

- [ ] **Step 3: Implement schema-first commands and typed error mapping**

Parse every request and response with contracts. Route create/resume/prompt/interrupt/permission/archive/delete/layout commands through `CommandRepository.executeOnce`. Return stable errors including `invalid_command`, `invalid_session_state`, `billing_configuration_conflict`, `unsupported_claude_capability`, `audit_unavailable`, and `workspace_preserved`.

- [ ] **Step 4: Implement snapshots and bounded history/diagnostic reads**

`GET /api/snapshot` returns projects, workspaces, non-deleted sessions, pending approvals, last sequence per session, and saved layout. `GET /api/sessions/:id/events?after=&limit=` returns normalized events. `GET /api/sessions/:id/diagnostics?after=&limit=` is the only raw payload endpoint. Clamp limits and parse all records before sending.

- [ ] **Step 5: Implement discovery/create/worktree/resume command orchestration**

Discovery merges driver transcript metadata with canonicalized local projects and application sessions. Create accepts either shared absolute path or explicit worktree inputs, persists project/workspace/session before starting one driver, and reports a collision warning when another live session uses the same shared path. Resume requires a stored/discovered Claude resume ID and never reuses a live driver.

- [ ] **Step 6: Run HTTP, runtime, and repository integration tests**

Run: `pnpm nx test server --testPathPattern="(routes|command-handler|session-runtime|repositories)"`

Expected: PASS for all commands, explicit deletion confirmation, archive preservation, pagination, idempotency, shared-folder collision warning, and raw-diagnostic separation.

- [ ] **Step 7: Commit the command surface**

```powershell
git add apps/server/src/http apps/server/src/app.ts
git commit -m "feat: expose session command API"
```

---

### Task 7: Add Replayable WebSocket Delivery and Reconnect Reconciliation

**Files:**
- Create: `apps/server/src/realtime/socket-hub.ts`, `replay.ts`
- Create: `apps/server/src/realtime/socket-hub.spec.ts`, `replay.spec.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `EventPublisher`, event repository, `ServerMessage`, and per-session cursor map.
- Produces: `/api/socket`, `ReplayService.after(cursors)`, connection health messages, ordered event batches, and `resync.required` fallback.

- [ ] **Step 1: Write failing reconnect tests**

```ts
it('replays only events after each supplied cursor', async () => {
  seedEvents('s1', [1, 2, 3]);
  const client = await connect({ s1: 1 });
  expect(await client.next()).toMatchObject({ type: 'events', events: [{ sequence: 2 }, { sequence: 3 }] });
});

it('requires a snapshot when requested history is unavailable', async () => {
  compactBefore('s1', 4);
  const client = await connect({ s1: 1 });
  expect(await client.next()).toEqual({ type: 'resync.required', sessionIds: ['s1'] });
});
```

- [ ] **Step 2: Run realtime tests and verify replay is absent**

Run: `pnpm nx test server --testPathPattern="(socket-hub|replay)"`

Expected: FAIL with missing realtime modules.

- [ ] **Step 3: Implement authenticated-by-origin loopback WebSocket upgrade**

Accept upgrades only when the remote address is loopback and `Origin` exactly matches the configured served origin. The first client frame must parse as `{ type: 'subscribe', cursors: Record<SessionId, number> }`; reject malformed frames and cap cursor/session counts.

- [ ] **Step 4: Implement replay-before-live subscription without gaps**

Capture a repository high-water mark, subscribe to publisher events, read persisted events through that mark, send ordered replay batches, then drain buffered live events above the mark. Deduplicate by `(sessionId, sequence)`. Emit health states `connected`, `degraded`, and heartbeat timestamps.

- [ ] **Step 5: Verify ordering under concurrent append/reconnect and commit**

Run: `pnpm nx test server --testPathPattern="(socket-hub|replay|session-runtime)"`

Expected: PASS with no gaps or duplicates while an event is appended during replay.

```powershell
git add apps/server/src/realtime apps/server/src/app.ts
git commit -m "feat: stream replayable session events"
```

---

### Task 8: Integrate the Claude Agent SDK Behind the Driver

**Files:**
- Create: `apps/server/src/claude/sdk-driver.ts`, `sdk-adapter.ts`, `sdk-driver.contract.spec.ts`, `sdk-driver.smoke.spec.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/main.ts`
- Modify: `apps/server/project.json`

**Interfaces:**
- Consumes: `ClaudeSessionDriver`, billing guard, workspace paths, permission policy.
- Produces: `SdkClaudeSessionDriver` and opt-in Nx target `external-smoke`.

- [ ] **Step 1: Write a failing adapter contract test using an injected SDK facade**

```ts
it('maps SDK streaming, resume identity, permission, and interruption without leaking SDK types', async () => {
  const sdk = scriptedSdk([sdkAssistant('hello'), sdkPermission('r1', 'Write'), sdkResult('done')]);
  const session = await new SdkClaudeSessionDriver(sdk).create(startRequest);
  expect(await collect(session.events())).toMatchObject([
    { kind: 'assistant_message', text: 'hello' },
    { kind: 'permission_request', requestId: 'r1', toolName: 'Write' },
    { kind: 'completed' },
  ]);
});
```

- [ ] **Step 2: Run the SDK contract test and verify the adapter is missing**

Run: `pnpm nx test server --testPathPattern=sdk-driver.contract`

Expected: FAIL with missing `SdkClaudeSessionDriver`.

- [ ] **Step 3: Implement the SDK facade and driver mapping**

Keep every SDK import in `sdk-adapter.ts`. Map SDK create/resume/query APIs, resume IDs, async stream messages, permission callbacks, interrupt, subscription-limit metadata, and errors into driver-owned types. If the installed SDK cannot support a required capability, throw the typed capability error; do not parse the Claude terminal UI and do not add a CLI fallback in this phase.

- [ ] **Step 4: Enforce subscription-only startup before constructing the SDK**

`main.ts` opens configuration, checks redacted billing conflicts, migrates/reconciles persistence, constructs the SDK driver only when no conflict exists, starts the loopback server, and installs bounded signal handlers. A conflict allows the UI/server to explain the block but prevents all launch/resume commands from constructing a Claude query.

- [ ] **Step 5: Add an explicitly opt-in external smoke target**

Gate the smoke test with `MESH_RUN_CLAUDE_SMOKE=1`; otherwise call `describe.skip`. Exercise one minimal subscription-authenticated session and interrupt it. Configure `external-smoke` outside `verify`, CI defaults, and affected test targets.

- [ ] **Step 6: Run deterministic tests and type checking**

Run: `pnpm nx test server --testPathPattern=sdk-driver.contract && pnpm nx typecheck server`

Expected: PASS without contacting Claude. Do not run `external-smoke` during implementation unless the operator explicitly opts in.

- [ ] **Step 7: Commit the real driver boundary**

```powershell
git add apps/server/src/claude apps/server/src/config.ts apps/server/src/main.ts apps/server/project.json
git commit -m "feat: connect Claude Agent SDK driver"
```

---

### Task 9: Build Contract-Safe Client Transport and Hookstate Projection

**Files:**
- Create: `apps/web/src/api/client.ts`, `socket.ts`
- Create: `apps/web/src/state/store.ts`, `reducer.ts`, `selectors.ts`
- Create: `apps/web/src/state/reducer.spec.ts`, `apps/web/src/api/socket.spec.ts`
- Create: `apps/web/src/test/setup.ts`

**Interfaces:**
- Consumes: `SessionSnapshot`, `SessionEvent`, command schemas, and `ServerMessage`.
- Produces: `MeshApi`, `MeshSocket`, `createMeshStore(snapshot)`, `applyEvent(state, event)`, per-session cursors, unread/approval selectors, and snapshot replacement.

- [ ] **Step 1: Write failing idempotent projection and resync tests**

```ts
it('applies each sequence once and detects a gap', () => {
  const state = createProjection(snapshotWithCursor('s1', 3));
  expect(applyEvent(state, event('s1', 3))).toEqual({ kind: 'duplicate' });
  expect(applyEvent(state, event('s1', 5))).toEqual({ kind: 'gap', expected: 4, received: 5 });
  expect(applyEvent(state, event('s1', 4))).toEqual({ kind: 'applied' });
});

it('replaces all canonical projections after resync while retaining prompt drafts', () => {
  const next = replaceSnapshot(stateWithDraft('draft'), freshSnapshot);
  expect(next.promptDrafts.s1).toBe('draft');
  expect(next.sessions).toEqual(freshSnapshot.sessions);
});
```

- [ ] **Step 2: Run client state tests and verify modules are missing**

Run: `pnpm nx test web --testPathPattern="(reducer|socket)"`

Expected: FAIL with unresolved API/state imports.

- [ ] **Step 3: Implement parse-at-boundary HTTP and WebSocket clients**

Generate UUID idempotency keys in the caller, parse every response/frame with contracts, reconnect with capped exponential backoff, subscribe with current cursors, and fetch/replace the snapshot on `resync.required` or a reducer gap. Never silently discard an invalid server payload; surface a local diagnostic notification.

- [ ] **Step 4: Implement Hookstate ownership and pure projection transitions**

Canonical projections include projects, workspaces, sessions, event lists, pending approvals, and cursor maps. Transient state includes selected session IDs, filters, drafts, unread markers, connection health, and notifications. Keep `applyEvent` pure and update Hookstate from its result so reducer tests do not require React.

- [ ] **Step 5: Run web state tests and commit**

Run: `pnpm nx test web --testPathPattern="(reducer|socket)" && pnpm nx typecheck web`

```powershell
git add apps/web/src/api apps/web/src/state apps/web/src/test
git commit -m "feat: project session state in the client"
```

---

### Task 10: Build the Dockview Shell, Sidebar, and Persisted Two-Pane Layout

**Files:**
- Create: `apps/web/src/main.tsx`, `apps/web/src/app/App.tsx`, `apps/web/src/app/App.spec.tsx`
- Create: `apps/web/src/workspace/SessionWorkspace.tsx`, `layout-controller.ts`, `SessionWorkspace.spec.tsx`
- Create: `apps/web/src/sessions/SessionSidebar.tsx`, `SessionSidebar.spec.tsx`
- Create: `apps/web/src/ui/Tooltip.tsx`, `Dialog.tsx`, `Select.tsx`, `ScrollArea.tsx`
- Create: `apps/web/src/styles.css`, `apps/web/src/vite-env.d.ts`
- Modify: `apps/web/vite.config.ts`

**Interfaces:**
- Consumes: Hookstate selectors, saved layout contracts, `MeshApi`, and a placeholder session panel component ID.
- Produces: responsive application shell, permanent grouped sidebar, Dockview panel open/hide behavior, maximum two visible groups, and debounced serialized layout commands.

- [ ] **Step 1: Write failing shell and layout-policy component tests**

```tsx
it('hiding a panel does not send an interrupt command', async () => {
  render(<TestApp sessions={[runningSession]} />);
  await user.click(screen.getByRole('button', { name: 'Close Session A panel' }));
  expect(api.commands).not.toContainEqual(expect.objectContaining({ type: 'session.interrupt' }));
});

it('refuses a third visible Dockview group while allowing another tab', async () => {
  const workspace = renderWorkspaceWithTwoGroups();
  await workspace.dragSessionToNewEdge('s3');
  expect(workspace.visibleGroups()).toHaveLength(2);
  expect(workspace.visibleTabs()).toContain('s3');
});
```

- [ ] **Step 2: Run component tests and verify the shell is absent**

Run: `pnpm nx test web --testPathPattern="(App|SessionWorkspace|SessionSidebar)"`

Expected: FAIL with missing components.

- [ ] **Step 3: Configure Tailwind and the application theme**

Use `@tailwindcss/vite`, import Dockview base CSS, and define a thin set of CSS variables for background, panel, border, focus, status, and Dockview group/tab colors. Preserve visible keyboard focus and reduced-motion behavior.

- [ ] **Step 4: Implement the sidebar and Dockview ownership boundary**

Group visible sessions by project/repository. Render title, lifecycle badge, unread count, `shared`/`worktree`, and approval indicator with filtering and “New session”. Register one Dockview component key, `session`, whose params contain only `sessionId`. Intercept group creation so a third group resolves to a tab insertion in the active/nearest existing group.

- [ ] **Step 5: Restore and persist layouts safely**

Parse the saved layout, discard panels for deleted sessions, restore at most two groups, and open missing selected sessions as tabs. Debounce `api.saveLayout({ dockview, sidebar, visibleSessionIds })`; closing a panel updates visibility/layout only.

- [ ] **Step 6: Verify accessibility and commit**

Run: `pnpm nx test web --testPathPattern="(App|SessionWorkspace|SessionSidebar)" && pnpm nx typecheck web`

Expected: PASS for keyboard-open sessions, two-group enforcement, restore pruning, hide-not-stop, and saved layout serialization.

```powershell
git add apps/web
git commit -m "feat: add persisted two-pane session workspace"
```

---

### Task 11: Render Structured Sessions, Permissions, Diagnostics, and Commands

**Files:**
- Create: `apps/web/src/sessions/SessionPanel.tsx`, `SessionHeader.tsx`, `Transcript.tsx`, `TranscriptItem.tsx`, `PermissionCard.tsx`, `RawDiagnostics.tsx`, `PromptComposer.tsx`, `SessionActions.tsx`
- Create: `apps/web/src/sessions/SessionPanel.spec.tsx`, `Transcript.spec.tsx`, `PermissionCard.spec.tsx`, `RawDiagnostics.spec.tsx`, `PromptComposer.spec.tsx`
- Modify: `apps/web/src/workspace/SessionWorkspace.tsx`

**Interfaces:**
- Consumes: Session/event/diagnostic projections and `MeshApi` command methods.
- Produces: Complete session panel UI with explicit interrupt/archive/delete, structured transcript, permission audit trail/actions, lazy diagnostics, and guarded prompt submission.

- [ ] **Step 1: Write failing rendering and interaction tests**

```tsx
it('renders normalized content and keeps raw payloads collapsed and lazy', async () => {
  render(<SessionPanel sessionId="s1" />);
  expect(screen.getByText('Assistant reply')).toBeVisible();
  expect(api.diagnosticRequests).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Raw diagnostics' }));
  expect(api.diagnosticRequests).toEqual(['s1']);
});

it('requires confirmation for destructive deletion', async () => {
  await user.click(screen.getByRole('button', { name: 'Delete session' }));
  expect(api.commands).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
  expect(api.commands.at(-1)).toMatchObject({ type: 'session.delete', payload: { sessionId: 's1', confirmed: true } });
});
```

- [ ] **Step 2: Run session component tests and verify components are missing**

Run: `pnpm nx test web --testPathPattern="(SessionPanel|Transcript|PermissionCard|RawDiagnostics|PromptComposer)"`

Expected: FAIL with unresolved session components.

- [ ] **Step 3: Implement typed transcript rendering**

Exhaustively render user/assistant messages, tool request/result pairs, status transitions, permission audit entries, errors, and diagnostics indicators. Unknown variants are impossible after contract parsing; use an exhaustive guard. Keep tool input/output collapsed by default and label errors/status for assistive technology.

- [ ] **Step 4: Implement permission cards and explicit actions**

Show tool name, summarized arguments, requested time, policy mode, and pending/resolved/expired status. Only pending decisions show Approve/Deny; each click sends a fresh idempotency key and disables both actions until resolved. Never infer approval from reconnect or disappearance.

- [ ] **Step 5: Implement diagnostics, composer, and session actions**

Fetch diagnostics only when the Radix Collapsible opens, render JSON read-only, and paginate. Preserve prompt drafts in Hookstate; disable send outside allowed states or when audit is unavailable. Interrupt, archive, and delete are distinct controls; only deletion has destructive confirmation.

- [ ] **Step 6: Run component tests and commit**

Run: `pnpm nx test web --testPathPattern="(SessionPanel|Transcript|PermissionCard|RawDiagnostics|PromptComposer)" && pnpm nx typecheck web`

```powershell
git add apps/web/src/sessions apps/web/src/workspace/SessionWorkspace.tsx
git commit -m "feat: render and control structured sessions"
```

---

### Task 12: Add Discovery and Shared/Worktree Session Creation Flows

**Files:**
- Create: `apps/web/src/sessions/NewSessionDialog.tsx`, `ResumeSessionDialog.tsx`, `WorkspaceFields.tsx`
- Create: `apps/web/src/sessions/NewSessionDialog.spec.tsx`, `ResumeSessionDialog.spec.tsx`
- Modify: `apps/web/src/sessions/SessionSidebar.tsx`
- Modify: `apps/web/src/app/App.tsx`

**Interfaces:**
- Consumes: Discovery snapshot, create/resume command contracts, permission/workspace enums, and collision/preservation errors.
- Produces: Accessible Radix dialogs for selecting project, shared folder or worktree, branch/start point, permission mode, and discovered Claude resume identity.

- [ ] **Step 1: Write failing creation/resume flow tests**

```tsx
it('submits an isolated worktree with explicit permission mode', async () => {
  render(<NewSessionDialog open />);
  await choose('Workspace type', 'Isolated Git worktree');
  await user.type(screen.getByLabelText('Branch'), 'mesh/session-a');
  await choose('Permission mode', 'Interactive approvals');
  await user.click(screen.getByRole('button', { name: 'Create session' }));
  expect(api.commands.at(-1)).toMatchObject({ type: 'session.create', payload: { workspace: { type: 'worktree', branch: 'mesh/session-a' }, permissionMode: 'interactive' } });
});
```

- [ ] **Step 2: Run dialog tests and verify the flows are absent**

Run: `pnpm nx test web --testPathPattern="(NewSessionDialog|ResumeSessionDialog)"`

Expected: FAIL with missing dialogs.

- [ ] **Step 3: Implement discovery and new-session controls**

Populate projects and discovered Claude sessions from the snapshot. Shared mode requests an absolute folder path and presents a prominent collision warning returned by the backend. Worktree mode requests repository, branch, start point, and proposed absolute worktree path. Always require the user to select one of the three permission modes.

- [ ] **Step 4: Implement explicit resume behavior and typed failure presentation**

Resume shows Claude identity, last known path, application session match, and permission/workspace selection. It never claims an interrupted process is still running and never resubmits the last prompt. Present billing conflict, subscription reset information, unsupported capability, dirty/ambiguous worktree preservation, and invalid path as actionable typed messages.

- [ ] **Step 5: Run flows, accessibility checks, and commit**

Run: `pnpm nx test web --testPathPattern="(NewSessionDialog|ResumeSessionDialog|SessionSidebar|App)" && pnpm nx typecheck web`

```powershell
git add apps/web/src/sessions apps/web/src/app/App.tsx
git commit -m "feat: add session discovery and creation flows"
```

---

### Task 13: Enforce Loopback Serving, Origin Policy, and Graceful Process Lifecycle

**Files:**
- Create: `apps/server/src/app.security.spec.ts`, `apps/server/src/main.spec.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/main.ts`, `apps/server/src/config.ts`
- Modify: `apps/server/project.json`, `apps/web/project.json`, `nx.json`

**Interfaces:**
- Consumes: Built web assets, app factory, registry shutdown, billing guard.
- Produces: one loopback origin serving both API/WebSocket and production web assets, bounded shutdown, and Nx development orchestration.

- [ ] **Step 1: Write failing local-security and shutdown tests**

```ts
it.each(['http://evil.example', 'null'])('rejects HTTP and socket origin %s', async (origin) => {
  expect((await app.inject({ method: 'GET', url: '/api/snapshot', headers: { origin } })).statusCode).toBe(403);
  await expect(connectSocket({ origin })).rejects.toThrow();
});

it('interrupts live sessions before the bounded shutdown deadline', async () => {
  await lifecycle.shutdown();
  expect(fakeSession.interruptCalls).toBe(1);
  expect(database.closed).toBe(true);
});
```

- [ ] **Step 2: Run security/process tests and verify current composition fails them**

Run: `pnpm nx test server --testPathPattern="(app.security|main)"`

Expected: FAIL until origin checks/static serving/signal lifecycle are composed.

- [ ] **Step 3: Bind and serve from one validated loopback origin**

Default host to `127.0.0.1`, reject non-loopback configured hosts, derive the one allowed origin from the actual listening address, serve `dist/apps/web` with SPA fallback, and apply identical origin checks to API requests and WebSocket upgrades. Do not add login, LAN binding, telemetry, or remote exposure.

- [ ] **Step 4: Complete startup and shutdown ordering**

Startup order: load config, open/migrate DB, reconcile stale live sessions, build adapters/driver/runtime, build app, listen. Shutdown order: stop accepting commands/upgrades, request runtime interruption, await bounded timeout, close sockets, close DB, exit with failure if persistence became untrustworthy.

- [ ] **Step 5: Add Nx local-development orchestration**

Configure `server:dev` to depend on contract build and run with the Vite dev origin explicitly allowed; configure production `server:serve` to depend on `web:build`. Keep cacheable build/test/typecheck inputs deterministic and keep database/runtime files outside the repository by default.

- [ ] **Step 6: Run server security, complete deterministic tests, and builds**

Run: `pnpm nx test server && pnpm nx build contracts && pnpm nx build web && pnpm nx build server`

Expected: PASS; server build contains no React/Hookstate imports, web build contains no server internals, and no external Claude request occurs.

- [ ] **Step 7: Commit the local application boundary**

```powershell
git add apps/server apps/web/project.json nx.json
git commit -m "feat: secure local session application"
```

---

### Task 14: Add End-to-End Acceptance Coverage and Developer Documentation

**Files:**
- Create: `e2e/project.json`, `e2e/playwright.config.ts`, `e2e/fixtures/fake-claude.ts`, `e2e/src/session-platform.spec.ts`
- Create: `docs/development/session-platform.md`
- Modify: `package.json`, `nx.json`

**Interfaces:**
- Consumes: Production server/web, fake driver selection available only in test configuration, and all public contracts.
- Produces: deterministic browser-level acceptance proof, aggregate `pnpm verify`, and operator documentation separating normal verification from opt-in Claude smoke usage.

- [ ] **Step 1: Write the failing Playwright acceptance scenarios**

```ts
test('active session survives refresh and restores two-pane layout without duplicate events', async ({ page }) => {
  await seedFakeClaude(['assistant:one', 'wait', 'assistant:two']);
  await createSharedSession(page, { permissionMode: 'interactive' });
  await expect(page.getByText('one')).toBeVisible();
  await splitWithSecondSession(page);
  await page.reload();
  await releaseFakeClaude();
  await expect(page.getByText('two')).toHaveCount(1);
  await expect(visibleDockviewGroups(page)).resolves.toHaveLength(2);
});
```

Add scenarios for discovered-session resume; shared and worktree creation; structured tool/result rendering; persisted interactive approval across reconnect; raw diagnostics; panel close without interruption; browser close with backend continuation; server restart truthfully marking live sessions interrupted; API-billing conflict refusal; and a third session becoming a tab rather than a third group.

- [ ] **Step 2: Run E2E and observe the first failing acceptance path**

Run: `pnpm nx e2e e2e --project=chromium`

Expected: FAIL until the deterministic fake-driver boot mode and fixtures are wired.

- [ ] **Step 3: Implement the test-only fake-driver boot fixture**

Start the production-built server on an ephemeral loopback port with a temporary SQLite database, temporary Git repositories, and `FakeClaudeSessionDriver`. Expose fixture controls only through an in-process test handle or random test-only control token; production configuration must reject the fake-driver switch.

- [ ] **Step 4: Complete all browser acceptance scenarios**

Use role/label selectors, assert persisted database-visible outcomes through the public snapshot/history APIs, and retain traces/screenshots only on failure. Run Windows Chromium as the required first platform; define macOS/Linux jobs as portable follow-up matrix entries using the same tests.

- [ ] **Step 5: Document setup, ownership, safety, and verification**

Document Node/pnpm prerequisites, `pnpm install`, local development, data directory, loopback origin, subscription-only behavior, billing-conflict remediation outside Mesh, shared-folder collision risk, worktree preservation/removal rules, restart semantics, normal `pnpm verify`, and the explicit `MESH_RUN_CLAUDE_SMOKE=1 pnpm nx external-smoke server` command with its subscription-capacity warning.

- [ ] **Step 6: Run the complete required gate from a clean process state**

Run: `pnpm verify`

Expected: formatting, linting, type checking, unit/contract tests, builds, deterministic integration tests, and Playwright E2E all PASS; `external-smoke` is not invoked.

- [ ] **Step 7: Confirm Nx affected coverage**

Run: `pnpm nx affected -t lint,typecheck,test,build --base=f221dd9 --head=HEAD`

Expected: PASS for every affected application/package and no dependency-boundary violation.

- [ ] **Step 8: Commit the acceptance proof and operating guide**

```powershell
git add e2e docs/development/session-platform.md package.json nx.json
git commit -m "test: prove session platform acceptance"
```

---

## Final Acceptance Review

- [ ] Confirm each of the ten MVP acceptance criteria in the specification has at least one deterministic integration or Playwright assertion.
- [ ] Confirm no source directories or contracts exist for tasks, boards, PM/Developer/QA roles, delegation, orchestration, automation policies, authentication, LAN hosting, interactive terminals, Electron packaging, or automatic retention.
- [ ] Confirm all mutating command variants require `idempotencyKey` and every event producer uses the repository-assigned sequence.
- [ ] Confirm raw SDK/process objects cross only the diagnostics endpoint and never become a browser event contract.
- [ ] Confirm API-billing environment conflicts block driver creation and no API key value is persisted, returned, or logged.
- [ ] Confirm restart recovery changes formerly live sessions to `interrupted` and no test observes prompt replay.
- [ ] Confirm clean owned worktrees alone can be removed, while shared, dirty, missing, ambiguous, unowned, and active workspaces are preserved.
- [ ] Confirm Dockview owns geometry, Hookstate owns projections/transient UI, SQLite owns canonical state, and Claude owns native transcripts/resume IDs.
- [ ] Confirm `pnpm verify` passes on Windows without calling the external smoke target.
