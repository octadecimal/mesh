# Milestone 5 Project Orchestration Design

**Date:** 2026-08-27
**Status:** Draft for written review

## Prerequisite

Milestone 5 builds on the implemented Milestone 3 Developer execution and
Milestone 4 QA execution flows. Those milestones provide explicit, durable,
and restart-safe commands for initial Developer launch, Developer completion
and blockers, QA launch and verdicts, bounded autonomous review and rework, and
human repair. Project orchestration invokes those boundaries; it does not
replace or generalize them.

## Product outcome

Milestone 5 lets an operator authorize one finite project run over a frozen
snapshot of ready tasks. Mesh launches those tasks in stable task-board order,
keeps no more than the operator-selected number active at once, and continues
independent work when one task needs human attention.

A run is an explicit subscription-usage authorization, not an always-on
scheduler. Tasks created or made ready after authorization wait for another
run. Each task's effective review mode, derived from project policy and its
task-level automation state, determines whether it can reach `done` without
intervention or stops at a human decision boundary.

## Goals

- Snapshot the eligible ready-task queue when an operator starts a run.
- Let the operator select a per-run concurrency limit, defaulting to one.
- Fill available capacity in frozen task-board order.
- Prevent duplicate launches across races, replay, and server restart.
- Continue independent queued work after a task-local blocker, manual-review
  boundary, exhausted rejection budget, or isolated failure.
- Pause the whole run when project-wide authority or safety cannot be proven.
- Let an operator pause, resume, or stop future launches without silently
  interrupting active work.
- Preserve run authorization, scheduling decisions, item outcomes, and repair
  evidence as durable project history.
- Reuse existing Developer, QA, task, session, and workspace authority.
- Preserve subscription-only operation, audit ordering, workspace safety,
  reconnect convergence, and truthful restart recovery.

## Non-goals

- Continuous scheduling or admission of tasks that become ready after a run
  starts.
- Task dependencies, PM planning, or automatic task creation and prioritization.
- Global, cross-project, quota-aware, or forecast-based scheduling.
- Automatic retry of work that needs human attention.
- Automatic commits, pull requests, merges, or worktree cleanup.
- Per-item queue editing or reordering after run authorization.
- General roles, workflow definitions, prompt profiles, or an orchestration
  framework.
- API-key or pay-per-token billing.

## Architecture and authority

Project orchestration belongs in the existing task domain as a concrete
`ProjectRun` service. It owns bounded initial-launch authority and reacts to
committed task outcomes. It does not own Developer or QA execution and does not
infer outcomes from transcripts, streaming state, or browser projections.

The operator may start, pause, resume, and stop a run. Starting a run grants the
orchestrator authority to claim and initially launch only the tasks in that
run's immutable snapshot and only up to its concurrency limit. The orchestrator
invokes the existing audited task-launch boundary with a system actor bound to
the run and run item.

Existing services retain their authority:

| Owner | Authority |
| --- | --- |
| Operator | Start a finite run; choose its concurrency; pause or resume future launches; permanently stop future launches. |
| Project orchestrator | Claim and initially launch frozen queued tasks; observe committed outcomes; release capacity; select the next frozen item. |
| Task and attempt services | Validate readiness, create attempts and sessions, compose startup, and own legal task transitions. |
| Developer execution | Own Developer cycles, completion reports, blockers, rework, and Developer capabilities. |
| QA execution and review automation | Own QA cycles, verdicts, manual boundaries, bounded autonomous review and rework, and their repair states. |

The orchestrator cannot edit task content, change task rank, alter review
policy, admit new queue members, resolve blockers, manufacture reports or
verdicts, change workspaces, broaden agent permissions, interrupt active work
as part of Stop, clean worktrees, commit, merge, or create a pull request.

Only one nonterminal run may exist for a project. Other projects may run
independently under their own run authorizations. Milestone 5 adds no global
capacity or quota authority.

## Run authorization and frozen queue

Starting a run is one atomic project-domain command. Mesh revalidates the
project, operator, billing environment, and absence of another nonterminal run,
then selects tasks that are currently `ready`, unblocked, launchable, and not
owned by another active attempt or run.

The command persists the run and one run item per eligible task in a single
transaction. An empty eligible set is rejected rather than producing an empty
history record. Each item snapshots:

- Task identity and current task revision.
- Queue position derived from current task-board rank.
- Project review policy and revision plus the task's automation state and
  generation visible at authorization time.
- Stable task ID tie-breaker.
- Initial `queued` status.

The policy snapshot records what the operator saw; the existing task-domain
policy remains authoritative when work executes. If project policy, task
automation state, or task content changes before launch, revision revalidation
fails closed and the item requires attention rather than executing under stale
authorization.

Tasks are ordered by snapshotted board rank and then stable task ID. Later board
reordering, new tasks, and tasks that become ready later do not alter the run.

The operator chooses a positive concurrency limit when starting the run. The UI
defaults it to one and confirms that concurrent launches consume Claude
subscription capacity. The server validates a finite product-defined maximum;
the exact maximum is an implementation and operational setting, not authority
to forecast or optimize quota.

## Durable model

A project run records:

- Stable run ID and owning project ID.
- Authorizing operator and command.
- Selected concurrency limit.
- Lifecycle state and state revision.
- Start, pause, resume, stop, drain, and completion evidence.
- Completion reason and aggregate outcome counts.
- Ordered run items.

Run lifecycle is:

- `running`: new items may be claimed while capacity exists.
- `paused`: no new items may be claimed; active work continues.
- `draining`: Stop has permanently revoked future launch authority; queued items
  are closed without launch while active work continues.
- `completed`: no launch-pending or active items remain.

A completed run records `queue_finished` or `stopped` and counts of completed,
attention-required, and not-started items. A completed run never reopens.

Each run item records its task snapshot, stable queue position, scheduling
status, launch idempotency key, claim evidence, linked attempt and session when
created, outcome reason, and transition timestamps. Item lifecycle is:

```text
queued -> launch_pending -> active -> completed
                                   -> attention_required
queued ----------------------------> attention_required
queued ----------------------------> not_started
```

`launch_pending` is durable intent written before invoking task launch. It
counts against concurrency so slow, failed, or restarting launches cannot
oversubscribe the run. `active` continues to count until the item reaches
`completed` or `attention_required`.

`completed` means the task reached `done`. `attention_required` means the item
can make no further progress under current authority, including a Developer
blocker, a manual QA or decision boundary, the autonomous rejection ceiling, a
stale task revision, a conflicting manual launch, or an isolated runtime or
workspace failure. `not_started` means Stop revoked authority before launch.

Resolving an attention item later does not reopen the item or run. The operator
may use existing human commands and, once a task becomes eligible again, include
it in a future run.

## Scheduling and data flow

The orchestrator is driven only by committed run and task-domain outcomes. For
each available slot it:

1. Re-reads the current run, run item, and task.
2. Confirms the run remains `running`, the item remains `queued`, and the task
   remains at its snapshotted revision in launchable `ready` state.
3. Atomically changes the item to `launch_pending` and records a durable claim
   on the task using the item's stable launch idempotency key.
4. Invokes the existing initial Developer launch path with a system actor bound
   to the run and item.
5. Links the resulting attempt and session and changes the item to `active`.
6. Observes committed task, Developer, QA, and review-automation outcomes.
7. Changes the item to `completed` or `attention_required`, releases its slot,
   and considers the next frozen item.

The claim and task launch must share an idempotent composition boundary. A
manual launch racing the orchestrator cannot create two current attempts. If
the task was edited, blocked, archived, manually launched, or otherwise made
ineligible before claim, the item becomes `attention_required` and scheduling
continues with the next item.

Manual-review tasks are valid run members. Their Developer work launches like
any other item, but the item becomes `attention_required` when existing policy
requires a human QA launch or verdict decision. Autonomous-review tasks may
continue through the bounded Developer-to-QA loop and reach `done` without more
operator input.

All run, item, claim, and scheduling outcome writes append ordered project
events in the same transaction before realtime publication. The browser is a
projection of that durable history.

## Pause, resume, and stop

Pause is reversible. Once its command is durably committed, no new item may
enter `launch_pending`. Existing launch-pending and active items continue and
may release their slots. Resume revalidates run and project safety, changes the
same run back to `running`, and fills capacity from its unchanged frozen queue.

Stop is irreversible. It changes the run to `draining`, atomically marks all
remaining queued items `not_started`, and revokes future launch authority.
Launch-pending and active items are not interrupted; they continue to a normal
terminal or attention boundary. Once none remain, the run completes with the
`stopped` reason.

Stop does not replace the existing explicit session-interruption controls. An
operator who also wants to interrupt active work must do so separately, with
the existing session and audit semantics.

Commands use expected run revisions and idempotency keys. A stale browser must
refresh rather than overwrite newer run state. Duplicate Pause, Resume, or Stop
delivery returns the original committed outcome where appropriate.

## Failure classification and recovery

Task-local conditions affect one run item and release its capacity:

- Developer blocker or manual-review boundary.
- Autonomous rejection ceiling.
- Stale task revision or a conflicting manual launch.
- Isolated attempt, session, Developer, QA, workspace, or startup failure whose
  ownership and outcome are known.
- An existing task-domain repair state that forbids further automatic action.

Project-wide uncertainty pauses the run before another launch:

- Repository identity or ownership cannot be proven.
- Audit persistence fails or event ordering cannot be preserved.
- A billing-environment conflict would permit API-backed execution.
- Run, claim, or concurrency ownership is inconsistent or ambiguous.
- The scheduler cannot prove whether launching another item would exceed the
  authorized concurrency limit.

Claims are durable ownership records, not expiring time leases. Mesh never
assumes work is abandoned because a wall clock elapsed.

At startup, reconciliation compares every `launch_pending` and `active` item
with durable task, attempt, session, Developer-cycle, QA-cycle, and review-
automation truth:

- Proven launch success reconnects the item to its existing active work.
- Proven absence of launch effects safely repeats the same idempotent launch.
- Proven terminal task state closes the item consistently.
- A known task-local repair condition changes the item to
  `attention_required`.
- An ambiguous launch result or concurrency count pauses the run and records a
  specific repair condition.

Reconciliation never creates a second attempt, guesses that a transcript or
process exit is an outcome, expires a claim by time, reopens a completed item,
or silently discards frozen membership.

## Realtime and web projection

Runs, items, queue order, concurrency, claims, transitions, outcomes, pause and
repair conditions are durable project state. They appear in project snapshots
and ordered project events. Project-local replay and resynchronization follow
the existing cursor rules.

The task board adds a project-run area with:

- A Start Run view that previews the exact eligible tasks in frozen order,
  displays their review policies, selects concurrency with a default of one,
  and requires explicit subscription-usage confirmation.
- An active-run view showing lifecycle state, occupied capacity, queued tasks,
  active roles and cycles, completed work, attention-required items, and
  project-wide repair state.
- Server-authoritative Pause, Resume, and Stop controls appropriate to the
  current lifecycle.
- A clear Stop explanation that active work drains rather than being
  interrupted.
- Links from attention items to the existing task drawer and its Developer, QA,
  blocker, report, or repair evidence.
- Durable run history showing original membership and order, authorization,
  state transitions, item outcomes, completion reason, and aggregate counts.

A disconnected or stale client never presents an optimistic scheduling change
as committed. Reconnect converges on the server's snapshot and project-event
truth. Changing task rank, task content, or review settings while a run exists
warns that frozen membership and order do not change and that a stale queued
task will not launch.

Milestone 5 does not add in-run drag ordering, queue membership edits,
per-item retry buttons, quota prediction, or a global multi-project dashboard.

## Persistence and compatibility

The schema migration is additive. Existing projects, tasks, attempts, Developer
cycles, QA cycles, and project events continue to decode with no run history.
No run is inferred from pre-Milestone 5 attempts.

Repositories own run, item, claim, and repair persistence. The project-run
service owns authorization, capacity, selection, lifecycle, and failure
classification. Existing task services remain responsible for launch and task
lifecycle rules. HTTP and realtime layers validate and transport commands and
events without scheduling decisions.

Run creation, item claims, lifecycle changes, outcome recording, aggregate
counts, task associations, and ordered project events commit atomically at the
appropriate domain boundary before publication. Migrations preserve foreign
keys to projects, tasks, attempts, sessions, and commands without rewriting
existing history.

## Verification strategy

Contract tests cover:

- Run and item schemas, lifecycle values, completion reasons, and outcome
  consistency.
- Start, Pause, Resume, and Stop commands with actor and expected-revision
  validation.
- Project snapshot and event variants with backward-compatible defaults.
- Stable queue positions, task-revision snapshots, attempt/session links, and
  repair diagnostics.

Focused backend tests prove:

- Run creation selects only eligible ready tasks and atomically freezes their
  revisions, policies, and stable order.
- Empty runs and concurrent nonterminal runs for one project are rejected.
- The selected concurrency limit is never exceeded during ordinary launch,
  launch failure, duplicate delivery, replay, or restart.
- Run claims and task-attempt creation cannot race into duplicate launches.
- Pause prevents new claims while launch-pending and active work continues.
- Resume fills capacity from the unchanged frozen queue.
- Stop closes queued items as not started, revokes future launch authority, and
  drains active work.
- Manual-review boundaries, blockers, rejection ceilings, and isolated failures
  release their slots as attention-required.
- Stale task revisions, archive, and conflicting human actions fail closed.
- Task-local failures do not stall independent queued work.
- Project-wide safety failures pause before another launch.
- Reconciliation reconnects proven launches, repeats only proven-absent effects,
  and pauses on ambiguity.
- Audit writes precede realtime publication.

Web tests cover queue preview, empty eligibility, stable order, review-policy
labels, concurrency selection, subscription confirmation, active capacity,
progress and attention states, Pause/Resume/Stop feedback, drain explanation,
task-evidence links, run history, stale commands, disconnect, replay, and
project-local resynchronization.

A deterministic fake-driver acceptance path imports a temporary repository and
starts a frozen run over several tasks with concurrency two. One autonomous
task reaches done, one manual task stops for attention, one Developer reports a
blocker, and later queued work continues without exceeding capacity. The path
pauses and resumes the run, refreshes the browser, restarts the server, then
stops the run and proves active-work draining plus durable history.

Normal verification uses temporary repositories, a temporary database, and the
fake driver. It never contacts Claude or consumes subscription quota. The real
Claude smoke test remains separate and opt-in.

## Affected surfaces

- **Contracts:** run and item models, commands, project events, snapshots,
  errors, revisions, and backward-compatible defaults.
- **Commands:** start, pause, resume, and stop with explicit human authority;
  idempotent orchestrator launch with bound system authority.
- **Runtime:** capacity filling, committed-outcome observation, startup
  reconciliation, drain behavior, and safe pausing.
- **Persistence:** additive migration, frozen membership, claims, run/item
  ordering, atomic state changes, and repair evidence.
- **Realtime:** durable run projection, replay, reconnect, and project-local
  resynchronization.
- **Web:** queue preview, subscription consent, concurrency, progress,
  Pause/Resume/Stop controls, attention evidence, repair feedback, and history.
- **Workspace safety:** no new workspace authority; every launch continues
  through existing repository, ownership, and attempt checks.
- **Operating modes:** fake and real drivers, manual and autonomous review,
  concurrency one and greater than one, fresh and existing databases, restart,
  and Windows paths.
- **Reverse states:** start/complete, pause/resume, stop/drain, claim/release,
  connect/disconnect, and failure/recovery.
- **Documentation:** architecture and operating guidance for finite runs,
  subscription authorization, recovery, and deferred scheduling scope.

## Deferred roadmap

A later milestone may add task dependencies and a PM planning boundary. Another
may add delivery operations such as commit and pull-request preparation under
their own explicit authority and human approval. Continuous scheduling,
cross-project capacity, and quota-aware backoff require separate product and
safety decisions rather than extensions hidden inside this finite-run model.

A general workflow or role framework should be extracted only after concrete
Developer, QA, PM, orchestration, and delivery implementations demonstrate
repeated mechanics that cannot remain clear as explicit task-domain policies.

## Milestone stop condition

Milestone 5 is complete when an operator can authorize one durable, finite
project run over a frozen ready-task snapshot and trust Mesh to fill a bounded
number of slots until every run item is completed, needs attention, or was left
unstarted by Stop.

Every launch and scheduling decision must remain inspectable, idempotent,
restart-safe, subscription-backed, and constrained by existing Developer and
QA authority. Task-local problems must release capacity for independent work,
while any condition that makes project ownership, audit durability, billing
safety, or authorized concurrency ambiguous must stop new launches.
