# Mesh V2 Milestone 5: Finite Parallel Runs Design

**Status:** Approved

**Date:** 2026-09-02

**Base:** `d479dd6c2a2c3b3b9da60f617cdd7e5a4d18f8fa`

**Parent architecture:**
[Mesh V2 Architecture](2026-08-27-mesh-v2-architecture-design.md)

**Predecessor:**
[Milestone 4 Single-Task Execution](2026-09-01-mesh-v2-milestone-4-single-task-execution-design.md)

## Outcome and Stop Condition

Milestone 5 lets an operator authorize one finite run over an explicit,
dependency-closed selection of current V2 tasks. Mesh freezes the selected
tasks, their exact Developer profiles, the current integration base, and a
bounded concurrency limit, then launches dependency-ready work through the
Milestone 4 Developer boundary in deterministic order.

The milestone stops when the built-process fake-only Todo scenario proves that
the independent frontend and backend tasks run concurrently at concurrency two,
while their dependent task remains waiting until both prerequisite tasks have
committed valid Developer completion reports. The dependent task must then
launch exactly once. Run state, capacity, attempts, attention, command results,
and ordered events must remain byte-equivalent through refresh, replay,
retained-gap resync, and server restart.

No process exit, browser projection, transcript, elapsed time, or uncommitted
runtime observation may advance an item or release a slot.

## Scope Boundary

### In scope

- One nonterminal `ExecutionRun` per project.
- Explicit nonempty task selection from the current approved plan.
- Dependency-closed membership: every incomplete active prerequisite of a
  selected task must also be selected.
- One exact compatible approved Developer profile revision per selected task.
- A product concurrency limit from one through four.
- Explicit operator confirmation that concurrent work consumes subscription
  capacity.
- Immutable run input and deterministic task order.
- Durable item claims before Developer launch side effects.
- Dependency-aware launch, bounded parallelism, Pause, Resume, Stop, attention,
  completion, and restart reconciliation.
- Strict HTTP commands, ordered project events, snapshots, replay, resync, Board
  projection, accessible controls, and deterministic fake-only acceptance.

### Explicit exclusions

- QA attempts, verdicts, rework loops, integration, merge, milestone completion,
  release, or pull-request authority; Milestone 6 owns them.
- Combining predecessor worktrees before a dependent task starts. Every M5
  attempt uses the run's frozen integration base; consuming integrated
  predecessor artifacts begins in Milestone 6.
- Continuous scheduling, recurring runs, tasks admitted after authorization,
  dynamic priorities, queue reprioritization, or retry budgets.
- Cross-project capacity, quota measurement, quota prediction, or automatic
  model and billing substitution.
- Interrupting active work as part of Pause or Stop.
- Worktree cleanup, branch deletion, reset, rebase, merge, push, or archival.
- Real Codex, Claude Code, or other subscription-backed adapters as acceptance
  requirements.
- V1 contracts, tables, services, runtime state, UI, or migration.
- A generic scheduler, workflow engine, queue provider, lock service, or role
  framework.

## Approaches Considered

### Selected: explicit dependency-closed task set

The operator selects exact tasks and an exact Developer profile revision for
each. The server rejects a selection that omits an incomplete active
prerequisite. This produces the smallest authorization that can still prove the
required frontend/backend/dependent sequence, makes every launch explainable,
and prevents hidden admission of unrelated work.

### Rejected: milestone-driven expansion

Selecting milestones and automatically including all active tasks is simpler
to click but broadens authority when a milestone contains unrelated or newly
revised work. It also obscures which profile and subscription choice authorized
each task.

### Rejected: browser-owned queue

Letting the browser issue multiple existing Developer start commands would not
produce durable concurrency ownership, restart recovery, or an auditable frozen
run. Disconnecting the browser would also change product behavior. Scheduling
therefore belongs to the server.

## Authority and Existing Boundaries

Milestone 3 remains authoritative for the current approved plan, immutable task
contracts and operational revisions, dependency graph, requirement traces,
readiness calculation, and Board projection. The run service asks M3 whether a
task is actionable; it does not implement a second readiness rule.

Milestone 4 remains authoritative for Developer attempts, managed workspace
reservation and verification, compatible profile enforcement, execution
activation, interruption, structured report settlement, task completion, audit
ordering, and repair states.

A concrete `ExecutionRunService` owns only finite-run authority:

- validate and freeze a run;
- serialize scheduling decisions per project;
- claim eligible run items while capacity exists;
- invoke an internal run-authorized Developer start entry point;
- reconcile committed task and attempt outcomes into item state;
- pause, resume, stop, complete, and recover a run.

`DeveloperAttemptService.start` remains the human HTTP path. M5 adds an internal
`startFromRun` method whose input is constructed by `ExecutionRunService` and
contains the bound run and item IDs. The HTTP command union never accepts a
run-system actor supplied by a client. Both entry points converge before the
existing M4 readiness, profile, billing, audit, workspace, and execution checks.

The execution runtime remains harness-neutral and owns no task, dependency,
item, or run transition. The browser remains a projection and command surface.

## Frozen Authorization

Starting a run is one human-only, idempotent project command. In one consistent
transaction Mesh validates:

- the audit barrier is healthy and no API billing override is present;
- the project, repository identity, current integration commit, approved intent,
  ledger, and delivery plan are exact and current;
- no nonterminal run already exists for the project;
- the selected task IDs are distinct, nonempty, current pending members of that
  plan and their milestones are active;
- the selection is dependency-closed for every incomplete active prerequisite;
- no selected task has a controlling Developer attempt;
- each selected profile revision is approved, in global or project scope,
  resolves successfully, and is exactly compatible with `developer_task` and
  `mesh.dev/developer-report/v1`;
- concurrency is an integer from one through four;
- subscription-capacity confirmation is exactly `true`.

The same transaction inserts the run and all items, appends the first ordered
run event, and stores the terminal command result. Failure inserts none of this
state and causes no workspace or harness effect.

The run freezes:

- approved intent, ledger, and delivery-plan IDs and revisions;
- project repository identity and current integration commit;
- concurrency and subscription confirmation;
- selected task identity, contract revision, current operational revision,
  requirement revisions, and active prerequisite IDs;
- the complete resolved profile snapshot and digest selected for each task;
- deterministic order by milestone ordinal, task rank, then task ID;
- one stable launch idempotency key per item.

Later plan replacement, task revision, profile approval, Board filtering, or
reordering cannot mutate the run. A changed task may make its item require
attention, but it never causes the scheduler to substitute newer input.

## Durable Model

The contracts add branded `ExecutionRunId` and `ExecutionRunItemId` values and
strict schemas equivalent to these shapes:

```ts
type ExecutionRunLifecycle =
  | 'running'
  | 'paused'
  | 'stopping'
  | 'completed';

type ExecutionRunCompletionReason = 'finished' | 'stopped';

type ExecutionRunItemLifecycle =
  | 'waiting'
  | 'launch_pending'
  | 'active'
  | 'completed'
  | 'attention_required'
  | 'not_started';

type ExecutionRun = {
  id: ExecutionRunId;
  projectId: ProjectId;
  revision: number;
  lifecycle: ExecutionRunLifecycle;
  completionReason: ExecutionRunCompletionReason | null;
  deliveryPlanId: DeliveryPlanId;
  deliveryPlanRevision: number;
  intentRevision: number;
  ledgerRevision: number;
  repositoryIdentity: RepositoryIdentity;
  baseCommit: GitObjectId;
  concurrencyLimit: number;
  subscriptionCapacityConfirmed: true;
  attention: { code: string; message: string } | null;
  itemIds: readonly ExecutionRunItemId[];
  counts: {
    waiting: number;
    launchPending: number;
    active: number;
    completed: number;
    attentionRequired: number;
    notStarted: number;
  };
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;
};

type ExecutionRunItem = {
  id: ExecutionRunItemId;
  runId: ExecutionRunId;
  projectId: ProjectId;
  taskId: TaskId;
  ordinal: number;
  revision: number;
  lifecycle: ExecutionRunItemLifecycle;
  taskContractRevision: number;
  taskCurrentRevision: number;
  requirementRevisions: readonly RequirementRevisionRef[];
  prerequisiteTaskIds: readonly TaskId[];
  profileSnapshot: ResolvedWorkerProfileSnapshot;
  launchIdempotencyKey: string;
  developerAttemptId: DeveloperAttemptId | null;
  attention: { code: string; message: string } | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;
};
```

Run counts are transactionally derived from the current item rows whenever the
run changes. They are stored with the run so snapshots and events expose one
self-consistent aggregate, but item rows remain the canonical per-task detail.

V2 persistence adds `execution_runs` and `execution_run_items` with foreign
keys, lifecycle checks, optimistic revisions, immutable frozen-input columns,
and a partial unique index allowing at most one nonterminal run per project.
Profile snapshots, requirement refs, prerequisite IDs, counts, attention, and
terminal command results use canonical JSON and existing bounded parsers.

## Lifecycle Invariants

Run lifecycle is:

```text
running <-> paused
running  -> stopping -> completed(stopped)
paused   -> stopping -> completed(stopped)
running  ------------> completed(finished)
```

An item lifecycle is:

```text
waiting -> launch_pending -> active -> completed
                    |          |----> attention_required
                    |---------> attention_required
waiting ----------------------> attention_required
waiting ----------------------> not_started
```

`launch_pending` and `active` both occupy capacity. Their sum may never exceed
the frozen concurrency limit. A terminal run has no `launch_pending` or
`active` item. A finished run has no `waiting` or `not_started` item. A stopped
run has at least one explicit Stop command but need not have a `not_started`
item if all work had already launched.

`completed` means the exact frozen task contract reached M4 `completed`
operational lifecycle through a valid Developer report. It does not mean the
workspace was integrated. `attention_required` is terminal for this run item;
later human repair may make the task eligible for a future run but does not
reopen history.

## Scheduling and Data Flow

`ExecutionRunService.drainProject(projectId)` is a per-project single-flight
loop. It always re-reads durable state and, while the run is `running` and
capacity exists:

1. Reconcile nonterminal items against current task and Developer-attempt truth.
2. Close active items whose exact task outcome is committed.
3. Mark impossible waiting dependents attention-required when an in-run
   prerequisite is terminal without completion.
4. Choose the first waiting item in frozen order whose existing M3 readiness is
   `actionable` and whose frozen revisions still match.
5. In one transaction revalidate run capacity and authority, transition the item
   to `launch_pending`, and append the ordered run event.
6. After commit, call `DeveloperAttemptService.startFromRun` with the stable item
   idempotency key and frozen profile selection.
7. In one transaction link the returned attempt and change the item to `active`,
   or record a classified attention outcome.
8. Publish only the events returned by committed transactions, then continue
   until capacity is full or no item is actionable.

The loop is triggered after run commands, after a Developer report consumer has
committed an outcome, and during startup recovery. A process-local single flight
avoids redundant effects; database transactions, revisions, stable command
keys, and the nonterminal-run uniqueness constraint provide correctness.

M5 does not add timed leases. Claims remain durable until reconciliation proves
their outcome.

## Attention and Failure Classification

Task-local conditions terminate one item, release capacity, and allow
independent work to continue:

- a valid Developer blocker;
- a frozen task, plan, profile, or prerequisite mismatch;
- a conflicting manual attempt;
- a known workspace, adapter, execution, or start failure whose ownership and
  effects are unambiguous;
- an interrupted or attention-required controlling attempt;
- an in-run prerequisite that ended attention-required or not-started.

Project-wide uncertainty pauses the run before any further claim:

- repository identity or the frozen base can no longer be proven;
- audit persistence or event ordering fails;
- an API-billing override is present;
- run, claim, attempt, or concurrency ownership is inconsistent;
- the scheduler cannot prove whether a launch effect occurred;
- aggregate counts disagree with item truth.

The pause transition records a typed attention message on the run and an ordered
event when audit persistence remains available. An audit-barrier trip remains
the stronger server-wide containment mechanism and stops publication and new
effects as required by M1.

## Pause, Resume, Stop, and Completion

Pause is reversible. After its transaction commits, no new item may enter
`launch_pending`; existing launch-pending and active work continues and its
outcomes remain recorded. Resume revalidates project, billing, audit, run
revision, aggregate counts, and frozen base identity before returning the same
run to `running` and draining it.

Stop is irreversible. Its transaction changes the run to `stopping`, marks all
waiting items `not_started`, and revokes future launch authority. It does not
interrupt launch-pending or active Developer attempts. Once those items become
completed or attention-required, the run becomes `completed` with reason
`stopped`.

A running run becomes `completed` with reason `finished` when every item is
either completed or attention-required and no launch-pending or active item
remains. Completion is durable and cannot be reopened.

All controls require the expected run revision and use the existing command
idempotency model. Duplicate delivery returns the original result; a stale
command reloads current project truth and never silently retries.

## Restart Reconciliation

Startup first performs existing execution and Developer-attempt reconciliation.
It then reconciles every nonterminal run before accepting commands:

- `active` plus the linked exact attempt remains active or becomes its proven
  completed/attention outcome;
- `launch_pending` plus a replayable successful M4 command links the existing
  attempt without creating another;
- `launch_pending` with proven absence of all M4 effects repeats the same
  idempotent internal start;
- an ambiguous effect, link, capacity count, repository identity, base, or
  ownership pauses the run with diagnostics;
- `stopping` closes waiting items and completes after active capacity drains;
- impossible waiting dependents become attention-required with their exact
  prerequisite blockers.

Committed recovery events are published in order before command acceptance.
Reconciliation never expires a claim by time, guesses from a process exit or
transcript, reopens a terminal item, changes frozen membership, or deletes a
workspace.

## Commands, Results, Events, and Snapshots

The existing local-origin `/api/v2/commands` route gains four human envelopes:

```ts
type StartExecutionRunCommand = {
  type: 'execution_run.start';
  projectId: ProjectId;
  expectedDeliveryPlanId: DeliveryPlanId;
  expectedDeliveryPlanRevision: number;
  expectedBoardFilterRevision: number;
  selections: readonly {
    taskId: TaskId;
    expectedTaskRevision: number;
    profileId: WorkerProfileId;
    profileRevision: number;
  }[];
  concurrencyLimit: number;
  subscriptionCapacityConfirmed: true;
};

type PauseExecutionRunCommand = {
  type: 'execution_run.pause';
  projectId: ProjectId;
  runId: ExecutionRunId;
  expectedRunRevision: number;
};

type ResumeExecutionRunCommand = {
  type: 'execution_run.resume';
  projectId: ProjectId;
  runId: ExecutionRunId;
  expectedRunRevision: number;
};

type StopExecutionRunCommand = {
  type: 'execution_run.stop';
  projectId: ProjectId;
  runId: ExecutionRunId;
  expectedRunRevision: number;
};
```

`expectedBoardFilterRevision` proves which visible selection the operator
reviewed but never changes membership server-side; every named task is still
validated against canonical unfiltered plan truth. Start selection uses the
existing approved-plan task-array bound and rejects duplicates.

One `execution_run.changed` domain event carries the complete run and ordered
items. The payload is strict and project-coherent. One aggregate event avoids
browser-observable partial item/run state and follows existing complete Board
payloads. Runtime events remain unchanged.

`ProjectSnapshot` adds `executionRuns`, ordered newest first, and the Board cards
add their current run item summary when one exists. Snapshots retain complete
terminal run history for M5; history pagination is deferred until measured
volume requires it.

New typed failures distinguish missing/stale run authority, non-closed task
selection, incompatible profile, concurrency bounds, subscription confirmation,
active-run conflict, item conflict, and unsafe recovery. They use existing HTTP
status mapping and never expose raw diagnostics as user copy.

Successful Start/Pause/Resume/Stop results return the complete committed run
and ordered items under their exact command discriminator. Failed results use
the same command discriminator plus the typed error. This lets command replay
return the original aggregate without reconstructing it from newer state.

## User Experience

The Board remains one cohesive pane. Its run section has two states.

With no nonterminal run, the operator can select pending cards from the current
filtered view. Selecting a dependent also selects its visible incomplete
prerequisites when possible; the server remains authoritative and reports any
missing prerequisite precisely. Each selected task has a compatible Developer
profile selector. The form provides concurrency values one through four,
defaults to one, and requires a checkbox labeled to state that concurrent starts
consume Claude subscription capacity. Start is disabled while disconnected,
stale, resyncing, submitting, empty, missing a profile, or unconfirmed.

With a nonterminal run, the section displays lifecycle, occupied capacity,
frozen concurrency, completion counts, and items in frozen order. Each item
links to existing task and Developer-attempt detail and shows waiting blockers,
active execution, completion, attention, or not-started explanation. Pause,
Resume, and Stop expose only legal transitions. Stop explains that active work
continues unless separately interrupted.

Status never relies on color. Controls have accessible names and visible
disabled reasons. Typed stale/conflict errors keep context open, announce and
focus the error, fetch current project truth, and never silently retry.

## Fake-Only Todo Acceptance Scenario

The M4 built-process Todo journey is extended rather than replaced.

1. Create a temporary Git repository and V2 database, approve Todo intent and a
   delivery plan containing frontend, backend, and dependent integration tasks,
   then approve two compatible Developer profile revisions.
2. Select all three tasks, assign exact profiles, choose concurrency two,
   confirm subscription capacity, and start from exact plan, Board, and task
   revisions.
3. Assert the server freezes one run and three items in milestone/rank/task-ID
   order at one base commit. No V1 or real-adapter state exists.
4. Hold both fake Developer executions after their durable start. Assert the
   frontend and backend items are active concurrently, occupied capacity is two,
   the dependent remains waiting on both exact prerequisite IDs, and a third
   attempt does not exist.
5. Release only the frontend completion. Assert its item completes, backend
   remains active, dependent remains waiting on the backend, and capacity is
   one without a duplicate launch.
6. Pause, then release backend completion. Assert M3 now reports the dependent
   actionable but no third attempt exists while the run is paused. Refresh and
   resume from the exact run revision, then assert the dependent launches
   exactly once with the frozen profile and base.
7. Restart the server while the dependent is active. Assert execution,
   workspace, attempt, run item, capacity, commands, and cursors reconcile
   without duplication, then complete the dependent and the run.
8. Start a second run fixture, Stop while two items are active, assert remaining
   waiting items become not-started, active work is not interrupted, and the run
   completes as stopped after drain.
9. Force retained-gap resync and assert the rebuilt run, items, Board summaries,
   attempts, reports, and cursors equal a fresh snapshot.
10. Assert default verification created only temporary repositories, worktrees,
    databases, and fake sessions and never read or set `ANTHROPIC_API_KEY`.

## Verification Strategy

Contract tests cover every schema, lifecycle union, command envelope, bounded
selection and concurrency, strict unknown-key rejection, project coherence,
snapshot/event round trip, aggregate consistency, and internal-actor exclusion
from HTTP.

Persistence tests cover fresh migration and reopen, canonical snapshots,
foreign keys, lifecycle checks, frozen-column immutability, optimistic
revisions, nonterminal-run uniqueness, command replay, atomic start/control
failure injection, aggregate/item consistency, and event ordering.

Focused service tests prove dependency closure, exact profile and revision
freezing, stable order, no empty or concurrent run, capacity across start,
failure, duplicate delivery, and restart, internal M4 composition without a
public system actor, task-local continuation, project-wide pause, impossible
dependent attention, Pause/Resume/Stop, and all reconciliation branches.

Web tests cover selection, prerequisite assistance, per-task profile choice,
concurrency confirmation, disabled reasons, progress, capacity, item evidence,
attention, legal controls, stale failures, disconnect, replay, and resync.

The built-process acceptance test proves the complete Todo stop condition. Run
focused Nx targets during iteration and `corepack pnpm verify` with
`NX_DAEMON=false` and `NX_SKIP_NX_CACHE=true` on the final exact head. No normal
test starts external Claude traffic.

## Affected Surface Decisions

- **Contracts:** required for run IDs, schemas, commands, errors, events,
  snapshots, and Board item summaries.
- **Commands:** required for strict local-origin Start/Pause/Resume/Stop routes;
  internal run launch is not a public actor.
- **Runtime:** existing harness execution remains unchanged; M5 composes its
  reservation and activation boundaries.
- **Persistence:** required for new V2 run/item tables, migration, atomicity,
  command replay, and startup reconciliation.
- **Realtime:** required for durable run aggregate events and existing
  replay/resync behavior; no transient run state is added.
- **Web:** required inside the existing Board experience; no new permanent pane
  or client-side scheduler is added.
- **Workspace safety:** existing M4 deterministic ownership and preservation
  rules remain authoritative; M5 adds no cleanup.
- **Operating modes:** fake-only deterministic acceptance and Windows path
  coverage are required; real adapters remain opt-in and outside acceptance.
- **Reverse states:** Pause/Resume and Stop/drain are explicit and tested;
  terminal runs and items never reopen.
- **Documentation:** architecture and V2 operating guidance must describe finite
  runs, subscription confirmation, controls, attention, and restart behavior.

## Settled Decisions and Stop Proof

- Selection is explicit and dependency-closed, not milestone-expanded.
- One exact compatible resolved Developer profile is frozen per item.
- Concurrency is a fixed product bound of one through four and requires explicit
  subscription-capacity confirmation.
- M3 readiness is the only actionable calculation.
- M4 Developer authority, workspace safety, and report completion remain intact.
- A private run-authorized start path cannot be forged through HTTP.
- Launch intent is durable before effects and occupies capacity.
- Task-local failures release capacity; project-wide uncertainty pauses.
- Pause is reversible; Stop is irreversible and does not interrupt active work.
- Restart repeats only a proven-absent launch through its stable idempotency key.
- Browser state never schedules or completes work.
- M5 does not integrate predecessor workspaces; M6 owns QA and integration.
- Default proof is fake-only, temporary, restart-aware, and subscription-safe.
- V1 and generic scheduling machinery remain absent.

Milestone 5 is complete only when current repository evidence proves every
clause above and the full fake Todo stop condition passes on the exact reviewed
head.
