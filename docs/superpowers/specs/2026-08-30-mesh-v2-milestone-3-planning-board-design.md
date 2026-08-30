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
13. **May M3 widen stored M2 events in place?** No. Existing strict payloads
    remain a legacy decoder alternative; all M3 writes use an explicit payload
    version and normalize to the new projection. This costs one compatibility
    decoder but preserves immutable event bytes, checksums, replay, and restart.
14. **Which task revision does a plan approve versus Board readiness use?** The
    plan and traces anchor one plan-authored contract revision. Board selects
    the greatest guarded lifecycle-only revision on that same anchor. This
    permits completion/reopen without silently changing approved scope.
15. **Are milestone dependencies another stored graph?** No. They derive from
    active cross-milestone task edges. A separate proposal/table would duplicate
    authority without adding an M3 operation.
16. **Does task detail need a new query?** No. At the M3 maximum of 100 tasks,
    each matched server card can carry its bounded detail. This keeps one
    coherent Board read and avoids an endpoint/cache before it is needed.

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
  baseDeliveryPlanId: DeliveryPlanId | null;
  baseDeliveryPlanRevision: number | null;
};
```

Migration 3 stores this as a one-to-one sidecar rather than rebuilding M2's
`planning_cycles` table. It backfills every existing cycle as `intent` with a
null plan ID/revision. Every new cycle inserts its purpose row in the same
transaction as the cycle. Repository reads fail closed if the sidecar is
missing.
Intent rows require both plan-base fields null. Delivery-plan rows require the
fields jointly null for an initial plan or jointly nonnull for replacement.

An intent cycle continues to use `planning_cycle.submit_turn`,
`PmDiscoveryAssignment`, `mesh.dev/pm-discovery-report/v1`, and M2 intent
proposals unchanged. A delivery-plan cycle uses
`planning_cycle.submit_plan_turn`, `PmPlanAssignment`, and
`mesh.dev/pm-plan-report/v1`. Both use the existing cycle lifecycle:

```text
discovering -> launch_pending -> execution_active -> awaiting_human
                                      \-> awaiting_approval
awaiting_human -> launch_pending           (answer)
awaiting_approval -> launch_pending        (revision request)
attention_required -> launch_pending       (human retry turn)
awaiting_approval -> approved              (human only)
awaiting_approval -> proposal_rejected     (human only)
any nonterminal state -> abandoned         (human only)
execution_active -> attention_required     (invalid/missing report or runtime failure)
launch_pending -> attention_required       (bound terminal reservation)
```

The existing project-wide partial unique index still permits at most one
nonterminal cycle across both purposes. `planning_cycle.abandon` remains common
to both. Existing M2 history limits remain: at most 32 human turns, 32 PM turns,
and 16 proposal revisions per cycle.

The complete M2 acceptance and retry rules apply to both purposes. Only
`discovering`, `awaiting_human`, `awaiting_approval`, and
`attention_required` accept a human turn. A retry from `attention_required`
creates a new immutable human turn and new finite execution; it never resumes a
native PM session. A rejected or missing report, an execution that terminates
without one accepted receipt, or a runtime failure moves an
`execution_active` cycle to `attention_required`. Binding a capability/skill
failure or another already-terminal reservation moves `launch_pending`
directly to `attention_required`. A pre-reservation lookup/probe failure writes
nothing and leaves the exact launch-pending turn eligible for idempotent drain
retry or abandonment. Existing proposal history remains unchanged while a
revision or retry turn is pending or fails.

`PlanningCycleView` is the strict purpose-aware union:

```ts
type PlanningCycleView =
  | {
      cycle: PlanningCycle;
      purpose: {
        kind: 'intent';
        baseDeliveryPlanId: null;
        baseDeliveryPlanRevision: null;
      };
      turns: readonly PlanningTurn[];
      questions: readonly PlanningQuestion[];
      proposals: readonly PlanningProposal[];
      deliveryPlanProposals: readonly [];
    }
  | {
      cycle: PlanningCycle;
      purpose: {
        kind: 'delivery_plan';
        baseDeliveryPlanId: DeliveryPlanId | null;
        baseDeliveryPlanRevision: number | null;
      };
      turns: readonly PlanningTurn[];
      questions: readonly PlanningQuestion[];
      proposals: readonly [];
      deliveryPlanProposals: readonly DeliveryPlanProposal[];
    };
```

Existing M2 limits and refinements still validate the cycle, turns, and
questions. Intent proposals retain their exact M2 schema. Delivery-plan
proposal revisions are contiguous and obey the equivalent latest-proposal/
cycle-lifecycle coherence rules. This avoids rewriting stored M2 proposals or
pretending the two proposal types have the same effects.

### Frozen requirement input

A delivery-plan cycle may be created only when the project has an approved
`ProjectIntentRevision` and `LedgerRevision`. It freezes:

- exact project-intent ID and revision;
- exact ledger ID and revision;
- every exact `LedgerRecordRevision` and relationship in that ledger;
- current approved delivery-plan ID/revision, jointly null for the first plan;
- approved PM profile ID and revision;
- complete cycle conversation and latest plan proposal.

`PmPlanAssignment` contains those snapshots and bindings, not a provider session
or a mutable “latest requirements” lookup. Its profile must be approved for the
single assignment kind `pm_plan` and output schema
`mesh.dev/pm-plan-report/v1`. The planning service validates scope, assignment
kind, and schema before accepting a human turn.

An initial or replacement cycle starts with `latestProposalRevision: 0`; its
first assignment requires proposal revision 1. Each accepted question/revision/
retry turn freezes `latestProposalRevision + 1`. A failed execution does not
consume that number because no proposal row exists; the later retry guards the
same next revision against the incremented cycle revision.

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
  baseProjectIntentId: ProjectIntentId;
  baseProjectIntentRevision: number;
  baseLedgerId: LedgerId;
  baseLedgerRevision: number;
  baseDeliveryPlanId: DeliveryPlanId | null;
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
  assistantMessage: PlanText;
  result:
    | { kind: 'questions'; questions: readonly PlanningQuestionInput[] }
    | { kind: 'plan_proposal'; proposal: ProposedDeliveryPlan };
};
```

The proposal wire contract is concrete rather than an implementation prompt:

```ts
type ProposalKey = string; // ^[a-z][a-z0-9-]{0,63}$
type PlanText = string; // trimmed, 1..4,096 characters
type PlanLabel = string; // trimmed, 1..64 characters

type ProposedMilestoneRef =
  | { kind: 'canonical'; milestoneId: MilestoneId }
  | { kind: 'proposal'; key: ProposalKey };
type ProposedTaskRef =
  | { kind: 'canonical'; taskId: TaskId }
  | { kind: 'proposal'; key: ProposalKey };

type MilestoneContractInput = {
  title: PlanText;
  outcome: PlanText;
  stopCondition: PlanText;
  exclusions: readonly PlanText[]; // 0..20
  ordinal: number; // positive integer, contiguous in the complete proposal
};

type TaskContractInput = {
  milestone: ProposedMilestoneRef;
  title: PlanText;
  outcome: PlanText;
  acceptanceCriteria: readonly PlanText[]; // 1..20
  verificationCriteria: readonly PlanText[]; // 1..20
  priority: 'must' | 'should' | 'could';
  labels: readonly PlanLabel[]; // unique, 0..20
  ownedSurfaces: readonly PlanText[]; // unique, 0..20
  prohibitedSurfaces: readonly PlanText[]; // unique, 0..20
  expectedArtifacts: readonly PlanText[]; // unique, 0..20
  ordinal: number; // positive integer, contiguous within the milestone
};

type ProposedMilestoneMember =
  | {
      operation: 'create';
      key: ProposalKey;
      content: MilestoneContractInput; // lifecycle is active
    }
  | {
      operation: 'reuse';
      milestoneId: MilestoneId;
      expectedRevision: number;
    }
  | {
      operation: 'revise';
      milestoneId: MilestoneId;
      expectedRevision: number;
      lifecycle: 'active' | 'retired';
      content: MilestoneContractInput;
    };

type ProposedTaskMember =
  | {
      operation: 'create';
      key: ProposalKey;
      content: TaskContractInput; // lifecycle is pending
    }
  | {
      operation: 'reuse';
      taskId: TaskId;
      expectedContractRevision: number;
      expectedCurrentRevision: number;
    }
  | {
      operation: 'revise';
      taskId: TaskId;
      expectedContractRevision: number;
      expectedCurrentRevision: number;
      lifecycle: 'pending' | 'retired';
      content: TaskContractInput;
    };

type ProposedDependencyMember =
  | {
      operation: 'create';
      key: ProposalKey;
      prerequisite: ProposedTaskRef;
      dependent: ProposedTaskRef;
    }
  | {
      operation: 'reuse';
      dependencyId: TaskDependencyId;
      expectedRevision: number;
    }
  | {
      operation: 'revise';
      dependencyId: TaskDependencyId;
      expectedRevision: number;
      lifecycle: 'active' | 'retired';
    };

type ProposedRequirementTrace =
  | {
      kind: 'milestone_covers';
      milestone: ProposedMilestoneRef;
      requirement: {
        recordId: LedgerRecordId;
        recordRevision: number;
      };
    }
  | {
      kind: 'task_satisfies';
      task: ProposedTaskRef;
      requirement: {
        recordId: LedgerRecordId;
        recordRevision: number;
      };
    };

type ProposedDeliveryPlan = {
  summary: PlanText;
  milestones: readonly ProposedMilestoneMember[]; // 1..20
  tasks: readonly ProposedTaskMember[]; // 1..100
  dependencies: readonly ProposedDependencyMember[]; // 0..200
  traces: readonly ProposedRequirementTrace[]; // 1..300
};
```

Every Zod object is strict. The numeric comments above are enforced bounds, not
documentation-only guidance. Proposal keys are unique across all created
members. Every proposal reference must resolve to a member in the same complete
proposal, and canonical references must belong to its current plan base.
Unknown fields, unresolved keys, duplicate members/traces, self-dependencies,
noncontiguous ordinals, invalid lifecycle operations, and out-of-bound strings
or collections fail parsing before semantic approval validation.

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

Each `DeliveryPlanProposal` content/base/reservation row is immutable. Its view
projects lifecycle from the absence or presence of one append-only terminal
decision/supersession row:

```text
awaiting_approval -> approved
awaiting_approval -> rejected
awaiting_approval -> superseded   (only when a later revision is accepted)
```

Its exact durable projection is:

```ts
type PlanProposalDiffCounts = {
  create: number;
  reuse: number;
  revise: number;
  retire: number;
  reactivate: number;
};

type DeliveryPlanProposal = {
  id: DeliveryPlanProposalId;
  projectId: ProjectId;
  planningCycleId: PlanningCycleId;
  revision: number;
  lifecycle: 'awaiting_approval' | 'superseded' | 'approved' | 'rejected';
  base: {
    projectIntentId: ProjectIntentId;
    projectIntentRevision: number;
    ledgerId: LedgerId;
    ledgerRevision: number;
    deliveryPlan:
      | { id: DeliveryPlanId; revision: number }
      | { id: null; revision: null };
  };
  proposedPlan: ProposedDeliveryPlan;
  reservations: {
    milestones: readonly { key: ProposalKey; id: MilestoneId }[];
    tasks: readonly { key: ProposalKey; id: TaskId }[];
    dependencies: readonly { key: ProposalKey; id: TaskDependencyId }[];
  };
  diff: {
    milestones: PlanProposalDiffCounts;
    tasks: PlanProposalDiffCounts;
    dependencies: PlanProposalDiffCounts;
    traceCreateCount: number;
    traceRemoveCount: number;
  };
  createdByTurnId: PlanningTurnId;
  createdByExecutionId: WorkerExecutionId;
  createdAt: IsoTimestamp;
  decision:
    | { kind: 'pending' }
    | {
        kind: 'superseded';
        supersededByProposalId: DeliveryPlanProposalId;
        decidedAt: IsoTimestamp;
      }
    | { kind: 'approved'; decidedBy: 'human'; decidedAt: IsoTimestamp }
    | {
        kind: 'rejected';
        decidedBy: 'human';
        feedback: PlanText;
        decidedAt: IsoTimestamp;
      };
};
```

Lifecycle and `decision.kind` must agree, revisions are contiguous per cycle,
reservation keys match exactly the `create` members, and every diff count is a
server-computed nonnegative integer. The PM supplies only
`ProposedDeliveryPlan`; `PlanReportConsumer` supplies proposal identity, bases,
reservations, diff, provenance, lifecycle, and timestamps. A revision request
is an ordinary `planning_cycle.submit_plan_turn` carrying human feedback. It
does not mutate
the reviewed proposal. The old proposal becomes `superseded` only when the new
complete proposal and its reservations commit.

Rejection records required human feedback, terminalizes the proposal and cycle,
and changes no canonical plan. Approval is all-or-nothing. Partial milestone,
task, dependency, or trace approval is not representable; the operator requests
a new proposal instead.

### Proposal members

The three explicit member unions above are the only accepted shapes. Every
identity in the current plan must appear in the next complete proposal.
Removal is an explicit revision to lifecycle `retired`, never omission or
deletion. A retired milestone, task, or dependency may be revised back to its
active lifecycle in a later plan proposal. A dependency's endpoints never
change under one identity; changing an edge retires it and creates a new edge.
The proposal diff classifies each member exactly once as create, reuse, ordinary
revise, retire, or reactivate; retire/reactivate are lifecycle-changing revise
operations, not extra operations in the wire union.

Task `reuse` guards both the plan-contract anchor and current lifecycle
revision. Task `revise` creates a new plan-contract anchor and may select only
`pending` or `retired`; a PM report can never select `completed`. Dependency
`revise` changes lifecycle only. Milestone and task content are repeated in a
revision operation, so no approval-time merge with an older proposal exists.

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
6. inserts the proposal's approved decision row and marks the cycle approved;
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
  projectIntentId: ProjectIntentId;
  projectIntentRevision: number;
  ledgerId: LedgerId;
  ledgerRevision: number;
  baseDeliveryPlanRevision: number | null;
  proposalId: DeliveryPlanProposalId;
  summary: PlanText;
  approvedBy: 'human';
  approvedAt: IsoTimestamp;
};

type PlanRequirementRef = {
  recordId: LedgerRecordId;
  recordRevision: number;
};

type ApprovedDeliveryPlan = {
  plan: DeliveryPlanRevision;
  milestones: readonly MilestoneRevision[];
  taskContracts: readonly TaskRevision[];
  dependencies: readonly TaskDependencyRevision[];
  traces: readonly (
    | {
        kind: 'milestone_covers';
        milestoneId: MilestoneId;
        milestoneRevision: number;
        requirement: PlanRequirementRef;
      }
    | {
        kind: 'task_satisfies';
        taskId: TaskId;
        taskContractRevision: number;
        requirement: PlanRequirementRef;
      }
  )[];
  milestoneDependencies: readonly MilestoneDependency[];
};
```

`milestones`, `taskContracts`, and `dependencies` are ordered complete
memberships, not “latest” lookups. Every task member is a plan-authored contract
revision. Historical `ApprovedDeliveryPlan` values reconstruct without current
lifecycle rows. The latest plan revision by number is canonical; its
`baseDeliveryPlanRevision` must equal the previously canonical revision or null
for revision 1.

### Milestone revisions

A milestone has stable identity and this exact immutable revision:

```ts
type MilestoneRevision = {
  id: MilestoneId;
  projectId: ProjectId;
  revision: number;
  lifecycle: 'active' | 'retired';
  title: PlanText;
  outcome: PlanText;
  stopCondition: PlanText;
  exclusions: readonly PlanText[];
  ordinal: number;
  proposalId: DeliveryPlanProposalId;
  deliveryPlanRevision: number;
  approvedAt: IsoTimestamp;
};
```

New milestones must be `active`. Revision may retire or reactivate them.
Milestone completion is not an M3 state; evidence-based milestone gates belong
to M6.

### Task contract and lifecycle revisions

A task has one immutable revision sequence, but every revision declares whether
it is a plan-contract anchor or a lifecycle-only successor:

```ts
type TaskRevision = {
  id: TaskId;
  projectId: ProjectId;
  revision: number;
  contractRevision: number;
  revisionKind: 'plan_contract' | 'operational_lifecycle';
  lifecycle: 'pending' | 'completed' | 'retired';
  milestoneId: MilestoneId;
  title: PlanText;
  outcome: PlanText;
  acceptanceCriteria: readonly PlanText[];
  verificationCriteria: readonly PlanText[];
  priority: 'must' | 'should' | 'could';
  labels: readonly PlanLabel[];
  ownedSurfaces: readonly PlanText[];
  prohibitedSurfaces: readonly PlanText[];
  expectedArtifacts: readonly PlanText[];
  ordinal: number;
  source:
    | {
        kind: 'plan';
        proposalId: DeliveryPlanProposalId;
        deliveryPlanRevision: number;
      }
    | { kind: 'lifecycle'; priorRevision: number };
  createdAt: IsoTimestamp;
};
```

For a plan-authored revision, `revisionKind` is `plan_contract`,
`contractRevision === revision`, and lifecycle is only `pending | retired`.
For an operational revision, `revisionKind` is `operational_lifecycle`,
`contractRevision` points to one exact plan-contract revision, every contract
field is byte-equal to that anchor, and only `pending <-> completed` may change.
Operational revisions cannot retire, move, or edit a task. The plan membership
and `task_satisfies` traces point to `contractRevision`; they never drift to a
later operational revision.

M3 exposes no task-completion or reopen command. A later authoritative service
must guard the current plan revision, contract anchor, and current task revision
before appending a lifecycle revision. The server resolves current operational
state for a plan member as the greatest task revision whose
`contractRevision` equals that member's anchored revision. A missing anchor,
two revisions with the same number, changed contract content, or a globally
newer revision tied to an obsolete anchor is an integrity/stale-writer failure,
never a readiness guess.

Plan `reuse` preserves the selected current lifecycle because it carries the
same contract anchor and guards its latest lifecycle revision. Plan `revise`
creates a new contract anchor as `pending | retired`, so completion evidence for
the old contract is not inherited. Retiring a completed task therefore creates
a retired plan-contract anchor; reactivation creates a pending anchor. A late
completion against the old anchor loses the guard and writes nothing.

Every active task belongs to exactly one active milestone. Cross-milestone
dependencies are legal and validated in the same project-wide graph.

### Dependency revisions and reverse transitions

A task dependency has stable identity, immutable endpoints, and this exact
immutable revision:

```ts
type TaskDependencyRevision = {
  id: TaskDependencyId;
  projectId: ProjectId;
  revision: number;
  prerequisiteTaskId: TaskId;
  dependentTaskId: TaskId;
  lifecycle: 'active' | 'retired';
  proposalId: DeliveryPlanProposalId;
  deliveryPlanRevision: number;
  approvedAt: IsoTimestamp;
};
```

Its directed meaning is:

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

Milestone dependencies are an authoritative derivation, not another mutable
graph:

```ts
type MilestoneDependency = {
  prerequisiteMilestoneId: MilestoneId;
  dependentMilestoneId: MilestoneId;
  throughTaskDependencyIds: readonly TaskDependencyId[];
};
```

For every active task edge whose endpoints belong to different active
milestones in the exact plan, the server groups by ordered milestone pair and
sorts the contributing dependency IDs. Intra-milestone edges contribute
nothing. These derived values populate `ApprovedDeliveryPlan`, Board milestone
context, and planning review. They are not proposed, stored, revised, or
independently editable; changing the underlying active task edges changes the
next plan revision's derivation. The task DAG remains the only readiness graph;
M3 does not add a second milestone-cycle rule or use this summary for
scheduling.

### Requirement traceability

Each plan revision stores two trace kinds:

- `milestone_covers`: exact milestone revision -> exact requirement revision;
- `task_satisfies`: exact task contract revision -> exact requirement revision.

Approval requires:

- every trace target is an approved requirement member of the captured ledger;
- every active milestone covers at least one requirement and owns at least one
  active task;
- every active task satisfies at least one requirement;
- every `task_satisfies` target is also covered by that task's milestone;
- every approved requirement in the captured ledger is covered by at least one
  active milestone and satisfied by at least one active task.

Trace rows are immutable plan-revision membership, not mutable requirement or
operational-task fields. Lifecycle-only task revisions inherit trace meaning
through their unchanged `contractRevision`; they do not copy or edit trace
rows. Requirement or task-contract revision changes therefore do not rewrite
an old plan.

## Deterministic Readiness

Readiness is a pure domain calculation. Its complete inputs are one exact
approved plan/base, its anchored task-contract and milestone revisions, the
current lifecycle revision selected for every anchored task contract, and the
plan's exact dependency revisions. Selection of a task lifecycle revision is
part of the domain read described above, not “latest task row” guessing. The
calculation does not read processes, profiles, workspaces, runs, browser state,
or time.

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

Completion appends a guarded lifecycle revision on the same contract anchor and
can make dependents actionable. Reopen appends another guarded revision and
reverses them to blocked. A replan that reuses the anchor preserves that state;
a replan that revises the contract creates a pending/retired anchor and ignores
old completion evidence. Ordered `task.lifecycle_changed` and
`delivery_plan.approved` events carry complete replacement Board views, so
replay order, a fresh snapshot, and restart selection from immutable rows
converge on the same current lifecycle and readiness.

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
  milestoneIds: readonly MilestoneId[]; // unique, 0..20; empty means all
  taskLifecycles: readonly ('pending' | 'completed' | 'retired')[]; // unique, 0..3
  readiness: readonly ('actionable' | 'blocked' | 'inactive')[]; // unique, 0..3
  priorities: readonly ('must' | 'should' | 'could')[]; // unique, 0..3
  labels: readonly string[]; // unique canonical labels, 0..100
  requirementRecordIds: readonly LedgerRecordId[]; // unique, 0..300
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
type BoardFacetOption<Value> = {
  value: Value;
  label: string;
  selected: boolean;
  matchingTaskCount: number; // nonnegative integer
};

type BoardMilestoneOption = BoardFacetOption<MilestoneId> & {
  milestoneRevision: number;
  lifecycle: 'active' | 'retired';
  historical: boolean;
};

type BoardRequirementOption = BoardFacetOption<LedgerRecordId> & {
  recordRevision: number;
  requirementKind: RequirementKind;
  historical: boolean;
};

type BoardDependencySummary = {
  dependencyId: TaskDependencyId;
  dependencyRevision: number;
  direction: 'prerequisite' | 'dependent';
  otherTaskId: TaskId;
  otherTaskTitle: string;
  otherTaskLifecycle: 'pending' | 'completed' | 'retired';
};

type BoardTaskDetail = {
  acceptanceCriteria: readonly PlanText[];
  verificationCriteria: readonly PlanText[];
  ownedSurfaces: readonly PlanText[];
  prohibitedSurfaces: readonly PlanText[];
  expectedArtifacts: readonly PlanText[];
  milestoneOutcome: PlanText;
  milestoneStopCondition: PlanText;
  milestoneExclusions: readonly PlanText[];
  requirementTraces: readonly {
    recordId: LedgerRecordId;
    recordRevision: number;
    title: string;
  }[];
};

type BoardTaskCard = {
  taskId: TaskId;
  taskContractRevision: number;
  taskCurrentRevision: number;
  milestoneId: MilestoneId;
  milestoneRevision: number;
  title: string;
  outcome: PlanText;
  lifecycle: 'pending' | 'completed' | 'retired';
  priority: 'must' | 'should' | 'could';
  labels: readonly PlanLabel[];
  readiness: TaskReadiness;
  dependencies: readonly BoardDependencySummary[];
  detail: BoardTaskDetail;
};

type BoardView = {
  projectId: ProjectId;
  deliveryPlanRevision: number | null;
  stale: boolean;
  emptyReason:
    | 'intent_required'
    | 'planning_required'
    | 'plan_empty'
    | 'filter_empty'
    | null;
  filter: BoardFilter | null;
  totalTaskCount: number;
  matchedTaskCount: number;
  facets: {
    milestones: readonly BoardMilestoneOption[];
    taskLifecycles: readonly BoardFacetOption<
      'pending' | 'completed' | 'retired'
    >[];
    readiness: readonly BoardFacetOption<
      'actionable' | 'blocked' | 'inactive'
    >[];
    priorities: readonly BoardFacetOption<'must' | 'should' | 'could'>[];
    labels: readonly BoardFacetOption<string>[];
    requirements: readonly BoardRequirementOption[];
  };
  cards: readonly BoardTaskCard[];
};
```

`emptyReason` is `intent_required` before intent approval,
`planning_required` after intent approval but before plan approval,
`plan_empty` for an approved plan with no current task identities, and
`filter_empty` only when tasks exist but none match. A stale plan keeps its
cards, sets `stale: true`, and exposes `plan_stale` blockers rather than
pretending to be empty.

Each facet option's count is the number of current plan task identities that
match all other filter fields plus that option; the option's own field is
temporarily omitted for counting. This count domain is server-owned,
nonnegative, and includes retired task identities when the candidate lifecycle
permits them. Current-plan options plus selected historical milestone/
requirement identities are returned; a selected historical option may have
count zero. `totalTaskCount` is before filters and `matchedTaskCount` is after
all filters.

Strict output bounds follow the input maxima: at most 100 cards, 40 milestone
options (20 current plus 20 selected historical), 600 requirement options (300
current plus 300 selected historical), 2,100 label options, the fixed enum
option counts above, and 200 dependency summaries per card. Counts are
nonnegative integers no greater than `totalTaskCount`; IDs/options are unique
and canonically ordered.

Cards sort by milestone ordinal, task ordinal, then task ID. `detail` is the
complete server-owned task-detail projection, so opening and closing task detail
requires no query, command, or client reconstruction. The browser only selects
one returned card locally. Facets, cards, details, and counts come from the same
coherent canonical read.

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

Their strict command payloads are:

```ts
type SubmitPlanTurnCommand =
  | {
      type: 'planning_cycle.submit_plan_turn';
      projectId: ProjectId;
      planningCycleId?: never;
      expectedCycleRevision: null;
      profileId: WorkerProfileId;
      profileRevision: number;
      expectedProjectIntentId: ProjectIntentId;
      expectedProjectIntentRevision: number;
      expectedLedgerId: LedgerId;
      expectedLedgerRevision: number;
      expectedDeliveryPlan:
        | { id: DeliveryPlanId; revision: number }
        | { id: null; revision: null };
      message: string; // trimmed, 1..16,384 characters
    }
  | {
      type: 'planning_cycle.submit_plan_turn';
      projectId: ProjectId;
      planningCycleId: PlanningCycleId;
      expectedCycleRevision: number;
      profileId?: never;
      profileRevision?: never;
      expectedProjectIntentId?: never;
      expectedProjectIntentRevision?: never;
      expectedLedgerId?: never;
      expectedLedgerRevision?: never;
      expectedDeliveryPlan?: never;
      message: string; // trimmed, 1..16,384 characters
    };

type ApprovePlanProposalCommand = {
  type: 'plan_proposal.approve';
  projectId: ProjectId;
  planningCycleId: PlanningCycleId;
  expectedCycleRevision: number;
  proposalId: DeliveryPlanProposalId;
  expectedProposalRevision: number;
  expectedProjectIntentId: ProjectIntentId;
  expectedProjectIntentRevision: number;
  expectedLedgerId: LedgerId;
  expectedLedgerRevision: number;
  expectedDeliveryPlan:
    | { id: DeliveryPlanId; revision: number }
    | { id: null; revision: null };
};

type RejectPlanProposalCommand = {
  type: 'plan_proposal.reject';
  projectId: ProjectId;
  planningCycleId: PlanningCycleId;
  expectedCycleRevision: number;
  proposalId: DeliveryPlanProposalId;
  expectedProposalRevision: number;
  feedback: PlanText; // required
};

type BoardFilterSelection = Pick<
  BoardFilter,
  | 'milestoneIds'
  | 'taskLifecycles'
  | 'readiness'
  | 'priorities'
  | 'labels'
  | 'requirementRecordIds'
>;

type SetBoardFilterCommand = {
  type: 'board_filter.set';
  projectId: ProjectId;
  expectedFilterRevision: number;
  filter: BoardFilterSelection;
};

type M3CommandSuccess =
  | {
      ok: true;
      schemaVersion: 2;
      commandType: 'planning_cycle.submit_plan_turn';
      planningCycle: PlanningCycleView;
    }
  | {
      ok: true;
      schemaVersion: 2;
      commandType: 'plan_proposal.approve';
      planningCycle: PlanningCycleView;
      deliveryPlan: ApprovedDeliveryPlan;
      board: BoardView;
    }
  | {
      ok: true;
      schemaVersion: 2;
      commandType: 'plan_proposal.reject';
      planningCycle: PlanningCycleView;
    }
  | {
      ok: true;
      schemaVersion: 2;
      commandType: 'board_filter.set';
      board: BoardView;
    };
```

The start variant freezes and guards all three canonical bases. The continue
variant reuses the immutable assignment/profile/base on its exact cycle and
therefore forbids profile and base fields. Approve rechecks both its explicit
bases and every member guard stored in the proposal. Reject requires feedback;
no empty-reason rejection exists. Successes above join the existing strict M2
success and failure union, and command-result persistence uses these exact
shapes. The frozen raw decoder also retains every exact unversioned M2 success
shape that embeds `LegacyM2PlanningCycleView`. New successes for existing M2
planning commands, including purpose-aware `planning_cycle.abandon`, use
`schemaVersion: 2` and the new `PlanningCycleView`; unversioned output is legacy
only. Replaying a seeded M2 idempotency key returns its byte-identical raw stored
result, while projection consumers normalize its cycle as `intent`. Migration 3
therefore copies command results without making their strict parser invalid.

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

Protocol remains `mesh.v2/1`; there is no second socket or Board polling
protocol. M3 does **not** widen either persisted M2 payload in place. The raw
event decoder keeps the exact strict M2 schemas as legacy alternatives and adds
explicitly versioned new-write alternatives:

```ts
type M3PlanningCycleChangedPayload = {
  schemaVersion: 2;
  planningCycle: PlanningCycleView;
};

type M3IntentLedgerApprovedPayload = {
  schemaVersion: 2;
  planningCycle: PlanningCycleView;
  intentLedger: ApprovedIntentLedger;
  board: BoardView;
};

type DeliveryPlanApprovedPayload = {
  schemaVersion: 1;
  planningCycle: PlanningCycleView;
  deliveryPlan: ApprovedDeliveryPlan;
  board: BoardView;
};

type BoardFilterChangedPayload = {
  schemaVersion: 1;
  board: BoardView;
};

type TaskLifecycleChangedPayload = {
  schemaVersion: 1;
  task: TaskRevision; // operational_lifecycle only
  board: BoardView;
};

type LegacyM2PlanningCycleView = {
  cycle: PlanningCycle;
  turns: readonly PlanningTurn[];
  questions: readonly PlanningQuestion[];
  proposals: readonly PlanningProposal[];
};
type LegacyM2PlanningCycleChangedPayload = {
  planningCycle: LegacyM2PlanningCycleView;
};
type LegacyM2IntentLedgerApprovedPayload = {
  planningCycle: LegacyM2PlanningCycleView;
  intentLedger: ApprovedIntentLedger;
};

type PersistedPlanningCycleChangedPayload =
  | LegacyM2PlanningCycleChangedPayload
  | M3PlanningCycleChangedPayload;
type PersistedIntentLedgerApprovedPayload =
  | LegacyM2IntentLedgerApprovedPayload
  | M3IntentLedgerApprovedPayload;
```

`LegacyM2PlanningCycleChangedPayload` remains exactly strict
`{ planningCycle: LegacyM2PlanningCycleView }`.
`LegacyM2IntentLedgerApprovedPayload` remains exactly the current strict M2
approved-planning outcome. A legacy decoder defaults its cycle purpose to
`intent`, both delivery-plan base fields to null, and
`deliveryPlanProposals` to `[]`. Because M3 is the first code capable of writing
a plan, a legacy intent-approval event deterministically normalizes with
`deliveryPlan: null` and this Board default: event project ID,
`deliveryPlanRevision: null`, `stale: false`, `emptyReason:
'planning_required'`, null filter, zero total/matched counts, empty facet arrays,
and empty cards. No decoder consults current database state while replaying an
old event.

Every event written after migration 3 uses the versioned alternative; omission
of `schemaVersion` is accepted only by the frozen legacy shapes. Stored event
JSON, sequence numbers, timestamps, and checksums are never rewritten. The
domain union contains:

- versioned `planning_cycle.changed`, carrying one complete purpose-aware cycle
  view and its correct proposal history;
- `delivery_plan.approved`, carrying the terminal cycle, complete
  `ApprovedDeliveryPlan`, and complete current `BoardView`;
- `board.filter_changed`, carrying the complete `BoardView`;
- versioned `intent_ledger.approved`, carrying the current Board so a new
  requirement revision immediately projects `plan_stale` blockers;
- `task.lifecycle_changed`, carrying the guarded operational revision and
  replacement Board.

M3 defines the parser, reducer, and transactional projection contract for
`task.lifecycle_changed` because readiness consumes task lifecycle. No M3
command or production service emits it. A later evidence-owning service must
append it in the same transaction as the lifecycle revision; M3 tests it with
repository fixtures, without inventing completion authority or execution.

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
intent approval, Board uses `intent_required`; after intent approval and before
first plan approval, `deliveryPlan` is null and Board uses
`planning_required`. After approval, snapshot construction reads intent, plan,
plan memberships, current lifecycle revisions, filter, and Board within one
coherent database transaction.

Reducers replace complete cycle, plan, and Board projections. They do not merge
cards or recalculate filter membership. Duplicate sequence delivery is a no-op;
stale sequences, gaps, project mismatch, invalid payloads, or an incomplete
plan/Board pair mark the projection stale and request resync. Reconnect uses the
existing domain/runtime cursors. A retained gap produces existing
`v2.resync_required`; the browser fetches a fresh project snapshot and replaces
server truth while preserving only its local unsent form draft.

Contract, repository, and reducer tests first seed byte-for-byte M2
`planning_cycle.changed` and `intent_ledger.approved` rows, migrate without
rewriting them, parse and normalize them, restart, and prove the M2 planning/
ledger projection plus the default `planning_required` Board. Mixed-history
tests then apply proposal revision, approval, lifecycle completion/reopen,
replan, filter, and later intent-approval events to an earlier snapshot and
assert byte-equivalence with a fresh final snapshot and restart. Runtime events
remain only PM transport facts and never mutate Board state.

## Persistence and Migration

Migration `003_planning_board.sql` is appended; `001_foundation.sql` and
`002_intent_ledger.sql` remain byte-for-byte immutable. It adds:

- `planning_cycle_purposes`, backfilled one-to-one as `intent` for every M2
  cycle;
- `delivery_plan_proposals`, proposal member/trace tables, and append-only
  proposal decision rows;
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
cycle, at most one terminal decision per proposal, one reserved ID per proposal
key, one dependency identity per immutable endpoint pair, one normalized active
edge per plan revision, one trace per subject/requirement/revision tuple, and one
Board filter per project. JSON is canonicalized and parsed through shared
contracts on read.

Each task revision's `(task_id, contract_revision)` references a same-task
revision. Repository validation requires that target to be `plan_contract`,
requires plan memberships/traces to target it, and requires every
`operational_lifecycle` row to copy its contract fields exactly. The transaction
that appends an operational revision compare-and-swaps current plan revision,
contract revision, and greatest task revision. These constraints make a stale
completion/reopen or a lifecycle revision for an obsolete replan base a no-write
conflict.

Migration 3 rebuilds only `command_results` inside the outer immediate migration
transaction. Its check accepts the exact M1/M2 command types plus the four M3
types above, copies all existing rows without transformation, restores primary-
key uniqueness, and then applies the remaining schema. A forced failure after
the rebuild restores the exact M2 schema, rows, indexes, migration ledger, and
command replay behavior.

The existing `pm_output_receipts`, planning turns, questions, project event
store, command repository, and project cursors are reused. Migration 3 does not
update the project event table: legacy payload bytes and checksums remain exact,
and compatibility lives solely in the strict raw decoder/normalizer. There is
no new event store, receipt store, Board-card cache, or runtime database.

Fresh-schema tests and exact migration-2 upgrade tests seed nonempty M1 and M2
commands, intent cycles, proposals, receipts, approved ledgers, domain/runtime
events, and cursors. Upgrade must preserve event bytes/checksums and produce the
specified normalized M2 planning/ledger plus `planning_required` Board on read,
replay, and restart.

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
membership, graph, traces, task contract anchors, and greatest matching
lifecycle revisions before serving a snapshot; corruption fails closed and
does not manufacture readiness. A command committed before process loss but not
published is recovered by ordered replay, not re-execution.

Every report input retains raw diagnostic-before-runtime-event ordering. Every
proposal, approval, filter, intent-drift Board projection, and later guarded
task lifecycle write commits its domain rows, ordered event, and applicable
command result before publication. Failure to write an audit record or required
event trips the existing central barrier and prevents later unsafe mutation.

## Planning and Board UI

### PM planning experience

After intent approval, PM Chat derives compatible profile choices only from
approved profile revisions whose scope is global or this project, whose
`assignmentKinds` is exactly `['pm_plan']`, and whose `outputSchema` is exactly
`mesh.dev/pm-plan-report/v1`. Starting a cycle requires one exact selected
profile ID/revision; later turns display and reuse that frozen selection and the
wire schema rejects replacement profile fields. With no compatible profile,
the start control is disabled with a text explanation.

With no approved plan, the action is “Plan delivery” and opens an editable
message prefilled with “Propose a delivery plan for the approved intent and
requirement ledger.” With an approved current plan it is “Replace plan” and
prefills “Revise the approved delivery plan against the current intent and
requirement ledger.” With `plan_stale` it is “Replan current requirements” and
uses the same replacement text. The user must submit the message; opening the
form never creates a turn.

The new-cycle submit sends the exact selected profile, null cycle revision,
current intent ID/revision, ledger ID/revision, and current delivery-plan
ID/revision or the joint-null first-plan base from `SubmitPlanTurnCommand`. A
question answer, revision request, or attention retry sends only cycle ID,
expected cycle revision, and message. Server conflict reloads current truth and
does not silently retry. A delivery-plan cycle uses the existing transcript and
question cards, but its proposal card renders:

- proposal revision and exact intent/ledger/plan base;
- milestone outcomes, stop conditions, exclusions, and order;
- tasks grouped by milestone with acceptance/verification criteria;
- cross-milestone dependencies in prerequisite -> dependent language;
- exact milestone coverage and task-satisfaction traces;
- server-computed create/revise/reuse/retire/reactivate counts;
- one complete Approve, Request revision, Reject, and Abandon boundary.

No per-item checkbox or partial approval control exists. Request revision uses
the ordinary labeled human message. Reject opens a required 1..4,096 character
feedback field and sends the exact cycle/proposal revision guards. Old revisions
remain inspectable and are clearly marked superseded.

Control availability is deterministic:

- `awaiting_human` enables Send answer and Abandon;
- `awaiting_approval` on the latest proposal enables Approve, Request revision,
  Reject, and Abandon;
- `attention_required` enables a labeled retry message and Abandon; retry
  creates a fresh turn/execution, while diagnostics explain that no native
  session resumes;
- `launch_pending` and `execution_active` disable Send/proposal decisions and
  leave only Abandon when its M2 cleanup boundary is available;
- history-limit disables another turn and leaves Abandon;
- `approved`, `proposal_rejected`, and `abandoned` expose no cycle action. The
  ordinary start form returns as “Replace plan” or “Replan current requirements”
  when an approved plan exists, otherwise “Plan delivery.” Rejection and
  abandonment never remove the still-current approved plan;
- disconnected, stale-projection, and submitting states disable every mutation.

Approval replaces the plan/Board and leaves the terminal proposal reviewable.
Later intent approval marks that plan stale and exposes the replacement-plan
path; it does not reopen the approved cycle. Errors use an `aria-live` region
and focus returns to the proposal heading, rejection field, or message field as
appropriate.

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
2. Approve a project-scoped PM profile whose sole assignment kind is `pm_plan`
   and output schema is `mesh.dev/pm-plan-report/v1`; assert an incompatible
   discovery profile is absent from the selector.
3. Submit the editable initial planning message with null cycle/plan bases and
   exact profile, intent 1, and ledger 1 guards. Assert the assignment freezes
   those IDs/revisions and no provider resume handle.
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
   Verify self-excluding facet counts. Reload after one filter and assert its
   revision and results persist.
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
remains queryable. A contract-anchor sequence fixture completes a prerequisite,
replans by reusing its anchor, reopens it, replans by revising its contract, and
rejects a late completion for the obsolete anchor. Ordered lifecycle/replan
event replay and restart must match the fresh Board at every step. No public M3
completion/reopen command or execution is introduced.

The scenario never launches a real agent, opens a worktree, reads credentials,
uses operator runtime paths, binds V1 ports, or kills an unowned process.

## Affected Surface Decisions

- **Contracts: yes.** `packages/v2-contracts` gains plan/Board IDs, strict plan
  contracts, `PmPlanAssignment`, command/results, versioned events plus frozen
  M2 legacy decoders, purpose-aware cycle views, and snapshot fields. Protocol
  version remains unchanged.
- **Commands: yes.** The existing V2 route parses four new human commands and
  preserves current status/error mapping. No new endpoint family is added.
- **Runtime: narrowly yes.** The existing execution substrate accepts
  `pm_plan`, routes its structured output to one explicit consumer, and extends
  the deterministic Todo fake. It gains no workspace, Developer, run, or
  scheduling behavior.
- **Persistence: yes.** One forward migration, plan/readiness repositories,
  task contract/lifecycle anchoring, atomic approval, saved filter, immutable
  history, command replay, and startup integrity checks are required. Applied
  migrations and existing event payload bytes remain immutable.
- **Realtime: yes.** Existing project domain events, cursors, replay, socket,
  retained-gap resync, strict legacy normalization, and publication ordering
  carry complete plan/Board projections. No new stream is added.
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
  active/retired/reactivated, task/milestone retirement/reactivation, guarded
  task completion/reopen projection, plan stale after intent change, filter
  replacement, and restart/replay recovery are explicit and tested.
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
proposal keys/refs, exact lifecycle enums, task contract/current-revision
guards, complete Board facets/details/empty reasons, frozen strict M2 event
alternatives, version-required new events, and no workspace/run/attempt field.

### Migration and persistence

Fresh and exact-M2 upgrade tests prove migration 3, sidecar backfill, immutable
revisions, proposal reservations without premature canonical rows, complete
memberships/traces, dependency history, saved filters, all command-result
types, task contract/lifecycle anchor selection, and exact M1/M2 replay
preservation. Seeded legacy event JSON/checksums remain unchanged and normalize
identically before/after restart. Forced migration failure after the command
table rebuild restores exact M2 state.

### Domain and approval

Focused tests cover questions, proposals, revision/supersession, rejection,
abandonment, duplicate/malformed reports, exact base and member conflicts,
atomic approval, injected failure at every write boundary, project-wide DAG
validation, trace completeness, retirement/reactivation, plan staleness,
filter idempotency, and Board derivation. Readiness cases cover proposal versus
approval, current versus stale ledger, pending/completed/retired tasks, retired
milestones, zero/one/multiple prerequisites, completed prerequisites, edge
retirement/reactivation, and prerequisite reopen. A focused immutable sequence
proves completion on anchor A, replan reuse preserving completion, reopen on A,
replan revision creating pending anchor B, rejection of a late A completion,
and byte-equivalent replay/restart Board output. Milestone dependency derivation
tests cover zero, one, and multiple contributing cross-milestone task edges.

### Runtime and fake adapter

Tests prove one finite PM execution per plan turn, bind-before-activation,
strict output before completion, raw diagnostic before runtime publication,
same/different digest handling, invalid/missing-output attention, runtime
failure attention, bound-terminal-reservation attention, human attention retry,
pre-reservation no-write retry, and no native plan session reuse. Existing
restart, terminal reconciliation, and abandon-race suites run for `pm_plan` as
well as `pm_discovery`, while foundation/intent fake behavior remains unchanged.

### HTTP, events, snapshots, and web

Route tests cover every command and exact status mapping. Event/repository/
reducer tests prove complete projection, duplicates, gaps, invalid payloads,
legacy/new mixed ordered replay, retained-gap resync, lifecycle/replan ordering,
and fresh-snapshot equivalence. Component tests cover compatible profile
selection, exact initial/replan/continue payloads, required rejection feedback,
every lifecycle control transition, proposal revisions, complete approval
authority, server-owned filters/facet counts, cards/blockers/traces, task detail
focus, tabs, labels, live errors, and every empty/loading/stale state.

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
  purpose; intent and plan proposal artifacts remain separate, and the full M2
  attention/failure/retry transition model applies to both.
- Plan PM output schema is exactly `mesh.dev/pm-plan-report/v1`; every human
  turn owns one finite execution.
- Plan proposal revisions are immutable complete snapshots. Revision feedback
  creates a new proposal; approval is human-only and all-or-nothing.
- Canonical plans, milestones, tasks, and dependencies use stable identities
  and immutable revisions. Plan revisions name exact members and traces.
- Plan membership/traces anchor an exact task contract; readiness selects the
  greatest guarded lifecycle revision on that anchor. Replan revise never
  inherits completion from an obsolete contract.
- Approval reserves proposal IDs first and materializes them only in the exact
  successful approval transaction.
- Traceability targets exact approved requirement revisions from the frozen
  ledger, and coverage is complete for all approved requirements.
- Dependency endpoints are immutable; active/retired/reactivated revisions
  preserve history. The active graph is project-wide and acyclic.
- Milestone dependencies are derived from active cross-milestone task edges and
  have no separate mutable persistence or proposal operation.
- M3 creates pending tasks only and cannot mark work complete. Readiness still
  defines completed/reopened behavior for later authoritative writers.
- Actionable means current approved plan + pending active task + completed
  active prerequisites. It says nothing about workspaces, runs, workers, or
  capacity.
- One durable project Board filter is server-owned. Empty selections mean all;
  AND applies across filter fields and OR within a field.
- Board cards are derived from canonical plan, readiness, traces, and saved
  filter. Facet counts and complete task detail are server projections, never a
  second mutable source of truth.
- Intent approval after plan approval preserves the plan but blocks pending
  work as `plan_stale` until an exact new plan revision is approved.
- Protocol, project domain/runtime streams, command route, cursor ordering,
  replay, retained-gap resync, audit barrier, and V2 datastore identity remain.
- Strict M2 persisted event payloads remain accepted and byte-immutable; all M3
  writes use explicit payload versions and normalize before projection.
- Migration 3 is forward-only; migrations 1 and 2 are immutable.
- Default verification is fake-only and temporary. No V1 state, real harness,
  credential, operator worktree, or subscription quota is touched.
- No `DeveloperAttempt`, workspace allocation, execution loop, task claim,
  `ExecutionRun`, scheduler, concurrency limit, or wave exists in M3.

If any stop-condition item needs an execution, workspace, run, or scheduling
object to pass, the implementation has crossed the milestone boundary and must
return to planning rather than adding that object.
