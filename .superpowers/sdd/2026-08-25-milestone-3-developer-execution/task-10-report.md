# Task 10 report: Developer history projection and recovery

## Outcome

- Project snapshots now read every Developer cycle, completion report, blocker
  report, and review-feedback record for the project's task IDs inside the
  existing SQLite snapshot transaction.
- Repository reads preserve deterministic attempt/cycle/report ordering and
  parse persisted JSON through the shared contracts.
- Existing generic project replay and socket delivery carry
  `task.developer_execution_changed` events unchanged. Focused tests prove
  reconnect replay, live delivery, gap resync, and capability absence.
- Restart reconciliation now prefers the explicit
  `developer_cycle_without_live_session` repair for an open Developer cycle
  whose canonical attempt session is non-live. It writes the diagnostic before
  the project event in the existing transaction, is event-idempotent, and does
  not close the cycle, change task lifecycle, or create a report.
- Production startup wires the Developer execution repository into both
  snapshot and reconciliation dependencies.

## TDD evidence

The focused RED run failed in the intended behavior gaps:

- snapshot Developer collections decoded as empty defaults;
- reconciliation emitted `task_in_progress_without_live_session` instead of
  the cycle-specific repair.

After implementation, the focused suite passed 37/37 tests.

## Verification

- `corepack pnpm nx test server -- --run src/http/project-snapshots.spec.ts src/realtime/project-replay.spec.ts src/realtime/socket-hub.spec.ts src/tasks/reconcile-attempts.spec.ts`
  - PASS: 4 files, 37 tests.
- `corepack pnpm nx typecheck server`
  - PASS.
- `corepack pnpm nx test server`
  - PASS: 30 files passed, 1 skipped; 313 tests passed, 1 skipped.
  - The production-build migration test required a temporary PATH shim because
    this Windows session exposes pnpm through Corepack but not as a bare
    executable. The shim was removed after the run.
- `git diff --check`
  - PASS; only Git's existing LF-to-CRLF notices were printed.

## Surface decisions

- Contracts: unchanged; the required snapshot defaults, Developer event, and
  repair reason already existed.
- Commands/runtime/web: unchanged.
- Persistence: added read projections only; no migration or mutable report
  behavior.
- Realtime: production replay/socket logic already preserves every project
  event variant and project-local sequence semantics, so only regression tests
  were needed there.
- Recovery: reads canonical session lifecycle and durable cycle/attempt IDs;
  it does not read transcripts or infer completion/blocking outcomes.

## Self-review

No unresolved correctness concerns. The final diff retains the existing audit
barrier and project/session ownership boundary. A misleading test-local
`persisted` array was removed during review; persistence ordering remains
covered at the owning Developer execution service boundary.

## Fix Round 1

- Verified the Important review finding: `developerRepairFor` returned only the
  first orphan cycle, and the task-level reconciliation loop could therefore
  skip that already-recorded repair forever without reaching later orphan
  cycles.
- Added a regression with one task, two attempts, and two open Developer cycles
  bound to non-live sessions. The RED run received only the `attempt-1` repair
  when two repairs were expected.
- Changed Developer reconciliation to return and process every orphan-cycle
  repair in repository order. Each repair retains the existing
  attempt/session/reason event identity and diagnostic-before-event transaction;
  an already-recorded repair no longer prevents processing the next cycle.
- The regression proves the first run records both events and one diagnostic per
  session, while the second run returns both current repair conditions and
  records no duplicate events or diagnostics.

Exact verification evidence:

- Focused projection/reconciliation command: PASS, 4 files and 38 tests.
- Full server command: PASS, 30 files passed and 1 skipped; 314 tests passed and
  1 skipped.
- Server typecheck command: PASS.
- The full-suite migration production-build test again used the temporary pnpm
  PATH shim documented above; the shim was removed after verification.

Deferred Minor review note: the snapshot history test proves ordering across
two cycles for one task, but does not independently exercise cross-task
aggregation/order or multiple records of each report type. This round is
intentionally limited to the orphan-cycle starvation fix; the Minor test-scope
expansion remains recorded for later work.
