# Mesh V2 Milestone 5 Finite Parallel Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator start one finite, dependency-closed run whose frozen Developer assignments execute in deterministic dependency-ready waves with bounded concurrency, durable pause/resume/stop controls, restart recovery, and Board visibility.

**Architecture:** Add one V2-native execution-run aggregate and repository. `ExecutionRunService` owns scheduling and run lifecycle, reuses M3 Board readiness, and delegates every task launch to M4 `DeveloperAttemptService.startFromRun`. SQLite transactions persist each run transition and its audit event before publication; restart reconciliation resumes proven work, retries proven-absent launches with the same idempotency key, and pauses ambiguity.

**Tech Stack:** TypeScript, Zod, Fastify, SQLite/better-sqlite3, React, Vitest, Nx, Playwright, deterministic fake harness.

**Spec:** [Mesh V2 Milestone 5: Finite Parallel Runs Design](../specs/2026-09-02-mesh-v2-milestone-5-finite-parallel-runs-design.md)

## Global Constraints

- Work only in `C:\code\mesh\.worktrees\v2-m05-finite-parallel-runs` on `campaign/v2-m05-finite-parallel-runs`.
- Never set or fall back to `ANTHROPIC_API_KEY`; every automated acceptance path uses the fake harness and temporary repositories/databases.
- Preserve M3 as the readiness authority and M4 as task-attempt, workspace, and execution authority.
- Persist run/item state plus the normalized domain event before publishing or launching the next external effect.
- Permit one nonterminal run per project, concurrency limits from 1 through 4, and require explicit subscription-capacity confirmation.
- Keep M6 QA/integration/merge/milestone-completion behavior out of scope.
- Use `NX_DAEMON=false` and `NX_SKIP_NX_CACHE=true` for verification commands.

---

## Task 1: Define the execution-run contracts

**Files:**

- Create: `packages/v2-contracts/src/execution-runs.ts`
- Modify: `packages/v2-contracts/src/ids.ts`
- Modify: `packages/v2-contracts/src/commands.ts`
- Modify: `packages/v2-contracts/src/events.ts`
- Modify: `packages/v2-contracts/src/http.ts`
- Modify: `packages/v2-contracts/src/board.ts`
- Modify: `packages/v2-contracts/src/executions.ts`
- Modify: `packages/v2-contracts/src/index.ts`
- Test: `packages/v2-contracts/src/contracts.spec.ts`

**Interfaces:**

- Consumes: approved delivery-plan task IDs and revisions, resolved Developer profile snapshots, repository identity/base commit, V2 command/event/snapshot conventions.
- Produces: `ExecutionRun`, `ExecutionRunItem`, start/control commands, `execution_run.changed`, snapshot history, and current Board run-item summaries.

- [ ] Add failing contract tests for valid run/item aggregates; cross-project, duplicate-item, invalid-count, invalid-concurrency, and invalid-lifecycle cases; all four command envelopes; event project coherence; and snapshot/Board projection.
- [ ] Run `corepack pnpm nx test v2-contracts --skip-nx-cache` and confirm the new tests fail because the schemas do not exist.
- [ ] Add branded UUID schemas for `executionRunId` and `executionRunItemId` in `ids.ts`.
- [ ] Implement `execution-runs.ts` with the exact finite state vocabulary and frozen authorization fields. Keep selection order explicit through `ordinal` and derive counts from items during validation.

```ts
export const executionRunLifecycleSchema = z.enum([
  'running',
  'paused',
  'stopping',
  'completed',
]);

export const executionRunItemLifecycleSchema = z.enum([
  'waiting',
  'launch_pending',
  'active',
  'completed',
  'attention_required',
  'not_started',
]);

export const executionRunItemSchema = z.strictObject({
  id: executionRunItemIdSchema,
  runId: executionRunIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  ordinal: nonNegativeIntegerSchema,
  revision: positiveIntegerSchema,
  lifecycle: executionRunItemLifecycleSchema,
  taskContractRevision: positiveIntegerSchema,
  taskCurrentRevision: positiveIntegerSchema,
  prerequisiteTaskIds: z.array(taskIdSchema).readonly(),
  profileSnapshot: resolvedWorkerProfileSnapshotSchema,
  launchIdempotencyKey: z.string().trim().min(1).max(256),
  developerAttemptId: developerAttemptIdSchema.nullable(),
  attention: executionRunAttentionSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
```

- [ ] Add `execution_run.start`, `.pause`, `.resume`, and `.stop` to the command union and envelope union. The start command carries the exact delivery-plan ID/revision, filter revision, selected task/profile revisions, concurrency limit, and `subscriptionCapacityConfirmed: z.literal(true)`.
- [ ] Add an `execution_run.changed` domain event whose payload contains `schemaVersion: 1`, the complete run, and the current run items. Extend project-coherence validation.
- [ ] Add `executionRuns` to `v2ProjectSnapshotSchema`. Add a nullable current-run summary to `boardTaskCardSchema`; server-produced M5 snapshots populate it while legacy persisted M3/M4 event payloads remain readable.
- [ ] Add run-specific error codes: not found, conflict, stale selection, dependency closure, incompatible profile, and ambiguous recovery.
- [ ] Export the new module from `index.ts`, run the focused contract tests, then run `corepack pnpm exec prettier --check packages/v2-contracts/src`.
- [ ] Commit: `feat(v2): define finite execution run contracts`

---

## Task 2: Persist runs, items, and their command/audit transitions

**Files:**

- Create: `apps/v2-server/src/db/migrations/007_execution_runs.sql`
- Modify: `apps/v2-server/src/db/migrate.ts`
- Modify: `apps/v2-server/src/db/database.spec.ts`
- Create: `apps/v2-server/src/runs/execution-run-repository.ts`
- Create: `apps/v2-server/src/runs/execution-run-repository.spec.ts`
- Modify: `apps/v2-server/src/test/create-v2-test-database.ts`

**Interfaces:**

- Consumes: `V2Database`, canonical JSON, `ExecutionRun`/`ExecutionRunItem`, command results, domain-event drafts.
- Produces: migration 7 and transaction-only repository mutations that reconstruct validated aggregates.

- [ ] Add failing migration tests for a fresh database, an upgraded migration-6 database, command-type CHECK support, the partial unique nonterminal-run constraint, foreign keys, and rejected malformed JSON/status rows.
- [ ] Add failing repository tests for create/read/list, optimistic revision updates, item transitions, deterministic ordering, and transaction enforcement.
- [ ] Run `corepack pnpm nx test v2-server --skip-nx-cache --testFile=database.spec.ts --testFile=execution-run-repository.spec.ts` and confirm the new cases fail.
- [ ] Add migration 7 and register it after `006_developer_start_reservations`.

```sql
CREATE TABLE execution_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('running','paused','stopping','completed')),
  completion_reason TEXT,
  aggregate_json TEXT NOT NULL CHECK (json_valid(aggregate_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_nonterminal_execution_run_per_project
ON execution_runs(project_id)
WHERE lifecycle <> 'completed';

CREATE TABLE execution_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('waiting','launch_pending','active','completed','attention_required','not_started')),
  aggregate_json TEXT NOT NULL CHECK (json_valid(aggregate_json)),
  UNIQUE(run_id, task_id),
  UNIQUE(run_id, ordinal)
);
```

- [ ] Extend the `command_results.command_type` rebuild pattern to accept the four run commands and preserve every existing row byte-for-byte at the logical schema level.
- [ ] Implement `ExecutionRunRepository` with prepared reads plus `createInTransaction` and compare-and-set update methods that reject use outside an active transaction.
- [ ] Parse every stored aggregate with the shared contract schemas and sort runs by `createdAt,id` and items by `ordinal,id`.
- [ ] Run the focused tests and `corepack pnpm nx test v2-server --skip-nx-cache --testFile=database.spec.ts`.
- [ ] Commit: `feat(v2): persist finite execution runs`

---

## Task 3: Reuse the M4 start boundary for run-owned launches

**Files:**

- Modify: `apps/v2-server/src/developer/developer-attempt-service.ts`
- Modify: `apps/v2-server/src/developer/developer-attempt-service.spec.ts`

**Interfaces:**

- Consumes: an internal `{ idempotencyKey, command }` containing the same validated `developer_attempt.start` command used by HTTP.
- Produces: `startFromRun` with identical readiness, profile, billing, workspace, audit, idempotency, and launch behavior; no run actor enters the public envelope schema.

- [ ] Add failing tests proving `startFromRun` creates the same frozen attempt as human start, replays by launch idempotency key, rejects stale/non-actionable tasks, rejects incompatible/unapproved profiles, and never weakens billing/workspace guards.
- [ ] Run the focused Developer service spec and confirm the new tests fail because `startFromRun` is absent.
- [ ] Extract only the post-envelope start path and route both entry points through it.

```ts
type InternalDeveloperStart = {
  idempotencyKey: string;
  command: StartDeveloperAttemptCommand;
};

async start(envelope: StartDeveloperAttemptEnvelope): Promise<V2CommandResult> {
  return this.startValidated({
    idempotencyKey: envelope.idempotencyKey,
    command: envelope.command,
  });
}

async startFromRun(input: InternalDeveloperStart): Promise<V2CommandResult> {
  return this.startValidated(input);
}
```

- [ ] Keep the existing reservation-first crash safety and command-result persistence unchanged beneath `startValidated`.
- [ ] Run the complete `developer-attempt-service.spec.ts` and commit: `refactor(v2): share developer attempt start boundary`

---

## Task 4: Implement deterministic finite scheduling and reconciliation

**Files:**

- Create: `apps/v2-server/src/runs/execution-run-service.ts`
- Create: `apps/v2-server/src/runs/execution-run-service.spec.ts`
- Create: `apps/v2-server/src/runs/reconcile-execution-runs.ts`
- Create: `apps/v2-server/src/runs/reconcile-execution-runs.spec.ts`

**Interfaces:**

- Consumes: planning snapshot/Board readiness, approved profiles, project repository identity/base commit, run repository, command/event stores, audit barrier, and `DeveloperAttemptService.startFromRun`.
- Produces: start/pause/resume/stop commands, deterministic `drain()`, attempt-settlement observation, and startup reconciliation decisions.

- [ ] Add failing service tests for dependency-closed selection, exact approved compatible profile revisions, one active run, explicit capacity confirmation, deterministic ordinal scheduling, concurrency 1–4, and `launch_pending + active` slot accounting.
- [ ] Add failing transition tests: pause blocks new launches; resume revalidates then drains; stop marks waiting items `not_started` and lets active attempts drain; completed prerequisites unlock dependents; task-local failure frees a slot while independent tasks continue; run completes only after all items are terminal.
- [ ] Add failing reconciliation tests: reconnect an item with a durable attempt, retry a proven-absent launch with the same key, and pause with `execution_run_recovery_ambiguous` when evidence is inconclusive.
- [ ] Run the two focused specs and confirm they fail.
- [ ] Implement start validation from one planning snapshot. Verify every selected task is current, pending, active, within the approved plan, and includes all unfinished prerequisites; resolve and freeze one approved compatible Developer profile per item.
- [ ] Persist the run, items, command result, and `execution_run.changed` event in one immediate transaction. Publish only after commit, then call `drain(run.id)`.
- [ ] Implement a project-keyed promise tail so commands, attempt callbacks, and recovery cannot schedule the same project concurrently.

```ts
private async drainLocked(runId: ExecutionRunId): Promise<void> {
  while (true) {
    const { run, items } = this.runs.requireAggregate(runId);
    if (run.lifecycle !== 'running') return;
    const occupied = items.filter(({ lifecycle }) =>
      lifecycle === 'launch_pending' || lifecycle === 'active',
    ).length;
    const candidate = items.find((item) =>
      item.lifecycle === 'waiting' &&
      item.prerequisiteTaskIds.every((taskId) =>
        items.some((other) =>
          other.taskId === taskId && other.lifecycle === 'completed',
        ),
      ),
    );
    if (!candidate || occupied >= run.concurrencyLimit) return;
    await this.launchReserved(candidate.id);
  }
}
```

- [ ] In `launchReserved`, commit `launch_pending` before calling M4; use the persisted launch key; then commit either `active` plus attempt ID or an item/run attention transition before publishing and continuing the drain.
- [ ] Map accepted Developer reports to `completed`; map blocked/malformed/missing-output/adapter failures to item `attention_required`; preserve independent scheduling when a slot is released.
- [ ] Implement pause/resume/stop with expected run revision and standard command idempotency. Resume rechecks project/plan/task/profile/repository invariants before returning to `running`.
- [ ] Implement startup reconciliation before command acceptance and make every ambiguity pause the run rather than guessing.
- [ ] Run both focused specs plus the Developer service spec and commit: `feat(v2): schedule finite parallel runs`

---

## Task 5: Wire HTTP commands, durable events, snapshots, and startup

**Files:**

- Modify: `apps/v2-server/src/http/routes.ts`
- Modify: `apps/v2-server/src/http/routes.spec.ts`
- Modify: `apps/v2-server/src/http/snapshots.ts`
- Modify: `apps/v2-server/src/main.ts`
- Modify: `apps/v2-server/src/main.spec.ts`

**Interfaces:**

- Consumes: run command envelopes/service, run repository, developer-attempt settlement callbacks.
- Produces: local-origin command routing, snapshot run history, decorated Board cards, recovery-before-acceptance, and durable replay publication.

- [ ] Add failing route tests for all four commands, origin rejection, error-status mapping, idempotent replay, and audit-barrier behavior.
- [ ] Add failing snapshot tests proving complete run history and current run-item summaries are emitted.
- [ ] Add failing composition tests proving execution and Developer recovery precede run reconciliation, recovery events publish before acceptance, and settlement triggers exactly one scheduling drain.
- [ ] Route `execution_run.*` commands through `ExecutionRunService`; like Developer starts, allow safe replay before the barrier check while rejecting any new mutation after the barrier trips.
- [ ] Construct the repository/service in `startV2Server`, attach the minimal mutable attempt observer, reconcile after executions and Developer attempts, then drain runnable runs before accepting commands.
- [ ] Add `runs.listForProject(projectId)` to snapshots and decorate Board cards from the sole current nonterminal run.
- [ ] Run route/main specs and commit: `feat(v2): expose finite execution runs`

---

## Task 6: Add Board run controls and live projection

**Files:**

- Modify: `apps/v2-web/src/state/reducer.ts`
- Modify: `apps/v2-web/src/state/reducer.spec.ts`
- Create: `apps/v2-web/src/components/ExecutionRunSection.tsx`
- Create: `apps/v2-web/src/components/ExecutionRunSection.spec.tsx`
- Modify: `apps/v2-web/src/components/BoardPane.tsx`
- Modify: `apps/v2-web/src/components/BoardPane.spec.tsx`
- Modify: `apps/v2-web/src/app/App.tsx`
- Modify: `apps/v2-web/src/app/App.spec.tsx`
- Modify: `apps/v2-web/src/styles.css`

**Interfaces:**

- Consumes: project snapshot run history, `execution_run.changed`, generic V2 command client, selected Board tasks, approved Developer profiles.
- Produces: start form, concurrency/capacity acknowledgement, pause/resume/stop actions, run counts/attention, and per-card run state.

- [ ] Add failing reducer tests that replace run history from snapshots and idempotently upsert a complete run aggregate from `execution_run.changed` without disturbing cursor rules.
- [ ] Add failing component tests for disabled start until the selection is dependency-closed and each task has one profile; concurrency bounds; explicit capacity checkbox; lifecycle counts; attention messages; and pause/resume/stop controls.
- [ ] Implement the reducer case by replacing the same run ID and sorting by `createdAt,id`; derive card badges from run items so older Board payloads cannot erase current run state.
- [ ] Implement one compact `ExecutionRunSection`; reuse `createV2Api().command`, existing Board card selection state, and existing profile options. Add no new state library or API wrapper.
- [ ] Make controls accessible by label, expose pending/errors beside the initiating control, and confirm irreversible Stop in the UI.
- [ ] Run `corepack pnpm nx test v2-web --skip-nx-cache` and commit: `feat(v2): control finite runs from board`

---

## Task 7: Prove the fake Todo acceptance path

**Files:**

- Modify: `apps/v2-server/src/executions/fake-harness.ts`
- Modify: `apps/v2-server/src/config.ts`
- Modify: `apps/v2-server/src/config.spec.ts`
- Modify: `e2e-v2/src/v2-foundation.spec.ts`

**Interfaces:**

- Consumes: test-only fake scenarios and hold controls, built V2 server/web, temporary Todo repositories/databases.
- Produces: observable proof of a two-worker wave, dependency wait, pause/resume, restart recovery, and stop/drain.

- [ ] Add only the deterministic fake controls needed to hold Developer attempts independently and identify task-specific completion. Reject them outside `NODE_ENV=test`.
- [ ] Extend the Todo fixture to provide frontend and backend tasks with one dependent integration task and compatible approved Developer profiles.
- [ ] Add a Playwright scenario that starts concurrency 2, observes frontend/backend active together, completes frontend, pauses while backend completes, proves the dependent remains waiting, restarts the server, resumes, and proves the dependent launches exactly once and the run completes.
- [ ] Add a separate scenario that starts a two-item run, stops it while one item is active, proves waiting work becomes `not_started`, releases the active attempt, and observes completion with the stopped/drained reason.
- [ ] Assert fake adapter request counts and durable snapshots before and after restart; never invoke a real adapter.
- [ ] Run `corepack pnpm nx e2e v2-e2e --skip-nx-cache` and commit: `test(v2): cover finite parallel run acceptance`

---

## Task 8: Update operations docs and run the completion gate

**Files:**

- Modify: `docs/development/architecture.md`
- Modify: `docs/development/v2-foundation.md`
- Modify: `docs/superpowers/specs/2026-09-02-mesh-v2-milestone-5-finite-parallel-runs-design.md`

**Interfaces:**

- Consumes: the implemented lifecycle, command, recovery, fake-acceptance, and exclusion behavior.
- Produces: current request/event-flow documentation and verification evidence.

- [ ] Document the run aggregate, scheduling authority, audit-before-publish boundary, pause/resume/stop semantics, restart reconciliation, Board projection, and fake-only acceptance command.
- [ ] Explicitly state that M5 does not perform QA, integration, merge, milestone completion, worktree cleanup, or real-Claude acceptance.
- [ ] Run focused tests for contracts, repository/service/reconciliation/routes/main, web, and V2 E2E.
- [ ] Run `corepack pnpm verify` with `NX_DAEMON=false` and `NX_SKIP_NX_CACHE=true`.
- [ ] Run `git diff --check`, inspect `git status --short`, and review the complete branch diff against every settled design decision and affected-surface checklist.
- [ ] Re-index the complete changed-path batch with jCodeMunch and the changed docs with jDocMunch; verify documentation links.
- [ ] Commit any final documentation-only correction as `docs(v2): document finite execution runs`.

## Stop Condition

Stop when the deterministic built-product acceptance proves two independent Todo tasks run concurrently at limit 2, their dependent task cannot launch before both accepted Developer outcomes, pause survives a predecessor completion and restart without launching new work, resume launches the dependent exactly once, and Stop prevents waiting work while draining already active work. Do not add M6 QA or integration behavior.
