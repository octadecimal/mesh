# Mesh architecture

This document is the current working map for contributors and coding agents.
Keep it aligned with the implemented system. Design specs record why a feature
was proposed; this document records how the repository works now.

## System shape

Mesh is a local Node and React application. A Fastify server owns durable
session state and Claude driver processes. The browser sends validated commands
over HTTP, receives snapshots over HTTP, and follows durable events plus
transient streaming deltas over a WebSocket connection.

The live-session server event flow is:

```text
browser action
  -> shared command contract
  -> Fastify route and command handler
  -> session registry/runtime
  -> Claude driver
  -> normalized domain event
  -> atomic event + diagnostic persistence
  -> realtime publisher
  -> web projection
```

The client begins from a snapshot. On reconnect it sends its durable cursors and
receives replay; a detected gap or `resync.required` triggers a fresh snapshot.
Text deltas may be transient, while lifecycle, messages, permissions, errors,
and other server-backed session events are durable. Selection, filters, drafts,
notifications, unread flags, and in-progress streaming text are intentionally
local interaction state. A browser view is a projection, not the source of
truth.

Project task-board state follows a parallel durable flow. Each imported project
has its own ordered project-event sequence and cursor, separate from every
session event stream. Project snapshots contain that project's tasks, attempts,
transition history, and repair conditions. A project gap triggers only that
project's snapshot refresh; importing a project establishes its cursor before
the browser resubscribes. Session snapshots and cursors continue independently.

Ownership is explicit. A durable project represents one explicitly imported Git
repository. A task belongs to exactly one project. An attempt belongs to exactly
one task and references one session; the project stream owns the task-attempt
association, while the session stream owns the session lifecycle and transcript.
Workspaces and sessions retain their existing project identities, and repository
discovery remains suggestion-only rather than creating durable projects.

Launching a task attempt composes the existing workspace and session boundaries:
the server validates a ready, unblocked task; resolves or creates the workspace;
persists the session, attempt, and project audit event; starts the session
runtime; and only then transitions the task to `in_progress`. A startup failure
retains the session and attempt while leaving the task `ready`. If the later task
transition fails, Mesh interrupts the started runtime; an unknown startup or
cleanup outcome becomes an explicit repair condition rather than an inferred
success.

Developer execution adds a durable cycle inside that attempt. Each cycle freezes
the task revision, acceptance criteria, project-instruction revision, workspace,
permission mode, policy version, attempt, and session that authorized the work.
The project's instructions remain editable project truth, but an active cycle
continues with its frozen instruction snapshot. A rejection or resolved blocker
creates another cycle, either by resuming the same session or by launching a new
attempt. The session remains the source of truth for its runtime lifecycle and
transcript; the project remains the source of truth for task state, cycles,
reports, feedback, and their ordered audit events.

Developer controls use scoped, ephemeral capabilities rather than giving the
Claude process general task authority. The server issues an in-memory capability
bound to one agent actor, task, attempt, cycle, and session. At the Claude SDK
boundary, Mesh adapts the `submit_for_review` and `mark_blocked` handlers into an
in-process MCP server and passes only those controls to the Developer runtime.
The capability registry is not durable or replayable. It invalidates tokens when
a cycle closes, a session ends, startup or recovery fails, or the registry is
cleared during shutdown/restart; the durable cycle and session state determine
what recovery is allowed next.

Not every browser action enters this flow. Selection, filters, and drafts stay
local. Layout, archive, and delete commands take repository-backed paths that do
not start or drive a Claude session.

## Boundaries

### Contracts

`packages/contracts` owns data shared across process boundaries: domain types,
commands, events, HTTP payloads, and realtime protocol messages. A wire-level
change starts here and is followed through server producers, web consumers, and
tests. Keep contracts declarative and free of server or UI behavior.

### HTTP and realtime transport

`apps/server/src/http` validates commands and maps failures to stable responses.
`apps/server/src/realtime` handles connection, replay, and publication. These
are transport boundaries: translate and validate here, but keep lifecycle and
storage rules in their owning modules.

The server accepts only configured local origins. Origin checks and the stop-
accepting barrier protect live command and socket entry points during shutdown;
do not work around them in feature code.

### Runtime and lifecycle

`apps/server/src/runtime` owns active sessions, their legal runtime transitions,
recovery, and the ordering between persistence and publication. Active-runtime
lifecycle changes belong in the explicit transition model. Archive, delete, and
layout commands use their repositories outside this runtime event path. Avoid
scattered boolean state or UI-only interpretations of whether an active session
is running, interrupted, waiting for approval, or terminal.

Driver events are untrusted boundary data. `apps/server/src/claude` adapts the
Claude Agent SDK, normalizes events, and applies permission policy. Keep SDK-
specific shapes at this boundary so the rest of Mesh speaks its own contracts.
The fake driver implements the same behavioral interface for deterministic
tests.

`apps/server/src/tasks` owns task readiness, legal task transitions, attempt
launch/link/unlink composition, Developer cycles and rework, and restart
reconciliation. `DeveloperExecutionService` owns the two agent-authorized
terminal outcomes. It validates the capability, actor, current attempt, open
cycle, and expected task revision before accepting a complete criterion report
or blocker report. In one transaction it appends the report, closes the cycle,
updates the task, appends its transition, and appends the project event; only
then does it publish the event and invalidate the capability. Human commands
separately own accepting review as done, rejecting with feedback, and resolving
a blocker by choosing resume or a new attempt.

### Persistence

`apps/server/src/db` owns SQLite setup and migrations.
`apps/server/src/repositories` owns durable reads and writes. Repositories hide
SQL from runtime and transport code; they do not decide product lifecycle.

State-bearing driver input is written with its raw diagnostic before it is
published. This audit barrier is intentional: if durable persistence fails,
Mesh must not continue presenting an unaudited state as successful.

Projects, project instructions, tasks, attempts, Developer cycles, completion
and blocker reports, review or unblock feedback, task transitions, and ordered
project events are durable repository state. Their foreign keys preserve
project, session, workspace, and layout identities when an existing database is
upgraded. Capability tokens and live MCP handler state are deliberately absent
from persistence.

Migrations are forward-moving, deterministic, and safe for existing databases.
Do not edit an applied migration to change history; add the next migration and
cover both fresh and upgraded databases.

### Web projection

`apps/web/src/api` owns transport clients. `apps/web/src/state` owns projection,
replay/resync behavior, selection, filters, drafts, and connection health.
`apps/web/src/projects` and `apps/web/src/tasks` render project import, board,
drawer, Developer execution history and reports, attempt, and repair states.
`apps/web/src/sessions` and `apps/web/src/workspace` render and compose session
states. Components should express interaction and presentation rather than
reimplementing server lifecycle rules.

Treat disconnect, stale snapshot, invalid payload, empty data, loading,
permission requests, and terminal states as first-class UI states. Reconnect
must converge on server truth rather than assuming every transient delta was
received.

### Platform operations

`apps/server/src/platform` owns filesystem paths, Git/worktree operations,
process execution, and billing-environment checks. This is a high-risk boundary:
validate resolved paths and ownership before mutation, keep subprocess calls
explicit, and return actionable errors instead of guessing.

## Repository map

```text
apps/server/                     Fastify API, runtime, drivers, persistence
  src/claude/                    Claude SDK boundary and fake driver
  src/db/                        SQLite creation and migrations
  src/http/                      commands, routes, snapshots, HTTP errors
  src/platform/                  paths, Git, processes, billing safeguards
  src/realtime/                  WebSocket hub and durable replay
  src/repositories/              persistent data access
  src/runtime/                   lifecycle, registry, recovery, publication
  src/tasks/                     task lifecycle, attempts, Developer execution
                                 and rework, restart repair
apps/web/                        React/Vite client
  src/api/                       HTTP and WebSocket clients
  src/projects/                  explicit project import
  src/state/                     client projection and resynchronization
  src/tasks/                     board, drawer, attempts, repair states
  src/sessions/                  session interaction and transcript UI
  src/workspace/                 workspace composition and layout
packages/contracts/              shared schemas, commands, events, protocols
docs/development/                current contributor and operational guidance
docs/superpowers/specs/          approved historical/product designs
docs/superpowers/plans/          implementation plans, not runtime truth
```

Tests live beside their subjects. Prefer a focused test at the boundary that
owns the rule. Cross-process behavior belongs in acceptance coverage only when
unit or integration tests cannot provide equivalent confidence.

## Where complexity belongs

Complexity caused by Claude SDK events, Git, the filesystem, SQLite, HTTP, and
WebSockets belongs in their adapters. The domain core should work with explicit
Mesh types and deterministic transitions. The UI should project server truth,
not invent a second lifecycle.

Create a new layer only when it has a clear responsibility, at least one real
consumer, and a boundary that can be explained without reading its internals.
Prefer adding a small function to the owning module over introducing a manager,
service, registry, strategy, or generic framework whose purpose is merely to
move code elsewhere.

## Durable documentation

Update this document when component ownership or the system flow changes.
Update `docs/development/session-platform.md` when setup, operating, or
verification behavior changes. Use a design spec for a meaningful future
architecture decision; once implemented, reconcile the durable development
docs so agents do not need to infer current behavior from historical plans.
