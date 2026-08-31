# Mesh V2 Milestone 3: Planning and Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the smallest complete V2 slice in which a human revises and atomically approves a traceable multi-milestone delivery plan, then inspects deterministic server-owned readiness through a durable, filterable Board that survives replay, retained-gap resync, and restart.

**Architecture:** Extend the existing M2 `PlanningCycle` with a purpose sidecar and plan-specific immutable artifacts. Settle strict cross-process contracts first, then build canonical persistence and pure Board projection separately from the finite PM runtime and leaf UI. Compose those pieces through the existing command route, event store, snapshot, socket, reducer, and shell. Board readiness is a pure M3 domain projection; no execution, workspace, or scheduler object enters the slice.

**Tech Stack:** TypeScript 6, Zod 4, SQLite/`better-sqlite3`, Fastify, React 19, Vitest, Playwright, Nx, pnpm, and the existing V2 fake harness.

**Spec:** [`docs/superpowers/specs/2026-08-30-mesh-v2-milestone-3-planning-board-design.md`](../specs/2026-08-30-mesh-v2-milestone-3-planning-board-design.md)

## Global Constraints

- The frozen product base is exactly `0ad20dd25e48ef390469fd51d5ff85b0249e1acc`. The accepted design tip is exactly `3934975154a7b3370032c283eabdcc3677b8cd36`. Task M3-P00 imports the accepted planning lineage before any implementation branch exists.
- `PLAN_COMMIT` means the full commit SHA reported by the accepted `PLAN HANDOFF` for this document. It is a required campaign input, not an editable placeholder. M3-P00 must resolve it to 40 hexadecimal characters, prove it descends from the frozen base and accepted design tip, and record it as the exact planning head. No later packet may contain an unresolved symbolic prerequisite: the coordinator replaces each prerequisite receipt below with its exact accepted integration SHA before dispatch.
- Every worker starts from the exact full SHA in its packet, runs `git rev-parse HEAD` before editing, and does not fetch, rebase, merge, reset, clean, push, open a pull request, or remove a worktree. Only the coordinator/integrator performs the declared fast-forward planning import and accepted-commit integrations.
- Before editing, read `AGENTS.md`, the architecture, accepted design, manual parallel-development runbook, this plan's global/frozen-interface sections, and the assigned task section. Use repository-prescribed jCodeMunch and jDocMunch. Do not use historical V1 milestone-3 artifacts as authority.
- Change only the task's owned paths. All other tracked paths are prohibited. If a correct change needs another path or a frozen signature to change, stop and return `blocked`; do not make a convenience edit.
- Preserve operator branches, worktrees, processes, listeners, repositories, databases, credentials, and durable history. Never read, write, traverse for fixtures, or otherwise touch `C:\code\bloom`.
- Tests use fixture-owned temporary repositories and databases only. They may bind only loopback port `0` through the existing built-test seam and must retain exact PIDs/listeners for cleanup. They never target the operator database, a live worktree, or an already-running service.
- Never set, read, or fall back to `ANTHROPIC_API_KEY` or another paid API key. Do not launch real Claude, Codex, or external-agent traffic. The only M3 acceptance runtime is the explicit Todo fake under `NODE_ENV=test` and `MESH_V2_TEST_FAKE_PM_SCENARIO=todo`.
- Keep the V2 application identity and `MESH_V2_*` configuration boundary. V1 remains runnable and imports no V2 code; V2 imports no `@mesh-session-platform/contracts`, `apps/server`, `apps/web`, or `e2e` path.
- Append only `003_planning_board.sql`. `001_foundation.sql` and `002_intent_ledger.sql` are immutable. Preserve raw M1/M2 command-result JSON, event JSON, checksums, cursors, and idempotent replay bytes.
- Reuse the existing human command route, `BEGIN IMMEDIATE`, command repository, event store, runtime audit barrier, reservation-before-activation flow, snapshot route, domain/runtime cursors, socket protocol `mesh.v2/1`, resync path, finite execution model, and fake harness. Add no second route family, event store, Board-card table, polling loop, generic consumer framework, dependency, or speculative extension point.
- Persist the applicable command result and ordered event in the same transaction as each domain change; commit before publication. Raw runtime diagnostics precede normalized runtime publication. Audit persistence failure trips the existing barrier and publishes nothing.
- M3 product behavior stops at immutable planning, deterministic readiness, saved Board filtering, and projection. It must not create or allocate a workspace, `DeveloperAttempt`, execution loop, task claim, worker assignment, QA attempt, `ExecutionRun`, queue, scheduler, concurrency setting, product wave, or Start button. M4 owns workspace/task execution. M5 owns `ExecutionRun` scheduling, concurrency, and waves. The implementation waves in this document are human development coordination only.
- Apply Ponytail/YAGNI: extend the current V2 modules and create only the two cohesive plan/Board contract modules and one pure Board projector named below. A V1 helper may move only if it is provider-neutral, already has two real consumers, and does not import V1 types; otherwise write the small V2-local function.
- Use strict TDD for every non-trivial behavior: add the named failing assertion, run the focused red command and record the expected behavioral failure, implement the minimum, then rerun the same command green. A compile error caused solely by a deliberately not-yet-integrated frozen consumer is a recorded deferment, not the red proof.
- Before every worker, reviewer, rework, integration, or final command that invokes Nx or `pnpm verify`, set `$env:NX_DAEMON='false'` and `$env:NX_SKIP_NX_CACHE='true'` in that PowerShell process and record both values, `git rev-parse HEAD`, command, exit code, and concise result. Cached or daemon-backed output is not acceptance evidence.
- The coordinator runs the recurring state barrier defined below after every
  asynchronous probe, resume, interruption, review, rework, and integration
  result and before it authorizes another mutation or dispatch. The barrier is
  observational: it never fetches, rebases, merges, resets, cleans, removes a
  worktree, aborts an active Git operation, deletes a temp artifact, or kills a
  listener.
- No worker edits the accepted design, this plan, another worker handoff, campaign scratch state, or a different task's files. No worker delegates top-level ownership.

## Exact Outcome and Stop Condition

One exact integrated commit must prove all of these together:

- a nonempty approved M2 requirement ledger can start an exact-base `delivery_plan` cycle with a compatible `pm_plan` profile and one finite PM execution per turn;
- questions, attention retry, complete proposal revisions, revision feedback, rejection, and abandonment preserve the full M2 lifecycle/failure model, including `attention_required -> launch_pending` and runtime/report/terminal-reservation failures;
- human approval atomically creates or revises one canonical plan, multiple milestones, pending tasks, dependency revisions, exact requirement traces, a default saved filter, one ordered event, and one stored versioned command result, with no partial state at any injected failure boundary;
- immutable task contract anchors select the greatest guarded lifecycle revision; completion/reopen fixtures and dependency retire/reactivate fixtures deterministically reverse readiness without granting M3 completion authority;
- Board cards, complete details, facets, self-excluding counts, zero-count historical selections, filters across milestones, empty reasons, and `plan_stale` blockers are server-owned and deterministic;
- strict M2 persisted events and command results remain byte-valid. Ordered legacy events retain sequence authority, while sequence-less legacy command replay is receipt-only: it never replaces newer planning/filter state and requires snapshot resync when freshness is unknown;
- snapshots, ordered incremental replay, retained-gap resync, refresh, process restart, and fresh canonical reads converge byte-for-byte for the fake Todo scenario;
- planning and Board UI expose all designed loading, empty, stale, disconnected, submitting, success, reverse-transition, and error states accessibly; and
- V1 gates and the complete local verify remain green without external traffic or operator state.

If any proof requires an M4/M5 object or behavior, stop and return to planning. Do not widen M3.

## Frozen Interfaces

Task M3-T01 owns the strict schemas and exports. All later tasks consume these exact design-defined names and refinements and may not alter them:

- IDs in `ids.ts`: `deliveryPlanIdSchema`, `deliveryPlanProposalIdSchema`, `milestoneIdSchema`, `taskIdSchema`, and `taskDependencyIdSchema` plus inferred branded/string types following the existing V2 ID pattern.
- Plan contracts in new `delivery-plan.ts`: `PM_PLAN_REPORT_SCHEMA`, `PlanningCyclePurpose`, the purpose-aware `PlanningCycleView` union, `ProposalKey`, `PlanText`, `PlanLabel`, all proposal-local refs/members/traces, `ProposedDeliveryPlan`, `DeliveryPlanProposal`, `ApprovedDeliveryPlan`, milestone/task/dependency revision types, trace types, `TaskReadiness`, `TaskReadinessBlocker`, `PmPlanAssignment`, and `PmPlanReport` exactly as bounded/refined in the design.
- Board contracts in new `board.ts`: `BoardFilter`, `BoardFilterSelection`, all facet options, `BoardDependencySummary`, `BoardTaskDetail`, `BoardTaskCard`, and `BoardView`, including all bounds, canonical ordering refinements, counts, historical flags, and four empty reasons.
- Profiles/executions: sole assignment tuple `['pm_plan']`, exact output schema `mesh.dev/pm-plan-report/v1`, and `PmPlanAssignment` in the existing execution assignment union. No provider session/resume field.
- Commands: new strict human envelopes for `planning_cycle.submit_plan_turn`, `plan_proposal.approve`, `plan_proposal.reject`, and `board_filter.set`; purpose-aware reuse of `planning_cycle.abandon`; exact base/revision guards and typed failures from the design.
- Results: the exact `schemaVersion: 2` success alternatives for all four reused M2 planning commands and all four M3 commands; exact legacy M2 alternatives; exhaustive persisted/result unions; `NormalizedPlanningCommandSuccess`; `PlanningCommandResponseDisposition`; and pure raw decoder/normalizer semantics.
- Events: exact strict legacy alternatives; versioned `planning_cycle.changed` and `intent_ledger.approved`; new `delivery_plan.approved`, `board.filter_changed`, and `task.lifecycle_changed` payloads. Protocol remains `mesh.v2/1`.
- Snapshots: `V2ProjectSnapshot` adds `deliveryPlan: ApprovedDeliveryPlan | null` and `board: BoardView`; the existing planning history becomes purpose-aware.

Task M3-T02 freezes the only new server-internal seam consumed by M3-T05:

```ts
export type PlanningBoardSnapshot = Readonly<{
  planningCycles: readonly PlanningCycleView[];
  planningHistoryTruncated: boolean;
  intentLedger: ApprovedIntentLedger | null;
  deliveryPlan: ApprovedDeliveryPlan | null;
  board: BoardView;
}>;

export type BoardProjectionInput = Readonly<{
  projectId: ProjectId;
  intentLedger: ApprovedIntentLedger | null;
  deliveryPlan: ApprovedDeliveryPlan | null;
  currentTaskRevisions: readonly TaskRevision[];
  filter: BoardFilter | null;
}>;

export function projectBoard(input: BoardProjectionInput): BoardView;
```

`PlanningRepository.planningSnapshot(projectId)` returns `PlanningBoardSnapshot`. M3-T02 extends that existing repository with transaction-only delivery-cycle purpose/proposal/decision/ID-reservation/canonical-plan/filter/task-lifecycle writes and guarded reads; M3-T05 calls those methods only inside the existing service-owned immediate transaction. The exact method set is kept local to `PlanningRepository`, not wrapped in another repository or generic unit-of-work abstraction. M3-T02 records the final public method signatures in its handoff; acceptance freezes them before M3-T05 starts. The required behaviors are: exact purpose insert/read; exact proposal insert/read/settle; atomic canonical apply; complete current plan/filter read; guarded filter replacement; guarded lifecycle append for fixtures; and coherent `planningSnapshot` projection.

Projection rules are frozen: `currentTaskRevisions` contains exactly one
repository-selected greatest valid revision for each task contract anchored by
the current plan and no revision for an obsolete anchor. The projector rejects
missing, duplicate, contract-mismatched, or extra entries; it never performs a
"latest task" lookup. Cards use those exact operational revisions; milestone
dependencies derive from current active cross-milestone task edges; blockers
sort by dependency ID; cards sort by milestone ordinal, task ordinal, task ID;
facet counts omit their own field; label values sort by ascending Unicode code
point; selected disappeared milestone/requirement/label options stay bounded
with zero counts.

Consumers replace complete server projections. Only ordered legacy domain events may install their deterministic `planning_required` fallback at their sequence. A legacy command result normalizes to `legacy_m2/receipt_only`; a healthy continuous matching projection returns `acknowledge_legacy` without changing cycles, intent, plan, Board, filter, cursors, or truncation flags; missing/mismatched/stale/gapped freshness returns `resync_required` and installs no synthetic field.

## Dependency Waves and Deterministic Integration

Development-wave labels below are coordination metadata, never M5 product behavior.

| Wave | Concurrent tasks | Exact prerequisite receipt | Deterministic integration order | Gate before next wave |
| --- | --- | --- | --- | --- |
| P | M3-P00 only | frozen base + accepted design + `PLAN_COMMIT` | accepted planning lineage | planning import review |
| W0 | M3-T01 only | M3-P00 exact head | M3-T01 | contracts review and gate |
| W1 | M3-T02, M3-T03, M3-T04 (maximum safe concurrency: 3) | accepted W0 integration head | T02, T03, T04 | focused persistence/runtime/leaf-UI gate and integration review |
| W2 | M3-T05, M3-T06 (maximum safe concurrency: 2) | accepted W1 integration head | T05, T06 | full server/web gate and integration review |
| W3 | M3-T07 only | accepted W2 integration head | M3-T07 | built Todo, docs, full verify, integration review |
| Final | M3-FINAL only | accepted W3 integration head | no product commit unless reviewed rework requires one | independent milestone review |

No task begins until its exact prerequisite integration SHA has an accepted `INTEGRATION REVIEW HANDOFF`. Parallel tasks in one wave use the same exact base. Before each integration, compare `git diff --name-only <task-base>..<accepted-task-tip>` with ownership below. Any conflict among same-wave tasks proves an ownership violation; do not resolve it mechanically. Any cross-package contract change after W0 pauses every consumer and requires a plan-level decision.

An accepted task is its complete, linear, additive lineage from the exact task
base through the accepted tip, not only the tip commit. For every task, the
integrator must:

1. prove the recorded task base is an ancestor of the accepted tip, the tip
   commit/tree match the accepted review, no merge commit occurs in
   `task-base..accepted-tip`, and
   `git rev-list --reverse --topo-order --ancestry-path
   <task-base>..<accepted-tip>` yields the complete ordered source sequence;
2. record the source cumulative binary diff SHA-256, its `git patch-id
   --stable`, and exact `git diff --name-status` output before applying
   anything. Generate the canonical bytes with `git diff --binary --full-index
   --no-ext-diff --output=<campaign-owned-source.patch>
   <task-base>..<accepted-tip>`, hash that exact named file with PowerShell
   `Get-FileHash -Algorithm SHA256`, and pipe the same base..tip `git diff`
   output to `git patch-id --stable`;
3. use `git merge --ff-only <accepted-tip>` only when the current integration
   head equals the task base. This imports the whole lineage unchanged, so each
   source commit maps to itself and its existing tree;
4. otherwise apply **every** source commit, oldest first, with one
   `git cherry-pick --no-edit <source-commit>` per commit. After each pick,
   record the source commit and resulting integration commit/tree. Cherry-
   picking only the accepted tip is prohibited because it would omit the
   worker commit beneath additive rework;
5. stop on any conflict or unexpected active Git operation without editing the
   conflict, aborting the operation, or cleaning the worktree. Preserve it for
   the recurring coordinator barrier; a same-wave conflict invalidates the
   shared ownership invariant;
6. generate the integration before..after diff with the identical flags into a
   separately named campaign-owned patch file, then compare the two SHA-256
   values and stable patch IDs. Require exact `git diff --name-status`
   path/status equivalence and byte-equivalent task-owned blobs. For a fast-
   forward, also require the source and integration commit/tree to be
   identical; and
7. record the exact source-tip verification evidence and rerun the task's
   focused green gate on the cumulative integration head. If this plan
   explicitly defers that gate, record `deferred`, its exact reason, owner, and
   discharge wave rather than inventing a pass.

After the last task, the integrator records the wave base/head/tree, the ordered
source-to-integration commit/tree map, final `git diff --name-status`, exact
union of task-owned paths, cumulative diff SHA-256/stable patch evidence, and
the wave gate results. There may be no integration-only content. A patch,
name-status, path, blob, ordering, or tree mismatch is manual drift and blocks
the wave.

## Recurring Coordinator State Barrier

The coordinator records this barrier after every returned asynchronous probe,
resumed execution, interruption, task/integration/final review, additive
rework, and integration handoff. It runs before the result is acted on or
another task is dispatched. Repeated results each receive a new record; a prior
record is never reused.

The read-only inspection records:

- the frozen base, accepted design, accepted plan, current integration ref/head/
  tree, and every active campaign task/review/rework head/tree;
- the campaign-start `origin/master`, current local remote-tracking
  `origin/master`, and live remote master SHA from read-only `git ls-remote`
  when reachable, with their relation to the frozen base and prior barrier. A
  changed remote SHA is recorded as drift. If its object already exists
  locally, record the exact name-status diff; otherwise record
  `changed_uninspected`. Do not fetch, rebase, or merge it silently;
- all local `campaign/*` refs, local `refs/remotes/origin/campaign/*` refs, and
  live remote `campaign/*` refs from read-only `git ls-remote` when reachable;
- every worktree named in the campaign ledger or attached to a campaign ref,
  including path, ref/detached state, head/tree, ownership classification,
  porcelain-v2 dirty state, protected state, and active `MERGE_HEAD`,
  `CHERRY_PICK_HEAD`, `REBASE_HEAD`, rebase directory, sequencer, or bisect
  state. Operator-owned and ambiguous worktrees are protected and recorded but
  not traversed beyond the Git metadata needed to classify them; never inspect
  `C:\code\bloom`;
- only temp directories, databases, logs, and process artifacts already named
  in the campaign ledger, with exact path, owner, expected lifecycle, existence,
  and cleanup disposition. Do not discover or delete by pattern; and
- every campaign-named PID/listener and every listener on a campaign-assigned
  port, with address, port, PID, executable, redacted command line, expected
  owner/task, and `owned | unowned | ambiguous` verdict. Read no process
  environment and never kill by name, path, or port.

Every barrier returns exactly:

```text
COORDINATOR BARRIER RECORD
Barrier: <M3-Bnnn>
Trigger: asynchronous_probe | resume | interruption | task_review | integration_review | final_review | rework | integration
Observed at: <ISO timestamp>
Status: continue | task_hold | hard_stop
Frozen authority: <base, design, plan full SHAs and trees>
Origin/master drift: <campaign-start, local tracking, live remote SHAs; relation/diff or unavailable>
Integration authority: <ref, expected prior head/tree, observed head/tree>
Campaign heads:
- <task/review/rework/integration ID, ref, full head/tree, expected relation>
Campaign refs:
- <local, remote-tracking, and live-remote ref tables or explicit unavailable>
Relevant worktrees:
- <path, ref, head/tree, owner, dirty state, protected state, active Git operation or none>
Named temp artifacts:
- <name, exact path, owner, expected lifecycle, observed state, disposition>
Listeners:
- <address/port, PID, executable, redacted command line, expected owner, verdict>
Ambiguous state:
- <preserved item and affected task; or none>
Shared invariant decision: <valid, or exact invalidated invariant and evidence>
Permitted next action: <exact dispatch/integration/review, task-local hold, or none>
```

`origin/master` movement, a remote-probe outage, protected operator state, an
unrelated listener, or one task-local dirty/active worktree is not by itself a
campaign hard stop. Record drift, preserve ambiguity, and use `task_hold` for
only the affected task while independent work remains safe. Use `hard_stop`
only when evidence invalidates a shared invariant: frozen planning authority is
missing or rewritten; the shared integration head/tree was unexpectedly
rewritten; the shared integration worktree is dirty or mid-operation; accepted
lineage/patch/path equivalence fails; task ownership overlaps; or a prohibited
shared surface was changed. Never repair ambiguous state inside the barrier.
For this frozen-base campaign, this refines the runbook's generic base-drift
pause rule: later remote movement is observed drift, while missing or rewritten
frozen local authority is invalidation. Neither case authorizes a silent fetch,
rebase, or merge.

## Required Handoff and Review Protocol

Angle-bracket fields in these schemas are values the reporting agent must fill with repository evidence; they are not optional prose.

Every worker returns exactly:

```text
TASK HANDOFF
Task: <exact M3 task ID>
Execution: <worker/session ID>
Status: ready_for_review | blocked
Base: <full frozen task-base SHA>
Prerequisite commits: <ordered full SHAs>
Branch: <branch>
Worktree: <absolute path>
Commit: <full SHA or none>
Tree: <full tree SHA or none>
Changed paths:
- <exact owned path and purpose; or none>
Outcome: <one paragraph>
Acceptance evidence:
- <criterion and file/test evidence>
TDD evidence:
- RED: <exact command, expected behavioral failure, exit code>
- GREEN: <exact command, result, exit code>
Verification:
- <NX env values, tested HEAD, exact command, exit code, concise result>
Deferred compatibility gates:
- <exact command, reason, owner/wave; or none>
Assumptions:
- <item or none>
Unverified risks:
- <item or none>
Review focus:
- <highest-risk behavior>
```

Every task tip receives a fresh independent read-only review. The reviewer must not be the worker, must start without inherited implementation conclusions, and must independently read the accepted design/task packet and inspect the exact base-to-tip diff. It checks ownership, prohibited paths, frozen interfaces, acceptance criteria, TDD evidence, safety, compatibility, raw-history preservation, and overbuilding. A worker report is never acceptance.

```text
TASK REVIEW HANDOFF
Task: <exact M3 task ID>
Review: <M3 task ID-REVIEW-Rn>
Reviewer: <fresh independent reviewer/session ID>
Status: accepted | rework_required | blocked
Base: <full task-base SHA>
Reviewed commit: <full exact SHA>
Reviewed tree: <full tree SHA>
Diff and paths: <exact base..commit command/result and changed paths>
Findings:
- <severity, path:line, impact, required correction; or none>
Acceptance coverage:
- <each criterion: satisfied | unsatisfied | unverified, with evidence>
Ownership and exclusions: <satisfied | unsatisfied | unverified, with evidence>
Verification:
- <NX env values, tested HEAD, exact command, exit code, concise result>
Deferred compatibility gates:
- <origin, command, owner/wave, disposition; or none>
Residual risks:
- <item or none>
```

`accepted` applies only to the exact reviewed commit/tree. For `rework_required`, the coordinator sends every verified finding to the original worker. Rework never amends, rebases, squashes, or replaces accepted history; it adds one focused commit atop the rejected tip and returns:

```text
TASK REWORK HANDOFF
Task: <exact M3 task ID>
Rework: <M3 task ID-REWORK-Rn>
Execution: <original worker/session ID>
Status: ready_for_review | blocked
Base: <original task-base SHA>
Rejected commit: <full SHA>
Commit: <new additive full SHA or none>
Tree: <full tree SHA or none>
Changed paths:
- <exact owned paths; or none>
Finding dispositions:
- <finding ID, verified evidence, correction and tests>
TDD and verification:
- <NX env values, tested HEAD, exact red/green/gate commands and results>
Assumptions:
- <item or none>
Unverified risks:
- <item or none>
```

A different fresh reviewer reviews the exact additive tip. Prior acceptance evidence does not transfer. A task may integrate only after the latest exact tip is accepted.

Each wave integrator starts from its frozen integration base, applies only accepted task commits in the declared order, makes no conflict fix or opportunistic product edit, and returns:

```text
INTEGRATION HANDOFF
Wave: <P | W0 | W1 | W2 | W3>
Integration: <integrator/session ID>
Status: ready_for_review | blocked
Wave base: <full integration-base SHA and tree>
Pre-integration coordinator barrier: <record ID and continue status>
Deterministic task order:
- <ordinal, task ID>
Task lineage applications:
- Task: <exact task ID>
  Source task base: <full SHA and tree>
  Accepted tip: <full SHA and tree>
  Ordered source commits:
  - <ordinal, full source commit SHA and tree>
  Mechanism: ff-only | complete-lineage cherry-pick
  Integration before: <full SHA and tree>
  Resulting commit map:
  - <source commit/tree -> resulting integration commit/tree>
  Integration after: <full SHA and tree>
  Stable patch equivalence: <source and integrated stable patch IDs; equal | mismatch>
  Cumulative diff equivalence: <source and integrated binary-diff SHA-256; equal | mismatch>
  Name-status/path/blob equivalence: <exact commands/results>
  Source verification: <source tip, NX env, commands/results>
  Integrated verification disposition: rerun | deferred
  Integrated verification: <integration head, NX env, commands/results, or reason/owner/discharge wave>
Result commit: <full integration SHA>
Tree: <full tree SHA>
Changed paths:
- <exact combined paths>
Final cumulative proof:
- <wave base..head ordered task/commit map, binary-diff SHA-256/stable patch evidence, name-status, expected/actual path union, blob/tree and ordering result>
Conflict and ownership audit: <commands/results; no unexpected paths or active operation>
Frozen-interface audit: <satisfied | blocked, with evidence>
Verification:
- <NX env values, tested HEAD, exact commands, exit codes, concise results>
Deferred gates:
- <originating task, command, reason, discharge owner/wave; or none>
Assumptions:
- <item or none>
Unverified risks:
- <item or none>
Next dependency-ready tasks:
- <exact task IDs or none>
```

A fresh read-only integration reviewer who is neither a wave worker nor integrator verifies the exact head and returns the same evidence fields under `INTEGRATION REVIEW HANDOFF`, plus `Reviewer`, `Status: accepted | rework_required | blocked`, and file/line findings. The reviewer independently reconstructs every `task-base..accepted-tip` source sequence, proves each complete source lineage was imported in declared order, and repeats the cumulative patch/name-status/path/blob checks. On rework, route task-owned defects to the original worker as additive commits, restart wave integration from the frozen wave base, integrate every newly accepted complete lineage in declared order, rerun the entire wave gate on the new head, and use another fresh reviewer. Reusing or manually editing the rejected integration worktree is forbidden.

The coordinator runs and records the recurring barrier immediately after every
task/rework review and integration/review handoff. The pre-integration barrier
record is an input to `INTEGRATION HANDOFF`; the post-result record remains a
separate campaign-ledger receipt so the reporting agent cannot assert the
coordinator's later observation.

## Task M3-P00: Import Accepted Planning Lineage

**Purpose:** Make the frozen design and this accepted plan the only planning authority on the implementation integration branch before product work.

**Owned files:** none; coordinator Git metadata only.

**Prohibited:** product edits, documentation edits, cherry-pick conflict resolution, rebase, push, PR, and every operator-owned branch/worktree/process.

**Prerequisites:** base `0ad20dd25e48ef390469fd51d5ff85b0249e1acc`; accepted design commits `6dc265047ef9d88797e4c0528ea541c7e8a6cb6a`, `1308f830b1706e1d1a6b3c4d1f6daac0c4276245`, `59c4c8c75b9900118eff5dcfedf7addcaf5f4659`, `3934975154a7b3370032c283eabdcc3677b8cd36`; exact `PLAN_COMMIT` from the plan handoff.

- [ ] Verify the current integration branch is exactly the frozen base and clean. Resolve `PLAN_COMMIT`; prove `git merge-base --is-ancestor 3934975154a7b3370032c283eabdcc3677b8cd36 $env:M3_PLAN_COMMIT` and `git merge-base --is-ancestor 0ad20dd25e48ef390469fd51d5ff85b0249e1acc $env:M3_PLAN_COMMIT` both exit 0.
- [ ] Run `git diff --name-only 0ad20dd25e48ef390469fd51d5ff85b0249e1acc..$env:M3_PLAN_COMMIT`. The exact set must be only the accepted design and this plan. Stop on anything else.
- [ ] Import with a fast-forward only operation so the exact accepted commit IDs remain unchanged. Verify the resulting `HEAD` equals `PLAN_COMMIT`; do not cherry-pick, merge-commit, or rewrite the planning lineage.
- [ ] Run `git diff --check 0ad20dd25e48ef390469fd51d5ff85b0249e1acc..HEAD`, verify both planning links resolve, and record the full result tree.
- [ ] Return an `INTEGRATION HANDOFF` for Wave P. A fresh exact-head reviewer must accept it before M3-T01 starts.

**Acceptance:** exact planning lineage, exactly two changed documentation paths from frozen base, clean tree, no product change, full base/design/plan ancestry proof.

## Task M3-T01: Strict Planning and Board Contracts

**Purpose:** Freeze every cross-process type, bound, decoder, result, event, and snapshot shape before any consumer proceeds.

**Prerequisite:** exact accepted Wave P integration SHA.

**Owned files:**

- `packages/v2-contracts/src/ids.ts`
- `packages/v2-contracts/src/delivery-plan.ts` (new)
- `packages/v2-contracts/src/board.ts` (new)
- `packages/v2-contracts/src/intent.ts`
- `packages/v2-contracts/src/profiles.ts`
- `packages/v2-contracts/src/executions.ts`
- `packages/v2-contracts/src/commands.ts`
- `packages/v2-contracts/src/events.ts`
- `packages/v2-contracts/src/http.ts`
- `packages/v2-contracts/src/index.ts`
- `packages/v2-contracts/src/contracts.spec.ts`
- `packages/v2-contracts/src/planning-board.spec.ts` (new)

**Prohibited:** every server/web/E2E/docs file; protocol bump; M4/M5 types; V1 imports; migration or persistence code.

**Consumes:** accepted design's exact strict types and refinements.

**Produces:** the frozen interfaces listed above. Later tasks may import them but may not change them.

- [ ] Add contract fixtures and failing assertions for every new ID, purpose-aware cycle view, proposal/report/member/ref/trace bound, task contract/current anchor, dependency revision, Board/filter/detail/facet shape, empty reason, command/envelope/failure, result/event alternative, and snapshot field. Include negative fixtures for unknown fields/versions, purpose mismatches, invalid bases, dangling proposal refs, duplicate keys, incomplete traces, out-of-bound arrays/text, and forbidden workspace/run/attempt fields.
- [ ] Add byte-shaped seeded M2 event/result fixtures. First prove the old unversioned alternatives parse exactly and extra M3 fields fail; prove all new writes require their specified schema version.
- [ ] Run the red gate:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm nx test v2-contracts
  ```

  Expected failure: missing plan/Board schemas and new discriminants, not a fixture syntax error.
- [ ] Implement only the two cohesive new contract modules and the minimal extensions to existing schemas/exports. Preserve the exact M2 raw decoder branches. Make `normalizePlanningCommandSuccess` pure and retain its `source`/`projectionAuthority` tag through response disposition.
- [ ] Prove the four legacy/versioned reused-command pairs, all M3 successes, exact refinements, exhaustive unions, and legacy `receipt_only` behavior. Prove the deterministic ordered-event `planning_required` fallback is distinct from command-response authority.
- [ ] Run green and local compatibility gates:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm nx test v2-contracts
  corepack pnpm nx typecheck v2-contracts
  corepack pnpm nx build v2-contracts
  git diff --check
  ```

- [ ] Commit only owned paths with `feat(v2-contracts): add planning board contracts` and return `TASK HANDOFF`.

**Acceptance:** every design contract parses strictly; bounds/order/coherence are executable; seeded M2 payloads/results remain valid without rewriting; new writes are versioned; no provider/workspace/attempt/run/scheduler field exists. Downstream server/web typechecks may be recorded as W2 deferments because their exhaustive consumers intentionally update later.

## Task M3-T02: Migration, Immutable Plan Persistence, and Board Projection

**Purpose:** Add one forward migration, immutable plan history, contract-anchored lifecycle selection, saved filters, and the pure deterministic Board projection without HTTP/runtime composition.

**Prerequisite:** exact accepted W0 integration SHA containing M3-T01.

**Owned files:**

- `apps/v2-server/src/db/migrations/003_planning_board.sql` (new)
- `apps/v2-server/src/db/migrate.ts`
- `apps/v2-server/src/db/database.spec.ts`
- `apps/v2-server/src/test/create-v2-test-database.ts`
- `apps/v2-server/src/planning/planning-repository.ts`
- `apps/v2-server/src/planning/planning-repository.spec.ts`
- `apps/v2-server/src/planning/planning-board.ts` (new)
- `apps/v2-server/src/planning/planning-board.spec.ts` (new)
- `apps/v2-server/src/storage/event-store.spec.ts`

**Prohibited:** `planning-service*`, runtime/fake files, routes/snapshots/main, web/E2E/docs, prior migrations, contract files, and any Board-card cache.

**Consumes:** W0 contracts and existing M2 `PlanningRepository`, migration ledger, event store, canonical JSON, and test database fixture.

**Produces:** `PlanningBoardSnapshot`, `BoardProjectionInput`, `projectBoard`, and the transaction/read method set on `PlanningRepository` described under Frozen Interfaces.

- [ ] Seed an exact nonempty migration-2 database with M1/M2 commands, all four M2 planning result forms, intent cycles/proposals/receipts, approved ledger, strict legacy domain/runtime events, checksums, and cursors. Add failing upgrade/rollback assertions for sidecar backfill, raw byte preservation, command-table rebuild rollback, and restart reads.
- [ ] Add failing repository tests for immutable proposal revisions and decisions, ID reservations without canonical materialization, `cycle_abandoned` null successor, canonical plan/milestone/task/dependency revisions and memberships, exact traces, saved filters, historical selections, and task contract/lifecycle guards.
- [ ] Add failing pure-domain tests for proposal preview, current/stale plan, retired milestone/task, completed task, zero/one/multiple prerequisites, completion/reopen, dependency retirement/reactivation, replan reuse/revise anchor behavior, obsolete-anchor conflict, derived cross-milestone dependencies, card/detail ordering, all empty reasons, self-excluding facet counts, and selected disappeared milestone/requirement/label options with exact bounds/order.
- [ ] Run the red gate:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.spec.ts apps/v2-server/src/planning/planning-board.spec.ts apps/v2-server/src/storage/event-store.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected failure: migration 3/repository/projector behavior is absent.
- [ ] Implement `003_planning_board.sql` exactly as the design: purpose sidecar/backfill, proposal/member/trace/decision/reservation tables, canonical stable identities and immutable revisions, exact plan memberships/traces, task contract anchors and operational revisions, dependency history, and one revisioned filter per project. Rebuild only `command_results` inside the outer immediate migration transaction; copy raw rows unchanged.
- [ ] Extend the existing repository rather than adding another repository/unit-of-work layer. Enforce same-project/revision FKs and startup integrity; canonicalize JSON; fail closed on missing sidecars, malformed graphs, orphan decisions, invalid anchors, or impossible current revision selection.
- [ ] Implement the pure `projectBoard` calculation. It reads no time/process/profile/workspace/run state and contains no completion authority; repository fixtures may append guarded operational revisions solely to prove future-event projection semantics.
- [ ] Inject failure at migration rebuild and representative canonical approval write boundaries. Prove exact rollback, no partial canonical/filter/event state, and unchanged M2 replay bytes/checksums across reopen.
- [ ] Run green:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.spec.ts apps/v2-server/src/planning/planning-board.spec.ts apps/v2-server/src/storage/event-store.spec.ts --config apps/v2-server/vitest.config.ts
  git diff --check
  ```

- [ ] Record the exact new/extended public `PlanningRepository` signatures in the handoff, commit only owned files with `feat(v2-server): persist planning board state`, and return `TASK HANDOFF`.

**Acceptance:** fresh and exact-M2 upgrade/restart pass; rollback restores exact migration-2 schema/data/indexes/ledger; raw legacy bytes/checksums/replay remain stable; immutable history and guards reject corruption/stale writes; Board/readiness/filter/detail output is deterministic and bounded; no server transport/runtime behavior is added. Full server typecheck is deferred to M3-T05 after exhaustive consumers update.

## Task M3-T03: Finite Plan Runtime and Todo Fake Reports

**Purpose:** Let the existing execution substrate carry one finite `pm_plan` assignment and deterministic strict Todo plan output without canonical plan authority.

**Prerequisite:** exact accepted W0 integration SHA containing M3-T01.

**Owned files:**

- `apps/v2-server/src/config.ts`
- `apps/v2-server/src/config.spec.ts`
- `apps/v2-server/src/executions/execution-runtime.ts`
- `apps/v2-server/src/executions/execution-runtime.spec.ts`
- `apps/v2-server/src/executions/fake-harness.ts`
- `apps/v2-server/src/executions/fake-harness.spec.ts`

**Prohibited:** planning repository/service/report-consumer/runtime, DB/migrations, HTTP/main, web/E2E/docs, contracts, real adapter behavior, provider resume state, and generic output routing.

**Consumes:** `PmPlanAssignment`, `PmPlanReport`, existing reservation/activation/structured-output machinery, and existing `MESH_V2_TEST_FAKE_PM_SCENARIO=todo` test-only gate.

**Produces:** exact `pm_plan` capability/assignment passage through `ExecutionRuntime` and deterministic fake report scripts for initial proposal, revision, malformed/missing-output/failure paths, without interpreting or approving the report.

- [ ] Add failing tests showing `pm_plan` uses one finite execution, does not resume, preserves bind-before-activation and raw-diagnostic-before-runtime-event ordering, accepts only the exact schema, and keeps same/different digest receipt inputs distinct for the later consumer.
- [ ] Extend Todo fake fixtures with deterministic plan revision 1 and revision 2 output: two milestones, three tasks, two cross-milestone dependencies, complete requirement traces, and the exact keyboard/persistence revision requested by the design. Add invalid, absent, runtime-failure, and terminal-without-accepted-output variants.
- [ ] Prove fake configuration remains rejected unless `NODE_ENV=test`, only value `todo` is allowed, port `0` remains test-only, and foundation/`pm_discovery` scripts are unchanged.
- [ ] Run red:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-server/src/config.spec.ts apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected failure: `pm_plan` fake/capability behavior is absent.
- [ ] Implement the smallest assignment-specific branches. Reuse the current finite session and event pipeline; add no new consumer registry, execution lifecycle, native handle semantics, or background loop.
- [ ] Run the same command green, then `git diff --check` with both Nx environment variables and exact HEAD recorded.
- [ ] Commit only owned paths with `feat(v2-server): add fake plan execution reports` and return `TASK HANDOFF`.

**Acceptance:** deterministic strict fake plan reports exist only in test mode; all M2 fake/runtime behavior remains green; no canonical plan/filter/Board mutation, real traffic, or persistent session is introduced.

## Task M3-T04: Delivery Planning and Board Leaf Views

**Purpose:** Build accessible presentational planning/Board views against frozen server-owned contracts without owning transport or application state.

**Prerequisite:** exact accepted W0 integration SHA containing M3-T01.

**Owned files:**

- `apps/v2-web/src/components/PlanningPane.tsx`
- `apps/v2-web/src/components/PlanningPane.spec.tsx`
- `apps/v2-web/src/components/BoardPane.tsx` (new)
- `apps/v2-web/src/components/BoardPane.spec.tsx` (new)
- `apps/v2-web/src/components/planning-board.css` (new)

**Prohibited:** `App*`, `FocusedProjectShell*`, API/state/resync/store, server/contracts/E2E/docs, readiness/filter calculation, and one-pane-per-task behavior.

**Consumes:** purpose-aware cycles, proposals, approved plan, `BoardView`, compatible profile summaries, mutation availability, and callback props. It treats every Board field/count/blocker/detail as server truth.

**Produces:** presentational callbacks for exact start/continue/approve/revision/reject/abandon/filter payload inputs, plus accessible Board/filter/task-detail rendering.

- [ ] Add failing component tests for compatible `pm_plan` profile selection, disabled no-profile and empty-requirement states, exact initial/replan/stale/continue message forms, proposal revision history and abandonment text, required rejection feedback, and control availability for every lifecycle including attention retry and terminal replacement path.
- [ ] Add failing Board tests for loading, intent required, planning required, stale, plan empty, filter empty, disconnected/stale/submitting, command failure, normal cards, milestone-spanning filters, self-excluding counts, selected historical labels with “historical, 0 tasks,” named dependency blockers, trace/detail/stop-condition context, and no Start control.
- [ ] Add keyboard/accessibility tests for `fieldset`/`legend`, labels, live errors/result counts, non-color status, focus return after errors, task-detail open/close focus, and retained shell tab semantics at the component boundary.
- [ ] Run red:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/BoardPane.spec.tsx --config apps/v2-web/vite.config.ts
  ```

  Expected failure: delivery-plan proposal/Board views are absent.
- [ ] Implement controlled presentational components only. Keep unsent messages, filter draft, rejection text, and selected task detail local; emit complete guarded commands through callbacks and await returned server projections. Do not duplicate readiness, facet counts, historical-option recovery, or filter matching.
- [ ] Run the same command green and `git diff --check`. Record full web typecheck/build as deferred to M3-T06 because existing state/shell consumers update there.
- [ ] Commit only owned paths with `feat(v2-web): add planning board views` and return `TASK HANDOFF`.

**Acceptance:** every designed UI state/control/accessibility rule has a focused test; exact payload inputs are exposed; cards/details/filters are server-owned; no transport/state composition or execution UI appears.

## Wave W1 Integration Gate

Integrate accepted M3-T02, M3-T03, then M3-T04 onto the exact accepted W0 head. Any same-wave conflict is blocking. Run:

```powershell
$env:NX_DAEMON='false'
$env:NX_SKIP_NX_CACHE='true'
git rev-parse HEAD
corepack pnpm nx test v2-contracts
corepack pnpm exec vitest run apps/v2-server/src/db/database.spec.ts apps/v2-server/src/planning/planning-repository.spec.ts apps/v2-server/src/planning/planning-board.spec.ts apps/v2-server/src/storage/event-store.spec.ts apps/v2-server/src/config.spec.ts apps/v2-server/src/executions/fake-harness.spec.ts apps/v2-server/src/executions/execution-runtime.spec.ts --config apps/v2-server/vitest.config.ts
corepack pnpm exec vitest run apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/BoardPane.spec.tsx --config apps/v2-web/vite.config.ts
git diff --check
```

Record server/web full typecheck/build as exact W2 deferments, not passes. Obtain an accepted fresh `INTEGRATION REVIEW HANDOFF` before M3-T05/M3-T06.

## Task M3-T05: Planning Service, Atomic Approval, Events, and Server Composition

**Purpose:** Compose frozen contracts, persistence/projector, and finite runtime through the existing service, command route, snapshot, event, restart, and audit boundaries.

**Prerequisite:** exact accepted W1 integration SHA and the frozen repository signatures from the accepted M3-T02 handoff.

**Owned files:**

- `apps/v2-server/src/planning/planning-service.ts`
- `apps/v2-server/src/planning/planning-service.spec.ts`
- `apps/v2-server/src/planning/pm-report-consumer.ts`
- `apps/v2-server/src/planning/pm-report-consumer.spec.ts`
- `apps/v2-server/src/planning/planning-runtime.ts`
- `apps/v2-server/src/planning/planning-runtime.spec.ts`
- `apps/v2-server/src/http/routes.ts`
- `apps/v2-server/src/http/routes.spec.ts`
- `apps/v2-server/src/http/snapshots.ts`
- `apps/v2-server/src/main.ts`
- `apps/v2-server/src/main.spec.ts`

**Prohibited:** repository/migration/projector, execution runtime/fake, contracts, web/E2E/docs, new endpoint/event store, task completion command, and M4/M5 behavior.

**Consumes:** exact W0 contracts, M3-T02 repository/projector seam, existing `PlanningService` launch coordinator, `PmReportConsumer`, `createPlanningRuntime`, HTTP app, snapshot composition, event store, publisher, and central `AuditBarrier`.

**Produces:** the four M3 commands, purpose-aware M2 reuse, strict plan report consumption, atomic approval/filter/abandon service semantics, versioned events/results, coherent snapshots, and restart order.

- [ ] Add failing service tests for nonempty-requirement start precedence/audited no-domain-write failure, exact bases/profile compatibility, new/continue turns, questions, proposal revisions, revision feedback, rejection, abandonment with/without pending proposal, full M2 attention/failure/retry transitions, limits, and stale distinct commands versus same-key replay.
- [ ] Add failing report-consumer tests for strict binding/schema/revision/digest validation, accepted/rejected receipts, invalid/missing output attention, runtime/terminal-reservation attention, pre-reservation no-write retry, proposal supersession, and diagnostic/audit ordering.
- [ ] Add atomic approval tests for complete multi-milestone canonical materialization, traces/DAG/member guards, default filter/Board, command result/event, and injected failure before/after every repository/event/command write. Assert no partial rows or publication and a tripped barrier where audit persistence fails.
- [ ] Add route/snapshot/main tests for all exact command status mappings, purpose-aware abandon, intent approval Board replacement/staleness, filter idempotency/conflict, complete Board snapshots, ordered publication, recovery of unconsumed plan output, bound-cycle reconciliation before attachment/drain/commands, and corruption fail-closed behavior.
- [ ] Seed strict legacy M2 rows and prove migration/start/replay/restart parse them without byte mutation. Repost an old idempotency key after an M3 plan/filter exists: response bytes remain exact, no event is appended, and the server exposes it as tagged receipt-only rather than a new authoritative projection.
- [ ] Run red:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-server/src/planning/planning-service.spec.ts apps/v2-server/src/planning/pm-report-consumer.spec.ts apps/v2-server/src/planning/planning-runtime.spec.ts apps/v2-server/src/http/routes.spec.ts apps/v2-server/src/main.spec.ts --config apps/v2-server/vitest.config.ts
  ```

  Expected failure: service/transport composition lacks M3 behavior.
- [ ] Implement assignment-specific service branches while preserving the M2 launch coordinator and cleanup-first, commit-last abandon path. A new cycle performs the approved-requirement gate after exact guarded ledger load and before cycle/turn/assignment/reservation/event writes; only its stored command-failure receipt is durable.
- [ ] In approval/filter/intent-drift operations, call the Board projector inside the same immediate transaction after domain rows and before event/result. Commit, then publish. Do not add an event observer or eventually consistent Board updater.
- [ ] Preserve startup order from the design: migrate, reconcile operations, consume durable structured output, reconcile bound cycles/reservations, publish recovery window, attach recovered sessions, drain never-reserved turns, accept commands.
- [ ] Run green and server gates:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm nx test v2-server
  corepack pnpm nx typecheck v2-server
  corepack pnpm nx build v2-server
  git diff --check
  ```

- [ ] Commit only owned paths with `feat(v2-server): compose planning board flow` and return `TASK HANDOFF`.

**Acceptance:** complete lifecycle/retry/reverse behavior; exact audited empty-ledger failure; strict report receipt handling; atomic human approval/filter/abandon; event/result compatibility; snapshot/replay/restart convergence; audit-before-publish; no task completion authority or execution scheduling.

## Task M3-T06: Monotonic Web Projection and Shell Composition

**Purpose:** Connect the leaf UI to complete server projections while making command-response application monotonic and stale-safe.

**Prerequisite:** exact accepted W1 integration SHA containing M3-T04. This task may run concurrently with M3-T05 because it consumes the frozen W0 wire contract rather than server implementation files.

**Owned files:**

- `apps/v2-web/src/api/client.ts`
- `apps/v2-web/src/api/client.spec.ts`
- `apps/v2-web/src/state/reducer.ts`
- `apps/v2-web/src/state/reducer.spec.ts`
- `apps/v2-web/src/state/resync.ts`
- `apps/v2-web/src/state/resync.spec.ts`
- `apps/v2-web/src/state/store.ts`
- `apps/v2-web/src/app/use-project-connection.ts`
- `apps/v2-web/src/app/use-project-connection.spec.tsx`
- `apps/v2-web/src/app/App.tsx`
- `apps/v2-web/src/app/App.spec.tsx`
- `apps/v2-web/src/components/FocusedProjectShell.tsx`
- `apps/v2-web/src/components/FocusedProjectShell.spec.tsx`
- `apps/v2-web/src/components/shell-state.ts`
- `apps/v2-web/src/styles.css`

**Prohibited:** leaf `PlanningPane`/`BoardPane`, server/contracts/E2E/docs, client readiness/filter/count calculations, polling, and execution controls.

**Consumes:** frozen command/result/event/snapshot contracts and the M3-T04 controlled component callbacks.

**Produces:** exact API calls, complete projection replacement, ordered event handling, legacy command-result disposition, resync, mutation availability, and accessible Board tab composition.

- [ ] Add failing reducer/API tests for versioned complete cycle/intent/plan/Board replacement; duplicate no-op; gap/stale/project mismatch/invalid pair resync; mixed legacy/new ordered replay; lifecycle/replan order; retained-gap snapshot replacement; and local unsent-form preservation only.
- [ ] Add the required regression: begin with seeded M2 approval result/event, install a healthy current M3 snapshot containing an approved plan and nondefault filter, replay the exact old idempotency result, and assert `acknowledge_legacy` clears only local submitting state while cycles, intent, plan, Board, filter revision/selections, both cursors, and truncation state remain byte-identical. Against absent/mismatched/stale/gapped freshness, assert `resync_required`, zero synthetic field application, single-flight snapshot fetch, and exact convergence after reconnect/restart-shaped snapshot input.
- [ ] Add app/shell tests for exact initial/replan/continue/approve/revision/reject/abandon/filter payloads and guards; typed failures/conflicts; empty approved-requirement disabled and raced-error reload behavior; every cycle lifecycle control transition; Board tab/empty/stale/detail/filter states; focus/live-region behavior; and mutation disabling while stale/disconnected/submitting.
- [ ] Run red:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm exec vitest run apps/v2-web/src/api/client.spec.ts apps/v2-web/src/state/reducer.spec.ts apps/v2-web/src/state/resync.spec.ts apps/v2-web/src/app/use-project-connection.spec.tsx apps/v2-web/src/app/App.spec.tsx apps/v2-web/src/components/FocusedProjectShell.spec.tsx --config apps/v2-web/vite.config.ts
  ```

  Expected failure: M3 projection/disposition/shell composition is absent.
- [ ] Implement one exhaustive command-response classifier before any projection mutation. Apply versioned authoritative fields as complete replacements. For `legacy_m2/receipt_only`, acknowledge only when a loaded same-project continuous domain cursor and clear stale/resync state prove freshness; otherwise mark/retain stale and invoke existing single-flight snapshot resync without applying normalized fields.
- [ ] Wire Planning and Board panes through existing App/connection/store/shell seams. Keep only unsent form/filter drafts and selected task detail local. Do not merge cards, fabricate historical options, or calculate readiness/counts.
- [ ] Run green and web gates:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm nx test v2-web
  corepack pnpm nx typecheck v2-web
  corepack pnpm nx build v2-web
  git diff --check
  ```

- [ ] Commit only owned paths with `feat(v2-web): compose planning board state` and return `TASK HANDOFF`.

**Acceptance:** no legacy replay can regress newer plan/filter state; unknown freshness resyncs; ordered events/snapshot converge; exact guarded commands drive accessible views; no client-owned domain logic or Start/execution UI.

## Wave W2 Integration Gate

Integrate accepted M3-T05 then M3-T06 onto the exact accepted W1 head. Run:

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

This discharges W0/W1 server/web compatibility deferments. Obtain an accepted fresh `INTEGRATION REVIEW HANDOFF` before M3-T07.

## Task M3-T07: Built Fake Todo Acceptance and Durable Documentation

**Purpose:** Prove the complete built vertical slice and document its exact M3/M4/M5 ownership boundary.

**Prerequisite:** exact accepted W2 integration SHA.

**Owned files:**

- `e2e-v2/src/fixtures/v2-process.ts`
- `e2e-v2/src/v2-foundation.spec.ts`
- `docs/development/architecture.md`
- `docs/development/v2-foundation.md`

**Prohibited:** all product/contracts/config/project files; every E2E path except `e2e-v2/src/fixtures/v2-process.ts` and `e2e-v2/src/v2-foundation.spec.ts`; design/plan/runbook; V1/E2E-V1 paths; historical artifacts; M4/M5 implementation; and `C:\code\bloom`. No other task owns `e2e-v2/src/fixtures/v2-process.ts`.

**Consumes:** the built V2 server/web, explicit Todo fake, current E2E process/temp-repository helpers, and accepted design scenario. It extends the existing fixture directly; no new fixture/config layer is allowed.

**Produces:** fake-only built acceptance and current durable M3 operating/architecture guidance.

- [ ] Extend only `V2ProcessFixture.spawnServer` and `V2ProcessFixture.runMismatchProbe` in `e2e-v2/src/fixtures/v2-process.ts` so both child environment objects pass absolute fixture-owned `MESH_V2_DATA_DIR` (the fixture root). Preserve their existing `NODE_ENV=test`, `MESH_V2_PORT=0`, `MESH_V2_WORKSPACE_ROOT`, `MESH_V2_DATABASE_PATH`, `MESH_V2_WEB_ROOT`, `HOME`, and `USERPROFILE`; preserve `spawnServer`'s explicit Todo fake selection. This covers normal start/restart and the database-mismatch child instead of relying on inherited operator environment. The fixture creates its temporary repository/database under its own temp directory, records exact child PIDs and loopback origin, closes only those children/listeners, and proves cleanup. It must reject any path resolving to operator state or `C:\code\bloom`.
- [ ] Add the named built test `approved delivery plan becomes a deterministic Board`. Drive M2 Todo intent/ledger approval, approve a project `pm_plan` profile, submit the editable initial message with exact null/current bases, inspect proposal revision 1, request the keyboard/persistence revision, inspect immutable proposal revision 2, and prove no canonical Board cards before approval.
- [ ] Approve proposal 2 and assert one atomic commit yields plan revision 1, two milestones, three pending tasks, two dependencies, complete exact traces, terminal proposal/cycle, default saved filter, versioned event/result, and Board. UI/persistence tasks are actionable; integrated Todo is blocked by both exact prerequisites; no workspace/attempt/run/worker assignment exists.
- [ ] Exercise all-milestone, each-milestone, actionable, blocked, requirement, priority, and label filters; verify self-excluding counts and persistence after refresh. Open detail and verify dependency direction, exact requirement revision, acceptance/verification criteria, surfaces/artifacts, milestone outcome/stop condition/exclusions, and focus behavior.
- [ ] Disconnect before selected committed events, reconnect at the prior cursor, and prove ordered replay equality. Subscribe outside retention, receive `v2.resync_required`/`retained_gap`, fetch a snapshot, and prove equality. Restart the built server on the same fixture database/repository and prove byte-equivalent planning history, IDs/revisions, dependency history, traces, filter, readiness, and Board.
- [ ] Add isolated built branches for: (a) an approved ledger with no approved current requirement, disabled UI, exact persisted `planning_requirements_required`, no planning/runtime/event/canonical rows, then enabled planning after an M2 requirement revision with a new idempotency key; (b) abandonment of an awaiting plan proposal with `superseded/cycle_abandoned`, null successor, versioned result/event, replay/restart coherence; and (c) a selected label removed by a replacement plan remaining a canonically ordered zero-count historical option through refresh/replay/restart and then being clearable.
- [ ] Add the monotonic legacy replay built regression: seed byte-for-byte M2 approval event/result rows, migrate, approve an M3 plan, save a nondefault filter, load a healthy current snapshot, repost the exact M2 approval key/request hash, and assert byte-identical response/no event plus byte-unchanged plan/Board/filter/intent/history/cursors. Repeat against a forced stale/gapped projection and after server restart; require snapshot resync and the same final snapshot without a repairing event.
- [ ] Run the focused test red before the E2E flow exists:

  ```powershell
  $env:NX_DAEMON='false'; $env:NX_SKIP_NX_CACHE='true'
  git rev-parse HEAD
  corepack pnpm nx e2e v2-e2e -- --grep "approved delivery plan becomes a deterministic Board"
  ```

  Expected failure: the named built journey/Board behavior is absent, not external traffic or a port collision.
- [ ] Update current docs only. State that M3 owns canonical delivery planning, deterministic readiness, and Board projection; M4 owns workspace/DeveloperAttempt execution; M5 owns `ExecutionRun` scheduling/concurrency/waves. Document fake-only controls, temp ownership, restart/replay/resync behavior, and the absence of real-agent acceptance.
- [ ] Run focused green plus the final gate below. Commit only owned paths with `test(v2): prove planning board journey` and return `TASK HANDOFF`.

**Acceptance:** the complete design Todo scenario, revision path, atomic approval, filters, traceability, readiness, refresh, replay, resync, restart, empty-ledger, proposal-abandonment, historical-label, and stale-safe legacy replay proofs run against built output with owned fake-only fixtures; both normal/restart and mismatch spawns pass the same absolute fixture-owned `MESH_V2_DATA_DIR`; `corepack pnpm nx typecheck v2-e2e`, the focused named journey, and the unfiltered V2 E2E run inside `corepack pnpm verify` cover the fixture change; current docs state the correct milestone boundary; no product fix is hidden in E2E/docs. Any discovered product defect returns to its owning task as additive reviewed rework.

## Wave W3 and Final Verification Gate

After integrating accepted M3-T07, run on the exact clean head:

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
git status --short
```

The integrator records exact V1/V2 E2E totals emitted by `verify`, fixture cleanup evidence, and all changed paths. No real smoke test is run. Obtain an accepted fresh W3 integration review before final milestone review.

## Task M3-FINAL: Independent Exact-Commit Milestone Review

**Purpose:** Verify the whole design and stop condition without editing or inheriting campaign conclusions.

**Owned files:** none; read-only.

**Prerequisite:** exact accepted W3 integration SHA and complete campaign ledger/handoffs.

- [ ] A fresh reviewer who was not a worker, task reviewer, reworker, or wave integrator independently checks base-to-head lineage, every complete ordered `task-base..accepted-tip` lineage and source-to-integration commit/tree map, every changed path, accepted planning import, recurring barrier receipts, ownership/prohibitions, design coverage, frozen interface consistency, migration/raw-history safety, atomicity/audit ordering, Board determinism, web monotonicity, fake fixture ownership, and M4/M5/V1 exclusions.
- [ ] Re-run the full final verification gate daemon-disabled and uncached on the exact reviewed HEAD; do not reuse W3 output.
- [ ] Inspect the built Todo evidence for proposal revision, atomic multi-milestone approval, dependency/trace readiness, filters/details, refresh/replay/retained-gap/restart, empty requirements, abandonment, historical label, and seeded-M2 receipt-only replay after current plan/filter state.
- [ ] Return:

  ```text
  MILESTONE REVIEW HANDOFF
  Milestone: M3-PLANNING-BOARD
  Reviewer: <fresh independent reviewer/session ID>
  Status: accepted | rework_required | blocked
  Base: 0ad20dd25e48ef390469fd51d5ff85b0249e1acc
  Planning head: <full accepted PLAN_COMMIT>
  Reviewed commit: <full exact integration SHA>
  Reviewed tree: <full tree SHA>
  Lineage and changed paths: <commands/results and exact list>
  Design/stop-condition coverage:
  - <each outcome: satisfied | unsatisfied | unverified, with evidence>
  Safety and exclusions: <satisfied | unsatisfied | unverified, with evidence>
  Verification:
  - <NX env values, exact HEAD, commands, exit codes, totals/results>
  Findings:
  - <severity, owner, path:line, impact, required correction; or none>
  Residual risks:
  - <item or none>
  ```

- [ ] On `rework_required`, route each finding to its original owning task. Require additive task rework, fresh exact-tip task review, deterministic reintegration, full affected-wave and final gates on the new head, a fresh integration review, and a different fresh final reviewer. Do not amend or patch directly on the integration branch.

## Coverage and Stop-Proof Audit

The coordinator may close M3 only when the exact final reviewed head proves:

- T01: every strict contract/version/legacy alternative and prohibited field;
- T02: migration-3 fresh/upgrade/rollback, immutable revisions, task anchors, dependency history, traces, filters, deterministic Board and restart reads;
- T03: finite fake `pm_plan` execution and all failure/attention inputs without provider reuse;
- T04: complete accessible leaf planning/Board states without client domain logic;
- T05: full lifecycle, report receipt, atomic approval/filter/abandon, audit-before-publish, snapshot/replay/recovery, and raw idempotency preservation;
- T06: exact commands, complete replacements, monotonic receipt-only legacy handling, gap resync, and accessible shell composition;
- T07: both normal/restart and mismatch children receive fixture-owned `MESH_V2_DATA_DIR`, plus built fake Todo revision/approval/multi-milestone/dependency/trace/filter/detail/refresh/replay/resync/restart and edge-branch proofs plus current docs;
- every task/rework/wave/final tip has fresh exact-commit review and uncached daemon-disabled evidence, every wave proves complete-lineage patch/path/order equivalence, and every required recurring coordinator barrier has a campaign-ledger receipt; and
- there is no M4 workspace/DeveloperAttempt/execution loop, no M5 `ExecutionRun` scheduler/concurrency/product wave, no paid traffic, no live operator state, and no access to `C:\code\bloom`.

Stop after that proof. Do not add convenience execution, drag-and-drop Board state, generic orchestration, speculative APIs, or Milestone 4+ scaffolding.
