# Mesh V2 Milestone 4: Single-Task Execution Design

**Status:** Approved

**Date:** 2026-09-01

**Base:** `ff8d6312355fba4fe9166e9a2584d71a3ddbd2a5`

**Parent architecture:**
[Mesh V2 Architecture](2026-08-27-mesh-v2-architecture-design.md)

**Predecessor:**
[Milestone 3 Planning and Board](2026-08-30-mesh-v2-milestone-3-planning-board-design.md)

## Outcome and Stop Condition

Milestone 4 lets an operator start one actionable task from the V2 Board. Mesh
allocates a safe managed Git worktree, freezes the exact authorized task and
profile, runs one Developer through the existing harness-neutral execution
substrate, records structured evidence, and completes or blocks the task only
through the Developer domain boundary.

The milestone stops when the deterministic Todo scenario proves that one task
can be completed through the fake harness with its workspace, execution
activity, report, task lifecycle change, Board consequences, and recovery
evidence preserved across a server restart.

Process exit is never task completion. A syntactically and semantically valid
Developer completion report is the only M4 path from a pending task to a
completed operational lifecycle revision.

## Scope Boundary

### In scope

- one explicit human launch for one currently actionable task;
- exact profile selection and frozen Developer assignment;
- one durable `DeveloperAttempt` controlling one task at a time;
- deterministic managed branch and worktree reservation;
- persist-intent-before-effect workspace creation and verification;
- a `developer_task` assignment on the existing `WorkerExecution` substrate;
- normalized runtime activity, interruption, and fake-harness output;
- immutable completion and blocker reports;
- task completion from validated Developer evidence;
- explicit replacement of an interrupted or failed execution within the same
  attempt and workspace;
- restart reconciliation of attempt, execution, and workspace reality;
- complete snapshot, event replay, retained-gap resync, and Board projection;
- a focused Developer panel in the selected Board task detail;
- fake-only temporary-repository acceptance on Windows and other supported
  development platforms.

### Explicit exclusions

- `ExecutionRun`, task claims, queues, waves, concurrency, automatic task
  selection, or continuous scheduling; Milestone 5 owns them;
- QA attempts, QA verdicts, structured rework feedback, integration authority,
  milestone completion, or release gates; Milestone 6 owns them;
- automatic merge, rebase, cherry-pick, push, branch deletion, worktree
  deletion, archival, or cleanup;
- real Codex, Claude Code, or other subscription-backed adapters as an
  acceptance requirement;
- resume semantics that a harness cannot prove exact;
- manual branch names, worktree paths, base commits, or arbitrary workspace
  selection in the product UI;
- V1 imports, tables, commands, events, components, runtime state, or migration;
- a generic role, workflow, report, workspace-provider, or scheduler framework.

M4 may reproduce a small proven V1 mechanism behind V2 contracts, but it may
not share V1 domain types or mutable state.

## Authority and Existing Boundaries

M3 remains authoritative for the current approved delivery plan, immutable task
contracts and operational revisions, requirement traceability, deterministic
readiness, and Board projection. M4 asks that existing read model whether a task
is actionable; it does not reimplement readiness.

The existing `ExecutionRuntime` remains harness-neutral. It owns durable worker
lifecycle, adapter operations, normalized runtime events, interruption, exact
resume when supported, replacement links, audit barriers, and runtime
publication. It does not decide whether a task is actionable, blocked, or
complete.

A concrete `DeveloperAttemptService` owns M4 authority. It coordinates M3 task
truth, managed workspace effects, compatible Developer profiles, the existing
execution runtime, structured Developer reports, and atomic task outcomes. A
small `DeveloperReportConsumer` receives structured output only after the
runtime event has been durably persisted.

The browser is a projection and command surface. It cannot allocate paths,
infer readiness, accept reports, or complete tasks.

## Durable Model

### Developer profile and assignment

M4 adds exactly one profile assignment kind and report schema:

```ts
type DeveloperTaskAssignment = {
  kind: 'developer_task';
  projectId: ProjectId;
  attemptId: DeveloperAttemptId;
  taskId: TaskId;
  taskContractRevision: number;
  taskCurrentRevision: number;
  deliveryPlanId: DeliveryPlanId;
  deliveryPlanRevision: number;
  requirementRevisions: readonly RequirementRevisionRef[];
  baseCommit: GitObjectId;
  workspacePath: AbsolutePath;
  title: PlanText;
  outcome: PlanText;
  acceptanceCriteria: readonly PlanText[];
  verification: readonly PlanText[];
  expectedArtifacts: readonly PlanText[];
  outputSchema: 'mesh.dev/developer-report/v1';
};
```

A selectable Developer profile is an exact approved global or project profile
revision whose sole assignment kind is `developer_task` and whose output schema
is `mesh.dev/developer-report/v1`. The start command names that exact revision.
There is no implicit default or fallback profile. The assignment freezes the
resolved profile and skill snapshot through the existing execution contracts.

The fake adapter implements `developer_task`. Real adapter work remains opt-in
and outside the stop condition.

### Developer attempt

```ts
type DeveloperAttemptLifecycle =
  | 'reserved'
  | 'provisioning'
  | 'active'
  | 'completed'
  | 'blocked'
  | 'interrupted'
  | 'attention_required';

type DeveloperAttempt = {
  id: DeveloperAttemptId;
  projectId: ProjectId;
  taskId: TaskId;
  ordinal: number;
  lifecycle: DeveloperAttemptLifecycle;
  revision: number;
  deliveryPlanId: DeliveryPlanId;
  deliveryPlanRevision: number;
  intentRevision: number;
  ledgerRevision: number;
  taskContractRevision: number;
  taskCurrentRevision: number;
  requirementRevisions: readonly RequirementRevisionRef[];
  baseCommit: GitObjectId;
  profileId: WorkerProfileId;
  profileRevision: number;
  assignment: DeveloperTaskAssignment;
  workspace: ManagedWorkspace;
  controllingExecutionId: WorkerExecutionId | null;
  executionIds: readonly WorkerExecutionId[];
  reportIds: readonly DeveloperReportId[];
  attention: DeveloperAttention | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;
};
```

The attempt is the durable domain owner. A worker execution is one runtime
activity within it. A partial unique database constraint permits at most one
attempt in `reserved`, `provisioning`, `active`, or `interrupted` for a task.
Terminal `blocked`, `completed`, and `attention_required` history remains
immutable and visible. An operator may start a fresh attempt after `blocked` or
`attention_required` only after current launch guards pass again.

`interrupted` is recoverable, not erased. Explicit replacement returns the same
attempt to `active` with a new controlling execution linked through the
existing `replacementForExecutionId` field. The prior execution and events
remain unchanged.

### Managed workspace

M4 needs no general workspace-provider abstraction. One Git implementation is
owned by the Developer domain and uses the already approved V2 Git executable
and process runner.

```ts
type ManagedWorkspaceLifecycle =
  | 'reserved'
  | 'creating'
  | 'ready'
  | 'attention_required';

type ManagedWorkspace = {
  attemptId: DeveloperAttemptId;
  repositoryPath: AbsolutePath;
  repositoryIdentity: RepositoryIdentity;
  branch: string;
  path: AbsolutePath;
  baseCommit: GitObjectId;
  lifecycle: ManagedWorkspaceLifecycle;
  ownershipToken: string;
  observedHead: GitObjectId | null;
  observedDirty: boolean | null;
  failure: DeveloperAttention | null;
  revision: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};
```

The row is keyed by `attemptId`; a separate workspace ID would add no boundary.
Mesh derives branch and path from full durable project, task, and attempt
identity beneath a managed root next to the V2 database. Names are deterministic
and do not include user-authored task text. The full values remain diagnostic
unless intervention is required.

The external operation sequence is fixed:

1. Resolve the registered project and current Git identity.
2. Resolve the exact current integration commit.
3. In one transaction, validate launch guards, reserve the attempt and managed
   branch/path, record the intended `git worktree add`, and store the command's
   in-progress reservation.
4. Run the exact approved Git executable without a shell.
5. Verify repository identity, worktree registration, branch, HEAD, clean state,
   and ownership token.
6. In one transaction, store the observation, mark the workspace ready, reserve
   the execution, and advance the attempt to active.
7. Activate the existing execution reservation only after the transaction
   commits.

A conflict, partial creation, identity mismatch, unexpected branch/HEAD, dirty
state, missing metadata, or audit failure records the observed facts and moves
the attempt/workspace to `attention_required`. Mesh does not delete, reset,
move, repurpose, or retry ambiguous work.

### Developer reports

`mesh.dev/developer-report/v1` is a strict discriminated union bound to the
current attempt and controlling execution.

```ts
type DeveloperCompletionReport = {
  schema: 'mesh.dev/developer-report/v1';
  disposition: 'completed';
  attemptId: DeveloperAttemptId;
  executionId: WorkerExecutionId;
  taskId: TaskId;
  taskContractRevision: number;
  requirementCoverage: readonly RequirementEvidence[];
  criterionCoverage: readonly CriterionEvidence[];
  changedArtifacts: readonly ChangedArtifact[];
  verification: readonly VerificationEvidence[];
  unresolvedConcerns: readonly string[];
  workspace: DeveloperWorkspaceObservation;
};

type DeveloperBlockerReport = {
  schema: 'mesh.dev/developer-report/v1';
  disposition: 'blocked';
  attemptId: DeveloperAttemptId;
  executionId: WorkerExecutionId;
  taskId: TaskId;
  taskContractRevision: number;
  blocker: string;
  evidence: readonly EvidenceItem[];
  suggestedNextAction: string;
  preserveWorkspace: true;
  workspace: DeveloperWorkspaceObservation;
};
```

Criterion evidence uses the frozen zero-based criterion index plus exact text,
because M3 criteria are ordered task-contract text rather than independent
entities. Requirement evidence uses exact stable ID and revision. Completion
requires exactly one passed entry for every frozen criterion and requirement,
at least one successful verification observation, exact report binding, and a
workspace observation consistent with the managed worktree. Duplicate,
missing, unexpected, failed, or malformed coverage cannot complete a task.

The report records claims and observations; it does not grant arbitrary domain
authority. Mesh validates binding, completeness, and consistency. M6 later adds
independent QA against the exact output.

Reports are immutable. A second report from the same execution is rejected and
recorded as attention-worthy runtime output; it never overwrites the first.

## Commands and State Transitions

M4 extends the existing `/api/v2/commands` boundary with three commands:

```ts
type StartDeveloperAttemptCommand = {
  type: 'developer_attempt.start';
  projectId: ProjectId;
  taskId: TaskId;
  expectedTaskRevision: number;
  expectedDeliveryPlan: { id: DeliveryPlanId; revision: number };
  profileId: WorkerProfileId;
  profileRevision: number;
};

type InterruptDeveloperAttemptCommand = {
  type: 'developer_attempt.interrupt';
  projectId: ProjectId;
  attemptId: DeveloperAttemptId;
  expectedAttemptRevision: number;
  expectedExecutionRevision: number;
};

type ReplaceDeveloperExecutionCommand = {
  type: 'developer_attempt.replace_execution';
  projectId: ProjectId;
  attemptId: DeveloperAttemptId;
  expectedAttemptRevision: number;
};
```

The existing envelope supplies command ID and operator identity. Duplicate
command IDs replay the original terminal or in-progress result. The command
route only validates and dispatches; the Developer service owns all lifecycle,
workspace, and report rules.

Start requires all of the following in one consistent database read:

- the project is current and active;
- the named approved plan revision is current and not stale against intent;
- the named task/current revision belongs to that plan;
- existing M3 readiness is exactly `actionable`;
- no controlling attempt exists;
- the selected profile revision is approved and exactly compatible;
- the repository identity and current integration commit are available;
- no billing override or audit barrier makes launch unsafe.

Validation failure creates no attempt, workspace effect, execution, or domain
event. A failure after reservation preserves the reservation and observations.

Interrupt first persists operation intent and the attempt transition, then asks
the execution runtime to interrupt. The final observed adapter result is
persisted before publication. A report durably ordered before the interrupt
outcome may still settle the attempt if every binding remains current; later
output cannot.

Replacement is human-only and valid only for an interrupted attempt whose
workspace still proves exact identity, branch, HEAD continuity, and ownership.
It freezes no new task or profile revision. If the adapter cannot prove exact
resume, replacement creates a new `WorkerExecution` with the same frozen
assignment and workspace and links it to the prior controlling execution.

## Completion and Atomicity

The runtime persists and normalizes structured output before calling the
Developer report consumer. The consumer ignores assignments it does not own and
fails closed for a Developer assignment it cannot bind.

For a valid completion report, one database transaction:

1. re-reads the attempt, current controlling execution, frozen task contract,
   and report uniqueness;
2. validates exact criterion and requirement coverage;
3. inserts the immutable report;
4. appends the next immutable task revision with
   `revisionKind: 'operational_lifecycle'`, `lifecycle: 'completed'`, unchanged
   `contractRevision`, and the existing sequential lifecycle source;
5. marks the attempt completed;
6. recalculates the complete server-owned Board projection, including reverse
   dependency readiness effects;
7. appends versioned Developer-attempt/report and task-lifecycle domain events;
8. completes the originating domain observation receipt.

No task/report/attempt/event subset may commit. Publication happens only after
commit. Audit persistence failure trips the existing barrier and prevents the
runtime from continuing unsafely.

A valid blocker report atomically stores the report and marks the attempt
blocked. The task stays pending; readiness remains an M3 calculation. The
workspace is explicitly preserved.

## Recovery and Reverse States

Startup continues to reject commands until recovery finishes. The ordered V2
startup sequence becomes:

1. reopen and validate the V2 database;
2. reconcile generic worker executions and collect exact resumed sessions;
3. reconcile Developer workspace operations and nonterminal attempts;
4. reconcile planning cycles and pending planning reservations;
5. publish all committed recovery-domain events;
6. attach recovered sessions to the execution runtime;
7. drain pending planning and Developer activations;
8. accept commands.

Developer reconciliation verifies each nonterminal attempt against current disk
and Git reality without changing user work:

- repository identity and registered project path;
- durable worktree registration;
- exact managed path and branch;
- base and observed HEAD continuity;
- dirty state without assuming dirty means unsafe—the attempt expects Developer
  changes once active;
- ownership metadata and controlling execution;
- adapter probe/resume result and audit cursors.

An active attempt may legitimately be dirty. Recovery therefore compares the
worktree to its frozen base and durable observations; it does not require a
clean active workspace. A reserved or provisioning workspace must be clean
before first activation.

Exact adapter resumption reattaches the existing execution. A terminal or lost
execution without a valid report changes the attempt to interrupted. Missing or
contradictory workspace facts change it to attention required. Neither state
deletes work. Explicit replacement is available only after successful
workspace verification.

Reverse behavior is explicit:

- task completion can make dependents actionable through existing M3 logic;
- a later M6 reopen appends a pending operational lifecycle revision and makes
  dependents blocked again through the same M3 logic;
- interruption may be replaced within the same attempt;
- blocker/attention history remains after a fresh attempt;
- retired or replanned task contracts cannot inherit an earlier attempt's
  completion.

## Events, Snapshots, and Errors

M4 adds versioned domain payloads for:

- `developer_attempt.changed` with the complete attempt and current Board;
- `developer_report.recorded` with the immutable report, attempt, completed task
  revision when present, and current Board;
- `developer_workspace.changed` with the complete managed workspace and attempt.

Existing worker runtime events remain unchanged. The project snapshot adds
complete Developer attempts and reports. Attempt rows embed their workspace, so
there is no second top-level workspace collection for the client to join.

Ordered domain events replace complete attempt/report/Board projections. Replay
and retained-gap resync use the existing project cursors and socket. No new
stream or protocol version is needed. Previously persisted event payload bytes
remain immutable; new writes use explicit M4 schema versions and strict legacy
normalization.

Typed failures distinguish at least stale task/plan/profile, task not
actionable, attempt conflict, attempt transition conflict, workspace conflict,
workspace identity mismatch, workspace operation failure, report binding or
coverage failure, replacement unavailable, adapter failure, and audit barrier.
HTTP status mapping follows existing V2 conflict, validation, unavailable, and
internal-failure conventions.

## User Experience

The Board remains one pane. Selecting a task exposes a Developer section in the
existing task detail rather than adding a permanent pane.

For an actionable pending task with no controlling attempt, the section shows
only exact compatible Developer profile revisions and one `Start development`
button. Branch, path, base commit, and workspace mode are not editable.

The projected attempt chronology shows:

- reservation and provisioning progress;
- active execution and normalized runtime activity;
- interrupt action while permitted;
- completion or blocker report evidence;
- prior and controlling replacement executions;
- workspace preservation state;
- explicit attention reason and safe next action.

Status never relies on color. The controls have accessible names and visible
busy/disabled reasons. They are disabled while disconnected, stale, submitting,
or resyncing. Typed stale/conflict failures keep task detail open, announce the
failure, focus the error region, and load current server truth. The UI never
optimistically completes a task or fabricates workspace state.

## Fake-Only Todo Acceptance Scenario

The existing M3 Todo journey is extended, not replaced:

1. Create a temporary Todo repository and V2 database, complete intent
   discovery, approve requirements, approve a two-milestone delivery plan, and
   assert one task is actionable.
2. Approve one project-scoped Developer profile whose sole assignment kind is
   `developer_task` and output schema is
   `mesh.dev/developer-report/v1`; incompatible profiles are absent.
3. Start that actionable task with exact task, plan, and profile guards.
4. Assert the durable attempt/workspace reservation exists before Git worktree
   creation and no execution is active yet.
5. Assert Mesh creates and verifies the deterministic branch/worktree inside
   the temporary test root, then activates one bound fake execution.
6. The fake emits normalized activity and changes a real Todo artifact in that
   worktree. Assert no operator repository or V1 state is touched.
7. Restart while the fake execution is held. Assert snapshots and replay retain
   the attempt/workspace/activity; recovery either exactly resumes the held fake
   session or records interruption and accepts explicit replacement.
8. Exercise interruption and explicit replacement, preserving the first
   execution history and all worktree changes.
9. Exercise a blocker report and a malformed/duplicate completion report in
   isolated attempts. Assert the task does not complete and evidence/workspaces
   remain visible.
10. Emit one valid bound completion report with exact requirement and criterion
    coverage and successful verification evidence.
11. Assert the report, attempt completion, task operational lifecycle revision,
    dependent readiness, Board, command result, and ordered events commit
    together and survive another restart.
12. Force retained-gap resync and assert the complete snapshot matches durable
    truth. Assert Windows-normalized paths and ownership checks remain exact.

The scenario uses only the fake harness, temporary repositories, temporary
databases, and test-owned managed worktrees. It consumes no subscription quota
and never reads operator credentials.

## Verification Strategy

- Contract tests cover strict assignment, attempt, workspace, report, command,
  result, event, snapshot, and legacy decoding rules.
- Migration/repository tests cover forward migration 4, immutable earlier
  migrations, constraints, ordering, idempotency, report immutability, active
  attempt uniqueness, task lifecycle append, and rollback on every injected
  persistence failure.
- Workspace tests use temporary Git repositories for deterministic naming,
  reservation-before-effect, collisions, partial creation, dirty/clean states,
  identity mismatch, base drift, missing metadata, Windows paths, and no
  deletion.
- Domain tests cover all start guards, profile compatibility, report binding
  and completeness, blocker behavior, completion atomicity, interruption,
  replacement, and reverse readiness.
- Runtime tests cover Developer dispatch through the existing adapter,
  persisted-before-consumed structured output, duplicate/late output, audit
  barriers, and unchanged planning behavior.
- Recovery tests cover every nonterminal attempt/workspace/execution
  combination, exact resume, replacement, attention, recovery publication, and
  restart ordering.
- Web tests cover profile selection, launch, progress, activity, interruption,
  reports, replacement chronology, preserved-work guidance, stale/disconnected
  controls, accessibility, and snapshot replacement.
- Playwright covers the integrated fake Todo journey, real temporary Git
  worktree effects, restart, replay/resync, completion, and dependent readiness.
- The complete local gate remains `corepack pnpm verify`. Real-harness smoke
  tests remain opt-in and outside CI.

## Affected Surface Decisions

- **Contracts: yes.** Add Developer IDs/model, assignment/report schemas, three
  commands/results, error codes, events, and snapshot fields. Keep the protocol
  version and legacy payloads unchanged.
- **Commands: yes.** Extend the single V2 command route; keep authority in the
  Developer service.
- **Runtime: narrowly yes.** Add `developer_task`, dispatch structured output to
  a composed observer, reuse reservations/interruption/replacement, and extend
  the fake adapter. Do not add Developer policy to `ExecutionRuntime`.
- **Persistence: yes.** Add forward migration 4 and repositories for attempts,
  workspaces, reports, and workspace-operation observations. Earlier migrations
  remain byte-immutable.
- **Realtime: yes.** Carry complete Developer projections over existing ordered
  domain events, cursor replay, and resync. Add no stream.
- **Web: yes.** Add the Developer section to selected Board task detail and
  project server truth only.
- **Workspace safety: central.** Persist intent before Git effects, use the
  approved executable without a shell, verify ownership after every effect,
  and never clean up ambiguous work.
- **Operating modes: yes.** Development and production build; acceptance is
  fake-only; tests are temporary and Windows-safe.
- **Reverse states: yes.** Interrupt/replace, block/fresh attempt,
  complete/later reopen, dependency readiness reversal, and failure/recovery
  are explicit.
- **Documentation: yes after implementation.** Update current architecture and
  V2 operating guidance with the implemented command, workspace, recovery, and
  verification flow.

Expected implementation stays inside `packages/v2-contracts`,
`apps/v2-server`, `apps/v2-web`, `e2e-v2`, and current V2 development docs. No
V1 source is modified or imported.

## Settled Decisions and Stop Proof

- M4 is single-task manual execution. M5 remains the first scheduler.
- M3 readiness is reused as the sole actionable calculation.
- `DeveloperAttemptService`, not the harness runtime or browser, owns task
  completion authority.
- One concrete Git workspace implementation is sufficient; no provider
  abstraction or user-selected path is added.
- Workspace intent is durable before effects, every effect is observed, and
  ambiguous work is preserved.
- One attempt may contain replacement executions, but only one controls it.
- Structured, exact, complete Developer evidence—not process exit—completes a
  task.
- The completion transaction includes the report, task revision, attempt,
  Board, events, and receipt.
- Restart proves execution and workspace reality before accepting new work.
- Snapshot/replay/resync project complete server truth; the browser owns no
  lifecycle rule.
- Default verification uses only fake adapters and temporary state.
- No QA, integration, run, concurrency, cleanup, real-adapter, V1, or generic
  workflow machinery exists in M4.

The milestone is complete only when every clause above is supported by current
repository evidence and the fake Todo stop condition passes across restart.
