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
- Only `actor: { kind: 'human' }` may approve or reject a complete proposal.
  Agent output, process completion, and partial item selection never mutate
  canonical intent.
- M2 ends at approved intent and ledger recovery. Do not add milestones, tasks,
  task dependencies, readiness, requirement coverage, scheduling, workspaces,
  Developer/QA attempts, evidence, Board cards, or any other M3 behavior. Leave
  the Board placeholder unchanged.
- Non-trivial behavior is test-driven: first run the focused test and observe
  the stated failure, implement only the described behavior, then rerun the
  same test and observe success.
- No worker edits this design, this plan, another worker's handoff, or campaign
  scratch state. No worker delegates top-level ownership or launches parallel
  agents.

## Settled Interface Map

Task T01 owns every cross-process type below. Later tasks consume these exact
names and may not change their signatures.

```ts
export const PM_DISCOVERY_REPORT_SCHEMA =
  'mesh.dev/pm-discovery-report/v1' as const;

export type PlanningCycleLifecycle =
  | 'discovering'
  | 'execution_active'
  | 'awaiting_human'
  | 'awaiting_approval'
  | 'attention_required'
  | 'approved'
  | 'proposal_rejected';

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

export type PmDiscoveryAssignment = {
  kind: 'pm_discovery';
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
intentLedger: ApprovedIntentLedger | null;
```

The planning service boundary produced by T02 and consumed by T05 is:

```ts
export type PmExecutionLauncher = (
  input: PmExecutionLaunchInput,
) => Promise<WorkerExecution>;

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
  drainPendingLaunches(): Promise<void>;
  reconcileTerminalExecution(executionId: string): void;
}

export class PmReportConsumer {
  consume(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
  ): void;
}
```

The T05 launcher calls existing M1 `ExecutionRuntime.start` with a deterministic
idempotency key `planning-turn:<humanTurnId>` and the cycle's frozen PM profile.
It does not duplicate execution lifecycle code.

## Dependency Waves and Ownership Audit

| Wave | Tasks | Why ready | Non-overlap proof | Gate |
| --- | --- | --- | --- | --- |
| W0 | T01 | No implementation dependency | Sole owner of `packages/v2-contracts/**` | Contract tests/typecheck/build |
| W1 | T02, T03, T04 | T01 accepted | T02 owns database/planning domain; T03 owns execution runtime/fake; T04 owns new leaf web components only | Three focused suites and typechecks |
| W2 | T05 | All W1 tasks accepted | Sole serialized owner of server/web composition and every shared file | Integrated server/web tests, typechecks, builds |
| W3 | T06 | T05 accepted | Sole owner of `e2e-v2/**` and current development docs | Todo E2E, full verify, stop-condition audit |

W1 workers start from the same accepted W0 head. They must not import another
W1 worker's new implementation file. T01 contracts are the only shared
interface. T05 starts from the deterministic integration of T02, T03, then T04
and is intentionally serialized because it touches shared composition. T06
starts only after T05 review and integration.

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
review. No task enters integration from its worker report alone.

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
Residual risks:
- every residual risk, or none
```

Every wave integrator returns the frozen base, accepted commits in the declared
order, integration-only commit if one was explicitly authorized, exact combined
changed paths, every gate command/result, unexpected surfaces, and whether the
wave stop condition is satisfied. The coordinator accepts a wave only after a
separate review confirms that handoff against repository evidence.

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
- Modify: `packages/v2-contracts/src/http.ts`
- Modify: `packages/v2-contracts/src/index.ts`
- Test: `packages/v2-contracts/src/contracts.spec.ts`
- Prohibited: every path outside `packages/v2-contracts/**`

**Interfaces:**

- Consumes: existing `V2CommandEnvelope`, `WorkerExecution`, `DomainEvent`,
  `RuntimeEvent`, `V2ProjectSnapshot`, ID-branding, timestamp, and strict Zod
  conventions.
- Produces: every type and event in the Settled Interface Map; branded IDs for
  planning cycles/turns/questions/proposals/intents/ledgers/records; strict
  `ProjectIntentContent`, record discriminated unions, proposal members and
  relationships, command results, and stable error codes.

- [ ] **Step 1: Add red contract cases for the exact domain vocabulary**

  Add table-driven parsing cases that assert all six requirement kinds, all
  five requirement statuses, all five requirement relationship kinds, the five
  record types, and `constrains`. Include failures for an unknown kind, missing
  risk mitigation, requirement-only fields on a decision, a self-edge, and an
  M3-shaped `taskId` field.

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
  references per record. Add `superRefine` rules for unique keys, structurally
  resolvable proposal-local endpoint references, and no self-edge. T02 performs
  semantic endpoint-type validation against reused canonical records.

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

  Add the three human commands and envelopes, planning-specific success result
  variants, `PmDiscoveryAssignment`, structured-output runtime event,
  `planning_cycle.changed`, `intent_ledger.approved`, and the two snapshot
  fields. Keep every union strict and add project/embedded-record coherence
  refinements.

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

- [ ] **Step 5: Add round-trip, strictness, and authority tests**

  Parse valid question/proposal reports, planning events, complete snapshots,
  and all three command results. Assert unknown fields fail, the output schema
  literal is exact, all proposal-local keys resolve, snapshot children match
  the project, command actors are human, and no approval command is representable
  inside `PmDiscoveryReport`.

- [ ] **Step 6: Run the T01 green gate**

  Run:

  ```powershell
  corepack pnpm nx test v2-contracts
  corepack pnpm nx typecheck v2-contracts
  corepack pnpm nx build v2-contracts
  git diff --check
  ```

  Expected: all commands exit `0`; contract tests include explicit failures for
  `taskId`, `covers`, unknown fields, and non-human command envelopes.

- [ ] **Step 7: Commit T01**

  ```powershell
  git add -- packages/v2-contracts
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
  `ExecutionRepository`, `inImmediateTransaction`, `AuditBarrier`, and test DB.
- Produces: `PlanningRepository`, `PlanningService`, `PmReportConsumer`,
  `PmExecutionLauncher`, `planningSnapshot(projectId)`,
  `approvedIntentLedger(projectId)`, and durable pending-launch reads.

- [ ] **Step 1: Write red migration and repository tests**

  Prove a fresh database and an exact migration-1 database both reach migration
  2; capture the SHA-256 of `001_foundation.sql` before the test and assert the
  source is unchanged. Test immutable inserts, ordered turns/proposals,
  provenance ownership, exact ledger membership, edge uniqueness, and restart
  reads.

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
  integrity.

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

  Expected: PASS for fresh/upgrade databases, foreign keys, uniqueness,
  immutable revision history, and restart reads.

- [ ] **Step 5: Write red service tests for turns, proposals, and authority**

  Cover new-cycle PM profile freezing, later-turn profile reuse, one pending
  launch per human turn, exact command replay, question receipt, complete
  proposal receipt, proposal supersession, revision request, rejection,
  approval, stale cycle/base/record failures, agent self-approval, malformed and
  duplicate output, completion without receipt, and injected failures at
  receipt insert, canonical insert, event append, and command-result insert.

  ```ts
  await service.submitTurn(firstTurnEnvelope);
  await service.submitTurn(firstTurnEnvelope);
  expect(launcher).toHaveBeenCalledTimes(1);

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
  derives `planning-turn:<turnId>`, binds the returned execution in a second
  transaction, and is safe after restart. The consumer accepts only a matching
  `pm_discovery` assignment and performs one immediate transaction per report.

  ```ts
  const launchKey = (turnId: string) => `planning-turn:${turnId}`;

  consume(execution, event): void {
    const report = pmDiscoveryReportSchema.parse(event.payload.value);
    requireFrozenBinding(execution.assignment, report);
    inImmediateTransaction(this.database, () => {
      if (this.repository.replayReceipt(execution.id, event)) return;
      this.repository.insertReceipt(execution, event, report);
      const change = this.repository.applyReport(execution, report);
      this.events.appendDomainInTransaction(
        execution.projectId,
        planningCycleChangedDraft(change, event.occurredAt),
      );
    });
  }
  ```

- [ ] **Step 8: Make service tests green and run the T02 gate**

  Run:

  ```powershell
  corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.spec.ts apps/v2-server/src/planning/planning-service.spec.ts apps/v2-server/src/planning/pm-report-consumer.spec.ts --config apps/v2-server/vitest.config.ts
  corepack pnpm nx typecheck v2-server
  git diff --check
  ```

  Expected: all commands exit `0`; injected persistence failures leave no
  partial canonical, receipt, command-result, or event rows.

- [ ] **Step 9: Commit T02**

  ```powershell
  git add -- apps/v2-server/src/db apps/v2-server/src/planning apps/v2-server/src/test/create-v2-test-database.ts
  git commit -m "feat(v2): persist intent ledger planning"
  ```

**Acceptance:** Migration 2 is forward-only; all planning and canonical history
survives reopen; human approval is exact and atomic; invalid/duplicate worker
output cannot partially mutate canonical intent.

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
- Prohibited: database migrations, `apps/v2-server/src/planning/**`,
  `apps/v2-server/src/main.ts`, `apps/v2-server/src/http/**`, all web/e2e paths

**Interfaces:**

- Consumes: T01 `PmDiscoveryAssignment`, `PmDiscoveryReport`, and structured
  runtime event; existing `HarnessAdapter`, `HarnessSession`, and
  `V2EventStore.appendRuntimeWithDiagnosticInTransaction`.
- Produces: `FakePmScenario = 'todo' | 'malformed' | 'duplicate' |
  'missing_output'`; `FakeHarnessAdapter` constructor option
  `pmScenario?: FakePmScenario`; unchanged adapter/runtime public signatures.

- [ ] **Step 1: Add red runtime ordering and fake scenario tests**

  Assert a Todo question run emits structured output then completion and closes;
  the answer run emits the complete proposal then completion; every structured
  event has a raw diagnostic committed first; malformed emits unparseable
  value; duplicate emits two output envelopes; missing-output emits only
  completion. Assert no second call reuses a native PM handle.

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
  corepack pnpm exec vitest run apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected: FAIL because the runtime event and PM fake scenarios are not
  implemented.

- [ ] **Step 3: Extend the fake script and runtime event persistence**

  Branch only on `assignment.kind`. Keep the existing foundation script intact.
  For `pm_discovery`, generate a fresh finite native handle and the deterministic
  report bound to assignment IDs/revisions. The Todo proposal must include the
  design's five record types, three requirements, `depends_on`, `constrains`,
  and provenance to both turns. Do not add an adapter session cache or provider
  resume concept.

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
  corepack pnpm exec vitest run apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts --config apps/v2-server/vitest.config.ts
  corepack pnpm nx typecheck v2-server
  git diff --check
  ```

  Expected: all commands exit `0`; the audit-failure test publishes neither the
  structured event nor completion and trips the barrier.

- [ ] **Step 5: Commit T03**

  ```powershell
  git add -- apps/v2-server/src/executions
  git commit -m "feat(v2): add finite fake pm reports"
  ```

**Acceptance:** PM behavior is finite and fake-only, structured output uses the
existing audited runtime path, and no planning authority enters the adapter.

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
  `FocusedProjectShell*`, `styles.css`, all server/contracts/e2e paths

**Interfaces:**

- Consumes: T01 `PlanningCycleView`, `PlanningProposal`,
  `ApprovedIntentLedger`, `WorkerProfileSummary`, and `WorkerExecution`.
- Produces: `PlanningPane` callbacks `onSubmitTurn`, `onApprove`, `onReject`;
  `RequirementsPane({ intentLedger })`; no local canonical state.

- [ ] **Step 1: Write red component tests for all visible states**

  Cover initial profile selection/message, transcript order, question rationale
  and choice draft population, execution-active state, complete proposal
  summary/diff/provenance, Approve/Request revision/Reject callbacks, disabled
  disconnected/stale/submitting authority, live error, focus return, approved
  state, empty Requirements state, all five record groups, requirement
  kind/status, provenance, and textual relationship endpoints.

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
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Approve proposal' }));
  expect(onApprove).toHaveBeenCalledWith(latestProposal.id);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  ```

- [ ] **Step 2: Run leaf component tests and prove red**

  Run:

  ```powershell
  corepack pnpm exec vitest run apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/RequirementsPane.spec.tsx --config apps/v2-web/vitest.config.ts
  ```

  Expected: FAIL because both components do not exist.

- [ ] **Step 3: Implement the pure components and isolated styles**

  Use semantic headings, ordered lists, `fieldset`/`legend` for initial PM
  profile selection, a labeled textarea, explicit button text, `aria-live` for
  status/errors, and standard buttons for question choices. Request revision
  exposes the same human-turn textarea and callback; it never exposes per-item
  approval controls.

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
  corepack pnpm exec vitest run apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/RequirementsPane.spec.tsx --config apps/v2-web/vitest.config.ts
  corepack pnpm nx typecheck v2-web
  git diff --check
  ```

  Expected: all commands exit `0`; callback assertions prove one complete
  approval action and no partial-selection UI.

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
- Modify: `apps/v2-server/src/http/routes.ts`
- Modify: `apps/v2-server/src/http/routes.spec.ts`
- Modify: `apps/v2-server/src/http/snapshots.ts`
- Modify: `apps/v2-server/src/main.ts`
- Modify: `apps/v2-server/src/main.spec.ts`
- Modify: `apps/v2-web/src/api/client.ts`
- Modify: `apps/v2-web/src/api/client.spec.ts`
- Modify: `apps/v2-web/src/state/reducer.ts`
- Modify: `apps/v2-web/src/state/reducer.spec.ts`
- Modify: `apps/v2-web/src/state/resync.ts`
- Modify: `apps/v2-web/src/state/resync.spec.ts`
- Modify: `apps/v2-web/src/state/store.ts`
- Modify: `apps/v2-web/src/app/App.tsx`
- Modify: `apps/v2-web/src/app/App.spec.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.spec.tsx`
- Modify: `apps/v2-web/src/styles.css`
- Prohibited: contracts, migration/SQL, planning repository/service/consumer,
  fake-harness implementation, leaf component implementation, e2e, docs, V1

**Interfaces:**

- Consumes: all T01 contracts, T02 planning service/consumer/read models, T03
  structured runtime events/fake scenarios, T04 leaf component props.
- Produces: existing `registerV2Routes`, snapshot/replay endpoints,
  `createV2Api`, `ProjectProjection`, `App`, and `FocusedProjectShell` extended
  for M2; no new transport.

- [ ] **Step 1: Write red server composition tests**

  Add route tests for submit/approve/reject parsing, stable status/error mapping,
  idempotent replay, and human actor. Add snapshot tests for absent/present
  ledger and complete planning history. Add runtime integration tests proving a
  structured output is audited/published, consumed once, and terminalized; add
  startup tests proving pending turns drain after execution reconciliation and
  before command acceptance.

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
  corepack pnpm exec vitest run apps/v2-server/src/planning/planning-runtime.spec.ts apps/v2-server/src/http/routes.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts apps/v2-server/src/main.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected: FAIL because planning dependencies are not composed into runtime,
  routes, snapshots, or startup.

- [ ] **Step 3: Compose the planning runtime without a generic framework**

  `planning-runtime.ts` adapts the planning launcher to
  `ExecutionRuntime.start`, subscribes only to
  `worker_execution.structured_output` and terminal execution notifications,
  and calls T02's planning-specific methods. Add one explicit optional runtime
  observer dependency rather than a registry.

  ```ts
  export type ExecutionRuntimeObserver = {
    structuredOutput(
      execution: WorkerExecution,
      event: WorkerExecutionStructuredOutputRuntimeEvent,
    ): void;
    terminal(execution: WorkerExecution): void;
  };
  ```

  Wire repositories/services in `main.ts`, reconcile M1 executions, then drain
  planning launches, then begin accepting commands. Extend the existing route
  switch and snapshot reader. Parse `MESH_V2_TEST_FAKE_PM_SCENARIO` only in
  explicit fake test mode, reject it in production/default configuration, and
  pass it to `FakeHarnessAdapter`. Publish only events returned from committed
  operations.

- [ ] **Step 4: Make server composition tests green**

  Rerun Step 2.

  Expected: PASS, including restart drain, duplicate receipt, stale approval,
  and audit/persistence failure cases.

- [ ] **Step 5: Write red client, reducer, resync, app, and shell tests**

  Prove all three commands serialize through the existing client; snapshot and
  domain events update planning/ledger state; duplicates are ignored; gaps,
  project mismatch, incomplete projections, and invalid payloads request
  resync; refresh retains the human draft but replaces server truth; the shell
  renders T04 panes; tabs retain ArrowLeft/ArrowRight/Home/End; Board still says
  `Available in a later milestone`; disconnected/stale state disables commands.

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
  corepack pnpm exec vitest run apps/v2-web/src/api/client.spec.ts apps/v2-web/src/state/reducer.spec.ts apps/v2-web/src/state/resync.spec.ts apps/v2-web/src/app/App.spec.tsx apps/v2-web/src/components/FocusedProjectShell.spec.tsx --config apps/v2-web/vitest.config.ts
  ```

  Expected: FAIL because the existing projection and shell do not carry M2
  state or commands.

- [ ] **Step 7: Integrate API, reducer/resync, app, and shell**

  Add typed client methods using `v2CommandEnvelopeSchema`; project the two new
  domain events in sequence; include planning/ledger in snapshot replacement;
  preserve existing cursor and resync behavior. Pass server truth and callbacks
  to T04 components. Import `intent-ledger.css` from the existing stylesheet or
  component entry without copying rules. Keep Board markup unchanged.

- [ ] **Step 8: Make web composition tests green and run the W2 gate**

  Run:

  ```powershell
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
  transport or UI-owned lifecycle.

- [ ] **Step 9: Commit T05**

  ```powershell
  git add -- apps/v2-server/src/planning/planning-runtime.ts apps/v2-server/src/planning/planning-runtime.spec.ts apps/v2-server/src/config.ts apps/v2-server/src/config.spec.ts apps/v2-server/src/executions/execution-runtime.ts apps/v2-server/src/executions/execution-runtime.spec.ts apps/v2-server/src/http apps/v2-server/src/main.ts apps/v2-server/src/main.spec.ts apps/v2-web/src
  git commit -m "feat(v2): compose intent ledger workflow"
  ```

**Acceptance:** One existing command route and realtime connection carry M2;
restart ordering is deterministic; UI state is a server projection; the Board
and M3 domain remain untouched.

---

### Task T06: Fake-Only Todo Acceptance and Durable Documentation

**Outcome:** The built V2 product proves the complete Milestone 2 stop
condition with deterministic fake PM behavior, and current contributor docs
describe the implemented boundary without claiming M3.

**Files:**

- Modify: `e2e-v2/src/v2-foundation.spec.ts`
- Modify: `e2e-v2/project.json` only if the existing target cannot pass the
  test-only fake PM setting through unchanged
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/v2-foundation.md`
- Prohibited: all contracts, database, planning, execution, HTTP, web source,
  V1 paths, design/plan documents, and every operator-owned runtime path

**Interfaces:**

- Consumes: the built W2 server/web, existing `v2-e2e` Playwright harness,
  temporary Todo repository/database setup, and T03 `FakePmScenario`.
- Produces: existing test-only `MESH_V2_TEST_FAKE_PM_SCENARIO=todo`
  configuration in the built fixture; updated current architecture/operation
  docs.

- [ ] **Step 1: Write the red built-process Todo scenario**

  Extend the existing fixture rather than creating another server harness. In
  the browser, register/select the temporary Todo repository, approve the fake
  PM profile, send the initial description, assert structured questions, answer
  them, assert the complete proposal and no item checkboxes, approve it, open
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

  Restart the built server against the same temporary database, reload/reconnect,
  and assert intent revision 1, ledger revision 1, transcript, provenance, and
  relationships remain identical. Force one cursor gap using the fixture's
  existing resync mechanism and assert the same result after snapshot refresh.

- [ ] **Step 2: Run the Todo E2E and prove red**

  Run:

  ```powershell
  corepack pnpm nx e2e v2-e2e -- --grep "conversation becomes an approved intent ledger"
  ```

  Expected: FAIL because the built-process fixture does not yet select the Todo
  fake PM scenario and the new journey is absent.

- [ ] **Step 3: Make the Todo scenario green**

  Rerun Step 2.

  Expected: PASS using built server/web output, a temporary database/repository,
  port `0`, and no external agent process.

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
  corepack pnpm nx test v2-contracts
  corepack pnpm nx test v2-server
  corepack pnpm nx test v2-web
  corepack pnpm nx typecheck v2-contracts
  corepack pnpm nx typecheck v2-server
  corepack pnpm nx typecheck v2-web
  corepack pnpm nx build v2-contracts
  corepack pnpm nx build v2-server
  corepack pnpm nx build v2-web
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
  - questions and complete proposal history survive restart;
  - one human approval creates exactly intent revision 1 and ledger revision 1;
  - five record types, exact requirement vocabulary, provenance,
    `depends_on`, and `constrains` survive replay/resync/restart;
  - stale base, partial approval, agent self-approval, malformed/duplicate
    output, and injected persistence failure create no partial canonical state;
  - Requirements renders server truth and Board remains a placeholder;
  - the combined diff defines no M3 object or behavior.

- [ ] **Step 7: Commit T06**

  ```powershell
  git add -- e2e-v2 docs/development/architecture.md docs/development/v2-foundation.md
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

After W0, run the T01 green gate. After W1 integration, run:

```powershell
corepack pnpm nx test v2-contracts
corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.spec.ts apps/v2-server/src/planning/planning-service.spec.ts apps/v2-server/src/planning/pm-report-consumer.spec.ts apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts --config apps/v2-server/vitest.config.ts
corepack pnpm exec vitest run apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/RequirementsPane.spec.tsx --config apps/v2-web/vitest.config.ts
corepack pnpm nx typecheck v2-server
corepack pnpm nx typecheck v2-web
git diff --check
```

After W2, run the T05 W2 gate. After W3, run the T06 final gate and
stop-condition audit. A green worker test without accepted review and clean
integration evidence is insufficient.

## Final Stop-Condition Proof

Milestone 2 is complete only when one exact integrated commit proves all of the
following:

- conversation -> structured questions -> answer -> complete proposed
  `ProjectIntent`/ledger diff -> human atomic approval;
- immutable approved intent, stable record identities, immutable record and
  ledger revisions, complete membership/edge snapshots, and provenance;
- exact requirement kinds/statuses/relationships and decision `constrains`
  traceability;
- one finite fake PM execution per human turn and one strict, idempotent,
  binding-validated report receipt per accepted output;
- audit-before-publish, immediate atomic approval, stale/invalid/failure
  rollback, snapshot/replay/resync, and restart recovery;
- accessible PM and Requirements UI with human-only all-or-nothing approval;
- deterministic built-process Todo acceptance with no paid traffic,
  credentials, real repository, or operator state;
- no milestone, task, dependency, readiness, coverage, scheduling, Board, real
  adapter, persistent provider session, or generic consumer implementation.

If any item is unproved, return a bounded rework packet to its owning task. Do
not widen M2 to make the test pass.
