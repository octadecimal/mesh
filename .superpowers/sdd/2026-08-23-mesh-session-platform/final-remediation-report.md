# Final remediation report

## Outcome

All five final-review MVP blockers were verified and fixed. No reviewer finding
was rejected.

1. The production entry point now bootstraps public project/session discovery,
   creates the shared store/resync coordinator, connects `MeshSocket`, applies
   event frames in order, and exposes connection health to prompting.
2. Client and server WebSocket subscription frames now use the shared
   `subscribeFrameSchema` with top-level cursors. The production Fastify route
   registers the WebSocket plugin before the upgrade route.
3. A fresh database discovers and persists a project through
   `projects.discover`; E2E setup no longer inserts a project directly into
   SQLite.
4. Resume commands require the selected workspace and permission mode. The
   server validates project ownership, persists the selection, and passes it to
   the driver.
5. Subscription-limit events persist a typed `subscription_limit` error with
   capability/reset metadata, emit a `session.status` transition with reason
   `subscription_limit`, close the driver, and leave the session in the existing
   non-runnable `failed` lifecycle state. This reuses the MVP lifecycle schema
   and avoids a migration while still allowing explicit resume.

## Changed files

- Contracts: `packages/contracts/src/commands.ts`,
  `packages/contracts/src/contracts.spec.ts`,
  `packages/contracts/src/realtime.ts`.
- Server Claude/runtime: `apps/server/src/claude/driver.ts`,
  `normalize-event.ts`, `normalize-event.spec.ts`, `sdk-adapter.ts`,
  `sdk-driver.ts`, `runtime/lifecycle.ts`, `runtime/session-registry.ts`,
  `runtime/session-runtime.ts`, and `runtime/session-runtime.spec.ts`.
- Server HTTP/realtime/persistence: `apps/server/src/http/command-handler.ts`,
  `apps/server/src/http/routes.spec.ts`, `apps/server/src/realtime/socket-hub.ts`,
  `apps/server/src/realtime/socket-hub.spec.ts`, and
  `apps/server/src/repositories/session-repository.ts`.
- Web composition/UI/state: `apps/web/src/api/client.ts`, `api/socket.ts`,
  `api/socket.spec.ts`, `app/app.tsx`, `main.tsx`,
  `sessions/ResumeSessionDialog.tsx`, `sessions/ResumeSessionDialog.spec.tsx`,
  `workspace/SessionWorkspace.tsx`, and
  `workspace/SessionWorkspace.spec.tsx`.
- Acceptance harness: `e2e/fixtures/fake-claude.ts` and
  `e2e/src/session-platform.spec.ts`.

## Test evidence

- Contracts: 8/8 passing.
- Resume server route: 17/17 passing; web dialog: 2/2 passing; focused Chromium
  resume acceptance: 1/1 passing.
- Socket contract: web 2/2, server 6/6, contracts 8/8 passing.
- Subscription limit: normalize/runtime 15/15, workspace 3/3, focused Chromium
  acceptance 1/1 passing.
- `corepack pnpm verify`: PASS. Format check, lint, typecheck, test, and build
  targets passed; server 133 passed/1 skipped, web 25 passed, and Chromium
  acceptance 6/6 passed.
- No external Claude request was made. All acceptance traffic used the in-process
  fake; `external-smoke` remained excluded/opt-in.

## Commit

`fix: close session platform MVP gaps` (this remediation commit).

## Deferred observations

- Existing lint warnings remain non-blocking (unused underscore parameters,
  non-null assertions, and test-only explicit `any` usage).
- Existing Nx/Vite deprecation notices and the Vite chunk-size warning remain
  deferred as production-hardening/polish outside this remediation scope.
