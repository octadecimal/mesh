# Task 6 report: atomic Developer outcomes

## Delivered

- Added `DeveloperExecutionService.submitForReview()` and `markBlocked()`.
- Both resolve the server-side capability inside one immediate command transaction, reload the current task/attempt/cycle, validate the report and revision, then persist report, closed cycle, task, transition, and one `task.developer_execution_changed` event atomically.
- Duplicate command IDs return the original completed durable result before capability lookup. Failed transactions retain the capability; successful results publish after commit and invalidate the cycle capability.
- Added explicit lifecycle operation policy: an agent may only submit `in_progress -> review` with `developer_submit_review`, or block the same `in_progress` state with `developer_mark_blocked`. Other agent transitions remain unauthorized.

## RED evidence

1. Lifecycle policy test before implementation:

   ```text
   FAIL task lifecycle policy > permits a bound Developer policy only to submit its current work for review or block it
   Error: Only a human may transition a task to review
   ```

2. New execution-service test before implementation:

   ```text
   FAIL src/tasks/developer-execution-service.spec.ts
   Error: Cannot find module './developer-execution-service.js'
   ```

## GREEN evidence

```text
corepack pnpm vitest run apps/server/src/tasks/developer-execution-service.spec.ts apps/server/src/domain/task-lifecycle.spec.ts --config apps/server/vitest.config.ts
2 passed, 21 passed

corepack pnpm nx typecheck server
Successfully ran target typecheck for project server
```

The Vitest invocation emits existing Vite configuration deprecation warnings; both tests pass. Nx emits an environment `pnpm` lookup warning before running `tsc`, but the typecheck target completes successfully.

## Self-review

- `git diff --check` passed.
- Confirmed report/cycle/task/transition/event are inside `executeOnceInImmediateTransaction` and that publication occurs after it returns.
- Confirmed failure test proves task, cycle, transition history, and project event history remain unchanged and capability remains resolvable when event persistence fails.

## Fix Round 1

### Root cause and fix

`developerSubmission` verified Developer actor, operation, and lifecycle state but did not verify that the task was unblocked. The generic blocked guard only covers transitions *to* `in_progress`, so a blocked `in_progress -> review` submission was authorized. The predicate now requires `!task.blocked`.

### Added coverage

- Lifecycle policy rejects a Developer review submission for a blocked task.
- Execution service rejects a review outcome when the persisted task is in `review`, rather than `in_progress`.
- Execution service rejects a review outcome when the persisted task is blocked.
- Publisher callback observes the committed task, closed cycle, durable project event, and completion report payload before it returns.

### RED

```text
corepack pnpm vitest run apps/server/src/domain/task-lifecycle.spec.ts --config apps/server/vitest.config.ts

FAIL task lifecycle policy > rejects a Developer review submission while its task is blocked
AssertionError: expected function to throw an error, but it didn't

Test Files  1 failed
Tests  1 failed | 15 passed (16)
```

### GREEN

```text
corepack pnpm vitest run apps/server/src/tasks/developer-execution-service.spec.ts apps/server/src/domain/task-lifecycle.spec.ts --config apps/server/vitest.config.ts

Test Files  2 passed (2)
Tests  25 passed (25)

corepack pnpm nx typecheck server

NX   Successfully ran target typecheck for project server
```

Both commands emitted the pre-existing Vite configuration deprecation warning. The Nx command also printed the environment's `pnpm` lookup warning before successfully running `tsc`.
