# Milestone 5 final-review fix report

Date: 2026-08-27

Implementation commit: `64699d2 fix(orchestration): harden project run safety`

## Outcome

All nine final-review findings were resolved in one consolidated safety wave.
The complete repository verification gate passed. No real Claude session, API
billing override, pull request, push, merge, or worktree cleanup was used.

## Finding evidence

1. **Safe concurrent workspaces.** Project-run items now receive deterministic,
   distinct Mesh-owned Git worktrees under `.mesh-project-runs`. Start, resume,
   and restart drains resolve the authoritative repository identity and reject a
   worktree root nested inside the imported repository before authorization or
   claim. Attempt reservation checks live same-path sessions inside the same
   `BEGIN IMMEDIATE` transaction. Production-composition coverage creates real
   Git worktrees, proves two paths and Git toplevel identities differ, and proves
   the imported repository remains clean.
2. **Attempt audit barrier.** Project-run attempt audit and reconciliation-
   required diagnostic failures call `onAuditFailure` and rethrow from the
   tracked drain. Attempt audit persistence no longer becomes an ambiguous
   launch pause. A SQLite trigger failure on
   `task.developer_execution_changed` proves the central origin/registry barrier
   closes with `audit_unavailable` and preserves the originating cause.
3. **Authorization snapshots.** `project.run.start` requires the displayed QA
   policy revision and each expected task's revision, automation status, and
   automation generation. The UI consent fingerprint uses a structured JSON
   value, including delimiter-shaped ids without collision. The service validates
   exact current truth atomically and snapshots all fields. Every queued launch
   rechecks the frozen values and terminalizes stale work as
   `authorization_stale` without invoking `AttemptService`.
4. **Paused reconciliation.** Reconciliation processes `launch_pending` and
   `active` items while a run remains paused, never claims queued work, repairs a
   proven effect-free paused claim, and is idempotent across repeated restart.
5. **Start/resume preflight.** Shared billing conflicts and authoritative
   repository identity/root safety are checked before Start authorization,
   Resume transition, and restart claim. Start rejects without creating a run;
   Resume and restart drains preserve the frozen queue in a specific
   `billing_conflict` or `repository_unsafe` pause.
6. **Shared contract invariants.** Project-run item schemas enforce status-
   specific link and timestamp presence. Aggregate parsing enforces enclosing
   run/project ownership, unique item ids, task ids, and queue positions,
   pause/completion consistency, and no occupied item in a completed run.
   Defaults decode legitimate payloads from before pause-reason and automation-
   status snapshots. Socket and project-snapshot fixtures exercise populated
   items; resync rejection preserves populated run and cursor state.
7. **Manual-link ownership race.** `task.attempt.link` checks open run-item task
   ownership inside the same transaction that creates the link. Race tests cover
   both manual-link-first and project-run-reservation-first outcomes.
   Reconciliation reads the complete current-attempt set and pauses or
   terminalizes on any extra nonmatching current attempt.
8. **Ordering parity.** The contract exports a deterministic UTF-16 code-unit
   comparator used by server selection, web preview, and run-item display.
   Case/supplementary-Unicode parity tests replace locale-dependent ordering.
9. **Planner convergence.** Production draining now consumes
   `planProjectRun`; the formerly test-only planner is the capacity/state/next-
   item decision path.

## Persistence and operating guidance

- Migration `016-project-run-automation-status.sql` adds a checked, non-null
  task automation status snapshot with a backward-compatible `disabled`
  default. Fresh, upgraded, bundled-production, and concurrent migration tests
  include migration 016.
- Durable session-platform guidance documents frozen authorization, preflight
  pause reasons, isolated worktrees, the safe `MESH_WORKSPACE_ROOT` parent
  requirement, atomic occupancy, and paused occupied-item reconciliation.
- The workspace root is created only after billing, repository identity, and
  repository-containment checks pass; server startup does not dirty a project
  whose repository is itself the configured workspace root.

## TDD and focused verification

- Consent delimiter-collision regression: failed 1/15 before the structured
  fingerprint, then passed 15/15.
- Nested workspace-root/repository preflight: failed 2/5 before containment and
  root preparation, then passed 5/5. Real restart composition exposed missing
  root preparation before queued claims; the corrected preflight path then
  passed the combined preflight/main/service set, 81/81.
- Contracts: `corepack pnpm nx test contracts` — 45/45 passed.
- Core server safety set (project-run service, preflight, workspace, attempt,
  reconciliation, main, command, snapshot, socket): 207/207 passed.
- Attempt/service/reconciliation focused rerun: 127/127 passed.
- Migration harness with production bundle: 17/17 passed.
- Web panel/selectors/resync/app/task-board set: 54/54 passed.
- Complete server suite: 728 passed, 1 intentionally skipped.

The Windows host has Corepack but no globally installed `pnpm.cmd`. The nested
production-build migration test therefore used a temporary-directory Corepack
shim prepended to `PATH`; no repository or persistent package-manager state was
changed. An initial harness run exposed and led to correction of a test-only
TypeScript matcher annotation before the successful 17/17 migration run.

## Complete verification

`corepack pnpm verify` passed with the same temporary Corepack shim on `PATH`:

- `nx format:check`: passed.
- Lint and typecheck for all six projects: passed (existing warning-only lint
  debt remains; zero errors).
- Contracts: 45 passed.
- Server: 728 passed, 1 intentionally skipped.
- Web: 155 passed.
- Production builds: passed.
- Chromium E2E: 18/18 passed, including API-billing refusal without invoking
  Claude.

## Self-review

- `git diff --check` passed before staging.
- Prettier formatted every changed TypeScript/TSX source.
- Reviewed the final contract, command, runtime, persistence, realtime, web,
  workspace-safety, restart/reverse-state, and documentation surfaces.
- Registered the complete 37-path code batch with jCodeMunch after edits.
- Refreshed the changed durable documentation through jDocMunch and verified
  the indexed finite-project-run section.
- No unresolved correctness or safety concern remains in the requested scope.
