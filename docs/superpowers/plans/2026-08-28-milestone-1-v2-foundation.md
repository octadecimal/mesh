# Mesh V2 Milestone 1: V2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separately runnable, fake-only V2 foundation that selects a
project, snapshots an approved profile into a harness-neutral execution,
persists audited ordered activity, and reconciles it across restart without V1
state.

**Architecture:** Add independent `v2-contracts`, `v2-server`, `v2-web`, and
`v2-e2e` Nx projects. Shared V2 wire contracts land first; one settled M1 SQLite
schema follows; project, profile, execution, and web-projection work then proceed
on non-overlapping surfaces before transport composition and the Todo restart
gate.

**Tech Stack:** TypeScript 6, Node.js 22, Nx 23, Zod 4, YAML 2.9,
better-sqlite3 13, Fastify 5, WebSocket, React 19, Vite 8, Vitest 4, Testing
Library, and Playwright.

**Spec:**
`docs/superpowers/specs/2026-08-28-milestone-1-v2-foundation-design.md`

## Global Constraints

- Start every worker from the exact frozen wave base supplied by the
  coordinator; confirm `git rev-parse HEAD` before editing and do not rebase,
  merge, reset, clean, push, open a pull request, or remove a worktree.
- Read `AGENTS.md`, the V2 architecture, the milestone design, and only the
  assigned task section before editing; use jCodeMunch and jDocMunch as required
  by repository policy.
- V2 projects are exactly `v2-contracts`, `v2-server`, `v2-web`, and `v2-e2e`;
  V2 imports contracts only as `@mesh/v2-contracts`.
- V2 must not import `@mesh-session-platform/contracts` or any file beneath
  `apps/server`, `apps/web`, or `e2e`. V1 must not import V2 code.
- V1 ports remain `3737` and `4200`. V2 server/web development ports default to
  `3838` and `4300`; only the test-only built-server fixture may request server
  port `0`. V2 reads only `MESH_V2_*` settings and defaults to
  `.mesh/v2/mesh-v2.sqlite` under the operator home directory.
- SQLite application ID is exactly `1297494528`; the migration ledger is
  `v2_schema_migrations`; a non-empty database without that identity is rejected
  before mutation.
- Protocol version is exactly `mesh.v2/1`; profile API version is exactly
  `mesh.dev/v1alpha1`; the only M1 assignment kind is `foundation-check`; the
  only adapter registered by normal M1 code is `fake`.
- Project profile extension is one pinned approved global revision at most.
  Missing child fields inherit, present fields replace, and child instructions
  append after `Project specialization:`. Arrays never union implicitly.
- Preferred unavailable skills use `mesh.foundation-check/v1`; required
  unavailable skills create `required_skill_unavailable` and must not call the
  adapter start method. Missing `requiredCapabilities` create
  `required_capability_unavailable` before operation intent or adapter start.
- Raw harness input and required diagnostics commit before normalized runtime or
  lifecycle publication. Any failed audit write rolls back, trips the mutation
  barrier, stops event consumption, interrupts best-effort, closes the affected
  owned session, and publishes nothing.
- Execution completion comes only from normalized runtime event
  `worker_execution.completed` at fake cursor 6. The runtime never interprets
  raw adapter data or iterator exhaustion as completion.
- An accepted start or interrupt command, correlated pending operation,
  `starting` or `interrupting` execution, and immutable command result commit
  before the matching adapter call. Idempotency is rechecked inside
  `BEGIN IMMEDIATE`; same-key replays return that result and never act again.
- No M1 type, table, command, route, component, or copy may introduce
  `PlanningCycle`, Requirement Ledger records, milestones, tasks, attempts,
  runs, scheduling, QA, evidence verdicts, integration authority, worktree
  allocation, provider session IDs, or real harness startup.
- All normal tests use temporary Git repositories, temporary V2 databases,
  fake harnesses, and loopback ports. No verification command may invoke Codex,
  Claude Code, an SDK query, or a paid API.
- The root `verify` script runs both `e2e` and `v2-e2e` with Chromium and keeps
  `external-smoke` excluded. The V2 stop-condition browser uses one built server
  origin; it never starts Vite beside the server.
- Every behavior change follows red-green-refactor. Before each commit, run the
  task's complete focused gate and `git diff --check`.

---

## Settled Interface Map

Task T01 owns all cross-process contracts. Later tasks consume these names
without changing their signatures:

```ts
export const V2_PROTOCOL_VERSION = 'mesh.v2/1' as const;
export const WORKER_PROFILE_API_VERSION = 'mesh.dev/v1alpha1' as const;

export type V2CommandEnvelope = {
  idempotencyKey: string;
  actor: { kind: 'human' };
  command: V2Command;
};

export type V2Command =
  | { type: 'project.register'; repositoryPath: string; displayName?: string }
  | {
      type: 'worker_profile.approve_revision';
      scope: 'global' | 'project';
      projectId?: string;
      sourceYaml: string;
      expectedLatestRevision: number;
    }
  | {
      type: 'worker_execution.start';
      projectId: string;
      profileId: string;
      profileRevision: number;
      assignment: FoundationCheckAssignment;
    }
  | {
      type: 'worker_execution.interrupt';
      projectId: string;
      executionId: string;
      expectedRevision: number;
    };

export interface HarnessAdapter {
  readonly id: string;
  capabilities(): Promise<HarnessCapabilities>;
  resolveSkills(
    requests: readonly LogicalSkillRequest[],
  ): Promise<readonly HarnessSkillDescriptor[]>;
  start(request: HarnessStartRequest): Promise<HarnessSession>;
  probe(nativeHandle: string): Promise<HarnessProbeResult>;
  resume(request: HarnessResumeRequest): Promise<HarnessSession>;
  interrupt(nativeHandle: string): Promise<HarnessOperationResult>;
}

export interface HarnessSession {
  readonly nativeHandle: string;
  events(afterAdapterCursor: number): AsyncIterable<HarnessEventEnvelope>;
  close(): Promise<void>;
}

export type ProjectRegisterEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'project.register' }>;
};
export type ProfileApprovalEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'worker_profile.approve_revision' }>;
};
export type StartExecutionEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'worker_execution.start' }>;
};
export type InterruptExecutionEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'worker_execution.interrupt' }>;
};

export type HarnessCapabilities = {
  adapterId: string;
  capabilities: readonly string[];
  skills: readonly HarnessSkillDescriptor[];
  exactResume: boolean;
};
export type HarnessStartRequest = {
  executionId: string;
  project: Project;
  assignment: FoundationCheckAssignment;
  profile: ResolvedWorkerProfileSnapshot;
  resolvedSkills: readonly ResolvedSkillSnapshot[];
};
export type HarnessResumeRequest = HarnessStartRequest & {
  nativeHandle: string;
  afterAdapterCursor: number;
};
export type HarnessProbeResult =
  | { status: 'resumable'; afterAdapterCursor: number }
  | { status: 'terminal'; outcome: 'completed' | 'failed' | 'interrupted' }
  | { status: 'missing' | 'unknown'; reason: string };
export type HarnessOperationResult = {
  status: 'succeeded' | 'already_terminal' | 'unknown';
  reason?: string;
};

export type DomainEventDraft = Omit<DomainEvent, 'id' | 'sequence'>;
export type RawDiagnosticDraft = Omit<RawDiagnostic, 'id'>;
export type RuntimeEventDraft = Omit<
  RuntimeEvent,
  'id' | 'sequence' | 'diagnosticId'
>;
export type WorkerExecutionCompletedRuntimeEventDraft = Extract<
  RuntimeEventDraft,
  { type: 'worker_execution.completed' }
>;
export type ExecutionFailure = {
  code: V2ErrorCode;
  message: string;
  missing?: readonly string[];
};
export type RetainedDomainWindow = {
  lowWater: number;
  highWater: number;
  events: readonly DomainEvent[];
};
export type RetainedRuntimeWindow = {
  lowWater: number;
  highWater: number;
  events: readonly RuntimeEvent[];
};
```

Server-internal database interfaces settle in T02:

```ts
export type V2Database = import('better-sqlite3').Database;
export const openV2Database: (path: string) => V2Database;
export const migrateV2Database: (database: V2Database) => void;
export const inImmediateTransaction: <T>(
  database: V2Database,
  work: () => T,
) => T;

export class V2EventStore {
  appendDomainInTransaction(projectId: string, draft: DomainEventDraft): DomainEvent;
  appendRawDiagnosticInTransaction(diagnostic: RawDiagnosticDraft): RawDiagnostic;
  appendRuntimeWithDiagnosticInTransaction(
    projectId: string,
    diagnostic: RawDiagnosticDraft,
    draft: RuntimeEventDraft,
  ): RuntimeEvent;
  domainAfter(projectId: string, sequence: number): RetainedDomainWindow;
  runtimeAfter(projectId: string, sequence: number): RetainedRuntimeWindow;
  cursors(projectId: string): ProjectEventCursors;
}

export class V2CommandRepository {
  find(idempotencyKey: string): StoredCommandResult | undefined;
  storeInTransaction(result: StoredCommandResult): void;
}
```

## Dependency Waves and Ownership Audit

| Wave | Tasks | Why ready | Non-overlap proof | Gate |
| --- | --- | --- | --- | --- |
| 0 | T01 | No implementation dependency | Sole owner of root dependency/path edits, V2 project scaffolds, and all `packages/v2-contracts/**` | Contract tests, scaffold typechecks/builds |
| 1 | T02, T03 | T01 contracts accepted | T02 owns only `apps/v2-server/src/db`, `storage`, and test DB helper; T03 owns only `apps/v2-web/src/components`, component tests, and shell CSS | Source/production-output database tests plus presentational UI tests |
| C | T01C, T02C | Whole-wave pause proved two settled interfaces incomplete | T01C owns only `packages/v2-contracts/**`; T02C owns only the existing event-store source/test | Contract and event-store correction gates |
| 2R | T06, T07 | T01C/T02C accepted and integrated; both tasks restart from that corrected head | Separate server `executions` and web `api`/`state` directories | Restarted T06/T07 focused suites and typechecks |
| 2I | Preserve T04, T05; integrate T06, T07 | Exact accepted T04/T05 patches do not consume corrected event/failure/store interfaces | Deterministic application of unchanged accepted patches; no worker edits in integration | Complete combined Wave 2 suite/typecheck/build gate |
| 3 | T08 | Project, profile, execution services accepted | Sole owner of V2 server config, platform process/path boundary, HTTP, realtime, app, main, and server integration tests | V2 server tests including both replay interleavings, typecheck, and build |
| 4 | T09 | Presentational shell, web projection, and server protocol accepted | Sole owner of V2 web app/main and integrated UI tests | V2 web test/typecheck/build |
| 5 | T10 | Integrated V2 apps accepted | Sole owner of `e2e-v2/**` | Same-origin built-server Todo restart e2e |
| 6 | T11 | T10 executable commands and evidence accepted | Sole owner of named development docs | Documentation formatting and jDocMunch link checks |

No two tasks in one wave own the same file or interface. If a worker discovers
that it must change a T01 contract or T02 table, the affected wave stops and the
coordinator issues a serialized contract/schema correction before resuming.

## Required TASK HANDOFF

Every worker returns this exact field set. Values must describe repository
evidence; a narrative success claim is insufficient.

```ts
type TaskHandoff = {
  heading: 'TASK HANDOFF';
  task: 'T01' | 'T01C' | 'T02' | 'T02C' | 'T03' | 'T04' | 'T05' | 'T06' | 'T07' | 'T08' | 'T09' | 'T10' | 'T11';
  status: 'ready_for_review' | 'blocked';
  branch: string;
  commit: string | 'none';
  base: string;
  outcome: string;
  changedSurfaces: readonly { path: string; purpose: string }[];
  acceptanceEvidence: readonly { criterion: string; evidence: string }[];
  verification: readonly { command: string; result: string }[];
  unverified: readonly string[] | ['none'];
  risksOrDecisions: readonly string[] | ['none'];
  reviewFocus: readonly string[];
};
```

The coordinator verifies base, exact commit, changed paths, red-green evidence,
and required commands before dispatching a read-only reviewer. Every rework
commit receives a fresh review. Only accepted commits enter the deterministic
integration order listed after each wave.

### Task T01: V2 Workspace Scaffolds and Shared Contracts

**Wave:** 0

**Outcome:** Create independently named V2 Nx projects and the complete M1 wire
contract, without adding behavior to either V1 application.

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.base.json`
- Create: `packages/v2-contracts/project.json`
- Create: `packages/v2-contracts/tsconfig.json`
- Create: `packages/v2-contracts/tsconfig.lib.json`
- Create: `packages/v2-contracts/tsconfig.spec.json`
- Create: `packages/v2-contracts/vitest.config.ts`
- Create: `packages/v2-contracts/eslint.config.mjs`
- Create: `packages/v2-contracts/src/ids.ts`
- Create: `packages/v2-contracts/src/projects.ts`
- Create: `packages/v2-contracts/src/profiles.ts`
- Create: `packages/v2-contracts/src/executions.ts`
- Create: `packages/v2-contracts/src/events.ts`
- Create: `packages/v2-contracts/src/commands.ts`
- Create: `packages/v2-contracts/src/http.ts`
- Create: `packages/v2-contracts/src/realtime.ts`
- Create: `packages/v2-contracts/src/index.ts`
- Create: `packages/v2-contracts/src/contracts.spec.ts`
- Create: `apps/v2-server/project.json`
- Create: `apps/v2-server/tsconfig.json`
- Create: `apps/v2-server/tsconfig.app.json`
- Create: `apps/v2-server/tsconfig.spec.json`
- Create: `apps/v2-server/vitest.config.ts`
- Create: `apps/v2-server/src/main.ts`
- Create: `apps/v2-web/project.json`
- Create: `apps/v2-web/tsconfig.json`
- Create: `apps/v2-web/tsconfig.app.json`
- Create: `apps/v2-web/tsconfig.spec.json`
- Create: `apps/v2-web/vite.config.ts`
- Create: `apps/v2-web/index.html`
- Create: `apps/v2-web/src/main.tsx`
- Create: `apps/v2-web/src/test/setup.ts`
- Create: `apps/v2-web/src/vite-env.d.ts`

**Owned surfaces:** The files above only.

**Prohibited surfaces:** All V1 source/tests; V2 database, domain, HTTP,
realtime, UI components, and e2e behavior.

**Interfaces produced:** Every schema/type in the Settled Interface Map plus
`Project`, `WorkerProfileDocument`, `WorkerProfileRevision`,
`ResolvedWorkerProfileSnapshot`, `WorkerExecution`, `FoundationCheckAssignment`,
`HarnessCapabilities`, `HarnessSkillDescriptor`, `ResolvedSkillSnapshot`,
`DomainEvent`, `RuntimeEvent`, `RawDiagnostic`, `V2SystemSnapshot`,
`V2ProjectSnapshot`, `V2CommandResult`, `ClientRealtimeMessage`, and
`ServerRealtimeMessage`. Export both each Zod schema and its inferred type.
The closed V2 error-code schema includes
`required_capability_unavailable`, `repository_head_unborn`,
`repository_head_failed`, and `repository_head_ambiguous` for the owning
services below; later tasks may not add these as ad hoc strings.

- [ ] **Step 1: Add failing contract tests**

Test exact literals, strict unknown-key rejection, profile shorthand
normalization, command discriminants, required/fallback skill snapshots,
provider-shape rejection, event stream distinction, and snapshot round trips.

```ts
it('rejects provider-native state and normalizes skill shorthand', () => {
  const profile = workerProfileDocumentSchema.parse({
    apiVersion: 'mesh.dev/v1alpha1',
    kind: 'WorkerProfile',
    metadata: {
      name: 'foundation-worker',
      displayName: 'Foundation worker',
      scope: 'global',
    },
    spec: {
      assignmentKinds: ['foundation-check'],
      preferredRuntime: { harness: 'fake', model: 'deterministic' },
      alternatives: [],
      requiredCapabilities: ['execution.stream'],
      skills: {
        preferred: ['test-driven-development'],
        required: ['verification-before-completion'],
      },
      instructions: 'Inspect the repository without writing it.',
      outputSchema: 'mesh.dev/foundation-report/v1',
    },
  });
  expect(profile.spec.skills.preferred).toEqual([
    { id: 'test-driven-development' },
  ]);
  expect(() =>
    workerExecutionSchema.parse({
      id: crypto.randomUUID(),
      providerSessionId: 'claude-session-1',
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the test and observe red**

```powershell
corepack pnpm exec vitest run packages/v2-contracts/src/contracts.spec.ts --config packages/v2-contracts/vitest.config.ts
```

Expected: failure because the V2 schemas and project do not exist.

- [ ] **Step 3: Implement the strict contracts and scaffolds**

Add `yaml: ^2.9.0`, add the `@mesh/v2-contracts` TypeScript path, mirror only
the repository's Nx configuration conventions, and keep stub entrypoints inert:

```ts
// apps/v2-server/src/main.ts
export const V2_SERVER_NOT_COMPOSED = true as const;

// apps/v2-web/src/main.tsx
export const V2_WEB_NOT_COMPOSED = true as const;
```

T01 is the sole owner of `apps/v2-server/project.json`, so it must reserve the
production database entrypoint and migration assets that T02 will supply:

```json
{
  "targets": {
    "build": {
      "options": {
        "additionalEntryPoints": ["apps/v2-server/src/db/database.ts"],
        "assets": [
          {
            "input": "apps/v2-server/src/db/migrations",
            "glob": "**/*.sql",
            "output": "db/migrations"
          },
          {
            "input": "apps/v2-server/src/db/migrations",
            "glob": "**/*.sql",
            "output": "apps/v2-server/src/db/migrations"
          }
        ]
      }
    }
  }
}
```

The production build must therefore emit
`apps/v2-server/src/db/database.js` and both supported migration asset layouts,
including `apps/v2-server/src/db/migrations/001_foundation.sql`, beneath a
custom output root once T02 lands. This mirrors the repository's proven
source-relative production migration lookup without importing V1 code.
T01 also changes the root verification script exactly to keep both acceptance
suites in the normal fake-only gate:

```json
{
  "verify": "nx format:check && nx run-many -t lint typecheck test build --exclude=external-smoke && nx e2e e2e --project=chromium && nx e2e v2-e2e --project=chromium"
}
```

The `v2-e2e` project arrives in T10, so Waves 0-4 use their listed wave gates;
from Wave 5 onward `corepack pnpm verify` is the complete repository gate.

Use `z.strictObject`, UUID IDs, ISO timestamp validation, non-negative integer
revisions/cursors, lowercase logical IDs, and discriminated unions. Do not use
`z.unknown()` for authoritative payloads; raw diagnostics alone may carry
unknown JSON.

- [ ] **Step 4: Run the complete T01 gate**

```powershell
corepack pnpm exec vitest run packages/v2-contracts/src/contracts.spec.ts --config packages/v2-contracts/vitest.config.ts
corepack pnpm nx typecheck v2-contracts
corepack pnpm nx typecheck v2-server
corepack pnpm nx typecheck v2-web
corepack pnpm nx build v2-contracts
node -e "const s=require('./package.json').scripts.verify;if(!s.includes('nx e2e e2e --project=chromium')||!s.includes('nx e2e v2-e2e --project=chromium')||!s.includes('--exclude=external-smoke'))process.exit(1)"
git diff --check
```

Expected: all commands exit zero; the contract test reports no failures.

- [ ] **Step 5: Commit**

```powershell
git add package.json pnpm-lock.yaml tsconfig.base.json packages/v2-contracts apps/v2-server apps/v2-web
git commit -m "feat(v2): establish foundation contracts"
```

**Acceptance criteria:** All named contracts parse valid examples and reject
wrong scope, unknown fields, duplicate skill requests, invalid lifecycle values,
provider-native fields, and missing-capability failure codes; Nx sees three
distinct V2 projects; the server build contract includes the T02 database entry
and SQL assets; the root verifier names both e2e targets and excludes
`external-smoke`; V1 files are unchanged.

### Task T02: V2 Database Identity, Schema, Commands, and Event Stores

**Wave:** 1

**Outcome:** Establish the complete M1 database contract, safe open/migration,
atomic command results, and independent project domain/runtime ordering.

**Files:**

- Create: `apps/v2-server/src/db/database.ts`
- Create: `apps/v2-server/src/db/migrate.ts`
- Create: `apps/v2-server/src/db/migrations/001_foundation.sql`
- Create: `apps/v2-server/src/db/database.spec.ts`
- Create: `apps/v2-server/src/db/database.production.spec.ts`
- Create: `apps/v2-server/src/storage/command-repository.ts`
- Create: `apps/v2-server/src/storage/event-store.ts`
- Create: `apps/v2-server/src/storage/event-store.spec.ts`
- Create: `apps/v2-server/src/test/create-v2-test-database.ts`

**Owned surfaces:** `apps/v2-server/src/db/**`,
`apps/v2-server/src/storage/**`, and the named test helper.

**Prohibited surfaces:** Contracts, project/profile/execution services,
transport, web, V1 files, and any migration after `001_foundation.sql`.

**Interfaces consumed:** T01 event, diagnostic, cursor, command-result, project,
profile, and execution schemas.

**Interfaces produced:** The settled `V2Database`, migration, transaction,
`V2EventStore`, and `V2CommandRepository` signatures. Migration 001 must create
all tables and constraints named in the design, including columns later tasks
consume; later Wave 2 tasks may not alter it.

- [ ] **Step 1: Write failing database identity and ordering tests**

```ts
it('rejects a non-empty unmarked database without changing it', () => {
  const path = join(directory, 'unknown.sqlite');
  const foreign = new BetterSqlite3(path);
  foreign.exec('CREATE TABLE v1_sessions (id TEXT PRIMARY KEY)');
  foreign.close();
  const before = readFileSync(path);
  expect(() => openV2Database(path)).toThrowError(
    expect.objectContaining({ code: 'database_identity_mismatch' }),
  );
  expect(readFileSync(path)).toEqual(before);
});

it('orders domain and runtime streams independently', () => {
  const { database, events, project } = createV2TestDatabase();
  const domain = inImmediateTransaction(database, () =>
    events.appendDomainInTransaction(project.id, domainDraft),
  );
  const runtime = inImmediateTransaction(database, () =>
    events.appendRuntimeWithDiagnosticInTransaction(
      project.id,
      diagnosticDraft,
      runtimeDraft,
    ),
  );
  expect([domain.sequence, runtime.sequence]).toEqual([1, 1]);
});
```

Add a production-output test owned by T02. Its `beforeAll` uses the repository's
proven shell-free `corepack pnpm nx build` test helper pattern to build
`v2-server --configuration=production --skip-nx-cache` into a unique temporary
output beneath the worktree, after removing inherited `NX_*` task variables.
This makes the proof run under `nx test v2-server` and the root verifier without
depending on a pre-existing `dist`. Import the emitted `database.js`, prove the
SQL asset is present, and open a fresh database through that built module rather
than through TypeScript source:

```ts
beforeAll(() => runProductionV2Build(workspaceRoot, builtRoot));

it('opens a fresh V2 database from the production build', async () => {
  const builtDatabase = join(builtRoot, 'apps/v2-server/src/db/database.js');
  const builtMigration = join(
    builtRoot,
    'apps/v2-server/src/db/migrations/001_foundation.sql',
  );
  expect(existsSync(builtMigration)).toBe(true);
  const built = createRequire(__filename)(builtDatabase);
  const database = built.openV2Database(join(directory, 'built.sqlite'));
  expect(database.pragma('application_id', { simple: true })).toBe(1_297_494_528);
  expect(
    database.prepare("SELECT name FROM sqlite_schema WHERE name = 'worker_executions'").get(),
  ).toBeDefined();
  database.close();
});
```

- [ ] **Step 2: Run red**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/storage/event-store.spec.ts --config apps/v2-server/vitest.config.ts
corepack pnpm exec vitest run apps/v2-server/src/db/database.production.spec.ts --config apps/v2-server/vitest.config.ts
```

Expected: failure because database/storage modules and the packaged migration do
not exist.

- [ ] **Step 3: Implement identity and migration**

`openV2Database` first inspects `PRAGMA application_id` and
`sqlite_schema`. Claim only an empty database. Apply migration and application
ID in one immediate transaction, then enable the standard pragmas.

```ts
export const V2_APPLICATION_ID = 1_297_494_528;

export const openV2Database = (path: string): V2Database => {
  const database = new BetterSqlite3(path);
  assertV2OrEmpty(database);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  migrateV2Database(database);
  return database;
};
```

Migration 001 includes the exact tables, foreign keys, checks, and uniqueness
from the design. Store snapshots as canonical JSON and expose mapping functions
that parse every row through T01 schemas.

- [ ] **Step 4: Implement command idempotency and atomic event append**

Hash canonical command JSON with SHA-256. `find` returns the stored result only
when hashes match; mismatch raises `idempotency_conflict`. Require an active
transaction for `storeInTransaction` and event append methods.

```ts
appendRuntimeWithDiagnosticInTransaction(
  projectId: string,
  diagnostic: RawDiagnosticDraft,
  draft: RuntimeEventDraft,
): RuntimeEvent {
  assertActiveTransaction(this.database);
  const storedDiagnostic = this.insertDiagnostic(projectId, diagnostic);
  return this.insertRuntime(projectId, storedDiagnostic.id, draft);
}
```

- [ ] **Step 5: Run the T02 gate**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/storage --config apps/v2-server/vitest.config.ts
corepack pnpm exec vitest run apps/v2-server/src/db/database.production.spec.ts --config apps/v2-server/vitest.config.ts
corepack pnpm nx typecheck v2-server
corepack pnpm nx build v2-server --configuration=production --skip-nx-cache
git diff --check
```

Expected: fresh/reopen/mismatch/rollback/ordering/idempotency tests pass and all
commands exit zero.

- [ ] **Step 6: Commit**

```powershell
git add apps/v2-server/src/db apps/v2-server/src/storage apps/v2-server/src/test/create-v2-test-database.ts
git commit -m "feat(v2): add isolated foundation datastore"
```

**Acceptance criteria:** Both fresh and existing V2 databases open; non-empty
unknown databases retain their byte hash on rejection; all M1 tables exist;
transactions roll back completely; stream sequences are gap-free per project
and kind; raw diagnostic insert failure creates no runtime event; the production
build packages migration 001 and its emitted database entrypoint opens a fresh
identified database.

### Task T03: Presentational Project Selector and Focused Shell

**Wave:** 1

**Outcome:** Build testable UI components for every M1 shell state without
network or server composition.

**Files:**

- Create: `apps/v2-web/src/components/ProjectSelector.tsx`
- Create: `apps/v2-web/src/components/ProjectSelector.spec.tsx`
- Create: `apps/v2-web/src/components/FocusedProjectShell.tsx`
- Create: `apps/v2-web/src/components/FocusedProjectShell.spec.tsx`
- Create: `apps/v2-web/src/components/ExecutionActivity.tsx`
- Create: `apps/v2-web/src/components/ExecutionActivity.spec.tsx`
- Create: `apps/v2-web/src/components/shell-state.ts`
- Create: `apps/v2-web/src/styles.css`

**Owned surfaces:** `apps/v2-web/src/components/**` and
`apps/v2-web/src/styles.css`.

**Prohibited surfaces:** `apps/v2-web/src/api`, `state`, `app`, `main.tsx`,
server, contracts, e2e, and V1 web files.

**Interfaces consumed:** T01 snapshots, project, profile, execution, skill, and
event types.

**Interface produced:**

```ts
export type SelectorViewModel =
  | { status: 'loading' }
  | { status: 'disconnected'; message: string }
  | { status: 'ready'; snapshot: V2SystemSnapshot; submitting: boolean }
  | { status: 'error'; snapshot?: V2SystemSnapshot; message: string };

export type ProjectShellViewModel =
  | { status: 'loading'; projectId: string }
  | { status: 'stale'; snapshot: V2ProjectSnapshot; message: string }
  | { status: 'disconnected'; snapshot?: V2ProjectSnapshot; message: string }
  | { status: 'ready'; snapshot: V2ProjectSnapshot };
```

- [ ] **Step 1: Write failing component tests**

```tsx
it('shows honest future panes and disables mutation while stale', async () => {
  render(
    <FocusedProjectShell
      model={{ status: 'stale', snapshot: projectSnapshot, message: 'Resyncing' }}
      onDeselect={vi.fn()}
      onInterrupt={vi.fn()}
    />,
  );
  expect(screen.getByText('PM Chat')).toBeVisible();
  expect(screen.getAllByText('Available in a later milestone')).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Interrupt execution' })).toBeDisabled();
});
```

Cover loading, empty project list, invalid path error, identity conflict,
disconnected, attention, running, terminal, preferred fallback, required
unavailable, child nesting, diagnostics disclosure, and deselect callbacks.

- [ ] **Step 2: Run red**

```powershell
corepack pnpm exec vitest run apps/v2-web/src/components --config apps/v2-web/vite.config.ts
```

Expected: failure because components are absent.

- [ ] **Step 3: Implement accessible presentational components**

Use labels, status regions, semantic lists, keyboard-operable tabs, and explicit
button disabled reasons. Components receive view models and callbacks only; no
fetching, socket, lifecycle inference, or future-domain command lives here.

```tsx
export function ExecutionActivity({ execution }: { execution: WorkerExecution }) {
  return (
    <article aria-labelledby={`execution-${execution.id}`}>
      <h3 id={`execution-${execution.id}`}>{execution.assignment.title}</h3>
      <p role="status">{execution.lifecycle}</p>
      <SkillResolutionList skills={execution.resolvedSkills} />
      <ChildActivityTree activities={execution.childActivities} />
    </article>
  );
}
```

- [ ] **Step 4: Run the T03 gate**

```powershell
corepack pnpm exec vitest run apps/v2-web/src/components --config apps/v2-web/vite.config.ts
corepack pnpm nx typecheck v2-web
git diff --check
```

Expected: all component tests and typecheck pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/v2-web/src/components apps/v2-web/src/styles.css
git commit -m "feat(v2): add project-focused shell views"
```

**Acceptance criteria:** Every named UI state is rendered and accessible;
future panes expose no active workflow action; provider terminology is confined
to the diagnostics disclosure; components do not perform I/O.

### Pre-resume correction protocol

The first Wave 2 review exposed an unsettled T01/T02 interface, so the whole
wave remains paused under the runbook. Preserve every existing worker branch,
worktree, and commit. Do not rebase, reset, amend, or silently copy changes from
the paused T06/T07 worktrees. The correction does not change migration 001,
`mesh.v2/1`, or `mesh.dev/v1alpha1`.

Run T01C and T02C in parallel from the exact accepted Wave 1 integration head
`b88a1a981c02002650d5a233356a00cb03fcbb79`.
Review each exact correction commit independently, then integrate T01C followed
by T02C in a dedicated correction integration worktree and run the correction
gate. That accepted correction head is the only base for fresh T06 and T07
worktrees. The original T06 result at
`98195e266cde808d92c8b8a05b0332eda85d688b` is superseded review evidence and
never enters integration. The paused T07 worktree remains at the Wave 1 head
with its untracked `apps/v2-web/src/api/**` and `apps/v2-web/src/state/**` state
preserved but not copied.

The already accepted T04 and T05 commit sets remain immutable. They do not
consume `ExecutionFailure`, runtime completion, or the standalone diagnostic
append, so their reviews remain valid. Preserve T04 as the ordered commits
`152040dedaf0e47db6ed7e5e4faaab2c8243f34f` then
`97c5bd0a687cd02f966bf02950aff1855540917f`, and T05 as
`1a1781602266bf6d7b0fd5512a0b3ec263438930`. After restarted T06 and T07 are
accepted,
the Wave 2 integrator starts from the correction head and applies the exact
accepted commits in order: T04, T05, restarted T06, restarted T07. A conflict,
changed T04/T05 patch ID, newly discovered dependency on a corrected interface,
or failed combined gate stops integration and returns the affected task to a
fresh worker/reviewer; the integrator never resolves a semantic conflict.

### Task T01C: Completion and Failure Contract Correction

**Wave:** C

**Outcome:** Add the normalized execution-completion runtime event and bounded
structured missing-item evidence without adding another lifecycle domain event.

**Files:**

- Modify: `packages/v2-contracts/src/executions.ts`
- Modify: `packages/v2-contracts/src/events.ts`
- Modify: `packages/v2-contracts/src/contracts.spec.ts`

**Owned surfaces:** The three files above only.

**Prohibited surfaces:** Every server/web implementation, migration/schema,
root configuration, V1 contract, and new domain-event discriminant.

**Interfaces consumed:** Accepted T01 execution/event schemas and V2 error
codes.

**Interfaces produced:**

```ts
export const executionFailureSchema = z.strictObject({
  code: v2ErrorCodeSchema,
  message: z.string().trim().min(1).max(4096),
  missing: z
    .array(z.string().trim().min(1).max(256))
    .min(1)
    .max(64)
    .readonly()
    .optional(),
});

export const executionCompletedDraftSchema = z.strictObject({
  ...runtimeEventBase,
  type: z.literal('worker_execution.completed'),
  payload: z.strictObject({ outcome: z.literal('completed') }),
});
```

Add `executionCompletedDraftSchema` to both `runtimeEventDraftSchema` and the
persisted `runtimeEventSchema` construction. Keep
`domainEventDraftSchema` unchanged with its single execution lifecycle variant
`worker_execution.lifecycle_changed`.

- [ ] **Step 1: Write failing contract tests**

```ts
it('parses normalized completion and bounded missing evidence', () => {
  expect(runtimeEventDraftSchema.parse({
    ...runtimeBase,
    adapterCursor: 6,
    type: 'worker_execution.completed',
    payload: { outcome: 'completed' },
  }).type).toBe('worker_execution.completed');
  expect(executionFailureSchema.parse({
    code: 'required_capability_unavailable',
    message: 'Required capabilities are unavailable',
    missing: ['execution.stream'],
  }).missing).toEqual(['execution.stream']);
});

it('keeps one lifecycle domain event and bounds missing evidence', () => {
  expect(() => executionFailureSchema.parse({
    code: 'required_skill_unavailable',
    message: 'Unavailable',
    missing: Array.from({ length: 65 }, (_, index) => `skill-${index}`),
  })).toThrow();
  expect(() => domainEventDraftSchema.parse({
    projectId,
    occurredAt: now,
    type: 'worker_execution.failed',
    payload: { execution },
  })).toThrow();
});
```

Also round-trip the cursor-6 draft through `runtimeEventSchema` with IDs,
sequence, and diagnostic ID; reject unknown completion payload keys, an empty
`missing` list, and a 257-character missing item.

- [ ] **Step 2: Run red**

```powershell
corepack pnpm exec vitest run packages/v2-contracts/src/contracts.spec.ts --config packages/v2-contracts/vitest.config.ts
```

Expected: completion is not in the union and `missing` is rejected.

- [ ] **Step 3: Implement only the corrected schemas**

Export the two schemas and inferred types through the existing module exports.
Do not loosen any base object, add `z.unknown()`, or add
`worker_execution.failed` to the domain union.

- [ ] **Step 4: Run the T01C gate**

```powershell
corepack pnpm nx test v2-contracts
corepack pnpm nx typecheck v2-contracts
corepack pnpm nx build v2-contracts
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add packages/v2-contracts/src/executions.ts packages/v2-contracts/src/events.ts packages/v2-contracts/src/contracts.spec.ts
git commit -m "fix(v2): normalize execution completion"
```

**Acceptance criteria:** Cursor-6 completion is a strict runtime draft and
persisted event; failure `missing` evidence is optional but bounded; the only
execution lifecycle domain event remains `worker_execution.lifecycle_changed`;
V1/provider shapes remain rejected.

### Task T02C: Transactional Raw Diagnostic Append

**Wave:** C

**Outcome:** Let reconciliation audit an adapter probe or interrupt result in
the same transaction as operation, lifecycle, and domain changes, using the
existing schema.

**Files:**

- Modify: `apps/v2-server/src/storage/event-store.ts`
- Modify: `apps/v2-server/src/storage/event-store.spec.ts`

**Owned surfaces:** The two files above only.

**Prohibited surfaces:** `db/**`, migration 001, contracts, executions,
transport, web, V1 storage, and any new table or column.

**Interfaces consumed:** T01 `RawDiagnosticDraft` and `RawDiagnostic`; accepted
T02 transaction and canonical-JSON helpers.

**Interface produced:**

```ts
export class V2EventStore {
  appendRawDiagnosticInTransaction(
    diagnostic: RawDiagnosticDraft,
  ): RawDiagnostic;
}
```

The method requires the caller's existing immediate transaction, inserts one
row into `raw_diagnostics`, canonicalizes the unknown payload with the existing
helper, and returns the parsed stored record. It does not advance either event
stream and does not open or commit its own transaction.

- [ ] **Step 1: Write failing storage tests**

```ts
it('appends a standalone reconciliation diagnostic without advancing cursors', () => {
  const before = fixture.events.cursors(fixture.project.id);
  const stored = inImmediateTransaction(fixture.database, () =>
    fixture.events.appendRawDiagnosticInTransaction({
      projectId: fixture.project.id,
      executionId: fixture.execution.id,
      adapterId: 'fake',
      adapterCursor: null,
      receivedAt: now,
      payload: { operation: 'probe', result: { status: 'resumable', afterAdapterCursor: 2 } },
    }),
  );
  expect(stored.payload).toMatchObject({ operation: 'probe' });
  expect(fixture.events.cursors(fixture.project.id)).toEqual(before);
});
```

Add a rollback test that appends the diagnostic and then throws inside the same
`inImmediateTransaction`; assert the raw row count and both cursors equal their
pre-transaction values.

- [ ] **Step 2: Run red**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/storage/event-store.spec.ts --config apps/v2-server/vitest.config.ts
```

- [ ] **Step 3: Extract the existing raw insert as the public transaction helper**

Make `appendRuntimeWithDiagnosticInTransaction` call the new helper so there is
one raw-diagnostic insertion path. Preserve its existing runtime insert,
execution cursor update, sequence allocation, and rollback behavior exactly.

- [ ] **Step 4: Run the T02C gate**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/storage/event-store.spec.ts --config apps/v2-server/vitest.config.ts
corepack pnpm nx test v2-server
corepack pnpm nx typecheck v2-server
corepack pnpm nx build v2-server
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add apps/v2-server/src/storage/event-store.ts apps/v2-server/src/storage/event-store.spec.ts
git commit -m "fix(v2): expose transactional diagnostic append"
```

**Acceptance criteria:** Standalone diagnostics use migration 001 unchanged,
rollback with the caller's transaction, leave stream cursors unchanged, and
share the exact insert path used by runtime events.

### Task T04: Project Registry and Repository Identity

**Wave:** 2

**Outcome:** Register one path-safe Git project with durable identity,
idempotency, revisions, and domain events.

**Files:**

- Create: `apps/v2-server/src/projects/repository-identity.ts`
- Create: `apps/v2-server/src/projects/repository-identity.spec.ts`
- Create: `apps/v2-server/src/projects/project-repository.ts`
- Create: `apps/v2-server/src/projects/project-service.ts`
- Create: `apps/v2-server/src/projects/project-service.spec.ts`

**Owned surfaces:** `apps/v2-server/src/projects/**`.

**Prohibited surfaces:** Migration/schema, profiles, executions, transport,
web, contracts, V1 project code, filesystem mutation, and repository discovery.

**Interfaces consumed:** T01 `Project`, command/result, error, and domain-event
contracts; T02 database, transaction, command repository, and event store.

**Interface produced:**

```ts
export type RepositoryIdentity = {
  canonicalPath: string;
  commonDirectory: string;
  repositoryIdentity: string;
  headCommit: string;
};

export type ResolveRepositoryIdentity = (
  repositoryPath: string,
) => Promise<RepositoryIdentity>;

export class ProjectService {
  register(envelope: ProjectRegisterEnvelope): Promise<V2CommandResult>;
  list(): Project[];
  get(projectId: string): Project | undefined;
}

export class ProjectRepository {
  list(): Project[];
  get(projectId: string): Project | undefined;
  getByRepositoryIdentity(repositoryIdentity: string): Project | undefined;
  insertInTransaction(project: Project): void;
}
```

- [ ] **Step 1: Write failing path and service tests**

```ts
it('does not silently rebind an existing repository identity', async () => {
  const first = await service.register(registerCommand(firstWorktree));
  await expect(service.register(registerCommand(linkedWorktree))).resolves.toMatchObject({
    ok: false,
    error: { code: 'repository_identity_conflict' },
  });
  expect(projects.get(first.value.project.id)?.repositoryPath).toBe(firstWorktree);
});
```

Use temporary Git repositories to cover canonical root, common directory,
Windows case normalization, non-repository, boundary escape, duplicate same
command, same request with a second idempotency key, and conflicting input under
one key. Use a committed temporary repository for the valid HEAD case, an
initialized repository with no commit for the unborn case, and the injected
process runner for failed and ambiguous results:

```ts
it('classifies an actual git init repository with no commit as unborn', async () => {
  const unbornRepository = await createTemporaryGitRepository({ commit: false });
  await expect(resolveRepositoryIdentity(unbornRepository)).rejects.toMatchObject({
    code: 'repository_head_unborn',
  });
  expect(projects.list()).toEqual([]);
  expect(processRunner.injectedHeadOutcomes).toEqual([]);
});

it.each([
  ['spawn_failure', 'repository_head_failed'],
  ['timeout', 'repository_head_failed'],
  ['nonzero_failure', 'repository_head_failed'],
  ['git_ambiguity', 'repository_head_ambiguous'],
  ['multiple_success_lines', 'repository_head_ambiguous'],
  ['invalid_success_oid', 'repository_head_ambiguous'],
] as const)('rejects injected %s HEAD evidence without storing a project', async (
  outcome,
  code,
) => {
  processRunner.headOutcome = outcome;
  await expect(resolveRepositoryIdentity(repository)).rejects.toMatchObject({ code });
  expect(projects.list()).toEqual([]);
});

it('stores the separately verified commit object ID', async () => {
  const identity = await resolveRepositoryIdentity(committedRepository);
  expect(identity.headCommit).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
  expect(processRunner.calls.at(-1)?.args).toEqual([
    '-c', 'credential.interactive=false', '-C', identity.canonicalPath,
    'rev-parse', '--verify', 'HEAD^{commit}',
  ]);
});
```

- [ ] **Step 2: Run red**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/projects --config apps/v2-server/vitest.config.ts
```

Expected: module-not-found failures.

- [ ] **Step 3: Implement read-only identity and transactional registration**

Run Git without a shell and with `credential.interactive=false`. Require the
resolved top-level and common directory to stay within the configured V2
workspace root. Normalize Windows identity comparisons with case folding while
preserving the canonical display path.

```ts
const result = await processRunner.run(
  gitExecutable,
  ['-c', 'credential.interactive=false', '-C', canonicalPath,
   'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
  { cwd: canonicalPath },
);

const head = await processRunner.run(
  gitExecutable,
  ['-c', 'credential.interactive=false', '-C', canonicalPath,
   'rev-parse', '--verify', 'HEAD^{commit}'],
  { cwd: canonicalPath },
);
```

Do not combine the root/common-directory and HEAD queries. Accept exactly one
trimmed lowercase 40- or 64-hex object ID. The unborn test must execute the real
Git binary against a fixture created by `git init` with no commit and observe
the real `rev-parse --verify HEAD^{commit}` failure; do not inject or synthesize
that classification. Reserve process-runner injection for spawn failure,
timeout, other nonzero failure, Git ambiguity, multiple successful output lines,
and an invalid successful object ID. Map those injected results to
`repository_head_failed` or `repository_head_ambiguous` as shown above. Every
case fails before the registration transaction.

Registration transaction inserts the project at revision 1, appends
`project.registered`, and stores the command result before commit. Publish is a
callback invoked only after commit.

- [ ] **Step 4: Run the T04 gate**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/projects --config apps/v2-server/vitest.config.ts
corepack pnpm nx typecheck v2-server
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add apps/v2-server/src/projects
git commit -m "feat(v2): add explicit project registry"
```

**Acceptance criteria:** All identity/path failures write nothing; successful
registration writes one project, one command result, and one ordered domain
event; duplicate identity never changes the stored path; no Git write occurs.
Valid, unborn, failed, and ambiguous HEAD outcomes have focused executable
tests; unborn proof uses a real no-commit Git repository, injected results cover
only process/ambiguity classifications, and `Project.headCommit` always comes
from the separate verified command.

### Task T05: Approved WorkerProfile Registry and Resolution

**Wave:** 2

**Outcome:** Parse strict YAML, approve immutable global/project revisions, and
produce deterministic one-level resolved snapshots.

**Files:**

- Create: `apps/v2-server/src/profiles/profile-parser.ts`
- Create: `apps/v2-server/src/profiles/profile-parser.spec.ts`
- Create: `apps/v2-server/src/profiles/profile-repository.ts`
- Create: `apps/v2-server/src/profiles/profile-service.ts`
- Create: `apps/v2-server/src/profiles/profile-service.spec.ts`

**Owned surfaces:** `apps/v2-server/src/profiles/**`.

**Prohibited surfaces:** Migration/schema, project identity, execution runtime,
transport, web, contracts, imported-skill content, credentials, and V1 files.

**Interfaces consumed:** T01 profile/skill/command/event schemas and T02
database, transactions, command repository, and event store. To preserve Wave 2
independence, this task defines and injects the project predicate below; T08
wires it to T04 after both commits are accepted.

**Interface produced:**

```ts
export const parseWorkerProfileYaml: (sourceYaml: string) => WorkerProfileDocument;
export const resolveWorkerProfileSnapshot: (
  revision: WorkerProfileRevision,
  base?: WorkerProfileRevision,
) => ResolvedWorkerProfileSnapshot;

export type ProfileProjectReader = {
  exists(projectId: string): boolean;
};

export class WorkerProfileService {
  constructor(dependencies: {
    database: V2Database;
    commands: V2CommandRepository;
    events: V2EventStore;
    projects: ProfileProjectReader;
    publishDomain: (event: DomainEvent) => void;
    now: () => string;
  });
  approveRevision(envelope: ProfileApprovalEnvelope): V2CommandResult;
  approvedGlobal(): WorkerProfileRevision[];
  approvedForProject(projectId: string): WorkerProfileRevision[];
  resolveApproved(profileId: string, revision: number): ResolvedWorkerProfileSnapshot;
}
```

- [ ] **Step 1: Write failing parser and resolution tests**

```ts
it('replaces arrays and appends specialization instructions', () => {
  const snapshot = resolveWorkerProfileSnapshot(projectRevision, globalRevision);
  expect(snapshot.effective.spec.requiredCapabilities).toEqual(['execution.resume']);
  expect(snapshot.effective.spec.instructions).toBe(
    'Base instruction.\n\nProject specialization:\nProject instruction.',
  );
  expect(snapshot.base).toEqual({ profileId: globalRevision.profileId, revision: 1 });
});
```

Cover YAML aliases disabled or bounded, unknown keys, overlong instructions,
duplicate skills, scope mismatch, stale expected revision, missing base,
project-to-project extension, base-with-extension corruption, revision
immutability, canonical digest stability, and unchanged old snapshot after base
revision 2.

- [ ] **Step 2: Run red**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/profiles --config apps/v2-server/vitest.config.ts
```

- [ ] **Step 3: Implement strict parsing, approval, and resolution**

Parse YAML to an unknown value, then use only the T01 strict schema. Reject
documents above 64 KiB before parsing and cap aliases with the YAML parser's
safe options. Project/global scope and base checks occur inside the approval
transaction.

```ts
export const canonicalProfileDigest = (
  document: WorkerProfileDocument,
): string => createHash('sha256').update(canonicalJson(document)).digest('hex');
```

The approval transaction creates or finds the stable profile identity, verifies
`expectedLatestRevision`, inserts the immutable next revision, updates the
approved pointer, and stores the idempotent result. A project-scoped approval
also appends `worker_profile.revision_approved` to its project domain stream;
a global approval is exposed by the next system snapshot because M1 has no
global event stream.

- [ ] **Step 4: Run the T05 gate**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/profiles --config apps/v2-server/vitest.config.ts
corepack pnpm nx typecheck v2-server
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add apps/v2-server/src/profiles
git commit -m "feat(v2): add approved worker profiles"
```

**Acceptance criteria:** Exact profile schema and merge rules are enforced;
only a human command approves; revisions are immutable; recursion and stale
writes are atomic failures; snapshots and digests remain stable after later
approvals.

### Task T06: Fake Harness and WorkerExecution Runtime

**Wave:** 2R (restart in a fresh worktree from the accepted correction head)

**Outcome:** Implement harness-neutral lifecycle, fake adapter conformance,
skill resolution, audit barrier, interruption, and exact restart resumption.

**Files:**

- Create: `apps/v2-server/src/executions/harness-adapter.ts`
- Create: `apps/v2-server/src/executions/fake-harness.ts`
- Create: `apps/v2-server/src/executions/fake-harness.spec.ts`
- Create: `apps/v2-server/src/executions/execution-repository.ts`
- Create: `apps/v2-server/src/executions/operation-repository.ts`
- Create: `apps/v2-server/src/executions/audit-barrier.ts`
- Create: `apps/v2-server/src/executions/execution-runtime.ts`
- Create: `apps/v2-server/src/executions/execution-runtime.spec.ts`
- Create: `apps/v2-server/src/executions/reconcile-executions.ts`
- Create: `apps/v2-server/src/executions/reconcile-executions.spec.ts`

**Owned surfaces:** `apps/v2-server/src/executions/**`.

**Prohibited surfaces:** Migration/schema, project/profile implementations,
HTTP/realtime, web, real adapter/SDK imports, child processes, worktrees, tasks,
QA, runs, and V1 runtime files.

**Interfaces consumed:** Corrected T01 adapter/execution/skill/event/command
contracts, including normalized completion and structured failure evidence, and
corrected T02 database, transaction, command, and event stores, including
`appendRawDiagnosticInTransaction`. To preserve Wave 2
independence, this task owns the two read ports below; T08 wires them to T04 and
T05 only after all three commits are accepted.

**Interfaces produced:** T01 `HarnessAdapter` implementation plus:

```ts
export class ExecutionRuntime {
  constructor(dependencies: {
    database: V2Database;
    commands: V2CommandRepository;
    events: V2EventStore;
    projects: ExecutionProjectReader;
    profiles: ExecutionProfileReader;
    executions: ExecutionRepository;
    operations: OperationRepository;
    adapter: HarnessAdapter;
    publisher: ExecutionPublisher;
    barrier: AuditBarrier;
    now: () => string;
  });
  start(envelope: StartExecutionEnvelope): Promise<V2CommandResult>;
  interrupt(envelope: InterruptExecutionEnvelope): Promise<V2CommandResult>;
  attach(executionId: string, session: HarnessSession): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export type ExecutionProjectReader = {
  get(projectId: string): Project | undefined;
};
export type ExecutionProfileReader = {
  resolveApproved(
    profileId: string,
    revision: number,
  ): ResolvedWorkerProfileSnapshot;
};
export type ExecutionPublisher = {
  domain(event: DomainEvent): void;
  runtime(event: RuntimeEvent): void;
};

export const reconcileExecutions: (dependencies: {
  executions: ExecutionRepository;
  operations: OperationRepository;
  adapter: HarnessAdapter;
  events: V2EventStore;
  barrier: AuditBarrier;
}) => Promise<ReconciliationSummary>;

export type ReconciliationSummary = {
  resumed: readonly string[];
  terminalized: readonly string[];
  attentionRequired: readonly string[];
};
```

- [ ] **Step 1: Write failing fake conformance tests**

```ts
it('resumes the Todo script from the next durable adapter cursor', async () => {
  const first = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
  const session = await first.start(startRequest);
  const firstEvents = await collectUntilHeld(session.events(0));
  expect(firstEvents.map((event) => event.adapterCursor)).toEqual([1, 2]);

  const restarted = new FakeHarnessAdapter();
  expect(await restarted.probe(session.nativeHandle)).toMatchObject({
    status: 'resumable',
    afterAdapterCursor: 2,
  });
  const resumed = await restarted.resume({ ...resumeRequest, afterAdapterCursor: 2 });
  expect((await collect(resumed.events(2)))[0].adapterCursor).toBe(3);
  await expect(
    restarted.resume({ ...resumeRequest, afterAdapterCursor: 1 }),
  ).rejects.toThrow('checkpoint');
});
```

Also cover capabilities, descriptors, nested child events, malformed envelope,
adapter failure, interrupt idempotency, `HarnessSession.close()` stopping the
iterator, no cursor duplication, an invalid/oversized handle, execution/scenario
mismatch, a missing checkpoint, unknown handle version, and a fresh adapter
object with no shared process-local record. Invalid handles return a parsed
`missing` or `unknown` probe result and cannot resume.

- [ ] **Step 2: Run fake tests red**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/executions/fake-harness.spec.ts --config apps/v2-server/vitest.config.ts
```

- [ ] **Step 3: Implement the deterministic fake and legal lifecycle**

The fixed `todo-foundation-v1` script emits adapter cursors 1 through 6:
`worker_execution.output`, `worker_execution.child_started`,
`worker_execution.output`, `worker_execution.child_finished`,
`worker_execution.output`, and `worker_execution.completed`. Cursor 6 has the
strict normalized payload `{ outcome: 'completed' }`. Native handles are
`fake:v1:<base64url-canonical-json>` inside the adapter and encode only
`{ executionId, scenario: 'todo-foundation-v1', checkpointCursor }`; enforce a
bounded encoded and decoded size. All other code treats the handle as opaque.
`probe` and `resume` parse the handle without a static/global recovery record,
and resume requires the request execution, scenario, and cursor to match it.
Constructor options inject hold, malformed event, failure, and availability.

```ts
export const legalExecutionTransitions = new Set([
  'created:starting',
  'created:failed',
  'starting:running',
  'starting:failed',
  'starting:attention_required',
  'running:completed',
  'running:failed',
  'running:interrupting',
  'running:attention_required',
  'interrupting:interrupted',
  'interrupting:failed',
  'interrupting:attention_required',
]);
```

- [ ] **Step 4: Write failing runtime/audit/skill tests**

```ts
it('durably fails a missing required capability before adapter start', async () => {
  fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
  const result = await runtime.start(requiresExecutionStreamCommand);
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'required_capability_unavailable' },
  });
  expect(executions.list(project.id)[0]).toMatchObject({
    lifecycle: 'failed',
    failure: {
      code: 'required_capability_unavailable',
      missing: ['execution.stream'],
    },
  });
  expect(events.domainAfter(project.id, 0).events.at(-1)?.type)
    .toBe('worker_execution.lifecycle_changed');
  expect(commands.find(requiresExecutionStreamCommand.idempotencyKey)).toBeDefined();
  expect(operations.listForExecution(executionId)).toEqual([]);
  expect(fake.startCount).toBe(0);
});

it('makes start idempotent before calling the adapter', async () => {
  fake.blockStart();
  const first = runtime.start(startCommand);
  await fake.waitUntilStartCalled();
  const stored = commands.find(
    startCommand.idempotencyKey,
    hashV2Command(startCommand.command),
  );
  expect(stored?.result).toMatchObject({
    ok: true,
    execution: { lifecycle: 'starting', nativeHandle: null },
  });
  await expect(runtime.start(startCommand)).resolves.toEqual(stored?.result);
  expect(fake.startCount).toBe(1);
  fake.releaseStart();
  await first;
  expect(commands.find(
    startCommand.idempotencyKey,
    hashV2Command(startCommand.command),
  )?.result).toEqual(stored?.result);
});

it('persists immutable interrupt acceptance before the side effect', async () => {
  fake.blockInterrupt();
  const first = runtime.interrupt(interruptCommand);
  await fake.waitUntilInterruptCalled();
  const stored = commands.find(
    interruptCommand.idempotencyKey,
    hashV2Command(interruptCommand.command),
  );
  expect(stored?.result).toMatchObject({
    ok: true,
    execution: { lifecycle: 'interrupting' },
  });
  await expect(runtime.interrupt(interruptCommand)).resolves.toEqual(stored?.result);
  expect(fake.interruptCalls).toHaveLength(1);
  fake.releaseInterrupt({ status: 'succeeded' });
  await first;
  expect(commands.find(
    interruptCommand.idempotencyKey,
    hashV2Command(interruptCommand.command),
  )?.result).toEqual(stored?.result);
});

it('commits normalized completion and lifecycle atomically', async () => {
  await fixture.releaseThroughAdapterCursor(6);
  const runtimeEvent = events.runtimeAfter(project.id, 0).events.at(-1);
  expect(runtimeEvent).toMatchObject({
    adapterCursor: 6,
    type: 'worker_execution.completed',
    payload: { outcome: 'completed' },
  });
  expect(executions.get(executionId)?.lifecycle).toBe('completed');
  expect(events.domainAfter(project.id, 0).events.at(-1)?.type)
    .toBe('worker_execution.lifecycle_changed');
});

it('fails a missing required skill before adapter start', async () => {
  const result = await runtime.start(requiredUnavailableCommand);
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'required_skill_unavailable' },
  });
  const failed = executions.list(project.id)[0];
  expect(fake.startCount).toBe(0);
  expect(failed.resolvedSkills[0].resolution.kind).toBe('unavailable');
  expect(failed.nativeHandle).toBeNull();
  expect(operations.listForExecution(failed.id)).toEqual([]);
  expect(
    events.runtimeAfter(project.id, 0).events.filter(
      (event) => event.executionId === failed.id,
    ),
  ).toEqual([]);
});

it.each([
  'raw_insert',
  'runtime_insert',
  'cursor_update',
  'lifecycle_domain_append',
] as const)('contains an audit failure at %s', async (faultPoint) => {
  const session = await fixture.startOwnedSession();
  const before = fixture.auditSnapshot();
  fixture.installSqliteAbortTrigger(faultPoint);

  await fixture.releaseOneEnvelopeThatReaches(faultPoint);
  await runtime.drain();

  expect(fixture.auditSnapshot()).toEqual(before);
  expect(barrier.status).toBe('tripped');
  expect(fake.interruptCalls).toEqual([session.nativeHandle]);
  expect(session.closeCount).toBe(1);
  expect(published).toEqual([]);
  expect(session.consumedAdapterCursors).toEqual([fixture.failingAdapterCursor]);
});
```

`installSqliteAbortTrigger` is test-only SQL in
`execution-runtime.spec.ts`: abort before `raw_diagnostics` insert, before
`runtime_events` insert, before the `worker_executions` cursor update, or before
the lifecycle `domain_events` insert after the lifecycle update. Each test
captures rows and execution revision immediately before the envelope
transaction, so equality proves rollback of diagnostics, runtime data, cursors,
lifecycle, and domain sequence. Repeat the raw-insert case with
`adapter.interrupt` throwing and assert `session.closeCount === 1`; interruption
is best-effort but closure and consumption stop are mandatory. The fake iterator
records every `next()` request, so the final assertion proves no later envelope
was consumed rather than relying on a timer.

Add a distinct regression where the first database write that terminalizes a
cursor-6 completion fails. Assert the barrier trips immediately, the owned
session is interrupted and closed, all completion/runtime/lifecycle rows roll
back, nothing publishes, and no second fallback terminalization transaction is
attempted. Repeat for an adapter failure that would normally terminalize the
execution.

Add reconciliation fixtures with pending start and interrupt operations whose
executions are open and terminal. Assert every pending operation receives one
standalone raw diagnostic and a terminal operation state in the same
transaction. An interrupt may become `interrupted` only for
`{ status: 'succeeded' }`, or for `{ status: 'already_terminal' }` paired with a
terminal interrupted probe; `unknown`, completed/failed terminal probes, and
probe errors produce an unknown operation result. Open executions become
`attention_required`; terminal executions remain immutable and the
reconciliation summary reports the attention alongside the durable operation
diagnostic.

Add table tests for exact and caret versions: `^1.2.3` accepts `1.9.0` and
rejects `2.0.0`; `^0.2.3` accepts `0.2.9` and rejects `0.3.0`; `^0.0.3` accepts
only `0.0.3`; malformed and prerelease constraints resolve unavailable.

For both start and interrupt, spy on the command repository and prove the
idempotency key/hash is checked once on the fast path and again inside the
immediate reservation transaction. For start, hold capability resolution until
two concurrent calls have both missed the fast lookup, release them, and assert
one stored acceptance result, one pending-operation lineage, and one adapter
start. Use two runtime instances sharing the same test database for the
reservation race.

- [ ] **Step 5: Implement execution start, stream, interrupt, and reconcile**

Read and store the adapter capability snapshot, then compare every effective
profile `requiredCapabilities` value before skill resolution, operation intent,
or `start`. Missing capabilities atomically store the terminal execution,
`worker_execution.lifecycle_changed` domain event, command result, and
structured `failure.missing` list; publish that committed domain event and
return without creating an operation or calling the adapter. Apply the same
no-operation/no-start rule to a missing required skill.

For an allowed start, perform a fast idempotency lookup, then one immediate
transaction rechecks the same key/hash before it snapshots profile/skills,
persists the `starting` execution, creates a pending operation whose canonical
`request_json` is
`{ version: 'mesh.v2.execution-start/v1', idempotencyKey, requestHash, request }`,
appends `worker_execution.lifecycle_changed`, and stores a successful immutable
command result containing the `starting` execution. Commit and publish before
`adapter.start`. A replay returns that exact stored result and never invokes the
adapter. After start, atomically store the native handle, complete the operation,
transition to `running`, and append the lifecycle event; on start failure,
complete the operation as failed and append the failed lifecycle event. Never
rewrite the accepted command result.

Interrupt follows the same two-look-up reservation discipline. Its immediate
transaction creates canonical
`{ version: 'mesh.v2.execution-interrupt/v1', idempotencyKey, requestHash, request }`
operation input, transitions the execution to `interrupting`, appends the sole
lifecycle domain event, and stores an immutable accepted `interrupting` command
result before `adapter.interrupt`. Only the transaction winner performs the
side effect; a replay returns the stored result. Later proof transitions the
execution and operation without rewriting that result.

For every envelope use one immediate transaction for raw insert, runtime insert,
execution cursor update, lifecycle change/domain append, and operation
observation as applicable; only after commit publish runtime followed by domain
events. Cursor-6 normalized completion performs all terminal writes in that
transaction, publishes runtime then domain, and immediately stops requesting
envelopes and closes the session. Stream exhaustion does not complete an
execution. Invalid normalized input is an audited adapter failure, never an
unvalidated event.

On any envelope-transaction error, trip `AuditBarrier` synchronously before the
iterator can request another item, remove the owned session from active
consumption, attempt `adapter.interrupt(nativeHandle)`, and call
`session.close()` in `finally`. Swallow interruption/close errors only after
recording them in in-memory unhealthy diagnostics because the durable audit path
is unavailable. Resolve `drain()` only when that containment sequence finishes;
publish nothing from the failed transaction.

The first failed terminalization write follows this same path immediately. Do
not enter a general catch that tries to write a second `failed` or
`attention_required` lifecycle as a fallback; that masks the audit failure and
can continue without the required containment.

Reconciliation iterates the union of open executions and every pending
operation, grouped as an ordered list per execution so no start/interrupt row is
collapsed. Each observed probe/interrupt result is stored through
`appendRawDiagnosticInTransaction` in the same immediate transaction as the
operation and lifecycle/domain changes. Require the interrupt proof matrix
above. A new fake adapter object must parse its opaque handle, probe the exact
held cursor, and resume `running` at `lastAdapterCursor + 1` only when the probe
cursor equals the stored cursor; unknown probes and pending side-effect
ambiguity become `attention_required`.

- [ ] **Step 6: Run the T06 gate**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/executions --config apps/v2-server/vitest.config.ts
corepack pnpm nx typecheck v2-server
git diff --check
```

- [ ] **Step 7: Commit**

```powershell
git add apps/v2-server/src/executions
git commit -m "feat(v2): add fake worker execution runtime"
```

**Acceptance criteria:** Fake conformance passes; snapshots precede start;
required capabilities and required skills durably fail with no operation and
zero adapter starts; preferred skills visibly fall back; the immutable accepted
start and interrupt results, in-transaction idempotency rechecks, and correlated
pending operations precede each single side effect;
cursor-6 normalized completion commits runtime and lifecycle atomically; each
audit failure point, including the first terminalization write, rolls back,
trips the barrier, interrupts/closes the owned session, publishes nothing, and
consumes nothing later without a fallback masking attempt; every pending
operation is reconciled with raw diagnostic evidence; interrupt completion is
proof-based; caret `0.x` semantics are correct; a fresh object resumes only
from its parsed handle and exact stored cursor; no provider or future-workflow
type exists.

### Task T07: V2 Web API, Projection, Replay, and Resync

**Wave:** 2R (restart in a fresh worktree from the accepted correction head)

**Outcome:** Provide a deterministic browser-side client and reducer that
converges from V2 snapshots and the two ordered streams.

**Files:**

- Create: `apps/v2-web/src/api/client.ts`
- Create: `apps/v2-web/src/api/client.spec.ts`
- Create: `apps/v2-web/src/api/socket.ts`
- Create: `apps/v2-web/src/api/socket.spec.ts`
- Create: `apps/v2-web/src/state/reducer.ts`
- Create: `apps/v2-web/src/state/reducer.spec.ts`
- Create: `apps/v2-web/src/state/resync.ts`
- Create: `apps/v2-web/src/state/resync.spec.ts`
- Create: `apps/v2-web/src/state/store.ts`

**Owned surfaces:** `apps/v2-web/src/api/**` and
`apps/v2-web/src/state/**`.

**Prohibited surfaces:** UI components, app/main, server, contracts, e2e, local
lifecycle rules, and V1 state code.

**Interfaces consumed:** Corrected T01 commands, HTTP snapshots, errors,
domain/runtime events (including `worker_execution.completed`), cursors, and
realtime messages.

**Interface produced:**

```ts
export interface V2Api {
  systemSnapshot(signal?: AbortSignal): Promise<V2SystemSnapshot>;
  projectSnapshot(projectId: string, signal?: AbortSignal): Promise<V2ProjectSnapshot>;
  command(envelope: V2CommandEnvelope, signal?: AbortSignal): Promise<V2CommandResult>;
}

export type ProjectionDispatch = (action: ProjectionAction) => void;
export const createV2Socket: (options: SocketOptions) => V2Socket;
export const createResyncCoordinator: (
  api: V2Api,
  dispatch: ProjectionDispatch,
) => ResyncCoordinator;

export type SocketOptions = {
  url: string;
  projectId: string;
  cursors: ProjectEventCursors;
  dispatch: ProjectionDispatch;
};
export type V2Socket = { close(): void; reconnect(): void };
export type ResyncCoordinator = {
  request(projectId: string): Promise<void>;
  cancel(): void;
};
```

- [ ] **Step 1: Write failing client and reducer tests**

```ts
it('requests resync on a runtime gap without changing the cursor', () => {
  const result = reduceProjectProjection(readyStateAtRuntime4, {
    type: 'runtime.event',
    event: { ...runtimeEvent, sequence: 6 },
  });
  expect(result.runtimeCursor).toBe(4);
  expect(result.connection).toEqual({ status: 'stale', reason: 'runtime_gap' });
  expect(result.resyncRequested).toBe(true);
});

it('projects completion activity but waits for the lifecycle domain event', () => {
  const afterRuntime = reduceProjectProjection(runningAtRuntime5, {
    type: 'runtime.event',
    event: { ...completionEvent, sequence: 6, adapterCursor: 6 },
  });
  expect(afterRuntime.runtimeCursor).toBe(6);
  expect(afterRuntime.executions[0]?.lifecycle).toBe('running');
  expect(afterRuntime.activity.at(-1)?.type).toBe('worker_execution.completed');

  const afterDomain = reduceProjectProjection(afterRuntime, {
    type: 'domain.event',
    event: lifecycleChangedToCompleted,
  });
  expect(afterDomain.executions[0]?.lifecycle).toBe('completed');
});
```

Cover exact duplicate ignore, project mismatch, domain gap, invalid server
message, abort, stable error parsing, reconnect cursor hello, and single-flight
snapshot refresh. Parse and project cursor-6 completion from both retained replay
and live delivery; never infer lifecycle completion from that runtime activity.

- [ ] **Step 2: Run red**

```powershell
corepack pnpm exec vitest run apps/v2-web/src/api apps/v2-web/src/state --config apps/v2-web/vite.config.ts
```

- [ ] **Step 3: Implement strict clients and projection**

Parse every response/message with T01 schemas. The reducer may project only
server events and snapshots; route selection, repository-form drafts, and tab
selection remain local store fields.

```ts
if (event.sequence === cursor) return state;
if (event.sequence !== cursor + 1) {
  return { ...state, connection: { status: 'stale', reason: `${stream}_gap` },
    resyncRequested: true };
}
return applyCommittedEvent(state, stream, event);
```

- [ ] **Step 4: Run the T07 gate**

```powershell
corepack pnpm exec vitest run apps/v2-web/src/api apps/v2-web/src/state --config apps/v2-web/vite.config.ts
corepack pnpm nx typecheck v2-web
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add apps/v2-web/src/api apps/v2-web/src/state
git commit -m "feat(v2): add snapshot and replay projection"
```

**Acceptance criteria:** Client parsing fails closed; two cursors advance
independently and contiguously; duplicates are harmless; gaps become stale and
single-flight resync; cursor-6 completion is visible as runtime activity while
the execution lifecycle changes only from
`worker_execution.lifecycle_changed`; no client-side domain transition is
invented.

### Task T08: V2 Server Composition, HTTP, Realtime, and Startup Recovery

**Wave:** 3

**Outcome:** Compose accepted project/profile/execution services behind the V2
entrypoint and prove local transport, replay, audit shutdown, and restart order.

**Files:**

- Modify: `apps/v2-server/src/main.ts`
- Create: `apps/v2-server/src/main.spec.ts`
- Create: `apps/v2-server/src/config.ts`
- Create: `apps/v2-server/src/config.spec.ts`
- Create: `apps/v2-server/src/platform/process-runner.ts`
- Create: `apps/v2-server/src/platform/paths.ts`
- Create: `apps/v2-server/src/http/app.ts`
- Create: `apps/v2-server/src/http/routes.ts`
- Create: `apps/v2-server/src/http/routes.spec.ts`
- Create: `apps/v2-server/src/http/snapshots.ts`
- Create: `apps/v2-server/src/realtime/event-publisher.ts`
- Create: `apps/v2-server/src/realtime/socket-hub.ts`
- Create: `apps/v2-server/src/realtime/socket-hub.spec.ts`

**Owned surfaces:** The files above and new files only within the same named
`config`, `platform`, `http`, and `realtime` boundaries.

**Prohibited surfaces:** Contracts, migration/schema, accepted project/profile/
execution internals, web, e2e, V1 server, real adapter/SDK, and Git mutation.

**Interfaces consumed:** T01 transport contracts; all T02/T04/T05/T06 produced
interfaces.

**Interface produced:**

```ts
export type V2ServerConfig = {
  host: '127.0.0.1' | '::1';
  port: number;
  workspaceRoot: string;
  databasePath: string;
  developmentOrigin?: string;
  webRoot?: string;
  testFakeHoldAfterAdapterCursor?: number;
};

export type RunningV2Server = {
  origin: string;
  close(): Promise<void>;
  releaseFakeHold(): void;
};

export type StartV2ServerOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  test?: {
    adapter?: HarnessAdapter;
    webRoot?: string;
    onPublished?: (message: ServerRealtimeMessage) => void;
  };
};

export const startV2Server: (
  options?: StartV2ServerOptions,
) => Promise<RunningV2Server>;

export type V2ReadyLine = {
  type: 'mesh.v2.ready';
  origin: string;
};
```

- [ ] **Step 1: Write failing config and route tests**

```ts
it('uses only the V2 port and database namespace', () => {
  const config = loadV2ServerConfig({}, 'C:\\work\\mesh');
  expect(config.port).toBe(3838);
  expect(config.databasePath).toMatch(/[\\/]\.mesh[\\/]v2[\\/]mesh-v2\.sqlite$/);
});

it('allows an ephemeral port only for the fake-only test process', () => {
  expect(loadV2ServerConfig({ NODE_ENV: 'test', MESH_V2_PORT: '0' }, root).port)
    .toBe(0);
  expect(() => loadV2ServerConfig({ NODE_ENV: 'production', MESH_V2_PORT: '0' }, root))
    .toThrowError(expect.objectContaining({ code: 'invalid_v2_port' }));
});

it('rejects a non-loopback origin before command dispatch', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/commands',
    headers: { origin: 'https://example.com' },
    payload: registerEnvelope,
  });
  expect(response.statusCode).toBe(403);
});
```

Cover all four commands, both snapshots, both replay streams, stable error
mapping, invalid payload, unknown project, revision conflict, audit barrier,
stop-accepting, static-root distinction, and no `/api` V1 route.

- [ ] **Step 2: Run HTTP/config tests red**

```powershell
corepack pnpm exec vitest run apps/v2-server/src/config.spec.ts apps/v2-server/src/http --config apps/v2-server/vitest.config.ts
```

- [ ] **Step 3: Implement config, safe process/path boundary, snapshots, and routes**

Read only `MESH_V2_HOST`, `MESH_V2_PORT`, `MESH_V2_WORKSPACE_ROOT`,
`MESH_V2_DATA_DIR`, `MESH_V2_DATABASE_PATH`, `MESH_V2_DEV_ORIGIN`, and
`MESH_V2_GIT_EXECUTABLE`, plus `MESH_V2_WEB_ROOT` for the production static
root. Approve one absolute Git executable at startup; never search from a
repository-controlled working directory. Accept port `0` only when
`NODE_ENV=test`; after reconciliation and listen, `main.ts` writes exactly one
JSON `V2ReadyLine` to stdout containing the actual loopback bound origin.
Only with `NODE_ENV=test`, accept `MESH_V2_FAKE_HOLD_AFTER_CURSOR` into
`testFakeHoldAfterAdapterCursor`; reject that setting in every other mode.

```ts
app.post('/api/v2/commands', async (request, reply) => {
  assertAcceptingAndLocalOrigin(request, dependencies);
  const envelope = v2CommandEnvelopeSchema.parse(request.body);
  return reply.send(await dispatchV2Command(envelope, dependencies));
});
```

- [ ] **Step 4: Write failing replay and restart-order tests**

```ts
it.each(['domain', 'runtime'] as const)(
  'does not lose a %s event published while replay is blocked',
  async (stream) => {
    const fixture = await createSocketReplayFixture(stream);
    const subscription = fixture.subscribeFrom(0);
    await fixture.waitUntilListenerInstalledAndReplayBlocked();

    const interleaved = fixture.commitAndPublishNext(stream);
    fixture.releaseReplay();

    expect(await subscription.collectThrough(interleaved.sequence)).toEqual(
      fixture.eventsThrough(interleaved.sequence),
    );
    expect(subscription.sequences(stream)).toEqual(
      fixture.contiguousSequencesThrough(interleaved.sequence),
    );
  },
);

it('reconciles before accepting a snapshot request', async () => {
  const first = await startV2Server({ test: restartFixture.holdAtCursor2 });
  await restartFixture.startExecution(first.origin);
  await restartFixture.waitForCursor(2);
  await restartFixture.simulateCrash(first);

  const second = await startV2Server({ test: restartFixture.resumeWithFreshFake });
  const snapshot = await fetch(`${second.origin}/api/v2/projects/${projectId}/snapshot`)
    .then((response) => response.json());
  expect(v2ProjectSnapshotSchema.parse(snapshot).executions[0].lifecycle)
    .not.toBe('starting');
});
```

- [ ] **Step 5: Implement realtime and server lifecycle**

Construct repositories/services, run `reconcileExecutions`, publish recovered
committed events, then begin accepting network traffic. A socket subscription
uses one serialized state machine per connection:

1. validate the project and both client cursors;
2. install domain and runtime committed-publication listeners in `buffering`
   mode before querying either replay window;
3. read retained windows and their `highWater` values, then send each replay in
   stream order;
4. discard buffered duplicates whose sequence is at or below that stream's
   replay high-water, and drain later buffered events in exact sequence;
5. keep buffering publications that arrive during the drain, repeat until the
   queue is empty, then atomically change the already-installed listeners to
   `live` mode.

A retained gap or non-contiguous buffer closes with `v2.resync_required`.
Listener cleanup occurs on every error/close. The two deterministic tests above
block replay sending only after listeners are observably installed, commit and
publish one event during that block, and prove exactly-once contiguous delivery
for domain and runtime independently. Shutdown order is stop accepting, reject
new starts, close socket hub, drain runtime event promises, close execution
runtime, close database.

- [ ] **Step 6: Run the T08 gate**

```powershell
corepack pnpm exec vitest run apps/v2-server/src --config apps/v2-server/vitest.config.ts
corepack pnpm nx typecheck v2-server
corepack pnpm nx build v2-server
git diff --check
```

- [ ] **Step 7: Commit**

```powershell
git add apps/v2-server/src/main.ts apps/v2-server/src/main.spec.ts apps/v2-server/src/config.ts apps/v2-server/src/config.spec.ts apps/v2-server/src/platform apps/v2-server/src/http apps/v2-server/src/realtime
git commit -m "feat(v2): compose foundation server"
```

**Acceptance criteria:** V2 config cannot collide by default with V1; only
loopback traffic enters; routes and sockets use strict V2 schemas; events replay
without a listener gap and interleavings are deduplicated per stream;
reconciliation precedes listen; audit/stop barriers reject mutation; a test
production process may bind port zero, reports its actual origin once, and
serves only the explicit V2 built-web root.

### Task T09: Integrated V2 Web Application

**Wave:** 4

**Outcome:** Wire routing, selector, snapshots, commands, sockets, resync, and
the focused shell into a separately runnable V2 browser application.

**Files:**

- Modify: `apps/v2-web/src/main.tsx`
- Create: `apps/v2-web/src/app/App.tsx`
- Create: `apps/v2-web/src/app/App.spec.tsx`
- Create: `apps/v2-web/src/app/use-project-connection.ts`
- Create: `apps/v2-web/src/app/use-project-connection.spec.tsx`

**Owned surfaces:** `apps/v2-web/src/main.tsx` and
`apps/v2-web/src/app/**`.

**Prohibited surfaces:** Components, api/state internals, server, contracts,
e2e, V1 web, and future-pane behavior.

**Interfaces consumed:** T03 components and view models; T07 `V2Api`, socket,
store, and resync coordinator; T01 contracts.

**Interface produced:** `App({ api, socketFactory, location, history })` with
defaults bound in `main.tsx`; hooks must accept injected dependencies for tests.

- [ ] **Step 1: Write failing integrated UI tests**

```tsx
it('registers a Todo repository, selects it, and reconnects from cursors', async () => {
  const user = userEvent.setup();
  render(<App api={api} socketFactory={socketFactory} location={location} history={history} />);
  await user.type(await screen.findByLabelText('Repository path'), 'C:\\repos\\todo');
  await user.click(screen.getByRole('button', { name: 'Add and select project' }));
  expect(history.pushState).toHaveBeenCalledWith(null, '', `/projects/${project.id}`);
  expect(await screen.findByText('Todo foundation worker')).toBeVisible();
  expect(socketFactory.lastHello()).toMatchObject({ domainAfter: 3, runtimeAfter: 5 });
});
```

Cover refresh at project URL, unknown project, deselect, disconnected/stale
disabled controls, interrupt command with revision, attention details, fallback
display, child activity, resync snapshot replacement, and future panes.

- [ ] **Step 2: Run red**

```powershell
corepack pnpm exec vitest run apps/v2-web/src/app --config apps/v2-web/vite.config.ts
```

- [ ] **Step 3: Implement app composition**

Generate idempotency UUIDs at the interaction boundary, preserve the same key
for a retried in-flight command, and navigate only from a parsed successful
result. URL changes drive project snapshot ownership; no selected project is
written to the server.

```tsx
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Run the T09 gate**

```powershell
corepack pnpm exec vitest run apps/v2-web/src --config apps/v2-web/vite.config.ts
corepack pnpm nx typecheck v2-web
corepack pnpm nx build v2-web
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add apps/v2-web/src/main.tsx apps/v2-web/src/app
git commit -m "feat(v2): wire project-focused application"
```

**Acceptance criteria:** Root always requires explicit selection; project URLs
reload from server truth; commands are disabled while unsafe; gaps resync;
execution/profile/skill/restart state is visible; future domains remain inert.

### Task T10: Todo Restart Stop-Condition Scenario

**Wave:** 5

**Outcome:** Add one executable fake-only Playwright scenario proving the full
M1 stop condition across a real server-process restart.

**Files:**

- Create: `e2e-v2/project.json`
- Create: `e2e-v2/tsconfig.json`
- Create: `e2e-v2/playwright.config.ts`
- Create: `e2e-v2/src/fixtures/v2-process.ts`
- Create: `e2e-v2/src/fixtures/todo-repository.ts`
- Create: `e2e-v2/src/v2-foundation.spec.ts`

**Owned surfaces:** `e2e-v2/**`.

**Prohibited surfaces:** Product code, contracts, V1 e2e, external harness
traffic, persistent operator database, and operator repositories.

**Interfaces consumed:** Built V2 server/web entrypoints and public `/api/v2`
contracts only.

**Interface produced:** Nx project `v2-e2e` whose `e2e` target depends on
`v2-server:build` and `v2-web:build` and runs Playwright Chromium with one worker.
The built server is the sole child process and serves `dist/apps/v2-web` on its
own ephemeral loopback origin.

- [ ] **Step 1: Write the failing browser scenario**

```ts
test('Todo foundation survives restart without V1 state', async ({ page }) => {
  const fixture = await V2ProcessFixture.createTodo();
  await fixture.start({ holdAfterAdapterCursor: 2 });
  await page.goto(fixture.origin);
  await page.getByLabel('Repository path').fill(fixture.todoRepository);
  await page.getByRole('button', { name: 'Add and select project' }).click();
  await fixture.approveProfilesAndStartExecution();
  await expect(page.getByText('child.started')).toBeVisible();

  const firstServerPid = fixture.serverPid;
  await fixture.crashServer();
  await fixture.restartWithFreshFake();
  expect(fixture.serverPid).not.toBe(firstServerPid);
  await page.reload();
  await expect(page.getByText('completed')).toBeVisible();
  await fixture.expectContinuousStreamsAndStableSnapshots();

  const allRuntime = await fixture.runtimeEventsAfter(0);
  const completions = allRuntime.events.filter(
    (event) => event.type === 'worker_execution.completed',
  );
  expect(completions).toEqual([
    expect.objectContaining({
      adapterCursor: 6,
      payload: { outcome: 'completed' },
    }),
  ]);
  const allDomain = await fixture.domainEventsAfter(0);
  expect(allDomain.events).toContainEqual(
    expect.objectContaining({
      type: 'worker_execution.lifecycle_changed',
      payload: expect.objectContaining({
        execution: expect.objectContaining({ lifecycle: 'completed' }),
      }),
    }),
  );

  const beforeFailure = await fixture.projectSnapshot();
  await expect(fixture.startRequiredUnavailable()).resolves.toMatchObject({
    ok: false,
    error: { code: 'required_skill_unavailable' },
  });
  const afterFailure = await fixture.projectSnapshot();
  const failed = afterFailure.executions.find(
    (execution) => execution.failure?.code === 'required_skill_unavailable',
  );
  expect(failed).toMatchObject({ lifecycle: 'failed', nativeHandle: null });

  const domain = await fixture.domainEventsAfter(beforeFailure.cursors.domain);
  const runtime = await fixture.runtimeEventsAfter(beforeFailure.cursors.runtime);
  expect(
    domain.events
      .filter((event) => event.payload.executionId === failed?.id)
      .map((event) => event.type),
  ).not.toContain('worker_execution.starting');
  expect(runtime.events.filter((event) => event.executionId === failed?.id)).toEqual([]);
  expect(afterFailure.cursors.runtime).toBe(beforeFailure.cursors.runtime);
  expect(domain.events.map((event) => event.sequence)).toEqual(
    contiguousAfter(beforeFailure.cursors.domain, afterFailure.cursors.domain),
  );
});
```

These are black-box assertions through the command result, project snapshot,
and both replay routes. They prove durable terminal
`required_skill_unavailable`, a null native handle, no public start-operation
transition, no runtime event for the failed execution, no runtime-cursor advance,
and contiguous unrelated domain sequencing. T10 must not read the adapter
object, execution repository, operations table, or a test-only endpoint. T06's
direct unit test supplies the stronger internal proof that
`operations.listForExecution(failed.id)` is empty and `fake.startCount` remains
zero. The completion assertions prove T07 receives the strict cursor-6 runtime
variant once and the lifecycle remains represented by the single domain event.
A separate T10 assertion hashes a copied non-empty unmarked database before and
after rejected startup.

- [ ] **Step 2: Run red**

```powershell
corepack pnpm nx e2e v2-e2e --project=chromium
```

Expected: failure because the V2 e2e project/fixture does not exist.

- [ ] **Step 3: Implement isolated process and repository fixtures**

Use `mkdtemp`, explicit resolved paths, `git init`, local test-only user name and
email, and a single Todo commit. First build both V2 projects. Spawn only
`dist/apps/v2-server/main.js`; do not start Vite. Pass `NODE_ENV=test`,
`MESH_V2_PORT=0`, the temporary database/path root, the absolute
`dist/apps/v2-web` path, and fake hold configuration. Parse exactly one ready
line shaped like
`{"type":"mesh.v2.ready","origin":"http://127.0.0.1:49152"}`, require the
parsed port to be a positive integer returned by the child, reject a
non-loopback origin, and use that same origin for Playwright, API, and WebSocket.
Track the exact server PID and terminate only that PID.

`restartWithFreshFake` must spawn a distinct Node child process with the same
database and workspace root but without the hold environment setting. No module,
static map, adapter object, or other JavaScript memory crosses the process
boundary. Successful recovery therefore proves the new fake adapter parsed the
opaque versioned handle and agreed with the stored cursor; the fixture treats
the handle as an opaque string and never decodes it.

```ts
const environment = {
  ...minimalSystemEnvironment(),
  NODE_ENV: 'test',
  MESH_V2_PORT: '0',
  MESH_V2_WORKSPACE_ROOT: fixtureRoot,
  MESH_V2_DATABASE_PATH: databasePath,
  MESH_V2_WEB_ROOT: resolve('dist/apps/v2-web'),
  MESH_V2_FAKE_HOLD_AFTER_CURSOR: '2',
};
```

Verify absolute targets remain under the fixture root before removing temporary
content in teardown.

- [ ] **Step 4: Run the T10 gate**

```powershell
corepack pnpm nx e2e v2-e2e --project=chromium
corepack pnpm nx typecheck v2-e2e
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add e2e-v2
git commit -m "test(v2): prove foundation restart scenario"
```

**Acceptance criteria:** Browser proves selection and focus; execution/profile/
skills remain stable; two distinct child PIDs prove a process boundary; runtime
resumes with no duplicate/gap and contains exactly one strict cursor-6
completion event plus a completed lifecycle domain projection; required failure
has public durable terminal/no-handle/no-start-transition/no-runtime evidence
without inspecting the fake, while T06 supplies direct no-operation/zero-start
proof; database mismatch is non-mutating; teardown touches only owned temporary
paths; the UI/API/socket share one ephemeral server origin; no Vite, port
collision, cross-origin allowance, or external-agent traffic occurs.

### Task T11: V2 Foundation Operating Documentation

**Wave:** 6

**Outcome:** Reconcile durable contributor documentation with the implemented
parallel V2 architecture and fake-only operating path.

**Files:**

- Modify: `docs/development/architecture.md`
- Modify: `docs/development/session-platform.md`
- Create: `docs/development/v2-foundation.md`

**Owned surfaces:** The three documentation files above.

**Prohibited surfaces:** Product/test/config code, historical specs/plans,
AGENTS.md, V1 behavior changes, and claims about future milestones.

**Interfaces consumed:** Accepted T01-T10 implementation and exact commands
verified in those task handoffs.

**Interface produced:** Current repository map and an operator guide naming both
V1 and V2 commands, ports, environment variables, database paths/identity,
fake-only test commands, restart scenario, and limitations.

- [ ] **Step 1: Write an evidence checklist before editing**

```text
V2 project names and entrypoints verified from project.json
V1/V2 ports verified from config tests
V2 environment names verified from config.ts
V2 database identity and mismatch behavior verified from database tests
Fake-only limitation and Todo restart command verified from v2-e2e
No future workflow represented as implemented
```

- [ ] **Step 2: Update the exact documentation sections**

Add a parallel V2 repository map and M1 request/event/restart flow to
`architecture.md`. Add one link from `session-platform.md` clarifying that its
commands and `MESH_*` settings remain V1. Write `v2-foundation.md` with exact
copy-paste commands:

```powershell
corepack pnpm nx dev v2-server
corepack pnpm nx dev v2-web
corepack pnpm nx e2e v2-e2e --project=chromium
```

Document that V2 normal execution is fake-only and that real harness smoke tests
do not exist in M1.

- [ ] **Step 3: Verify docs and links**

```powershell
corepack pnpm exec prettier --check docs/development/architecture.md docs/development/session-platform.md docs/development/v2-foundation.md
git diff --check
```

Then use the required jDocMunch MCP surface, not an inferred formatter result:

```text
index_local {
  "path": "docs",
  "name": "mesh-v2-foundation-docs",
  "incremental": false,
  "use_ai_summaries": false,
  "use_embeddings": false,
  "worktree_mode": "branch_local"
}
get_broken_links { "repo": "local/mesh-v2-foundation-docs" }
```

Expected: formatter and `git diff --check` exit zero, `index_local` covers the
complete `docs` corpus without truncation so cross-document targets can resolve,
and `get_broken_links` contains zero entries whose `source_file` is one of the
three changed documents. Record both MCP receipts, the reported overall
`broken_link_count`, and the changed-source filtered count in TASK HANDOFF
verification. Any broken link sourced from a changed document blocks the task;
pre-existing entries sourced elsewhere are reported as unverified repository
debt rather than silently claimed clean. If jDocMunch is unavailable, mark the
task blocked; do not claim links were verified.

- [ ] **Step 4: Commit**

```powershell
git add docs/development/architecture.md docs/development/session-platform.md docs/development/v2-foundation.md
git commit -m "docs(v2): document foundation operation"
```

**Acceptance criteria:** Documentation describes implemented M1 only, keeps V1
instructions accurate, distinguishes all ports/settings/data, labels fake-only
behavior, contains no provider smoke-test instruction, and has a reported
jDocMunch full-corpus scan with zero broken links sourced from the three changed
documents.

## Deterministic Integration Order and Wave Gates

The integrator starts each wave from its frozen base and applies only accepted
commits in this order:

1. Wave 0: T01.
2. Wave 1: T02, then T03.
3. Correction Wave C: T01C, then T02C, applied to the accepted Wave 1 head.
4. Wave 2R: restart T06 and T07 independently from the accepted correction
   head; preserve but do not integrate the superseded/paused worktrees.
5. Wave 2I: from the correction head apply the unchanged accepted T04 and T05
   commit sets, then the accepted restarted T06 and T07 commits.
6. Wave 3: T08.
7. Wave 4: T09.
8. Wave 5: T10.
9. Wave 6: T11.

The order within Waves 1, C, and 2I is deterministic for reproducible history;
it does not add dependencies between tasks whose owned surfaces do not overlap.
T04/T05 are applied as their exact reviewed commits, not rebased or amended.
The pre-correction T06 commit and any paused T07 state remain preserved and are
never applied. A semantic conflict, unexpected path, unplanned contract/schema
change, changed accepted patch, V1 edit, real-agent traffic, or base drift
blocks integration and returns to the coordinator; the integrator does not fix
it.

After Wave 0:

```powershell
corepack pnpm nx test v2-contracts
corepack pnpm nx typecheck v2-contracts
corepack pnpm nx typecheck v2-server
corepack pnpm nx typecheck v2-web
```

After Wave 1:

```powershell
corepack pnpm nx test v2-server
corepack pnpm nx test v2-web
corepack pnpm nx typecheck v2-server
corepack pnpm nx typecheck v2-web
```

After Correction Wave C:

```powershell
corepack pnpm nx test v2-contracts
corepack pnpm exec vitest run apps/v2-server/src/storage/event-store.spec.ts --config apps/v2-server/vitest.config.ts
corepack pnpm nx typecheck v2-contracts
corepack pnpm nx typecheck v2-server
corepack pnpm nx build v2-contracts
corepack pnpm nx build v2-server
git diff --check
```

The correction gate additionally verifies that the two accepted commits changed
only T01C/T02C owned paths and that `001_foundation.sql` and every other
`apps/v2-server/src/db/**` path are byte-identical to the Wave 1 base.

Wave 2R has no shared integration gate: each restarted T06/T07 task runs its
complete focused gate and receives an independent review. After Wave 2I:

```powershell
corepack pnpm nx test v2-contracts
corepack pnpm nx test v2-server
corepack pnpm nx test v2-web
corepack pnpm nx typecheck v2-contracts
corepack pnpm nx typecheck v2-server
corepack pnpm nx typecheck v2-web
corepack pnpm nx build v2-contracts
corepack pnpm nx build v2-server
corepack pnpm nx build v2-web
git diff --check
```

After Waves 3 and 4:

```powershell
corepack pnpm nx test v2-server
corepack pnpm nx test v2-web
corepack pnpm nx typecheck v2-server
corepack pnpm nx typecheck v2-web
corepack pnpm nx build v2-server
corepack pnpm nx build v2-web
```

After Wave 5:

```powershell
corepack pnpm verify
```

After Wave 6:

```powershell
corepack pnpm verify
```

`corepack pnpm verify` is permitted because repository policy defines it as
deterministic and fake-only. T01 makes that script run both
`nx e2e e2e --project=chromium` and
`nx e2e v2-e2e --project=chromium`; the `external-smoke` target remains
excluded. Any missing e2e invocation, new prompt, SDK query, or real harness
process in this gate is a milestone failure.

## Final Milestone Acceptance Audit

After Wave 6 integrates, dispatch a separate read-only milestone reviewer. It
must inspect the exact integrated head and map repository evidence to every
design section:

1. Outcome and Stop Condition: cite the Todo Playwright assertions for every
   public clause and the named T02/T04/T06/T08 focused tests for internal facts;
   specifically pair T10 required-skill terminal/replay evidence with T06's
   empty-operation and zero-start-count assertions.
2. Scope and deferrals: search V2 symbols and routes for every prohibited
   future concept and real adapter dependency; any implementation is a finding.
3. V2/V1 boundaries: inspect imports, Nx projects, ports, environment variables,
   database paths, production SQL assets/database-open proof, and the root
   verifier's explicit V1 plus V2 e2e invocations.
4. Project identity/selection: verify temporary Git path, conflict, deselect,
   reload, Windows normalization, separate verified HEAD command with valid,
   unborn, failed, and ambiguous cases, and no repository mutation.
5. Profiles: verify strict YAML, immutable revision, one-level extension,
   approval actor, merge rules, stale write, and old snapshot preservation.
6. Skills/execution: verify assignment/profile/capability/skill snapshots,
   preferred fallback, required capability/skill durable zero-start failures,
   structured bounded missing evidence, SemVer caret behavior including `0.x`,
   immutable pre-side-effect start idempotency, fake conformance, versioned
   opaque-handle recovery in a distinct child process, child activity,
   normalized cursor-6 completion, lifecycle, and interrupt reverse state.
7. Persistence/audit: verify application ID, fresh/reopen/mismatch cases,
   transaction rollback, idempotency, independent ordering, raw diagnostic
   reference, standalone reconciliation diagnostic atomicity without a schema
   change, every pending-operation outcome, publish-after-commit, and all four
   audit-failure points including immediate first-terminalization containment
   with no fallback masking, session interrupt/close, no publication, and no
   later consumption.
8. Commands/realtime/UI: verify strict routes, local origin, snapshot/replay,
   duplicate/gap/resync, deterministic domain/runtime replay interleavings,
   cursor-6 completion activity followed by the sole
   `worker_execution.lifecycle_changed` projection, selector/focused-shell
   states, and inert future panes.
9. Restart/security/workspace/billing: verify a fresh process and fake adapter
   resume from durable cursor, ambiguity attention, loopback/path safety, no
   filesystem mutation, one ephemeral same-origin built server with no Vite, no
   credentials, and no external-agent traffic.
10. Documentation: verify current docs name exact implemented behavior and keep
    V1 instructions correct; cite the full-corpus jDocMunch index receipt,
    overall broken-link count, and zero changed-source broken-link result.

The reviewer then runs fresh:

```powershell
corepack pnpm verify
git diff --check
git status --short
```

The milestone is accepted only if the full gate exits zero, the working tree is
clean, the complete Todo scenario passes, every design checklist item has a
repository citation, V1 remains runnable, and no required item is unverified.
Process exit, worker handoffs, individual task reviews, or unit tests alone do
not satisfy the architecture stop condition.
