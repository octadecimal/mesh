# Milestone 5 blocker fix report

Date: 2026-08-27
Implementation commit: `05da858d1dee48891dc50408a64379e97134bb52`
Worktree: `C:\code\mesh\.worktrees\milestone-5-project-orchestration-design`

## Status

Complete. The remaining workspace-safety blockers are fixed without a public
contract change or database migration. Focused verification and the normal
complete local/CI gate pass. No real Claude smoke test was run or authorized.

## Root-cause confirmation and fix

### Authoritative repository topology and HEAD

The root cause was confirmed: one imported `canonicalPath` did not describe the
complete Git common-directory worktree set, and repository identity did not
prove that `HEAD` resolved to the commit required by project-run worktree
creation.

`RepositoryIdentity` now uses the approved `ProcessRunner`/Git executable to
run `git worktree list --porcelain -z`, strictly parses complete records,
canonicalizes every returned root, rejects duplicate, malformed, incomplete,
failed, or unreadable topology, and requires the imported canonical path to be
a member. It also reports `headCommit` from `git rev-parse --verify
HEAD^{commit}` or `null` for an unborn/unresolvable HEAD. Project import remains
usable for an unborn repository.

Project-run preflight now rejects null HEAD, incomplete membership, and a
planned root equal to or below any associated worktree before
`ensureWorkspaceRoot`, Start, Resume, restart drain, or a new claim can proceed.

### Transactional protected-path occupancy

The root cause was confirmed: the correct live-state predicate existed only in
`AttemptService`, while manual create and registry resume could mutate the same
path from the reverse direction.

One repository-layer `assertWorkspaceAvailable` guard now owns the live states
(`idle`, `starting`, `running`, `waiting_for_approval`, and `interrupting`) and
stable `project_run_conflict` error. It refuses to run outside a caller-held
transaction and supports two policies:

- project-run reservation rejects every other live occupant of its path;
- manual create/resume rejects another live occupant only when the path is
  backed by a pending or active Mesh-owned worktree, including shared aliases.

Project-run reservation, manual workspace/session creation, and resume
configuration call the guard inside their `BEGIN IMMEDIATE` mutation
transaction. Resume excludes its own session ID, rolls back workspace and
permission changes on pre-attach failure, and prevalidates live attachment and
Claude resume authority before configuration. Ordinary shared/shared overlap
remains successful with `shared_workspace_collision` warning behavior.

A two-worker/two-connection SQLite race proves that project-run reservation and
manual protected-path entry serialize so exactly one workspace/session mutation
commits and the other receives `project_run_conflict`.

### Operational documentation

`session-platform.md` now documents the real sequence:

1. immediate reservation transaction;
2. Git filesystem worktree creation;
3. immediate activation/attempt/cycle/audit transaction.

It also documents bidirectional protected-worktree occupancy, warning-only
ordinary shared collisions, complete associated-worktree containment, unborn
HEAD rejection, and preserved reconciliation evidence across filesystem or
audit failure.

## Strict RED/GREEN evidence

1. Repository topology, HEAD, and preflight:
   - RED: identity/preflight run had 6 expected failures: associated roots and
     HEAD were absent, malformed topology resolved successfully, and associated
     containment plus unborn HEAD were accepted.
   - GREEN: 2 files, 14 tests passed.
2. Incomplete topology:
   - RED: a `worktree` record without HEAD/disposition resolved successfully.
   - GREEN: repository identity, 8 tests passed.
3. Failed topology enumeration:
   - RED: non-zero `worktree list` with safe-looking stdout resolved
     successfully.
   - GREEN: repository identity, 9 tests passed.
4. Reverse occupancy:
   - RED: manual create and aliased resume returned HTTP 200, and direct
     registry resume resolved instead of raising `project_run_conflict`.
   - GREEN: routes, registry, and attempt service, 88 tests passed.
5. Transaction ownership:
   - RED: the extracted occupancy check did not reject use outside a
     transaction.
   - GREEN: the focused guard contract passed; the repository suite later
     passed the two-connection race and same-session exclusion proof.
6. Unreadable associated root:
   - RED: canonicalization leaked raw `ENOENT` instead of stable
     `repository_ambiguous`.
   - GREEN: the targeted identity regression passed.
7. Failed duplicate resume:
   - RED: an already-live attachment rejected only after rewriting workspace
     and permission.
   - GREEN: the targeted registry regression passed with original values.
8. Missing Claude resume authority:
   - RED: the registry rejected only after rewriting workspace and permission.
   - GREEN: the targeted registry regression passed with original values.

The two-connection race, ordinary shared-collision compatibility, and prose
review are proof/compatibility checks. The prose intentionally has no brittle
source-text test, following the good-test guidance.

## Files changed

- `apps/server/src/projects/repository-identity.ts`
- `apps/server/src/projects/repository-identity.spec.ts`
- `apps/server/src/tasks/project-run-preflight.ts`
- `apps/server/src/tasks/project-run-preflight.spec.ts`
- `apps/server/src/repositories/workspace-occupancy.ts`
- `apps/server/src/repositories/repositories.spec.ts`
- `apps/server/src/tasks/attempt-service.ts`
- `apps/server/src/http/command-handler.ts`
- `apps/server/src/http/routes.spec.ts`
- `apps/server/src/runtime/session-registry.ts`
- `apps/server/src/runtime/session-registry.spec.ts`
- `docs/development/session-platform.md`

No contract, migration, realtime protocol, or web projection change was
required.

## Verification

Focused command:

```text
corepack pnpm vitest run \
  apps/server/src/projects/repository-identity.spec.ts \
  apps/server/src/tasks/project-run-preflight.spec.ts \
  apps/server/src/tasks/project-run-service.spec.ts \
  apps/server/src/tasks/attempt-service.spec.ts \
  apps/server/src/http/command-handler.spec.ts \
  apps/server/src/http/routes.spec.ts \
  apps/server/src/runtime/session-registry.spec.ts \
  apps/server/src/repositories/repositories.spec.ts \
  --config apps/server/vitest.config.ts
```

Result: 8 files passed, 242 tests passed.

Complete gate:

```text
corepack pnpm verify
```

Result: exit 0. All format, lint, typecheck, test, and build targets completed;
server tests reported 744 passed and 1 intentional skip; Chromium acceptance
reported 18/18 passed.

`git diff --check` passed before commit. The gate emitted existing non-failing
lint, Vite/Nx deprecation, Windows line-ending, chunk-size, and nested-shell
`pnpm` discovery warnings; none was introduced as a new error and the gate
completed successfully.

## Self-review

Self-review found and fixed three issues before the full gate:

- unreadable associated roots needed stable identity error mapping;
- duplicate or missing-ID resume failures could rewrite configuration before
  rejection;
- the shared SQL guard belonged in the repository layer, not runtime.

No remaining actionable review finding was found.

## Residual concerns

No unresolved blocker remains. Git worktree creation is intentionally outside
SQLite, so filesystem/audit failures continue to preserve reconciliation
evidence rather than claim cross-system atomicity. The real Claude smoke remains
separate, opt-in, subscription-consuming, and was not run.

## Follow-up: durable resume occupancy

### Root-cause confirmation

`SessionRegistry.resume` previously committed the workspace and permission
change while the durable lifecycle remained `interrupted`. The subsequent
attachment awaited `driver.resume()` before `SessionRuntime` recorded the
`resume` transition. Because the shared occupancy guard intentionally excludes
stopped states, another create or resume could claim the same protected path
during that await.

The durable owner now checks occupancy, configures resume, and appends the
audited transition to `starting` in the same `BEGIN IMMEDIATE` transaction.
`starting` is already part of the shared guard's live-state set. Only after the
transaction commits and publishes that event does Mesh call the driver. A
known driver-resume rejection atomically records the error diagnostic and
`starting -> failed` transition, preserving audit order and permitting a legal
retry.

### RED/GREEN evidence

1. Deferred-driver occupancy race:
   - RED: while the first resume was paused inside the driver, its durable state
     was `interrupted`; the second resume reached the driver instead of
     returning `project_run_conflict`.
   - GREEN: the first session is durably `starting` while paused, the second
     resume is rejected before its driver call, and the first completes to
     `running`.
2. Driver-resume failure cleanup and recovery:
   - RED: a rejected driver resume left the session `interrupted` with no
     reservation, error, or failure audit events.
   - GREEN: the ordered audit is `interrupted -> starting`,
     `driver_resume_failed`, then `starting -> failed`; a retry reaches
     `running`.
3. Reservation audit failure:
   - RED: diagnostic insertion failure rolled back the reservation but left the
     registry audit status `available`.
   - GREEN: the audit barrier trips, configuration and lifecycle remain
     unchanged, and the driver is never called.
4. Same-session compatibility:
   - GREEN proof: an interrupted session can resume its own protected workspace
     and reaches `running` without self-conflict.
5. Pending-resume cancellation:
   - RED: after the deferred driver settled and was closed, the durable
     reservation remained stuck in `starting`.
   - GREEN: occupancy remains protected until driver settlement, then ordered
     `starting -> interrupting -> interrupted` audit transitions release it.

### Follow-up files changed

- `apps/server/src/repositories/event-repository.ts`
- `apps/server/src/runtime/session-runtime.ts`
- `apps/server/src/runtime/session-registry.ts`
- `apps/server/src/runtime/session-registry.spec.ts`
- `docs/development/session-platform.md`

No migration, shared contract, realtime protocol, or web projection change was
required.

### Follow-up verification

Focused command:

```text
corepack pnpm vitest run \
  apps/server/src/runtime/session-registry.spec.ts \
  apps/server/src/runtime/session-runtime.spec.ts \
  apps/server/src/http/routes.spec.ts \
  apps/server/src/http/command-handler.spec.ts \
  apps/server/src/repositories/repositories.spec.ts \
  --config apps/server/vitest.config.ts
```

Result: 5 files passed, 134 tests passed.

Complete gate:

```text
corepack pnpm verify
```

Result: exit 0. All format, lint, typecheck, test, and build targets
completed; server tests reported 749 passed and 1 intentional skip; Chromium
acceptance reported 18/18 passed. The gate emitted the existing non-failing
lint, Vite/Nx deprecation, Windows line-ending, chunk-size, and nested-shell
`pnpm` discovery warnings.

### Follow-up residual concerns

No unresolved blocker is known. A failed reservation audit deliberately leaves
the process behind the global audit barrier; a failure while terminalizing an
already committed `starting` reservation leaves that live reservation in place
for fail-closed recovery rather than releasing occupancy without durable proof.
The real Claude smoke remains opt-in and was not run.
