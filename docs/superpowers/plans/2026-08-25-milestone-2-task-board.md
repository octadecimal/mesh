# Milestone 2 Task Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repository-backed projects, an audited task board, and durable task-to-session attempts to Mesh without introducing autonomous orchestration.

**Architecture:** Extend the existing Fastify/SQLite backend with a task-management domain and a per-project durable event stream. Keep sessions authoritative for runtime state, join them to tasks through attempt records, and rebuild the React board from project snapshots plus ordered events.

**Tech Stack:** Nx, pnpm, TypeScript, Zod, Fastify, better-sqlite3, WebSocket, React, Hookstate, Radix UI, Tailwind CSS, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-milestone-2-task-board-design.md`

## Global Constraints

- Never set or fall back to `ANTHROPIC_API_KEY`; all automated tests use the fake driver.
- Use temporary repositories and databases; never use the operator's runtime database, credentials, active worktree, or live sessions as test data.
- Persist normalized project events and required diagnostics before publishing them.
- Preserve existing project IDs, sessions, layouts, workspaces, discovery provenance, and repository paths through migration.
- One project is anchored to one validated Git repository; one session has at most one current task association.
- Human policy alone authorizes transitions into `review` and `done` in Milestone 2.
- Session completion never automatically advances a task.
- Keep manual rank independent of priority and defer dependencies, autonomous scheduling, generalized workflows, and multi-repository projects.
- Do not add permanent project or task deletion.
- Run focused tests after every task and `corepack pnpm verify` before completion.

---

## Planned File Structure

```text
packages/contracts/src/
├── domain.ts                         # Extend Project; add Task, TaskAttempt, TaskTransition
├── commands.ts                       # Project/task/attempt commands and command envelope variants
├── project-events.ts                 # Durable project event variants and envelope
├── http.ts                           # Project snapshot/history response schemas
├── realtime.ts                       # Session and project websocket message union
├── errors.ts                         # Stable task/project error codes shared by server and web
├── index.ts                          # Public exports
└── contracts.spec.ts                 # Round-trip and rejection tests

apps/server/src/
├── db/migrate.ts                     # Additive project/task/event migration
├── db/migrate.spec.ts                # Fresh and legacy database migration proof
├── domain/task-lifecycle.ts           # Pure readiness and transition policy
├── domain/task-lifecycle.spec.ts
├── repositories/project-repository.ts # Imported/archive/revision-aware project persistence
├── repositories/task-repository.ts
├── repositories/task-attempt-repository.ts
├── repositories/task-transition-repository.ts
├── repositories/project-event-repository.ts
├── repositories/repositories.spec.ts
├── projects/repository-identity.ts    # Canonical Git identity and duplicate detection
├── projects/repository-identity.spec.ts
├── tasks/task-service.ts              # Transactional task mutations and project events
├── tasks/task-service.spec.ts
├── tasks/attempt-service.ts           # Launch/link/unlink composition with session runtime
├── tasks/attempt-service.spec.ts
├── tasks/reconcile-attempts.ts        # Restart repair-state detection
├── tasks/reconcile-attempts.spec.ts
├── realtime/project-replay.ts         # Cursor replay and resync decision
├── realtime/project-replay.spec.ts
├── realtime/socket-hub.ts             # Multiplex session and project durable messages
├── realtime/socket-hub.spec.ts
├── http/project-snapshots.ts          # Project board snapshot/history reads
├── http/command-handler.ts             # Dispatch new application services
├── http/command-handler.spec.ts
├── http/errors.ts                      # Map typed domain errors
├── http/routes.ts                      # Snapshot/history endpoints
├── http/routes.spec.ts
├── test/create-test-database.ts        # Compose new repositories and failure hooks
├── main.ts                             # Production composition and startup reconciliation
└── main.spec.ts

apps/web/src/
├── api/client.ts                       # Project snapshot/history reads and command calls
├── api/socket.ts                       # Parse multiplexed websocket messages
├── api/socket.spec.ts
├── state/reducer.ts                    # Project projection and ordered event application
├── state/reducer.spec.ts
├── state/store.ts                      # Project resync integration
├── state/selectors.ts                  # Board/task/attempt selectors
├── projects/ProjectImportDialog.tsx
├── projects/ProjectImportDialog.spec.tsx
├── tasks/TaskBoard.tsx
├── tasks/TaskBoard.spec.tsx
├── tasks/TaskCard.tsx
├── tasks/TaskDrawer.tsx
├── tasks/TaskDrawer.spec.tsx
├── tasks/AttemptTimeline.tsx
├── app/app.tsx                         # Project/board navigation and command wiring
├── app/app.spec.tsx
└── styles.css                          # Board, drawer, status, and responsive styles

e2e/src/session-platform.spec.ts        # Fake-driver project/task/attempt journey
docs/development/architecture.md        # Task-domain ownership and event flow
docs/development/session-platform.md    # Task-attempt/session boundary and smoke-test scope
```

### Task 1: Define the task-management contracts

**Files:**
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/commands.ts`
- Create: `packages/contracts/src/project-events.ts`
- Modify: `packages/contracts/src/http.ts`
- Modify: `packages/contracts/src/realtime.ts`
- Create: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/contracts.spec.ts`

**Interfaces:**
- Consumes: Existing `idSchema`, `isoTimestampSchema`, `protocolVersionSchema`, session schemas, workspace schemas, and command envelope conventions.
- Produces: `projectSchema`, `taskSchema`, `taskAttemptSchema`, `taskTransitionSchema`, `attemptRepairSchema`, `taskCommandSchema`, `projectEventSchema`, `projectSnapshotSchema`, `projectHistorySchema`, `ProjectEvent`, and stable task/project error codes.

- [ ] **Step 1: Add failing contract tests for domain invariants**

Add fixtures that prove a backlog task may contain only a title, a blocked condition requires a reason, priorities are limited to `low | normal | high | urgent`, attempt sources are `launched | linked`, and one transition records actor, command ID, previous state, and next state.

```ts
expect(
  taskSchema.parse({
    id: 'task-1',
    projectId: 'project-1',
    title: 'Add retry controls',
    description: '',
    acceptanceCriteria: [],
    priority: 'normal',
    rank: 'm',
    lifecycleState: 'backlog',
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }),
).toMatchObject({ lifecycleState: 'backlog', revision: 1 });
expect(() =>
  blockedConditionSchema.parse({ reason: ' ', actor, blockedAt: now }),
).toThrow();
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: FAIL because the new schemas are not exported.

- [ ] **Step 3: Implement domain and error schemas**

Extend `projectSchema` additively with `repositoryIdentity`, `revision`, `createdAt`, `updatedAt`, and nullable `archivedAt`. Give migration-compatible fields defaults only where old wire payloads must still decode. Define explicit actor, blocked condition, task lifecycle, task, attempt, and transition schemas.

```ts
export const taskLifecycleStateSchema = z.enum([
  'backlog',
  'ready',
  'in_progress',
  'review',
  'done',
  'cancelled',
]);

export const taskActorSchema = z.object({
  type: z.enum(['human', 'system', 'agent']),
  id: idSchema,
  displayName: z.string().trim().min(1).optional(),
});

export const attemptRepairSchema = z.object({
  taskId: idSchema,
  attemptId: idSchema,
  sessionId: idSchema,
  reason: z.enum([
    'task_in_progress_without_live_session',
    'startup_outcome_unknown',
  ]),
});

export const stableTaskErrorCodeSchema = z.enum([
  'project_not_found',
  'project_archived',
  'repository_invalid',
  'repository_ambiguous',
  'repository_already_imported',
  'task_not_found',
  'task_revision_conflict',
  'task_not_ready',
  'task_blocked',
  'task_transition_invalid',
  'task_transition_unauthorized',
  'session_already_linked',
  'session_repository_mismatch',
  'attempt_start_failed',
  'attempt_reconciliation_required',
]);
```

- [ ] **Step 4: Add failing tests for commands, snapshots, events, and websocket messages**

Cover project import/archive/restore, task create/edit/reorder/block/unblock/transition, attempt launch/link/unlink, expected revisions, actor metadata, project event cursor, and both session and project websocket variants.

```ts
expect(
  taskCommandSchema.parse({
    type: 'task.transition',
    payload: {
      taskId: 'task-1',
      expectedRevision: 3,
      nextState: 'review',
      reason: 'Acceptance criteria implemented',
      actor,
    },
  }),
).toMatchObject({ type: 'task.transition' });
```

- [ ] **Step 5: Implement command, HTTP, project-event, and realtime schemas**

Use a dedicated per-project event envelope with `projectId` and monotonic `sequence`. Extend `serverMessageSchema` as a discriminated union without changing existing session message shapes.

```ts
export const projectEventSchema = z.discriminatedUnion('type', [
  projectChangedEventSchema,
  taskChangedEventSchema,
  taskTransitionedEventSchema,
  taskBlockChangedEventSchema,
  taskRankChangedEventSchema,
  taskAttemptChangedEventSchema,
]);

export const projectSnapshotSchema = z.object({
  protocolVersion: protocolVersionSchema,
  project: projectSchema,
  tasks: z.array(taskSchema),
  attempts: z.array(taskAttemptSchema),
  transitions: z.array(taskTransitionSchema),
  repairs: z.array(attemptRepairSchema),
  cursor: z.number().int().nonnegative(),
});
```

- [ ] **Step 6: Run contract tests**

Run: `corepack pnpm nx test contracts -- --run src/contracts.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src
git commit -m "feat(contracts): add task board protocol"
```

### Task 2: Add compatibility-safe task persistence

**Files:**
- Modify: `apps/server/src/db/migrate.ts`
- Test: `apps/server/src/db/migrate.spec.ts`
- Modify: `apps/server/src/test/create-test-database.ts`

**Interfaces:**
- Consumes: Task-management schemas from Task 1 and the existing sequential migration runner.
- Produces: Extended `projects` columns plus `tasks`, `task_attempts`, `task_transitions`, and `project_events` tables and indexes.

- [ ] **Step 1: Write failing fresh-database and legacy-migration tests**

Seed the pre-Milestone-2 schema with one discovered project, workspace, layout, and session. After migration, assert that IDs and relationships are unchanged, new project fields are populated, and all task tables exist.

```ts
expect(migratedProject.id).toBe('project-existing');
expect(migratedProject.repository_path).toBe(repositoryPath);
expect(migratedProject.revision).toBe(1);
expect(tableNames).toEqual(
  expect.arrayContaining([
    'tasks',
    'task_attempts',
    'task_transitions',
    'project_events',
  ]),
);
```

- [ ] **Step 2: Run migration tests and verify they fail**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts`

Expected: FAIL because the task tables and project columns do not exist.

- [ ] **Step 3: Add one additive migration**

Add project metadata columns without recreating project IDs. Backfill timestamps from `discovered_at`, set revision to one, and derive an initial repository identity from the canonical stored path; Task 5 will refresh it through Git validation when a project is used.

Create constraints and indexes equivalent to:

```sql
CREATE UNIQUE INDEX task_attempts_one_current_task_per_session
  ON task_attempts(session_id)
  WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX task_attempts_task_ordinal
  ON task_attempts(task_id, ordinal);
CREATE UNIQUE INDEX project_events_sequence
  ON project_events(project_id, sequence);
CREATE UNIQUE INDEX project_events_id
  ON project_events(id);
CREATE INDEX tasks_board_order
  ON tasks(project_id, lifecycle_state, rank, id);
```

Store JSON fields as normalized JSON text and enforce foreign keys from tasks to projects, attempts to tasks/sessions, transitions to tasks, and project events to projects.

- [ ] **Step 4: Extend the temporary database fixture**

Return composed task, attempt, transition, and project-event repositories from `createTestRepositories`. Add scoped failure options `failProjectEventInsert` and `failTaskTransitionInsert` for later audit-failure tests.

- [ ] **Step 5: Run migration tests**

Run: `corepack pnpm nx test server -- --run src/db/migrate.spec.ts`

Expected: PASS for both fresh and migrated databases.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db apps/server/src/test/create-test-database.ts
git commit -m "feat(server): migrate task board storage"
```

### Task 3: Implement project and task repositories

**Files:**
- Modify: `apps/server/src/repositories/project-repository.ts`
- Create: `apps/server/src/repositories/task-repository.ts`
- Create: `apps/server/src/repositories/task-attempt-repository.ts`
- Create: `apps/server/src/repositories/task-transition-repository.ts`
- Create: `apps/server/src/repositories/project-event-repository.ts`
- Test: `apps/server/src/repositories/repositories.spec.ts`

**Interfaces:**
- Consumes: Task 1 schemas and Task 2 tables.
- Produces: Revision-aware repositories, append-only history APIs, transactional event append, and cursor reads.

- [ ] **Step 1: Write failing repository behavior tests**

Prove project lookup by repository identity, revision-guarded task update, board ordering, monotonic attempt ordinals, preserved unlink history, append-only transitions, event sequences, and duplicate event/command rejection.

```ts
expect(tasks.update(task, 1)?.revision).toBe(2);
expect(tasks.update({ ...task, title: 'stale' }, 1)).toBeUndefined();
expect(attempts.createForTask(task.id, session.id, 'linked', actor).ordinal).toBe(1);
expect(() => attempts.createForTask(otherTask.id, session.id, 'linked', actor)).toThrow();
expect(events.after(project.id, 0).map((event) => event.sequence)).toEqual([1, 2]);
```

- [ ] **Step 2: Run repository tests and verify they fail**

Run: `corepack pnpm nx test server -- --run src/repositories/repositories.spec.ts`

Expected: FAIL because the repositories are missing.

- [ ] **Step 3: Implement focused repository classes**

Expose these stable APIs:

```ts
class TaskRepository {
  create(task: Task): Task;
  get(id: string): Task | undefined;
  listByProject(projectId: string): Task[];
  update(task: Task, expectedRevision: number): Task | undefined;
}

class TaskAttemptRepository {
  create(attempt: TaskAttempt): TaskAttempt;
  getCurrentBySession(sessionId: string): TaskAttempt | undefined;
  listByTask(taskId: string): TaskAttempt[];
  unlink(id: string, actor: TaskActor, reason: string, at: string): TaskAttempt;
}

class TaskTransitionRepository {
  append(transition: TaskTransition): TaskTransition;
  listByTask(taskId: string): TaskTransition[];
}

class ProjectEventRepository {
  append(projectId: string, draft: ProjectEventDraft): ProjectEvent;
  after(projectId: string, sequence: number): ProjectEvent[];
  latestSequence(projectId: string): number;
}
```

Use prepared statements and contract parsing at repository boundaries. Do not put lifecycle or authorization decisions in repositories.

- [ ] **Step 4: Extend `ProjectRepository` without retaining permanent removal**

Add `getByRepositoryIdentity`, revision-aware `update`, and archive/restore support. Remove new application usage of `remove`; if legacy tests require the method for fixture cleanup, keep it non-exported from command behavior.

- [ ] **Step 5: Run repository tests**

Run: `corepack pnpm nx test server -- --run src/repositories/repositories.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/repositories apps/server/src/test/create-test-database.ts
git commit -m "feat(server): persist tasks and attempts"
```

### Task 4: Encode readiness, lifecycle, and human transition policy

**Files:**
- Create: `apps/server/src/domain/task-lifecycle.ts`
- Test: `apps/server/src/domain/task-lifecycle.spec.ts`

**Interfaces:**
- Consumes: `Task`, `TaskActor`, and `TaskLifecycleState` from contracts.
- Produces: `readinessProblems(task)`, `allowedTaskTransitions(task)`, and `authorizeTaskTransition(input)`.

- [ ] **Step 1: Write the lifecycle state-table tests**

Cover forward transitions, rework transitions, cancelled restoration, done/cancelled launch rejection, readiness fields, blocked launch rejection, and human-only review/done authorization.

```ts
expect(readinessProblems(backlogTask)).toEqual([
  'description',
  'acceptanceCriteria',
]);
expect(allowedTaskTransitions(taskIn('review'))).toEqual([
  'in_progress',
  'done',
  'cancelled',
]);
expect(() =>
  authorizeTaskTransition({
    task: taskIn('in_progress'),
    nextState: 'review',
    actor: { type: 'agent', id: 'agent-1' },
    reason: 'finished',
  }),
).toThrow(TaskTransitionUnauthorizedError);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `corepack pnpm nx test server -- --run src/domain/task-lifecycle.spec.ts`

Expected: FAIL because the lifecycle module is missing.

- [ ] **Step 3: Implement the explicit transition table and typed errors**

```ts
const transitionTable: Record<TaskLifecycleState, readonly TaskLifecycleState[]> = {
  backlog: ['ready', 'cancelled'],
  ready: ['backlog', 'in_progress', 'cancelled'],
  in_progress: ['ready', 'review', 'cancelled'],
  review: ['in_progress', 'done', 'cancelled'],
  done: ['review'],
  cancelled: ['backlog'],
};
```

Require a non-empty reason for backward transitions, cancellation, restoration, blocking, and unblocking. Return structured readiness problems for the web rather than a prose-only error.

- [ ] **Step 4: Run lifecycle tests**

Run: `corepack pnpm nx test server -- --run src/domain/task-lifecycle.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain
git commit -m "feat(server): define task lifecycle policy"
```

### Task 5: Make project import explicit and repository-safe

**Files:**
- Create: `apps/server/src/projects/repository-identity.ts`
- Test: `apps/server/src/projects/repository-identity.spec.ts`
- Modify: `apps/server/src/http/command-handler.ts`
- Test: `apps/server/src/http/command-handler.spec.ts`
- Modify: `apps/server/src/http/errors.ts`

**Interfaces:**
- Consumes: Existing `resolveWorkspacePath` and Git process helpers, `ProjectRepository.getByRepositoryIdentity`, and `project.import` contract.
- Produces: `resolveRepositoryIdentity(path, pathOptions): Promise<RepositoryIdentity>` and explicit import/archive/restore command handling.

- [ ] **Step 1: Write repository identity tests**

Use temporary Git repositories to prove equivalent path spellings and a linked worktree resolve to stable identity fields, non-Git paths fail, and paths outside the allowed base fail through the existing boundary.

```ts
const identity = await resolveRepositoryIdentity(repositoryPath, pathOptions);
expect(identity).toMatchObject({
  canonicalPath: await realpath(repositoryPath),
  commonDirectory: expect.any(String),
});
```

- [ ] **Step 2: Run the identity tests and verify they fail**

Run: `corepack pnpm nx test server -- --run src/projects/repository-identity.spec.ts`

Expected: FAIL because the resolver is missing.

- [ ] **Step 3: Implement fail-closed Git identity resolution**

Resolve the workspace-safe real path, then use non-interactive Git commands to read the absolute common directory and top-level working tree. Normalize Windows case and separators only for comparison; retain canonical display paths.

- [ ] **Step 4: Write failing command tests for explicit import and archive protections**

Assert import creates one project, duplicate identity returns `repository_already_imported` with the existing project, discovery suggestions do not persist, archive rejects a running task attempt, and restore increments project revision.

- [ ] **Step 5: Implement project commands and stop discovery-side creation**

Change `discoverProjects` to return suggestions separately from persisted projects. Route `project.import`, `project.rename`, `project.archive`, and `project.restore` through idempotent command handling. Keep pre-existing discovered project records valid as imported records.

- [ ] **Step 6: Map typed project errors**

Add stable HTTP mappings: invalid/ambiguous repository `400`, missing project `404`, duplicate import `409`, stale revision `409`, archived or running-attempt conflict `409`.

- [ ] **Step 7: Run focused project tests**

Run: `corepack pnpm nx test server -- --run src/projects/repository-identity.spec.ts src/http/command-handler.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/projects apps/server/src/http
git commit -m "feat(server): import repository projects"
```

### Task 6: Implement transactional task commands and project events

**Files:**
- Create: `apps/server/src/tasks/task-service.ts`
- Test: `apps/server/src/tasks/task-service.spec.ts`
- Modify: `apps/server/src/http/command-handler.ts`
- Modify: `apps/server/src/http/errors.ts`

**Interfaces:**
- Consumes: Task repositories, lifecycle policy, command idempotency, and project event repository.
- Produces: `TaskService.create`, `edit`, `reorder`, `block`, `unblock`, and `transition`, each returning canonical records plus persisted events.

- [ ] **Step 1: Write failing service tests for each mutation**

Assert canonical row, transition/history row, and project event commit together; stale revisions and duplicate command IDs do not mutate twice; audit insert failure rolls the transaction back; and session completion has no task mutation path.

```ts
await expect(
  service.transition({
    commandId: 'command-1',
    taskId: task.id,
    expectedRevision: 2,
    nextState: 'review',
    reason: 'Criteria satisfied',
    actor: human,
  }),
).resolves.toMatchObject({ task: { lifecycleState: 'review', revision: 3 } });
expect(transitions.listByTask(task.id)).toHaveLength(1);
expect(events.after(project.id, 0)).toHaveLength(1);
```

- [ ] **Step 2: Run task-service tests and verify they fail**

Run: `corepack pnpm nx test server -- --run src/tasks/task-service.spec.ts`

Expected: FAIL because `TaskService` is missing.

- [ ] **Step 3: Implement one transaction boundary per task command**

Use `BEGIN IMMEDIATE`/commit/rollback through a small local transaction helper or the existing database transaction facility. Perform revision checks inside the transaction. Append normalized events before returning; publish only after the transaction commits.

```ts
export type TaskMutationResult = {
  task: Task;
  event: ProjectEvent;
  transition?: TaskTransition;
};
```

Use neighbor ranks for reorder and rebalance only when no rank exists between neighbors. Keep priority untouched.

- [ ] **Step 4: Wire commands and typed errors through the HTTP handler**

Dispatch each task command to `TaskService`; preserve the existing command response and idempotency conventions. Return the canonical updated task and project event cursor.

- [ ] **Step 5: Run task service and command-handler tests**

Run: `corepack pnpm nx test server -- --run src/tasks/task-service.spec.ts src/http/command-handler.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/tasks/task-service.ts apps/server/src/tasks/task-service.spec.ts apps/server/src/http
git commit -m "feat(server): handle audited task commands"
```

### Task 7: Add project snapshots, replay, and realtime delivery

**Files:**
- Create: `apps/server/src/http/project-snapshots.ts`
- Modify: `apps/server/src/http/routes.ts`
- Test: `apps/server/src/http/routes.spec.ts`
- Create: `apps/server/src/realtime/project-replay.ts`
- Test: `apps/server/src/realtime/project-replay.spec.ts`
- Modify: `apps/server/src/realtime/socket-hub.ts`
- Test: `apps/server/src/realtime/socket-hub.spec.ts`

**Interfaces:**
- Consumes: Project/task/attempt/transition repositories and per-project events.
- Produces: `GET /projects/:projectId/snapshot`, `GET /projects/:projectId/history?after=`, `ProjectReplayService.after`, and multiplexed project websocket messages.

- [ ] **Step 1: Write failing snapshot and history route tests**

Assert a snapshot returns only the requested project's records and latest cursor, missing projects return `404`, history validates non-negative cursors, and cross-project records cannot leak.

- [ ] **Step 2: Write failing replay tests**

```ts
expect(replay.after({ 'project-1': 4 })).toEqual({
  events: [eventAt(5)],
  resyncProjectIds: [],
});
expect(replay.after({ 'project-1': 1 }).resyncProjectIds).toContain('project-1');
```

Use a bounded retained-history condition rather than assuming all events are forever replayable in memory.

- [ ] **Step 3: Run route and replay tests and verify they fail**

Run: `corepack pnpm nx test server -- --run src/http/routes.spec.ts src/realtime/project-replay.spec.ts`

Expected: FAIL because project reads and replay do not exist.

- [ ] **Step 4: Implement project reads and replay**

Parse responses through shared contracts. Query attempts and transitions only for tasks in the selected project. Return ordered events and explicit project IDs requiring resynchronization.

- [ ] **Step 5: Extend socket delivery without changing session semantics**

Accept independent session and project cursors during subscription. Publish tagged `project.event` and `project.resync_required` messages only after committed events; keep existing session messages byte-compatible.

- [ ] **Step 6: Run snapshot, replay, socket, and security tests**

Run: `corepack pnpm nx test server -- --run src/http/routes.spec.ts src/realtime/project-replay.spec.ts src/realtime/socket-hub.spec.ts src/app.security.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/http apps/server/src/realtime
git commit -m "feat(server): stream durable project events"
```

### Task 8: Compose attempt launch, manual linking, and unlink history

**Files:**
- Create: `apps/server/src/tasks/attempt-service.ts`
- Test: `apps/server/src/tasks/attempt-service.spec.ts`
- Modify: `apps/server/src/http/command-handler.ts`
- Modify: `apps/server/src/http/errors.ts`

**Interfaces:**
- Consumes: Existing session-create/runtime registry boundary, repository identity resolver, TaskService transition API, attempt repository, and project events.
- Produces: `AttemptService.launch`, `link`, and `unlink` with explicit failure outcomes.

- [ ] **Step 1: Write failing launch outcome tests**

Cover ready/unblocked success, startup failure retaining the attempt and ready task, blocked/not-ready rejection before session creation, audit-write failure preventing startup, and transition-write failure interrupting the new runtime.

```ts
const result = await service.launch(launchInput);
expect(result.task.lifecycleState).toBe('in_progress');
expect(result.attempt.ordinal).toBe(1);
expect(registry.get(result.session.id)).toBeDefined();

driver.failNextStart(new Error('driver unavailable'));
await expect(service.launch(nextInput)).rejects.toMatchObject({
  code: 'attempt_start_failed',
});
expect(tasks.get(nextTask.id)?.lifecycleState).toBe('ready');
expect(attempts.listByTask(nextTask.id)).toHaveLength(1);
```

- [ ] **Step 2: Run launch tests and verify they fail**

Run: `corepack pnpm nx test server -- --run src/tasks/attempt-service.spec.ts`

Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement launch as an application-level saga**

Persist session metadata and attempt association before driver startup. After startup confirmation, call the audited TaskService transition. If that transition fails, request runtime interruption, persist a diagnostic through the existing diagnostic boundary, and return `attempt_reconciliation_required` if cleanup cannot be proven.

Do not place the process start inside a SQLite transaction and do not publish an attempt event before its audit transaction commits.

- [ ] **Step 4: Write and implement link/unlink tests**

Prove same-repository linking succeeds without changing task state, cross-repository and already-linked sessions fail, unlink requires a reason, and linking after unlink preserves both historical rows.

- [ ] **Step 5: Wire attempt commands through command handling**

Route `task.attempt.launch`, `task.attempt.link`, and `task.attempt.unlink` through the new service and map typed conflicts to stable HTTP errors.

- [ ] **Step 6: Run attempt and command tests**

Run: `corepack pnpm nx test server -- --run src/tasks/attempt-service.spec.ts src/http/command-handler.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/tasks/attempt-service.ts apps/server/src/tasks/attempt-service.spec.ts apps/server/src/http
git commit -m "feat(server): launch task session attempts"
```

### Task 9: Reconcile attempts after restart and compose production dependencies

**Files:**
- Create: `apps/server/src/tasks/reconcile-attempts.ts`
- Test: `apps/server/src/tasks/reconcile-attempts.spec.ts`
- Modify: `apps/server/src/main.ts`
- Test: `apps/server/src/main.spec.ts`

**Interfaces:**
- Consumes: Existing session recovery, task attempts, tasks, project events, diagnostics, and runtime registry.
- Produces: `reconcileTaskAttempts(dependencies): ReconciliationResult` using the shared `AttemptRepair` contract, and production composition for all new repositories/services.

- [ ] **Step 1: Write restart reconciliation tests**

Cover formerly live sessions becoming interrupted without automatic task movement, failed startup attempts retaining ready tasks, an in-progress task with no viable session becoming a repair condition, and a completed session leaving task state unchanged.

- [ ] **Step 2: Run reconciliation tests and verify they fail**

Run: `corepack pnpm nx test server -- --run src/tasks/reconcile-attempts.spec.ts src/main.spec.ts`

Expected: FAIL because reconciliation and composition are absent.

- [ ] **Step 3: Implement explicit repair-state reporting**

Return typed repair records rather than inventing task outcomes:

```ts
export type ReconciliationResult = {
  repairs: AttemptRepair[];
  events: ProjectEvent[];
};
```

Persist a project diagnostic event for each newly detected repair condition idempotently. Never transition a task during reconciliation.

- [ ] **Step 4: Compose repositories, services, replay, and startup recovery in `main.ts`**

Keep driver selection and billing-conflict behavior unchanged. Run existing session recovery before attempt reconciliation so task reconciliation sees canonical recovered session state.

- [ ] **Step 5: Run reconciliation and main tests**

Run: `corepack pnpm nx test server -- --run src/tasks/reconcile-attempts.spec.ts src/main.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/tasks/reconcile-attempts.ts apps/server/src/tasks/reconcile-attempts.spec.ts apps/server/src/main.ts apps/server/src/main.spec.ts
git commit -m "feat(server): reconcile task attempts"
```

### Task 10: Add the browser project projection and API integration

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/socket.ts`
- Test: `apps/web/src/api/socket.spec.ts`
- Modify: `apps/web/src/state/reducer.ts`
- Test: `apps/web/src/state/reducer.spec.ts`
- Modify: `apps/web/src/state/store.ts`
- Modify: `apps/web/src/state/selectors.ts`

**Interfaces:**
- Consumes: Project snapshot/history/realtime contracts from Task 1 and server endpoints from Task 7.
- Produces: `MeshProjection.projectsById`, `tasksById`, `attemptsById`, `projectCursors`, ordered `applyProjectEvent`, and project resync handling.

- [ ] **Step 1: Write failing reducer tests**

Prove snapshot replacement, ordered event application, duplicate suppression, gap detection, task rank update, transition update, and attempt association update while preserving the existing session projection.

```ts
const applied = applyProjectEvent(state, eventAt(4));
expect(applied.kind).toBe('applied');
expect(applied.state.projectCursors['project-1']).toBe(4);
expect(applyProjectEvent(applied.state, eventAt(6)).kind).toBe('gap');
```

- [ ] **Step 2: Run web state tests and verify they fail**

Run: `corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/api/socket.spec.ts`

Expected: FAIL because project messages and projection fields are unsupported.

- [ ] **Step 3: Implement API parsing and normalized projection updates**

Parse every server response through shared Zod contracts. Keep session and project cursors separate. On a project gap, fetch only that project's snapshot; do not replace unrelated session or project projections.

- [ ] **Step 4: Add selectors**

Expose stable selectors:

```ts
selectProject(state, projectId): Project | undefined;
selectBoardTasks(state, projectId): Record<BoardColumn, Task[]>;
selectTaskAttempts(state, taskId): Array<{ attempt: TaskAttempt; session?: Session }>;
selectTaskTransitions(state, taskId): TaskTransition[];
selectProjectRepairConditions(state, projectId): AttemptRepair[];
```

- [ ] **Step 5: Run state and socket tests**

Run: `corepack pnpm nx test web -- --run src/state/reducer.spec.ts src/api/socket.spec.ts`

Expected: PASS with all existing session reducer tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api apps/web/src/state
git commit -m "feat(web): project task board state"
```

### Task 11: Add explicit project import and board navigation

**Files:**
- Create: `apps/web/src/projects/ProjectImportDialog.tsx`
- Test: `apps/web/src/projects/ProjectImportDialog.spec.tsx`
- Modify: `apps/web/src/app/app.tsx`
- Test: `apps/web/src/app/app.spec.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Project commands/API, project suggestions, project snapshot store, and existing session navigation.
- Produces: Explicit import flow, project board route/view selection, archived-project read-only mode, and restore action.

- [ ] **Step 1: Write failing import dialog tests**

Cover manual path entry, suggestion selection, duplicate import response linking to the existing project, invalid path feedback, submit pending state, and no mutation from merely viewing suggestions.

- [ ] **Step 2: Run import tests and verify they fail**

Run: `corepack pnpm nx test web -- --run src/projects/ProjectImportDialog.spec.tsx`

Expected: FAIL because the component is missing.

- [ ] **Step 3: Implement the accessible import dialog**

Use existing Radix dialog/select primitives and command error presentation. Disable duplicate submits while the command is pending. Label suggestions as suggestions, not imported projects.

- [ ] **Step 4: Write failing app navigation tests**

Prove a project opens its board, session workspace remains reachable, archive makes the board read-only, restore re-enables commands, and cross-project selection loads the correct project snapshot.

- [ ] **Step 5: Wire navigation and import into `ConnectedApp`**

Keep the current session workspace intact. Add project-level navigation with `Board` and `Sessions` destinations rather than making Dockview own the board.

- [ ] **Step 6: Run app and import tests**

Run: `corepack pnpm nx test web -- --run src/projects/ProjectImportDialog.spec.tsx src/app/app.spec.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/projects apps/web/src/app apps/web/src/styles.css
git commit -m "feat(web): import project repositories"
```

### Task 12: Build the board, task cards, and validated drag behavior

**Files:**
- Create: `apps/web/src/tasks/TaskBoard.tsx`
- Create: `apps/web/src/tasks/TaskCard.tsx`
- Test: `apps/web/src/tasks/TaskBoard.spec.tsx`
- Modify: `apps/web/src/app/app.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Board selectors, create/reorder/transition commands, and task readiness fields.
- Produces: Full-width board columns, completed/cancelled filters, pending drag state, and selected-task callback.

- [ ] **Step 1: Write failing board rendering tests**

Assert the four active columns, priority and attempt summaries, blocked marker/reason, manual order, completed/cancelled filters, and archived read-only behavior.

- [ ] **Step 2: Write failing drag tests**

Prove same-column drop sends `task.reorder`, cross-column drop sends `task.transition`, the card stays pending until authoritative event/snapshot response, rejection restores its prior location, and dropping backlog into ready surfaces missing readiness fields.

```ts
await user.pointer(drag(card('Task A'), column('Ready')));
expect(sendCommand).toHaveBeenCalledWith(
  expect.objectContaining({ type: 'task.transition' }),
);
expect(card('Task A')).toHaveAttribute('data-pending', 'true');
```

- [ ] **Step 3: Run board tests and verify they fail**

Run: `corepack pnpm nx test web -- --run src/tasks/TaskBoard.spec.tsx`

Expected: FAIL because the board components are missing.

- [ ] **Step 4: Implement the board without a new drag framework unless required**

Use native pointer/drag events and accessible move actions first. Provide keyboard-accessible status and rank controls alongside drag. Add a dependency only if tests prove the native approach cannot meet accessibility or deterministic ordering requirements.

- [ ] **Step 5: Style the full-width board and responsive overflow**

Keep columns horizontally scrollable at narrow widths, preserve visible focus, and make blocked/pending/error states distinguishable without color alone.

- [ ] **Step 6: Run board and app tests**

Run: `corepack pnpm nx test web -- --run src/tasks/TaskBoard.spec.tsx src/app/app.spec.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/tasks/TaskBoard.tsx apps/web/src/tasks/TaskCard.tsx apps/web/src/tasks/TaskBoard.spec.tsx apps/web/src/app/app.tsx apps/web/src/styles.css
git commit -m "feat(web): add project task board"
```

### Task 13: Add the task drawer and attempt timeline

**Files:**
- Create: `apps/web/src/tasks/TaskDrawer.tsx`
- Create: `apps/web/src/tasks/AttemptTimeline.tsx`
- Test: `apps/web/src/tasks/TaskDrawer.spec.tsx`
- Modify: `apps/web/src/tasks/TaskBoard.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Selected task, attempt/session/transition selectors, task commands, existing workspace and permission-mode controls, and session-open callback.
- Produces: Right-side task drawer, execution-readiness editing, lifecycle/block actions, launch/link/unlink controls, and immutable history views.

- [ ] **Step 1: Write failing task editing and lifecycle tests**

Cover lightweight backlog creation, description/acceptance editing, stale-revision conflict resync, missing ready fields, block/unblock reasons, backward-transition reason, cancel/restore, and human review/done actions.

- [ ] **Step 2: Write failing attempt timeline tests**

Assert ordinal order, linked session state, failed launch visibility, unlinked history, open-session action, same-project link choices, and repair-condition warning.

- [ ] **Step 3: Run drawer tests and verify they fail**

Run: `corepack pnpm nx test web -- --run src/tasks/TaskDrawer.spec.tsx`

Expected: FAIL because the drawer and timeline are missing.

- [ ] **Step 4: Implement the Radix side drawer and controlled forms**

Reuse existing workspace-type and permission-mode inputs for start attempt. Keep form drafts local until submission. On a revision conflict, preserve the user's draft, show the server version, and require explicit retry rather than silently overwriting.

- [ ] **Step 5: Implement launch/link/unlink and session navigation**

Disable launch unless the task is ready, unblocked, and active. Do not move the card locally on launch success; wait for the authoritative project event. Require confirmation and reason for unlink.

- [ ] **Step 6: Run drawer, board, and session workspace tests**

Run: `corepack pnpm nx test web -- --run src/tasks/TaskDrawer.spec.tsx src/tasks/TaskBoard.spec.tsx src/workspace/SessionWorkspace.spec.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/tasks apps/web/src/styles.css
git commit -m "feat(web): manage task attempts"
```

### Task 14: Prove the integrated fake-driver workflow and document operations

**Files:**
- Modify: `e2e/src/session-platform.spec.ts`
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/session-platform.md`

**Interfaces:**
- Consumes: Complete server/web task workflow and existing fake-driver E2E harness.
- Produces: End-to-end regression proof and updated operator/developer documentation.

- [ ] **Step 1: Add the failing integrated task-board scenario**

Using only a temporary Git repository, temporary database, and fake driver:

```ts
test('imports a project and preserves an attempted task across refresh', async ({ page }) => {
  await importTemporaryRepository(page);
  await createReadyTask(page, {
    title: 'Add retry controls',
    description: 'Expose a safe retry action.',
    acceptanceCriteria: ['A failed session can be retried explicitly.'],
  });
  await launchFakeAttempt(page);
  await expect(taskCard(page, 'Add retry controls')).toContainText('In progress');
  await moveTaskToReviewAndDone(page, 'Add retry controls');
  await page.reload();
  await expect(doneTask(page, 'Add retry controls')).toBeVisible();
  await expect(attempt(page, 1)).toBeVisible();
});
```

Also cover failed startup leaving the task ready with a visible failed attempt.

- [ ] **Step 2: Run the E2E scenario and verify it fails**

Run: `corepack pnpm nx e2e e2e -- --grep "imports a project"`

Expected: FAIL until any missing integrated wiring, selectors, or test helpers are completed.

- [ ] **Step 3: Fix only integration gaps exposed by the scenario**

Keep fixes within the components and services introduced by Tasks 1-13. Add no orchestration, dependency, multi-repository, or generalized workflow behavior.

- [ ] **Step 4: Run the focused E2E scenario**

Run: `corepack pnpm nx e2e e2e -- --grep "imports a project"`

Expected: PASS using the fake driver with no Claude traffic.

- [ ] **Step 5: Update architecture and session-platform documentation**

Document project/task/attempt ownership, the separate per-project event stream, task launch composition, restart repair conditions, human-only Milestone-2 completion policy, and the opt-in status of real Claude smoke testing.

- [ ] **Step 6: Run documentation and complete verification gates**

Run:

```bash
corepack pnpm exec prettier --check "docs/**/*.md"
corepack pnpm verify
corepack pnpm e2e
```

Expected: all commands exit zero. `pnpm e2e` uses the deterministic fake driver and does not consume Claude subscription capacity.

- [ ] **Step 7: Inspect the final diff for scope and safety**

Run:

```bash
git diff --check origin/master...HEAD
git status --short
git diff --stat origin/master...HEAD
```

Expected: no whitespace errors, only planned source/test/documentation files, no databases, credentials, screenshots, logs, temporary repositories, or `.superpowers` scratch artifacts.

- [ ] **Step 8: Commit**

```bash
git add e2e/src/session-platform.spec.ts docs/development/architecture.md docs/development/session-platform.md
git commit -m "test: verify task board workflow"
```

## Completion Conditions

- Existing databases migrate without changing project, session, workspace, or layout IDs.
- Explicit import is the only path that creates future durable projects; discovery remains suggestion-only.
- Task readiness, lifecycle, blocking, ranking, cancellation, and restoration are backend-enforced and auditable.
- Attempt launch retains failed attempts, advances only after startup, and interrupts on post-start audit failure.
- Manual linking is same-repository, one-current-task-per-session, and historically reversible.
- Project snapshots and ordered project events recover independently of session streams.
- Board, drawer, archived views, conflicts, failures, and repair conditions are visible and testable.
- Autonomous agents have no Milestone-2 transition authority, while actor and policy contracts support adding it later.
- Focused suites, `corepack pnpm verify`, and deterministic `corepack pnpm e2e` pass.
- No real Claude smoke test is run unless the maintainer separately opts in.
