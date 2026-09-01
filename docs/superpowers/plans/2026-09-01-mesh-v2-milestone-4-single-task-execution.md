# Mesh V2 Milestone 4 Single-Task Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator run one actionable V2 Board task in a Mesh-owned Git worktree and complete or block it only through a durable, validated Developer report that survives restart.

**Architecture:** Add strict Developer contracts and one forward-only V2 migration, then place a concrete `DeveloperAttemptService` around the existing M3 planning read model, V2 Git process runner, and `ExecutionRuntime` reservation/activation boundary. Persist workspace intent before Git effects, consume already-persisted structured output through a small observer, and project complete attempt/report/Board truth through the existing command, snapshot, event, replay, and resync paths.

**Tech Stack:** TypeScript, Zod, Fastify, SQLite/better-sqlite3, Node filesystem/path/crypto APIs, Git CLI through the approved V2 process runner, React, Vitest/Testing Library, Playwright, Nx/pnpm.

**Spec:** `docs/superpowers/specs/2026-09-01-mesh-v2-milestone-4-single-task-execution-design.md`

## Global Constraints

- M4 is one explicit human launch for one currently actionable task; do not add `ExecutionRun`, queues, waves, claims, concurrency, automatic selection, or scheduling.
- Reuse M3 readiness as the sole actionable calculation and keep task-completion authority in `DeveloperAttemptService`.
- Reuse `ExecutionRuntime` for worker lifecycle, adapter operations, audit persistence, normalized activity, interruption, and exact recovery; do not put Developer policy in it.
- Add one concrete Git workspace implementation; do not add a workspace-provider interface, user-selected paths, cleanup, merge, rebase, push, or deletion.
- Persist workspace intent before every Git effect, invoke only the approved Git executable without a shell, verify ownership afterward, and preserve ambiguous work.
- A valid `mesh.dev/developer-report/v1` report—not process exit—is the only M4 path to task completion.
- Keep V1 source, tables, commands, events, components, and runtime state untouched and unimported.
- Default and acceptance verification must use only the fake adapter, temporary repositories, temporary databases, and test-owned worktrees; never set `ANTHROPIC_API_KEY` or spend subscription quota.
- Keep existing protocol and legacy payload bytes unchanged; new M4 writes use strict versioned schemas.
- Do not add dependencies.

---

## File Map

- `packages/v2-contracts/src/developer-attempts.ts`: Developer IDs, assignment, attempt/workspace, evidence/report, and projection schemas.
- `packages/v2-contracts/src/{ids,profiles,executions,commands,events,http,index}.ts`: Extend existing unions and public contracts without changing legacy variants.
- `apps/v2-server/src/db/migrations/004_developer_attempts.sql`: Durable attempts, workspaces, effects, execution links, reports, and output receipts.
- `apps/v2-server/src/developer/developer-repository.ts`: SQLite mapping and transaction-only Developer persistence.
- `apps/v2-server/src/developer/managed-workspace.ts`: Deterministic Git worktree creation and read-only verification.
- `apps/v2-server/src/developer/developer-attempt-service.ts`: Launch, interrupt, replacement, completion/blocking, reconciliation, and command idempotency authority.
- `apps/v2-server/src/developer/developer-report-consumer.ts`: Strict persisted structured-output dispatch into the service.
- `apps/v2-server/src/executions/{execution-runtime,fake-harness}.ts`: One replacement-reservation seam and deterministic fake Developer activity/report output.
- `apps/v2-server/src/{http/main}.ts` and `apps/v2-server/src/http/{routes,snapshots}.ts`: Composition, command dispatch, startup ordering, snapshot projection, and publication.
- `apps/v2-web/src/components/DeveloperSection.tsx`: Selected-task Developer controls and chronology.
- `apps/v2-web/src/{app,state}/...`: Command wiring and complete snapshot/event replacement.
- `e2e-v2/src/v2-foundation.spec.ts`: Extend the existing fake-only Todo journey with the M4 stop proof.
- `docs/development/{architecture,session-platform}.md`: Implemented authority, workspace, recovery, and verification flow.

---

### Task 1: Define strict Developer contracts

**Files:**

- Create: `packages/v2-contracts/src/developer-attempts.ts`
- Modify: `packages/v2-contracts/src/ids.ts`
- Modify: `packages/v2-contracts/src/profiles.ts`
- Modify: `packages/v2-contracts/src/executions.ts`
- Modify: `packages/v2-contracts/src/commands.ts`
- Modify: `packages/v2-contracts/src/events.ts`
- Modify: `packages/v2-contracts/src/http.ts`
- Modify: `packages/v2-contracts/src/index.ts`
- Test: `packages/v2-contracts/src/contracts.spec.ts`

**Interfaces:**

- Consumes: existing `projectIdSchema`, `taskIdSchema`, `deliveryPlanIdSchema`, `workerProfileIdSchema`, `workerExecutionIdSchema`, `planRequirementRefSchema`/`PlanRequirementRef`, `boardViewSchema`, `taskRevisionSchema`, timestamp/text/path/Git schemas, and strict union patterns.
- Produces: `DEVELOPER_REPORT_SCHEMA`, `developerTaskAssignmentSchema`, `developerAttemptSchema`, `managedWorkspaceSchema`, `developerReportSchema`, three command/envelope schemas, three domain-event schemas, snapshot fields `developerAttempts` and `developerReports`, and their inferred public types.

- [ ] **Step 1: Write failing contract tests for exact shapes and rejection rules**

Add table-driven tests that parse one valid start/interrupt/replace envelope, workspace, attempt, blocker report, and completion report, then reject unknown keys, mismatched report disposition fields, duplicate criterion indexes, duplicate requirement IDs, and profiles whose assignment/output pair is not exactly Developer-compatible.

```ts
const assignment = developerTaskAssignmentSchema.parse({
  kind: 'developer_task',
  projectId,
  attemptId,
  taskId,
  taskContractRevision: 1,
  taskCurrentRevision: 1,
  deliveryPlanId,
  deliveryPlanRevision: 1,
  requirementRevisions: [{ recordId: requirementId, recordRevision: 1 }],
  baseCommit: 'a'.repeat(40),
  workspacePath: 'C:\\mesh-data\\worktrees\\attempt',
  title: 'Persist Todo items',
  outcome: 'Todo items survive reload.',
  acceptanceCriteria: ['Reload restores one Todo item.'],
  verification: ['Run the Todo persistence test.'],
  expectedArtifacts: ['src/todos.ts'],
  outputSchema: DEVELOPER_REPORT_SCHEMA,
});

expect(
  developerCompletionReportSchema.safeParse({
    ...validCompletionReport(assignment),
    criterionCoverage: [
      { index: 0, text: assignment.acceptanceCriteria[0], passed: true, evidence: [] },
      { index: 0, text: assignment.acceptanceCriteria[0], passed: true, evidence: [] },
    ],
  }).success,
).toBe(false);
```

- [ ] **Step 2: Run the contract test and verify the missing exports fail**

Run: `corepack pnpm nx test v2-contracts -- --run src/contracts.spec.ts`

Expected: FAIL because the Developer schemas and union variants do not exist.

- [ ] **Step 3: Add the minimal schemas and union extensions**

Define branded UUID IDs in `ids.ts`, keep all objects strict, and make coverage uniqueness/completeness-friendly at the boundary:

```ts
export const DEVELOPER_REPORT_SCHEMA = 'mesh.dev/developer-report/v1' as const;

export const developerReportSchema = z.discriminatedUnion('disposition', [
  developerCompletionReportSchema,
  developerBlockerReportSchema,
]);

export const developerAttemptLifecycleSchema = z.enum([
  'reserved',
  'provisioning',
  'active',
  'completed',
  'blocked',
  'interrupted',
  'attention_required',
]);
```

Add `developerTaskAssignmentSchema` to `workerAssignmentSchema`, add the exact tuple `[z.literal('developer_task')]` to profile assignment kinds, and enforce `mesh.dev/developer-report/v1` in `requireHarnessProjectCoherence`. Extend `v2CommandEnvelopeSchema`, `domainEventDraftSchema`/`domainEventSchema`, `v2CommandResultSchema`, and `v2ProjectSnapshotSchema` by appending new variants/fields only; preserve all existing legacy members byte-for-byte.

Append these exact typed failure codes to `V2_ERROR_CODES`:

```ts
'developer_task_stale'
'developer_plan_stale'
'developer_profile_stale'
'developer_profile_incompatible'
'developer_task_not_actionable'
'developer_attempt_conflict'
'developer_attempt_transition_conflict'
'developer_workspace_conflict'
'developer_workspace_identity_mismatch'
'developer_workspace_operation_failed'
'developer_report_binding_invalid'
'developer_report_coverage_invalid'
'developer_replacement_unavailable'
```

Use these exact command names:

```ts
'developer_attempt.start'
'developer_attempt.interrupt'
'developer_attempt.replace_execution'
```

Use schema version `1` in each new event payload and return complete projections in success results:

```ts
type StartDeveloperAttemptSuccess = {
  ok: true;
  commandType: 'developer_attempt.start';
  schemaVersion: 1;
  attempt: DeveloperAttempt;
  board: BoardView;
};
```

- [ ] **Step 4: Run focused contracts and type checking**

Run: `corepack pnpm nx test v2-contracts -- --run src/contracts.spec.ts`

Expected: PASS, including strict legacy decoding assertions and the new Developer cases.

Run: `corepack pnpm nx typecheck v2-contracts`

Expected: PASS.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add packages/v2-contracts/src
git commit -m "feat(v2): define developer attempt contracts"
```

---

### Task 2: Add forward-only Developer persistence

**Files:**

- Create: `apps/v2-server/src/db/migrations/004_developer_attempts.sql`
- Create: `apps/v2-server/src/developer/developer-repository.ts`
- Create: `apps/v2-server/src/developer/developer-repository.spec.ts`
- Modify: `apps/v2-server/src/db/migrate.ts`
- Modify: `apps/v2-server/src/db/database.spec.ts`

**Interfaces:**

- Consumes: `V2Database`, `inImmediateTransaction`, Developer contract schemas, existing command/event repositories, and the immutable `task_revisions` ledger.
- Produces: `DeveloperRepository` with `attempt`, `attemptsForProject`, `reportsForProject`, `reserveAttemptInTransaction`, `transitionAttemptInTransaction`, `recordWorkspaceObservationInTransaction`, `linkExecutionInTransaction`, `insertReportInTransaction`, `recordOutputReceiptInTransaction`, and `nonterminalAttempts`.

- [ ] **Step 1: Write failing migration and repository tests**

Prove migration version/name, fresh and upgraded databases, partial uniqueness, immutable reports, ordered execution/report history, optimistic revisions, idempotent output receipts, and transaction rollback.

```ts
expect(
  database.prepare(
    'SELECT version, name FROM v2_schema_migrations ORDER BY version',
  ).all(),
).toContainEqual({ version: 4, name: '004_developer_attempts' });

repository.reserveAttemptInTransaction(firstReservation);
expect(() =>
  inImmediateTransaction(database, () =>
    repository.reserveAttemptInTransaction(secondReservationForSameTask),
  ),
).toThrow(/developer attempt already controls task/i);
```

Also install a trigger that fails the final report insert and assert no attempt, task revision, event, or receipt subset survives.

- [ ] **Step 2: Run focused database tests and verify migration 4 is absent**

Run: `corepack pnpm nx test v2-server -- --run src/db/database.spec.ts src/developer/developer-repository.spec.ts`

Expected: FAIL because migration 4 and `DeveloperRepository` do not exist.

- [ ] **Step 3: Add migration 4 and transaction-only mappings**

Create tables keyed by durable IDs:

```sql
CREATE TABLE developer_attempts (...);
CREATE UNIQUE INDEX developer_attempt_one_controlling_task
  ON developer_attempts(project_id, task_id)
  WHERE lifecycle IN ('reserved', 'provisioning', 'active', 'interrupted');

CREATE TABLE developer_workspaces (
  attempt_id TEXT PRIMARY KEY REFERENCES developer_attempts(id),
  ...
);
CREATE TABLE developer_workspace_operations (...);
CREATE TABLE developer_attempt_executions (... UNIQUE(attempt_id, ordinal), UNIQUE(execution_id));
CREATE TABLE developer_reports (... UNIQUE(execution_id));
CREATE TABLE developer_output_receipts (... UNIQUE(runtime_event_id));
```

Use checks for every lifecycle enum, nonnegative revision, monotonic ordinal, nonempty canonical JSON, and `ended_at` terminal consistency. Store complete contract-shaped JSON for assignment/workspace/report and parse it through Zod on every read. Do not mutate reports; provide insert and list methods only.

Append this migration after the immutable first three entries in `migrate.ts`:

```ts
const developerAttemptsMigration = {
  version: 4,
  name: '004_developer_attempts',
  sql: readFileSync(join(__dirname, 'migrations', '004_developer_attempts.sql'), 'utf8'),
};
```

- [ ] **Step 4: Run persistence tests and the full V2 database spec**

Run: `corepack pnpm nx test v2-server -- --run src/developer/developer-repository.spec.ts src/db/database.spec.ts`

Expected: PASS with versions 1-4 and unchanged earlier migration digests/behavior.

- [ ] **Step 5: Commit the durable model**

```bash
git add apps/v2-server/src/db apps/v2-server/src/developer/developer-repository.ts apps/v2-server/src/developer/developer-repository.spec.ts
git commit -m "feat(v2): persist developer attempts"
```

---

### Task 3: Provision and verify one managed Git worktree

**Files:**

- Create: `apps/v2-server/src/developer/managed-workspace.ts`
- Create: `apps/v2-server/src/developer/managed-workspace.spec.ts`

**Interfaces:**

- Consumes unchanged: approved `gitExecutable`, `createV2GitProcessRunner`, `createRepositoryIdentityResolver`, `ManagedWorkspace`, and a previously persisted `creating` workspace operation.
- Produces: `deriveManagedWorkspace`, `createManagedWorkspace`, and `observeManagedWorkspace`; all return observations and never delete/reset/move a path.

- [ ] **Step 1: Write failing temporary-Git tests**

Cover deterministic branch/path derivation without task text, reservation-before-effect, successful creation, collision, partial directory, wrong identity, wrong branch/HEAD, missing ownership metadata, clean provisioning, dirty active observation, Windows case/separator normalization, and no cleanup call after failure.

```ts
const first = deriveManagedWorkspace({
  managedRoot,
  projectId,
  taskId,
  attemptId,
  baseCommit,
});
expect(first.branch).toBe(`mesh/dev/${projectId}/${taskId}/${attemptId}`);
expect(first.path).toBe(resolve(managedRoot, projectId, taskId, attemptId));
expect(first.path).not.toContain('Persist Todo items');
```

Inject a recording process runner and assert the first mutating call is exactly `git -c credential.interactive=false -C <repo> worktree add -b <branch> <path> <baseCommit>` and only occurs after the repository fixture reports the durable operation as present.

- [ ] **Step 2: Run the workspace spec and verify the module is missing**

Run: `corepack pnpm nx test v2-server -- --run src/developer/managed-workspace.spec.ts`

Expected: FAIL because the managed workspace functions do not exist.

- [ ] **Step 3: Implement the concrete Git service**

Use `resolve`, `relative`, `realpath`, `mkdir`, `readFile`, `writeFile`, `randomUUID`, and the approved process runner. Reject paths escaping `managedRoot`; never use a shell. Write ownership metadata only in the newly created worktree's Git administrative directory returned by `git rev-parse --git-dir`, never in its checked-out tree, so the required clean provisioning observation remains true:

```ts
const ownership = {
  schema: 'mesh.v2/developer-workspace-owner/v1',
  attemptId: workspace.attemptId,
  ownershipToken: workspace.ownershipToken,
  repositoryIdentity: workspace.repositoryIdentity,
  branch: workspace.branch,
  baseCommit: workspace.baseCommit,
};
```

Verify with `git worktree list --porcelain`, `rev-parse --show-toplevel`, `rev-parse HEAD^{commit}`, `symbolic-ref --short HEAD`, and `status --porcelain=v1 -z`. Return typed attention observations for conflicts or ambiguous state; do not remove anything.

- [ ] **Step 4: Run workspace and repository-identity tests**

Run: `corepack pnpm nx test v2-server -- --run src/developer/managed-workspace.spec.ts src/projects/repository-identity.spec.ts`

Expected: PASS on the current platform with test-owned repositories only.

- [ ] **Step 5: Commit workspace safety**

```bash
git add apps/v2-server/src/developer/managed-workspace.ts apps/v2-server/src/developer/managed-workspace.spec.ts
git commit -m "feat(v2): provision managed developer worktrees"
```

---

### Task 4: Start one actionable Developer attempt

**Files:**

- Create: `apps/v2-server/src/developer/developer-attempt-service.ts`
- Create: `apps/v2-server/src/developer/developer-attempt-service.spec.ts`
- Modify: `apps/v2-server/src/planning/planning-repository.ts`
- Modify: `apps/v2-server/src/planning/planning-repository.spec.ts`

**Interfaces:**

- Consumes: `DeveloperRepository`, managed workspace functions, approved profile resolution, `PlanningRepository.projectPlanningBoard`, `ExecutionRuntime.reserveStart`, `ExecutionRuntime.activateReserved`, command/event repositories, and the audit barrier.
- Produces: `PlanningRepository.taskExecutionAuthority(projectId, taskId)` and `DeveloperAttemptService.start(envelope)` plus `drainPendingActivations()`.

- [ ] **Step 1: Write failing launch-guard and ordering tests**

Test every guard independently: missing/inactive project, stale plan ID/revision, stale task revision, non-actionable readiness, existing controlling attempt, incompatible/unapproved profile, changed repository identity/HEAD, billing override, and tripped audit barrier. Assert zero attempts/effects/executions/events for pre-reservation failures.

For success, record phase order and assert:

```ts
expect(phases).toEqual([
  'attempt_reserved',
  'workspace_effect_started',
  'workspace_observed_ready',
  'execution_reserved',
  'attempt_activated',
  'execution_activated',
]);
expect(result.attempt.assignment.taskCurrentRevision).toBe(authority.task.revision);
expect(result.attempt.workspace.baseCommit).toBe(authority.projectHead);
```

Also replay the same command ID and assert it returns the same reserved/in-progress result without a second Git or adapter call.

- [ ] **Step 2: Run service and planning repository tests and verify they fail**

Run: `corepack pnpm nx test v2-server -- --run src/developer/developer-attempt-service.spec.ts src/planning/planning-repository.spec.ts`

Expected: FAIL because the execution-authority read and service are missing.

- [ ] **Step 3: Add one M3 execution-authority read**

Return one transactionally coherent value assembled from current M3 truth, including `project`, approved plan/intent/ledger revisions, exact task contract/current revision, exact requirement revisions, and the existing Board card/readiness. Do not duplicate the readiness algorithm:

```ts
type TaskExecutionAuthority = {
  project: Project;
  deliveryPlan: ApprovedDeliveryPlan;
  intentRevision: number;
  ledgerRevision: number;
  task: TaskRevision;
  requirementRevisions: readonly PlanRequirementRef[];
  board: BoardView;
  card: BoardTaskCard;
};
```

- [ ] **Step 4: Implement minimal start orchestration**

Validate the exact profile pair:

```ts
const compatible =
  profile.document.spec.assignmentKinds.length === 1 &&
  profile.document.spec.assignmentKinds[0] === 'developer_task' &&
  profile.document.spec.outputSchema === DEVELOPER_REPORT_SCHEMA;
```

Reserve attempt/workspace/operation and command receipt in one immediate transaction; perform Git creation; persist the verified observation; derive a `worker_execution.start` reservation using the frozen `developer_task` assignment; link it to the attempt; publish only committed domain events; then call `activateReserved`. On any post-reservation conflict, store observed facts and transition both workspace and attempt to `attention_required` without cleanup.

Use a deterministic internal execution idempotency key derived from the attempt and ordinal:

```ts
const executionKey = `developer-attempt:${attempt.id}:execution:1`;
```

- [ ] **Step 5: Run start-domain tests**

Run: `corepack pnpm nx test v2-server -- --run src/developer/developer-attempt-service.spec.ts src/planning/planning-repository.spec.ts`

Expected: PASS with no adapter start before durable attempt/workspace/execution linkage.

- [ ] **Step 6: Commit the single-task launch**

```bash
git add apps/v2-server/src/developer/developer-attempt-service.ts apps/v2-server/src/developer/developer-attempt-service.spec.ts apps/v2-server/src/planning/planning-repository.ts apps/v2-server/src/planning/planning-repository.spec.ts
git commit -m "feat(v2): start actionable developer attempts"
```

---

### Task 5: Consume reports and settle attempts atomically

**Files:**

- Create: `apps/v2-server/src/developer/developer-report-consumer.ts`
- Create: `apps/v2-server/src/developer/developer-report-consumer.spec.ts`
- Modify: `apps/v2-server/src/developer/developer-attempt-service.ts`
- Modify: `apps/v2-server/src/developer/developer-attempt-service.spec.ts`
- Modify: `apps/v2-server/src/planning/planning-repository.ts`
- Modify: `apps/v2-server/src/planning/planning-repository.spec.ts`

**Interfaces:**

- Consumes: persisted `WorkerExecutionStructuredOutputRuntimeEvent`, exact controlling execution, frozen assignment, immutable report/output-receipt persistence, M3 task revisions, Board projection, event store, and audit barrier.
- Produces: synchronous `DeveloperReportConsumer.structuredOutput(execution, event)`, `DeveloperAttemptService.acceptReport`, and `PlanningRepository.appendOperationalTaskLifecycleInTransaction`.

- [ ] **Step 1: Write failing report validation and atomicity tests**

Cover ignored non-Developer assignments; exact attempt/execution/task/contract/workspace binding; exactly one passed entry per frozen criterion and requirement; exact criterion text and requirement revision; at least one successful verification; malformed, missing, unexpected, duplicate, failed, late, and second reports; blocker preservation; dependent readiness after completion; and audit rollback at every persistence boundary.

```ts
expect(() => consumer.structuredOutput(execution, structured(validReport))).not.toThrow();
expect(repository.attempt(attempt.id)?.lifecycle).toBe('completed');
expect(planning.taskExecutionAuthority(projectId, dependentTaskId)?.card.readiness).toBe('actionable');

expect(() => consumer.structuredOutput(execution, structured(validReport))).not.toThrow();
expect(repository.reportsForProject(projectId)).toHaveLength(1);
expect(repository.outputReceipt(runtimeEventId)?.status).toBe('rejected');
```

- [ ] **Step 2: Run focused report tests and verify no completion path exists**

Run: `corepack pnpm nx test v2-server -- --run src/developer/developer-report-consumer.spec.ts src/developer/developer-attempt-service.spec.ts src/planning/planning-repository.spec.ts`

Expected: FAIL because the consumer and task-lifecycle append method are missing.

- [ ] **Step 3: Implement strict evidence validation**

Compare sorted key sets, not counts alone:

```ts
const expectedCriteria = assignment.acceptanceCriteria.map((text, index) => ({ index, text }));
const expectedRequirements = assignment.requirementRevisions;
assertExactCriterionCoverage(report.criterionCoverage, expectedCriteria);
assertExactRequirementCoverage(report.requirementCoverage, expectedRequirements);
if (!report.verification.some(({ outcome }) => outcome === 'passed')) {
  throw new DeveloperReportRejectedError('report_coverage_invalid', 'A successful verification observation is required');
}
```

The consumer must first parse `event.payload.value` through `developerReportSchema`, then call the service only for `developer_task`. Record one accepted or rejected output receipt keyed by `runtimeEventId`; never overwrite a report.

- [ ] **Step 4: Implement one completion/blocker transaction**

For completion, re-read all authority and insert in this order inside one `inImmediateTransaction`: output receipt, immutable report, operational task revision, attempt transition, recomputed Board, report/attempt/`task.lifecycle_changed` domain events, command/domain observation receipt. Keep `contractRevision` unchanged and use the existing sequential lifecycle source.

For blockers, insert receipt/report, transition the attempt to `blocked`, keep the task pending, recompute the Board, and append complete report/attempt events. Publish the returned event batch only after commit.

- [ ] **Step 5: Run report, planning, and execution regression tests**

Run: `corepack pnpm nx test v2-server -- --run src/developer/developer-report-consumer.spec.ts src/developer/developer-attempt-service.spec.ts src/planning/planning-repository.spec.ts src/executions/execution-runtime.spec.ts`

Expected: PASS; planning structured-output behavior remains unchanged.

- [ ] **Step 6: Commit evidence-authoritative completion**

```bash
git add apps/v2-server/src/developer apps/v2-server/src/planning
git commit -m "feat(v2): settle tasks from developer reports"
```

---

### Task 6: Add interruption, replacement, and Developer recovery

**Files:**

- Modify: `apps/v2-server/src/executions/execution-runtime.ts`
- Modify: `apps/v2-server/src/executions/execution-runtime.spec.ts`
- Modify: `apps/v2-server/src/executions/reconcile-executions.ts`
- Modify: `apps/v2-server/src/developer/developer-attempt-service.ts`
- Modify: `apps/v2-server/src/developer/developer-attempt-service.spec.ts`
- Create: `apps/v2-server/src/developer/reconcile-developer-attempts.ts`
- Create: `apps/v2-server/src/developer/reconcile-developer-attempts.spec.ts`

**Interfaces:**

- Consumes: `ExecutionRuntime.interrupt`, exact execution reconciliation results, workspace observations, attempt revision guards, and frozen assignment/profile/workspace.
- Produces: `ExecutionRuntime.reserveReplacement(startEnvelope, priorExecutionId)`, `DeveloperAttemptService.interrupt`, `DeveloperAttemptService.replaceExecution`, and `reconcileDeveloperAttempts` returning pending activations/events.

- [ ] **Step 1: Write failing runtime replacement tests**

Prove a replacement reservation freezes the same assignment/profile, sets `replacementForExecutionId`, records a distinct linked start operation, replays idempotently, and does not activate before the caller links it.

```ts
const replacement = await runtime.reserveReplacement(envelope, first.id);
expect(replacement.execution).toMatchObject({
  replacementForExecutionId: first.id,
  lifecycle: 'starting',
});
expect(fake.startCount).toBe(1); // only the already activated first execution
```

- [ ] **Step 2: Run the runtime spec and verify replacement reservation is missing**

Run: `corepack pnpm nx test v2-server -- --run src/executions/execution-runtime.spec.ts`

Expected: FAIL because `reserveReplacement` does not exist.

- [ ] **Step 3: Add the narrow replacement reservation seam**

Thread `replacementForExecutionId` through the existing private reservation transaction, stored start-operation authority, replay validation, execution row, and successful receipt. Reject a prior execution from another project or a nonterminal prior execution. Keep public `start` behavior and ordinary receipts unchanged.

```ts
async reserveReplacement(
  envelope: StartExecutionEnvelope,
  replacementForExecutionId: WorkerExecutionId,
): Promise<ReservedExecutionStart> {
  return this.reserveStartAfterLookup(envelope, false, replacementForExecutionId);
}
```

- [ ] **Step 4: Write failing attempt interruption/replacement/recovery tests**

Cover revision conflicts, report-before-interrupt ordering, proven interrupt to `interrupted`, unproven interrupt to `attention_required`, replacement only from `interrupted`, dirty-but-owned active workspaces, missing/wrong workspace ownership to attention, exact resumed sessions, lost/terminal execution to interrupted, and preserved prior execution/worktree history.

Assert startup recovery returns events and activation IDs without publishing or activating them itself:

```ts
expect(recovery).toEqual({
  events: expect.arrayContaining([expect.objectContaining({ type: 'developer_attempt.changed' })]),
  pendingActivationIds: [replacementExecutionId],
});
```

- [ ] **Step 5: Run attempt/recovery specs and verify reverse states fail**

Run: `corepack pnpm nx test v2-server -- --run src/developer/developer-attempt-service.spec.ts src/developer/reconcile-developer-attempts.spec.ts src/executions/reconcile-executions.spec.ts`

Expected: FAIL because interrupt/replacement/reconciliation are not implemented.

- [ ] **Step 6: Implement reverse transitions and read-only reconciliation**

`interrupt` must transactionally move the attempt first, then call the generic runtime with the exact controlling execution revision, and finally settle from durable runtime truth. `replaceExecution` must re-observe identity/branch/HEAD/ownership, reserve with the frozen assignment/profile, atomically link ordinal + controlling ID + attempt revision, then activate after commit.

`reconcileDeveloperAttempts` must inspect every nonterminal attempt after generic execution reconciliation, never mutate disk, and apply this decision table:

```ts
if (!workspace.provesOwnership) return 'attention_required';
if (execution.lifecycle === 'running' || execution.lifecycle === 'starting') return 'active';
if (attempt.lifecycle === 'reserved' || attempt.lifecycle === 'provisioning') return 'attention_required';
if (!hasValidReport && isExecutionTerminal(execution)) return 'interrupted';
return attempt.lifecycle;
```

Treat a dirty active worktree as expected Developer activity; require clean state only before first activation.

- [ ] **Step 7: Run runtime, attempt, and recovery tests**

Run: `corepack pnpm nx test v2-server -- --run src/executions/execution-runtime.spec.ts src/executions/reconcile-executions.spec.ts src/developer/developer-attempt-service.spec.ts src/developer/reconcile-developer-attempts.spec.ts`

Expected: PASS with exact replacement links and no cleanup behavior.

- [ ] **Step 8: Commit lifecycle recovery**

```bash
git add apps/v2-server/src/executions apps/v2-server/src/developer
git commit -m "feat(v2): recover developer attempt lifecycles"
```

---

### Task 7: Wire commands, events, snapshots, fake output, and startup

**Files:**

- Modify: `apps/v2-server/src/executions/fake-harness.ts`
- Modify: `apps/v2-server/src/executions/fake-harness.spec.ts`
- Modify: `apps/v2-server/src/config.ts`
- Modify: `apps/v2-server/src/config.spec.ts`
- Modify: `apps/v2-server/src/http/routes.ts`
- Modify: `apps/v2-server/src/http/routes.spec.ts`
- Modify: `apps/v2-server/src/http/snapshots.ts`
- Modify: `apps/v2-server/src/http/snapshots.spec.ts`
- Modify: `apps/v2-server/src/main.ts`
- Modify: `apps/v2-server/src/main.spec.ts`

**Interfaces:**

- Consumes: three Developer envelope schemas, `DeveloperAttemptService`, `DeveloperReportConsumer`, `DeveloperRepository`, `reconcileDeveloperAttempts`, existing publisher/cursors/runtime observer, and `developer_task` assignment.
- Produces: route dispatch for all three commands, complete snapshot projections, composed planning+Developer observers, deterministic fake Developer artifact/report events, and the required startup phase ordering.

- [ ] **Step 1: Write failing fake harness tests**

Add Developer scenarios `completed`, `blocked`, `malformed`, `duplicate`, and `missing_output`, parsed from `MESH_V2_TEST_FAKE_DEVELOPER_SCENARIO` with the same test-only configuration discipline as `MESH_V2_TEST_FAKE_PM_SCENARIO`. Here `duplicate` means one completion payload containing duplicate criterion or requirement coverage, so the whole report is invalid and cannot complete the task; the report-consumer unit test separately proves that a second report never overwrites an already accepted report. Use the frozen `workspacePath` and Node `writeFile` to change a real test-owned Todo artifact before emitting activity/report/completion. Assert the emitted report binds every frozen criterion and requirement and includes a passed verification plus observed HEAD/dirty state.

```ts
expect(events.map(({ normalized }) => normalized.type)).toEqual([
  'worker_execution.output',
  'worker_execution.child_started',
  'worker_execution.child_finished',
  'worker_execution.structured_output',
  'worker_execution.completed',
]);
expect(readFileSync(join(assignment.workspacePath, 'todo-m4.txt'), 'utf8')).toBe('persisted\n');
```

- [ ] **Step 2: Run fake harness tests and verify `developer_task` is unsupported**

Run: `corepack pnpm nx test v2-server -- --run src/executions/fake-harness.spec.ts`

Expected: FAIL because the fake handle/scenario union cannot start a Developer assignment.

- [ ] **Step 3: Extend the fake adapter only for deterministic M4 cases**

Add `DEVELOPER_SCENARIO = 'developer-task-v1'` to the existing canonical handle, resume cursor, terminal cursor, probe, and event switch. Use assignment content to generate exact evidence; do not read operator credentials or invoke another process.

- [ ] **Step 4: Write failing HTTP/snapshot/startup tests**

Prove strict route dispatch and status mapping, full attempts/reports in snapshots, complete event replacement payloads, retained replay, and this startup order:

```ts
expect(phases).toEqual([
  'executions_reconciled',
  'developer_attempts_reconciled',
  'planning_bound_cycles_reconciled',
  'planning_pending_reservations_reconciled',
  'recovery_window_published',
  'recovered_sessions_attached',
  'pending_launches_drained',
  'accepting_commands',
]);
```

Hold the fake after structured output, restart the server, and assert no command is accepted before Developer recovery and no committed recovery event is published twice.

- [ ] **Step 5: Run server boundary tests and verify wiring is absent**

Run: `corepack pnpm nx test v2-server -- --run src/http/routes.spec.ts src/http/snapshots.spec.ts src/main.spec.ts`

Expected: FAIL because routes, snapshots, observers, and startup do not include Developer state.

- [ ] **Step 6: Compose the Developer domain into the existing server**

Instantiate one repository, managed workspace service, attempt service, and report consumer in `startV2Server`. Fan out the existing observer callbacks directly:

```ts
observer: {
  structuredOutput: (execution, event) => {
    planningObserver.structuredOutput(execution, event);
    developerObserver.structuredOutput(execution, event);
  },
  terminal: (execution) => {
    planningObserver.terminal(execution);
    developerObserver.terminal(execution);
  },
},
```

Derive the only managed root as `join(dirname(config.databasePath), 'developer-worktrees')`; do not add configuration for it. Run generic execution reconciliation first, Developer reconciliation second, then existing planning reconciliation. Publish the whole recovery window before attaching sessions, drain both planning and Developer pending activations, then accept commands. Add the service to route dependencies and repository to snapshots; keep the same socket and cursors. Map `*_stale`, attempt/workspace conflicts, identity mismatch, and replacement-unavailable errors to HTTP 409; report binding/coverage errors remain HTTP 400; adapter/audit failures remain HTTP 503.

- [ ] **Step 7: Run the complete V2 server target**

Run: `corepack pnpm nx test v2-server`

Expected: PASS with fake-only execution and unchanged planning/runtime tests.

- [ ] **Step 8: Commit the integrated server path**

```bash
git add apps/v2-server/src
git commit -m "feat(v2): expose developer execution lifecycle"
```

---

### Task 8: Add the selected-task Developer section

**Files:**

- Create: `apps/v2-web/src/components/DeveloperSection.tsx`
- Create: `apps/v2-web/src/components/DeveloperSection.spec.tsx`
- Modify: `apps/v2-web/src/components/BoardPane.tsx`
- Modify: `apps/v2-web/src/components/BoardPane.spec.tsx`
- Modify: `apps/v2-web/src/app/App.tsx`
- Modify: `apps/v2-web/src/app/App.spec.tsx`
- Modify: `apps/v2-web/src/state/reducer.ts`
- Modify: `apps/v2-web/src/state/reducer.spec.ts`
- Modify: `apps/v2-web/src/styles.css`

**Interfaces:**

- Consumes: snapshot `developerAttempts`/`developerReports`, existing execution/activity projections, compatible approved profiles, Board selected card, `V2Api.command`, connection/resync state, and three Developer command types.
- Produces: `DeveloperSection` and complete snapshot/event reducers; no local lifecycle authority.

- [ ] **Step 1: Write failing reducer tests for complete projection replacement**

Feed snapshot, `developer_attempt.changed`, `developer_workspace.changed`, and `developer_report.recorded` messages and assert keyed attempt/report replacement plus server-supplied Board replacement. Assert a retained gap replaces all Developer state from the next snapshot instead of merging stale rows.

```ts
expect(reduceProjectProjection(state, { type: 'domain.event', event })).toMatchObject({
  developerAttempts: { [attempt.id]: attempt },
  board: event.payload.board,
});
```

- [ ] **Step 2: Run reducer tests and verify Developer projection fields are missing**

Run: `corepack pnpm nx test v2-web -- --run src/state/reducer.spec.ts`

Expected: FAIL because the projection does not retain attempts or reports.

- [ ] **Step 3: Implement complete server-truth projection**

Initialize empty keyed maps, replace them from snapshots, and replace complete rows from events. Do not infer attempt or task lifecycle from runtime activity.

- [ ] **Step 4: Write failing component and App command tests**

Cover compatible exact profile options, start, active progress/activity, accessible interrupt, interrupted replacement chronology, completed/blocker evidence, preserved workspace guidance, attention reason, disconnected/stale/submitting/resync disabled reasons, error focus/announcement, and no optimistic completion.

```tsx
expect(screen.getByRole('button', { name: 'Start development' })).toBeEnabled();
await user.click(screen.getByRole('button', { name: 'Start development' }));
expect(api.command).toHaveBeenCalledWith(
  expect.objectContaining({ command: expect.objectContaining({ type: 'developer_attempt.start' }) }),
  expect.any(AbortSignal),
);
expect(screen.getByRole('region', { name: 'Developer for Persist Todo items' })).toHaveFocus();
```

- [ ] **Step 5: Run component tests and verify the section is absent**

Run: `corepack pnpm nx test v2-web -- --run src/components/DeveloperSection.spec.tsx src/components/BoardPane.spec.tsx src/app/App.spec.tsx`

Expected: FAIL because the Developer section and handlers do not exist.

- [ ] **Step 6: Add the minimal task-detail UI and command wiring**

Render `DeveloperSection` from `TaskDetails`; pass the selected card, matching attempts/reports/executions/activity, compatible profiles, connection state, and three handlers from `ProjectConnection`. Use exact server revisions in commands. Keep the detail open on typed conflict; request current truth through the existing resync path; focus an `aria-live="assertive"` error region. Expose no branch/path/base inputs.

Use text plus icons/borders for state; do not rely on color. Add only selectors needed by the component and reuse existing button, form, activity, and error styles before adding scoped CSS.

- [ ] **Step 7: Run the complete V2 web target**

Run: `corepack pnpm nx test v2-web`

Expected: PASS with accessible Developer controls and unchanged Board/planning behavior.

- [ ] **Step 8: Commit the browser projection**

```bash
git add apps/v2-web/src
git commit -m "feat(v2): add board developer controls"
```

---

### Task 9: Prove the fake Todo stop condition and document the implementation

**Files:**

- Modify: `e2e-v2/src/v2-foundation.spec.ts`
- Modify: `e2e-v2/src/fixtures/v2-process.ts`
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/session-platform.md`

**Interfaces:**

- Consumes: the complete public V2 UI/HTTP/socket path, temporary Todo repository/database, fake Developer scenarios/hold, process restart, snapshot/replay/resync, and managed worktree diagnostics.
- Produces: one deterministic acceptance test covering the approved stop condition and current operational documentation.

- [ ] **Step 1: Write the failing integrated Todo scenario**

Build on the current Todo intent/plan flow, approve one project Developer profile, and exercise only public commands/UI. Assert reservation before Git, real artifact change in the managed worktree, activity, restart, interruption, replacement, isolated blocker/malformed/duplicate cases, exact completion evidence, task revision, dependent readiness, event ordering, second restart, retained-gap resync, normalized paths, and no V1/operator state.

```ts
const developerProfileYaml = `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: todo-developer
  displayName: Todo developer
  scope: project
spec:
  assignmentKinds:
    - developer_task
  preferredRuntime:
    harness: fake
    model: deterministic
  alternatives: []
  requiredCapabilities:
    - execution.stream
  skills:
    preferred: []
    required: []
  instructions: |
    Implement the exact frozen task and return structured evidence.
  outputSchema: mesh.dev/developer-report/v1
`;

const approveDeveloperProfile = async (page: Page, fixture: V2ProcessFixture) => {
  const response = await sendCommand(page, {
    type: 'worker_profile.approve_revision',
    scope: 'project',
    projectId: fixture.projectId,
    expectedLatestRevision: 0,
    sourceYaml: developerProfileYaml,
  });
  expect(response).toMatchObject({ status: 200, body: { ok: true } });
  await page.reload();
};

test('one Todo task completes with durable workspace evidence across restart', async ({ page }) => {
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
    fakeDeveloperScenario: 'completed',
    fakeHoldAfterAdapterCursor: 2,
  });
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await approveDeveloperProfile(page, fixture);
    await page.getByRole('button', { name: 'Start development' }).click();
    await expect(page.getByText('Workspace ready')).toBeVisible();
    await fixture.restart({ fakeHoldAfterAdapterCursor: undefined });
    await expect(page.getByText('Developer attempt 1')).toBeVisible();
    await expect(page.getByText('Todo persistence test passed')).toBeVisible();
    await expect(page.getByText('Completed', { exact: true })).toBeVisible();
    expect(await fixture.managedArtifact('todo-m4.txt')).toBe('persisted\n');
  } finally {
    await fixture.close();
  }
});

for (const scenario of ['blocked', 'malformed', 'duplicate'] as const) {
  test(`${scenario} Developer evidence preserves the task and workspace`, async ({ page }) => {
    const fixture = await V2ProcessFixture.createTodo({
      fakePmScenario: 'todo',
      fakeDeveloperScenario: scenario,
    });
    try {
      await registerTodo(page, fixture);
      await approveTodoIntent(page, fixture);
      await approveTodoDeliveryPlan(page, fixture);
      await approveDeveloperProfile(page, fixture);
      await page.getByRole('button', { name: 'Start development' }).click();
      await expect.poll(async () => (await fixture.projectSnapshot()).board.cards[0]?.task.lifecycle).toBe('pending');
      expect((await fixture.projectSnapshot()).developerAttempts[0]?.workspace.path).toBeTruthy();
    } finally {
      await fixture.close();
    }
  });
}

test('interruption and replacement preserve both executions and the workspace', async ({ page }) => {
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
    fakeDeveloperScenario: 'completed',
    fakeHoldAfterAdapterCursor: 2,
  });
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await approveDeveloperProfile(page, fixture);
    await page.getByRole('button', { name: 'Start development' }).click();
    await page.getByRole('button', { name: 'Interrupt development' }).click();
    await page.getByRole('button', { name: 'Replace execution' }).click();
    await expect.poll(async () => (await fixture.projectSnapshot()).developerAttempts[0]?.executionIds.length).toBe(2);
    expect((await fixture.projectSnapshot()).developerAttempts[0]?.workspace.path).toBeTruthy();
  } finally {
    await fixture.close();
  }
});
```

Keep every repository, database, managed root, and server process owned by the fixture; fixture cleanup may remove only paths it created and verified.

- [ ] **Step 2: Run the focused Playwright test and verify the stop condition fails**

Run: `corepack pnpm nx e2e v2-e2e -- --grep "one Todo task completes"`

Expected: FAIL at the first missing Developer UI/fixture behavior.

- [ ] **Step 3: Add only fixture controls required by the scenario**

Expose fake scenario/hold selection, managed-root lookup under the fixture root, safe artifact reads, restart, and forced retained-gap resync. Do not add real-adapter controls or arbitrary workspace paths.

- [ ] **Step 4: Run the focused Playwright scenario**

Run: `corepack pnpm nx e2e v2-e2e -- --grep "one Todo task completes"`

Expected: PASS using only fake adapter traffic and temporary state.

- [ ] **Step 5: Update current V2 development documentation**

Document these implemented facts: `DeveloperAttemptService` owns completion authority; M3 readiness is reused; worktree intent precedes effects; ambiguity preserves work; reports are strict/immutable; startup reconciles executions then Developer workspaces/attempts before publication/activation; M4 verification is fake-only; M5/M6 remain excluded.

- [ ] **Step 6: Run documentation and formatting checks**

Run: `corepack pnpm exec prettier --check docs/development/architecture.md docs/development/session-platform.md e2e-v2/src/v2-foundation.spec.ts e2e-v2/src/fixtures/v2-process.ts`

Expected: PASS.

- [ ] **Step 7: Run focused targets serially, then the repository gate**

Run: `corepack pnpm nx run-many -t test -p v2-contracts v2-server v2-web --parallel=1 --skip-nx-cache`

Expected: PASS.

Run: `corepack pnpm nx e2e v2-e2e`

Expected: PASS.

Run: `corepack pnpm verify`

Expected: PASS. If the known pre-existing parallel `server`/`v2-server` migration-directory race recurs, preserve the failing output, rerun `corepack pnpm nx run-many -t test -p server v2-server --parallel=1 --skip-nx-cache`, and report both results without changing unrelated V1 code.

- [ ] **Step 8: Register edits and inspect the final diff**

Call jCodeMunch `register_edit` once with the complete changed-path batch. Then run:

```bash
git diff --check origin/master...HEAD
git status --short
```

Expected: no whitespace errors and only intentional M4 files.

- [ ] **Step 9: Commit acceptance and documentation**

```bash
git add e2e-v2/src docs/development
git commit -m "test(v2): prove milestone 4 task execution"
```

---

## Acceptance Audit

Before claiming completion, map every design clause to current repository evidence:

- Contract tests prove assignment, profile compatibility, attempts, workspaces, reports, commands/results, events, snapshots, errors, and legacy decoding.
- Persistence tests prove migration 4, constraints, immutable history, reservation ordering, idempotency, and injected rollback.
- Workspace tests prove deterministic safe creation/observation and preservation of ambiguity.
- Domain/runtime tests prove launch guards, persisted-before-consumed reports, completion atomicity, interruption/replacement, recovery, audit barriers, and unchanged planning behavior.
- Web tests prove server-truth projection, accessible controls, disabled/error/resync states, activity/report chronology, and no optimistic task completion.
- The fake Todo Playwright scenario proves real managed worktree effects, restart, replay/resync, exact evidence, dependent readiness, and no V1/operator state.
- No implementation adds M5 scheduling, M6 QA/integration, cleanup, real-adapter gates, V1 coupling, API billing, or generic workflow/workspace abstractions.
