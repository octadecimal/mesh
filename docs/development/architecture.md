# Mesh architecture

This document is the current working map for contributors and coding agents.
Keep it aligned with the implemented system. Design specs record why a feature
was proposed; this document records how the repository works now.

## System shape

Mesh is a local Node and React application. A Fastify server owns durable
session state and Claude driver processes. The browser sends validated commands
over HTTP, receives snapshots over HTTP, and follows durable events plus
transient streaming deltas over a WebSocket connection.

This established session platform is V1. The implemented V2 Milestone 1
foundation runs beside it with separate applications, contracts, settings, and
storage; it does not replace or migrate V1. See
[`v2-foundation.md`](v2-foundation.md) for operating instructions.

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

### Parallel V2 foundation

The V2 Milestone 1 request and event flow is:

```text
v2-web action
  -> v2-contracts request schema
  -> v2-server /api/v2 route
  -> project, profile, or execution service
  -> V2 SQLite repository transaction
  -> persisted V2 event
  -> WebSocket publication
  -> v2-web snapshot projection
```

V2 clients begin from project, profile, and execution snapshots and continue
from durable event cursors. The M1 execution path uses the fake harness adapter.
On backend restart, V2 reopens only its own database, reconciles nonterminal
execution evidence and publishes committed recovery events before accepting new
requests, then allows the browser projection to converge from snapshots and
replay. This is the implemented foundation-check flow only; the broader V2
workflow domains in the architecture design are not implemented by M1.

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

Project planning is also project-owned truth. A plan records immutable bases,
structured proposal revisions, operator feedback, and terminal history, while
its linked PM session owns only runtime lifecycle and transcript. The PM runs
against the imported repository in read-only mode and receives one scoped
proposal-submission control; it cannot edit the worktree, mutate canonical
tasks, approve its own proposal, or launch work. Human approval is the only
boundary that atomically materializes proposal tasks and dependencies into the
canonical board. Task dependencies then belong to the task domain, independent
of the plan that proposed them.

The PM SDK query receives no built-in filesystem tools or inherited filesystem
MCP servers. Mesh exposes only session-scoped bounded read, glob, and text-search
controls plus proposal submission. The read controls reject absolute paths,
traversal, unsafe glob grammar, and symlink or junction escapes. They retain
opened-handle identity and revalidate the canonical root, parent, and target
before and after reads or directory enumeration, so a concurrent path or
ancestor swap fails closed. Traversal limits, cancellation, and runtime close
revoke access without granting writes.

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
unbounded directory first. Workspace listing uses the same streaming boundary,
returns at most 500 entries, reads at most one additional entry to report
truncation, and closes promptly when the owning cycle is cancelled.
Cancellation of either listing or search reports the shared
`qa_workspace_operation_cancelled` diagnostic because both operations use the
same runtime-owned traversal boundary.
The constrained runner treats ambiguous joined option values as workspace
paths unless they are explicitly safe non-path values, and validates missing
paths through their deepest existing ancestor. It admits only non-interactive
verification commands, gives each child a five-minute wall-clock bound, caps
each output stream at 64,000 bytes, and cancels owned process trees when the QA
runtime is interrupted, closes, or exceeds a bound. On Windows, vetted package
manager commands resolve to canonical bundled JavaScript entries and run via
the installed Node executable with the shell disabled. At server startup, Mesh
approves one absolute canonical Git executable for both ordinary repository and
QA commands. An explicit `MESH_GIT_EXECUTABLE` must be absolute; otherwise Mesh
examines only absolute entries from the startup `PATH`, ignoring empty,
relative, and workspace-contained entries. The approval records canonical file
identity outside the configured workspace root and is revalidated before every
Git spawn. Runtime code never searches `PATH`, trusts `SystemRoot`, or consults
repository-controlled configuration. A missing or changed approval fails closed
before launch. Before reserving a new QA launch command, the service repeats
actor, lifecycle, and exact-workspace authorization and runs one bounded,
read-only Git capability probe. This avoids probing an unauthorized path and
leaves no command reservation when the approved executable is unavailable, so
the same idempotency key can be retried after operator repair. The full
authoritative tracked-source capture remains inside the reserved launch command.
Mesh proves that its canonical owned-tree terminator works before launching a
child; a missing, failing, or unresponsive terminator refuses launch or durably
pauses the QA cycle after an exact-owned-PID fallback. The runner never exposes
a general shell or source-authoring control.

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

`PlanningExecutionService` owns PM start, revision, resume, retry, cancellation,
and restart reconciliation. Starting or revising first commits the plan state,
immutable base, linked session, and ordered project event, then attaches the
read-only PM runtime. Its ephemeral capability is bound to that plan, base,
session, and capability generation. A structured proposal submission is
validated against those bindings and persisted with the plan transition and
project event before publication. Cancellation invalidates the capability
before interrupting the runtime, so an interrupt-time callback cannot create a
late proposal.

`PlanApprovalService` owns the human approval transaction. It revalidates the
proposal's captured task and policy base against current canonical truth; a
stale approval creates no task or dependency rows. A valid approval creates all
tasks, resolves proposal-local dependency keys, appends their ordered audit
events, and terminalizes the plan in one transaction before publishing. Plans
already `awaiting_review` survive restart without a live PM. A plan formerly in
`planning` or `revising` becomes `attention_required` when its runtime cannot be
proven live; resume and retry are explicit operator operations and issue fresh
capability authority rather than reviving an old token.

Task dependency readiness is evaluated from canonical dependency rows and
prerequisite lifecycle. A task cannot enter `ready`, launch manually, or enter a
new project-run preview while any prerequisite is incomplete. Reopening a
prerequisite does not roll back or interrupt dependents that are already
`ready`, `in_progress`, `review`, or `done`; it blocks their next launch or
future wave membership instead. A finite project run never expands its frozen
wave when dependencies later become satisfied, and it never admits work that
was ineligible when the preview was authorized.

Project-run orchestration is a finite authorization over current task truth,
not an open-ended scheduler. The browser first previews the ordered eligible
tasks, then sends their ids and revisions as `expectedTasks`. The start command
rejects a stale preview and, on success, freezes membership, queue order, task
revision, QA-policy revision, and task-automation generation. Only one
`running`, `paused`, or `draining` run may exist for a project. Capacity counts
both `launch_pending` and `active` items, and each launch claim plus its project
event commits before the attempt starts. The resulting attempt records its run
and run-item provenance.

Task outcomes release capacity through the same durable run boundary. A done
task completes its item; a Developer blocker, manual-review boundary, disabled
task automation, rejection ceiling, or paused review automation requires
attention. Later queued items may then launch without changing the frozen
membership. `Pause` persists `operator_paused` and stops new claims while
already occupied slots settle. `Resume` clears the durable pause reason and
continues the same queue. `Stop` marks queued work `not_started`, lets occupied
work drain without replacement, and completes the run with reason `stopped`.

Full project-run reconciliation is a startup boundary. It proves persisted
claims and attempt provenance, repairs known terminal outcomes, and pauses on
repository, billing, capacity, or launch ambiguity rather than guessing. Live
runtime-stop repair is deferred behind any tracked launch drain and observes
only the affected durable attempt repairs, so a concurrent legitimate launch
is not mistaken for restart ambiguity. Start, resume, and outcome-triggered
drains share a tracked single-flight scheduler. Shutdown stops accepting new
commands, settles that scheduler (including requested reruns), then shuts down
the session registry and closes the database. Any drain or project-run audit
failure trips the central audit barrier and prevents further mutation.

### Persistence

`apps/server/src/db` owns SQLite setup and migrations.
`apps/server/src/repositories` owns durable reads and writes. Repositories hide
SQL from runtime and transport code; they do not decide product lifecycle.

State-bearing driver input is written with its raw diagnostic before it is
published. This audit barrier is intentional: if durable persistence fails,
Mesh must not continue presenting an unaudited state as successful.

Projects, Developer and QA instructions, review policy, tasks, dependencies,
attempts, Developer and QA cycles, completion, blocker, and verdict reports,
review or unblock feedback, review-automation actions and pause state, plans,
immutable planning bases, proposal revisions, planning feedback, task
transitions, and ordered project events are durable repository state. Writes
representing one Developer or QA outcome, plan approval, or plan lifecycle
operation commit atomically. Their foreign keys preserve project, session,
workspace, and layout identities when an existing database is upgraded.
Developer, QA, and PM capability tokens and live MCP handler state are
deliberately absent from persistence.

Project-run storage was introduced by migrations 012 through 015. Migration
012 adds runs, their frozen queue items, capacity states, and the one-active-run
and one-open-item constraints. Migration 013 adds structured project-run source
provenance to task attempts. Migration 014 permits pre-launch failures to end as
`attention_required` without invented attempt or session ids. Migration 015
adds the nullable durable `pause_reason`; a paused run therefore remains
explainable after refresh and restart.

Migrations are forward-moving, deterministic, and safe for existing databases.
Do not edit an applied migration to change history; add the next migration and
cover both fresh and upgraded databases.

### Web projection

`apps/web/src/api` owns transport clients. `apps/web/src/state` owns projection,
replay/resync behavior, selection, filters, drafts, and connection health.
`apps/web/src/projects` and `apps/web/src/tasks` render project import, board,
drawer, Developer and QA execution history and reports, automation budget,
attempt, planning history and review, dependencies, and repair states.
`apps/web/src/sessions` and `apps/web/src/workspace` render and compose session
states. Components should express interaction and presentation rather than
reimplementing server lifecycle rules.

The project-run panel renders the server preview before authorization, requires
an explicit subscription-capacity confirmation, and sends that preview as the
stale-write guard. Running, paused, draining, and completed views are projections
of durable run state, including occupied capacity, per-item outcomes, pause
reason, and final history. Refresh and reconnect must preserve the same run id,
frozen order, item statuses, and terminal counts.

The planning panel renders server-owned plan history and structured proposal
details. Its start, revise, approve, reject, cancel, resume, and retry controls
remain disabled when transport state is disconnected or stale. The board and
task drawer project dependency blockers from the snapshot; they do not infer
readiness locally or treat a visible PM transcript as an approved plan.

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
                                 execution, PM planning and approval,
                                 dependencies, review automation, restart repair
apps/web/                        React/Vite client
  src/api/                       HTTP and WebSocket clients
  src/projects/                  explicit project import
  src/state/                     client projection and resynchronization
  src/tasks/                     board, drawer, attempts, repair states
  src/sessions/                  session interaction and transcript UI
  src/workspace/                 workspace composition and layout
packages/contracts/              shared schemas, commands, events, protocols
apps/v2-server/                  M1 V2 HTTP, persistence, fake execution, replay
  src/db/                        V2-only SQLite identity and migrations
  src/executions/                foundation-check lifecycle and reconciliation
  src/http/                      /api/v2 routes and snapshots
  src/profiles/                  V2 profile discovery and approval
  src/projects/                  V2 repository registration
  src/realtime/                  V2 durable event publication and replay
apps/v2-web/                     M1 V2 selector, focused shell, and projection
packages/v2-contracts/           V2-only wire schemas and types
e2e-v2/                         fake-only built-process Todo restart acceptance
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
