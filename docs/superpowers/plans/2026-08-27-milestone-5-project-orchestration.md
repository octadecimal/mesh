# Milestone 5 Project Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build finite, durable project runs that snapshot ready tasks and launch them through the existing Developer/QA workflow under an operator-selected concurrency limit.

**Architecture:** Add a concrete project-run aggregate and repository inside the task domain. `ProjectRunService` owns authorization, frozen membership, capacity, and operator controls; existing attempt, Developer, QA, and review-automation services retain execution authority. Run state flows through existing project snapshots and ordered project events into a focused React panel.

**Tech Stack:** TypeScript 6, Zod, Fastify, SQLite/better-sqlite3, React 19, Hookstate, Vitest, Playwright, Nx/pnpm.

**Spec:** `docs/superpowers/specs/2026-08-27-milestone-5-project-orchestration-design.md`

## Global Constraints

- Never enable `ANTHROPIC_API_KEY` or any pay-per-token billing path.
- Normal tests use the fake driver, temporary repositories, and temporary SQLite databases only.
- Persist run events before realtime publication; an audit write failure stops further scheduling.
- Snapshot only tasks that are ready, unblocked, and free of another current attempt or run claim.
- Default run concurrency is `1`; enforce a finite server maximum through configuration.
- Pause and Stop affect future launches only; active work drains without implicit interruption.
- Claims are durable ownership records and never expire by elapsed time.
- Do not add continuous scheduling, dependencies, PM authority, global quota scheduling, automatic retries, delivery automation, or a generic workflow framework.
- Update `docs/development/architecture.md` and `docs/development/session-platform.md` when the integrated behavior exists.

---

### Task 1: Define project-run contracts

**Files:**

- Create: `packages/contracts/src/project-runs.ts`
- Modify: `packages/contracts/src/commands.ts`
- Modify: `packages/contracts/src/project-events.ts`
- Modify: `packages/contracts/src/http.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/contracts.spec.ts`

**Interfaces:**

- Produces: `projectRunSchema`, `projectRunItemSchema`, `ProjectRun`, `ProjectRunItem`, `projectRunChangedEventSchema`.
- Produces commands: `project.run.start`, `project.run.pause`, `project.run.resume`, and `project.run.stop`.
- Produces snapshot fields: `ProjectSnapshot.runs: ProjectRun[]` and
  `ProjectSnapshot.projectRunLimits: { maxConcurrency: number }`.
- Consumes existing: `idSchema`, `isoTimestampSchema`, `taskActorSchema`, `projectEvent()`, and `expectedRevisionSchema` conventions.

- [ ] **Step 1: Write failing contract tests**

Add table-driven parsing tests that prove valid run/item states, reject invalid
state/outcome combinations, parse every command, parse the run event, and decode
an old project snapshot with `runs` defaulting to `[]`.

```ts
const run = {
  id: 'run-1',
  projectId: 'project-1',
  state: 'running',
  revision: 1,
  concurrency: 2,
  completionReason: null,
  startedAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  completedAt: null,
  items: [
    {
      id: 'item-1',
      runId: 'run-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskRevision: 3,
      queuePosition: 0,
      status: 'queued',
      outcomeReason: null,
      attemptId: null,
      sessionId: null,
      launchIdempotencyKey: 'run-1:item-1:launch',
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
};

expect(projectRunSchema.parse(run)).toEqual(run);
expect(
  projectSnapshotSchema.parse({ ...projectSnapshotWithoutRuns }),
).toMatchObject({ runs: [], projectRunLimits: { maxConcurrency: 1 } });
expect(() =>
  projectRunItemSchema.parse({
    ...run.items[0],
    status: 'completed',
    outcomeReason: null,
  }),
).toThrow();
```

- [ ] **Step 2: Run the focused contract tests and confirm RED**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: FAIL because `projectRunSchema` and the four command variants do not exist.

- [ ] **Step 3: Implement the run schemas and command/event unions**

Use discriminated unions so illegal terminal combinations cannot cross the wire.

```ts
export const projectRunItemStatusSchema = z.enum([
  'queued',
  'launch_pending',
  'active',
  'completed',
  'attention_required',
  'not_started',
]);

export const projectRunStateSchema = z.enum([
  'running',
  'paused',
  'draining',
  'completed',
]);

export const projectRunStartPayloadSchema = z.object({
  projectId: idSchema,
  concurrency: z.number().int().positive(),
  actor: humanActorSchema,
});
```

Make `projectSnapshotSchema` use `runs: z.array(projectRunSchema).default([])`
and default `projectRunLimits` to `{ maxConcurrency: 1 }` for compatibility.
The run event payload contains the complete authoritative run so clients can
replace one run without inferring item transitions.

- [ ] **Step 4: Run contracts and type checking**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: PASS.

Run: `corepack pnpm nx typecheck contracts`

Expected: PASS.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add packages/contracts
git commit -m "feat(contracts): add project run model"
```

---

### Task 2: Persist runs, items, and durable claims

**Files:**

- Create: `apps/server/src/db/migrations/012-project-runs.sql`
- Create: `apps/server/src/repositories/project-run-repository.ts`
- Create: `apps/server/src/repositories/project-run-repository.spec.ts`
- Modify: `apps/server/src/db/migrate.ts`
- Modify: `apps/server/src/db/migrate.spec.ts`
- Modify: `apps/server/src/test/create-test-database.ts`

**Interfaces:**

- Consumes: `ProjectRun`, `ProjectRunItem`, SQLite transaction ownership, project/task foreign keys.
- Produces: `ProjectRunRepository.create`, `get`, `getActiveByProject`, `listByProject`, `claimNext`, `linkLaunch`, `finishItem`, `changeState`, and `reconcileCounts`.
- Produces claim result: `{ run: ProjectRun; item: ProjectRunItem } | undefined`.

- [ ] **Step 1: Add failing fresh/upgrade migration tests**

Extend the migration manifests and assert tables, constraints, indexes, and
foreign keys exist after both a fresh migration and an upgrade from migration
011.

```ts
expect(tableNames(database)).toEqual(
  expect.arrayContaining(['project_runs', 'project_run_items']),
);
expect(indexNames(database)).toEqual(
  expect.arrayContaining([
    'one_active_project_run',
    'one_open_project_run_item_per_task',
    'project_run_queue_order',
  ]),
);
```

- [ ] **Step 2: Run migration tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts`

Expected: FAIL because migration 012 is absent.

- [ ] **Step 3: Add the additive migration**

Create `project_runs` and `project_run_items`. Use a partial unique index for
one run in `running|paused|draining` per project and another for one
`queued|launch_pending|active` item per task. Store policy revision and task
automation generation on items. Use checks for concurrency, revision, queue
position, lifecycle timestamps, terminal reason consistency, and linked
attempt/session pairing.

```sql
CREATE UNIQUE INDEX one_active_project_run
ON project_runs(project_id)
WHERE state IN ('running', 'paused', 'draining');

CREATE UNIQUE INDEX one_open_project_run_item_per_task
ON project_run_items(task_id)
WHERE status IN ('queued', 'launch_pending', 'active');
```

- [ ] **Step 4: Write failing repository transaction tests**

Cover atomic run creation, deterministic queue ordering, concurrency-aware
claiming, duplicate-task rejection, expected-revision state changes, launch
linking, terminal outcomes, aggregate counts, and rollback when project-event
insertion fails.

```ts
const first = repositories.projectRuns.claimNext({
  runId: run.id,
  expectedRunRevision: 1,
  occurredAt,
});
const second = repositories.projectRuns.claimNext({
  runId: run.id,
  expectedRunRevision: first!.run.revision,
  occurredAt,
});
const full = repositories.projectRuns.claimNext({
  runId: run.id,
  expectedRunRevision: second!.run.revision,
  occurredAt,
});
expect([first!.item.taskId, second!.item.taskId]).toEqual(['task-a', 'task-b']);
expect(full).toBeUndefined();
```

- [ ] **Step 5: Run repository tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/repositories/project-run-repository.spec.ts`

Expected: FAIL because `ProjectRunRepository` does not exist.

- [ ] **Step 6: Implement repository mapping and transactions**

Keep SQL and row decoding in the repository. Accept a transaction-owned
database in mutation helpers so the service can append project events in the
same transaction. Re-read the complete aggregate after every mutation rather
than hand-building partial return values.

```ts
export class ProjectRunRepository {
  constructor(private readonly database: Database) {}

  get(id: string): ProjectRun | undefined;
  getActiveByProject(projectId: string): ProjectRun | undefined;
  listByProject(projectId: string): ProjectRun[];
  create(input: CreateProjectRunInput): ProjectRun;
  claimNext(input: ClaimNextRunItemInput): ClaimedRunItem | undefined;
  linkLaunch(input: LinkRunItemLaunchInput): ProjectRun;
  finishItem(input: FinishRunItemInput): ProjectRun;
  changeState(input: ChangeProjectRunStateInput): ProjectRun | undefined;
}
```

- [ ] **Step 7: Run migration and repository tests**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts src/repositories/project-run-repository.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit persistence**

```bash
git add apps/server/src/db apps/server/src/repositories apps/server/src/test/create-test-database.ts
git commit -m "feat(server): persist project runs"
```

---

### Task 3: Define deterministic scheduling policy

**Files:**

- Create: `apps/server/src/tasks/project-run-policy.ts`
- Create: `apps/server/src/tasks/project-run-policy.spec.ts`
- Modify: `apps/server/src/config.ts`
- Test: `apps/server/src/config.spec.ts`

**Interfaces:**

- Consumes: live `Task[]`, `Project`, `ProjectRun`, and current attempts.
- Produces: `selectEligibleRunTasks(input): EligibleRunTask[]` and `planProjectRun(input): ProjectRunPlan`.
- Produces config: `projectRunMaxConcurrency`, default `4`, parsed from `MESH_PROJECT_RUN_MAX_CONCURRENCY` without touching billing variables.

- [ ] **Step 1: Write failing pure policy tests**

Cover ready/unblocked eligibility, current-attempt exclusion, rank/task-ID
ordering, policy/automation snapshots, capacity calculation including
`launch_pending`, and actions for running, paused, draining, and completed runs.

```ts
expect(
  selectEligibleRunTasks({ project, tasks, currentAttemptTaskIds: new Set() }).map(
    ({ task }) => task.id,
  ),
).toEqual(['lower-rank', 'same-rank-a', 'same-rank-b']);

expect(
  planProjectRun({ ...fixture, run: { ...run, state: 'paused' } }),
).toEqual({ type: 'wait', reason: 'run_paused' });
```

- [ ] **Step 2: Run policy tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/project-run-policy.spec.ts src/config.spec.ts`

Expected: FAIL because policy and configuration do not exist.

- [ ] **Step 3: Implement pure selectors and planner**

Keep policy synchronous and side-effect free. Return one explicit action at a
time so the runtime decides when to persist and invoke it.

```ts
export type ProjectRunPlan =
  | { type: 'claim'; itemId: string }
  | { type: 'complete'; reason: 'queue_finished' | 'stopped' }
  | { type: 'wait'; reason: 'at_capacity' | 'run_paused' | 'draining' };

export const occupiedSlots = (run: ProjectRun): number =>
  run.items.filter(({ status }) =>
    status === 'launch_pending' || status === 'active',
  ).length;
```

Validate concurrency in both the command schema and server config boundary;
the service must reject a command above the configured maximum.

- [ ] **Step 4: Run focused policy/config tests**

Run: `corepack pnpm nx test server -- --run src/tasks/project-run-policy.spec.ts src/config.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit scheduling policy**

```bash
git add apps/server/src/tasks/project-run-policy* apps/server/src/config*
git commit -m "feat(server): add project run policy"
```

---

### Task 4: Implement run authorization and operator controls

**Files:**

- Create: `apps/server/src/tasks/project-run-service.ts`
- Create: `apps/server/src/tasks/project-run-service.spec.ts`
- Modify: `apps/server/src/repositories/command-repository.ts`
- Modify: `packages/contracts/src/errors.ts`

**Interfaces:**

- Consumes repositories: projects, tasks, attempts, projectRuns, projectEvents, commands.
- Consumes publisher: `{ publishProject(event: ProjectEvent): void }`.
- Produces: `startRun`, `pauseRun`, `resumeRun`, `stopRun` returning `{ run, events }`.
- Produces stable errors: `project_run_conflict`, `project_run_empty`, `project_run_stale`, `project_run_concurrency_exceeded`, and `project_run_not_controllable`.

- [ ] **Step 1: Write failing service tests for Start Run**

Prove actor authority, empty rejection, one-active-run enforcement, configured
concurrency cap, atomic frozen membership, stable ordering, policy snapshots,
idempotent duplicate delivery, and no publication after audit failure.

```ts
const outcome = service.startRun({
  projectId,
  concurrency: 2,
  actor: human,
  idempotencyKey: 'start-run-1',
});
expect(outcome.run.items.map(({ taskId }) => taskId)).toEqual([
  'rank-a',
  'rank-b',
]);
expect(repositories.projectRuns.get(outcome.run.id)).toEqual(outcome.run);
expect(publisher.publishProject).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Write failing control tests**

Prove Pause is reversible, Resume revalidates project safety, Stop atomically
marks queued items `not_started`, active items remain active, stale revisions
fail, duplicate keys return original outcomes, and draining completes only when
occupied slots reach zero.

- [ ] **Step 3: Run service tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/project-run-service.spec.ts`

Expected: FAIL because `ProjectRunService` does not exist.

- [ ] **Step 4: Implement transactional commands**

Follow Developer/QA outcome ordering: reserve the command, validate current
truth, mutate run state and append `project.run_changed` in one database
transaction, complete the command, then publish.

```ts
export class ProjectRunService {
  startRun(input: StartProjectRunInput): ProjectRunCommandOutcome;
  pauseRun(input: ChangeProjectRunInput): ProjectRunCommandOutcome;
  resumeRun(input: ChangeProjectRunInput): ProjectRunCommandOutcome;
  stopRun(input: ChangeProjectRunInput): ProjectRunCommandOutcome;
}
```

Use `task.revision`, project QA policy revision, and
`task.reviewAutomation.generation` in each frozen item. Do not start work from
inside `startRun`; scheduling begins only after its transaction commits.

- [ ] **Step 5: Run focused service and repository tests**

Run: `corepack pnpm nx test server -- --run src/tasks/project-run-service.spec.ts src/repositories/project-run-repository.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit run commands**

```bash
git add apps/server/src/tasks/project-run-service* apps/server/src/repositories/command-repository.ts packages/contracts/src/errors.ts
git commit -m "feat(server): add project run controls"
```

---

### Task 5: Compose claims with initial Developer launch

**Files:**

- Modify: `apps/server/src/tasks/project-run-service.ts`
- Modify: `apps/server/src/tasks/project-run-service.spec.ts`
- Modify: `apps/server/src/tasks/attempt-service.ts`
- Modify: `apps/server/src/tasks/attempt-service.spec.ts`
- Modify: `packages/contracts/src/domain.ts`
- Test: `packages/contracts/src/contracts.spec.ts`

**Interfaces:**

- Consumes: `AttemptService.launchAttempt` and existing Developer cycle creation.
- Produces attempt source: `{ type: 'project_run'; runId: string; runItemId: string }`.
- Produces: `ProjectRunService.drainAvailableSlots(runId): Promise<ProjectRun>`.
- Produces system actor bound internally to the run/item; no caller-provided ownership IDs reach launch authority.

- [ ] **Step 1: Extend attempt-source tests and confirm RED**

```ts
expect(
  taskAttemptSourceSchema.parse({
    type: 'project_run',
    runId: 'run-1',
    runItemId: 'item-1',
  }),
).toEqual({ type: 'project_run', runId: 'run-1', runItemId: 'item-1' });
```

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: FAIL because the source variant is absent.

- [ ] **Step 2: Add the attempt-source variant**

Keep attempt provenance explicit and backward compatible. Export the inferred
type through the existing domain barrel.

- [ ] **Step 3: Write failing orchestration launch tests**

Cover claim-before-launch ordering, `launch_pending` capacity consumption,
successful attempt/session linking, startup failure as attention-required,
stale revision/manual launch races, duplicate drain calls, concurrency two,
Pause/Stop racing a drain, and audit failure preventing the next claim.

```ts
await Promise.all([
  service.drainAvailableSlots(run.id),
  service.drainAvailableSlots(run.id),
]);
expect(repositories.attempts.listByTask('task-a')).toHaveLength(1);
expect(repositories.attempts.listByTask('task-b')).toHaveLength(1);
expect(repositories.attempts.listByTask('task-c')).toHaveLength(0);
```

- [ ] **Step 4: Run launch tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/project-run-service.spec.ts src/tasks/attempt-service.spec.ts`

Expected: FAIL because run claims are not composed with attempt launch.

- [ ] **Step 5: Implement idempotent launch composition**

Re-read run/item/task after claiming and call `AttemptService.launchAttempt`
with `launchIdempotencyKey` and the bound project-run source. Link the existing
attempt/session on success. On a proven startup failure, terminalize only the
item; on an unknown outcome, pause the run.

```ts
async drainAvailableSlots(runId: string): Promise<ProjectRun> {
  for (;;) {
    const action = this.planCurrentRun(runId);
    if (action.type !== 'claim') return action.run;
    const claim = this.claimItem(action.itemId);
    await this.launchClaim(claim);
  }
}
```

Do not hold a database transaction open while starting a driver. Durable
`launch_pending` plus the attempt launch's idempotency key bridges the boundary.

- [ ] **Step 6: Run contracts, launch, and service tests**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: PASS.

Run: `corepack pnpm nx test server -- --run src/tasks/project-run-service.spec.ts src/tasks/attempt-service.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit launch composition**

```bash
git add packages/contracts/src apps/server/src/tasks/attempt-service* apps/server/src/tasks/project-run-service*
git commit -m "feat(server): launch project run items"
```

---

### Task 6: React to outcomes and reconcile restart state

**Files:**

- Create: `apps/server/src/tasks/reconcile-project-runs.ts`
- Create: `apps/server/src/tasks/reconcile-project-runs.spec.ts`
- Modify: `apps/server/src/tasks/project-run-service.ts`
- Modify: `apps/server/src/tasks/project-run-service.spec.ts`
- Modify: `apps/server/src/tasks/review-automation-service.ts`
- Modify: `apps/server/src/tasks/review-automation-service.spec.ts`
- Modify: `apps/server/src/tasks/reconcile-attempts.ts`
- Modify: `apps/server/src/tasks/reconcile-attempts.spec.ts`

**Interfaces:**

- Consumes committed task/Developer/QA/review-automation outcomes.
- Produces: `ProjectRunService.observeTaskOutcome(taskId): Promise<void>`.
- Produces: `reconcileProjectRuns(dependencies): ProjectRunReconciliationResult`.
- Produces repair reasons: `launch_outcome_unknown`, `capacity_ambiguous`, `repository_unsafe`, `audit_failed`, and `billing_conflict`.

- [ ] **Step 1: Write failing outcome-classification tests**

Cover autonomous `done` as completed; Developer blocker, manual review, third
QA rejection, and known isolated repair as attention-required; then prove each
released slot launches the next queued item. Verify unrelated task outcomes are
ignored.

```ts
await service.observeTaskOutcome(blockedTask.id);
expect(repositories.projectRuns.get(run.id)!.items).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      taskId: blockedTask.id,
      status: 'attention_required',
      outcomeReason: 'developer_blocked',
    }),
    expect.objectContaining({ taskId: nextTask.id, status: 'active' }),
  ]),
);
```

- [ ] **Step 2: Run outcome tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/project-run-service.spec.ts src/tasks/review-automation-service.spec.ts`

Expected: FAIL because run items do not observe committed outcomes.

- [ ] **Step 3: Implement post-commit observation hooks**

Call the observer only after Developer/QA/review-automation transactions commit.
The observer re-reads all durable truth; event payloads are triggers, not
authority. Publish the item outcome before calling `drainAvailableSlots`.

- [ ] **Step 4: Write failing startup reconciliation tests**

Cover proven active launch, proven absent launch effects, terminal task state,
known task-local repair, unknown launch result, inconsistent occupied count,
paused run, draining run, and duplicate startup reconciliation.

```ts
const result = reconcileProjectRuns(dependencies);
expect(result).toEqual({
  repairedItemIds: [],
  pausedRunIds: [run.id],
  launchableRunIds: [],
});
expect(repositories.projectRuns.get(run.id)).toMatchObject({ state: 'paused' });
```

- [ ] **Step 5: Run reconciliation tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/reconcile-project-runs.spec.ts src/tasks/reconcile-attempts.spec.ts`

Expected: FAIL because project-run reconciliation does not exist.

- [ ] **Step 6: Implement deterministic reconciliation**

Run attempt/session reconciliation first, then reconcile run items against the
resulting durable truth. Return run IDs that are safe to drain only after server
startup begins accepting internal scheduling work. Never expire claims by time
or infer success from a stopped process.

```ts
export type ProjectRunReconciliationResult = {
  repairedItemIds: string[];
  pausedRunIds: string[];
  launchableRunIds: string[];
};

export type ReconcileProjectRuns = (
  dependencies: ProjectRunReconciliationDependencies,
) => ProjectRunReconciliationResult;
```

- [ ] **Step 7: Run outcome and reconciliation tests**

Run: `corepack pnpm nx test server -- --run src/tasks/project-run-service.spec.ts src/tasks/review-automation-service.spec.ts src/tasks/reconcile-attempts.spec.ts src/tasks/reconcile-project-runs.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit outcome/restart handling**

```bash
git add apps/server/src/tasks
git commit -m "feat(server): reconcile project runs"
```

---

### Task 7: Wire commands, snapshots, events, and server startup

**Files:**

- Modify: `apps/server/src/http/command-handler.ts`
- Modify: `apps/server/src/http/command-handler.spec.ts`
- Modify: `apps/server/src/http/project-snapshots.ts`
- Modify: `apps/server/src/http/project-snapshots.spec.ts`
- Modify: `apps/server/src/http/routes.spec.ts`
- Modify: `apps/server/src/realtime/project-replay.spec.ts`
- Modify: `apps/server/src/realtime/socket-hub.spec.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.spec.ts`

**Interfaces:**

- Consumes: four run commands and `ProjectRunService`.
- Produces command results: `{ run: ProjectRun }`.
- Produces snapshots containing `runs`, `projectRunLimits`, and replay containing
  `project.run_changed`.
- Wires startup order: attempt reconciliation, run reconciliation, then safe drain scheduling.

- [ ] **Step 1: Write failing command-handler tests**

Test all four command variants, result/error mapping, expected revision, human
actor enforcement, duplicate idempotency keys, and Stop's drain semantics.

```ts
const response = await execute({
  type: 'project.run.start',
  payload: { projectId, concurrency: 2, actor: human },
});
expect(response.result).toEqual({
  run: expect.objectContaining({ projectId, concurrency: 2, state: 'running' }),
});
```

- [ ] **Step 2: Write failing snapshot/replay tests**

Seed two historical runs and one active run; assert complete ordered projection,
project isolation, replay cursor behavior, and gap/resync behavior.

- [ ] **Step 3: Run HTTP/realtime tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/project-snapshots.spec.ts src/http/routes.spec.ts src/realtime/project-replay.spec.ts src/realtime/socket-hub.spec.ts`

Expected: FAIL because transport does not expose project runs.

- [ ] **Step 4: Wire command and projection boundaries**

Add a narrow `executeProjectRunCommand` dispatcher beside QA/review automation.
Transport validates and maps errors only; lifecycle decisions stay in the
service. Snapshot assembly calls `projectRuns.listByProject(projectId)`.

```ts
type ProjectRunCommand = Extract<
  MutatingCommand,
  { type: `project.run.${string}` }
>;
```

- [ ] **Step 5: Write failing server-start tests**

Assert repository/service construction, reconciliation ordering, resumed drain
after successful startup, no drain while paused, correct draining completion,
and no command/socket acceptance after an audit-barrier failure.

- [ ] **Step 6: Run main tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/main.spec.ts`

Expected: FAIL because startup does not construct or reconcile run services.

- [ ] **Step 7: Wire repositories, services, and startup recovery**

Construct one `ProjectRunRepository` and `ProjectRunService`. Reconcile stopped
runtimes and attempts first, reconcile project runs second, then asynchronously
drain only returned `launchableRunIds`. Preserve the stop-accepting barrier.

- [ ] **Step 8: Run complete server tests**

Run: `corepack pnpm nx test server`

Expected: PASS with no external Claude traffic.

- [ ] **Step 9: Commit server composition**

```bash
git add apps/server/src/http apps/server/src/realtime apps/server/src/main.ts apps/server/src/main.spec.ts
git commit -m "feat(server): expose project runs"
```

---

### Task 8: Project runs in the web projection

**Files:**

- Modify: `apps/web/src/state/reducer.ts`
- Modify: `apps/web/src/state/reducer.spec.ts`
- Modify: `apps/web/src/state/selectors.ts`
- Modify: `apps/web/src/state/selectors.spec.ts`
- Modify: `apps/web/src/state/resync.spec.ts`
- Modify: `apps/web/src/api/client.spec.ts`
- Modify: `apps/web/src/api/socket.spec.ts`

**Interfaces:**

- Produces projection: `projectRunsById: Record<string, ProjectRun>`,
  `projectRunIdsByProjectId: Record<string, string[]>`, and
  `projectRunMaxConcurrencyByProjectId: Record<string, number>`.
- Produces selectors: `selectProjectRuns`, `selectActiveProjectRun`, and `selectEligibleRunPreview`.
- Consumes `project.run_changed` and `ProjectSnapshot.runs`.

- [ ] **Step 1: Write failing reducer and selector tests**

Cover initial projection, snapshot replacement isolated by project, event
upsert, event replay, completed history ordering, active-run selection, frozen
queue order, cursor gaps, and project removal.

```ts
const next = applyProjectEvent(state, runChangedEvent);
expect(next.state.projectRunsById[run.id]).toEqual(run);
expect(selectActiveProjectRun(next.state, projectId)?.id).toBe(run.id);
```

- [ ] **Step 2: Run web state tests and confirm RED**

Run: `corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/state/selectors.spec.ts src/state/resync.spec.ts`

Expected: FAIL because run projection fields and event handling are absent.

- [ ] **Step 3: Implement normalized run projection**

Follow the existing task/attempt replacement pattern. Replace only the target
project's runs during project resync and preserve every other project's state.
Upsert the complete aggregate on `project.run_changed`.

- [ ] **Step 4: Extend client/socket parsing tests**

Assert run-bearing snapshots and events pass the shared Zod contracts; malformed
run state must trigger existing invalid-payload/resync behavior.

- [ ] **Step 5: Run focused web state/API tests**

Run: `corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/state/selectors.spec.ts src/state/resync.spec.ts src/api/client.spec.ts src/api/socket.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit web projection**

```bash
git add apps/web/src/state apps/web/src/api
git commit -m "feat(web): project run projection"
```

---

### Task 9: Add the operator run panel

**Files:**

- Create: `apps/web/src/tasks/ProjectRunPanel.tsx`
- Create: `apps/web/src/tasks/ProjectRunPanel.spec.tsx`
- Modify: `apps/web/src/tasks/TaskBoard.tsx`
- Modify: `apps/web/src/tasks/TaskBoard.spec.tsx`
- Modify: `apps/web/src/app/app.tsx`
- Modify: `apps/web/src/app/app.spec.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Consumes: `Project`, `MeshProjection`, `connected`, and `(command: MutatingCommand) => Promise<unknown> | void`.
- Produces UI commands for Start, Pause, Resume, and Stop.
- Uses existing task selection callback to open attention evidence in `TaskDrawer`.

- [ ] **Step 1: Write failing Start Run UI tests**

Cover empty eligibility, frozen-order preview, manual/autonomous labels based on
effective project policy plus task automation state, concurrency default `1`,
server maximum, subscription warning, confirmation, disconnect/read-only state,
command payload, and server error feedback.

```tsx
await user.click(screen.getByRole('button', { name: 'Start run' }));
expect(screen.getByLabelText('Concurrency')).toHaveValue(1);
expect(screen.getByText('Ready task A')).toBeVisible();
await user.click(screen.getByRole('checkbox', { name: /subscription capacity/i }));
await user.click(screen.getByRole('button', { name: 'Authorize run' }));
expect(onCommand).toHaveBeenCalledWith({
  type: 'project.run.start',
  payload: { projectId, concurrency: 1, actor: operator },
});
```

- [ ] **Step 2: Write failing active/history UI tests**

Cover occupied capacity, queued/active/completed/attention/not-started rows,
role/cycle evidence, Pause/Resume/Stop visibility, Stop drain copy, stale-command
errors, attention links, project-wide repair messages, completed reason/counts,
and historical frozen order.

- [ ] **Step 3: Run component tests and confirm RED**

Run: `corepack pnpm nx test web -- --run src/tasks/ProjectRunPanel.spec.tsx src/tasks/TaskBoard.spec.tsx src/app/app.spec.tsx`

Expected: FAIL because the run panel is absent.

- [ ] **Step 4: Implement the focused panel**

Keep command-pending and form state local. Read lifecycle and capacity only from
the server projection. Render attention items as buttons that call
`onSelectTask(item.taskId)`. Do not optimistically mutate run state.

```tsx
export type ProjectRunPanelProps = {
  project: Project;
  projection: MeshProjection;
  connected: boolean;
  maxConcurrency: number;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onSelectTask: (taskId: string) => void;
};
```

Mount `ProjectRunPanel` above the task columns. Pass `maxConcurrency` from the
project snapshot's `projectRunLimits`; do not duplicate a magic number in the
client.

- [ ] **Step 5: Add accessible responsive styling**

Use existing task-board tokens and focus styles. At narrow widths, stack queue
rows and controls without hiding status, evidence links, or Stop drain copy.

- [ ] **Step 6: Run complete web tests**

Run: `corepack pnpm nx test web`

Expected: PASS.

- [ ] **Step 7: Commit the operator experience**

```bash
git add apps/web/src/tasks apps/web/src/app apps/web/src/styles.css
git commit -m "feat(web): add project run controls"
```

---

### Task 10: Prove the integrated path and update durable docs

**Files:**

- Modify: `e2e/fixtures/fake-claude.ts`
- Modify: `e2e/src/session-platform.spec.ts`
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/session-platform.md`

**Interfaces:**

- Consumes the complete HTTP, realtime, fake-driver, and browser path.
- Produces no new product interfaces.

- [ ] **Step 1: Extend the fake driver with deterministic per-task outcomes**

Add fixture controls keyed by task/session that can submit Developer completion,
report a blocker, submit QA verification/rejection, and hold one active session
until the test releases it. Keep every control in-process and subscription-free.

```ts
harness.queueTaskOutcome('task-auto', { developer: 'complete', qa: 'verified' });
harness.queueTaskOutcome('task-manual', { developer: 'complete' });
harness.queueTaskOutcome('task-blocked', { developer: 'blocked' });
```

- [ ] **Step 2: Write the failing orchestration E2E scenario**

Import a temporary repository, create at least five ready tasks, authorize
concurrency two, and assert:

- Two tasks launch and a third does not until capacity releases.
- An autonomous task reaches done.
- A manual task and blocked task become attention-required.
- Later queued work continues.
- Pause prevents another launch while active work finishes.
- Refresh and server restart preserve membership, order, occupancy, and history.
- Resume fills capacity from the same queue.
- Stop marks queued work not started and active work drains.
- No request uses an API billing environment.

- [ ] **Step 3: Run the scenario and confirm RED**

Run: `corepack pnpm e2e -- --grep "finite project run"`

Expected: FAIL before the complete integrated behavior is wired.

- [ ] **Step 4: Fix only integration gaps exposed by the E2E test**

Limit changes to wiring, selectors, fixture behavior, or copy already required by
the spec. Add focused regression tests beside any corrected owning module before
changing its implementation.

- [ ] **Step 5: Update durable documentation**

Document the concrete project-run service and event flow in architecture. In
session-platform guidance, explain finite authorization, concurrency,
Pause/Resume/Stop drain behavior, attention outcomes, restart recovery,
subscription confirmation, and that real-Claude smoke remains opt-in.

- [ ] **Step 6: Run focused E2E and full verification**

Run: `corepack pnpm e2e -- --grep "finite project run"`

Expected: PASS using the fake driver and temporary state.

Run: `corepack pnpm verify`

Expected: PASS for formatting, lint, type checking, unit/integration tests, and
the repository's normal CI-equivalent gates, with no real Claude traffic.

- [ ] **Step 7: Inspect the final diff and affected surfaces**

Run: `git diff --check origin/master...HEAD`

Expected: no output.

Run: `git status --short`

Expected: only the intended Task 10 files before commit.

Confirm contracts, commands, runtime, persistence, realtime, web, workspace
safety, operating modes, reverse states, and documentation match the approved
spec. Record any deliberately unverified real-Claude smoke test in the handoff.

- [ ] **Step 8: Commit integrated verification and docs**

```bash
git add e2e docs/development
git commit -m "test: verify project orchestration"
```
