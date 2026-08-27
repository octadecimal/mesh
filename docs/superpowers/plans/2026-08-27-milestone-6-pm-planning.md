# Milestone 6 PM Planning and Task Dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proposal-only PM planning loop that atomically creates new backlog tasks and same-project dependency edges after explicit operator approval.

**Architecture:** Add concrete planning and dependency aggregates beside the existing task, Developer, QA, and project-run services. A read-only PM role submits immutable structured proposals through an ephemeral capability; human commands own revision, approval, rejection, cancellation, and dependency edits. Existing project snapshots, ordered events, and Hookstate projections carry compact planning and dependency truth, while full proposal history is fetched on demand.

**Tech Stack:** TypeScript 6, Zod, Fastify, SQLite/better-sqlite3, Claude Agent SDK role configuration and local MCP tools, React 19, Hookstate, Vitest, Testing Library, Playwright, Nx/pnpm.

**Spec:** `docs/superpowers/specs/2026-08-27-milestone-6-pm-planning-design.md`

## Global Constraints

- Never set, accept, or fall back to `ANTHROPIC_API_KEY` or another pay-per-token billing override.
- PM repository access is read-only: allow `Read`, `Glob`, `Grep`, and the plan-submission MCP tool; do not grant source-write, mutating shell, network-expansion, task, run, Developer, or QA tools.
- Persist planning, proposal, feedback, capability-generation, task, dependency, command, and project-event truth before publication or runtime action.
- Planning start captures an immutable base revision; every revision request captures a new immutable base before resuming Claude.
- Approval is additive: create new `backlog` tasks; never edit existing tasks or make an existing task depend on proposed work.
- Limit each proposal to 50 tasks and 200 dependency edges.
- Limit project snapshots to the active plan plus the 20 most recent terminal plan summaries; paginate older summaries through HTTP.
- Limit stale-plan error lists to 50 IDs per added, removed, and changed category; include total counts and truncation flags.
- Dependencies are same-project, unique, non-self, and acyclic. A proposed prerequisite may be another proposed task or a current non-cancelled existing task.
- Dependency edits require a human, a dependent task in `backlog` or `ready`, no active attempt, and an expected task revision.
- Dependencies never auto-transition or interrupt tasks. Recheck them on `backlog -> ready`, attempt launch, and project-run eligibility.
- One nonterminal planning cycle may exist per project. Project archive requires that cycle to be rejected or cancelled first.
- Transcript text and process exit never create a proposal. Only `mcp__mesh_pm__submit_project_plan` with a valid ephemeral capability may submit one.
- Routine tests use the fake driver, temporary repositories, and temporary databases. The real Claude planning smoke is opt-in and excluded from CI and `pnpm verify`.

---

## Planned File Structure

### Shared contracts

- Create `packages/contracts/src/planning.ts`: planning lifecycle, immutable base, proposal, feedback, repair, detail, and summary schemas.
- Create `packages/contracts/src/task-dependencies.ts`: task dependency and dependency-readiness schemas.
- Modify `packages/contracts/src/commands.ts`: nine human planning/dependency commands.
- Modify `packages/contracts/src/project-events.ts`: `project.plan_changed` and `task.dependencies_changed`.
- Modify `packages/contracts/src/http.ts`: project snapshot planning/dependency fields, paginated plan summaries, and plan-detail response.
- Modify `packages/contracts/src/errors.ts`: stable planning and dependency error codes.
- Modify `packages/contracts/src/index.ts`: public exports.
- Modify `packages/contracts/src/contracts.spec.ts`: schema, limits, event, command, and snapshot round trips.

### Persistence and domain

- Create `apps/server/src/db/migrations/017-pm-planning.sql`: planning, base, session, proposal, feedback, approval-mapping, and dependency tables.
- Modify `apps/server/src/db/migrate.ts` and `apps/server/src/db/migrate.spec.ts`: register and verify migration 017.
- Create `apps/server/src/repositories/planning-repository.ts` and `.spec.ts`: immutable planning aggregate persistence.
- Create `apps/server/src/repositories/task-dependency-repository.ts` and `.spec.ts`: current dependency truth.
- Modify `apps/server/src/test/create-test-database.ts`: expose both repositories to focused tests.
- Create `apps/server/src/domain/task-dependencies.ts` and `.spec.ts`: graph validation and incomplete-prerequisite calculation.
- Modify `apps/server/src/domain/task-lifecycle.ts` and `.spec.ts`: structured dependency readiness problems.

### Planning, task, and runtime services

- Create `apps/server/src/tasks/task-dependency-service.ts` and `.spec.ts`: human dependency mutations and ordered events.
- Modify `apps/server/src/tasks/task-service.ts` and `.spec.ts`: dependency-aware transitions and revision bumping.
- Modify `apps/server/src/tasks/project-run-policy.ts` and `.spec.ts`: exclude dependency-blocked tasks from frozen runs.
- Create `apps/server/src/domain/planning-policy.ts` and `.spec.ts`: versioned PM prompt and exact read-only tool set.
- Create `apps/server/src/tasks/planning-capability-registry.ts` and `.spec.ts`: ephemeral proposal capability lifecycle.
- Create `apps/server/src/tasks/planning-execution-service.ts` and `.spec.ts`: start, submit, revise, resume, retry, and cancel.
- Create `apps/server/src/tasks/plan-approval-service.ts` and `.spec.ts`: stale detection, rejection, and atomic application.
- Create `apps/server/src/tasks/reconcile-project-plans.ts` and `.spec.ts`: truthful restart reconciliation.
- Modify `apps/server/src/claude/driver.ts`, `sdk-adapter.ts`, `sdk-driver.ts`, `fake-driver.ts`, and their focused specs: PM role and MCP tool transport.
- Modify `apps/server/src/runtime/session-registry.ts` and `.spec.ts`: invalidate PM capability and reconcile stopped PM sessions.

### HTTP, realtime, and composition

- Modify `apps/server/src/http/command-handler.ts` and `.spec.ts`: route planning and dependency commands.
- Modify `apps/server/src/http/project-snapshots.ts` and `.spec.ts`: compact plan summaries and dependency edges.
- Modify `apps/server/src/http/routes.ts` and `routes.spec.ts`: plan-detail endpoint.
- Modify `apps/server/src/http/errors.ts`: stable status mapping.
- Modify `apps/server/src/app.ts`, `main.ts`, and their specs: compose repositories, services, runtime, audit barrier, and restart reconciliation.
- Modify `apps/server/src/realtime/project-replay.ts` and `.spec.ts`: replay new project events without special ordering rules.

### Web and integrated verification

- Modify `apps/web/src/state/reducer.ts`, `reducer.spec.ts`, `selectors.ts`, and `selectors.spec.ts`: project plan and dependency projection.
- Modify `apps/web/src/api/client.ts`: read full plan details.
- Create `apps/web/src/tasks/ProjectPlanningPanel.tsx` and `.spec.tsx`: operator planning and review flow.
- Modify `apps/web/src/tasks/TaskBoard.tsx` and `.spec.tsx`: mount planning panel and dependency-aware run preview.
- Modify `apps/web/src/tasks/TaskCard.tsx`: unmet-prerequisite count.
- Modify `apps/web/src/tasks/TaskDrawer.tsx` and `.spec.tsx`: dependency evidence and edits.
- Modify `apps/web/src/app/app.tsx`, `app.spec.tsx`, and `styles.css`: app wiring, layout, and accessible states.
- Modify `e2e/fixtures/fake-claude.ts` and `e2e/src/session-platform.spec.ts`: deterministic planning lifecycle acceptance.
- Modify `docs/development/architecture.md` and `docs/development/session-platform.md`: durable operator and development guidance.

---

### Task 1: Add planning and dependency contracts

**Files:**

- Create: `packages/contracts/src/planning.ts`
- Create: `packages/contracts/src/task-dependencies.ts`
- Modify: `packages/contracts/src/commands.ts`
- Modify: `packages/contracts/src/project-events.ts`
- Modify: `packages/contracts/src/http.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/contracts.spec.ts`

**Interfaces:**

- Consumes: existing `idSchema`, `isoTimestampSchema`, `taskActorSchema`, `taskSchema`, `sessionSchema`, and `protocolVersionSchema`.
- Produces: `ProjectPlan`, `ProjectPlanBase`, `ProjectPlanProposalInput`, `ProjectPlanProposal`, `ProjectPlanSummary`, `ProjectPlanHistoryPage`, `ProjectPlanDetails`, `TaskDependency`, new `MutatingCommand` variants, two `ProjectEvent` variants, and extended `ProjectSnapshot`.

- [ ] **Step 1: Write failing planning-schema tests**

Add contract tests that parse the full lifecycle, immutable base revisions, proposal-local and existing-task references, feedback, attention evidence, compact summaries, and full details. Assert 51 tasks and 201 edges fail while 50 tasks and 200 edges pass.

```ts
const proposal = projectPlanProposalSchema.parse({
  id: 'proposal-1',
  planId: 'plan-1',
  baseId: 'base-2',
  ordinal: 2,
  planRevision: 4,
  capabilityGeneration: 2,
  sessionId: 'session-1',
  tasks: [
    {
      key: 'contracts',
      title: 'Add contracts',
      description: 'Define the public planning boundary.',
      acceptanceCriteria: ['All new payloads parse through Zod.'],
      priority: 'high',
      labels: ['planning'],
      rationale: 'Consumers need stable types.',
      goalMapping: 'Enables durable planning.',
    },
  ],
  dependencies: [],
  assumptions: ['The repository is already imported.'],
  risks: ['Board state may change during planning.'],
  exclusions: ['No continuous scheduling.'],
  submittedAt: '2026-08-27T12:00:00.000Z',
});
expect(proposal.tasks[0]?.key).toBe('contracts');
```

- [ ] **Step 2: Write failing command, event, error, and snapshot tests**

Cover every command named in Global Constraints, human-only actors, required expected revisions, plan-detail response, compact snapshot fields, dependency events, and stable error-code parsing.

```ts
expect(
  mutatingCommandSchema.parse({
    type: 'project.plan.approve',
    payload: {
      projectId: 'project-1',
      planId: 'plan-1',
      proposalId: 'proposal-2',
      expectedPlanRevision: 4,
      actor: { type: 'human', id: 'operator-1' },
    },
  }).type,
).toBe('project.plan.approve');
```

- [ ] **Step 3: Run contract tests and confirm RED**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: FAIL because the planning and dependency modules and union members do not exist.

- [ ] **Step 4: Implement the shared schemas and exports**

Use these exact lifecycle and reference discriminants:

```ts
export const projectPlanStatusSchema = z.enum([
  'planning',
  'awaiting_review',
  'revising',
  'attention_required',
  'approved',
  'rejected',
  'cancelled',
]);

export const proposalPrerequisiteSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('proposal_task'), taskKey: idSchema }),
  z.object({ type: z.literal('existing_task'), taskId: idSchema }),
]);

export const projectPlanProposalInputSchema = z.object({
  tasks: z.array(projectPlanProposalTaskSchema).max(50),
  dependencies: z.array(projectPlanProposalDependencySchema).max(200),
  assumptions: z.array(z.string().trim().min(1)),
  risks: z.array(z.string().trim().min(1)),
  exclusions: z.array(z.string().trim().min(1)),
});
export type ProjectPlanProposalInput = z.infer<
  typeof projectPlanProposalInputSchema
>;

export const taskDependencySchema = z.object({
  projectId: idSchema,
  taskId: idSchema,
  prerequisiteTaskId: idSchema,
  createdBy: taskActorSchema,
  createdAt: isoTimestampSchema,
});
```

Represent readiness problems as:

```ts
export const taskReadinessProblemSchema = z.union([
  z.enum(['title', 'description', 'acceptanceCriteria', 'priority']),
  z.object({ type: z.literal('dependency_incomplete'), taskId: idSchema }),
]);
```

- [ ] **Step 5: Run contract tests and confirm GREEN**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: PASS with every new schema round trip and limit assertion green.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add pm planning types"
```

---

### Task 2: Add reversible planning storage

**Files:**

- Create: `apps/server/src/db/migrations/017-pm-planning.sql`
- Modify: `apps/server/src/db/migrate.ts`
- Modify: `apps/server/src/db/migrate.spec.ts`

**Interfaces:**

- Consumes: Task 1 IDs, lifecycle values, and serialized contract shapes.
- Produces: normalized storage for plans, bases, sessions, proposals, feedback, approval mappings, and current dependency truth.

- [ ] **Step 1: Write failing fresh and upgrade migration tests**

Add `017-pm-planning.sql` to every production-build migration manifest fixture. Prove a fresh database has all tables and an existing migration-016 database upgrades without changing current project, task, attempt, execution, run, or event rows.

```ts
expect(
  tableNames(database),
).toEqual(
  expect.arrayContaining([
    'project_plans',
    'project_plan_bases',
    'project_plan_sessions',
    'project_plan_proposals',
    'project_plan_proposal_tasks',
    'project_plan_proposal_dependencies',
    'project_plan_feedback',
    'project_plan_task_mappings',
    'task_dependencies',
  ]),
);
```

- [ ] **Step 2: Run migration tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts`

Expected: FAIL because migration 017 and its tables are absent.

- [ ] **Step 3: Implement migration 017 and register it**

The migration must include a partial unique index for one nonterminal plan and database-enforced pair uniqueness:

```sql
CREATE UNIQUE INDEX project_plans_one_nonterminal_per_project
ON project_plans(project_id)
WHERE status IN (
  'planning',
  'awaiting_review',
  'revising',
  'attention_required'
);

CREATE TABLE task_dependencies (
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  prerequisite_task_id TEXT NOT NULL REFERENCES tasks(id),
  created_by_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, prerequisite_task_id),
  CHECK (task_id <> prerequisite_task_id)
);
```

Store proposal task order and dependency order explicitly. Store base task snapshots and dependency edges as normalized JSON documents so equality and bounded stale diffs use the exact captured representation.

- [ ] **Step 4: Run migration tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts`

Expected: PASS for fresh, upgrade, production-build, and constraint tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db
git commit -m "feat(server): add pm planning storage"
```

---

### Task 3: Implement planning and dependency repositories

**Files:**

- Create: `apps/server/src/repositories/planning-repository.ts`
- Create: `apps/server/src/repositories/planning-repository.spec.ts`
- Create: `apps/server/src/repositories/task-dependency-repository.ts`
- Create: `apps/server/src/repositories/task-dependency-repository.spec.ts`
- Modify: `apps/server/src/test/create-test-database.ts`
- Modify: `apps/server/src/repositories/repositories.spec.ts`

**Interfaces:**

- Consumes: Task 1 contract types and Task 2 tables.
- Produces: `PlanningRepository` and `TaskDependencyRepository` used by every later server task.

- [ ] **Step 1: Write failing planning-repository tests**

Prove cycle creation, one-active-plan enforcement, monotonic base/proposal/session ordinals, immutable prior revisions, ordered feedback, optimistic plan revision, compact summaries, full detail reconstruction, approval mappings, and terminal history.

```ts
const created = repository.create({
  plan,
  base,
  sessionId: 'pm-session-1',
});
const nextBase = repository.appendBase(created.id, created.revision, baseDraft);
expect(repository.getDetails(created.id)?.bases.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
expect(nextBase.ordinal).toBe(2);
```

- [ ] **Step 2: Write failing dependency-repository tests**

Prove create, duplicate rejection, list-by-project, ordered prerequisites and dependents, removal, cross-project query isolation, and deletion without loss of previously appended project events.

```ts
dependencies.create(edge);
expect(dependencies.listPrerequisites('task-b')).toEqual([edge]);
expect(dependencies.listDependents('task-a')).toEqual([edge]);
expect(dependencies.remove('task-b', 'task-a')).toBe(true);
```

- [ ] **Step 3: Run repository tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/repositories/planning-repository.spec.ts src/repositories/task-dependency-repository.spec.ts src/repositories/repositories.spec.ts`

Expected: FAIL because both repositories are absent.

- [ ] **Step 4: Implement exact repository surfaces**

```ts
export class PlanningRepository {
  create(input: CreatePlanningCycleInput): ProjectPlan;
  get(planId: string): ProjectPlan | undefined;
  getActiveByProject(projectId: string): ProjectPlan | undefined;
  listSummaries(projectId: string, options: { before?: string; limit: number }): ProjectPlanSummary[];
  getDetails(planId: string): ProjectPlanDetails | undefined;
  appendBase(planId: string, expectedRevision: number, input: CreatePlanBaseInput): ProjectPlanBase;
  appendSession(planId: string, expectedRevision: number, sessionId: string): ProjectPlan;
  appendProposal(input: AppendPlanProposalInput): ProjectPlanProposal;
  appendFeedback(input: AppendPlanFeedbackInput): ProjectPlanFeedback;
  update(planId: string, expectedRevision: number, update: ProjectPlanUpdate): ProjectPlan | undefined;
  recordApprovalMappings(planId: string, proposalId: string, mappings: readonly PlanTaskMapping[]): void;
}

export class TaskDependencyRepository {
  create(dependency: TaskDependency): TaskDependency;
  remove(taskId: string, prerequisiteTaskId: string): boolean;
  listByProject(projectId: string): TaskDependency[];
  listPrerequisites(taskId: string): TaskDependency[];
  listDependents(prerequisiteTaskId: string): TaskDependency[];
}
```

- [ ] **Step 5: Run repository tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/repositories/planning-repository.spec.ts src/repositories/task-dependency-repository.spec.ts src/repositories/repositories.spec.ts`

Expected: PASS with temporary SQLite databases only.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/repositories apps/server/src/test/create-test-database.ts
git commit -m "feat(server): persist plans and dependencies"
```

---

### Task 4: Add dependency graph and readiness policy

**Files:**

- Create: `apps/server/src/domain/task-dependencies.ts`
- Create: `apps/server/src/domain/task-dependencies.spec.ts`
- Modify: `apps/server/src/domain/task-lifecycle.ts`
- Modify: `apps/server/src/domain/task-lifecycle.spec.ts`

**Interfaces:**

- Consumes: `Task`, `TaskDependency`, and `TaskReadinessProblem` contracts.
- Produces: `validateDependencyGraph`, `incompletePrerequisiteIds`, and dependency-aware `authorizeTaskTransition`.

- [ ] **Step 1: Write failing graph-policy tests**

Cover unique edges, self edges, missing nodes, cross-project nodes, direct and transitive cycles, cancelled existing prerequisites at proposal time, stable output ordering, and incomplete prerequisite IDs.

```ts
let graphError: unknown;
try {
  validateDependencyGraph({
    tasks: [task('a'), task('b')],
    dependencies: [edge('a', 'b'), edge('b', 'a')],
  });
} catch (error) {
  graphError = error;
}
expect(graphError).toMatchObject({ code: 'task_dependency_cycle' });

expect(
  incompletePrerequisiteIds('b', [task('a', 'review'), task('b')], [edge('b', 'a')]),
).toEqual(['a']);
```

- [ ] **Step 2: Write failing lifecycle tests**

Pass incomplete prerequisite IDs into `authorizeTaskTransition`. Prove `backlog -> ready` and any transition to `in_progress` fail with structured dependency problems, while a reopened prerequisite does not mutate an already-active task.

```ts
let readinessError: unknown;
try {
  authorizeTaskTransition({
    task: taskIn('backlog'),
    nextState: 'ready',
    actor: human,
    incompletePrerequisiteIds: ['task-a'],
  });
} catch (error) {
  readinessError = error;
}
expect(readinessError).toMatchObject({
  problems: [{ type: 'dependency_incomplete', taskId: 'task-a' }],
});
```

- [ ] **Step 3: Run domain tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/domain/task-dependencies.spec.ts src/domain/task-lifecycle.spec.ts`

Expected: FAIL because graph and dependency readiness policy are absent.

- [ ] **Step 4: Implement pure graph and readiness functions**

Use deterministic DFS over IDs sorted by code-unit order. Extend the transition input without repository access:

```ts
type AuthorizeTaskTransitionInput = {
  task: Task;
  nextState: TaskLifecycleState;
  actor: TaskActor;
  reason?: string;
  blocked?: boolean;
  operation?: 'developer_submit_review' | 'developer_mark_blocked' | 'project_run_launch';
  incompletePrerequisiteIds?: readonly string[];
};
```

- [ ] **Step 5: Run domain tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/domain/task-dependencies.spec.ts src/domain/task-lifecycle.spec.ts`

Expected: PASS for all graph, reverse-state, and existing lifecycle cases.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain
git commit -m "feat(server): enforce task dependencies"
```

---

### Task 5: Integrate dependency mutations and launch gates

**Files:**

- Create: `apps/server/src/tasks/task-dependency-service.ts`
- Create: `apps/server/src/tasks/task-dependency-service.spec.ts`
- Modify: `apps/server/src/tasks/task-service.ts`
- Modify: `apps/server/src/tasks/task-service.spec.ts`
- Modify: `apps/server/src/tasks/project-run-policy.ts`
- Modify: `apps/server/src/tasks/project-run-policy.spec.ts`
- Modify: `apps/server/src/tasks/project-run-service.ts`
- Modify: `apps/server/src/tasks/project-run-service.spec.ts`

**Interfaces:**

- Consumes: Task 3 repositories and Task 4 domain policy.
- Produces: `TaskDependencyService.add/remove`, dependency-aware `TaskService.transition`, and dependency-aware frozen run selection.

- [ ] **Step 1: Write failing dependency-service tests**

Prove human-only authority, expected task revision, project ownership, allowed dependent lifecycle, no active attempt, cancelled prerequisite rejection, cycle rejection, dependent task revision bump, command idempotency, one transaction, event-before-publication, and audit failure rollback.

```ts
const result = await service.add({
  projectId: project.id,
  taskId: dependent.id,
  prerequisiteTaskId: prerequisite.id,
  expectedTaskRevision: dependent.revision,
  actor: human,
  commandId: 'dependency-add-1',
});
expect(result.task.revision).toBe(dependent.revision + 1);
expect(result.dependencies).toHaveLength(1);
```

- [ ] **Step 2: Write failing transition and run-policy tests**

Prove manual transition, manual attempt launch, project-run launch, server run selection, and browser-compatible expected task sets all exclude incomplete dependencies. Prove reopening a prerequisite does not change the dependent lifecycle or active attempt.

```ts
expect(
  selectEligibleRunTasks({
    project,
    tasks: [prerequisite, dependent],
    currentAttemptTaskIds: new Set(),
    dependencyBlockedTaskIds: new Set([dependent.id]),
  }).map(({ task }) => task.id),
).toEqual([prerequisite.id]);
```

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/task-dependency-service.spec.ts src/tasks/task-service.spec.ts src/tasks/project-run-policy.spec.ts src/tasks/project-run-service.spec.ts`

Expected: FAIL because services do not load or enforce dependency truth.

- [ ] **Step 4: Implement dependency service and integrations**

```ts
export type DependencyMutationInput = {
  projectId: string;
  taskId: string;
  prerequisiteTaskId: string;
  expectedTaskRevision: number;
  actor: TaskActor;
  commandId: string;
};

export type DependencyMutationResult = {
  task: Task;
  dependencies: TaskDependency[];
  event: ProjectEvent;
};

export class TaskDependencyService {
  add(input: DependencyMutationInput): Promise<DependencyMutationResult>;
  remove(input: DependencyMutationInput): Promise<DependencyMutationResult>;
  incompletePrerequisiteIds(taskId: string): string[];
  dependencyBlockedTaskIds(projectId: string): Set<string>;
}
```

Call `incompletePrerequisiteIds` inside `TaskService.transitionWithOperation` immediately before domain authorization. Pass `dependencyBlockedTaskIds` into `selectEligibleRunTasks`; re-read it inside `ProjectRunService.startRun` before comparing operator `expectedTasks`.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/tasks/task-dependency-service.spec.ts src/tasks/task-service.spec.ts src/tasks/project-run-policy.spec.ts src/tasks/project-run-service.spec.ts`

Expected: PASS without changing existing task or run ordering.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/tasks
git commit -m "feat(server): gate work on dependencies"
```

---

### Task 6: Add the read-only PM policy and capability transport

**Files:**

- Create: `apps/server/src/domain/planning-policy.ts`
- Create: `apps/server/src/domain/planning-policy.spec.ts`
- Create: `apps/server/src/tasks/planning-capability-registry.ts`
- Create: `apps/server/src/tasks/planning-capability-registry.spec.ts`
- Modify: `apps/server/src/claude/driver.ts`
- Modify: `apps/server/src/claude/sdk-adapter.ts`
- Modify: `apps/server/src/claude/sdk-adapter.spec.ts`
- Modify: `apps/server/src/claude/sdk-driver.ts`
- Modify: `apps/server/src/claude/sdk-driver.contract.spec.ts`
- Modify: `apps/server/src/claude/fake-driver.ts`
- Modify: `apps/server/src/claude/fake-driver.spec.ts`

**Interfaces:**

- Consumes: planning proposal input schema from Task 1.
- Produces: `PM_POLICY_VERSION`, `buildPmPrompt`, `PlanningCapabilityRegistry`, `PmRuntimeConfiguration`, and the `mcp__mesh_pm__submit_project_plan` transport callback.

- [ ] **Step 1: Write failing policy and capability tests**

Prove the prompt includes goal, constraints, non-goals, exact base identity, current tasks and dependencies, proposal limits, authority denials, and structured tool requirement. Prove capability binding, expiry, session/plan/base/revision/generation mismatch, invalid-payload reuse, accepted-submission consumption, restart loss, and session invalidation.

```ts
expect(PM_AVAILABLE_TOOLS).toEqual([
  'Read',
  'Glob',
  'Grep',
  'mcp__mesh_pm__submit_project_plan',
]);
expect(buildPmPrompt(input)).toContain('You cannot modify repository files');
```

- [ ] **Step 2: Write failing SDK and fake-driver contract tests**

Add a `role: 'pm'` runtime configuration. Assert only the exact four tools above are available and allowed, plan submission reaches the registered callback, unlisted shell/write/network tools are unavailable, and the fake driver can emit a deterministic proposal submission.

```ts
const pm: PmRuntimeConfiguration = {
  role: 'pm',
  initialPrompt: 'Plan the approved project goal.',
  availableTools: PM_AVAILABLE_TOOLS,
  allowedTools: PM_AVAILABLE_TOOLS,
  submitProposal: vi.fn(),
};
```

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/domain/planning-policy.spec.ts src/tasks/planning-capability-registry.spec.ts src/claude/sdk-adapter.spec.ts src/claude/sdk-driver.contract.spec.ts src/claude/fake-driver.spec.ts`

Expected: FAIL because PM policy, capability, and runtime transport do not exist.

- [ ] **Step 4: Implement concrete PM policy and runtime configuration**

Keep the existing Developer configuration and QA role behavior intact. Extend `AgentRuntimeConfiguration` with a dedicated PM branch rather than generalizing product roles:

```ts
export interface PmRuntimeConfiguration {
  role: 'pm';
  initialPrompt: string;
  availableTools: readonly string[];
  allowedTools: readonly string[];
  submitProposal: (input: ProjectPlanProposalInput) => Promise<unknown>;
}

export type AgentRuntimeConfiguration =
  | DeveloperRuntimeConfiguration
  | QaRuntimeConfiguration
  | PmRuntimeConfiguration;
```

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/domain/planning-policy.spec.ts src/tasks/planning-capability-registry.spec.ts src/claude/sdk-adapter.spec.ts src/claude/sdk-driver.contract.spec.ts src/claude/fake-driver.spec.ts`

Expected: PASS with no regression in Developer or QA tool lists.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/planning-policy* apps/server/src/tasks/planning-capability-registry* apps/server/src/claude
git commit -m "feat(server): add read-only pm runtime"
```

---

### Task 7: Implement the planning execution lifecycle

**Files:**

- Create: `apps/server/src/tasks/planning-execution-service.ts`
- Create: `apps/server/src/tasks/planning-execution-service.spec.ts`
- Modify: `apps/server/src/runtime/session-registry.ts`
- Modify: `apps/server/src/runtime/session-registry.spec.ts`

**Interfaces:**

- Consumes: `PlanningRepository`, project/task/dependency/session/workspace/event/command repositories, `PlanningCapabilityRegistry`, `buildPmPrompt`, `SessionRegistry.create/resume/interrupt`, repository identity resolution, and billing conflicts.
- Produces: `start`, `submitProposal`, `requestRevision`, `resume`, `retry`, and `cancel` methods returning `PlanningMutationResult`.

- [ ] **Step 1: Write failing start and submission tests**

Prove human authority, active project, one-active-plan, billing conflict refusal, repository identity, normalized base capture, canonical shared workspace reuse, policy/session/base persistence before runtime start, proposal limit and graph validation, invalid submission reuse, accepted generation consumption, ordered event publication, idempotent start, and startup attention evidence.

```ts
const started = await service.start({
  projectId: project.id,
  goal: 'Plan dependency-aware delivery.',
  constraints: 'Preserve current task authority.',
  nonGoals: 'Do not schedule continuously.',
  actor: human,
  commandId: 'plan-start-1',
});
expect(started.plan.status).toBe('planning');
expect(started.base.ordinal).toBe(1);
expect(registry.create.mock.invocationCallOrder[0]).toBeGreaterThan(
  appendEvent.mock.invocationCallOrder[0],
);
```

- [ ] **Step 2: Write failing revision, resume, retry, and cancel tests**

Prove revision feedback captures base ordinal two before same-session resume, interrupted resume issues a new capability generation, fresh retry appends a new session association, cancellation revokes capability before post-commit interruption, stale revisions fail, and interruption failure never restores authority.

```ts
const revised = await service.requestRevision({
  projectId: project.id,
  planId: started.plan.id,
  proposalId: 'proposal-1',
  expectedPlanRevision: started.plan.revision,
  feedback: 'Split persistence from runtime composition.',
  actor: human,
  commandId: 'plan-revise-1',
});
expect(revised.base.ordinal).toBe(2);
expect(registry.resume).toHaveBeenCalledTimes(1);
```

- [ ] **Step 3: Run service tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/planning-execution-service.spec.ts src/runtime/session-registry.spec.ts`

Expected: FAIL because the planning lifecycle service and PM invalidation hook are absent.

- [ ] **Step 4: Implement lifecycle methods and exact boundary**

```ts
export type StartPlanningInput = {
  projectId: string;
  goal: string;
  constraints: string;
  nonGoals: string;
  actor: TaskActor;
  commandId: string;
};

export type SubmitPlanningProposalInput = {
  capability: string;
  proposal: ProjectPlanProposalInput;
};

export type PlanControlInput = {
  projectId: string;
  planId: string;
  expectedPlanRevision: number;
  actor: TaskActor;
  commandId: string;
};

export type RequestPlanRevisionInput = PlanControlInput & {
  proposalId: string;
  feedback: string;
};

export type ResumePlanningInput = PlanControlInput;
export type RetryPlanningInput = PlanControlInput;
export type CancelPlanningInput = PlanControlInput & { reason: string };

export type PlanningMutationResult = {
  plan: ProjectPlan;
  base?: ProjectPlanBase;
  proposal?: ProjectPlanProposal;
  session?: Session;
  events: ProjectEvent[];
};

export class PlanningExecutionService {
  start(input: StartPlanningInput): Promise<PlanningMutationResult>;
  submitProposal(input: SubmitPlanningProposalInput): Promise<PlanningMutationResult>;
  requestRevision(input: RequestPlanRevisionInput): Promise<PlanningMutationResult>;
  resume(input: ResumePlanningInput): Promise<PlanningMutationResult>;
  retry(input: RetryPlanningInput): Promise<PlanningMutationResult>;
  cancel(input: CancelPlanningInput): Promise<PlanningMutationResult>;
}
```

Use one transaction for every durable state/event/command batch. Publish after commit, then perform runtime start/resume/interrupt. On runtime failure, commit a second `attention_required` event before returning the stable failure.

- [ ] **Step 5: Run service tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/tasks/planning-execution-service.spec.ts src/runtime/session-registry.spec.ts`

Expected: PASS for start, proposal, revision, recovery, cancellation, and audit-order cases.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/tasks/planning-execution-service* apps/server/src/runtime/session-registry*
git commit -m "feat(server): add pm planning lifecycle"
```

---

### Task 8: Apply approved plans atomically

**Files:**

- Create: `apps/server/src/tasks/plan-approval-service.ts`
- Create: `apps/server/src/tasks/plan-approval-service.spec.ts`

**Interfaces:**

- Consumes: planning/task/dependency/project/event/command repositories, Task 4 graph validation, and existing task rank conventions.
- Produces: `PlanApprovalService.approve/reject` and bounded stale-plan details.

- [ ] **Step 1: Write failing stale-diff and rejection tests**

Cover task add/remove/edit/transition/block/reorder, dependency change, project archive and policy revision changes, planning-event non-staleness, bounded changed-ID reporting, human-only rejection, reason requirement, and no board mutation on rejection.

```ts
let staleError: unknown;
try {
  await service.approve(staleInput);
} catch (error) {
  staleError = error;
}
expect(staleError).toMatchObject({
  code: 'project_plan_stale',
  details: {
    addedTaskIds: [],
    removedTaskIds: [],
    changedTaskIds: ['task-1'],
    dependenciesChanged: false,
    policyChanged: false,
  },
});
```

- [ ] **Step 2: Write failing approval-transaction tests**

Prove proposal-local key mapping, existing prerequisite mapping, proposal order to task rank, `backlog` creation, task provenance, dependency edges only for new dependents, non-cancelled existing prerequisite validation, combined graph cycle validation, one transaction, complete ordered event batch, idempotent duplicate delivery, and rollback on task/edge/event/command-completion failure.

```ts
const approved = await service.approve({
  projectId: project.id,
  planId: plan.id,
  proposalId: proposal.id,
  expectedPlanRevision: plan.revision,
  actor: human,
  commandId: 'plan-approve-1',
});
expect(approved.plan.status).toBe('approved');
expect(approved.createdTasks.map(({ lifecycleState }) => lifecycleState)).toEqual([
  'backlog',
  'backlog',
]);
expect(approved.taskMappings).toEqual([
  { taskKey: 'contracts', taskId: expect.any(String) },
  { taskKey: 'server', taskId: expect.any(String) },
]);
```

- [ ] **Step 3: Run approval tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/plan-approval-service.spec.ts`

Expected: FAIL because approval and stale comparison are absent.

- [ ] **Step 4: Implement approval and rejection**

```ts
export type ApproveProjectPlanInput = {
  projectId: string;
  planId: string;
  proposalId: string;
  expectedPlanRevision: number;
  actor: TaskActor;
  commandId: string;
};

export type RejectProjectPlanInput = Omit<
  ApproveProjectPlanInput,
  'proposalId'
> & { reason: string };

export type PlanApprovalResult = PlanningMutationResult & {
  createdTasks: Task[];
  dependencies: TaskDependency[];
  taskMappings: Array<{ taskKey: string; taskId: string }>;
};

export class PlanApprovalService {
  approve(input: ApproveProjectPlanInput): Promise<PlanApprovalResult>;
  reject(input: RejectProjectPlanInput): Promise<PlanningMutationResult>;
}
```

Append `project.plan_changed` first, then `task.changed` for each created task, then one `task.dependencies_changed` per new task with dependencies. Persist the entire batch and command result in the approval transaction; publish only after commit.

- [ ] **Step 5: Run approval tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/tasks/plan-approval-service.spec.ts`

Expected: PASS with zero partial rows after each injected failure.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/tasks/plan-approval-service*
git commit -m "feat(server): apply approved pm plans"
```

---

### Task 9: Wire commands, plan details, and server composition

**Files:**

- Modify: `apps/server/src/http/command-handler.ts`
- Modify: `apps/server/src/http/command-handler.spec.ts`
- Modify: `apps/server/src/http/routes.ts`
- Modify: `apps/server/src/http/routes.spec.ts`
- Modify: `apps/server/src/http/errors.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.spec.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.spec.ts`

**Interfaces:**

- Consumes: Tasks 5, 7, and 8 service methods and Task 3 `PlanningRepository.getDetails`.
- Produces: public HTTP command handling, paginated `GET /api/projects/:projectId/plans`, `GET /api/projects/:projectId/plans/:planId`, and production/test composition.

- [ ] **Step 1: Write failing command and route tests**

Cover all nine commands, human actor enforcement, command-ID forwarding, stable status/error mapping, plan ownership, missing plan/project, archived project, a 20-item paginated summary page with stable cursor ordering, detail schema parsing, and no raw capability values in responses or logs.

```ts
const response = await app.inject({
  method: 'GET',
  url: `/api/projects/${project.id}/plans/${plan.id}`,
});
expect(response.statusCode).toBe(200);
expect(projectPlanDetailsSchema.parse(response.json()).plan.id).toBe(plan.id);
```

- [ ] **Step 2: Write failing production composition tests**

Prove repositories and services share the production database, session stop invalidates PM capability, planning audit failure trips the existing origin/runtime audit barrier, start refuses billing overrides, and fake-driver test configuration can submit a proposal without external Claude traffic.

- [ ] **Step 3: Run HTTP and composition tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/routes.spec.ts src/app.spec.ts src/main.spec.ts`

Expected: FAIL because commands, route, error mapping, and composition are absent.

- [ ] **Step 4: Implement command dispatch and composition**

Add service boundaries rather than exposing repository mutation from HTTP:

```ts
type PlanningExecutionBoundary = Pick<
  PlanningExecutionService,
  'start' | 'requestRevision' | 'resume' | 'retry' | 'cancel'
>;

type PlanApprovalBoundary = Pick<PlanApprovalService, 'approve' | 'reject'>;
type TaskDependencyBoundary = Pick<TaskDependencyService, 'add' | 'remove'>;
```

Register planning capability invalidation beside Developer and QA invalidation in `SessionRegistry`. Reuse the existing central audit barrier callback for any committed planning-event failure.

- [ ] **Step 5: Run HTTP and composition tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/http/command-handler.spec.ts src/http/routes.spec.ts src/app.spec.ts src/main.spec.ts`

Expected: PASS without opening a real Claude session.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/http apps/server/src/app.ts apps/server/src/app.spec.ts apps/server/src/main.ts apps/server/src/main.spec.ts
git commit -m "feat(server): expose pm planning commands"
```

---

### Task 10: Reconcile planning state after restart

**Files:**

- Create: `apps/server/src/tasks/reconcile-project-plans.ts`
- Create: `apps/server/src/tasks/reconcile-project-plans.spec.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.spec.ts`
- Modify: `apps/server/src/runtime/session-registry.ts`
- Modify: `apps/server/src/runtime/session-registry.spec.ts`

**Interfaces:**

- Consumes: planning/session repositories, project events, invalidated capability registry, and existing interrupted-session recovery.
- Produces: `reconcileProjectPlans` returning committed events and repair evidence before server acceptance.

- [ ] **Step 1: Write failing reconciliation tests**

Cover `awaiting_review` without a live session, formerly live `planning` and `revising` sessions, a committed proposal winning over stale runtime state, attention persistence, missing/mismatched session association, terminal plan no-op, capability invalidation, idempotent repeated reconciliation, and audit insert failure.

```ts
const result = reconcileProjectPlans({ ...repositories, capabilities });
expect(result.attentionPlanIds).toEqual(['plan-planning']);
expect(repositories.plans.get('plan-review')?.status).toBe('awaiting_review');
expect(capabilities.size).toBe(0);
```

- [ ] **Step 2: Run reconciliation tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/tasks/reconcile-project-plans.spec.ts src/runtime/session-registry.spec.ts src/main.spec.ts`

Expected: FAIL because no plan reconciliation runs at startup or runtime stop.

- [ ] **Step 3: Implement reconciliation and startup ordering**

```ts
export const reconcileProjectPlans = (
  dependencies: ReconcileProjectPlansDependencies,
): { attentionPlanIds: string[]; events: ProjectEvent[] } =>
  dependencies.database.transaction(() => {
    // Derive only from committed plan, proposal, association, and session rows.
    return reconcileCommittedPlanningTruth(dependencies);
  })();
```

Run it after generic session interruption recovery and before HTTP acceptance. Publish its already-committed events through the existing cursor-based recovered-event path. A persistence failure must trip the central audit barrier.

- [ ] **Step 4: Run reconciliation tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/tasks/reconcile-project-plans.spec.ts src/runtime/session-registry.spec.ts src/main.spec.ts`

Expected: PASS with no inferred proposal or approval state.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tasks/reconcile-project-plans* apps/server/src/runtime/session-registry* apps/server/src/main*
git commit -m "feat(server): reconcile pm planning state"
```

---

### Task 11: Project planning and dependency projection

**Files:**

- Modify: `apps/server/src/http/project-snapshots.ts`
- Modify: `apps/server/src/http/project-snapshots.spec.ts`
- Modify: `apps/server/src/realtime/project-replay.ts`
- Modify: `apps/server/src/realtime/project-replay.spec.ts`
- Modify: `apps/web/src/state/reducer.ts`
- Modify: `apps/web/src/state/reducer.spec.ts`
- Modify: `apps/web/src/state/selectors.ts`
- Modify: `apps/web/src/state/selectors.spec.ts`
- Modify: `apps/web/src/state/resync.spec.ts`
- Modify: `apps/web/src/api/client.ts`

**Interfaces:**

- Consumes: compact plan summaries, active plan, current dependency edges, and new project events.
- Produces: project snapshot/replay convergence, `MeshProjection` planning/dependency maps, selectors, `MeshApi.projectPlanHistory`, and `MeshApi.projectPlanDetails`.

- [ ] **Step 1: Write failing snapshot and replay tests**

Prove active plan plus at most 20 most-recent terminal summaries, paginated older summaries, no full historical proposal payload in snapshot, current dependencies, one-transaction snapshot cursor, ordered replay, duplicate delivery, retained-history gaps, and resync convergence.

```ts
expect(snapshot.activePlan?.id).toBe('plan-active');
expect(snapshot.planSummaries).toEqual(
  expect.arrayContaining([expect.objectContaining({ id: 'plan-approved' })]),
);
expect(snapshot.dependencies).toEqual([dependency]);
expect(snapshot).not.toHaveProperty('proposalHistory');
```

- [ ] **Step 2: Write failing reducer and selector tests**

Cover project replacement, plan upsert, dependency replacement, dependency event task revision, task removal cleanup, duplicate/gap handling, unmet prerequisite IDs/counts, dependent IDs, and dependency-aware run preview.

```ts
expect(selectUnmetPrerequisiteIds(state, 'task-b')).toEqual(['task-a']);
expect(selectEligibleRunPreview(state, project.id).map(({ id }) => id)).toEqual([
  'task-a',
]);
```

- [ ] **Step 3: Run projection tests and confirm RED**

Run: `corepack pnpm nx test server -- --run src/http/project-snapshots.spec.ts src/realtime/project-replay.spec.ts`

Run: `corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/state/selectors.spec.ts src/state/resync.spec.ts`

Expected: FAIL because snapshots and projections omit plans and dependencies.

- [ ] **Step 4: Implement projection and client surfaces**

Add these maps to `MeshProjection`:

```ts
activePlanByProjectId: Record<string, ProjectPlanSummary | undefined>;
planSummariesByProjectId: Record<string, ProjectPlanSummary[]>;
dependenciesByTaskId: Record<string, TaskDependency[]>;
dependentsByTaskId: Record<string, TaskDependency[]>;
```

Add both read-only client calls from Task 9:

```ts
projectPlanHistory(
  projectId: string,
  before?: string,
): Promise<ProjectPlanHistoryPage>;
projectPlanDetails(
  projectId: string,
  planId: string,
): Promise<ProjectPlanDetails>;
```

- [ ] **Step 5: Run projection tests and confirm GREEN**

Run: `corepack pnpm nx test server -- --run src/http/project-snapshots.spec.ts src/realtime/project-replay.spec.ts`

Run: `corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/state/selectors.spec.ts src/state/resync.spec.ts`

Expected: PASS with snapshot and replay producing identical projection truth.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/http/project-snapshots* apps/server/src/realtime/project-replay* apps/web/src/state apps/web/src/api/client.ts
git commit -m "feat: project pm planning state"
```

---

### Task 12: Build the operator planning panel

**Files:**

- Create: `apps/web/src/tasks/ProjectPlanningPanel.tsx`
- Create: `apps/web/src/tasks/ProjectPlanningPanel.spec.tsx`
- Modify: `apps/web/src/tasks/TaskBoard.tsx`
- Modify: `apps/web/src/tasks/TaskBoard.spec.tsx`
- Modify: `apps/web/src/app/app.tsx`
- Modify: `apps/web/src/app/app.spec.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Consumes: project, sessions, active/recent plan summaries, `MeshApi.projectPlanHistory`, `MeshApi.projectPlanDetails`, `MutatingCommand`, connection state, and session-open callback.
- Produces: start, review, revise, approve, reject, cancel, resume, retry, history, and attention UI.

- [ ] **Step 1: Write failing start and active-state tests**

Cover goal, constraints, non-goals, exact read-only disclosure, subscription acknowledgement, archived/disconnected state, start payload, pending state without optimistic mutation, associated-session link, planning/revising/attention states, resume/retry/cancel visibility, and server error feedback.

```tsx
await user.type(screen.getByLabelText('Project goal'), 'Plan milestone 7');
await user.click(screen.getByRole('checkbox', { name: /subscription capacity/i }));
await user.click(screen.getByRole('button', { name: 'Start planning' }));
expect(onCommand).toHaveBeenCalledWith({
  type: 'project.plan.start',
  payload: expect.objectContaining({
    projectId: project.id,
    goal: 'Plan milestone 7',
  }),
});
```

- [ ] **Step 2: Write failing proposal-review tests**

Cover on-demand detail loading, ordered task contracts, accessible prerequisite/dependent lists, assumptions/risks/exclusions, goal mappings, revision history and feedback, 20 recent terminal summaries, paginated older-history loading, stale diff evidence and truncation counts, Approve, Request changes, Reject, Cancel, exact expected revisions, no graph library, loading/error/empty states, and authoritative refresh.

- [ ] **Step 3: Run component tests and confirm RED**

Run: `corepack pnpm nx test web -- --run src/tasks/ProjectPlanningPanel.spec.tsx src/tasks/TaskBoard.spec.tsx src/app/app.spec.tsx`

Expected: FAIL because the planning panel is absent.

- [ ] **Step 4: Implement the focused panel**

```ts
export type ProjectPlanningPanelProps = {
  project: Project;
  projection: MeshProjection;
  connected: boolean;
  loadDetails: (projectId: string, planId: string) => Promise<ProjectPlanDetails>;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onOpenSession?: (sessionId: string) => void;
};
```

Keep form, expanded rows, detail-cache, and pending-command state local. Read lifecycle, current revision, proposal identity, and session truth only from the authoritative projection/details response.

- [ ] **Step 5: Run component tests and confirm GREEN**

Run: `corepack pnpm nx test web -- --run src/tasks/ProjectPlanningPanel.spec.tsx src/tasks/TaskBoard.spec.tsx src/app/app.spec.tsx`

Expected: PASS with keyboard-accessible controls and no optimistic plan/task insertion.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/tasks/ProjectPlanningPanel* apps/web/src/tasks/TaskBoard* apps/web/src/app apps/web/src/styles.css
git commit -m "feat(web): add pm planning review"
```

---

### Task 13: Show and edit task dependencies

**Files:**

- Modify: `apps/web/src/tasks/TaskCard.tsx`
- Modify: `apps/web/src/tasks/TaskBoard.tsx`
- Modify: `apps/web/src/tasks/TaskBoard.spec.tsx`
- Modify: `apps/web/src/tasks/TaskDrawer.tsx`
- Modify: `apps/web/src/tasks/TaskDrawer.spec.tsx`
- Modify: `apps/web/src/tasks/ProjectRunPanel.tsx`
- Modify: `apps/web/src/tasks/ProjectRunPanel.spec.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Consumes: Task 11 unmet-prerequisite/dependent selectors and Task 1 dependency commands.
- Produces: dependency counts, evidence, task navigation, audited add/remove controls, and client preview parity with server run selection.

- [ ] **Step 1: Write failing card, drawer, and run-preview tests**

Cover unmet count, complete prerequisite suppression, full prerequisite/dependent lists, links to tasks, cancelled/reopened prerequisite copy, allowed dependency editing only for backlog/ready without active attempt, candidate filtering to same-project non-self tasks, expected revision payloads, cycle/conflict server errors, disconnected/archived state, and dependency-blocked run preview.

```tsx
expect(screen.getByText('1 unmet prerequisite')).toBeVisible();
await user.selectOptions(screen.getByLabelText('Add prerequisite'), prerequisite.id);
await user.click(screen.getByRole('button', { name: 'Add prerequisite' }));
expect(onCommand).toHaveBeenCalledWith({
  type: 'task.dependency.add',
  payload: {
    projectId: project.id,
    taskId: dependent.id,
    prerequisiteTaskId: prerequisite.id,
    expectedTaskRevision: dependent.revision,
    actor: operator,
  },
});
```

- [ ] **Step 2: Run component tests and confirm RED**

Run: `corepack pnpm nx test web -- --run src/tasks/TaskBoard.spec.tsx src/tasks/TaskDrawer.spec.tsx src/tasks/ProjectRunPanel.spec.tsx`

Expected: FAIL because current UI and run preview ignore dependency truth.

- [ ] **Step 3: Implement dependency evidence and controls**

Render accessible lists and ordinary selects/buttons; do not add a graph or drag dependency. Keep command pending state local and preserve current task selection behavior for navigation.

```tsx
const unmet = selectUnmetPrerequisiteIds(projection, task.id);
const editable =
  connected &&
  !project.archivedAt &&
  ['backlog', 'ready'].includes(task.lifecycleState) &&
  !hasCurrentAttempt;
```

- [ ] **Step 4: Run component tests and confirm GREEN**

Run: `corepack pnpm nx test web -- --run src/tasks/TaskBoard.spec.tsx src/tasks/TaskDrawer.spec.tsx src/tasks/ProjectRunPanel.spec.tsx`

Expected: PASS with server/client run preview parity.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/tasks apps/web/src/styles.css
git commit -m "feat(web): expose task dependencies"
```

---

### Task 14: Prove the integrated workflow and document operations

**Files:**

- Modify: `e2e/fixtures/fake-claude.ts`
- Modify: `e2e/src/session-platform.spec.ts`
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/session-platform.md`

**Interfaces:**

- Consumes: complete contracts, fake PM driver path, HTTP/realtime projection, planning panel, dependency UI, and existing deterministic verification gate.
- Produces: browser-level acceptance proof and durable operator/developer guidance.

- [ ] **Step 1: Extend the fake harness for PM submission**

Add a deterministic control that waits for a PM runtime, invokes its structured proposal callback, and records the received role/tool configuration. It must not shell out or access a real Claude installation.

```ts
await harness.submitProjectPlan({
  tasks: [proposalTask('foundation'), proposalTask('feature')],
  dependencies: [proposalDependency('feature', 'foundation')],
  assumptions: [],
  risks: [],
  exclusions: [],
});
```

- [ ] **Step 2: Write the full planning acceptance scenario**

Through the browser: start planning, assert read-only/subscription copy, submit proposal revision one, request changes, submit revision two against a refreshed base, approve, refresh, verify two backlog tasks and one dependency, reject premature ready transition, complete the prerequisite through seeded task truth, move the dependent ready, and confirm its appearance in the next finite-run preview.

Run: `corepack pnpm nx e2e e2e --project=chromium --grep "plans and approves dependency-aware work"`

Expected: FAIL until all integrated surfaces are wired.

- [ ] **Step 3: Write stale, restart, and cancellation acceptance scenarios**

Use fake/runtime controls to prove a board edit makes approval stale with no created rows, an awaiting-review plan survives server restart without a live PM, a formerly live planning session becomes attention-required, and cancellation revokes submission authority before session interruption.

Run: `corepack pnpm nx e2e e2e --project=chromium --grep "pm planning"`

Expected: PASS after the integrated behavior is complete.

- [ ] **Step 4: Update durable documentation**

Document:

- Planning/domain/runtime/repository ownership and audit ordering in `architecture.md`.
- Starting, reviewing, revising, approving, rejecting, cancelling, resuming, and retrying plans in `session-platform.md`.
- Dependency readiness, reopened prerequisites, finite-run wave boundaries, repair states, and read-only PM authority.
- The fact that normal verification uses the fake driver and the real PM smoke consumes subscription quota and remains opt-in.

- [ ] **Step 5: Run documentation and focused acceptance checks**

Run: `corepack pnpm exec prettier --check docs/development/architecture.md docs/development/session-platform.md docs/superpowers/specs/2026-08-27-milestone-6-pm-planning-design.md docs/superpowers/plans/2026-08-27-milestone-6-pm-planning.md`

Expected: PASS.

Run: `corepack pnpm nx e2e e2e --project=chromium --grep "pm planning|dependency-aware"`

Expected: PASS with the fake driver only.

- [ ] **Step 6: Run the complete deterministic gate**

Run: `corepack pnpm verify`

Expected: formatting, lint, typecheck, unit tests, production builds, and all Chromium acceptance tests PASS. Do not run the real Claude planning smoke.

- [ ] **Step 7: Inspect final scope and safety**

Run: `git status --short && git diff --check && git diff --stat origin/master...HEAD`

Expected: only Milestone 6 contracts, migration, repositories, planning/dependency domain and services, runtime adapters, HTTP/realtime state, web UI, deterministic tests, and durable documentation changed. No credentials, runtime database, temporary plans outside `docs/superpowers`, screenshots, logs, or scratch files are tracked.

- [ ] **Step 8: Commit**

```bash
git add e2e docs/development
git commit -m "test: prove pm planning workflow"
```
