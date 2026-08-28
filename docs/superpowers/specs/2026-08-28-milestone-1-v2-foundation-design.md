# Mesh V2 Milestone 1: V2 Foundation Design

**Status:** Recommended design for implementation review

**Date:** 2026-08-28

**Architecture:**
[`2026-08-27-mesh-v2-architecture-design.md`](2026-08-27-mesh-v2-architecture-design.md)

## Outcome and Stop Condition

Milestone 1 establishes a runnable V2 vertical slice beside V1. It gives V2 its
own applications, contracts, datastore, project focus, approved worker-profile
snapshots, harness-neutral worker executions, deterministic fake harness,
durable audit and runtime streams, and restart reconciliation.

The milestone stops when one deterministic Todo-repository scenario proves all
of the following without reading or migrating V1 state:

1. the V2 web application opens on project selection, registers a temporary Todo
   Git repository, and opens its focused shell;
2. the V2 server creates or reopens a database bearing the V2 application
   identity and cannot open a non-empty V1 or unknown database;
3. a human-authorized global profile revision and a project profile extending
   that exact global revision are stored, resolved, and snapshotted;
4. one preferred logical skill falls back to the Mesh-native workflow and one
   required logical skill fails closed before harness start when unavailable;
5. a fake `WorkerExecution` starts with a frozen assignment, profile, adapter
   capability result, and resolved-skill snapshot;
6. raw fake-harness input and its normalized runtime event commit before either
   runtime or lifecycle publication;
7. the server is terminated after a known fake checkpoint, reopened against the
   same V2 database, and deterministically resumes or reconciles that same Mesh
   execution without a provider session concept; and
8. snapshots and ordered replay converge the browser on the same selected
   project, profile revision, execution, child activity, event cursors, and
   terminal result after reconnect.

No real Codex, Claude Code, model, or paid API traffic is part of this stop
condition.

## Scope

### In scope

- Separate Nx projects named `v2-contracts`, `v2-server`, `v2-web`, and
  `v2-e2e`, with the import name `@mesh/v2-contracts`.
- A V2 server entrypoint on loopback port `3838` and a V2 Vite entrypoint on
  loopback port `4300`.
- V2-only environment names, database filename, SQLite application identity,
  migration ledger, tables, repositories, commands, routes, snapshots, and
  realtime protocol.
- Explicit registration and selection of one Git working tree at a time.
- Global and project `WorkerProfile` identities with immutable approved
  revisions, strict YAML validation, one pinned global base revision at most,
  deterministic resolution, and execution snapshots.
- A harness-neutral `WorkerExecution` and assignment contract whose only M1
  assignment kind is `foundation-check`.
- Adapter capability discovery, logical preferred and required skill requests,
  deterministic resolution snapshots, and fake-only start, resume, interrupt,
  child activity, failure, and malformed-event behavior.
- Project-scoped ordered domain and runtime streams, raw diagnostic persistence,
  idempotent commands, snapshots, WebSocket replay, resync on gaps, and a central
  audit barrier.
- Startup reconciliation for incomplete execution operations and exact fake
  resumption from a persisted cursor.
- Project-selection, loading, empty, invalid-path, conflict, focused-shell,
  disconnected, stale, attention, running, and terminal UI states.
- Focused contributor and operator documentation for running V1 and V2 beside
  each other.

### Deferred

Milestone 1 does not implement `ProjectIntent`, Requirement Ledger records,
`PlanningCycle`, milestones, tasks, dependencies, Developer or QA attempts,
finite runs, scheduling, worktree allocation, evidence verdicts, integration
authority, PM chat behavior, Board behavior, requirement editing, real harness
adapters, imported skills, skill content approval, or V1 retirement.

The focused shell reserves PM Chat, Board, and Requirements regions as explicit
unavailable placeholders. It does not invent partial future domain behavior.
There is no workflow engine, generic adapter framework extracted from V1,
continuous scheduler, automatic repository discovery, V1 data migration, or
provider-native session entity.

## Options Considered

### Recommended: parallel V2 applications with selective local copying

Create separate V2 Nx applications and a V2 contract library. Recreate only the
small audit, replay, SQLite, fake-driver, path-validation, and origin-checking
mechanisms M1 uses, under V2 names and types. This keeps V1 runnable and makes
accidental V1 coupling visible in imports, configuration, ports, and storage.

### Rejected: a V2 feature flag inside the V1 applications

This would minimize initial scaffolding but share entrypoints, configuration,
contracts, database identity, and composition. It would make “fresh V2 without
V1 state” difficult to prove and invite V1 sessions and provider concepts into
the new domain.

### Rejected: extract a neutral framework before building V2

Moving V1 persistence, runtime, and transport into generic packages first could
appear reusable, but M1 supplies only one new consumer and the conceptual seams
are intentionally different. Extraction would broaden risk before V2 proves
which mechanisms are genuinely stable.

## V2 Boundaries and V1 Coexistence

The ownership boundary is structural:

```text
packages/v2-contracts/       V2 wire schemas and shared data only
apps/v2-server/              V2 configuration, SQLite, domain services, fake runtime,
                             HTTP, WebSocket, reconciliation, static production host
apps/v2-web/                 V2 project selector, focused shell, projection and clients
e2e-v2/                      V2 fake-only Todo stop-condition scenario

packages/contracts/          unchanged V1 contracts
apps/server/                 unchanged V1 server and database
apps/web/                    unchanged V1 web client
e2e/                         unchanged V1 acceptance suite
```

V2 code must not import `@mesh-session-platform/contracts` or any file under
`apps/server` or `apps/web`. V1 code must not import `@mesh/v2-contracts` or any
V2 application file. The only initially shared surfaces are repository tooling,
third-party dependencies, TypeScript configuration, and Nx conventions.

V1 keeps ports `3737` and `4200`, its `MESH_*` environment variables, and its
`session-platform.sqlite` identity. V2 defaults to ports `3838` and `4300`, only
`MESH_V2_*` variables, and defaults to
`%USERPROFILE%/.mesh/v2/mesh-v2.sqlite` on Windows or the equivalent home path
on other platforms. Production V2 serves the exact built-web root supplied by
`MESH_V2_WEB_ROOT` (normally `dist/apps/v2-web`); development V2 accepts only
`http://127.0.0.1:4300` unless an explicit loopback origin is configured. The
fake-only stop-condition fixture starts that production server with
`MESH_V2_PORT=0`, reads its loopback bound origin from the structured ready
line, and loads both UI and API from that one origin.

V2 SQLite databases use `PRAGMA application_id = 1297494528` (`MV2\0`) and a
`v2_schema_migrations` ledger. Opening logic follows these rules before any
migration changes data:

- an empty database may be claimed by V2 and receives the application ID in the
  same migration transaction;
- a database with the V2 application ID is migrated forward;
- a non-empty database with application ID zero or any different ID is rejected
  as `database_identity_mismatch`;
- V2 never probes, attaches, copies, imports, or rewrites the V1 database.

The V2 server production build exposes
`apps/v2-server/src/db/database.js` and copies
`apps/v2-server/src/db/migrations/**/*.sql` to both `db/migrations` and the
emitted source-relative `apps/v2-server/src/db/migrations` layout beneath its
output root, matching the repository's proven production mechanism. A
production-output test imports that emitted entrypoint and opens a fresh
identified database, so source-tree-only migration resolution cannot pass M1.

## Project Identity and Selection

`Project` is the only project-domain record in M1:

```ts
type Project = {
  id: ProjectId;
  displayName: string;
  repositoryIdentity: string;
  repositoryPath: string;
  gitCommonDirectory: string;
  headCommit: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
```

`project.register` accepts an absolute or workspace-root-relative path. The V2
platform boundary resolves every component, rejects traversal and symlink or
junction escape, requires a readable Git working tree, and runs explicit
non-interactive `git rev-parse --path-format=absolute --show-toplevel
--git-common-dir` and `git rev-parse --verify HEAD^{commit}` commands. The
normalized canonical common-directory path is the durable
`repositoryIdentity`; the canonical top-level is the mutable display/operation
path. The identity is unique.

The HEAD lookup is a separate shell-free process invocation. Exactly one
trimmed 40- or 64-character lowercase hexadecimal object ID is accepted.
Unborn HEAD fails as `repository_head_unborn`, ambiguity or multiple/invalid
successful output fails as `repository_head_ambiguous`, and process
spawn/timeout or other nonzero failure fails as `repository_head_failed`. Every
case writes nothing; Mesh never substitutes a working-tree hash or empty
sentinel.

Registering the same identity and path is idempotent. Registering a different
path for an existing identity returns `repository_identity_conflict`; M1 does
not silently relocate it. Registering a path already claimed by a different
identity also fails closed. Automatic repository discovery remains suggestion-
only and is not implemented.

Selection is client interaction state expressed by the route
`/projects/:projectId`, not a global server singleton. Deselecting returns to
`/`; reselecting loads a fresh project snapshot. This permits independent
browsers without making a transient UI choice canonical.

## WorkerProfile Registry

### Source schema

Profiles are strict YAML documents parsed with `yaml` and validated by Zod. The
M1 API version is `mesh.dev/v1alpha1`; unknown keys fail. Credential and secret
fields do not exist in the schema.

```yaml
apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: todo-foundation-worker
  displayName: Todo foundation worker
  scope: project
extends:
  profile: global/foundation-worker
  revision: 1
spec:
  assignmentKinds:
    - foundation-check
  preferredRuntime:
    harness: fake
    model: deterministic
  alternatives: []
  requiredCapabilities:
    - execution.stream
    - execution.resume
  skills:
    preferred:
      - test-driven-development
    required:
      - verification-before-completion
  instructions: |
    Inspect the Todo repository without modifying it and report deterministic
    foundation activity.
  outputSchema: mesh.dev/foundation-report/v1
```

The normalized contract is:

```ts
type WorkerProfileSpec = {
  assignmentKinds: readonly ['foundation-check'];
  preferredRuntime: { harness: string; model: string };
  alternatives: readonly { harness: string; model: string }[];
  requiredCapabilities: readonly string[];
  skills: {
    preferred: readonly LogicalSkillRequest[];
    required: readonly LogicalSkillRequest[];
  };
  instructions: string;
  outputSchema: string;
};

type WorkerProfileDocument = {
  apiVersion: 'mesh.dev/v1alpha1';
  kind: 'WorkerProfile';
  metadata: {
    name: string;
    displayName: string;
    scope: 'global' | 'project';
  };
  extends?: { profile: `global/${string}`; revision: number };
  spec: Partial<WorkerProfileSpec>;
};

type LogicalSkillRequest = {
  id: string;
  constraint?: { version?: string; digest?: string };
};
```

A string shorthand in YAML normalizes to `{ id: value }`. Duplicate logical
skill IDs across preferred and required lists are rejected. Names use lowercase
letters, digits, and hyphens, start with a letter, and contain at most 64
characters. Instructions, when present, are non-empty and at most 32 KiB. A
global or independent project profile must supply every `WorkerProfileSpec`
field. Only a project profile with `extends` may submit a partial spec; resolving
it against the pinned base must produce every field.

### Identity, revision, extension, and approval

`WorkerProfile` supplies stable identity and scope; `WorkerProfileRevision`
stores immutable `sourceYaml`, normalized document, optional pinned base, and
human approval metadata. A command with actor `human` and
`expectedLatestRevision` is the only M1 write path. The command creates the next
integer revision atomically and makes it the approved revision. A stale expected
revision changes nothing. Agents and executions cannot invoke this command.
Global approval atomically stores the revision and idempotent command result;
the next system snapshot exposes it. Project approval additionally appends
`worker_profile.revision_approved` to that project's domain stream. M1 does not
create a global event stream.

A global profile cannot extend another profile. A project profile may extend
exactly one approved global revision and must belong to the target project. A
project profile cannot extend another project profile, an unapproved or missing
revision, or a base that itself has `extends`. These checks make inheritance one
level even if stored data is corrupt.

Resolution copies the base normalized spec and applies the child document.
Missing child fields inherit. A present scalar or array replaces the base value;
arrays are not implicitly unioned. Child instructions append to base
instructions with one blank line and an explicit `Project specialization:`
separator. The resolved snapshot records both source revision identities, the
fully materialized effective document, and a SHA-256 digest of canonical JSON.
Updating a global profile never changes an existing project revision or
execution. Rebase means approving a new project revision pinned to the new
global revision.

## Logical Skills and Resolution Snapshots

Adapters advertise `HarnessCapabilities` and a set of native
`HarnessSkillDescriptor` values:

```ts
type HarnessSkillDescriptor = {
  logicalId: string;
  nativeId: string;
  version?: string;
  digest: string;
};

type ResolvedSkillSnapshot = {
  requested: LogicalSkillRequest;
  mode: 'preferred' | 'required';
  resolution:
    | { kind: 'native'; nativeId: string; version?: string; digest: string }
    | { kind: 'mesh-native-fallback'; workflow: string }
    | { kind: 'unavailable'; reason: string };
};
```

Resolution is deterministic: exact logical ID, then exact digest when supplied,
then a semantic-version match when supplied, otherwise the adapter's single
approved descriptor. Ambiguous matches are unavailable. M1 does not download,
import, inspect, or approve skill content.

A profile's `requiredCapabilities` are compared with the adapter capability
snapshot before an operation intent is created and before `start` is called. A
missing capability stores a terminal `failed` execution, domain event, and
idempotent command result with code `required_capability_unavailable`; it does
not invoke the adapter. A preferred unavailable skill snapshots
`mesh-native-fallback` using the stable workflow identifier
`mesh.foundation-check/v1`; execution continues because Mesh owns the domain
gate. A required unavailable or ambiguous skill snapshots `unavailable`, stores
a terminal `failed` execution with code `required_skill_unavailable`, and never
calls `HarnessAdapter.start`. Alternative harness selection is deferred because
M1 registers only `fake`.

## WorkerExecution and Adapter Contract

### Assignment and durable record

The only M1 assignment is deliberately narrow:

```ts
type FoundationCheckAssignment = {
  kind: 'foundation-check';
  projectId: ProjectId;
  title: string;
  instructions: string;
  fakeScenario: 'todo-foundation-v1';
};
```

`WorkerExecution` stores a Mesh ID, project, assignment snapshot, resolved
profile snapshot, logical and resolved skill snapshots, chosen harness and
model, adapter capability snapshot, opaque native handle, lifecycle and
revision, last committed runtime cursor, replacement link, timestamps, and
failure diagnostics. It never stores or exposes a Claude session ID, Codex
thread ID, provider transcript type, task, run, QA verdict, or integration
result.

Lifecycle is explicit:

```text
created -> starting -> running -> completed
   |          |          |  \-> interrupting -> interrupted
   |          |          \----> failed | attention_required
   |          \---------------> failed | attention_required
   \--------------------------> failed
```

Terminal states are `completed`, `failed`, `interrupted`, and
`attention_required`; none can restart in place. An explicit later replacement
creates a new execution linked by `replacementForExecutionId`, but replacement
commands are deferred until a real assignment workflow needs them. M1 restart
reconciliation may resume the same execution only when the adapter proves exact
resumption.

### Harness adapter

The V2 substrate consumes this interface:

```ts
interface HarnessAdapter {
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

interface HarnessSession {
  readonly nativeHandle: string;
  events(afterAdapterCursor: number): AsyncIterable<HarnessEventEnvelope>;
  close(): Promise<void>;
}

type HarnessEventEnvelope = {
  adapterCursor: number;
  raw: unknown;
  normalized: RuntimeEventDraft;
};
```

`start` and `interrupt` are consequential side effects. The runtime records a
pending `execution_operation` intent before calling either. It then records the
observed native handle or result and lifecycle transition. A failure between
intent and observation becomes restart reconciliation work, never inferred
success.

The deterministic fake adapter implements the same interface. Its
`todo-foundation-v1` script is keyed by Mesh execution ID and adapter cursor,
emits output plus nested child start/finish activity, can inject malformed input
or adapter failure, can hold after a configured cursor, and resumes from the
next cursor in a fresh adapter instance. Its opaque handle is treated as a
string by all non-adapter code. Fake controls are constructor/test configuration,
not public production commands. The built-process e2e fixture may supply
`MESH_V2_FAKE_HOLD_AFTER_CURSOR` only with `NODE_ENV=test`; other modes reject
that setting.

## Datastore, Event Ordering, and Audit Barrier

Migration 001 creates the entire M1 schema so parallel repository workers share
one settled database contract:

- `v2_schema_migrations` and the V2 application ID;
- `projects`;
- `worker_profiles` and `worker_profile_revisions`;
- `worker_executions` and `execution_operations`;
- `command_results`;
- `event_streams` keyed by `(project_id, stream_kind)`;
- `domain_events` keyed by `(project_id, sequence)`;
- `runtime_events` keyed by `(project_id, sequence)`; and
- `raw_diagnostics` referenced by runtime events.

The table columns are frozen for M1:

```text
v2_schema_migrations(version PK, name UNIQUE, applied_at)
projects(id PK, display_name, repository_identity UNIQUE, repository_path,
  git_common_directory, head_commit, revision, created_at, updated_at)
worker_profiles(id PK, scope, project_id FK nullable, name, display_name,
  approved_revision nullable, created_at, updated_at)
worker_profile_revisions(profile_id FK, revision, source_yaml,
  normalized_json, base_profile_id FK nullable, base_revision nullable,
  approved_by, approved_at, digest, PRIMARY KEY(profile_id, revision))
worker_executions(id PK, project_id FK, profile_id FK, profile_revision,
  assignment_json, profile_snapshot_json, skill_requests_json,
  resolved_skills_json, capability_snapshot_json, adapter_id, model,
  native_handle nullable, lifecycle, revision, last_adapter_cursor,
  last_runtime_sequence, replacement_for_execution_id FK nullable,
  failure_json nullable, created_at, updated_at, ended_at nullable)
execution_operations(id PK, execution_id FK, kind, state, request_json,
  result_json nullable, created_at, updated_at)
command_results(idempotency_key PK, command_type, request_hash, result_json,
  created_at)
event_streams(project_id FK, stream_kind, high_water,
  PRIMARY KEY(project_id, stream_kind))
domain_events(id PK, project_id FK, sequence, occurred_at, type, payload_json,
  UNIQUE(project_id, sequence))
raw_diagnostics(id PK, project_id FK, execution_id FK nullable, adapter_id,
  adapter_cursor nullable, received_at, payload_json)
runtime_events(id PK, project_id FK, execution_id FK, diagnostic_id FK,
  sequence, adapter_cursor, occurred_at, type, payload_json,
  UNIQUE(project_id, sequence), UNIQUE(execution_id, adapter_cursor))
UNIQUE INDEX worker_profiles_global_name ON worker_profiles(name)
  WHERE scope = 'global'
UNIQUE INDEX worker_profiles_project_name ON worker_profiles(project_id, name)
  WHERE scope = 'project'
UNIQUE INDEX execution_operations_pending ON execution_operations(execution_id, kind)
  WHERE state = 'pending'
```

Foreign keys are enabled, the busy timeout is 5000 ms, WAL is enabled, IDs are
text UUIDs, timestamps are UTC ISO strings, JSON is stored as canonical compact
text, and all sequence/revision columns are non-negative integers. The schema
adds uniqueness for repository identity, profile scope/name, profile revision,
one pending operation per execution/kind, command idempotency key, and both event
streams.

Every mutating command carries an idempotency key. Reuse with the same canonical
request hash returns the stored response; reuse with different input returns
`idempotency_conflict`. One transaction updates canonical state, appends domain
events, and stores the command result. Publication occurs only after commit.

Each project has independent `domain` and `runtime` high-water marks. Appending
uses `BEGIN IMMEDIATE`, advances exactly one stream counter, inserts the event,
and commits. Consumers never compare sequence numbers across streams; each
snapshot carries both cursors.

For a harness envelope, one transaction:

1. inserts the raw diagnostic exactly as received with adapter, execution, and
   adapter-cursor metadata;
2. inserts the normalized runtime event referencing that diagnostic;
3. updates the execution's last adapter and runtime cursors;
4. applies any legal lifecycle change and appends its domain event; and
5. commits before either event is published.

If any required write fails, no normalized event is published, the server-wide
in-memory `AuditBarrier` trips, and the affected owned harness session stops
consuming immediately. Mesh attempts adapter interruption and always closes the
session best-effort, even if interruption fails. This rule applies uniformly to
raw-diagnostic insert, normalized-runtime insert, execution-cursor update, and
lifecycle/domain append failure: the transaction rolls back every write, no
publication occurs, and no later adapter envelope is requested. All later
mutation commands return `audit_barrier_tripped`, and health/realtime clients
show the failure. Restart clears the in-memory barrier only after the database
opens successfully and reconciliation converts every ambiguous open execution
or operation into an explicit state.

## Commands, HTTP, Snapshots, and Realtime

All V2 HTTP paths begin `/api/v2`; V1 paths are untouched.

- `POST /api/v2/commands` accepts the strict `V2CommandEnvelope` union for
  `project.register`, `worker_profile.approve_revision`,
  `worker_execution.start`, and `worker_execution.interrupt`.
- `GET /api/v2/snapshot` returns protocol version, health, known projects, and
  approved global-profile summaries.
- `GET /api/v2/projects/:projectId/snapshot` returns the project, resolved
  project/global profiles, executions, attention items derived from execution
  state, and both event cursors.
- `GET /api/v2/projects/:projectId/events?stream=domain|runtime&after=N` returns
  an ordered retained replay window or `resync_required` when the cursor is
  outside retained history.
- `GET /api/v2/realtime` upgrades to WebSocket. The first client message is a
  strict subscription containing project ID and both cursors. For each stream,
  the server installs its committed-publication listener first in buffering
  mode, reads and sends the retained replay with its high-water mark, drops
  buffered duplicates at or below that high-water, drains the remaining buffer
  in exact sequence, and only then changes the same listener to live mode.
  Events arriving during replay or drain stay buffered. Invalid, cross-project,
  retained-gap, or non-contiguous buffered subscriptions receive
  `v2.resync_required` and no guessed projection.

Commands validate actor, expected revision, origin, project ownership, profile
scope, lifecycle, audit status, and adapter availability at the transport edge
and again at the owning service. Stable failures use V2 error codes; internal
exceptions and raw diagnostics are not exposed as authoritative domain data.

## Restart Reconciliation

Startup runs after migrations and repository construction but before accepting
HTTP or WebSocket traffic. It scans `created`, `starting`, `running`, and
`interrupting` executions plus pending operations.

- `created` with no external-operation intent becomes `failed` with
  `startup_interrupted_before_start`; Mesh does not start new work implicitly.
- A pending start or `starting` execution is probed by opaque handle when one
  was observed. Proven resumable fake state resumes after the stored adapter
  cursor. Missing or unknown side-effect outcome becomes `attention_required`.
- A `running` execution resumes only when `probe` returns `resumable` for the
  same handle and cursor. A proven terminal observation is recorded; any other
  result becomes `attention_required`.
- A pending interrupt or `interrupting` execution records `interrupted` only
  when the adapter proves interruption; ambiguity becomes `attention_required`.
- Terminal executions and complete operations are unchanged.

Every reconciliation change and observed probe result is audited and appended
before publication. Reconciliation never manufactures completion, silently
restarts an assignment, reuses a different profile revision, advances a cursor
without a matching raw diagnostic, or consults V1 sessions. The fake restart
test uses a new server and adapter object against the same V2 database to prove
that recovery depends on durable V2 facts.

## UI Shell and Projection States

The V2 browser is visually and behaviorally separate from V1.

The root route displays system health, known projects, an explicit repository
path form, approved global-profile summaries, and links to V1 operating guidance.
It covers loading, no projects, invalid path, identity conflict, command failure,
and disconnected states. Registration success navigates to
`/projects/:projectId`.

The focused project shell shows the project name and canonical path, a deselect
control, connection/cursor health, approved profile summaries, worker execution
activity with nested child rows, resolved-skill outcomes, and attention details.
It contains the architecture's left PM Chat pane and right Board/Requirements
tabs, but these are labelled “Available in a later milestone” and have no
commands. A diagnostics disclosure may show opaque handle, adapter ID, raw
diagnostic ID, and cursors; provider-specific concepts do not appear elsewhere.

The client begins from an HTTP snapshot, applies an event only when its sequence
is exactly the current cursor plus one, ignores exact duplicates, and requests a
fresh snapshot on a gap, invalid payload, project mismatch, or server
`resync_required`. Local route selection survives event replay; server state
wins for profiles and executions. Mutating controls are disabled while the
projection is disconnected, stale, loading, or the audit barrier is tripped.

## Failure and Reverse States

- Invalid or escaping repository paths make no project row.
- Duplicate repository commands are idempotent; identity conflicts preserve
  both the existing record and filesystem.
- A stale profile approval writes no revision or event. A later approved
  revision supersedes selection for new executions but never mutates old
  snapshots. Profile deletion is deferred.
- Required-skill failure creates auditable terminal evidence without calling
  the adapter. Preferred-skill absence remains visible as fallback.
- Start failure preserves the execution, operation intent/result, skill and
  profile snapshots, and diagnostics.
- Interrupt is revision-checked and idempotent. Terminal execution interruption
  returns its existing terminal state.
- Disconnect affects only client freshness. Reconnect replays or resyncs from
  durable cursors.
- Restart ambiguity becomes `attention_required`; the UI never presents it as
  completion.
- Project deselection is local and reversible. Project archive/delete and
  filesystem cleanup are deferred.

## Security, Workspace, and Billing Invariants

- Server listeners and accepted browser origins are loopback-only.
- Repository paths are canonicalized inside `MESH_V2_WORKSPACE_ROOT`; path
  traversal, link escape, unreadable Git state, and ambiguous identity fail
  closed.
- M1 reads Git identity only. It creates no branch, worktree, commit, child
  shell, or repository file and never cleans a repository.
- Only the deterministic fake adapter is registered. V2 does not import an SDK,
  read provider credentials, pass API keys to a process, or fall back to a paid
  API.
- Profile YAML and command payloads are strict and size-bounded; credentials
  have no schema field. Raw diagnostics are local database records and are not
  rendered by default.
- Authority is the intersection of global safety, project identity, assignment,
  approved profile snapshot, and fake adapter capabilities. A profile or skill
  cannot approve its own revision or lifecycle outcome.
- Shutdown stops accepting commands and subscriptions, prevents new starts,
  drains committed event processing, closes fake sessions, then closes SQLite.

## Test Strategy

All implementation behavior is developed red-green with focused Vitest tests.
Normal verification uses fake harnesses, temporary Git repositories, temporary
databases, loopback ephemeral ports, and Playwright Chromium.

- Contract tests parse every command, event, snapshot, profile, execution,
  skill-resolution, and realtime variant and reject V1/provider shapes.
- Database tests cover empty creation, existing V2 reopen, forward migration,
  V1/unknown rejection, foreign keys, transaction rollback, idempotency,
  independent per-project/per-stream ordering, and opening a fresh database
  through the production-built database entrypoint with packaged migration SQL.
- Project tests cover Windows path normalization, Git common-directory identity,
  boundary escape, duplicate import, identity conflict, and valid, unborn,
  failed, and ambiguous results from the separate HEAD command using temporary
  Git repositories plus an injected process boundary.
- Profile tests cover strict YAML, immutable revisions, stale approval, global
  and project scope, pinned one-level extension, forbidden recursion, exact
  replacement/append merge rules, digest stability, and preserved old snapshots.
- Adapter conformance tests run the fake through capability reporting, skill
  resolution, start, streaming, nested child activity, malformed input,
  interruption, exact resume, and failure.
- Runtime tests prove intent-before-side-effect, raw-before-normalized-before-
  publish, lifecycle legality, required-capability and required-skill
  fail-closed behavior with zero adapter starts, preferred fallback, all four
  audit-write failure points with rollback/session-stop/no-publication/no-later-
  consumption evidence, and reconciliation outcomes.
- Transport tests cover local origin, strict commands, stable errors, project
  snapshots, replay, duplicate delivery, gaps, resync, stop-accepting, and
  deterministic domain/runtime publications interleaved with replay.
- React tests cover every selector and focused-shell state and prove future-pane
  placeholders have no active workflow controls.
- V1 regression gates build and test `contracts`, `server`, `web`, and `e2e`
  unchanged. The normal repository `verify` gate explicitly runs both the V1
  `e2e` and V2 `v2-e2e` Chromium targets while excluding `external-smoke`.

### Executable Todo stop-condition scenario

`v2-e2e` creates a temporary frontend/backend Todo Git repository with one
commit and a temporary V2 database. It builds the V2 web and server, then
launches only the built V2 Node server with the fake adapter, an explicit
built-web root, and ephemeral loopback port. The fixture parses the server's
structured ready line and uses that single origin for UI, API, and WebSocket;
it registers and selects the repository through the browser,
approves a global and extending project profile through V2 commands, and starts
`todo-foundation-v1`.

The fake emits the preferred fallback, required native resolution, output, and
one nested child start event, then holds after a configured cursor. The fixture
terminates the server without graceful runtime completion, starts a new server
and fresh fake adapter object against the same database, reconnects the browser,
and releases the resumed script. The test asserts one execution ID, no duplicate
events, continuous runtime and domain sequences, completed child and execution
states, immutable profile/skill snapshots, and the same focused project. It
also asserts a required-unavailable execution is terminal and the fake start
count did not increase.

The scenario finally opens a fresh empty V2 database successfully and attempts
to open a copied non-empty V1-format fixture, which must fail with
`database_identity_mismatch` without changing the fixture hash.

## Documentation Updates

Implementation updates `docs/development/architecture.md` with the parallel V2
repository map and M1 request/event/restart flow. It adds
`docs/development/v2-foundation.md` with V1/V2 commands, ports, environment
names, data paths, fake-only verification, database identity behavior, and the
Todo scenario. V1 session-platform guidance remains accurate and links to the
V2 guide rather than being rewritten as V2. The documentation task indexes the
complete docs corpus with jDocMunch, reports the overall broken-link count, and
requires zero broken links sourced from those three changed development
documents; formatting alone is not link proof.

## Autonomous Decisions

| Question | Chosen answer | Rationale and consequence |
| --- | --- | --- |
| Where does V2 live? | Separate `v2-contracts`, `v2-server`, `v2-web`, and `v2-e2e` Nx projects. | Makes coexistence and regression proof structural; adds small scaffolding duplication. |
| Should V1 mechanisms be imported? | Copy only the bounded mechanism into V2 ownership when used; no cross-app imports or generic extraction. | Prevents V1 domain leakage; later stable duplication may justify a separate refactor. |
| How is a database recognized? | SQLite application ID `1297494528`, `v2_schema_migrations`, and rejection of every non-empty unmarked database. | Fresh and existing V2 databases are safe; V1 migration is impossible by accident. |
| Where is project selection stored? | In the client route, with project records durable on the server. | Avoids a global selected-project race and keeps selection reversible. |
| What identifies a repository? | Normalized canonical Git common directory, with the selected top-level path stored separately. | Linked worktrees share repository identity; relocation is explicit instead of silent. |
| What profile states exist in M1? | Immutable human-approved revisions only; the approval command directly creates the next revision. | Satisfies approval snapshots without building proposal or planning workflows. |
| How does one-level extension merge? | Missing fields inherit, present fields replace, and instructions append behind a labelled separator. | Deterministic and reviewable; avoids surprising array unions. |
| Which assignment exists? | `foundation-check` only. | Exercises the substrate without introducing Task, Developer, QA, run, or integration semantics. |
| How are unavailable capabilities or skills handled? | Required capabilities and skills store durable failure before an operation intent or `start`; preferred skills fall back to `mesh.foundation-check/v1`. | Preserves Mesh-owned workflow semantics and proves fail-closed behavior with zero external side effects. |
| Which harness runs? | A deterministic fake adapter only. | Proves neutrality and recovery without subscription usage; real adapter work remains later. |
| How does restart work? | Resume the same execution only after exact fake probe proof; otherwise require attention. | Demonstrates durable recovery without guessing or provider session concepts. |
| How are event orders modeled? | Independent domain and runtime sequences per project, joined by Mesh IDs; realtime subscribes before replay and drains buffered events against each replay high-water. | Separates authority from transport without a replay/listener lost-event window. |
| What happens on audit failure? | Roll back, trip a server-wide mutation barrier, stop consuming, interrupt best-effort, and close the affected owned session. | Prevents publication or unaudited continuation at every write stage; restart reconciliation exposes ambiguity. |
| How does the stop-condition browser avoid port and origin races? | One production-built V2 server binds an ephemeral loopback port and serves the explicitly configured built-web root on the same origin. | Eliminates Vite/server collision and cross-origin setup while retaining a real process restart. |
| What UI is delivered? | Project selector and focused shell with honest future-pane placeholders plus profile/execution diagnostics. | Proves project focus without prematurely implementing later workflows. |
| Should project/profile deletion exist? | No; deselection and new immutable profile revisions are the M1 reverse paths. | Avoids destructive state and cleanup semantics not needed by the stop condition. |

## Acceptance Checklist

- V2 applications, contracts, ports, environment names, and database identity
  are separate while V1 remains runnable.
- Both fresh and existing V2 databases work; V1/unknown state is rejected
  without mutation.
- Project registration and focused selection are explicit and path-safe.
- Global/project profile revisions, one-level extension, approval, resolution,
  and immutable execution snapshots match the defined schema and merge rules.
- WorkerExecution contains Mesh assignment/runtime facts only and the fake
  adapter satisfies the exact contract.
- Required capabilities plus preferred and required skills produce durable,
  deterministic snapshots with zero-start fail-closed behavior or fallback.
- Raw diagnostics and ordered events obey the audit barrier before publication;
  every audit-stage failure rolls back and stops the owned session.
- Restart reconciliation is evidence-based and demonstrated with a fresh server
  and fake adapter object.
- UI loading, empty, disconnected, stale, failure, attention, and terminal
  states converge from snapshots and gap-free subscribe-before-replay delivery.
- The Todo scenario and all default checks use fake or temporary resources and
  emit no external-agent traffic.
- Later milestone concepts and generic frameworks are absent.
