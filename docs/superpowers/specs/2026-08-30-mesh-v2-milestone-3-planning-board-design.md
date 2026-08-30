# Mesh V2 Milestone 3: Planning and Board Design

**Status:** Approved by delegated campaign authority

**Date:** 2026-08-30

**Base:** `0ad20dd25e48ef390469fd51d5ff85b0249e1acc`

**Parent architecture:**
[Mesh V2 Architecture](2026-08-27-mesh-v2-architecture-design.md)

**Predecessor:**
[Milestone 2 Intent and Requirement Ledger](2026-08-29-mesh-v2-milestone-2-intent-ledger-design.md)

## Outcome and Stop Condition

Milestone 3 turns an approved intent ledger into one human-approved,
revisioned delivery plan and a server-owned Board projection. The project
manager may ask planning questions and propose a complete multi-milestone plan
containing milestones, tasks, dependencies, and exact requirement-revision
traceability. Proposal revision and rejection preserve immutable history. Only
an exact human approval transaction materializes canonical plan records.

Mesh, not the browser and not a worker, calculates whether each task is
actionable from three kinds of canonical truth: the current approved plan, the
task lifecycle, and active dependency state. Workspace availability,
`DeveloperAttempt`, worker selection, run authorization, concurrency, and wave
scheduling do not participate in the M3 calculation. M4 owns the first
single-task workspace/execution path; M5 owns finite `ExecutionRun` scheduling,
concurrency, and dependency-ready waves.

The milestone stops when the built-process fake-only Todo fixture proves all of
the following on one integrated commit:

1. an operator starts delivery planning from the exact approved Todo intent and
   ledger revisions;
2. one finite fake PM execution proposes a complete plan, and operator feedback
   produces a second immutable proposal revision while superseding the first;
3. exact human approval atomically creates one canonical delivery-plan revision
   with at least two milestones, three tasks, cross-milestone dependencies, and
   milestone/task links to exact requirement revisions;
4. no canonical milestone, task, dependency, trace, Board, event, or successful
   command result is partially visible after any injected approval failure;
5. the server calculates the two independent Todo tasks as actionable and the
   dependent integration task as blocked for the exact incomplete
   prerequisites;
6. the Board displays server-provided cards and supports persisted multi-
   milestone, lifecycle, readiness, priority, label, and requirement filters;
7. refresh, ordered replay, a forced retained-gap resync, and server restart
   reconstruct byte-equivalent planning history, canonical plan, saved filter,
   traceability, and readiness;
8. no test starts a workspace, `DeveloperAttempt`, worker execution loop, or
   `ExecutionRun`, and no real harness, credential, operator database, or
   subscription capacity is used.

Passing contract or repository tests alone is insufficient. The stop condition
requires the built V2 server and web application, a temporary Todo repository,
a temporary V2 database, and the deterministic fake adapter.

## Scope Boundary

### In scope

- an explicit delivery-planning purpose on the existing durable
  `PlanningCycle` aggregate;
- finite `pm_plan` assignments and strict
  `mesh.dev/pm-plan-report/v1` structured output;
- durable planning questions, complete plan proposals, proposal revisions,
  revision feedback, rejection, abandonment, and exact human approval;
- one stable project delivery-plan identity and immutable approved plan
  revisions;
- stable milestone, task, and dependency identities with immutable revisions;
- complete approved-plan membership snapshots and exact requirement-revision
  traceability;
- dependency validation, immutable dependency history, retirement and
  reactivation, and deterministic reverse readiness effects;
- a pure server-domain readiness calculation over approval, task lifecycle,
  and dependencies;
- one durable server-owned Board filter per project and a server-derived Board
  view across one, several, or all milestones;
- strict commands, command results, domain events, snapshots, replay, retained-
  gap resync, restart recovery, and audit-before-publication;
- delivery-planning review UI, the real Board pane, task detail within Board,
  and required accessible loading/error/empty/stale states;
- migration 3 from both a fresh database and the exact M2 schema, preserving
  all M1 and M2 history and replay results.

### Deferred

- workspace reservation or allocation, Git branches, worktrees, and repository
  mutation (M4);
- `DeveloperAttempt`, developer reports, task claims, worker assignment, worker
  interruption/replacement, and task execution loops (M4);
- `ExecutionRun`, run preview, concurrency limits, queue ownership, task waves,
  harness choice, and scheduling (M5);
- QA attempts, evidence acceptance, task-completion authority, integration,
  rework, and milestone-completion gates (M6);
- worker-attempt, QA, and attention filters, because those records do not exist
  in M3;
- drag-and-drop lifecycle mutation, calendar/estimate planning, templates,
  arbitrary saved views, graph visualization, impact analysis, and portfolio
  views;
- real PM adapters, persistent native PM sessions, advisory assignments, and a
  generic workflow or structured-output framework.

### Non-goals

- Predicting worker capacity or labeling a task ready because a worker is idle.
- Treating Board column position, a browser filter, PM prose, or process exit as
  canonical state.
- Letting a PM approve its own plan or create canonical work directly.
- Letting an M3 operator command mark implementation complete without the later
  accepted-evidence authority.
- Importing V1 plan, task, session, attempt, project-run, or Board contracts.
- Designing M4 or M5 while adding fields “for later.”

## Autonomous Questions and Answers

The campaign mandate replaces human wait gates, not design reasoning. These are
the consequential questions and the conservative choices used here.

1. **Is delivery planning a new aggregate or another use of
   `PlanningCycle`?** It is another explicit purpose of `PlanningCycle`.
   Conversation, questions, finite PM launches, attention, abandonment, and
   restart reconciliation already have one correct owner. A one-to-one purpose
   row extends that owner without copying its lifecycle.
2. **Should intent proposals and delivery-plan proposals share one schema or
   table?** No. They share cycle mechanics but remain separate strict artifacts
   and report schemas. Intent approval revises canonical intent; plan approval
   materializes work. A union-shaped catch-all proposal would weaken both
   boundaries.
3. **Is a plan proposal a patch?** No. It is the complete desired plan snapshot
   at one exact intent, ledger, and current-plan base. Complete snapshots make
   review, stale-base detection, DAG validation, atomic application, and replay
   deterministic.
4. **Does M3 create only mutable task rows?** No. It creates stable identities,
   immutable milestone/task/dependency revisions, and an immutable plan revision
   that names the exact members. Later executions must be able to freeze exact
   task revisions.
5. **What happens when requirements change after plan approval?** The approved
   plan remains historical and visible, but every pending task is blocked by
   `plan_stale` until a new exact plan revision is approved against the current
   intent and ledger. Mesh never silently carries old coverage forward.
6. **What is “actionable” in M3?** A task is actionable only when it belongs to
   the current approved, non-stale plan, its current lifecycle is `pending`, its
   milestone is active, and every active prerequisite is `completed`.
   Workspaces, runs, workers, and capacity are deliberately absent.
7. **Can M3 mark a prerequisite completed to demonstrate readiness?** No public
   M3 command can do so. `completed` is part of the readiness input contract so
   later authoritative services can use it, but M3 approval creates pending
   tasks only. M3 proves initial readiness plus dependency retirement/
   reactivation reversals without inventing completion evidence.
8. **How is dependency removal represented?** As a new immutable revision of a
   stable dependency with lifecycle `retired`. Reactivation creates another
   revision of the same identity. Endpoint changes retire one identity and
   create another; history is never overwritten.
9. **Who filters the Board?** The server. One revisioned filter is durable per
   project, the server applies it to canonical plan/readiness truth, and events
   and snapshots carry the resulting `BoardView`. The browser owns only the
   in-progress form draft.
10. **Should M3 add unassigned work, attempts, attention, or run filters because
    the parent architecture mentions them?** No. Only filters backed by M3
    records are implemented. Later milestones may extend the strict filter
    union when their records exist.
11. **Can two planning cycles run for one project if one is intent and one is a
    plan?** No. The M2 one-nonterminal-cycle invariant remains project-wide.
    This avoids two proposals racing over the same canonical intent.
12. **How are proposal-local IDs made canonical?** The server reserves UUIDs
    when it accepts the PM report, exactly as M2 does for ledger records. They
    remain noncanonical until that exact proposal is approved and are never
    reused after supersession, rejection, or abandonment.

## Approaches Considered

### Selected: extend `PlanningCycle`, keep plan artifacts specific

Add an explicit cycle purpose and base-plan revision while reusing M2 turns,
questions, finite launch coordination, receipts, attention handling, and
abandonment. Add a plan-specific assignment, report consumer, proposal store,
approval service, canonical plan store, readiness function, and Board service.

This is the smallest coherent vertical slice. It reuses the lifecycle that
already survived M2 concurrency and restart work, but it does not force the
intent proposal and plan proposal into one mutable or generic structure. The
cost is a deliberate extension of cycle views and the planning UI, plus a
migration that backfills the purpose of every M2 cycle.

### Alternative: separate `DeliveryPlanningCycle`

A separate aggregate could leave M2 types untouched. It would duplicate turns,
questions, limits, launch-pending arbitration, output receipts, abandon races,
reconciliation, snapshots, and UI state. The duplicated safety surface is much
larger than the one purpose discriminator and is rejected.

### Alternative: widen the M2 intent proposal into a generic change set

One generic proposal could hold intent records, milestones, tasks, profiles, or
future workflow objects. Its validators, approval effects, and UI would depend
on optional fields and runtime dispatch. That is a workflow framework before a
second concrete approval boundary is proven. It is rejected.

## Relationship to Milestone 2

### Planning cycle purpose

`PlanningCycle` gains:

```ts
type PlanningCyclePurpose = 'intent' | 'delivery_plan';

type PlanningCyclePurposeState = {
  planningCycleId: PlanningCycleId;
  purpose: PlanningCyclePurpose;
  baseDeliveryPlanRevision: number | null;
};
```

Migration 3 stores this as a one-to-one sidecar rather than rebuilding M2's
`planning_cycles` table. It backfills every existing cycle as `intent` with a
null plan base. Every new cycle inserts its purpose row in the same transaction
as the cycle. Repository reads fail closed if the sidecar is missing.

An intent cycle continues to use `planning_cycle.submit_turn`,
`PmDiscoveryAssignment`, `mesh.dev/pm-discovery-report/v1`, and M2 intent
proposals unchanged. A delivery-plan cycle uses
`planning_cycle.submit_plan_turn`, `PmPlanAssignment`, and
`mesh.dev/pm-plan-report/v1`. Both use the existing cycle lifecycle:

```text
discovering -> launch_pending -> execution_active
execution_active -> awaiting_human | awaiting_approval | attention_required
awaiting_human -> launch_pending
awaiting_approval -> launch_pending        (revision feedback)
awaiting_approval -> approved | proposal_rejected
any nonterminal state -> abandoned
```

The existing project-wide partial unique index still permits at most one
nonterminal cycle across both purposes. `planning_cycle.abandon` remains common
to both. Existing M2 history limits remain: at most 32 human turns, 32 PM turns,
and 16 proposal revisions per cycle.

`PlanningCycleView` retains M2's `proposals` field for intent proposals and adds
`deliveryPlanProposals`. A strict refinement requires exactly the collection
matching the purpose to be populated. This avoids rewriting stored M2 proposals
or pretending the two proposal types have the same effects.

### Frozen requirement input

A delivery-plan cycle may be created only when the project has an approved
`ProjectIntentRevision` and `LedgerRevision`. It freezes:

- exact project-intent ID and revision;
- exact ledger ID and revision;
- every exact `LedgerRecordRevision` and relationship in that ledger;
- current approved delivery-plan revision, or null for the first plan;
- approved PM profile ID and revision;
- complete cycle conversation and latest plan proposal.

`PmPlanAssignment` contains those snapshots and bindings, not a provider session
or a mutable “latest requirements” lookup. Its profile must be approved for the
single assignment kind `pm_plan` and output schema
`mesh.dev/pm-plan-report/v1`. The planning service validates scope, assignment
kind, and schema before accepting a human turn.

A requirement trace always names `(recordId, recordRevision)` from the frozen
ledger. Only records whose type is `requirement` and whose exact revision status
is `approved` are valid targets. Decisions, assumptions, questions, risks, and
superseded/rejected/retired requirements cannot be coverage targets.

## Plan Proposal and Approval

### Strict PM output

The assignment union gains:

```ts
type PmPlanAssignment = {
  kind: 'pm_plan';
  projectId: ProjectId;
  outputSchema: 'mesh.dev/pm-plan-report/v1';
  planningCycleId: PlanningCycleId;
  humanTurnId: PlanningTurnId;
  expectedCycleRevision: number;
  expectedProposalRevision: number;
  baseProjectIntentRevision: number;
  baseLedgerRevision: number;
  baseDeliveryPlanRevision: number | null;
  input: {
    conversation: readonly PlanningConversationTurn[];
    approvedIntentLedger: ApprovedIntentLedger;
    latestProposal: DeliveryPlanProposal | null;
    approvedDeliveryPlan: ApprovedDeliveryPlan | null;
  };
};
```

The runtime report is a strict discriminated shape:

```ts
type PmPlanReport = {
  schema: 'mesh.dev/pm-plan-report/v1';
  planningCycleId: PlanningCycleId;
  humanTurnId: PlanningTurnId;
  expectedCycleRevision: number;
  expectedProposalRevision: number;
  assistantMessage: string;
  result:
    | { kind: 'questions'; questions: readonly PlanningQuestionInput[] }
    | { kind: 'plan_proposal'; proposal: ProposedDeliveryPlan };
};
```

`ProposedDeliveryPlan` contains a summary, complete milestone/task/dependency
memberships, and complete requirement traces. Collections are bounded at 20
milestones, 100 tasks, 200 dependencies, 300 traces, 20 labels per task, 20
criteria per task, and the existing 4,096-character narrative limit. Proposal
keys are unique bounded identifiers. Unknown fields, unresolved keys, duplicate
members, duplicate traces, self-dependencies, and structurally invalid
operations fail strict parsing.

`PlanReportConsumer` is the second explicit planning consumer. The runtime
observer dispatches only by the frozen assignment kind: `pm_discovery` to the
existing M2 consumer and `pm_plan` to this consumer. There is no consumer
registry. It reuses `pm_output_receipts`, whose execution-keyed accepted/
rejected receipt is already assignment-bound; no second receipt subsystem is
added.

The consumer computes the output digest and, in one immediate transaction,
re-reads the execution, assignment, cycle, human turn, exact bases, and current
proposal revision. Invalid schema/binding/semantics store one rejected receipt,
move the complete cycle to `attention_required`, append
`planning_cycle.changed`, and create no PM turn, proposal, reservation, or
canonical row. The same digest redelivered is a no-op; a different second output
for one execution is rejected and cannot replace the first.

### Proposal lifecycle and revisions

`DeliveryPlanProposal` is immutable and has lifecycle:

```text
awaiting_approval -> approved
awaiting_approval -> rejected
awaiting_approval -> superseded   (only when a later revision is accepted)
```

It records proposal ID/revision, cycle and project, exact intent/ledger/plan
base tuple, complete projected members, complete traces, a server-computed diff,
creating PM turn/execution, creation time, and decision metadata. A revision
request is an ordinary `planning_cycle.submit_plan_turn` carrying human
feedback. It does not mutate the reviewed proposal. The old proposal becomes
`superseded` only when the new complete proposal and its reservations commit.

Rejection records required human feedback, terminalizes the proposal and cycle,
and changes no canonical plan. Approval is all-or-nothing. Partial milestone,
task, dependency, or trace approval is not representable; the operator requests
a new proposal instead.

### Proposal members

Milestones, tasks, and dependencies use the same three operations:

```ts
type ProposedMember<Id, Content> =
  | { operation: 'create'; key: string; content: Content }
  | { operation: 'reuse'; id: Id; expectedRevision: number }
  | {
      operation: 'revise';
      id: Id;
      expectedRevision: number;
      content: Content;
    };
```

Every identity in the current plan must appear in the next complete proposal.
Removal is an explicit revision to lifecycle `retired`, never omission or
deletion. A retired milestone, task, or dependency may be revised back to its
active lifecycle in a later plan proposal. A dependency's endpoints never
change under one identity; changing an edge retires it and creates a new edge.
The proposal diff classifies each member exactly once as create, reuse, ordinary
revise, retire, or reactivate; retire/reactivate are lifecycle-changing revise
operations, not extra operations in the wire union.

The server reserves stable UUIDs for every `create` key when it accepts the
proposal. Those reservation rows are durable proposal state, not canonical plan
state. Superseded, rejected, or abandoned proposal IDs never become canonical
and are never reused.

### Human-only atomic approval

`plan_proposal.approve` targets one exact cycle, proposal revision, intent
revision, ledger revision, and current plan revision. Its immediate transaction:

1. replay-checks the idempotency key/request hash and asserts a human actor;
2. re-reads the exact cycle, proposal, current intent/ledger/plan, all expected
   milestone/task/dependency revisions, and proposal reservations;
3. validates complete membership, lifecycle transitions, requirement targets,
   milestone/task ownership, task ordering, active dependency endpoints, the
   project-wide DAG, and traceability completeness;
4. inserts newly canonical identities and every new immutable revision;
5. inserts one immutable `DeliveryPlanRevision` with complete ordered
   memberships, active/retired dependency revisions, and exact traces;
6. marks the proposal and cycle approved;
7. creates the default Board filter if the project has none and derives the
   complete server-owned Board view;
8. appends `delivery_plan.approved` carrying the terminal cycle, approved plan,
   and Board view;
9. stores the successful command result and commits;
10. publishes only the committed event.

Any unexpected exception rolls back every row, including reservations becoming
canonical, plan memberships, Board filter creation, event, and command result.
Expected stale or invalid approval stores only the idempotent failed command
result; it creates no canonical row or domain event. A repeated exact successful
or failed command returns its stored result without another write or publish.

## Canonical Plan Model

### Delivery plan revision

A project has at most one stable `DeliveryPlan` identity. Each approval creates
one immutable `DeliveryPlanRevision`:

```ts
type DeliveryPlanRevision = {
  id: DeliveryPlanId;
  projectId: ProjectId;
  revision: number;
  projectIntentRevision: number;
  ledgerId: LedgerId;
  ledgerRevision: number;
  proposalId: DeliveryPlanProposalId;
  approvedBy: 'human';
  approvedAt: IsoTimestamp;
};
```

The revision owns ordered memberships pointing to exact milestone, task, and
dependency revisions plus the complete requirement-trace snapshot. Historical
plan revisions are reconstructed without reading mutable “current” rows. The
latest revision by number is the canonical plan.

### Milestone revisions

A milestone has stable identity and immutable revisions containing:

- project and revision;
- lifecycle `active | retired`;
- title, outcome, and explicit stop condition;
- exclusions;
- deterministic ordinal;
- producing proposal and approval metadata.

New milestones must be `active`. Revision may retire or reactivate them.
Milestone completion is not an M3 state; evidence-based milestone gates belong
to M6.

### Task revisions

A task has stable identity and immutable revisions containing:

- project, milestone identity, and revision;
- lifecycle `pending | completed | retired`;
- title and required outcome;
- acceptance criteria and verification criteria;
- priority `must | should | could` and bounded labels;
- owned and prohibited surfaces when known;
- expected artifacts;
- deterministic ordinal;
- producing proposal and approval metadata.

Plan proposals create tasks only as `pending`. They may revise content, retire a
pending/completed task, or reactivate a retired task as `pending`; they cannot
claim `completed`. M3 exposes no task-completion or reopen command. Later
authoritative services may create a `completed` revision only with their
accepted evidence and may reopen it through an audited reverse transition. M3
defines how readiness reacts to those states without implementing their writer.

Every active task belongs to exactly one active milestone. Cross-milestone
dependencies are legal and validated in the same project-wide graph.

### Dependency revisions and reverse transitions

A task dependency has stable identity, immutable endpoints, and immutable
revisions with lifecycle `active | retired`. Its directed meaning is:

```text
prerequisiteTaskId -> dependentTaskId
```

Approval rejects self-edges, duplicates, cross-project endpoints, retired active
endpoints, missing current-plan members, and any cycle across the full active
graph. Retiring an edge makes it irrelevant to readiness; reactivating it in a
later approved plan makes it authoritative again. Every state change is a new
revision named by an immutable plan revision, so add/remove/re-add history and
its human approval remain reconstructable.

Readiness is recalculated after every approved plan revision. Thus retiring the
only unsatisfied edge changes the dependent from blocked to actionable, while
reactivating it reverses the task to blocked. When a later authoritative service
changes a prerequisite from completed back to pending, the same domain function
reverses each dependent from actionable to blocked. Already-running work is not
interrupted by this calculation; M4/M5 must handle that policy explicitly.

### Requirement traceability

Each plan revision stores two trace kinds:

- `milestone_covers`: exact milestone revision -> exact requirement revision;
- `task_satisfies`: exact task revision -> exact requirement revision.

Approval requires:

- every trace target is an approved requirement member of the captured ledger;
- every active milestone covers at least one requirement and owns at least one
  active task;
- every active task satisfies at least one requirement;
- every `task_satisfies` target is also covered by that task's milestone;
- every approved requirement in the captured ledger is covered by at least one
  active milestone and satisfied by at least one active task.

Trace rows are immutable plan-revision membership, not mutable requirement
fields. Requirement revision changes therefore do not rewrite an old plan.

## Deterministic Readiness

Readiness is a pure domain calculation. Its complete inputs are one plan
approval/base state, one exact task revision and milestone revision, all current
exact task revisions, and all current exact dependency revisions. It does not
read processes, profiles, workspaces, runs, browser state, or time.

```ts
type TaskReadiness =
  | { state: 'actionable'; blockers: readonly [] }
  | { state: 'blocked'; blockers: readonly TaskReadinessBlocker[] }
  | { state: 'inactive'; blockers: readonly TaskReadinessBlocker[] };

type TaskReadinessBlocker =
  | { kind: 'plan_not_approved' }
  | { kind: 'plan_stale'; expectedLedgerRevision: number; actualLedgerRevision: number }
  | { kind: 'milestone_retired'; milestoneId: MilestoneId }
  | { kind: 'task_completed' }
  | { kind: 'task_retired' }
  | {
      kind: 'dependency_incomplete';
      dependencyId: TaskDependencyId;
      prerequisiteTaskId: TaskId;
    };
```

The calculation is ordered:

1. A proposal preview or missing human approval returns blocked
   `plan_not_approved`.
2. If the approved plan's intent or ledger revision is not current, every
   pending task returns blocked `plan_stale`.
3. A retired milestone, completed task, or retired task returns `inactive` with
   its exact reason.
4. Each active incoming dependency whose prerequisite is not `completed` adds
   one `dependency_incomplete` blocker sorted by dependency ID.
5. A pending task with no blockers is `actionable`.

Invalid stored graphs, absent endpoints, or impossible lifecycle combinations
are integrity failures, not readiness variants. Snapshot/event creation fails,
trips the audit boundary where mutation is implicated, and never guesses a card
state. Proposal approval prevents those states in ordinary operation.

The server calculates every card from one transactionally coherent read. The
browser renders `TaskReadiness`; it never duplicates the function. M3's word
“actionable” means only domain eligibility. M4 still must prove workspace and
single-task authorization before launch, and M5 still must select and schedule
an authorized finite wave.

## Server-Owned Board

### Durable filter

One `BoardFilter` row belongs to each project with an approved plan:

```ts
type BoardFilter = {
  projectId: ProjectId;
  revision: number;
  milestoneIds: readonly MilestoneId[];       // empty means all
  taskLifecycles: readonly ('pending' | 'completed' | 'retired')[];
  readiness: readonly ('actionable' | 'blocked' | 'inactive')[];
  priorities: readonly ('must' | 'should' | 'could')[];
  labels: readonly string[];
  requirementRecordIds: readonly LedgerRecordId[];
  updatedAt: IsoTimestamp;
};
```

Values within one field are ORed; populated fields are ANDed. Label matching is
“has any selected label.” Requirement matching is “has any selected exact
task-satisfies trace.” The default filter selects pending and completed tasks
and leaves every other field empty, so the first Board shows active work across
all milestones while retired history remains opt-in.

`board_filter.set` carries the complete filter and expected filter revision.
The server validates milestone and requirement identities belong to this
project, canonicalizes order and duplicate values, stores the next revision,
derives the Board, appends `board.filter_changed`, stores the command result,
commits, and publishes. Same-key replay returns the same Board. A stale distinct
command returns `board_filter_revision_conflict` with no filter/event change.

Plan changes do not silently clear saved selections. A selected retired
milestone or requirement remains a valid project identity and may yield zero
cards until the operator changes the filter. Filter options include selected
historical identities with a zero count so the UI can explain and clear them.

### Board view

`BoardView` is derived, not stored as card rows:

```ts
type BoardView = {
  projectId: ProjectId;
  deliveryPlanRevision: number | null;
  stale: boolean;
  filter: BoardFilter | null;
  totalTaskCount: number;
  matchedTaskCount: number;
  milestoneOptions: readonly BoardMilestoneOption[];
  requirementOptions: readonly BoardRequirementOption[];
  cards: readonly BoardTaskCard[];
};
```

Each card carries the exact task/milestone revisions, task outcome, lifecycle,
priority, labels, server-calculated readiness and blockers, active incoming and
outgoing dependency summaries, and exact requirement traces. Cards sort by
milestone ordinal, task ordinal, then task ID. Option counts and card matching
come from the same coherent canonical read.

There is no Board-card table, client-owned readiness cache, drag state, worker
slot, run queue, or scheduling column. The canonical plan and filter are enough
to rebuild the view after every restart.

## Commands, Results, and Failures

The existing `/api/v2/commands` route and human envelope remain the sole command
transport. M3 adds:

- `planning_cycle.submit_plan_turn`;
- `plan_proposal.approve`;
- `plan_proposal.reject`;
- `board_filter.set`.

`planning_cycle.abandon` already applies to either purpose. Revision requests
use `planning_cycle.submit_plan_turn`, not a fifth command. Every envelope is
strict and human-only. PM reports contain no approval, filter, or canonical
mutation field.

Expected domain failures remain HTTP 200 `ok: false` and are idempotently
stored:

| Code | Meaning |
| --- | --- |
| `planning_intent_required` | No approved intent/ledger exists for delivery planning |
| `planning_cycle_active_conflict` | Another nonterminal intent or plan cycle owns the project |
| `planning_cycle_revision_conflict` | Expected cycle revision/lifecycle is stale |
| `planning_cycle_history_limit` | Existing bounded cycle history is exhausted |
| `planning_profile_incompatible` | Profile scope, `pm_plan` kind, or report schema is invalid |
| `plan_proposal_not_found` | Proposal does not belong to the referenced cycle |
| `plan_proposal_revision_conflict` | Proposal revision/lifecycle is stale |
| `plan_canonical_base_conflict` | Intent, ledger, plan, or member revision changed |
| `plan_proposal_invalid` | Membership, DAG, lifecycle, trace, or reservation validation failed |
| `board_filter_not_found` | No approved plan/filter exists for the project |
| `board_filter_revision_conflict` | Expected filter revision is stale |
| `board_filter_invalid` | Filter contains malformed, foreign, or unknown identities |

Existing M2 cycle-not-found and proposal-independent errors are reused rather
than aliased. Malformed/non-human envelopes remain HTTP 400 `invalid_request`;
origin rejection remains 403; retained-gap conflicts remain 409; stopping and
audit-barrier failures remain 503; unknown exceptions remain 500.

Stale plan approval stores no canonical plan or domain event. Malformed/wrongly
bound PM output stores its rejected receipt and cycle attention transaction but
no proposal. Rejection and abandonment preserve history but create no canonical
plan. Audit persistence failure stops further unsafe mutation and publishes
nothing.

## Events, Snapshots, Replay, and Resync

Protocol remains `mesh.v2/1`. Strict unions are extended; there is no second
socket or Board polling protocol.

Domain events are:

- `planning_cycle.changed`, widened to carry the complete purpose-aware cycle
  view and its correct proposal history;
- `delivery_plan.approved`, carrying the terminal cycle, complete
  `ApprovedDeliveryPlan`, and complete current `BoardView`;
- `board.filter_changed`, carrying the complete `BoardView`;
- existing `intent_ledger.approved`, extended with the current Board view when
  a plan exists, so a new requirement revision immediately projects
  `plan_stale` blockers in the same committed intent-approval transaction.

This is an explicit transaction composition point, not an event observer:
`PlanningService` invokes one M3 Board projector after inserting the new intent
and ledger revisions but before appending the event and command result. Any
projection failure rolls back the intent approval and publishes nothing.

`V2ProjectSnapshot` adds:

```ts
deliveryPlan: ApprovedDeliveryPlan | null;
board: BoardView;
```

The existing bounded planning-cycle history now includes both purposes. Before
first plan approval, `deliveryPlan` is null and Board has no filter/cards with an
explicit `planning_required` empty reason. After approval, snapshot construction
reads intent, plan, plan memberships, filter, and Board within one coherent
database transaction.

Reducers replace complete cycle, plan, and Board projections. They do not merge
cards or recalculate filter membership. Duplicate sequence delivery is a no-op;
stale sequences, gaps, project mismatch, invalid payloads, or an incomplete
plan/Board pair mark the projection stale and request resync. Reconnect uses the
existing domain/runtime cursors. A retained gap produces existing
`v2.resync_required`; the browser fetches a fresh project snapshot and replaces
server truth while preserving only its local unsent form draft.

Contract, repository, and reducer tests apply proposal revision, approval,
filter, and later intent-approval events to an earlier snapshot and assert
byte-equivalence with a fresh final snapshot. Runtime events remain only PM
transport facts and never mutate Board state.

## Persistence and Migration

Migration `003_planning_board.sql` is appended; `001_foundation.sql` and
`002_intent_ledger.sql` remain byte-for-byte immutable. It adds:

- `planning_cycle_purposes`, backfilled one-to-one as `intent` for every M2
  cycle;
- `delivery_plan_proposals` and proposal member/trace tables;
- proposal-local ID reservation tables for milestones, tasks, and dependencies;
- `delivery_plans` and `delivery_plan_revisions`;
- stable milestone identities and immutable milestone revisions;
- stable task identities and immutable task revisions;
- stable dependency identities and immutable dependency revisions;
- plan-revision milestone/task/dependency membership tables;
- plan-revision requirement-trace rows;
- `board_filters` with one revisioned current row per project.

Foreign keys include project ownership and exact compound revision references.
Unique constraints enforce one delivery plan per project, one revision number
per identity, one membership per plan revision, one proposal revision per
cycle, one reserved ID per proposal key, one dependency identity per immutable
endpoint pair, one normalized active edge per plan revision, one trace per
subject/requirement/revision tuple, and one Board filter per project. JSON is
canonicalized and parsed through shared contracts on read.

Migration 3 rebuilds only `command_results` inside the outer immediate migration
transaction. Its check accepts the exact M1/M2 command types plus the four M3
types above, copies all existing rows without transformation, restores primary-
key uniqueness, and then applies the remaining schema. A forced failure after
the rebuild restores the exact M2 schema, rows, indexes, migration ledger, and
command replay behavior.

The existing `pm_output_receipts`, planning turns, questions, project event
store, command repository, and project cursors are reused. There is no new
event store, receipt store, Board-card cache, or runtime database.

Fresh-schema tests and exact migration-2 upgrade tests seed nonempty M1 and M2
commands, intent cycles, proposals, receipts, approved ledgers, domain/runtime
events, and cursors. Upgrade must preserve byte-equivalent reads and replay.

## Restart Recovery and Audit Ordering

Delivery-plan PM executions use the existing M2 reservation-before-activation
flow. The exact execution is durably bound to its turn before an adapter may
start or emit output. Startup order remains:

1. reopen and migrate only the V2 database;
2. reconcile M1/M2 execution operations without attaching recovered sessions;
3. consume any durable unconsumed intent or plan structured output through the
   assignment-specific consumer;
4. reconcile bound planning cycles and unbound existing reservations;
5. publish the committed recovery window;
6. attach proven recovered sessions;
7. drain only never-reserved pending turns;
8. begin accepting commands.

An `awaiting_approval` plan cycle requires no live PM and survives restart. A
starting reservation with unknown adapter outcome follows the M2 fail-closed
path to execution/cycle attention and is never automatically activated.
Completion without one accepted plan receipt also reaches attention. Abandon
continues to use M2's cleanup-first, commit-last launch coordinator and internal
quiescence bridge.

Canonical plan and Board recovery require no side effect. They are rebuilt from
immutable revisions plus the saved filter. Startup validates the latest plan's
membership, graph, and traces before serving a snapshot; corruption fails
closed and does not manufacture readiness. A command committed before process
loss but not published is recovered by ordered replay, not re-execution.

Every report input retains raw diagnostic-before-runtime-event ordering. Every
proposal, approval, filter, and intent-drift Board projection commits its domain
rows, ordered event, and command result before publication. Failure to write an
audit record or required event trips the existing central barrier and prevents
later unsafe mutation.

## Planning and Board UI

### PM planning experience

After intent approval, PM Chat offers a text-labeled “Plan delivery” action. A
delivery-plan cycle uses the existing transcript and question cards, but its
proposal card renders:

- proposal revision and exact intent/ledger/plan base;
- milestone outcomes, stop conditions, exclusions, and order;
- tasks grouped by milestone with acceptance/verification criteria;
- cross-milestone dependencies in prerequisite -> dependent language;
- exact milestone coverage and task-satisfaction traces;
- server-computed create/revise/reuse/retire counts;
- one complete Approve, Request revision, Reject, and Abandon boundary.

No per-item checkbox or partial approval control exists. Request revision uses
the ordinary labeled human message. Old revisions remain inspectable and are
clearly marked superseded. Approval/rejection/abandon actions are disabled when
disconnected, stale, already submitting, or not viewing the latest proposal.

Launch-pending, execution-active, attention-required, history-limit, rejected,
abandoned, and approved states retain M2's explicit statuses. Errors use an
`aria-live` region and focus returns to the proposal heading or message field.

### Board experience

The Board placeholder becomes one pane. It renders the server-owned filter,
matched/total count, and cards across the selected milestones. Filter groups use
`fieldset`/`legend`; milestones, readiness, lifecycle, priority, labels, and
requirements are multi-select controls with visible counts. Applying a filter
sends the complete expected-revision command. The draft is local until submit;
the applied chips, options, counts, and cards come back from the server.

Cards show task outcome, milestone, lifecycle, priority, labels, actionable/
blocked/inactive text, named dependency blockers, and requirement coverage.
Status never relies on color. A task button opens detail inside the Board pane
as a labeled section with focus management and a close button; M3 does not add
one permanent pane per task.

The Board has explicit states for:

- loading a project snapshot;
- no approved intent;
- approved intent but no approved plan;
- stale plan after requirement revision;
- no tasks in the approved plan;
- filters matching no tasks;
- disconnected or stale projection;
- command failure;
- normal actionable/blocked/inactive results.

Controls are disabled while disconnected/stale/submitting. Existing tablist,
ArrowLeft/ArrowRight, Home/End, selected-state, heading, and visible-focus
behavior remains. Filter result count and command errors are announced without
moving focus unexpectedly. Dependency direction and blocker text are readable
by name, not UUID alone.

Worker, workspace, attempt, QA, run, concurrency, and queue UI is absent. The
Board does not expose a Start button in M3.

## Fake-Only Todo Acceptance Scenario

The M2 built-process journey remains and is extended rather than replaced. The
fixture explicitly enables the existing test-only Todo fake mode for every
owned server spawn and restart.

1. Create a temporary Todo repository/database and complete the M2 conversation
   through approved intent revision 1 and ledger revision 1.
2. Approve a project PM profile for `pm_plan` with output schema
   `mesh.dev/pm-plan-report/v1`.
3. Start a delivery-plan cycle. Assert the assignment freezes intent 1, ledger
   1, a null plan base, and no provider resume handle.
4. The fake PM emits proposal revision 1. It contains two milestones, Todo UI
   and persistence tasks in the first milestone, and an integrated Todo task in
   the second milestone depending on both first-milestone tasks. All approved
   requirements have milestone and task traces.
5. Request revision with feedback that keyboard acceptance must be explicit and
   persistence verification must be isolated. The fake emits proposal revision
   2; revision 1 remains immutable and becomes superseded only after revision 2
   commits.
6. Assert no canonical plan/Board cards exist before approval. Approve the exact
   second proposal. Assert one plan revision, two milestone identities, three
   task identities, two dependencies, complete traces, terminal proposal/cycle,
   default filter, Board, event, and command result appear atomically.
7. Assert UI and persistence tasks are `actionable`; integrated Todo is
   `blocked` with both exact prerequisite IDs. No workspace, attempt, execution
   run, or worker assignment exists.
8. Apply and verify server-owned filters for all milestones, each milestone,
   actionable, blocked, keyboard UX requirement coverage, priority, and label.
   Reload after one filter and assert its revision and results persist.
9. Open task detail and verify requirement revision links, dependency direction,
   acceptance criteria, and stop-condition context.
10. Disconnect before receiving selected committed domain events, reconnect with
    the prior cursor, and prove ordered replay converges to the same plan,
    filter, and Board.
11. Subscribe outside the retained domain window, receive
    `v2.resync_required` with reason `retained_gap`, fetch a new snapshot, and
    prove exact convergence.
12. Restart the built server on the same temporary database and repository.
    Assert proposal history, plan revision, stable IDs/revisions, dependency
    history, traces, filter, readiness, and Board are byte-equivalent.

Focused domain tests separately approve a second plan revision that retires and
then another that reactivates one dependency. They prove the dependent Board
card changes blocked -> actionable -> blocked while every dependency revision
remains queryable. A pure readiness test changes a prerequisite
completed -> pending and proves actionable -> blocked without starting work.

The scenario never launches a real agent, opens a worktree, reads credentials,
uses operator runtime paths, binds V1 ports, or kills an unowned process.

## Affected Surface Decisions

- **Contracts: yes.** `packages/v2-contracts` gains plan/Board IDs, strict plan
  contracts, `PmPlanAssignment`, command/results, events, purpose-aware cycle
  views, and snapshot fields. Protocol version remains unchanged.
- **Commands: yes.** The existing V2 route parses four new human commands and
  preserves current status/error mapping. No new endpoint family is added.
- **Runtime: narrowly yes.** The existing execution substrate accepts
  `pm_plan`, routes its structured output to one explicit consumer, and extends
  the deterministic Todo fake. It gains no workspace, Developer, run, or
  scheduling behavior.
- **Persistence: yes.** One forward migration, plan/readiness repositories,
  atomic approval, saved filter, immutable history, command replay, and startup
  integrity checks are required. Applied migrations remain immutable.
- **Realtime: yes.** Existing project domain events, cursors, replay, socket,
  retained-gap resync, and publication ordering carry complete plan/Board
  projections. No new stream is added.
- **Web: yes.** Planning supports the delivery-plan purpose; Board renders
  server truth and filter commands; reducer/resync replace complete
  projections. The client owns no readiness rule.
- **Workspace safety: no new mutation surface.** M3 does not resolve, create,
  reserve, delete, or inspect task workspaces. Tests use only the existing
  temporary Todo repository identity.
- **Operating modes: yes for compatibility.** Development and production build
  with M3 schemas. Only explicit `NODE_ENV=test` may enable the fake Todo PM
  output. Real adapters remain opt-in and are not an acceptance gate.
- **Reverse states: yes.** Proposal supersede/reject/abandon, dependency
  active/retired/reactivated, task/milestone retirement/reactivation, plan stale
  after intent change, filter replacement, and restart/replay recovery are
  explicit and tested.
- **Documentation: yes after implementation.** Current architecture and V2
  operating guidance must state that M3 owns plan/readiness/Board and M4/M5 own
  workspace execution and scheduling. This design is the only documentation
  artifact in the present planning task.

Expected implementation stays inside `packages/v2-contracts`,
`apps/v2-server`, `apps/v2-web`, `e2e-v2`, and current V2 development docs. No
V1 path is modified or imported. Exact per-task file ownership belongs in the
later implementation plan, not this design.

## V1 Mechanism Reuse and Forbidden Concepts

M3 may reproduce these proven mechanisms behind V2 contracts:

- exact immutable planning bases and stale approval rejection;
- proposal-local key to server-owned ID reservation;
- one immediate approval transaction for tasks and dependencies;
- project-wide dependency DAG validation and deterministic blocker ordering;
- pure readiness helpers separated from HTTP and UI;
- ordered project events, idempotent command replay, complete snapshot
  replacement, retained-gap resync, and fake/temporary test techniques;
- accessible task-card and dependency-language patterns.

Reuse is by behavior and small mechanism. A V1 helper moves only if it is
provider-neutral, already has two real consumers, and does not force V1 types
into V2. Otherwise M3 implements the small V2-specific function locally.

The following V1 concepts are forbidden:

- `ProjectPlan`, its PM SDK/session ownership, planning capability tokens, and
  provider resume semantics;
- mutable V1 `Task`, `TaskAttempt`, session/workspace links, Developer/QA
  cycles, repair conditions, and automation policy;
- V1 readiness that includes workspace or attempt launch checks;
- `ProjectRun`, preview, queue, capacity, launch claims, scheduling, or wave
  membership;
- V1 command/event/snapshot types, database tables, React components, CSS
  ownership, and client projection shapes;
- any V1 historical milestone-3 design or implementation artifact as a source
  of product authority.

M3 preserves V1 runnability and V2 datastore/application identity. Neither
application imports the other's contracts or storage.

## TDD and Verification Strategy

Implementation follows red-green tests at the owning boundary.

### Contracts

Contract tests first fail for the absent purpose, assignment/report, immutable
plan records, operations, commands/results, events, Board filter/view, and
snapshot fields. Green tests prove strict parsing, limits, unknown-field
rejection, ID/project/revision coherence, human-only authority, complete
proposal keys, exact lifecycle enums, and no workspace/run/attempt field.

### Migration and persistence

Fresh and exact-M2 upgrade tests prove migration 3, sidecar backfill, immutable
revisions, proposal reservations without premature canonical rows, complete
memberships/traces, dependency history, saved filters, all command-result
types, and exact M1/M2 replay preservation. Forced migration failure after the
command table rebuild restores exact M2 state.

### Domain and approval

Focused tests cover questions, proposals, revision/supersession, rejection,
abandonment, duplicate/malformed reports, exact base and member conflicts,
atomic approval, injected failure at every write boundary, project-wide DAG
validation, trace completeness, retirement/reactivation, plan staleness,
filter idempotency, and Board derivation. Readiness cases cover proposal versus
approval, current versus stale ledger, pending/completed/retired tasks, retired
milestones, zero/one/multiple prerequisites, completed prerequisites, edge
retirement/reactivation, and prerequisite reopen.

### Runtime and fake adapter

Tests prove one finite PM execution per plan turn, bind-before-activation,
strict output before completion, raw diagnostic before runtime publication,
same/different digest handling, missing-output attention, no native plan session
reuse, and unchanged foundation/intent fake behavior. Existing restart and
abandon-race suites run for `pm_plan` as well as `pm_discovery`.

### HTTP, events, snapshots, and web

Route tests cover every command and exact status mapping. Event/repository/
reducer tests prove complete projection, duplicates, gaps, invalid payloads,
ordered replay, retained-gap resync, and fresh-snapshot equivalence. Component
tests cover proposal revisions, complete approval authority, server-owned
filters, cards/blockers/traces, task detail focus, tabs, labels, live errors,
and every empty/loading/stale state.

### Built-process acceptance

The Todo journey above runs against built V2 server/web output, port 0,
temporary repository/database, and the explicit fake scenario. It includes
refresh, replay, retained-gap resync, and restart. Process cleanup asserts only
fixture-owned PIDs/listeners are gone. Real Codex or Claude smoke tests remain
outside CI and are not run for M3 acceptance.

The eventual full implementation gate is:

```powershell
$env:NX_DAEMON='false'
$env:NX_SKIP_NX_CACHE='true'
git rev-parse HEAD
corepack pnpm nx test v2-contracts
corepack pnpm nx test v2-server
corepack pnpm nx test v2-web
corepack pnpm nx typecheck v2-contracts
corepack pnpm nx typecheck v2-server
corepack pnpm nx typecheck v2-web
corepack pnpm nx build v2-contracts
corepack pnpm nx build v2-server
corepack pnpm nx build v2-web
corepack pnpm nx typecheck v2-e2e
corepack pnpm nx e2e v2-e2e -- --grep "approved delivery plan becomes a deterministic Board"
corepack pnpm verify
git diff --check
```

Every Nx/verify result records the exact tested HEAD with daemon and cache
disabled. No external-agent traffic is an acceptable default verification
dependency.

## Settled Interfaces and Stop Proof

- M3 owns deterministic actionable/readiness calculation and the Board
  projection. M5 owns `ExecutionRun` scheduling, concurrency, and waves.
- Existing `PlanningCycle` is reused with an explicit `intent | delivery_plan`
  purpose; intent and plan proposal artifacts remain separate.
- Plan PM output schema is exactly `mesh.dev/pm-plan-report/v1`; every human
  turn owns one finite execution.
- Plan proposal revisions are immutable complete snapshots. Revision feedback
  creates a new proposal; approval is human-only and all-or-nothing.
- Canonical plans, milestones, tasks, and dependencies use stable identities
  and immutable revisions. Plan revisions name exact members and traces.
- Approval reserves proposal IDs first and materializes them only in the exact
  successful approval transaction.
- Traceability targets exact approved requirement revisions from the frozen
  ledger, and coverage is complete for all approved requirements.
- Dependency endpoints are immutable; active/retired/reactivated revisions
  preserve history. The active graph is project-wide and acyclic.
- M3 creates pending tasks only and cannot mark work complete. Readiness still
  defines completed/reopened behavior for later authoritative writers.
- Actionable means current approved plan + pending active task + completed
  active prerequisites. It says nothing about workspaces, runs, workers, or
  capacity.
- One durable project Board filter is server-owned. Empty selections mean all;
  AND applies across filter fields and OR within a field.
- Board cards are derived from canonical plan, readiness, traces, and saved
  filter. They are never a second mutable source of truth.
- Intent approval after plan approval preserves the plan but blocks pending
  work as `plan_stale` until an exact new plan revision is approved.
- Protocol, project domain/runtime streams, command route, cursor ordering,
  replay, retained-gap resync, audit barrier, and V2 datastore identity remain.
- Migration 3 is forward-only; migrations 1 and 2 are immutable.
- Default verification is fake-only and temporary. No V1 state, real harness,
  credential, operator worktree, or subscription quota is touched.
- No `DeveloperAttempt`, workspace allocation, execution loop, task claim,
  `ExecutionRun`, scheduler, concurrency limit, or wave exists in M3.

If any stop-condition item needs an execution, workspace, run, or scheduling
object to pass, the implementation has crossed the milestone boundary and must
return to planning rather than adding that object.
