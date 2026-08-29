# Mesh V2 Milestone 2: Intent and Requirement Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert a fake-backed PM conversation into one human-approved,
immutable `ProjectIntent` and Requirement Ledger revision with durable
provenance, relationships, replay, restart recovery, and an accessible review
UI.

**Architecture:** Extend the M1 V2 contracts and persistence with one
planning-specific aggregate and one forward migration. Every human turn creates
one finite PM `WorkerExecution`; a strict planning receipt consumer records
questions or a complete proposal, and only an exact human approval transaction
creates canonical immutable revisions. Existing project events, snapshots,
WebSocket replay/resync, and the focused shell carry the result end to end.

**Tech Stack:** TypeScript 6, Node.js 22, Nx 23, Zod 4,
better-sqlite3 13, Fastify 5, WebSocket, React 19, Vite 8, Vitest 4,
Testing Library, Playwright, Prettier.

**Spec:**
[`docs/superpowers/specs/2026-08-29-mesh-v2-milestone-2-intent-ledger-design.md`](../specs/2026-08-29-mesh-v2-milestone-2-intent-ledger-design.md)

## Global Constraints

- Start every worker from the exact frozen wave base supplied by the
  coordinator; confirm `git rev-parse HEAD` before editing and do not rebase,
  merge, reset, clean, push, open a pull request, or remove a worktree.
- Read `AGENTS.md`, the V2 architecture, the milestone design, and only the
  assigned task section before editing; use jCodeMunch and jDocMunch as required
  by repository policy.
- Change only the task's owned surfaces. Every other tracked path is
  prohibited. Stop if a correct change requires an unowned surface or an
  unsettled interface.
- Preserve operator-owned state, existing worktrees, branches, processes,
  credentials, and real repositories. Tests use only temporary repositories,
  temporary databases, and the deterministic fake harness.
- Never set, read, or fall back to `ANTHROPIC_API_KEY` or another paid API key.
  Do not invoke real Codex, Claude Code, or external-agent traffic in tests.
- V1 remains runnable and must not import V2 code. V2 must not import
  `@mesh-session-platform/contracts` or any file under `apps/server`,
  `apps/web`, or `e2e`.
- V1 ports remain `3737` and `4200`. V2 development defaults remain `3838` and
  `4300`; only the existing test-only built-server fixture may request port
  `0`. Do not kill processes by name or path pattern.
- Keep the V2 application ID, database path, and `MESH_V2_*` configuration
  boundary. Add only migration `002_intent_ledger.sql`; never edit
  `001_foundation.sql` or an applied migration.
- Use M1 command idempotency and `BEGIN IMMEDIATE`. Persist raw runtime input and
  required diagnostics before normalized runtime publication; persist domain
  changes and ordered project events before domain publication. Any audit
  persistence failure stops further unsafe mutation.
- Every human turn creates exactly one finite PM `WorkerExecution` with output
  schema `mesh.dev/pm-discovery-report/v1`. Do not add a persistent provider
  session, real adapter behavior, or a generic output-consumer framework.
- Reserve and durably bind the exact PM execution before activation can start
  an adapter or consume events. Reconcile bound cycles before recovered-session
  attachment, pending-launch drain, or command acceptance after restart.
- Permit at most one nonterminal planning cycle per project. Bound each cycle
  to 32 human turns, 32 PM turns, and 16 proposals; project snapshots carry the
  active cycle plus at most 19 terminal cycle views.
- Only `actor: { kind: 'human' }` may approve, reject, or abandon. Approval is
  one complete proposal revision; agent output, process completion, and partial
  item selection never mutate canonical intent.
- M2 ends at approved intent and ledger recovery. Do not add milestones, tasks,
  task dependencies, readiness, requirement coverage, scheduling, workspaces,
  Developer/QA attempts, evidence, Board cards, or any other M3 behavior. Leave
  the Board placeholder unchanged.
- Non-trivial behavior is test-driven: first run the focused test and observe
  the stated failure, implement only the described behavior, then rerun the
  same test and observe success.
- Before every worker, reviewer, rework, integration, wave, final, or
  post-rework command that invokes Nx or `pnpm verify`, set
  `$env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'` in that PowerShell
  process and record both values plus `git rev-parse HEAD` with the result.
  This is mandatory campaign evidence: daemon state and cached artifacts can
  outlive isolated worktrees and otherwise report a result produced from a
  different branch or head. A cached or daemon-backed result is not an
  acceptance gate.
- No worker edits this design, this plan, another worker's handoff, or campaign
  scratch state. No worker delegates top-level ownership or launches parallel
  agents.

## Settled Interface Map

Task T01 owns every T01-owned cross-process contract type and event below.
Later tasks consume those exact names and may not change their signatures. T02
implementation-local service types shown in this map—including
`PmExecutionReservation`, `PmExecutionLaunchInput`, and
`PmExecutionLauncher`—are explicitly excluded from T01 ownership.

```ts
export const PM_DISCOVERY_REPORT_SCHEMA =
  'mesh.dev/pm-discovery-report/v1' as const;

export type PlanningCycleLifecycle =
  | 'discovering'
  | 'launch_pending'
  | 'execution_active'
  | 'awaiting_human'
  | 'awaiting_approval'
  | 'attention_required'
  | 'approved'
  | 'proposal_rejected'
  | 'abandoned';

export type PlanningProposalLifecycle =
  | 'awaiting_approval'
  | 'superseded'
  | 'approved'
  | 'rejected';

export type RequirementKind =
  | 'functional'
  | 'quality'
  | 'ux'
  | 'safety'
  | 'operational'
  | 'constraint';
export type RequirementStatus =
  | 'proposed'
  | 'approved'
  | 'superseded'
  | 'rejected'
  | 'retired';
export type RequirementRelationshipKind =
  | 'refines'
  | 'depends_on'
  | 'conflicts_with'
  | 'supersedes'
  | 'duplicates';
export type DecisionStatus = 'active' | 'superseded' | 'retired';
export type AssumptionStatus =
  | 'active'
  | 'confirmed'
  | 'invalidated'
  | 'retired';
export type QuestionStatus = 'open' | 'answered' | 'retired';
export type RiskStatus = 'open' | 'mitigated' | 'accepted' | 'retired';

export type PmDiscoveryAssignment = {
  kind: 'pm_discovery';
  projectId: string;
  outputSchema: typeof PM_DISCOVERY_REPORT_SCHEMA;
  planningCycleId: string;
  humanTurnId: string;
  expectedCycleRevision: number;
  expectedProposalRevision: number;
  baseProjectIntentRevision: number | null;
  baseLedgerRevision: number | null;
  input: PmDiscoveryInput;
};

export type PmDiscoveryInput = {
  conversation: readonly {
    turnId: string;
    actor: 'human' | 'pm';
    message: string;
  }[];
  latestProposal: PlanningProposal | null;
  approvedIntentLedger: ApprovedIntentLedger | null;
};

export type PmDiscoveryReport = {
  schema: typeof PM_DISCOVERY_REPORT_SCHEMA;
  planningCycleId: string;
  humanTurnId: string;
  expectedCycleRevision: number;
  expectedProposalRevision: number;
  assistantMessage: string;
  result: PmQuestionResult | PmProposalResult;
};

export type SubmitPlanningTurnEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_cycle.submit_turn' }>;
};
export type ApprovePlanningProposalEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_proposal.approve' }>;
};
export type RejectPlanningProposalEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_proposal.reject' }>;
};
export type AbandonPlanningCycleEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_cycle.abandon' }>;
};

export type PlanningCycleView = {
  cycle: PlanningCycle;
  turns: readonly PlanningTurn[];
  questions: readonly PlanningQuestion[];
  proposals: readonly PlanningProposal[];
};

export type ApprovedIntentLedger = {
  projectIntent: ProjectIntentRevision;
  ledger: LedgerRevision;
  records: readonly LedgerRecordRevision[];
  relationships: readonly LedgerRelationship[];
};
```

`WorkerExecution.assignment` becomes
`FoundationCheckAssignment | PmDiscoveryAssignment`. Runtime output adds this
event variant:

```ts
type WorkerExecutionStructuredOutputRuntimeEventDraft = {
  projectId: string;
  executionId: string;
  adapterCursor: number;
  occurredAt: string;
  type: 'worker_execution.structured_output';
  payload: { schema: string; value: unknown };
};
```

`V2ProjectSnapshot` adds:

```ts
planningCycles: readonly PlanningCycleView[];
planningHistoryTruncated: boolean;
intentLedger: ApprovedIntentLedger | null;
```

The planning service boundary produced by T02 and consumed by T05 is:

```ts
export type PmExecutionReservation = {
  execution: WorkerExecution;
  result: V2CommandResult;
  activationRequired: boolean;
};

export type PmExecutionLaunchInput = StartExecutionEnvelope;

export type PmExecutionLauncher = {
  findReserved(
    input: PmExecutionLaunchInput,
  ): PmExecutionReservation | undefined;
  reserve(input: PmExecutionLaunchInput): Promise<PmExecutionReservation>;
  activate(executionId: WorkerExecutionId): Promise<void>;
  cancelReserved(executionId: WorkerExecutionId): Promise<WorkerExecution>;
  interruptForPlanning(executionId: WorkerExecutionId): Promise<void>;
};

export class PlanningService {
  submitTurn(
    envelope: SubmitPlanningTurnEnvelope,
  ): Promise<V2CommandResult>;
  approveProposal(
    envelope: ApprovePlanningProposalEnvelope,
  ): V2CommandResult;
  rejectProposal(
    envelope: RejectPlanningProposalEnvelope,
  ): V2CommandResult;
  abandonCycle(
    envelope: AbandonPlanningCycleEnvelope,
  ): Promise<V2CommandResult>;
  reconcilePendingReservations(): void;
  drainPendingLaunches(): Promise<void>;
  reconcileBoundCycles(): void;
  reconcileTerminalExecution(executionId: string): void;
}

export class PmReportConsumer {
  consume(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
  ): void;
}
```

T03 adds read-only `ExecutionRuntime.findReservedStart`, plus `reserveStart`,
`activateReserved`, and `cancelReserved` while preserving the existing `start`
signature as a reserve/activate wrapper. T05 adapts those methods to
`PmExecutionLauncher`;
T02 reserves with deterministic idempotency key
`planning-turn:<humanTurnId>`, commits the exact execution binding, and only
then activates it. No layer duplicates execution lifecycle code.

```ts
export type ReservedExecutionStart = {
  execution: WorkerExecution;
  result: V2CommandResult;
  activationRequired: boolean;
};

export class ExecutionReservationError extends Error {
  readonly result: V2CommandResult;
}

export class ExecutionRuntime {
  findReservedStart(
    envelope: StartExecutionEnvelope,
  ): ReservedExecutionStart | undefined;
  reserveStart(
    envelope: StartExecutionEnvelope,
  ): Promise<ReservedExecutionStart>;
  activateReserved(executionId: WorkerExecutionId): Promise<void>;
  cancelReserved(executionId: WorkerExecutionId): Promise<WorkerExecution>;
  interruptForPlanning(executionId: WorkerExecutionId): Promise<void>;
  start(envelope: StartExecutionEnvelope): Promise<V2CommandResult>;
}

export class PlanningInterruptCleanupError extends Error {
  readonly code:
    | 'planning_interrupt_not_running'
    | 'planning_interrupt_unproven'
    | 'planning_interrupt_audit_failure'
    | 'planning_interrupt_quiescence_failure';
}
```

`ReservedExecutionStart` and T02's `PmExecutionReservation` are deliberately
structurally identical; the T05 adapter is the sole W1 composition point.
T02 exports `PmExecutionLaunchInput` from
`apps/v2-server/src/planning/planning-service.ts` as an implementation-local
alias of T01's existing `StartExecutionEnvelope`; it is not a new contracts
type. T01's assignment-union extension makes the existing envelope schema accept
`PmDiscoveryAssignment`, while every other field and validation rule remains
owned by `startExecutionEnvelopeSchema`. T02 constructs and parses the complete
envelope—derived turn key, human actor, start command discriminator, exact
project, frozen profile ID/revision, and exact PM assignment—without optional or
inferred launcher fields. T05 passes that object unchanged to
`ExecutionRuntime.findReservedStart` or `reserveStart`.
The service boundary has no implicit local type names: its planning-specific
types are declared in this map, and every remaining referenced type is an
existing M1 contract or a T01-owned cross-process type named above.
`findReserved` and `ExecutionRuntime.findReservedStart` are synchronous,
read-only SQLite lookups. Therefore `reconcilePendingReservations` remains
synchronous and must return only after every existing reservation has been
projected; startup cannot publish recovery, attach sessions, drain fresh turns,
or accept commands before that return.
`interruptForPlanning` is T03-owned and internal. It accepts only an execution
ID, never synthesizes `InterruptExecutionEnvelope`, never traverses the public
human command route, and never reads or writes `command_results`. On the first
running call, under M1's per-execution interlock, it captures the exact
`ActiveSession` entry (`HarnessSession` and consume task), marks that entry
fenced, asserts the audit barrier, transitions the exact execution to
interrupting, and creates an `execution_operations.kind = 'interrupt'` row
whose request is tagged `mesh.v2.planning-interrupt/v1`. The consume loop checks
that fence after each iterator result and before every diagnostic, event,
persistence, or publication boundary. A late result is discarded.

Still owning the cleanup attempt, the bridge appends/publishes the committed
interrupting event, awaits adapter interrupt with barrier checks, closes the
captured `HarnessSession`, awaits settlement and removal of that exact consume
task, and checks the barrier again. Only after that fence proves consumer
quiescence does it transactionally record the interrupted or attention-required
terminal state, operation proof, and terminal event and resolve. It preserves
M1 audit-before-publish, containment, barrier, and diagnostic ordering. The
bridge is callable only from the external planning coordinator; a call from its
own consume task throws typed before fencing, so it can never await itself.
After fencing, close-and-join is mandatory containment even when adapter
interrupt rejects; retain the adapter rejection as the primary typed diagnostic
and attach any close/join failure without reporting cleanup success.

Calls for the same execution coalesce while live. After a successful prior
planning-interrupt operation, replay against its already-terminal execution is
an idempotent success; an unrelated terminal execution or any other non-running
state throws `PlanningInterruptCleanupError` without adapter work. Adapter
rejection/unproven interruption records attention plus the operation proof and
throws `planning_interrupt_unproven`. Barrier or audit-write failure contains
owned work, performs no later adapter/publication work, and throws
`planning_interrupt_audit_failure`. Exact-session close or consume-task
settlement/removal failure preserves the operation and diagnostics, contains
owned work, and throws `planning_interrupt_quiescence_failure`; it must not
claim terminal cleanup. The planning coordinator awaits this method and may
commit Abandon only after it resolves; every typed failure occurs before the
Abandon transaction and stores no successful Abandon result/event.
The exact execution ID plus its first tagged planning-interrupt operation is the
durable coordinator-attempt identity; replay never creates a second tagged
operation for that execution.
`reserveStart` rejects with `ExecutionReservationError` before any write when
project/profile lookup or adapter capability/skill probing cannot produce the
required snapshots. The M1 `start` wrapper preserves its command-result behavior;
T02 leaves the planning turn pending for retry or human abandonment.

Every returned reservation is linked through exactly one existing
`execution_operations` `kind: 'start'` row. Its request contains the
idempotency key/request hash and its `execution_id` is authoritative. T03
creates and immediately fails that operation for terminal capability/skill
reservations, and replay resolves the exact execution through
`OperationRepository.findStartReservation`; it never infers from assignments or
the generic command result. Migration 2 uniquely indexes the normalized start
key/hash. Missing or conflicting replay links trip the audit barrier.

Pre-migration terminal foundation command results may legitimately lack an
operation. The existing public `start` wrapper preserves its early stored-result
replay for those commands and does not call `reserveStart`; planning calls only
post-migration `reserveStart`, where an absent link is never accepted.

Accepted turns atomically move the cycle and turn to `launch_pending`. That
cycle lifecycle accepts only same-key command replay or human Abandon; a
distinct turn returns `planning_cycle_revision_conflict` with no write.
`drainPendingLaunches` coalesces by turn, and `activateReserved` coalesces by
execution only inside the live process until terminal/running state owns it.
After process loss, an existing starting/pending/no-handle reservation is never
activated: M1 finishes its operation `unknown` and moves its execution to
attention, then `reconcilePendingReservations` binds/projects that exact truth
to the complete cycle. Only a pending turn with no start-operation link may make
one fresh reservation and live activation.

One per-cycle `PlanningLaunchCoordinator` arbitrates drain and Abandon. Abandon
signals cancellation before waiting. `cancelReserved` shares the execution
interlock with activation: if cancellation owns the boundary it fails the
linked starting execution and pending start operation with existing
`startup_interrupted_before_start` evidence and no adapter call; if activation
already owns it, cancellation waits and returns the running or terminal
execution. Planning interrupts the running result before committing Abandon.
No adapter start may occur after the abandoned-cycle commit, and M1's public
human interrupt contract is unchanged and is never called by planning. Planning
instead awaits T03's internal `interruptForPlanning`, whose success means the
exact active session is closed and its consume task has settled and been
removed; cancellation, interruption, or quiescence failure stores no successful
Abandon result/event and does not mark the cycle abandoned. Cleanup succeeds
first and the abandoned transaction always commits last.

T01 freezes these planning result codes; T02 returns them and T05 may not
reinterpret them:

| Code | HTTP status from `/api/v2/commands` |
| --- | --- |
| `planning_cycle_not_found` | `200` with `ok: false` |
| `planning_cycle_active_conflict` | `200` with `ok: false` |
| `planning_cycle_revision_conflict` | `200` with `ok: false` |
| `planning_cycle_history_limit` | `200` with `ok: false` |
| `planning_proposal_not_found` | `200` with `ok: false` |
| `planning_proposal_revision_conflict` | `200` with `ok: false` |
| `planning_canonical_base_conflict` | `200` with `ok: false` |
| `planning_profile_incompatible` | `200` with `ok: false` |
| `planning_proposal_invalid` | `200` with `ok: false` |

Malformed/non-human envelopes remain `invalid_request`/`400`; origin rejection
is `403`; retained-gap/stable transport conflicts are `409`; stopping/audit
failures are `503`; unknown exceptions are `500`.

## Dependency Waves and Ownership Audit

| Wave | Tasks | Why ready | Non-overlap proof | Gate |
| --- | --- | --- | --- | --- |
| W0 | T01 | No implementation dependency | Sole owner of `packages/v2-contracts/**` | Contract tests/typecheck/build; downstream compatibility debt recorded |
| W1 | T02, T03, T04 | T01 accepted | T02 owns database/planning domain; T03 owns execution runtime/fake; T04 owns new leaf web components only | Three focused suites plus integrated server typecheck; web typecheck deferred |
| W2 | T05 | All W1 tasks accepted | Sole serialized owner of server/web composition and every shared file | Integrated server/web tests, typechecks, builds; no deferred compatibility remains |
| W3 | T06 | T05 accepted | Sole owner of `e2e-v2/**` and current development docs | Todo E2E, full verify, stop-condition audit |

W1 workers start from the same accepted W0 head. They must not import another
W1 worker's new implementation file. T01 contracts are the only shared
interface. T05 starts from the deterministic integration of T02, T03, then T04
and is intentionally serialized because it touches shared composition. T06
starts only after T05 review and integration.

T01 intentionally widens strict contract unions before their server and web
consumers can be updated. That temporary incompatibility is bounded: T01 proves
only `v2-contracts`; T02 defers the full `v2-server` typecheck until accepted
T02 and T03 commits share the W1 integration head; T04 defers full `v2-web`
test/typecheck/build until T05 lands on the W2 integration head. A focused
Vitest command remains a worker gate only when it loads the owned leaf modules
without compiling incompatible consumers. If the repository's configured test
target instead performs a whole-project compile, record that command as the
same deferred gate rather than claiming a false worker pass. W1 cannot advance
to W2 without the integrated server typecheck; W2 cannot advance to W3 without
the integrated web test, typecheck, and build.

## Required Worker and Reviewer Handoffs

Every worker returns:

```text
TASK HANDOFF
Task: the frozen task ID
Status: ready_for_review | blocked
Branch: the worker branch
Base: the full frozen base commit
Commit: the full worker commit, or none when blocked
Outcome: one sentence describing the delivered result
Changed surfaces:
- every changed owned path and its purpose
Acceptance evidence:
- every criterion with repository or test evidence
Verification:
- every exact command, exit code, and concise result
Deferred compatibility gates:
- exact command, reason, compatibility owner, and required integration wave; or none
Unverified:
- every unverified item, or none
Risks or decisions:
- every material item, or none
Review focus:
- the highest-risk behavior
```

For each worker commit, a fresh read-only reviewer checks the exact base-to-head
diff, owned/prohibited surfaces, this task's interfaces and acceptance criteria,
focused tests, safety invariants, and overbuilding risk. The reviewer returns
`accept`, `rework`, or `blocked` with file/line findings and verification
evidence. Rework returns to the original worker and receives a new independent
review. No task enters integration from its worker report alone. Reviewer gate
evidence must show the exact reviewed HEAD and both mandatory Nx environment
values; otherwise the result is unverified. Reviewers must distinguish the
explicit T02 server and T04 web compatibility deferments from unexpected
failures and confirm that each is assigned to its mandatory integration gate;
they may not require a worker to claim a whole-project gate that this plan says
is temporarily unrunnable.

Every reviewer returns:

```text
REVIEW HANDOFF
Task: the frozen task ID
Commit: the exact reviewed commit
Verdict: accept | rework | blocked
Findings:
- severity, path:line, impact, and required correction; or none
Contract coverage:
- every acceptance criterion marked satisfied, unsatisfied, or unverified with evidence
Verification:
- every exact command, exit code, and concise result
Deferred compatibility gates:
- bounded deferments and mandatory integration owner/wave; or none
Residual risks:
- every residual risk, or none
```

Every wave integrator returns the frozen base, accepted commits in the declared
order, integration-only commit if one was explicitly authorized, exact combined
changed paths, every gate command/result, unexpected surfaces, and whether the
wave stop condition is satisfied. Every Nx/verify result includes its exact HEAD
and daemon-disabled/cache-disabled environment. The coordinator accepts a wave
only after a separate review confirms that handoff against repository evidence.

### Coordinator Campaign Ledger and Morning Handoff

The coordinator maintains one campaign ledger outside worker-owned commits and
updates it at worker launch, handoff, review, rework, integration, and gate
boundaries. Each task row records: task ID and wave; worker/reviewer IDs; frozen
base; branch; absolute worktree; worker commit; exact changed paths; review
commit and verdict; every rework commit and fresh reviewer; integration order
and resulting head; commands/results; decisions and assumptions; blockers; the
observed `origin/master` SHA; and whether origin drifted from the campaign base.
Every Nx/verify command entry records `NX_DAEMON=false`,
`NX_SKIP_NX_CACHE=true`, and the exact tested HEAD.
Every deliberately deferred compatibility gate also gets a ledger entry with
the originating task/head, exact command not yet runnable, observed or expected
incompatibility, responsible compatibility owner, required integration wave,
and the later exact-head passing evidence. A deferment is neither a pass nor a
worker defect unless it exceeds this plan's frozen boundary.
Origin drift is informational unless the coordinator explicitly replans; no
worker rebases or absorbs it.

At the end of the unattended run, the coordinator returns exactly this
operator-facing packet, populated from repository evidence rather than worker
claims:

```text
MORNING HANDOFF
Status: ready_for_milestone_review | ready_for_hands_on_test | blocked
Campaign base: <full SHA>
Origin/master observed: <full SHA and drift yes/no>
Integration head: <full SHA or none>
Tasks: <each ID, branch, worktree, worker commit, review ID/verdict, rework commits>
Integration: <ordered commits, integration commits, resulting heads>
Decisions and assumptions: <settled items or none>
Verification: <exact commands, exit codes, concise results, and head tested>
Deferred gates: <origin, command, owner/wave, and discharge evidence; or none>
Stop-condition proof: <each final criterion satisfied/unproved with evidence>
Blockers: <owner and bounded next action, or none>
Review: <final independent reviewer ID, exact head, verdict, findings>
Changed surfaces: <exact base-to-head paths>
Unverified and risks: <items or none>
```

---

### Task T01: Intent, Planning, and Realtime Contracts

**Outcome:** Every process shares one strict, bounded contract for planning
cycles, reports, proposals, canonical revisions, commands, events, and
snapshots, without introducing an M3 type.

**Files:**

- Create: `packages/v2-contracts/src/intent.ts`
- Modify: `packages/v2-contracts/src/ids.ts`
- Modify: `packages/v2-contracts/src/commands.ts`
- Modify: `packages/v2-contracts/src/events.ts`
- Modify: `packages/v2-contracts/src/executions.ts`
- Modify: `packages/v2-contracts/src/profiles.ts`
- Modify: `packages/v2-contracts/src/http.ts`
- Modify: `packages/v2-contracts/src/index.ts`
- Test: `packages/v2-contracts/src/contracts.spec.ts`
- Prohibited: every path outside `packages/v2-contracts/**`

**Interfaces:**

- Consumes: existing `V2CommandEnvelope`, `WorkerExecution`, `DomainEvent`,
  `RuntimeEvent`, `V2ProjectSnapshot`, ID-branding, timestamp, and strict Zod
  conventions.
- Produces: every T01-owned cross-process contract type and event in the
  Settled Interface Map; branded IDs for planning
  cycles/turns/questions/proposals/intents/ledgers/records; strict
  `ProjectIntentContent`, record discriminated unions, proposal members and
  relationships, complete-cycle events, PM-compatible profiles, command
  results, and the exact stable error/status table above. It does not produce
  T02 implementation-local service aliases or launcher interfaces.

- [ ] **Step 1: Add red contract cases for the exact domain vocabulary**

  Add table-driven parsing cases that assert all six requirement kinds, all
  five requirement statuses, all five requirement relationship kinds, the five
  record types and their settled lifecycle statuses, and `constrains`. Assert
  reversed `conflicts_with`/`duplicates` normalize to one lexical pair while
  directed kinds retain order. Include failures for an unknown kind, missing
  risk mitigation, invalid answered-question resolution, requirement-only
  fields on a decision, a self-edge, and an M3-shaped `taskId` field.
  Include `launch_pending` in the cycle lifecycle and the turn launch-state
  transition to `execution_bound`.

  ```ts
  it.each([
    'functional',
    'quality',
    'ux',
    'safety',
    'operational',
    'constraint',
  ])('accepts requirement kind %s', (kind) => {
    expect(
      requirementRecordContentSchema.parse({
        type: 'requirement',
        statement: 'Users can complete a Todo item.',
        rationale: 'Completion is core to the product.',
        kind,
        status: 'proposed',
        priority: 'must',
      }).kind,
    ).toBe(kind);
  });

  expect(() =>
    ledgerRelationshipSchema.parse({
      kind: 'covers',
      fromRecordId: crypto.randomUUID(),
      toRecordId: crypto.randomUUID(),
    }),
  ).toThrow();
  ```

- [ ] **Step 2: Run the contract test and prove red**

  Run:

  ```powershell
  corepack pnpm exec vitest run packages/v2-contracts/src/contracts.spec.ts --config packages/v2-contracts/vitest.config.ts
  ```

  Expected: FAIL because `intent.ts` exports and new union variants do not
  exist.

- [ ] **Step 3: Implement `intent.ts` with strict bounded schemas**

  Implement the settled types with `z.strictObject`, branded UUID IDs,
  nonempty trimmed strings, maximum 4,096 characters per narrative field,
  maximum 100 records, 200 relationships, 20 questions, and 20 provenance
  references per record. Bound assignment conversation to 64 turns, each human
  or PM message to 16 KiB, proposal history to 16 revisions, and snapshot cycle
  views to 20. Add `superRefine` rules for unique keys, structurally resolvable
  proposal-local endpoint references, and no self-edge. T02 performs semantic
  endpoint-type validation against reused canonical records.

  ```ts
  export const PM_DISCOVERY_REPORT_SCHEMA =
    'mesh.dev/pm-discovery-report/v1' as const;

  export const ledgerRecordContentSchema = z.discriminatedUnion('type', [
    requirementRecordContentSchema,
    decisionRecordContentSchema,
    assumptionRecordContentSchema,
    questionRecordContentSchema,
    riskRecordContentSchema,
  ]);

  export const pmDiscoveryReportSchema = z.strictObject({
    schema: z.literal(PM_DISCOVERY_REPORT_SCHEMA),
    planningCycleId: planningCycleIdSchema,
    humanTurnId: planningTurnIdSchema,
    expectedCycleRevision: nonNegativeIntegerSchema,
    expectedProposalRevision: positiveIntegerSchema,
    assistantMessage: boundedNarrativeSchema,
    result: z.discriminatedUnion('kind', [
      pmQuestionResultSchema,
      pmProposalResultSchema,
    ]),
  });
  ```

- [ ] **Step 4: Extend execution, command, event, result, and snapshot unions**

  Add the four human commands and envelopes, the nine exact planning failure
  codes, planning-specific success result variants, `PmDiscoveryAssignment`,
  structured-output runtime event, replay-complete `planning_cycle.changed`,
  `intent_ledger.approved`, and the three snapshot fields. The cycle event
  carries one complete bounded `PlanningCycleView`; snapshots carry at most 20
  cycle views and an explicit truncation flag. Keep every union strict and add
  project/embedded-record coherence refinements.

  ```ts
  export const submitPlanningTurnCommandSchema = z
    .strictObject({
      type: z.literal('planning_cycle.submit_turn'),
      projectId: projectIdSchema,
      planningCycleId: planningCycleIdSchema.optional(),
      expectedCycleRevision: nonNegativeIntegerSchema.nullable(),
      profileId: workerProfileIdSchema.optional(),
      profileRevision: positiveIntegerSchema.optional(),
      message: z.string().trim().min(1).max(16_384),
    })
    .superRefine(requireProfileOnlyForNewCycle);
  ```

  Extend `profiles.ts` with exactly two allowed single-kind tuples:
  `['foundation-check']` retains its current bounded output-schema behavior,
  while `['pm_discovery']` requires
  `mesh.dev/pm-discovery-report/v1`. Refine execution/start-request parsing so
  assignment `projectId`, selected project, approved profile scope/revision,
  assignment kind, and PM output schema are coherent.

- [ ] **Step 5: Add round-trip, strictness, and authority tests**

  Parse valid question/proposal reports, complete-cycle supersede/reject events,
  complete snapshots, and all four command results. Assert unknown fields fail,
  the output schema literal is exact, all proposal-local keys resolve, snapshot
  children match the project, command actors are human, and no approval command
  is representable inside `PmDiscoveryReport`. Add compatibility cases proving
  existing foundation profiles still parse, exact PM profiles/assignments parse,
  and a PM profile with the wrong assignment kind or output schema fails.

- [ ] **Step 6: Run the T01 green gate**

  Run:

  ```powershell
  $env:NX_DAEMON='false'
  $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm nx test v2-contracts
  corepack pnpm nx typecheck v2-contracts
  corepack pnpm nx build v2-contracts
  git diff --check
  ```

  Expected: all commands exit `0`; contract tests include explicit failures for
  `taskId`, `covers`, unknown fields, non-human command envelopes, and
  incompatible PM profile/output bindings. Record, without running or claiming,
  the downstream full `v2-server` and `v2-web` compatibility gates: widened
  strict unions are allowed to remain temporarily unhandled until T03 and T05,
  respectively. This bounded deferment does not weaken the T01 contract gate.

- [ ] **Step 7: Commit T01**

  ```powershell
  git add -- packages/v2-contracts/src/intent.ts packages/v2-contracts/src/ids.ts packages/v2-contracts/src/commands.ts packages/v2-contracts/src/events.ts packages/v2-contracts/src/executions.ts packages/v2-contracts/src/profiles.ts packages/v2-contracts/src/http.ts packages/v2-contracts/src/index.ts packages/v2-contracts/src/contracts.spec.ts
  git commit -m "feat(v2): define intent ledger contracts"
  ```

**Acceptance:** The contracts express the full M2 approval boundary and exact
enums, round trip safely, and contain no milestone/task/coverage/readiness type.

---

### Task T02: Immutable Planning and Ledger Persistence

**Outcome:** Planning history and canonical revisions persist through one
forward migration, and the domain service proves complete atomic approval,
idempotent receipt consumption, stale rejection, and failure rollback without
runtime or transport composition.

**Files:**

- Create: `apps/v2-server/src/db/migrations/002_intent_ledger.sql`
- Modify: `apps/v2-server/src/db/migrate.ts`
- Modify: `apps/v2-server/src/db/database.spec.ts`
- Create: `apps/v2-server/src/planning/planning-repository.ts`
- Create: `apps/v2-server/src/planning/planning-repository.spec.ts`
- Create: `apps/v2-server/src/planning/planning-service.ts`
- Create: `apps/v2-server/src/planning/planning-service.spec.ts`
- Create: `apps/v2-server/src/planning/pm-report-consumer.ts`
- Create: `apps/v2-server/src/planning/pm-report-consumer.spec.ts`
- Modify: `apps/v2-server/src/test/create-v2-test-database.ts`
- Prohibited: `apps/v2-server/src/main.ts`, `apps/v2-server/src/http/**`,
  `apps/v2-server/src/executions/**`, all web/e2e paths, and
  `001_foundation.sql`

**Interfaces:**

- Consumes: T01 contracts; M1 `V2CommandRepository`, `V2EventStore`,
  `ExecutionRepository`, `WorkerProfileService.resolveApproved`,
  `inImmediateTransaction`, `AuditBarrier`, and test DB.
- Produces: `PlanningRepository`, `PlanningService`, `PmReportConsumer`,
  implementation-local `PmExecutionLaunchInput = StartExecutionEnvelope`,
  `PmExecutionLauncher`, `planningSnapshot(projectId)`,
  `approvedIntentLedger(projectId)`, and durable pending-launch reads.

- [ ] **Step 1: Write red migration and repository tests**

  Prove a fresh database and an exact migration-1 database both reach migration
  2; capture the SHA-256 of `001_foundation.sql` before the test and assert the
  source is unchanged. Test immutable inserts, ordered turns/proposals,
  conversation-turn-only provenance ownership, proposal key-to-UUID
  reservations without canonical rows, exact ledger membership, the partial
  unique indexes for one nonterminal cycle, one pending turn per cycle, and one
  M1 start-operation key/hash link, symmetric edge normalization, complete
  cycle-view reads, and restart reads. Seed a valid migration-1 start operation
  and prove migration 2 indexes it; malformed or duplicate legacy start links
  fail upgrade instead of becoming ambiguous. Also seed a terminal foundation
  command/execution with no operation and prove upgrade preserves its legal M1
  wrapper-replay compatibility.

  Seed nonempty `command_results` with one valid replayable row for each M1
  command type. Snapshot those rows, command-repository replay results, the
  table SQL, and every M1 index before upgrade; after migration assert the rows
  and replay values are byte-equivalent, every unrelated M1 table/index is
  unchanged, and primary-key/idempotency uniqueness still holds. On both fresh
  and upgraded databases insert and replay all four M2 command/result variants:
  `planning_cycle.submit_turn`, `planning_proposal.approve`,
  `planning_proposal.reject`, and `planning_cycle.abandon`. Force a later
  migration statement to fail after the rebuild and prove the outer transaction
  restores the exact migration-1 table SQL, rows, indices, ledger, and replay
  results with no migration-2 entry.

  ```ts
  expect(migrationRows(database)).toEqual([
    { version: 1, name: '001_foundation' },
    { version: 2, name: '002_intent_ledger' },
  ]);
  expect(repository.approvedIntentLedger(project.id)).toEqual(
    approvedIntentLedgerSchema.parse(expectedLedger),
  );
  ```

- [ ] **Step 2: Run migration/repository tests and prove red**

  Run:

  ```powershell
  corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected: FAIL because migration 2 and `PlanningRepository` do not exist.

- [ ] **Step 3: Add the forward schema and repository mappings**

  Add exactly the tables and constraints from the design. Register migration 2
  after migration 1 in `migrate.ts`. Keep SQL inside the repository and parse
  every read through T01 schemas. Use canonical JSON for arrays/content and
  separate provenance, membership, and relationship rows for referential
  integrity. Include `planning_proposal_records`, the nonterminal-cycle partial
  unique index, the pending-turn partial unique index, the exact unique
  expression index over start-operation request idempotency key/request hash,
  lexical storage constraints for symmetric edges, and no provenance variant
  beyond durable conversation turns.

  Do not alter `001_foundation.sql`. At the start of `002_intent_ledger.sql`,
  rebuild only `command_results` within `migrateV2Database`'s existing immediate
  transaction: create a replacement with the identical five columns and checks
  except for a `command_type` check containing exactly the four M1 plus four M2
  values; copy all rows without transformation; drop the old table; rename the
  replacement; and preserve primary-key uniqueness. Continue all other
  migration-2 statements in that same transaction so any failure rolls the
  rebuild and migration ledger back together.

  ```ts
  const intentLedgerMigration = {
    version: 2,
    name: '002_intent_ledger',
    sql: readFileSync(
      join(__dirname, 'migrations', '002_intent_ledger.sql'),
      'utf8',
    ),
  };
  const migrations = [foundationMigration, intentLedgerMigration] as const;
  ```

- [ ] **Step 4: Make migration/repository tests green**

  Rerun Step 2.

  Expected: PASS for fresh/upgrade databases, all eight command-result types,
  byte-equivalent M1 rows/replay, rollback to exact M1 schema after an injected
  later failure, foreign keys, uniqueness, immutable revision history, and
  restart reads.

- [ ] **Step 5: Write red service tests for turns, proposals, and authority**

  Cover new-cycle PM profile freezing, later-turn profile reuse, one pending
  launch per human turn, exact command replay, question receipt, complete
  proposal receipt, proposal supersession, revision request, rejection,
  cleanup-first abandonment/interruption (including cancellation/interruption
  failure that stores no abandoned cycle/event/result), approval, stale
  cycle/base/record failures, agent self-approval,
  malformed and duplicate output, completion without receipt,
  and injected failures at receipt insert, canonical insert, event append, and
  command-result insert. Prove the nine exact planning failures, single-active
  conflict, 32/32/16 history limits, all five record lifecycle-only removals,
  proposal-time reserved IDs becoming canonical only on approval, and complete
  cycle events for supersede/reject/abandon/launch-pending.

  Race two distinct submit commands from the same acceptable cycle revision.
  Assert exactly one commits a turn and cycle as `launch_pending`; same-key
  replay returns its stored success, while the distinct loser returns
  `planning_cycle_revision_conflict` with no turn, reservation, event, or
  activation. Restart with an unbound terminal reservation and prove the drain
  binds the launcher's exact same execution once, moves the turn to
  `execution_bound` and cycle to attention, and never activates it. For a
  reconciled unbound starting reservation, prove the existing operation is
  `unknown`, its exact execution is `attention_required`, planning binds that
  truth and completes the cycle view as attention, and reserve/activate are not
  called. A pending turn with no operation may reserve and activate freshly.

  Capture every `PmExecutionLauncher.findReserved` and `reserve` argument.
  Assert it parses through T01's `startExecutionEnvelopeSchema` and equals the
  complete `PmExecutionLaunchInput`: `idempotencyKey` is exactly
  `planning-turn:<humanTurnId>`; actor is exactly `{ kind: 'human' }`; command
  type is `worker_execution.start`; project ID is the cycle project; profile ID
  and revision are the cycle's frozen approved PM profile; assignment is the
  exact frozen `PmDiscoveryAssignment`. Reject omissions, substitutions, extra
  fields, or project/profile/assignment mismatches before the launcher call.

  Use controlled launcher barriers for both Abandon races. Pause after
  `reserve` commits but before bind, signal Abandon, release the barrier, and
  assert `cancelReserved` terminalizes that exact execution/start operation,
  the cycle commits `abandoned`, and bind/activate/adapter start never occur.
  Repeat after binding but before activation and prove the same cancellation,
  no late adapter start, no pending start operation, one complete abandoned
  cycle event, and no canonical mutation. Let activation win a third race and
  prove Abandon waits for one running result, awaits exactly one
  `launcher.interruptForPlanning(executionId)`, observes its durable terminal
  outcome, then commits; no start or cleanup work occurs after that commit.
  Inject cancellation and a rejected `interruptForPlanning` Promise without
  importing T03 implementation types; prove no successful Abandon command
  result/event or falsely abandoned cycle is stored. The cycle remains
  nonterminal or reaches attention through its frozen failure. Assert the
  abandoned transaction is always the last durable step and no test models
  terminalization followed by reopening.

  Abandon an already reconciled `attention_required` cycle whose exact start
  operation is `unknown`. Assert the coordinator performs only the read-only
  reservation/execution observation: it does not call `cancelReserved`,
  `activate`, or adapter start; it preserves the operation ID, execution ID,
  link, result, and raw diagnostics; then it commits the abandoned lifecycle,
  complete event, and command result as the final durable step. Prove a new
  cycle is accepted afterward. Inject cleanup/observation failure and each
  final-transaction write failure; assert no successful command result/event or
  abandoned lifecycle is stored, no new cycle is accepted, and no linked
  operation or diagnostic is lost or rewritten.

  For malformed payloads and well-formed reports with wrong project/cycle/turn,
  revision, or schema binding, assert one immediate transaction stores a
  rejected durable receipt with stable reason, moves the complete cycle to
  `attention_required`, and appends its complete-cycle event while inserting no
  PM turn, question, proposal, reservation, or canonical row. Inject failures at
  rejected-receipt insert, attention update, and event append; each must roll
  back the entire rejected path and publish nothing.

  T02 owns approved-profile validation. Using an injected
  `Pick<WorkerProfileService, 'resolveApproved'>`, prove the selected revision
  is approved, global or scoped to the same project, includes `pm_discovery`,
  and has exactly `mesh.dev/pm-discovery-report/v1`; wrong scope/kind/schema
  returns `planning_profile_incompatible` before any turn or execution write.

  ```ts
  await service.submitTurn(firstTurnEnvelope);
  await service.submitTurn(firstTurnEnvelope);
  expect(launcher.reserve).toHaveBeenCalledTimes(1);
  expect(launchTrace).toEqual(['reserve', 'bind', 'publish', 'activate']);

  expect(() =>
    approvePlanningProposalEnvelopeSchema.parse(agentEnvelope),
  ).toThrow();
  const cursorBefore = events.cursors(project.id).domain;
  expect(repository.approvedIntentLedger(project.id)).toBeUndefined();
  expect(events.cursors(project.id).domain).toBe(cursorBefore);
  ```

- [ ] **Step 6: Run service tests and prove red**

  Run:

  ```powershell
  corepack pnpm exec vitest run apps/v2-server/src/planning/planning-service.spec.ts apps/v2-server/src/planning/pm-report-consumer.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected: FAIL because the planning service and receipt consumer do not
  exist.

- [ ] **Step 7: Implement the planning service and receipt consumer**

  Use the exact interfaces in the Settled Interface Map. `submitTurn` commits
  the turn/event/result before invoking a launcher. `drainPendingLaunches`
  derives `planning-turn:<turnId>` and first checks the durable operation link.
  It may call `reserve`, bind, publish, and activate only when no link exists. A
  live-process reserve result follows the normal bind-then-activate sequence.
  Reservation exceptions leave the turn pending, terminal capability/skill
  reservations bind then move the cycle to attention, and activation failures
  terminalize an already-bound execution.

  Build the launcher input once in `planning-service.ts` and validate it with
  `startExecutionEnvelopeSchema.parse`; export its compile-time type only as
  `PmExecutionLaunchInput = StartExecutionEnvelope`. Reuse that exact parsed
  object for the read-only lookup and, only when absent, reservation. Do not
  reconstruct it in the launcher adapter or infer project, profile, assignment,
  actor, or idempotency fields from ambient state.

  Turn acceptance sets both the turn launch state and cycle lifecycle to
  `launch_pending` inside its command transaction. The drain coalesces by turn
  ID, re-reads before binding, and permits activation only after one committed
  `execution_bound` transition. A distinct command cannot create another turn
  while either launch-pending or execution-active. A per-cycle
  `PlanningLaunchCoordinator` accepts an Abandon cancellation signal before it
  waits for the drain. The drain checks that signal after reserve, before bind,
  and inside the execution activation claim. Cancellation invokes
  `cancelReserved`; an activation-owned running result is interrupted before
  the abandoned cycle transaction commits by awaiting
  `interruptForPlanning(executionId)`. Do not construct an
  `InterruptExecutionEnvelope` or invoke the public human command service.
  Cleanup failure propagates its typed error without storing the Abandon
  result/event or lifecycle; cleanup success is followed by one immediate
  abandoned-cycle transaction as the final step.
  For an already reconciled attention cycle, the coordinator instead uses the
  synchronous read-only `findReserved` to observe the exact linked
  attention-required execution and unknown operation. It neither cancels nor
  activates that contained execution, preserves all operation/diagnostic rows,
  and commits abandonment only after observation succeeds. Observation or final
  transaction failure reports no Abandon success and leaves the cycle and audit
  evidence unchanged.

  The consumer is invoked only for a `pm_discovery` assignment. It derives the
  authoritative cycle/turn from that frozen assignment, then performs parsing,
  binding checks, receipt persistence, cycle transition, and event append in
  one immediate transaction per report.

  ```ts
  const launchKey = (turnId: string) => `planning-turn:${turnId}`;

  consume(execution, event): void {
    inImmediateTransaction(this.database, () => {
      if (this.repository.replayReceipt(execution.id, event)) return;
      const cycle = this.repository.requireAssignedCycle(execution.assignment);
      const parsed = validatePmReportInTransaction(execution, event, cycle);
      const change = parsed.ok
        ? this.repository.acceptReport(execution, event, parsed.report, cycle)
        : this.repository.rejectReport(execution, event, parsed.reason, cycle);
      this.events.appendDomainInTransaction(
        execution.projectId,
        planningCycleChangedDraft(change, event.occurredAt),
      );
    });
  }
  ```

  `reconcileBoundCycles` first consumes any durable unconsumed structured output
  for each bound nonterminal cycle, then re-reads it and moves an
  `execution_active` cycle whose execution is terminal or attention-required
  without an accepted receipt to cycle attention. Next,
  `reconcilePendingReservations` checks unbound turns through only the
  launcher's read-only `findReserved`: an existing start-operation link binds
  its exact already-reconciled terminal/attention execution and moves the
  complete cycle view to attention; no link leaves the turn for the later fresh
  drain. Both methods are idempotent and do not attach sessions or activate
  executions.

- [ ] **Step 8: Make service tests green and run the T02 gate**

  Run:

  ```powershell
  $env:NX_DAEMON='false'
  $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.spec.ts apps/v2-server/src/planning/planning-service.spec.ts apps/v2-server/src/planning/pm-report-consumer.spec.ts --config apps/v2-server/vitest.config.ts
  git diff --check
  ```

  Expected: the focused Vitest command and diff check exit `0`; injected
  accepted- or rejected-receipt
  persistence failures leave no partial canonical, receipt, attention,
  command-result, or event rows. Accepted, superseded, rejected, cancelled, and
  abandoned reservations have the exact canonical or noncanonical semantics
  defined by the design, neither Abandon race starts an adapter late, and every
  launcher call receives one schema-validated complete start envelope. Do not
  run or claim full `corepack pnpm nx typecheck v2-server` on the isolated T02
  branch: T01 widened execution unions whose runtime consumers are owned by
  T03. Record that exact command as deferred to the mandatory W1 integration
  gate after accepted T02+T03. If this focused Vitest invocation is discovered
  to compile those incompatible unowned consumers, defer it with the same
  evidence instead of weakening types or editing outside T02 ownership.

- [ ] **Step 9: Commit T02**

  ```powershell
  git add -- apps/v2-server/src/db/migrations/002_intent_ledger.sql apps/v2-server/src/db/migrate.ts apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.ts apps/v2-server/src/planning/planning-repository.spec.ts apps/v2-server/src/planning/planning-service.ts apps/v2-server/src/planning/planning-service.spec.ts apps/v2-server/src/planning/pm-report-consumer.ts apps/v2-server/src/planning/pm-report-consumer.spec.ts apps/v2-server/src/test/create-v2-test-database.ts
  git commit -m "feat(v2): persist intent ledger planning"
  ```

**Acceptance:** Migration 2 is forward-only; all planning and canonical history
survives reopen; human approval is exact and atomic; invalid/duplicate worker
output cannot partially mutate canonical intent; profile incompatibility and
every lifecycle limit fail before unauthorized writes. The only launch-input
type exported by T02 is the local alias to T01's validated start envelope.

---

### Task T03: Finite PM Runtime and Deterministic Fake Reports

**Outcome:** The existing execution substrate carries strict structured output
with audit-first ordering, and the fake adapter produces finite question,
proposal, malformed, duplicate, and missing-output scenarios without a
persistent planning session.

**Files:**

- Modify: `apps/v2-server/src/executions/execution-runtime.ts`
- Modify: `apps/v2-server/src/executions/execution-runtime.spec.ts`
- Modify: `apps/v2-server/src/executions/fake-harness.ts`
- Modify: `apps/v2-server/src/executions/fake-harness.spec.ts`
- Modify: `apps/v2-server/src/executions/harness-adapter.ts`
- Modify: `apps/v2-server/src/executions/operation-repository.ts`
- Prohibited: database migrations, `apps/v2-server/src/planning/**`,
  `apps/v2-server/src/main.ts`, `apps/v2-server/src/http/**`, all web/e2e paths

**Interfaces:**

- Consumes: T01 `PmDiscoveryAssignment`, `PmDiscoveryReport`, and structured
  runtime event; existing `HarnessAdapter`, `HarnessSession`, and
  `V2EventStore.appendRuntimeWithDiagnosticInTransaction`.
- Produces: `FakePmScenario = 'todo' | 'malformed' | 'duplicate' |
  'missing_output'`; `FakeHarnessAdapter` constructor option
  `pmScenario?: FakePmScenario`; `ExecutionRuntime.reserveStart` and
  read-only `findReservedStart`, `activateReserved`, `cancelReserved`, and
  internal `interruptForPlanning`; `PlanningInterruptCleanupError`;
  `OperationRepository.findStartReservation`; the existing public `start` and
  `interrupt` signatures and behavior preserved.

- [ ] **Step 1: Add red runtime ordering and fake scenario tests**

  Assert a Todo question run emits structured output then completion and closes;
  the answer run emits the complete proposal then completion; every structured
  event has a raw diagnostic committed first; malformed emits unparseable
  value; duplicate emits two output envelopes; missing-output emits only
  completion. Assert no second call reuses a native PM handle.

  Freeze absent scenario behavior: a `pm_discovery` assignment with no
  `pmScenario` must start and complete normally through the fake harness with no
  structured output, producing the ordinary planning
  completion-without-receipt attention path. It must not throw, reject an
  import/type, start infrastructure, or affect the unchanged
  `foundation-check` default. This is the deterministic pre-fixture behavior
  used by T06's red journey.

  Add runtime boundary cases proving `reserveStart` returns the exact execution
  and command result without calling `adapter.start`, attaching, or consuming
  events. Cover successful reservation, missing capabilities, missing skills,
  project/profile lookup failure, adapter capability/skill probe failure,
  reservation persistence failure, adapter-start failure, attachment failure,
  and idempotent replay. Lookup/probe/reservation exceptions write no execution
  or event; only `activateReserved` may cross into adapter startup; terminal
  capability/skill reservations report `activationRequired: false`.

  For successful and terminal capability/skill reservations, inspect the
  transaction and assert exactly one start operation contains the idempotency
  key/request hash and exact execution ID. In the same live runtime, replay a
  terminal reservation and prove it returns that execution with no duplicate
  row. Assert read-only `findReservedStart` returns that same linked current
  execution and returns undefined without a command/operation; delete or
  conflict the link and assert fail-closed audit behavior. Race two
  `activateReserved(executionId)` calls before running/attachment and assert one
  adapter start, one running transition, and one attached consumer.
  Separately seed a pre-migration terminal foundation command result without an
  operation and prove public `start` still returns that stored result without
  adapter work, while direct post-migration `reserveStart` never infers it.

  Add controlled `cancelReserved` races against activation. If cancellation
  claims the shared execution interlock first, assert the exact linked
  `starting` execution transitions to `failed` with
  `startup_interrupted_before_start`, its pending start operation finishes
  failed with `planning_cycle_abandoned`, and adapter start/attach/consume remain
  zero. If activation owns first, cancellation waits and returns the one running
  or terminal execution for planning to interrupt or accept. Repeated
  cancellation is idempotent, preserves the operation link, and injected
  execution/operation/event persistence failure trips the audit barrier without
  reporting cancellation success.

  Add focused `interruptForPlanning` cases. A running execution must transition
  through interrupting, append/publish its event only after commit, create one
  tagged internal interrupt operation, and capture/fence its exact active
  `HarnessSession` plus consume task. Use a fake iterator blocked in `next()`
  that attempts to deliver a structured PM report and completion after adapter
  interrupt. Assert the bridge awaits adapter success, closes that exact
  session, waits for that exact task to settle and leave the active map, then
  durably finishes execution/operation/event before resolving. Assert zero late
  diagnostic writes, receipt consumption, runtime/domain events, or publication
  after resolution. The consume loop must check the fence after iterator return
  and before every durable/public boundary. Concurrent calls coalesce; replay
  after that exact finished planning operation and terminal execution is an
  idempotent no-op. A direct self-wait attempt fails before fencing. An
  already-terminal execution without that operation and every other
  non-running lifecycle throw
  `planning_interrupt_not_running` with zero adapter, event, command-result, or
  operation writes. Adapter rejection or unproven already-terminal probe records
  attention plus exact proof and throws `planning_interrupt_unproven`.

  Inject barrier trip, interrupt-operation insert failure, interrupting-event
  insert failure, terminal execution/operation/event persistence failure, and
  adapter rejection, exact-session close rejection, and consume-task
  settlement/removal failure. Assert the existing barrier/containment path runs;
  the exact `planning_interrupt_audit_failure`,
  `planning_interrupt_unproven`, or
  `planning_interrupt_quiescence_failure` reaches the coordinator; operation
  and audit diagnostics remain; no `command_results` row is written; no
  uncommitted event is published; and no adapter, persistence, or publication
  work occurs after containment.

  ```ts
  const fake = new FakeHarnessAdapter({ pmScenario: 'todo' });
  const events = await collect(fake.start(pmStartRequest({ turn: 1 })));
  expect(events.map(({ normalized }) => normalized.type)).toEqual([
    'worker_execution.structured_output',
    'worker_execution.completed',
  ]);
  expect(events[0]?.normalized.payload.schema).toBe(
    PM_DISCOVERY_REPORT_SCHEMA,
  );
  ```

- [ ] **Step 2: Run runtime/fake tests and prove red**

  Run:

  ```powershell
  $env:NX_DAEMON='false'
  $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected: FAIL because the runtime event, PM fake scenarios, reservation
  split, and internal planning-interrupt bridge do not exist.

- [ ] **Step 3: Split reservation from activation and extend the fake script**

  Extract the reservation transaction already at the front of M1 `start` into
  `reserveStart`. It returns `{ execution, result, activationRequired }` and
  never calls `adapter.start`, attaches a session, or launches an event loop.
  Move those effects to idempotent `activateReserved(executionId)`. Keep
  `start(envelope)` at its exact M1 signature as reserve, conditional activate,
  then `result`, mapping typed no-write reservation errors to the existing
  command result so foundation behavior and callers do not change.

  Create one start operation for every inserted execution. Starting executions
  leave it pending; terminal capability/skill executions finish it failed in
  the same transaction. On command replay, resolve the operation by exact
  idempotency key/request hash and load `execution_id`; never derive identity
  from assignment fields. Coalesce activation promises by execution ID before
  `adapter.start`, remove them only after durable running/terminal ownership,
  and limit that ownership to the live process. `findReservedStart` performs
  only the exact command/operation/execution read used by T05 after M1
  reconciliation; it creates nothing and never grants activation authority.
  Implement `cancelReserved` under that same per-execution interlock. It may
  close only an exact operation-linked `starting` execution with a pending start
  operation, using the existing `starting -> failed` transition and
  `startup_interrupted_before_start` failure code; it never calls or broadens M1
  `interrupt`. If activation already owns the interlock, await its durable
  running/terminal result and return that execution without claiming it was
  cancelled. Do not modify M1 reconciliation or add a restart marker/retry in
  T03; its activation tests are live-process tests only.

  Implement `interruptForPlanning(executionId)` beside the existing public
  `interrupt` without calling it. Share only its proven low-level audit/barrier,
  adapter-interrupt/probe, containment, execution-transition, operation, and
  event helpers. The internal method has no actor/idempotency envelope and never
  touches `command_results`; tag its durable operation request
  `mesh.v2.planning-interrupt/v1`. Coalesce its live Promise by execution ID.
  Under the existing execution interlock, capture the exact `ActiveSession`,
  mark it fenced before adapter interruption, and make `consume` exit without
  observing/persisting/publishing any iterator value returned after that fence.
  After adapter interruption and barrier checks, close the captured
  `HarnessSession`, await its captured consume task, and verify that exact entry
  is removed before terminalization and resolution. The method is invoked only
  outside `consume`; detect/reject self-wait before fencing to avoid deadlock.
  Execute close-and-join in the contained failure path as well when adapter
  interruption rejects; preserve both diagnostics and never skip the fence.
  Treat a finished tagged operation plus its interrupted execution as replay
  success; reject unrelated terminal/non-running state with
  `PlanningInterruptCleanupError`. Resolve only after proven terminal writes;
  record unproven adapter outcomes as attention then throw; convert audit/barrier
  failures to the exact typed cleanup error only after containment has stopped
  late work. A close or consume settlement/removal failure preserves the
  operation/diagnostics, contains the execution, and throws
  `planning_interrupt_quiescence_failure` without authorizing terminal cleanup.
  Keep the public human interruption path byte-for-behavior compatible.

  Branch the fake only on `assignment.kind`. Keep the existing foundation
  script intact. For `pm_discovery`, generate a fresh finite native handle and
  the deterministic report bound to assignment IDs/revisions. The Todo proposal
  must include the design's five record types, three requirements, `depends_on`,
  `constrains`, and provenance to both turns. Do not add an adapter session cache
  or provider resume concept. When `pmScenario` is absent, use exactly the
  finite completion-only behavior of `missing_output`; this is a legitimate
  planning failure, not a thrown configuration or infrastructure error.

  ```ts
  const scriptEnvelope = (
    request: HarnessStartRequest,
    adapterCursor: number,
  ): HarnessEventEnvelope =>
    request.assignment.kind === 'pm_discovery'
      ? pmDiscoveryEnvelope(request, adapterCursor, pmScenario)
      : foundationEnvelope(request, adapterCursor);
  ```

  Let the existing runtime validation and
  `appendRuntimeWithDiagnosticInTransaction` path accept the new event. Preserve
  diagnostic-before-event insertion, event-before-publication, cursor checks,
  audit barrier behavior, and terminal lifecycle handling.

- [ ] **Step 4: Make runtime/fake tests green and run the T03 gate**

  Run:

  ```powershell
  $env:NX_DAEMON='false'
  $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts --config apps/v2-server/vitest.config.ts
  corepack pnpm nx typecheck v2-server
  git diff --check
  ```

  Expected: all commands exit `0`; the audit-failure test publishes neither the
  structured event nor completion and trips the barrier. The reservation tests
  show no adapter event can precede the planning binding, while every expected
  or unexpected start failure leaves exactly one durable execution outcome.
  Terminal replay and concurrent activation retain one execution, operation,
  adapter session, and event consumer. Cancellation-first races retain the same
  auditable operation link with no adapter session, and an absent PM scenario
  deterministically reaches completion-without-receipt attention. Internal
  running interruption is awaited, replay-safe for its exact operation,
  audit-first, command-result-free, closes and joins the exact fenced consumer,
  and leaves zero late work after success or typed failure.

- [ ] **Step 5: Commit T03**

  ```powershell
  git add -- apps/v2-server/src/executions/execution-runtime.ts apps/v2-server/src/executions/execution-runtime.spec.ts apps/v2-server/src/executions/fake-harness.ts apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/harness-adapter.ts apps/v2-server/src/executions/operation-repository.ts
  git commit -m "feat(v2): add finite fake pm reports"
  ```

**Acceptance:** PM behavior is finite and fake-only, structured output uses the
existing audited runtime path, and no planning authority enters the adapter.
The exact execution is reservable before consumption and M1 foundation start
behavior remains compatible. The internal running-cleanup bridge is audited,
awaited, replay-safe, typed on failure, and does not create public command
history.

---

### Task T04: PM and Requirements Leaf Views

**Outcome:** Pure accessible components render planning conversation,
questions, complete proposal decisions, and approved ledger details without
owning transport, reducer, lifecycle, or Board behavior.

**Files:**

- Create: `apps/v2-web/src/components/PlanningPane.tsx`
- Create: `apps/v2-web/src/components/PlanningPane.spec.tsx`
- Create: `apps/v2-web/src/components/RequirementsPane.tsx`
- Create: `apps/v2-web/src/components/RequirementsPane.spec.tsx`
- Create: `apps/v2-web/src/components/intent-ledger.css`
- Prohibited: existing files under `apps/v2-web/src/api`, `app`, `state`,
  `ExecutionActivity*`, `FocusedProjectShell*`, `styles.css`, all
  server/contracts/e2e paths

**Interfaces:**

- Consumes: T01 `PlanningCycleView`, `PlanningProposal`,
  `ApprovedIntentLedger`, `WorkerProfileSummary`, and `WorkerExecution`.
- Produces: `PlanningPane` callbacks `onSubmitTurn`, `onApprove`, `onReject`,
  `onAbandon`; `RequirementsPane({ intentLedger })`; no local canonical state.

- [ ] **Step 1: Write red component tests for all visible states**

  Cover initial profile selection/message, transcript order, question rationale
  and choice draft population, execution-active state, complete proposal
  summary/diff/provenance, Approve/Request revision/Reject callbacks, disabled
  disconnected/stale/submitting authority, live error, focus return, approved
  state, rejected/abandoned history, history-limit guidance and Abandon action,
  empty Requirements state, all five record groups, every record lifecycle
  status, provenance, and textual relationship endpoints.

  Add a `launch_pending` case that preserves the accepted human turn, announces
  “Starting project manager…” through the live status region, disables Send and
  all proposal actions, and leaves only connected/current Abandon enabled. It
  must not render another accepting message form or optimistic execution state.

  Add an ambiguous-start `attention_required` case that says Mesh did not retry
  the execution after restart, keeps execution/operation diagnostics visible,
  and guides “Abandon this cycle to start a new one.” Connected/current Abandon
  is enabled; after the server projects successful abandonment, the ordinary
  new-cycle form returns. Never label the unknown execution retrying or running.

  ```tsx
  render(
    <PlanningPane
      cycle={awaitingApprovalCycle}
      connection={{ status: 'ready' }}
      profiles={pmProfiles}
      submitting={false}
      error={undefined}
      onSubmitTurn={onSubmitTurn}
      onApprove={onApprove}
      onReject={onReject}
      onAbandon={onAbandon}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Approve proposal' }));
  expect(onApprove).toHaveBeenCalledWith(latestProposal.id);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  ```

- [ ] **Step 2: Run leaf component tests and prove red**

  Run:

  ```powershell
  $env:NX_DAEMON='false'
  $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/RequirementsPane.spec.tsx --config apps/v2-web/vitest.config.ts
  ```

  Expected: FAIL because both components do not exist.

- [ ] **Step 3: Implement the pure components and isolated styles**

  Use semantic headings, ordered lists, `fieldset`/`legend` for initial PM
  profile selection, a labeled textarea, explicit button text, `aria-live` for
  status/errors, and standard buttons for question choices. Request revision
  exposes the same human-turn textarea and callback; it never exposes per-item
  approval controls.

  Render Abandon cycle for a nonterminal cycle, including history-limit state;
  keep it disabled under the same disconnected/stale/submitting authority gate.
  For ambiguous-start attention, render the frozen recovery guidance and do not
  synthesize activation progress.

  ```tsx
  <section aria-labelledby="pm-chat-heading">
    <h2 id="pm-chat-heading">PM Chat</h2>
    <ol aria-label="Planning conversation">{turns}</ol>
    <label htmlFor="pm-message">Message to project manager</label>
    <textarea id="pm-message" value={draft} onChange={changeDraft} />
    <button type="submit" disabled={commandsDisabled}>Send message</button>
    <p role="status" aria-live="polite">{statusText}</p>
  </section>
  ```

  Requirements renders server-provided relationships and never calculates
  graph, impact, coverage, or readiness.

- [ ] **Step 4: Make component tests green and run the T04 gate**

  Run:

  ```powershell
  $env:NX_DAEMON='false'
  $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/RequirementsPane.spec.tsx --config apps/v2-web/vitest.config.ts
  git diff --check
  ```

  Expected: the focused component tests and diff check exit `0`; callback
  assertions prove one complete approval action and no partial-selection UI.
  Do not run or claim full `v2-web` test/typecheck/build on the isolated T04
  branch: existing snapshot, reducer, shell, socket, and assignment-union
  consumers are serialized T05 ownership. Record those exact gates as deferred
  to W2. If this focused Vitest invocation is configured to compile incompatible
  unowned consumers, defer it with the same evidence rather than changing a T05
  file. W2 must prove full web test, typecheck, and build before W3 starts.

- [ ] **Step 5: Commit T04**

  ```powershell
  git add -- apps/v2-web/src/components/PlanningPane.tsx apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/RequirementsPane.tsx apps/v2-web/src/components/RequirementsPane.spec.tsx apps/v2-web/src/components/intent-ledger.css
  git commit -m "feat(v2): render pm and requirements views"
  ```

**Acceptance:** Pure components cover every required state and accessibility
behavior, show complete-proposal authority, and contain no M3 projection.

---

### Task T05: Server and Web Composition

**Outcome:** The HTTP command route, runtime, startup recovery, snapshots,
realtime projection, API client, reducer, and focused shell compose T02-T04 into
one durable integrated M2 flow while retaining the M1 transport and Board
placeholder.

**Files:**

- Create: `apps/v2-server/src/planning/planning-runtime.ts`
- Create: `apps/v2-server/src/planning/planning-runtime.spec.ts`
- Modify: `apps/v2-server/src/config.ts`
- Modify: `apps/v2-server/src/config.spec.ts`
- Modify: `apps/v2-server/src/executions/execution-runtime.ts`
- Modify: `apps/v2-server/src/executions/execution-runtime.spec.ts`
- Modify: `apps/v2-server/src/executions/reconcile-executions.spec.ts`
- Modify: `apps/v2-server/src/http/routes.ts`
- Modify: `apps/v2-server/src/http/routes.spec.ts`
- Modify: `apps/v2-server/src/http/snapshots.ts`
- Modify: `apps/v2-server/src/main.ts`
- Modify: `apps/v2-server/src/main.spec.ts`
- Modify: `apps/v2-web/src/api/client.spec.ts`
- Modify: `apps/v2-web/src/api/socket.spec.ts`
- Modify: `apps/v2-web/src/state/reducer.ts`
- Modify: `apps/v2-web/src/state/reducer.spec.ts`
- Modify: `apps/v2-web/src/state/resync.ts`
- Modify: `apps/v2-web/src/state/resync.spec.ts`
- Modify: `apps/v2-web/src/state/store.ts`
- Modify: `apps/v2-web/src/app/App.tsx`
- Modify: `apps/v2-web/src/app/App.spec.tsx`
- Modify: `apps/v2-web/src/app/use-project-connection.spec.tsx`
- Modify: `apps/v2-web/src/components/ExecutionActivity.tsx`
- Modify: `apps/v2-web/src/components/ExecutionActivity.spec.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.spec.tsx`
- Modify: `apps/v2-web/src/styles.css`
- Prohibited: contracts, migration/SQL, planning repository/service/consumer,
  `apps/v2-server/src/executions/reconcile-executions.ts`, fake-harness
  implementation, T04 `PlanningPane*`/`RequirementsPane*` implementation, e2e,
  docs, V1, `apps/v2-web/src/api/client.ts`

**Interfaces:**

- Consumes: all T01 contracts, T02 planning service/consumer/read models and
  `PmExecutionLaunchInput`, T03 structured runtime events/fake scenarios, T04
  leaf component props.
- Produces: existing `registerV2Routes`, snapshot/replay endpoints,
  unchanged generic `V2Api.command`, `ProjectProjection`, `App`, and
  `FocusedProjectShell` extended for M2; `ExecutionActivity` narrowed across
  both assignment kinds; no new transport or API method.

- [ ] **Step 1: Write red server composition tests**

  Add route tests for submit/approve/reject/abandon parsing, all nine exact
  planning `ok: false` codes at HTTP 200, malformed/non-human 400, origin 403,
  transport 409, stopping/audit 503, unknown 500, idempotent replay, and human
  actor. Race distinct submit requests at one acceptable revision and assert one
  success, one `planning_cycle_revision_conflict`, one pending turn, and no
  second launch. Add snapshot tests for absent/present ledger, one active plus 19 latest
  terminal cycle views, and truncation. Add runtime integration tests proving a
  structured output is audited/published, consumed once, and terminalized.

  Add startup cases for (a) a bound execution with durable unconsumed output,
  (b) a bound execution terminalized immediately before process loss, (c) an
  unbound terminal capability/skill reservation, (d) a pending turn with no
  operation, and both physically distinct but durably identical starting states:
  (e) crash after reservation/binding but before `adapter.start`, and (f) crash
  after `adapter.start` returns but before native-handle/running persistence.

  In `reconcile-executions.spec.ts`, exercise the existing unmodified M1
  `reconcileExecutions`: for (e) and (f), assert no restarted call to
  `adapter.start` or `resume`, the pending start operation finishes `unknown`,
  the exact execution becomes `attention_required`, and raw reconciliation
  evidence retains the operation/execution link. In planning-runtime tests,
  assert the exact order: M1 reconciliation without attachment; planning output
  replay and bound-cycle terminal/attention reconciliation; unbound existing-
  reservation reconciliation to a complete attention cycle; recovery-window
  publication; recovered-session attachment; fresh drain only for turns with no
  operation; then command acceptance. A valid replayed receipt wins over
  terminal attention. Terminal and unknown/attention reservations bind without
  activation; only case (d) reserves/binds/activates freshly. Assert the
  synchronous `reconcilePendingReservations()` call has returned with all
  projections committed before the recovery-publication trace entry; no promise
  or fire-and-forget reconciliation may cross that boundary.

  Compose a running-execution Abandon through the real planning launcher adapter
  and controlled runtime. Assert `interruptForPlanning` owns one internal tagged
  operation; fences, closes, settles, and removes the exact active consumer; and
  only then records its durable interrupted/attention outcome and resolves.
  Assert this quiescence proof is awaited before the planning abandoned
  event/result transaction and no public interrupt envelope or command-result
  row is created. Release a blocked iterator with late structured output and
  completion after adapter interrupt and assert neither can write or publish,
  including after Abandon commits. Inject each
  `PlanningInterruptCleanupError`, including close/task-settlement failure;
  assert no successful Abandon result/event or abandoned lifecycle is stored,
  diagnostics remain auditable, and no cleanup/publication work occurs after
  containment.

  In `config.spec.ts`, add red cases proving
  `MESH_V2_TEST_FAKE_PM_SCENARIO=todo` is accepted only with `NODE_ENV=test`, is
  absent by default, and returns `invalid_v2_test_option` in production and when
  `NODE_ENV` is unset. Reject unknown scenario values.

  ```ts
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/commands',
    payload: submitTurnEnvelope,
  });
  expect(response.statusCode).toBe(200);
  expect(v2CommandResultSchema.parse(response.json()).commandType).toBe(
    'planning_cycle.submit_turn',
  );
  expect(snapshot.planningCycles[0]?.turns).toHaveLength(1);
  ```

- [ ] **Step 2: Run server composition tests and prove red**

  Run:

  ```powershell
  corepack pnpm exec vitest run apps/v2-server/src/planning/planning-runtime.spec.ts apps/v2-server/src/http/routes.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts apps/v2-server/src/executions/reconcile-executions.spec.ts apps/v2-server/src/main.spec.ts --config apps/v2-server/vitest.config.ts
  corepack pnpm exec vitest run apps/v2-server/src/config.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected: FAIL because planning dependencies are not composed into runtime,
  routes, snapshots, or startup, and config does not recognize the test-only PM
  scenario.

- [ ] **Step 3: Compose the planning runtime without a generic framework**

  `planning-runtime.ts` adapts the planning launcher to
  `ExecutionRuntime.findReservedStart`, `reserveStart`, `activateReserved`,
  `cancelReserved`, and internal `interruptForPlanning`,
  subscribes only to
  `worker_execution.structured_output` and terminal execution notifications,
  and calls T02's planning-specific methods. Add one explicit optional runtime
  observer dependency rather than a registry.

  The T05 adapter is an identity mapping for the frozen launch input:

  ```ts
  findReserved: (input: PmExecutionLaunchInput) =>
    executionRuntime.findReservedStart(input),
  reserve: (input: PmExecutionLaunchInput) =>
    executionRuntime.reserveStart(input),
  interruptForPlanning: (executionId: WorkerExecutionId) =>
    executionRuntime.interruptForPlanning(executionId),
  ```

  In `planning-runtime.spec.ts`, capture both runtime calls and assert the exact
  parsed object from T02 is forwarded by reference/value with no added, omitted,
  or recomputed field. Cover both an existing reservation lookup and a fresh
  reservation. Assert the interruption mapping passes only the execution ID and
  awaits the exact runtime Promise; it never constructs a public command
  envelope. The composed Abandon test must observe runtime consumer quiescence
  before the repository begins the final abandoned-cycle transaction.

  ```ts
  export type ExecutionRuntimeObserver = {
    structuredOutput(
      execution: WorkerExecution,
      event: WorkerExecutionStructuredOutputRuntimeEvent,
    ): void;
    terminal(execution: WorkerExecution): void;
  };
  ```

  Wire repositories/services in `main.ts` and implement the exact startup order
  asserted in Step 1. Preserve `reconcile-executions.ts` unchanged: its
  unknown/attention result, not a new marker, is the authority for every
  persisted starting reservation. Planning calls read-only `findReservedStart`
  after M1 reconciliation, projects existing terminal/attention reservations,
  and never sends them to activation. Reconciliation must finish before
  recovered sessions can produce events, before never-reserved pending launches
  activate, and before the server accepts commands. Call the synchronous
  planning reconciliation methods directly in this sequence; never wrap or
  launch them as unawaited work. Extend the existing route switch and snapshot
  reader. Parse
  `MESH_V2_TEST_FAKE_PM_SCENARIO` only in explicit `NODE_ENV=test`, reject it in
  production or default configuration, reject unknown values, and pass it to
  `FakeHarnessAdapter`. Publish only events returned from committed operations.

- [ ] **Step 4: Make server composition tests green**

  Rerun both commands from Step 2, including the focused `config.spec.ts`
  command.

  Expected: PASS, including both ambiguous-start crash windows with no duplicate
  adapter start, fresh drain only without an operation, duplicate receipt, stale
  approval, awaited internal running-Abandon cleanup, and audit/persistence
  failure cases.

- [ ] **Step 5: Write red client, reducer, resync, app, and shell tests**

  Prove all four commands serialize through the existing generic
  `V2Api.command()` and `v2CommandEnvelopeSchema`; do not add planning-specific
  API methods. Snapshot and complete-cycle domain events update planning/ledger
  state; duplicates are
  ignored; gaps, project mismatch, incomplete projections, and invalid payloads
  request resync; refresh retains the human draft but replaces server truth;
  the shell renders T04 panes; tabs retain ArrowLeft/ArrowRight/Home/End; Board
  still says `Available in a later milestone`; disconnected/stale state disables
  commands. Apply append, proposal supersede, reject, and abandon events to an
  earlier snapshot and assert the final projection is byte-equivalent to a
  fresh final snapshot.
  Assert the shell visibly projects `launch_pending`, rejects a distinct second
  turn without optimistic transcript mutation, and keeps only Abandon enabled
  until binding or recovery changes server truth.

  In `ExecutionActivity.spec.tsx`, retain the existing foundation execution
  assertions and add a PM discovery execution. Prove
  `FoundationCheckAssignment` renders its existing `.title` in the heading and
  accessible child/runtime labels, while `PmDiscoveryAssignment` renders the
  exact deterministic label `Project manager discovery` without reading or
  requiring `.title`. Both kinds retain lifecycle, skills, diagnostics, and
  activity rendering.

  Update every `V2ProjectSnapshot` fixture in
  `use-project-connection.spec.tsx` and `socket.spec.ts` with schema-valid
  `planningCycles`, `planningHistoryTruncated`, and `intentLedger` fields. Use a
  populated planning/ledger snapshot in the connection test to prove initial
  hydration and resync replacement preserve server truth while retaining only
  the local human draft. In the socket/store test, prove a schema-valid snapshot
  with those fields survives runtime replay/live-event handling unchanged and
  still requests resync for invalid or incomplete planning events.

  ```ts
  const next = reduceProjectProjection(state, {
    type: 'domain.event',
    event: intentLedgerApprovedEvent,
  });
  expect(next.intentLedger?.ledger.revision).toBe(1);
  expect(next.domainCursor).toBe(intentLedgerApprovedEvent.sequence);
  expect(screen.getByRole('tabpanel', { name: 'Board' })).toHaveTextContent(
    'Available in a later milestone',
  );
  ```

- [ ] **Step 6: Run web composition tests and prove red**

  Run:

  ```powershell
  corepack pnpm exec vitest run apps/v2-web/src/api/client.spec.ts apps/v2-web/src/api/socket.spec.ts apps/v2-web/src/state/reducer.spec.ts apps/v2-web/src/state/resync.spec.ts apps/v2-web/src/app/App.spec.tsx apps/v2-web/src/app/use-project-connection.spec.tsx apps/v2-web/src/components/ExecutionActivity.spec.tsx apps/v2-web/src/components/FocusedProjectShell.spec.tsx --config apps/v2-web/vitest.config.ts
  ```

  Expected: FAIL because the existing projection and shell do not carry M2
  state or commands, and `ExecutionActivity` has not narrowed the new assignment
  union before reading the foundation-only `.title`; the connection/socket
  fixtures also lack the now-required snapshot planning fields.

- [ ] **Step 7: Integrate API, reducer/resync, app, and shell**

  Keep the existing generic `V2Api.command()` implementation and method set
  unchanged; T01's envelope union is sufficient for all four planning commands.
  Project the two new domain events in sequence; include planning/ledger in
  snapshot replacement; preserve existing cursor and resync behavior. Pass
  server truth and callbacks to T04 components. Import `intent-ledger.css` from
  the existing stylesheet or component entry without copying rules. In
  `ExecutionActivity`, narrow
  `execution.assignment.kind`: retain `assignment.title` only for
  `foundation-check`, and use exactly `Project manager discovery` for
  `pm_discovery` in the heading plus accessible child/runtime labels. Do not add
  `title` to the PM contract or weaken the assignment union. Keep Board markup
  unchanged.

- [ ] **Step 8: Make web composition tests green and run the W2 gate**

  Run:

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
  git diff --check
  ```

  Expected: all commands exit `0`; server and browser converge from snapshots,
  incremental events, replay, forced resync, and restart without a second
  transport or UI-owned lifecycle. `config.spec.ts` proves the fake PM option is
  test-only and rejected by production/default modes. The complete v2-web gate
  includes schema-valid connection/socket fixtures and the unchanged generic
  command API.

- [ ] **Step 9: Commit T05**

  ```powershell
  git add -- apps/v2-server/src/planning/planning-runtime.ts apps/v2-server/src/planning/planning-runtime.spec.ts apps/v2-server/src/config.ts apps/v2-server/src/config.spec.ts apps/v2-server/src/executions/execution-runtime.ts apps/v2-server/src/executions/execution-runtime.spec.ts apps/v2-server/src/executions/reconcile-executions.spec.ts apps/v2-server/src/http/routes.ts apps/v2-server/src/http/routes.spec.ts apps/v2-server/src/http/snapshots.ts apps/v2-server/src/main.ts apps/v2-server/src/main.spec.ts apps/v2-web/src/api/client.spec.ts apps/v2-web/src/api/socket.spec.ts apps/v2-web/src/state/reducer.ts apps/v2-web/src/state/reducer.spec.ts apps/v2-web/src/state/resync.ts apps/v2-web/src/state/resync.spec.ts apps/v2-web/src/state/store.ts apps/v2-web/src/app/App.tsx apps/v2-web/src/app/App.spec.tsx apps/v2-web/src/app/use-project-connection.spec.tsx apps/v2-web/src/components/ExecutionActivity.tsx apps/v2-web/src/components/ExecutionActivity.spec.tsx apps/v2-web/src/components/FocusedProjectShell.tsx apps/v2-web/src/components/FocusedProjectShell.spec.tsx apps/v2-web/src/styles.css
  git commit -m "feat(v2): compose intent ledger workflow"
  ```

**Acceptance:** One existing command route and realtime connection carry M2;
restart ordering is deterministic; UI state is a server projection; the Board
and M3 domain remain untouched. No bound terminal cycle can remain
`execution_active` across startup. Foundation and PM activity labels are
deterministic without pretending the PM assignment has a foundation title. The
T02→T05 launch boundary exports one implementation-local alias to the validated
M1 envelope and forwards it unchanged. Running Abandon awaits the internal
command-result-free runtime interruption bridge before its final transaction.

---

### Task T06: Fake-Only Todo Acceptance and Durable Documentation

**Outcome:** The built V2 product proves the complete Milestone 2 stop
condition with deterministic fake PM behavior, and current contributor docs
describe the implemented boundary without claiming M3.

**Files:**

- Modify: `e2e-v2/src/v2-foundation.spec.ts`
- Modify: `e2e-v2/src/fixtures/v2-process.ts`
- Modify: `e2e-v2/project.json` only if the existing target cannot pass the
  test-only fake PM setting through unchanged
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/v2-foundation.md`
- Prohibited: all contracts, database, planning, execution, HTTP, web source,
  V1 paths, design/plan documents, and every operator-owned runtime path

**Interfaces:**

- Consumes: the built W2 server/web, existing `v2-e2e` Playwright harness,
  temporary Todo repository/database setup, and T05's test-only fake PM config.
- Produces: `V2ProcessFixture.createTodo({ fakePmScenario: 'todo' })`, preserving
  that explicit test-only selection for every owned server spawn and restart;
  `forceProjectResync(page)` using the existing subscription/gap protocol; and
  updated current architecture/operation docs.

- [ ] **Step 1: Write the red built-process Todo scenario**

  Modify only `e2e-v2/src/v2-foundation.spec.ts`. Write the complete journey
  with the fixture's existing compiling `V2ProcessFixture.createTodo()` API
  before changing `v2-process.ts`, project configuration, or docs.
  Register/select the temporary Todo repository, approve the fake PM profile,
  send the initial description, assert structured questions, restart the built
  server, and assert the question/transcript survives. Answer after restart and
  assert the complete Todo proposal. Assert no item checkboxes, approve it, open
  Requirements, and assert all five record types, requirement kind/status,
  `depends_on`, `constrains`, and provenance to both turns.

  ```ts
  await page.getByLabel('Message to project manager').fill(
    'Build a Todo app that adds, completes, and persists items.',
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByRole('heading', { name: 'Clarifying questions' }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve proposal' }).click();
  await page.getByRole('tab', { name: 'Requirements' }).click();
  await expect(page.getByText('depends on')).toBeVisible();
  await expect(page.getByText('constrains')).toBeVisible();
  ```

  After approval, restart once more against the same temporary database,
  reload/reconnect, and assert intent revision 1, ledger revision 1, transcript,
  provenance, and relationships remain identical. The forced-resync assertion
  is added only in Step 3 after this core journey has produced genuine red
  evidence. Before the red run, `git diff --name-only` must list only the journey
  spec and TypeScript compilation must succeed.

- [ ] **Step 2: Run the Todo E2E and prove red**

  Run:

  ```powershell
  $env:NX_DAEMON='false'
  $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  git diff --name-only
  corepack pnpm nx typecheck v2-e2e
  corepack pnpm nx e2e v2-e2e -- --grep "conversation becomes an approved intent ledger"
  ```

  Expected: `typecheck v2-e2e` exits `0`, then the new test runs and FAILS at the
  first structured PM question assertion because the fixture's absent fake-PM
  option deterministically takes T03's completion-without-receipt attention
  path rather than the Todo scenario. Record both exit codes, that assertion,
  exact HEAD, and clean process evidence; a compiler/import/type failure, thrown
  fake configuration, build contamination, infrastructure failure, or unrelated
  test failure is not the required red evidence.

- [ ] **Step 3: Implement only the owned fixture support and make the journey green**

  Now modify `e2e-v2/src/fixtures/v2-process.ts`. Extend the existing fixture
  rather than creating another server harness: `createTodo` accepts and retains
  `fakePmScenario?: 'todo'`; `spawnServer` emits
  `MESH_V2_TEST_FAKE_PM_SCENARIO` only from that retained option; and
  `restartWithFreshFake` reuses it automatically. No global process environment
  mutation is allowed. Add `forceProjectResync(page)`: subscribe with a
  deliberately non-contiguous cursor beyond current high-water, assert existing
  `v2.resync_required`, reload through the ordinary app snapshot path, and
  return the converged snapshot. Modify `e2e-v2/project.json` only if the
  existing target cannot preserve the explicit option. Update the journey to
  create the fixture with `{ fakePmScenario: 'todo' }` and add the forced-resync
  assertion. Do not edit production source to make the journey pass. Rerun the
  exact Step 2 typecheck-then-E2E sequence with the same daemon/cache environment
  and exact-head evidence. Green requires both commands to exit `0` in that
  order; an E2E-only rerun is insufficient.

  Expected: PASS using built server/web output, a temporary database/repository,
  port `0`, a fixture-owned fake PM option on both child processes, and no
  external agent process.

- [ ] **Step 4: Update current architecture and operating guidance**

  In `architecture.md`, extend the parallel V2 flow with planning-cycle
  ownership, finite PM executions, atomic human approval, canonical immutable
  intent/ledger revisions, and Requirements projection; state explicitly that
  Board/planning tasks remain M3. In `v2-foundation.md`, document the fake-only
  M2 verification command and the test-only scenario setting, and retain the
  warning that real agent smoke tests are opt-in.

- [ ] **Step 5: Run the final stop-condition gate**

  Run:

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
  corepack pnpm nx e2e v2-e2e -- --grep "conversation becomes an approved intent ledger"
  corepack pnpm verify
  git diff --check
  ```

  Expected: every command exits `0`. Review the process environment and test
  output to confirm no real harness, credential, operator database, operator
  repository, V1 port, or non-owned process was used.

- [ ] **Step 6: Audit the complete milestone stop condition**

  Inspect repository evidence, not handoffs, and record all as satisfied:

  - two human turns each own one distinct finite PM execution;
  - each execution was durably bound before adapter activation and startup
    reconciliation leaves no bound terminal/attention cycle `execution_active`;
  - both starting/pending/no-handle crash windows finish the operation unknown
    and project execution/cycle attention without a restarted adapter call;
  - terminal reservation replay follows its unique start-operation link, and a
    concurrent distinct turn cannot bypass non-accepting `launch_pending`;
  - questions and complete proposal history survive restart;
  - one human approval creates exactly intent revision 1 and ledger revision 1;
  - five record types, exact requirement vocabulary, provenance,
    `depends_on`, and `constrains` survive replay/resync/restart;
  - stale base, partial approval, agent self-approval, malformed/duplicate
    output, and injected persistence failure create no partial canonical state;
  - one-active-cycle/history limits, lifecycle-only retirement, symmetric edge
    normalization, and incremental/final snapshot equivalence are proven by the
    accepted focused gates;
  - Requirements renders server truth and Board remains a placeholder;
  - the combined diff defines no M3 object or behavior;
  - all Nx/verify evidence records the same audited HEAD with daemon and cache
    disabled.

- [ ] **Step 7: Commit T06**

  ```powershell
  git add -- e2e-v2/src/v2-foundation.spec.ts e2e-v2/src/fixtures/v2-process.ts docs/development/architecture.md docs/development/v2-foundation.md
  git add -- e2e-v2/project.json # No-op unless the conditional owned edit was necessary.
  git commit -m "test(v2): prove intent ledger milestone"
  ```

**Acceptance:** The built fake-only Todo journey satisfies every design stop
condition across restart/replay/resync, the full local gate passes, and durable
docs describe M2 without importing M3.

## Deterministic Integration and Review Gates

The integrator starts each wave from its frozen base and applies only accepted
commits in this order:

1. W0: T01.
2. W1: T02, then T03, then T04. This order is deterministic only; the tasks are
   independent and start from the same W0 base.
3. W2: T05.
4. W3: T06.

Before each integration, compare `git diff --name-only <base>..<commit>` with
the task's owned files and stop on any unexpected path. A conflict in W1 means
the ownership audit was violated; do not resolve it mechanically. A changed T01
interface pauses all dependent tasks and returns to planning.

After W0, run the T01 green gate and record the bounded downstream server/web
compatibility deferments; do not mislabel unrun downstream typechecks as W0
passes. After accepted T02 and T03 are both on the W1 integration head (and T04
is applied in its declared order), run:

```powershell
$env:NX_DAEMON='false'
$env:NX_SKIP_NX_CACHE='true'
git rev-parse HEAD
corepack pnpm nx test v2-contracts
corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.spec.ts apps/v2-server/src/planning/planning-service.spec.ts apps/v2-server/src/planning/pm-report-consumer.spec.ts apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts --config apps/v2-server/vitest.config.ts
corepack pnpm exec vitest run apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/RequirementsPane.spec.tsx --config apps/v2-web/vitest.config.ts
corepack pnpm nx typecheck v2-server
git diff --check
```

The W1 server typecheck discharges T02's deferred gate and must pass before W2
starts. The focused leaf web test is evidence only for T04; full `v2-web`
test/typecheck/build remain explicitly deferred because T05 owns the existing
union, snapshot, reducer, socket, connection, activity, and shell consumers.
After W2, run the T05 W2 gate, including full `v2-web` test, typecheck, and
build; those commands discharge the T04/W1 web deferment and must pass before
W3 starts. After W3, run the T06 final gate and stop-condition audit. A green
worker test without accepted review and clean integration evidence is
insufficient.

After every W0-W3 integration gate, and before starting the next wave or final
milestone review, dispatch a fresh independent read-only integration reviewer.
The reviewer may not be a worker whose commit is in that wave, that wave's
integrator, or the reviewer of the latest rework included in the integration
head. It independently verifies the exact wave base/head, ordered commit set,
base-to-head diff and changed paths, ownership/prohibited surfaces, interface
compatibility, gate commands/results, mandatory Nx environment evidence, and
wave stop condition, then returns exactly:

```text
INTEGRATION REVIEW HANDOFF
Wave: <W0 | W1 | W2 | W3>
Reviewer: <fresh independent reviewer ID>
Wave base: <full SHA>
Integration head: <full reviewed SHA>
Integrated commits: <ordered full SHAs>
Diff and paths: <exact base..head command, result, and changed paths>
Verdict: accept | rework | blocked
Findings: <severity, owner, path:line, impact, required correction; or none>
Ownership and exclusions: <satisfied, unsatisfied, or unverified with evidence>
Interfaces and stop condition: <satisfied, unsatisfied, or unverified with evidence>
Verification: <exact commands, exit codes, NX_DAEMON/NX_SKIP_NX_CACHE, tested HEAD>
Deferred gates: <originating task, exact command, reason, owner/wave, and discharged evidence; or none>
Residual risks: <items or none>
```

`accept` applies only to that exact integration head. On `rework`, route each
task-owned finding to its original worker; route only an authorized
integration-only finding to the integrator. Each correction receives its normal
fresh task review, is reintegrated in deterministic task order, and the full
wave gate reruns daemon-disabled and uncached on the new exact head. A different
fresh integration reviewer then reviews that new head; prior evidence does not
transfer. On `blocked`, record the exact owner/condition and do not start the
next wave. The coordinator records every integration handoff, reviewer,
finding, rework/reintegration commit, re-gate, and re-review verdict in the
campaign ledger before advancing.

### Final Independent Milestone Review

After W3 is integrated, the coordinator records the exact final integration
head and reruns the complete T06 Step 5 gate on that head. Only after that gate
passes, dispatch a fresh read-only milestone reviewer who was neither a task
reviewer for the latest rework nor the final integrator. The reviewer receives
the campaign base, exact final head, design, this plan, campaign ledger, all task
and wave handoffs, and full-gate evidence. It independently inspects
`<campaign-base>..<final-head>`, verifies every owned/prohibited surface and the
Final Stop-Condition Proof against repository evidence, and returns:

The reviewer rejects any Nx/verify evidence that does not record the reviewed
HEAD with `NX_DAEMON=false` and `NX_SKIP_NX_CACHE=true`. Any reviewer-run Nx or
verify command must set the same values and record its own exact HEAD.

```text
MILESTONE REVIEW HANDOFF
Reviewer: <fresh reviewer ID>
Base: <full campaign-base SHA>
Integration head: <full reviewed SHA>
Verdict: accept | rework | blocked
Findings: <severity, path:line, impact, required correction; or none>
Ownership and exclusions: <exact changed paths and M3/real-traffic audit>
Stop-condition proof: <each criterion satisfied, unsatisfied, or unverified>
Verification: <exact commands/evidence and the head to which each applies>
Residual risks: <items or none>
```

`accept` is valid only for that exact head after the full gate. On `rework`, the
coordinator sends each bounded finding to its owning task, records the new
worker commit and a fresh task review, integrates accepted corrections in task
order, reruns the complete full gate on the new head, and dispatches a different
fresh milestone reviewer. The prior reviewer does not approve its own rework,
and stale review evidence never transfers to a new head. On `blocked`, record
the exact missing authority or external condition in the campaign ledger and
MORNING HANDOFF. No hands-on-test handoff is ready before an `accept` verdict.

## Final Stop-Condition Proof

Milestone 2 is complete only when one exact integrated commit proves all of the
following:

- conversation -> structured questions -> answer -> complete proposed
  `ProjectIntent`/ledger diff -> human atomic approval;
- immutable approved intent, stable record identities, immutable record and
  ledger revisions, complete membership/edge snapshots, proposal-reserved IDs
  becoming canonical only on exact approval, and conversation-turn provenance;
- exact requirement kinds/statuses/relationships and decision `constrains`
  traceability, lifecycle-only removal for all five record types, and normalized
  symmetric conflict/duplicate edges;
- one finite fake PM execution per human turn and one strict, idempotent,
  binding-validated report receipt per accepted output;
- migration 2 transactionally accepts all four planning command results while
  preserving every nonempty M1 command row, result, index, and replay path on
  upgrade and rollback;
- exact execution reservation and durable binding before activation, including
  a unique start-operation link for terminal capability/skill replay and
  adapter-start failures, plus cleanup-first/commit-last Abandon arbitration
  whose running path awaits one internal command-result-free interrupt operation
  that fences/closes the exact active session and joins its consume task before
  the final Abandon transaction, stores no success on cleanup or quiescence
  failure, and leaves no late adapter start, consumer write, orphan starting
  execution, or pending start operation, with no pre-binding event consumption
  or duplicate execution/session;
- fail-closed restart handling for both ambiguous adapter-start windows: M1
  operation `unknown`, execution/cycle attention, exact audit link preserved,
  and no automatic activation; only never-reserved turns launch freshly;
- one active nonterminal cycle per project, bounded assignment/snapshot history,
  non-accepting single-flight `launch_pending`, replay-complete proposal
  supersede/reject/abandon events, and incremental projection equivalent to a
  fresh snapshot;
- audit-before-publish, immediate atomic approval, stale/invalid/failure
  rollback, transactional rejected receipts plus complete-cycle attention for
  malformed/wrongly-bound output, snapshot/replay/resync, and restart recovery
  that reconciles durable output and terminal/attention executions before
  session attachment, fresh pending launch, or command acceptance;
- accessible PM and Requirements UI with human-only all-or-nothing approval;
- deterministic built-process Todo acceptance with no paid traffic,
  credentials, real repository, or operator state;
- every Nx/verify acceptance result is uncached, daemon-disabled, and bound to
  its recorded exact HEAD; every bounded transitional deferment is recorded and
  discharged at its mandatory integrated server or web gate before the next
  dependent wave;
- no milestone, task, dependency, readiness, coverage, scheduling, Board, real
  adapter, persistent provider session, or generic consumer implementation.

If any item is unproved, return a bounded rework packet to its owning task. Do
not widen M2 to make the test pass.
