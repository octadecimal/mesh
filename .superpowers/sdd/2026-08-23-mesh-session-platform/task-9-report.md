# Task 9 Report — Contract-Safe Client Transport and Hookstate Projection

## Status

Completed the Task 9 MVP.

## Delivered

- `MeshApi` parses every HTTP payload at the contract boundary and wraps mutating commands in a UUID idempotency envelope.
- `MeshSocket` parses every server frame, reports invalid payload diagnostics, resubscribes using current per-session cursors, and reconnects with capped exponential backoff.
- `resync.required` delegates snapshot replacement to the integration layer; the pure projection also detects cursor gaps.
- Hookstate store ownership separates canonical snapshot data from selections, filters, drafts, unread markers, health, and notifications. Snapshot replacement preserves transient drafts.
- Added focused reducer and socket contract tests plus web test setup.

## Verification

- `vitest --config apps/web/vite.config.ts run apps/web/src/state/reducer.spec.ts apps/web/src/api/socket.spec.ts` — 4 passing tests.
- `nx typecheck web` — passed.
- `git diff --check` — passed.

## Concerns

- The provided `pnpm nx test web --testPathPattern=...` command is incompatible with this Vitest version (`--testPathPattern` is unsupported), so focused tests ran via Vitest paths.
- Existing Vite/Nx deprecation/config-loader warnings remain outside this task’s scope.

## Follow-up Fix Round

- Added one `createResyncCoordinator` shared by reducer gap handling and `resync.required` socket handling.
- The coordinator calls `MeshApi.snapshot()`, uses the existing parsed snapshot client path, and delegates to `replaceSnapshot()` through the Hookstate store.
- A single in-flight promise prevents simultaneous gap/resync signals from issuing duplicate snapshot fetches.
- Focused tests now cover the gap refresh, snapshot replacement, draft retention, and socket resync reuse path.
