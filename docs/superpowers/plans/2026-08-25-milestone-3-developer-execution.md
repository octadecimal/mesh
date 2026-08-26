# Milestone 3 Developer Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human launch a policy-constrained Developer on one ready task, receive an audited review submission or blocker, and choose acceptance, same-session resume, or a fresh rework attempt.

**Architecture:** Extend the existing task-attempt aggregate with immutable Developer execution cycles and reports. A task-domain `DeveloperExecutionService` owns authority and atomic task/project-event mutations; an in-memory `DeveloperCapabilityRegistry` binds SDK MCP tool closures to one active session, attempt, task, and cycle. Existing HTTP, realtime, session-runtime, and web projection boundaries carry the new durable state without inferring outcomes from transcripts.

**Tech Stack:** TypeScript 6, Zod 4, Fastify 5, SQLite/better-sqlite3, Anthropic Claude Agent SDK in-process MCP tools, React 19, Hookstate, Vitest, Testing Library, Playwright, Nx/pnpm.

**Spec:** `docs/superpowers/specs/2026-08-25-milestone-3-developer-execution-design.md`

## Global Constraints

- Never set or fall back to `ANTHROPIC_API_KEY`; all real execution remains subscription-backed.
- Default tests use `FakeClaudeSessionDriver`, temporary repositories, and temporary SQLite databases only.
- Persist reports, task mutations, transitions, and project events before publishing success.
- A Developer may affect only the task and execution cycle bound to its runtime capability.
- Only a human may launch, resume, unblock, reject, or accept work as `done`.
- Backend restart invalidates runtime capabilities and never infers completion from transcript or process state.
- Project instructions may not broaden permissions, workspace scope, billing, or lifecycle authority.
- Use additive migration `007`; never edit an applied migration.
- Preserve existing Milestone 2 projects, attempts, sessions, workspaces, and events.
- Run focused Nx targets while iterating and `corepack pnpm verify` before completion.

---

## File structure

- `packages/contracts/src/developer-execution.ts`: Developer instruction, cycle, report, feedback, and disposition schemas.
- `packages/contracts/src/domain.ts`: additive project/attempt fields and repair variants.
- `packages/contracts/src/commands.ts`: human orchestration and internal Developer control command schemas.
- `packages/contracts/src/project-events.ts`: durable Developer configuration/cycle/report events.
- `packages/contracts/src/http.ts`: project snapshot collections for cycles, reports, and feedback.
- `packages/contracts/src/errors.ts`: stable Developer authority, capability, and cycle error codes.
- `apps/server/src/db/migrations/007-developer-execution.sql`: additive project instruction columns and immutable execution tables.
- `apps/server/src/repositories/developer-execution-repository.ts`: cycle, report, and feedback persistence only.
- `apps/server/src/repositories/project-repository.ts`: project instruction read/update support.
- `apps/server/src/domain/developer-policy.ts`: built-in policy version and deterministic launch/resume prompt composition.
- `apps/server/src/tasks/developer-capability-registry.ts`: ephemeral capability ownership and invalidation.
- `apps/server/src/tasks/developer-execution-service.ts`: Developer command authorization and atomic durable outcomes.
- `apps/server/src/tasks/attempt-service.ts`: human initial launch, resume, fresh rework, and unblock composition.
- `apps/server/src/claude/driver.ts`: SDK-neutral Developer control callbacks on create/resume requests.
- `apps/server/src/claude/sdk-driver.ts`: propagate Developer runtime controls to the SDK facade.
- `apps/server/src/claude/sdk-adapter.ts`: build always-loaded in-process MCP tools with Zod input.
- `apps/server/src/claude/fake-driver.ts`: retain and invoke Developer controls deterministically in tests.
- `apps/server/src/runtime/session-registry.ts`: pass per-session Developer runtime configuration and invalidate it on stop.
- `apps/server/src/http/command-handler.ts`: route new human and Developer commands to their owning services.
- `apps/server/src/http/errors.ts`: stable status mapping.
- `apps/server/src/http/project-snapshots.ts`: include Developer execution history.
- `apps/server/src/main.ts`: construct and wire repositories, registry, and services.
- `apps/web/src/state/reducer.ts`: project Developer instruction and execution-history projection.
- `apps/web/src/projects/DeveloperInstructions.tsx`: project instruction editor.
- `apps/web/src/tasks/DeveloperExecutionPanel.tsx`: launch, reports, acceptance, blocker recovery, and rework UI.
- `apps/web/src/tasks/TaskDrawer.tsx`: compose the focused Developer panel into the existing drawer.
- `apps/web/src/tasks/AttemptTimeline.tsx`: show execution cycles under each attempt.
- `apps/web/src/app/app.tsx`: send Developer commands and surface pending/failure feedback.
- `e2e/fixtures/fake-claude.ts`: scripted Developer MCP outcomes.
- `e2e/src/session-platform.spec.ts`: integrated review/rework and blocker/recovery paths.

---

### Task 1: Define backward-compatible Developer contracts

**Files:**
- Create: `packages/contracts/src/developer-execution.ts`
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/commands.ts`
- Modify: `packages/contracts/src/project-events.ts`
- Modify: `packages/contracts/src/http.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/contracts.spec.ts`

**Interfaces:**
- Produces: `developerExecutionCycleSchema`, `developerCompletionReportSchema`, `developerBlockerReportSchema`, `developerReviewFeedbackSchema`, and their inferred types.
- Produces commands: `project.developer_instructions.update`, `task.developer.launch`, `task.developer.submit_review`, `task.developer.block`, `task.developer.accept`, `task.developer.reject_resume`, `task.developer.reject_new`, `task.developer.unblock_resume`, and `task.developer.unblock_new`.
- Produces events: `project.developer_instructions_changed` and `task.developer_execution_changed`.

- [ ] **Step 1: Add failing contract tests**

Add table-driven tests that parse a complete cycle/report, reject a completion report missing a criterion result, reject a Developer command without `agent` actor metadata, and decode a Milestone 2 project/attempt with defaults:

```ts
expect(projectSchema.parse(oldProject).developerInstructions).toEqual({
  content: '',
  revision: 1,
  updatedAt: oldProject.updatedAt,
  updatedBy: null,
});
expect(() => developerCompletionReportSchema.parse({
  ...report,
  criterionResults: [],
})).toThrow();
```

- [ ] **Step 2: Run the contract tests and confirm RED**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: FAIL because the Developer schemas and command variants do not exist.

- [ ] **Step 3: Add the schemas and exports**

Define immutable cycle modes/dispositions and discriminated report records. Use a non-empty criterion ID captured from the task snapshot:

```ts
export const developerCycleModeSchema = z.enum(['new', 'resume']);
export const developerCycleDispositionSchema = z.enum([
  'submitted_for_review',
  'blocked',
]);
export const acceptanceCriterionResultSchema = z.object({
  criterionId: idSchema,
  status: z.enum(['met', 'not_met']),
  evidence: z.string().trim().min(1),
});
```

Add `developerInstructions` to `projectSchema` with a default for old payloads. Add optional/defaulted `role: 'developer' | null` to `taskAttemptSchema`. Keep cycles and reports as snapshot collections instead of nesting an unbounded history into attempt events.

- [ ] **Step 4: Add exact command and event payloads**

Human commands carry `actor`, `expectedRevision`, and explicit rework feedback. Internal Developer commands carry `capability`, `expectedRevision`, `report`, and an agent actor; they never carry target task/attempt IDs. Add stable codes `project_revision_conflict`, `developer_capability_invalid`, `developer_cycle_invalid`, and `developer_report_invalid`.

- [ ] **Step 5: Run contract tests and typecheck**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts && corepack pnpm nx typecheck contracts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/contracts
git commit -m "feat(contracts): add developer execution model"
```

### Task 2: Add reversible additive storage

**Files:**
- Create: `apps/server/src/db/migrations/007-developer-execution.sql`
- Modify: `apps/server/src/db/migrate.ts`
- Create: `apps/server/src/repositories/developer-execution-repository.ts`
- Modify: `apps/server/src/repositories/project-repository.ts`
- Test: `apps/server/src/db/migrate.spec.ts`
- Test: `apps/server/src/repositories/repositories.spec.ts`

**Interfaces:**
- Produces: `DeveloperExecutionRepository.createCycle`, `getCycle`, `getActiveCycleBySession`, `closeCycle`, `appendCompletionReport`, `appendBlockerReport`, `appendFeedback`, and `listByTask`.
- Produces: `ProjectRepository.updateDeveloperInstructions(projectId, expectedRevision, value)`.

- [ ] **Step 1: Write migration and repository failure tests**

Cover fresh and upgraded databases, immutable report rows, one active cycle per attempt, cycle ordinals, project instruction revision conflicts, and preservation of old attempts.

```ts
expect(columns('projects')).toContain('developer_instructions');
expect(() => repository.createCycle(secondActiveCycle)).toThrow();
expect(projects.updateDeveloperInstructions('project-1', 99, value)).toBeUndefined();
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts src/repositories/repositories.spec.ts`

Expected: FAIL because migration 007 and repository methods do not exist.

- [ ] **Step 3: Add migration 007**

Add project instruction content/revision/update metadata and normalized `developer_execution_cycles`, `developer_completion_reports`, `developer_blocker_reports`, and `developer_review_feedback` tables. Use foreign keys to projects, tasks, attempts, and sessions; unique `(attempt_id, ordinal)`; and a partial unique index allowing one row with `terminal_disposition IS NULL` per attempt.

- [ ] **Step 4: Implement focused repositories**

Parse every row through shared Zod schemas. Require the caller's existing SQLite transaction for `closeCycle` plus report insertion so the service can include the task transition and project event atomically.

- [ ] **Step 5: Run focused tests**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts src/repositories/repositories.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/db apps/server/src/repositories
git commit -m "feat(server): store developer execution history"
```

### Task 3: Add project instruction mutation and projection

**Files:**
- Modify: `apps/server/src/http/command-handler.ts`
- Modify: `apps/server/src/http/project-snapshots.ts`
- Modify: `apps/server/src/http/errors.ts`
- Modify: `apps/server/src/main.ts`
- Test: `apps/server/src/http/command-handler.spec.ts`
- Test: `apps/server/src/http/project-snapshots.spec.ts`

**Interfaces:**
- Consumes: `ProjectRepository.updateDeveloperInstructions` and `project.developer_instructions.update`.
- Produces: idempotent HTTP command response and `project.developer_instructions_changed` event.

- [ ] **Step 1: Write failing command and snapshot tests**

Prove only a human can update instructions, stale revisions return the current project, duplicate command IDs return the original response, the event is persisted before publication, and snapshots expose the updated value.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/project-snapshots.spec.ts`

Expected: FAIL on the unknown command/event.

- [ ] **Step 3: Implement the atomic mutation**

Inside `CommandRepository.executeOnceInImmediateTransaction`, load an active project, check revision and human actor, update instructions, append the project event, commit, then publish. Map a stale project revision to the new `project_revision_conflict` code consistently in contracts and HTTP handling.

- [ ] **Step 4: Run focused tests**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/project-snapshots.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/http apps/server/src/main.ts
git commit -m "feat(server): manage developer instructions"
```

### Task 4: Compose the versioned Developer execution prompt

**Files:**
- Create: `apps/server/src/domain/developer-policy.ts`
- Test: `apps/server/src/domain/developer-policy.spec.ts`

**Interfaces:**
- Produces: `DEVELOPER_POLICY_VERSION` and `composeDeveloperPrompt(input: DeveloperPromptInput): string`.
- Consumes: cycle snapshot with task title, description, criterion IDs/text, project instructions, mode, and optional review/blocker feedback.

- [ ] **Step 1: Write deterministic prompt tests**

Assert section order, exact policy version, criterion IDs, subordinate project-instruction wording, tool names, resume feedback, and absence of capability tokens.

- [ ] **Step 2: Run the test and confirm RED**

Run: `corepack pnpm nx test server -- --run src/domain/developer-policy.spec.ts`

Expected: FAIL because the composer does not exist.

- [ ] **Step 3: Implement a pure prompt composer**

Use fixed sections: role/authority, safety invariants, task contract, acceptance criteria, project instructions, feedback (resume only), and terminal reporting requirements. Do not read files, environment variables, or runtime state in this module.

- [ ] **Step 4: Run the test**

Run: `corepack pnpm nx test server -- --run src/domain/developer-policy.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/domain/developer-policy.*
git commit -m "feat(server): compose developer policy prompt"
```

### Task 5: Implement ephemeral capability ownership

**Files:**
- Create: `apps/server/src/tasks/developer-capability-registry.ts`
- Test: `apps/server/src/tasks/developer-capability-registry.spec.ts`

**Interfaces:**
- Produces: `DeveloperCapabilityRegistry.issue(binding)`, `resolve(token)`, `invalidateCycle(cycleId)`, `invalidateSession(sessionId)`, and `clear()`.
- Produces binding `{ sessionId, attemptId, taskId, cycleId, agentActor }`.

- [ ] **Step 1: Write failing ownership and invalidation tests**

Cover opaque unique tokens, exact binding resolution, terminal-cycle invalidation, session-stop invalidation, restart represented by a fresh empty registry, and no target enumeration for invalid tokens.

- [ ] **Step 2: Run the test and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/developer-capability-registry.spec.ts`

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement the in-memory registry**

Use `randomBytes(32).toString('base64url')`, maps keyed by token and by cycle/session, and one generic `DeveloperCapabilityInvalidError` for missing, expired, or mismatched tokens. Never log or persist tokens.

- [ ] **Step 4: Run the test**

Run: `corepack pnpm nx test server -- --run src/tasks/developer-capability-registry.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/tasks/developer-capability-registry.*
git commit -m "feat(server): scope developer capabilities"
```

### Task 6: Persist Developer review and blocker outcomes atomically

**Files:**
- Create: `apps/server/src/tasks/developer-execution-service.ts`
- Test: `apps/server/src/tasks/developer-execution-service.spec.ts`
- Modify: `apps/server/src/domain/task-lifecycle.ts`
- Test: `apps/server/src/domain/task-lifecycle.spec.ts`

**Interfaces:**
- Produces: `DeveloperExecutionService.submitForReview(input)` and `markBlocked(input)`.
- Consumes: capability token, expected task revision, report, and idempotency ID.
- Produces: `{ task, cycle, report, transition, event }` and invalidates the capability only after durable commit.

- [ ] **Step 1: Add failing authority and atomicity tests**

Cover wrong session/task/cycle, non-current attempt, non-`in_progress` task, blocked review submission, incomplete criterion coverage, duplicate command, persistence failure, event ordering, and Developer authority for only `in_progress -> review` or setting blocked.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/developer-execution-service.spec.ts src/domain/task-lifecycle.spec.ts`

Expected: FAIL on missing service and unauthorized Developer transition.

- [ ] **Step 3: Narrow the lifecycle policy**

Permit actor type `agent` with the bound Developer policy to request only `in_progress -> review` and same-state blocking. Keep `done`, unblocking, launch, and all unrelated transitions human-only. Pass an explicit authorization operation into the domain function rather than treating every agent actor as a Developer.

- [ ] **Step 4: Implement transactional outcomes**

Resolve capability ownership, re-read current task/attempt/cycle inside `BEGIN IMMEDIATE`, validate exact criterion IDs, insert report, close cycle, mutate task, append transition and one `task.developer_execution_changed` event, then commit and publish. On failure roll back and retain the active capability unless the audit barrier requires runtime interruption.

- [ ] **Step 5: Run focused tests**

Run: `corepack pnpm nx test server -- --run src/tasks/developer-execution-service.spec.ts src/domain/task-lifecycle.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/tasks/developer-execution-service.* apps/server/src/domain/task-lifecycle.*
git commit -m "feat(server): accept developer outcomes"
```

### Task 7: Expose first-class SDK MCP controls

**Files:**
- Modify: `apps/server/src/claude/driver.ts`
- Modify: `apps/server/src/claude/sdk-driver.ts`
- Modify: `apps/server/src/claude/sdk-adapter.ts`
- Modify: `apps/server/src/claude/fake-driver.ts`
- Test: `apps/server/src/claude/sdk-driver.spec.ts`
- Test: `apps/server/src/claude/sdk-adapter.spec.ts`
- Test: `apps/server/src/claude/fake-driver.spec.ts`

**Interfaces:**
- Produces: SDK-neutral `DeveloperRuntimeControls` with `submitForReview(report)` and `markBlocked(report)` callbacks.
- Extends create/resume requests with optional `{ initialPrompt, controls }`.
- Consumes Claude SDK `createSdkMcpServer` and `tool` with Zod raw shapes.

- [ ] **Step 1: Write failing adapter tests**

Assert ordinary sessions install no Mesh MCP server, Developer sessions install exactly `mesh_developer`, both tools are always loaded, valid calls invoke the provided closure once, invalid inputs return MCP errors, and capability values never enter tool schemas or outputs.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/claude/sdk-driver.spec.ts src/claude/sdk-adapter.spec.ts src/claude/fake-driver.spec.ts`

Expected: FAIL because driver requests have no Developer controls.

- [ ] **Step 3: Extend SDK-neutral driver requests**

Add optional `developer` configuration to `StartClaudeSessionRequest` and `ResumeClaudeSessionRequest`. Keep callbacks server-owned closures; do not expose the token to the model-facing schema.

- [ ] **Step 4: Build the in-process MCP server**

In `sdk-adapter.ts`, use:

```ts
const server = createSdkMcpServer({
  name: 'mesh_developer',
  version: '1',
  alwaysLoad: true,
  tools: [tool('submit_for_review', description, shape, handler),
          tool('mark_blocked', description, blockerShape, blockerHandler)],
});
```

Pass it as `mcpServers: { mesh_developer: server }` to `query`. Return concise success or typed failure content. The callback itself invokes the task-domain service with the closure-bound capability.

- [ ] **Step 5: Extend the fake driver**

Retain Developer requests and expose test-only `submitForReview(index, report)` and `markBlocked(index, report)` helpers that invoke the same callbacks without transcript parsing.

- [ ] **Step 6: Run focused tests**

Run: `corepack pnpm nx test server -- --run src/claude/sdk-driver.spec.ts src/claude/sdk-adapter.spec.ts src/claude/fake-driver.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/server/src/claude
git commit -m "feat(server): expose developer control tools"
```

### Task 8: Compose human launch with a Developer cycle

**Files:**
- Modify: `apps/server/src/tasks/attempt-service.ts`
- Modify: `apps/server/src/runtime/session-registry.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/http/command-handler.ts`
- Modify: `apps/server/src/http/errors.ts`
- Test: `apps/server/src/tasks/attempt-service.spec.ts`
- Test: `apps/server/src/runtime/session-registry.spec.ts`
- Test: `apps/server/src/http/command-handler.spec.ts`

**Interfaces:**
- Consumes: `task.developer.launch`, prompt composer, execution repository, capability registry, and Developer execution service.
- Produces: a launched `TaskAttempt` with `role: 'developer'`, cycle ordinal 1, installed controls, and the existing safe `ready -> in_progress` ordering.

- [ ] **Step 1: Write failing launch tests**

Prove human-only launch, exact task/policy/instruction snapshot, current project-instruction revision, capability installation before runtime start, no token in diagnostics/events, startup failure retention, audit failure interruption, worktree preservation, and ordinary `task.attempt.launch` compatibility.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/attempt-service.spec.ts src/runtime/session-registry.spec.ts src/http/command-handler.spec.ts`

Expected: FAIL on the unknown launch command and missing cycle.

- [ ] **Step 3: Add per-session runtime configuration**

Let `SessionRegistry.create` and `resume` accept optional Developer runtime configuration for that attach only. Pass it to the driver request, send `initialPrompt` after the driver identity is established, and invalidate the session capability from `onStopped`, interruption, shutdown, and attach failure.

- [ ] **Step 4: Extend the attempt launch transaction**

Create the Developer attempt and cycle in the same launch audit transaction. Issue the capability only after durable rows exist and before calling `registry.create`. On any later failure, invalidate it. Keep the existing reservation, billing, workspace, diagnostic, and transition ordering intact.

- [ ] **Step 5: Wire command handling and services**

Construct one capability registry and Developer execution service in `main.ts`. Route `task.developer.launch` separately from the legacy generic launch and enforce human actor authorization before entering `AttemptService`.

- [ ] **Step 6: Run focused tests**

Run: `corepack pnpm nx test server -- --run src/tasks/attempt-service.spec.ts src/runtime/session-registry.spec.ts src/http/command-handler.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/server/src/tasks apps/server/src/runtime apps/server/src/http apps/server/src/main.ts
git commit -m "feat(server): launch developer task attempts"
```

### Task 9: Implement acceptance, rejection, resume, fresh rework, and unblock

**Files:**
- Modify: `apps/server/src/tasks/attempt-service.ts`
- Modify: `apps/server/src/tasks/developer-execution-service.ts`
- Modify: `apps/server/src/http/command-handler.ts`
- Test: `apps/server/src/tasks/attempt-service.spec.ts`
- Test: `apps/server/src/tasks/developer-execution-service.spec.ts`
- Test: `apps/server/src/http/command-handler.spec.ts`

**Interfaces:**
- Consumes: six human commands for accept, two rejection paths, and two unblock paths.
- Produces: immutable feedback plus either a new cycle on the same attempt/session or a fresh attempt/session.

- [ ] **Step 1: Write failing human lifecycle tests**

Cover human-only acceptance, non-empty rejection/unblock reasons, same-session resume, failed resume leaving the task in review/blocked, fresh startup failure retaining prior review/blocker truth, fresh attempt history, updated cycle snapshots, and duplicate commands.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/attempt-service.spec.ts src/tasks/developer-execution-service.spec.ts src/http/command-handler.spec.ts`

Expected: FAIL because human review/recovery commands are not handled.

- [ ] **Step 3: Implement accept and feedback persistence**

Accept uses the existing audited `review -> done` transition with a human actor. Rejection and unblock commands append immutable feedback before creating a cycle. Do not reuse or reopen a terminal cycle.

- [ ] **Step 4: Implement same-session resume**

Preflight the resumable Claude ID, workspace, task revision, and human authority. In one transaction append feedback, create a resume cycle, and prepare task state; then attach the runtime with a new capability and resume prompt. If attach fails, restore the prior visible review/blocked truth and record the failed cycle/diagnostic rather than claiming active work.

- [ ] **Step 5: Implement fresh rework and unblock**

Reuse a private launch composition that accepts prior state (`review` or blocked `in_progress`) and changes visible state only after startup succeeds. Preserve the prior attempt and blocker/report. For unblock, clear the blocker only as part of the successfully started selected path.

- [ ] **Step 6: Run focused tests**

Run: `corepack pnpm nx test server -- --run src/tasks/attempt-service.spec.ts src/tasks/developer-execution-service.spec.ts src/http/command-handler.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/server/src/tasks apps/server/src/http/command-handler*
git commit -m "feat(server): add developer review and rework"
```

### Task 10: Project Developer history through snapshots and realtime

**Files:**
- Modify: `apps/server/src/http/project-snapshots.ts`
- Modify: `apps/server/src/realtime/project-replay.ts`
- Modify: `apps/server/src/realtime/socket-hub.ts`
- Modify: `apps/server/src/tasks/reconcile-attempts.ts`
- Test: `apps/server/src/http/project-snapshots.spec.ts`
- Test: `apps/server/src/realtime/project-replay.spec.ts`
- Test: `apps/server/src/realtime/socket-hub.spec.ts`
- Test: `apps/server/src/tasks/reconcile-attempts.spec.ts`

**Interfaces:**
- Consumes: execution repository and new project event variants.
- Produces: snapshot collections `developerCycles`, `developerCompletionReports`, `developerBlockerReports`, and `developerReviewFeedback` plus `developer_cycle_without_live_session` repair state.

- [ ] **Step 1: Write failing snapshot/replay/recovery tests**

Prove ordered history, reconnect convergence, gap resync, event-before-publish ordering, capability absence, and restart repair for a non-terminal cycle whose session is no longer live.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/http/project-snapshots.spec.ts src/realtime/project-replay.spec.ts src/realtime/socket-hub.spec.ts src/tasks/reconcile-attempts.spec.ts`

Expected: FAIL because Developer history and repair variants are absent.

- [ ] **Step 3: Extend snapshot and event replay**

Read all Developer records for the project's task IDs inside the existing snapshot transaction. Project events carry changed durable records needed for incremental projection; they never carry capability material.

- [ ] **Step 4: Extend restart reconciliation**

Detect active cycles whose canonical session is not live, append an explicit repair event once, and leave task lifecycle unchanged. Do not inspect transcript text or infer a report.

- [ ] **Step 5: Run focused tests**

Run: `corepack pnpm nx test server -- --run src/http/project-snapshots.spec.ts src/realtime/project-replay.spec.ts src/realtime/socket-hub.spec.ts src/tasks/reconcile-attempts.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/http/project-snapshots* apps/server/src/realtime apps/server/src/tasks/reconcile-attempts*
git commit -m "feat(server): replay developer execution history"
```

### Task 11: Add web projection and project instruction editor

**Files:**
- Modify: `apps/web/src/state/reducer.ts`
- Test: `apps/web/src/state/reducer.spec.ts`
- Create: `apps/web/src/projects/DeveloperInstructions.tsx`
- Create: `apps/web/src/projects/DeveloperInstructions.spec.tsx`
- Modify: `apps/web/src/app/app.tsx`
- Test: `apps/web/src/app/app.spec.tsx`

**Interfaces:**
- Produces projection maps for cycles/reports/feedback and reducer support for both new event variants.
- Produces `DeveloperInstructions` with `{ project, disabled, onSave }`.

- [ ] **Step 1: Write failing reducer and editor tests**

Cover snapshot replacement, incremental events, duplicate/gap behavior, edit/save/cancel, archived/disconnected disabled states, pending save, and revision-conflict feedback.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/projects/DeveloperInstructions.spec.tsx src/app/app.spec.tsx`

Expected: FAIL because the projection fields and editor do not exist.

- [ ] **Step 3: Extend the projection**

Index cycles by attempt ID and reports/feedback by cycle ID. On project snapshot replacement, remove only records belonging to replaced task IDs. Apply `project.developer_instructions_changed` and `task.developer_execution_changed` idempotently.

- [ ] **Step 4: Implement the editor**

Use a controlled draft, display instruction revision, and send `project.developer_instructions.update` with the current project revision and human actor. Keep drafts local until command success and resync on stale revision.

- [ ] **Step 5: Run focused tests**

Run: `corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/projects/DeveloperInstructions.spec.tsx src/app/app.spec.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/state apps/web/src/projects apps/web/src/app
git commit -m "feat(web): configure developer instructions"
```

### Task 12: Add Developer launch, reports, and human review UI

**Files:**
- Create: `apps/web/src/tasks/DeveloperExecutionPanel.tsx`
- Create: `apps/web/src/tasks/DeveloperExecutionPanel.spec.tsx`
- Modify: `apps/web/src/tasks/TaskDrawer.tsx`
- Modify: `apps/web/src/tasks/TaskDrawer.spec.tsx`
- Modify: `apps/web/src/tasks/AttemptTimeline.tsx`
- Modify: `apps/web/src/tasks/TaskBoard.tsx`
- Modify: `apps/web/src/app/app.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes projected attempts, cycles, reports, feedback, sessions, repairs, and `onCommand`.
- Produces explicit Start Developer, accept, reject/resume, reject/new, unblock/resume, and unblock/new interactions.

- [ ] **Step 1: Write failing interaction tests**

Cover launch eligibility, workspace/permission selection reuse, structured criterion/report rendering, human accept, rejection feedback and path choice, blocker evidence, unblock path choice, archived/disconnected/read-only states, pending commands, typed failures, and repair warnings.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test web -- --run src/tasks/DeveloperExecutionPanel.spec.tsx src/tasks/TaskDrawer.spec.tsx`

Expected: FAIL because the panel and commands do not exist.

- [ ] **Step 3: Implement the focused panel**

Keep report/rework UI outside the already-large `TaskDrawer`. Reuse `WorkspaceFields` for launch/new-attempt choices. Show every cycle in chronological order, criterion status without collapsing `not_met`, verification output, workspace state, feedback, blocker evidence, and linked session navigation.

- [ ] **Step 4: Compose commands in the app boundary**

Use the existing `MeshApi.command` path and human operator actor. Keep each action visibly pending until the durable project event arrives; on error retain the prior canonical task state and show the typed message.

- [ ] **Step 5: Run focused web tests**

Run: `corepack pnpm nx test web -- --run src/tasks/DeveloperExecutionPanel.spec.tsx src/tasks/TaskDrawer.spec.tsx src/app/app.spec.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/tasks apps/web/src/app apps/web/src/styles.css
git commit -m "feat(web): add developer review workflow"
```

### Task 13: Prove integrated fake-driver workflows

**Files:**
- Modify: `e2e/fixtures/fake-claude.ts`
- Modify: `e2e/src/session-platform.spec.ts`

**Interfaces:**
- Consumes: fake-driver Developer control helpers and production HTTP/realtime/web paths.
- Produces deterministic end-to-end coverage without Claude traffic.

- [ ] **Step 1: Add failing review/rework acceptance test**

Script: import a temporary repository, save project instructions, create and ready a task, human-launch Developer, fake-submit review, reject/resume with feedback, fake-submit again, accept done, reload, and assert both cycles/reports/feedback survive.

- [ ] **Step 2: Add failing blocker/recovery acceptance test**

Script: launch Developer, fake-mark blocked with workspace-preservation evidence, assert runtime stopped and task stayed `in_progress`, human-unblock with a fresh attempt, submit review, and assert the blocked attempt remains in history.

- [ ] **Step 3: Run both tests and confirm RED**

Run: `corepack pnpm nx e2e e2e --project=chromium --grep "Developer"`

Expected: FAIL before fixture and UI support are complete.

- [ ] **Step 4: Extend only the deterministic fixture controls needed by the tests**

Route fixture script messages to `FakeDriverSession.submitForReview` and `markBlocked`. Do not parse assistant prose and do not introduce sleeps; await board events, session status, and visible report state.

- [ ] **Step 5: Run Developer acceptance tests**

Run: `corepack pnpm nx e2e e2e --project=chromium --grep "Developer"`

Expected: both paths PASS without external Claude traffic.

- [ ] **Step 6: Commit**

```powershell
git add e2e
git commit -m "test(e2e): cover developer execution flows"
```

### Task 14: Update durable guidance and run the complete gate

**Files:**
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/session-platform.md`

**Interfaces:**
- Documents: Developer authority, control/audit flow, project instructions, human review/rework, restart behavior, and opt-in real smoke boundaries.

- [ ] **Step 1: Update architecture guidance**

Document `DeveloperExecutionService` ownership, ephemeral capability invalidation, SDK MCP adaptation, durable cycle/report events, and the continuing separation between project task truth and session runtime truth.

- [ ] **Step 2: Update operating guidance**

Document configuring project instructions, starting a Developer, reading reports, choosing rework paths, recovering blockers/repair states, preserving workspaces, and the fact that default verification never consumes subscription quota.

- [ ] **Step 3: Run documentation formatting**

Run: `corepack pnpm exec prettier --check docs/development/architecture.md docs/development/session-platform.md`

Expected: PASS.

- [ ] **Step 4: Run the complete deterministic gate**

Run: `corepack pnpm verify`

Expected: formatting, lint, typecheck, unit tests, builds, and Chromium acceptance all PASS. Do not run the real Claude smoke test.

- [ ] **Step 5: Inspect final scope and safety**

Run: `git status --short && git diff --check && git diff --stat origin/master...HEAD`

Expected: only Milestone 3 contracts, storage, task/runtime/control, web, tests, and durable docs changed; no credentials, runtime database, temporary worktree content, screenshots, or scratch files are tracked.

- [ ] **Step 6: Commit**

```powershell
git add docs/development
git commit -m "docs: explain developer execution workflow"
```

Do not publish a pull request or run the real Claude smoke test unless the maintainer explicitly asks.
