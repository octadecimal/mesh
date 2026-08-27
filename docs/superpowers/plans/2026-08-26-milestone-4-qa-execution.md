# Milestone 4 QA Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add policy-constrained QA execution and a bounded manual or autonomous Developer-to-QA review loop to Mesh.

**Architecture:** Extend the Milestone 3 task-attempt aggregate with immutable QA cycles, criterion-level reports, and durable automatic-action records. Task-domain services own QA authority and atomic outcomes; a narrow review-automation service invokes the same explicit launch and rework boundaries without becoming a scheduler or workflow engine.

**Tech Stack:** TypeScript 6, Zod 4, Fastify 5, SQLite/better-sqlite3, Anthropic Claude Agent SDK in-process MCP tools, React 19, Hookstate, Vitest, Testing Library, Playwright, Nx/pnpm.

**Spec:** `docs/superpowers/specs/2026-08-26-milestone-4-qa-execution-design.md`

## Global Constraints

- Start implementation only from a revision containing the completed Milestone 3 Developer execution implementation.
- Normal tests use the fake driver, temporary repositories, and temporary databases; never contact Claude or use operator runtime state.
- Never set or fall back to `ANTHROPIC_API_KEY` or any pay-per-token billing configuration.
- Persist every QA outcome and required diagnostic before realtime publication or automatic follow-up.
- QA uses the current Developer attempt's exact verified workspace and receives no source-authoring tools.
- `manual` review policy never advances or resumes work after a QA verdict without a human command.
- `autonomous_review` may launch QA, complete verified work, and resume the same Developer session after the first two rejections.
- The third autonomous QA rejection pauses automation and starts no Developer cycle.
- Any ambiguous workspace, startup failure, resume failure, audit failure, or outcome-unknown state pauses automation without guessing.
- Existing Milestone 2 projects and Milestone 3 attempts remain backward-compatible.
- Do not add a scheduler, queue, lease, PM role, generic workflow framework, fresh-attempt fallback, cleanup, merge, or pull-request behavior.

---

## Planned File Structure

```text
packages/contracts/src/
  qa-execution.ts                         QA configuration, cycles, reports, actions
  domain.ts                               Project and TaskAttempt QA fields/defaults
  commands.ts                             Human, QA, and automation command variants
  project-events.ts                       QA/configuration/automation event payloads
  http.ts                                 Snapshot response additions
  errors.ts                               Stable QA and automation error codes
  index.ts                                Public exports

apps/server/src/
  db/migrate.ts                           Additive QA tables and project columns
  repositories/qa-execution-repository.ts QA cycles, reports, automatic actions
  repositories/project-repository.ts      Revisioned QA configuration writes
  domain/qa-policy.ts                     Prompt and report invariants
  tasks/qa-capability-registry.ts          Ephemeral session/task/attempt/cycle binding
  tasks/qa-execution-service.ts            QA launch and verdict transactions
  tasks/review-automation-service.ts       Bounded post-commit follow-up policy
  tasks/reconcile-attempts.ts              Interrupted QA and pending-action repairs
  tasks/attempt-service.ts                 QA launch/runtime and Developer resume bridge
  http/command-handler.ts                  Command authorization and error mapping
  http/project-snapshots.ts                QA snapshot assembly
  test/create-test-database.ts             QA repositories in isolated test fixtures
  main.ts                                  Production composition and restart reconciliation

apps/web/src/
  state/projection.ts                      QA state maps and configuration projection
  state/reducer.ts                         Ordered QA project-event application
  tasks/QaExecutionPanel.tsx               QA evidence, controls, budget, and repairs
  tasks/QaExecutionPanel.spec.tsx          Panel behavior
  tasks/DeveloperExecutionPanel.tsx        Alternating Developer/QA timeline integration
  tasks/TaskDrawer.tsx                     QA panel composition
  projects/QaSettings.tsx                  Instructions and review-policy editor
  app/app.tsx                              QA commands and pending feedback

e2e/src/session-platform.spec.ts           Manual and autonomous integrated workflows
docs/development/architecture.md            QA ownership and data flow
docs/development/session-platform.md        Operator workflow and recovery
```

### Task 1: Define backward-compatible QA contracts

**Files:**
- Create: `packages/contracts/src/qa-execution.ts`
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/commands.ts`
- Modify: `packages/contracts/src/project-events.ts`
- Modify: `packages/contracts/src/http.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/contracts.spec.ts`

**Interfaces:**
- Produces: `reviewPolicySchema`, `qaInstructionsSchema`, `qaExecutionCycleSchema`, `qaReportSchema`, `reviewAutomationStateSchema`, `reviewAutomationActionSchema`, and inferred public types.
- Produces commands: `project.qa_configuration.update`, `task.qa.launch`, `task.qa.submit_verdict`, `task.review_automation.enable`, and `task.review_automation.pause`.
- Produces events: `project.qa_configuration_changed`, `task.qa_execution_changed`, and `task.review_automation_changed`.

- [ ] **Step 1: Write failing contract tests**

Add table-driven tests that parse both policies, require one QA result per criterion, reject `verified` when any criterion failed or was skipped, decode a Milestone 3 project with manual defaults, and decode a Developer attempt with empty QA history:

```ts
expect(projectSchema.parse(milestone3Project).qaConfiguration).toEqual({
  instructions: { content: '', revision: 1, updatedAt: milestone3Project.updatedAt, updatedBy: null },
  reviewPolicy: 'manual',
  revision: 1,
  updatedAt: milestone3Project.updatedAt,
  updatedBy: null,
});
expect(taskAttemptSchema.parse(milestone3Attempt).qaCycles).toEqual([]);
expect(() => qaReportSchema.parse({ ...report, disposition: 'verified', criterionResults: [{ criterionId: 'criterion-1', status: 'failed', evidence: 'test failed' }] })).toThrow();
```

- [ ] **Step 2: Run the contract test and confirm RED**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: FAIL because QA schemas and command/event variants do not exist.

- [ ] **Step 3: Implement the QA schemas and defaults**

Use these stable shapes in `qa-execution.ts`:

```ts
export const reviewPolicySchema = z.enum(['manual', 'autonomous_review']);
export const qaCriterionResultSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped']),
  evidence: z.string().min(1),
});
export const qaReportSchema = z.object({
  id: z.string().min(1),
  cycleId: z.string().min(1),
  disposition: z.enum(['verified', 'rejected']),
  criterionResults: z.array(qaCriterionResultSchema).min(1),
  verificationCommands: z.array(z.object({ command: z.string().min(1), outcome: z.string().min(1) })),
  limitations: z.array(z.string().min(1)),
  residualRisks: z.array(z.string().min(1)),
  workspaceBefore: z.string().min(1),
  workspaceAfter: z.string().min(1),
  createdAt: z.string().datetime(),
});
```

Add QA fields to project and attempt schemas with compatibility defaults. Add a task-local automation state containing `status`, `generation`, `rejectionCount`, `pauseReason`, and `updatedAt`; old tasks default to disabled generation zero with no rejections. Refine `qaReportSchema` so `verified` permits only `passed` criterion results and requires exact criterion coverage at the service boundary.

- [ ] **Step 4: Add command, event, error, snapshot, and export variants**

Every mutating command keeps the existing envelope, idempotency key, expected revision, and actor metadata patterns. The QA agent command carries a capability token rather than model-supplied task ownership IDs. Add stable errors for invalid QA capability, incomplete report, QA already active, automation paused, rejection ceiling reached, unsafe QA workspace, and Developer resume unavailable.

- [ ] **Step 5: Run contract tests and confirm GREEN**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: PASS with old project/attempt fixtures and all QA variants.

- [ ] **Step 6: Commit**

```powershell
git add packages/contracts
git commit -m "feat(contracts): define QA execution"
```

### Task 2: Persist QA configuration, cycles, reports, and actions

**Files:**
- Modify: `apps/server/src/db/migrate.ts`
- Test: `apps/server/src/db/migrate.spec.ts`
- Create: `apps/server/src/repositories/qa-execution-repository.ts`
- Test: `apps/server/src/repositories/qa-execution-repository.spec.ts`
- Modify: `apps/server/src/repositories/project-repository.ts`
- Test: `apps/server/src/repositories/project-repository.spec.ts`
- Modify: `apps/server/src/test/create-test-database.ts`

**Interfaces:**
- Produces: `QaExecutionRepository.createCycle`, `getCycle`, `listCyclesForAttempts`, `insertReport`, `getReport`, `listReportsForAttempts`, `insertAutomationAction`, `completeAutomationAction`, and `listPendingAutomationActions`.
- Produces: `ProjectRepository.updateQaConfiguration(projectId, expectedRevision, value, actor)`.

- [ ] **Step 1: Write failing migration and repository tests**

Cover migration from a Milestone 3 database, manual defaults, stale QA configuration revision, ordered cycles, immutable reports, unique terminal report per cycle, unique automation idempotency key, pending-action lookup, and rollback when project-event insertion fails.

```ts
expect(migratedProject.qaConfiguration.reviewPolicy).toBe('manual');
expect(repository.listCyclesForAttempts([attempt.id])).toEqual([firstCycle, secondCycle]);
expect(() => repository.insertReport(conflictingReport)).toThrow();
expect(repository.insertAutomationAction(duplicate)).toEqual(original);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts src/repositories/qa-execution-repository.spec.ts src/repositories/project-repository.spec.ts`

Expected: FAIL because the QA migration and repositories are absent.

- [ ] **Step 3: Add the additive migration**

Extend `migrate.ts` with the next ordered migration. Add project QA configuration columns and tables equivalent to:

```sql
CREATE TABLE qa_execution_cycles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  review_policy TEXT NOT NULL,
  automation_generation INTEGER NOT NULL,
  rejection_ordinal INTEGER NOT NULL,
  disposition TEXT,
  started_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE(attempt_id, ordinal)
);
CREATE TABLE qa_reports (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL UNIQUE,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE review_automation_actions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  source_cycle_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

Use foreign keys and indexes consistent with existing task-attempt repositories. Store validated snapshots as JSON while keeping ownership, ordering, status, and idempotency queryable.

- [ ] **Step 4: Implement repository mapping and transactional methods**

Parse every JSON column through the Task 1 schemas on read. Do not expose raw rows. `insertReport` and terminal cycle updates accept an existing SQLite transaction so the service can commit report, lifecycle, events, and action status atomically.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts src/repositories/qa-execution-repository.spec.ts src/repositories/project-repository.spec.ts`

Expected: PASS, including migration and rollback cases.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/db apps/server/src/repositories apps/server/src/test/create-test-database.ts
git commit -m "feat(server): persist QA execution"
```

### Task 3: Define QA policy, prompt, and capability binding

**Files:**
- Create: `apps/server/src/domain/qa-policy.ts`
- Test: `apps/server/src/domain/qa-policy.spec.ts`
- Create: `apps/server/src/tasks/qa-capability-registry.ts`
- Test: `apps/server/src/tasks/qa-capability-registry.spec.ts`

**Interfaces:**
- Produces: `composeQaPrompt(input: QaPromptInput): string`.
- Produces: `QaCapabilityRegistry.issue(binding)`, `resolve(token)`, `invalidate(token)`, and `invalidateSession(sessionId)`.

- [ ] **Step 1: Write failing prompt and registry tests**

Assert that the prompt includes frozen criteria, the Developer report, QA instructions, verification-only authority, exact workspace, report requirements, and the `submit_qa_verdict` control. Assert that hostile project instructions cannot override billing, workspace, source-authoring, or task authority. Cover expired, replayed, cross-session, wrong-task, wrong-attempt, and wrong-cycle tokens.

```ts
const token = registry.issue({ sessionId: 'qa-session', taskId: 'task-1', attemptId: 'attempt-1', cycleId: 'qa-cycle-1' });
expect(registry.resolve(token).cycleId).toBe('qa-cycle-1');
registry.invalidate(token);
expect(() => registry.resolve(token)).toThrow(QaCapabilityInvalidError);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/domain/qa-policy.spec.ts src/tasks/qa-capability-registry.spec.ts`

Expected: FAIL because the policy and registry do not exist.

- [ ] **Step 3: Implement the built-in QA prompt**

Compose fixed built-in policy before project instructions. State that QA may inspect source and run verification commands, receives no source-authoring controls, must report unexpected source changes, cannot alter task truth, and must submit exactly one structured verdict.

- [ ] **Step 4: Implement opaque in-memory capability binding**

Follow `DeveloperCapabilityRegistry` ownership and invalidation patterns, but use a distinct token type and QA binding. Never accept ownership IDs from the model tool payload.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/domain/qa-policy.spec.ts src/tasks/qa-capability-registry.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/domain/qa-policy.ts apps/server/src/domain/qa-policy.spec.ts apps/server/src/tasks/qa-capability-registry.ts apps/server/src/tasks/qa-capability-registry.spec.ts
git commit -m "feat(server): constrain QA authority"
```

### Task 4: Add revisioned project QA configuration commands

**Files:**
- Modify: `apps/server/src/http/command-handler.ts`
- Test: `apps/server/src/http/command-handler.spec.ts`
- Modify: `apps/server/src/http/project-snapshots.ts`
- Test: `apps/server/src/http/project-snapshots.spec.ts`

**Interfaces:**
- Consumes: `ProjectRepository.updateQaConfiguration` from Task 2.
- Produces: handling for `project.qa_configuration.update` with a `project.qa_configuration_changed` event.

- [ ] **Step 1: Write failing authorization and revision tests**

Cover human-only updates, stale revisions returning current project truth, idempotent duplicate commands, exact actor metadata, event ordering, and project snapshots containing manual defaults and updated configuration.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/project-snapshots.spec.ts`

Expected: FAIL on the unhandled QA configuration command.

- [ ] **Step 3: Implement the command transaction**

Validate the human actor and expected QA configuration revision, update the project, append the project event, and store the idempotent command result in one transaction. Publish only after commit.

```ts
case 'project.qa_configuration.update':
  return executeQaConfigurationUpdate(command.command, command.idempotencyKey, dependencies);
```

- [ ] **Step 4: Add QA configuration to project snapshots**

Use the contract default for existing projects; do not derive policy from browser state.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/project-snapshots.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/http
git commit -m "feat(server): configure project QA"
```

### Task 5: Launch QA in the current Developer workspace

**Files:**
- Create: `apps/server/src/tasks/qa-execution-service.ts`
- Test: `apps/server/src/tasks/qa-execution-service.spec.ts`
- Modify: `apps/server/src/tasks/attempt-service.ts`
- Test: `apps/server/src/tasks/attempt-service.spec.ts`

**Interfaces:**
- Produces: `QaExecutionService.launch(input: QaLaunchInput): Promise<QaLaunchResult>`.
- Consumes: current task, Developer attempt and completion report, verified workspace, QA configuration, driver, session registry, QA repository, and capability registry.

- [ ] **Step 1: Write failing launch tests**

Cover manual human launch, autonomous-policy launch, non-review task, blocked task, stale revision, non-current attempt, missing Developer report, active role cycle, mismatched repository, ambiguous workspace, billing conflict, startup failure, duplicate idempotency key, and exact reuse of shared or isolated Developer workspace.

```ts
const result = await service.launch({
  commandId: 'qa-launch-1',
  taskId: task.id,
  expectedRevision: task.revision,
  actor: humanActor,
  trigger: 'manual',
});
expect(result.cycle.attemptId).toBe(task.currentAttemptId);
expect(result.session.workspaceId).toBe(developerSession.workspaceId);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/qa-execution-service.spec.ts src/tasks/attempt-service.spec.ts`

Expected: FAIL because QA launch is absent.

- [ ] **Step 3: Implement launch preflight and durable preparation**

Re-read the project, task, current attempt, terminal Developer cycle, completion report, session, and workspace. Require `review`, unblocked state, no active role cycle, matching repository identity, and safe workspace ownership. Snapshot the task, Developer report, QA policy, configuration, policy revision, automation generation, and rejection ordinal.

- [ ] **Step 4: Start QA truthfully**

Persist the QA session and cycle before driver startup. Compose a QA start request for the exact existing workspace. Expose only the `submit_qa_verdict` Mesh control plus source-reading and verification capabilities. Record startup diagnostics; on failure retain the failed cycle, leave the task in review, and return a pause-worthy error.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/tasks/qa-execution-service.spec.ts src/tasks/attempt-service.spec.ts`

Expected: PASS with no new worktree creation and no task transition on startup failure.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/tasks/qa-execution-service.ts apps/server/src/tasks/qa-execution-service.spec.ts apps/server/src/tasks/attempt-service.ts apps/server/src/tasks/attempt-service.spec.ts
git commit -m "feat(server): launch task QA"
```

### Task 6: Persist QA verdicts atomically

**Files:**
- Modify: `apps/server/src/tasks/qa-execution-service.ts`
- Modify: `apps/server/src/tasks/qa-execution-service.spec.ts`
- Modify: `apps/server/src/domain/task-lifecycle.ts`
- Test: `apps/server/src/domain/task-lifecycle.spec.ts`

**Interfaces:**
- Produces: `QaExecutionService.submitVerdict(input: QaSubmitVerdictInput): QaVerdictOutcome`.
- Produces validated manual terminal outcomes; Task 7 extends the transaction with autonomous completion or a durable rejection follow-up action.

- [ ] **Step 1: Write failing verdict tests**

Cover exact criterion IDs, duplicate/missing criteria, verified-with-failure, rejected-with-all-pass, wrong capability binding, non-current attempt, non-review task, terminal cycle replay, unexpected source changes, persistence failure, event ordering, and idempotent duplicate commands.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/qa-execution-service.spec.ts src/domain/task-lifecycle.spec.ts`

Expected: FAIL because verdict submission is absent.

- [ ] **Step 3: Implement strict report validation**

Compare criterion IDs as an exact set against the cycle snapshot. Require all `passed` for `verified`; require at least one `failed` or `skipped` for `rejected`. Compare recorded workspace state and reject verification when unexpected source changes are reported.

- [ ] **Step 4: Commit the terminal outcome atomically**

Inside one immediate transaction, re-read ownership, insert the report, close the cycle, append `task.qa_execution_changed`, and store the command result. In manual mode do not transition the task. Invalidate the QA capability only after commit and publish afterward.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/tasks/qa-execution-service.spec.ts src/domain/task-lifecycle.spec.ts`

Expected: PASS, proving manual verdicts leave the task in review.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/tasks/qa-execution-service.ts apps/server/src/tasks/qa-execution-service.spec.ts apps/server/src/domain/task-lifecycle.ts apps/server/src/domain/task-lifecycle.spec.ts
git commit -m "feat(server): record QA verdicts"
```

### Task 7: Implement bounded autonomous review actions

**Files:**
- Create: `apps/server/src/tasks/review-automation-service.ts`
- Test: `apps/server/src/tasks/review-automation-service.spec.ts`
- Modify: `apps/server/src/tasks/qa-execution-service.ts`
- Modify: `apps/server/src/tasks/qa-execution-service.spec.ts`
- Modify: `apps/server/src/tasks/developer-rework-service.ts`
- Test: `apps/server/src/tasks/attempt-service.spec.ts`

**Interfaces:**
- Produces: `ReviewAutomationService.afterDeveloperSubmission(input)`, `planQaVerdict(input, transaction)`, and `continueRejectedVerdict(input)`.
- Consumes: `QaExecutionService.launch`, existing same-session Developer resume boundary, QA repository automatic actions, task service, and project events.

- [ ] **Step 1: Write failing policy tests**

Cover manual no-op, autonomous QA launch, verified-to-done, first and second rejection resuming the same Claude session, third rejection pausing, human rework resetting generation and budget, stale source cycles, duplicate triggers, disabled policy, resume preflight failure, and action persistence failure.

```ts
await automation.afterQaVerdict({ taskId: task.id, cycleId: rejectedCycle.id });
expect(driver.resumeRequests.at(-1)?.sessionId).toBe(developerSession.claudeResumeId);
expect(repositories.qaExecutions.listPendingAutomationActions()).toEqual([]);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/review-automation-service.spec.ts src/tasks/attempt-service.spec.ts`

Expected: FAIL because the automation service is absent.

- [ ] **Step 3: Implement durable idempotent action creation**

Derive the key from `taskId`, `attemptId`, `sourceCycleId`, action kind, and automation generation. Re-read project policy and current task state before every action. A replay returns the stored result.

- [ ] **Step 4: Implement verified and rejected follow-up**

For verified QA, `QaExecutionService.submitVerdict` uses `planQaVerdict` inside its existing transaction to insert the report, close the cycle, append the authorized `review -> done` transition, complete the automatic action, and append ordered events as one outcome. For rejection, the verdict transaction stores the report and a durable follow-up action. `continueRejectedVerdict` handles ordinals one and two by appending immutable QA feedback, preparing a new Developer resume cycle, starting the same session, and transitioning to `in_progress` only after startup succeeds. For ordinal three, the verdict transaction records `automation_paused` and leaves the task in review without scheduling a follow-up.

- [ ] **Step 5: Preserve truth on resume failure**

Retain the QA report, feedback, failed cycle diagnostics, and automatic-action failure. Keep the task in review and publish the pause condition. Never call fresh-attempt launch.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/tasks/review-automation-service.spec.ts src/tasks/attempt-service.spec.ts`

Expected: PASS with exactly two automatic resumes and no fourth QA/Developer action after the third rejection.

- [ ] **Step 7: Commit**

```powershell
git add apps/server/src/tasks/review-automation-service.ts apps/server/src/tasks/review-automation-service.spec.ts apps/server/src/tasks/qa-execution-service.ts apps/server/src/tasks/qa-execution-service.spec.ts apps/server/src/tasks/developer-rework-service.ts apps/server/src/tasks/attempt-service.spec.ts
git commit -m "feat(server): automate bounded QA rework"
```

### Task 8: Expose QA controls through the driver and fake driver

**Files:**
- Modify: `apps/server/src/claude/driver.ts`
- Modify: `apps/server/src/claude/sdk-driver.ts`
- Test: `apps/server/src/claude/sdk-driver.contract.spec.ts`
- Modify: `apps/server/src/claude/fake-driver.ts`
- Test: `apps/server/src/claude/fake-driver.spec.ts`
- Modify: `apps/server/src/main.ts`
- Test: `apps/server/src/main.spec.ts`

**Interfaces:**
- Consumes: QA prompt, capability token, and `QaExecutionService.submitVerdict`.
- Produces: runtime composition for a QA session with `submit_qa_verdict(report)` bound to one active cycle.

- [ ] **Step 1: Write failing driver contract tests**

Assert QA start requests carry the QA role metadata, exact cwd, no source-authoring tools, one Mesh verdict control, and no Developer controls. Assert the fake driver can deterministically emit verified, rejected, wait, and startup-failure outcomes.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/claude/sdk-driver.contract.spec.ts src/claude/fake-driver.spec.ts src/main.spec.ts`

Expected: FAIL because the driver has no QA composition.

- [ ] **Step 3: Add role-scoped control composition**

Extend the start request with an optional role control server rather than embedding QA logic in the SDK adapter. Bind the tool closure to the issued capability token; the tool payload contains only the structured report.

- [ ] **Step 4: Extend the fake driver script vocabulary**

Add deterministic QA script steps consumed only under explicit test configuration:

```ts
type FakeQaStep =
  | { type: 'qa.verified'; report: QaReportInput }
  | { type: 'qa.rejected'; report: QaReportInput }
  | { type: 'qa.wait' }
  | { type: 'qa.startup_failure'; message: string };
```

- [ ] **Step 5: Compose production services in `main.ts`**

Instantiate QA repositories, capability registry, QA execution service, and review automation service beside the Milestone 3 services. Keep the billing-conflict driver guard in front of all role starts and resumes.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/claude/sdk-driver.contract.spec.ts src/claude/fake-driver.spec.ts src/main.spec.ts`

Expected: PASS without contacting Claude.

- [ ] **Step 7: Commit**

```powershell
git add apps/server/src/claude apps/server/src/main.ts apps/server/src/main.spec.ts
git commit -m "feat(server): expose QA runtime controls"
```

### Task 9: Add QA commands and HTTP error mapping

**Files:**
- Modify: `apps/server/src/http/command-handler.ts`
- Modify: `apps/server/src/http/command-handler.spec.ts`
- Modify: `apps/server/src/http/errors.ts`
- Test: `apps/server/src/http/routes.spec.ts`

**Interfaces:**
- Consumes: QA execution and automation services from Tasks 5-7.
- Produces: validated command dispatch and stable HTTP conflict/forbidden/error responses.

- [ ] **Step 1: Write failing command tests**

Cover human-only manual launch/pause/enable, QA-agent-only verdict submission, automation actor authorization, stale revision, invalid capability, incomplete report, rejection ceiling, unsafe workspace, resume unavailable, duplicate command, and current authoritative record in conflict responses.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/routes.spec.ts`

Expected: FAIL on unhandled QA command variants.

- [ ] **Step 3: Dispatch commands to narrow services**

Add exhaustive branches for every Task 1 command. Do not place QA lifecycle or automation decisions in the handler. Map domain errors to existing error-envelope conventions and never return capability tokens or raw driver objects.

- [ ] **Step 4: Trigger follow-up only after committed outcomes**

After a successful Developer review submission, invoke `afterDeveloperSubmission`. After a committed autonomous rejection with a pending follow-up action, invoke `continueRejectedVerdict`. Autonomous verification-to-done and third-rejection pause are already part of the verdict transaction. If rejected follow-up fails, return the committed QA outcome plus durable automation pause state; do not roll back or misreport the report.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/routes.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/http
git commit -m "feat(server): handle QA commands"
```

### Task 10: Reconcile interrupted QA and pending automatic actions

**Files:**
- Modify: `apps/server/src/tasks/reconcile-attempts.ts`
- Modify: `apps/server/src/tasks/reconcile-attempts.spec.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.spec.ts`

**Interfaces:**
- Produces repair kinds: `qa_cycle_without_trustworthy_outcome`, `qa_session_workspace_mismatch`, and `review_automation_action_incomplete`.
- Consumes pending automatic actions only to report them; restart does not automatically repeat an outcome-unknown action.

- [ ] **Step 1: Write failing restart tests**

Seed active QA cycles with interrupted, missing, completed, and mismatched sessions; seed pending actions before and after their target outcome. Assert restart closes no cycle with a guessed verdict, starts no driver, emits one idempotent repair event, invalidates ephemeral capabilities, and preserves completed truth.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/reconcile-attempts.spec.ts src/main.spec.ts`

Expected: FAIL because QA state is not reconciled.

- [ ] **Step 3: Extend reconciliation from durable truth**

Join QA cycles to sessions, attempts, workspaces, reports, and automatic actions. A valid terminal report wins. An active or pending record without a trustworthy runtime outcome produces a repair and automation pause; it is never replayed automatically.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/tasks/reconcile-attempts.spec.ts src/main.spec.ts`

Expected: PASS with zero driver create/resume calls during reconciliation.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/tasks/reconcile-attempts.ts apps/server/src/tasks/reconcile-attempts.spec.ts apps/server/src/main.ts apps/server/src/main.spec.ts
git commit -m "fix(server): reconcile QA execution"
```

### Task 11: Project QA events through snapshots and reconnect

**Files:**
- Modify: `apps/server/src/http/project-snapshots.ts`
- Modify: `apps/server/src/http/project-snapshots.spec.ts`
- Modify: `apps/web/src/state/projection.ts`
- Modify: `apps/web/src/state/reducer.ts`
- Modify: `apps/web/src/state/reducer.spec.ts`
- Modify: `apps/web/src/state/resync.spec.ts`

**Interfaces:**
- Produces projection maps `qaCyclesByAttemptId`, `qaReportsByCycleId`, and `reviewAutomationByTaskId`.
- Consumes ordered project events from Task 1 and snapshot repository reads from Task 2.

- [ ] **Step 1: Write failing snapshot and reducer tests**

Cover full QA snapshot assembly, ordered event application, duplicate suppression, gap detection, project-local refresh, configuration changes, cycle/report replacement by stable ID, automation pause state, and no cross-project contamination.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/http/project-snapshots.spec.ts; corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/state/resync.spec.ts`

Expected: FAIL because the snapshot and projection omit QA state.

- [ ] **Step 3: Assemble QA snapshot state**

Read cycles and reports in batches for the project's attempt IDs. Return only that project's records and cursor. Keep session snapshots independent.

- [ ] **Step 4: Apply QA events idempotently in the reducer**

Update maps by stable identity after the existing cursor check. A duplicate event changes nothing; a sequence gap requests only the owning project snapshot.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/http/project-snapshots.spec.ts; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/state/resync.spec.ts`

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/http/project-snapshots.ts apps/server/src/http/project-snapshots.spec.ts apps/web/src/state
git commit -m "feat: project QA history in realtime"
```

### Task 12: Add QA settings and task execution UI

**Files:**
- Create: `apps/web/src/projects/QaSettings.tsx`
- Test: `apps/web/src/projects/QaSettings.spec.tsx`
- Create: `apps/web/src/tasks/QaExecutionPanel.tsx`
- Test: `apps/web/src/tasks/QaExecutionPanel.spec.tsx`
- Modify: `apps/web/src/tasks/DeveloperExecutionPanel.tsx`
- Modify: `apps/web/src/tasks/DeveloperExecutionPanel.spec.tsx`
- Modify: `apps/web/src/tasks/TaskDrawer.tsx`
- Modify: `apps/web/src/tasks/TaskDrawer.spec.tsx`
- Modify: `apps/web/src/app/app.tsx`
- Modify: `apps/web/src/app/app.spec.tsx`

**Interfaces:**
- Consumes: projected QA configuration, cycles, reports, automation state, repairs, sessions, and command API.
- Produces: revision-safe QA settings, criterion comparison, manual controls, automation consent/pause, budget, progress, and repair feedback.

- [ ] **Step 1: Write failing settings tests**

Cover instruction editing, expected revision, stale-save feedback, policy selector, explicit subscription-use confirmation before `autonomous_review`, disabling automation without interrupting a running session, and no retroactive task processing.

- [ ] **Step 2: Write failing task-panel tests**

Cover manual `Start QA`, verified acceptance, rejected rework choice, autonomous upcoming action, immediate pause, remaining rejection budget, alternating Developer/QA history, side-by-side criterion evidence, unexpected source changes, startup/resume failure, and repair actions.

```tsx
expect(screen.getByText('2 autonomous rejections remaining')).toBeVisible();
expect(screen.getByRole('button', { name: 'Pause automation' })).toBeEnabled();
expect(screen.getByText('QA rejected')).toBeVisible();
```

- [ ] **Step 3: Run web tests and confirm RED**

Run: `corepack pnpm nx test web -- --run src/projects/QaSettings.spec.tsx src/tasks/QaExecutionPanel.spec.tsx src/tasks/DeveloperExecutionPanel.spec.tsx src/tasks/TaskDrawer.spec.tsx src/app/app.spec.tsx`

Expected: FAIL because QA components and wiring are absent.

- [ ] **Step 4: Implement `QaSettings`**

Use controlled drafts, current QA revision, explicit confirmation dialog, pending state, authoritative conflict refresh, and clear copy that autonomous review consumes Claude subscription quota but never API billing.

- [ ] **Step 5: Implement `QaExecutionPanel` and timeline composition**

Render the current role, policy, remaining budget, cycle/session links, criterion results, commands/outcomes, limitations, workspace state, automatic actions, and exact pause reason. Expose only state-valid actions. Integrate QA cycles by timestamp/ordinal with the existing Developer execution history.

- [ ] **Step 6: Wire commands in `ConnectedApp`**

Follow existing command pending/error/refresh behavior. Keep button state local and durable task truth in the store. Resubscribe after QA launch because it creates a session.

- [ ] **Step 7: Run web tests and confirm GREEN**

Run: `corepack pnpm nx test web -- --run src/projects/QaSettings.spec.tsx src/tasks/QaExecutionPanel.spec.tsx src/tasks/DeveloperExecutionPanel.spec.tsx src/tasks/TaskDrawer.spec.tsx src/app/app.spec.tsx`

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/web/src/projects apps/web/src/tasks apps/web/src/app
git commit -m "feat(web): manage QA review loops"
```

### Task 13: Prove manual and autonomous workflows end to end

**Files:**
- Modify: `e2e/src/session-platform.spec.ts`
- Modify: `e2e/fixtures/fake-claude.ts`

**Interfaces:**
- Consumes: production-built server/web, temporary SQLite database and Git repositories, and explicit fake-driver QA scripts.
- Produces: browser-level proof for the milestone stop condition without external Claude traffic.

- [ ] **Step 1: Add a failing autonomous acceptance scenario**

Script this exact path: import repository, configure Developer and QA instructions, enable autonomous review with confirmation, create and ready a task, manually launch Developer, submit review, automatically launch QA, reject, resume the same Developer session, submit again, launch QA again, verify, transition to done, refresh, and confirm the full alternating audit history appears once.

```ts
await expect(page.getByText('QA rejected')).toBeVisible();
await expect(page.getByText('Developer resumed')).toBeVisible();
await expect(page.getByText('QA verified')).toBeVisible();
await expect(taskCard(page, taskTitle)).toHaveAttribute('data-column', 'done');
```

- [ ] **Step 2: Add failing manual and ceiling scenarios**

Prove manual verification waits for human acceptance, manual rejection waits for a human rework choice, and the third autonomous rejection displays a paused state with zero additional Developer resume requests.

- [ ] **Step 3: Run Chromium acceptance and confirm RED**

Run: `corepack pnpm nx e2e e2e -- --project=chromium --grep "QA review"`

Expected: FAIL until the fake fixture and integrated flow are complete.

- [ ] **Step 4: Extend deterministic fake-driver helpers**

Make QA steps role-aware and assert the same Developer resume ID is reused. Do not add time-based sleeps; release scripted steps through observable events or fixture drains.

- [ ] **Step 5: Run Chromium acceptance and confirm GREEN**

Run: `corepack pnpm nx e2e e2e -- --project=chromium --grep "QA review"`

Expected: PASS with the fake driver and temporary repository/database only.

- [ ] **Step 6: Commit**

```powershell
git add e2e
git commit -m "test(e2e): cover QA review loops"
```

### Task 14: Update durable guidance and run the complete gate

**Files:**
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/session-platform.md`

**Interfaces:**
- Documents: QA authority, exact-workspace execution, reports, manual/autonomous policies, rejection ceiling, pause and repair behavior, and subscription boundaries.

- [ ] **Step 1: Update architecture guidance**

Document `QaExecutionService`, `ReviewAutomationService`, QA capability invalidation, atomic outcome flow, project events, restart reconciliation, and the future scheduler boundary. State that verification commands may create ignored artifacts but QA receives no source-authoring tools and unexpected source changes pause the loop.

- [ ] **Step 2: Update operating guidance**

Document QA settings, explicit automation consent, manual workflow, autonomous loop, three-rejection ceiling, pause control, session/report inspection, safe recovery, and the fact that normal verification consumes no Claude quota.

- [ ] **Step 3: Run documentation and focused aggregate checks**

Run: `corepack pnpm exec prettier --check docs/development/architecture.md docs/development/session-platform.md docs/superpowers/specs/2026-08-26-milestone-4-qa-execution-design.md`

Expected: PASS.

- [ ] **Step 4: Run the complete deterministic gate**

Run: `corepack pnpm verify`

Expected: formatting, lint, typecheck, unit tests, builds, and Chromium acceptance all PASS. Do not run the real Claude smoke test.

- [ ] **Step 5: Inspect final scope and safety**

Run: `git status --short; git diff --check origin/master...HEAD; git diff --stat origin/master...HEAD`

Expected: only Milestone 4 contracts, storage, QA/task/runtime/control, web, tests, and durable docs changed. No credentials, runtime database, temporary repositories, screenshots, logs, or scratch files are tracked.

- [ ] **Step 6: Commit**

```powershell
git add docs/development
git commit -m "docs: explain QA execution workflow"
```

## Final Acceptance Review

- [ ] Every spec goal and affected surface maps to at least one task above.
- [ ] Existing project and attempt fixtures prove backward-compatible migration.
- [ ] Manual mode has no automatic transition or resume after a QA verdict.
- [ ] Autonomous mode starts QA only after a Developer review submission for the current task.
- [ ] Verified autonomous QA reaches done through an audited policy transition.
- [ ] Only the first two autonomous rejections resume the same Developer session.
- [ ] The third autonomous rejection pauses with all work and evidence preserved.
- [ ] QA runs only in the exact verified Developer workspace and receives no source-authoring tools.
- [ ] Unexpected source changes, ambiguous workspaces, startup/resume failure, audit failure, and outcome-unknown restart state pause safely.
- [ ] Reports cover every snapshotted criterion and are never inferred from transcript text or process exit.
- [ ] Automatic actions are durable and idempotent across duplicate delivery, reconnect, and restart.
- [ ] Project snapshots and ordered events reproduce configuration, cycles, reports, budget, and pause state.
- [ ] No scheduler, queue, lease, PM role, generic workflow engine, fresh-attempt fallback, cleanup, merge, PR, or API billing behavior entered scope.
- [ ] `corepack pnpm verify` passes without running the real Claude smoke test.
