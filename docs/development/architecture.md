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
transition history, Developer and QA cycles and reports, QA configuration,
review-automation state, and repair conditions. A project gap triggers only
that project's snapshot refresh; importing a project establishes its cursor
before the browser resubscribes. Session snapshots and cursors continue
independently.

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

QA execution extends the current Developer attempt rather than creating another
attempt or workspace. `QaExecutionService` accepts a human launch in manual mode
or a system-policy launch in autonomous-review mode only after the current
Developer cycle has submitted a complete report and the task is unblocked in
`review`. It revalidates and reuses that cycle's exact active workspace; a fresh
worktree would not contain the submission being verified. The QA SDK query has
no built-in tools and does not load filesystem settings or inherited MCP
servers. It receives only Mesh's structured verdict, constrained verification,
and bounded workspace read, list, and search controls. Those workspace controls
resolve requested paths canonically inside the assigned workspace and reject
absolute paths, traversal, and links whose targets escape it. Handle-backed
reads and directory enumerations revalidate the canonical root, object, and
parent identities before returning data so a link or file swap fails closed.
Workspace search also caps visited directories, directory entries, queued
paths, files, and matches, and checks the owning QA cycle's cancellation signal
throughout traversal and file reads. Directory traversal streams entries and
closes the handle at the entry or queue budget instead of materializing an
unbounded directory first.
The constrained runner treats ambiguous joined option values as workspace
paths unless they are explicitly safe non-path values, and validates missing
paths through their deepest existing ancestor. It admits only non-interactive
verification commands, gives each child a five-minute wall-clock bound, caps
each output stream at 64,000 bytes, and cancels owned process trees when the QA
runtime is interrupted, closes, or exceeds a bound. On Windows, vetted package
manager commands resolve to canonical bundled JavaScript entries and run via
the installed Node executable with the shell disabled. QA Git commands resolve
to an absolute canonical executable from fixed system installation locations;
Mesh never accepts PATH or a workspace-local Git executable, and fails closed
before launch when no trusted Git installation is available. Mesh proves that
its canonical owned-tree terminator works before launching a child; a missing,
failing, or unresponsive terminator refuses launch or durably pauses the QA
cycle after an exact-owned-PID fallback. The runner never exposes a general
shell or source-authoring control.

The server captures Git-tracked source before launch, after every verification
command, and immediately before verdict persistence instead of accepting an
agent-reported workspace state. Each accepted capture requires matching forward
and reverse observations of the tracked path set, per-file metadata, and
content. A mutation or failure to stabilize within the bounded retry limit
invalidates QA authority and pauses the review loop for inspection. This
protocol defines the source-stability boundary; it is not a cross-file
filesystem lock. A write after the accepted observation is a new concurrent
mutation, so the verdict transaction begins immediately after capture without
claiming
filesystem-transaction atomicity. Tracked symbolic links are hashed as link
identity and target text without following the target; regular tracked files
are opened by handle and checked with pre/post handle metadata while their
content is streamed into the hash. Mesh then revalidates the canonical
workspace root, full path, and parent identity, so a restored parent swap cannot
hide an external read. Every component of a requested path is inspected;
broken links whose lexical target escapes the workspace fail closed even when
the target does not exist. An indexed link's canonical parent must also remain
inside the workspace. Capture checks cancellation after final canonical
revalidation and immediately before accepting either an observation or its
stable hash. Timeout, cancellation, output overflow, or confinement failure
pauses review and prevents a verdict. Verification may create ordinary ignored
build or test artifacts.

QA controls use a separate ephemeral capability bound to the QA session, task,
current attempt, and open QA cycle. The only task-domain control exposed to the
runtime is one structured verdict submission covering every snapshotted
criterion. The capability becomes invalid when the verdict closes the cycle,
startup or cleanup fails, the session stops, or the server restarts. A
transcript, process exit, or stale capability is never interpreted as a QA
outcome. If reconciliation finds a dead runtime with an open cycle, a human may
terminalize it as `interrupted` through an audited repair command. That state
has command, event, and end-time evidence but deliberately has no verdict
report.

`ReviewAutomationService` is the narrow policy boundary after committed
Developer and QA outcomes. Manual policy records the verdict and performs no
follow-up. With explicit task automation enabled under the
`autonomous_review` project policy, it durably launches QA after Developer
submission, completes verified work, resumes the same Developer session after
the first two rejections, and pauses on the third rejection or any unsafe
failure. Its action keys make duplicate delivery, replay, and restart
idempotent. It does not select ready tasks, own a queue, lease work, control
concurrency, or implement quota scheduling; a future scheduler may invoke the
same explicit launch and resume commands under its own audited policy.

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
reconciliation. `DeveloperExecutionService` owns the two Developer-authorized
terminal outcomes. It validates the capability, actor, current attempt, open
cycle, and expected task revision before accepting a complete criterion report
or blocker report. In one transaction it appends the report, closes the cycle,
updates the task, appends its transition, and appends the project event; only
then does it publish the event and invalidate the capability. Human commands
separately own accepting manual review as done, choosing rework, and resolving a
blocker.

Once a QA cycle exists for the current Developer submission, the older human
commands are gated by that evidence: acceptance requires the latest matching
verified verdict, rework requires the latest matching rejection, and neither is
valid while QA is active. Tasks with no QA history retain the pre-QA manual
decision path.

`QaExecutionService` owns QA launch, authority checks, runtime composition, and
verdict validation. A verdict transaction appends the complete QA report,
closes the cycle, applies the policy-owned task outcome, records any transition
or durable automatic-action intent, and appends ordered
`task.qa_execution_changed`, `task.review_automation_changed`, or task
transition events before anything is published. The QA capability is then
invalidated. `ReviewAutomationService` executes a committed pending action only
after re-reading current durable task, attempt, cycle, policy, and automation-
generation truth; completion or failure is persisted and published as another
ordered project event.

Startup reconciliation compares open Developer and QA cycles and pending review
actions with durable session truth. An interrupted or outcome-unknown QA cycle,
a missing live session, or an action whose safe result cannot be proven becomes
an explicit paused repair condition. Reconciliation neither manufactures a
verdict nor silently repeats QA or Developer work. State-specific recovery
preserves the workspace, cycles, reports, diagnostics, and action history.

### Persistence

`apps/server/src/db` owns SQLite setup and migrations.
`apps/server/src/repositories` owns durable reads and writes. Repositories hide
SQL from runtime and transport code; they do not decide product lifecycle.

State-bearing driver input is written with its raw diagnostic before it is
published. This audit barrier is intentional: if durable persistence fails,
Mesh must not continue presenting an unaudited state as successful.

Projects, Developer and QA instructions, review policy, tasks, attempts,
Developer and QA cycles, completion, blocker, and verdict reports, review or
unblock feedback, review-automation actions and pause state, task transitions,
and ordered project events are durable repository state. Writes representing
one Developer or QA outcome commit atomically. Their foreign keys preserve
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
drawer, Developer and QA execution history and reports, automation budget,
attempt, and repair states.
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
  src/tasks/                     task lifecycle, attempts, Developer and QA
                                 execution, review automation, restart repair
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
