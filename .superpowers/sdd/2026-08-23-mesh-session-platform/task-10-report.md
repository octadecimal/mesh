# Task 10 report

## Status

Complete. The prior facade was replaced with a real Dockview/Hookstate/MeshApi integration and the Task 10 MVP acceptance conditions are covered.

## Implemented

- Instantiated `DockviewReact` with exactly one component key, `session`; every programmatic panel add sends params containing only `{ sessionId }`.
- Bootstrapped the web app from `MeshApi.snapshot()` into the existing Hookstate store and consumed project, workspace, session, selected-session, filter, layout, and unread selectors without adding a second canonical store.
- Restored `SavedLayout.dockview` through Dockview `fromJSON`, pruned panels for deleted sessions, consolidated restored layouts to at most two groups, and opened a missing selected session as a tab.
- Enforced the two-group maximum for programmatic split/add, drag/split interception, and post-add group reconciliation; excess groups are merged as tabs into an existing group.
- Debounced Dockview `toJSON()` persistence through the existing idempotent `MeshApi.command({ type: 'layout.save' })` v1 transport, preserving saved-layout identity and contract fields (`sidebar`, `visiblePanels`, and scope IDs).
- Kept panel close as a layout/visibility operation only. No close path emits `session.interrupt`.
- Preserved the responsive sidebar, lifecycle/unread/workspace/approval affordances, keyboard focus styling, reduced-motion behavior, Tailwind Vite integration, Dockview CSS, and thin Radix exports.

## TDD evidence

The focused red run failed five tests for the absent Dockview controller operations and custom layout serialization. After the minimal integration was added, the same workspace tests passed. App-level red tests then failed on the old custom-layout/App boundary; they passed after Hookstate selector and MeshApi transport wiring.

## Verification

- `corepack pnpm exec vitest run apps/web/src/app/app.spec.tsx apps/web/src/workspace/SessionWorkspace.spec.tsx apps/web/src/workspace/layout-controller.spec.ts apps/web/src/sessions/SessionSidebar.spec.tsx`
  - 4 test files passed, 9 tests passed.
- `corepack pnpm nx typecheck web`
  - `web:typecheck` passed.
- `git diff --cached --check`
  - Passed.

The environment still emits the existing Vite native-config and Nx Vite-plugin deprecation warnings, plus the existing Corepack `pnpm` shim message during Nx execution; all requested gates exit successfully.

## Self-review

- Confirmed the saved payload uses real Dockview serialized JSON and the `SavedLayout.visiblePanels` contract rather than the prior `visibleSessionIds` facade.
- Confirmed restore happens before live group-policy listeners attach, avoiding interference while Dockview deserializes multi-group layouts.
- Confirmed group consolidation handles restored groups, direct group additions, programmatic split requests, panel drags, and group drags.
- Confirmed selection clears unread state in Hookstate, saved sidebar filtering remains controlled by Hookstate, and layout saves preserve an existing saved-layout ID/project scope.
- Confirmed the staged changes are limited to Task 10 web shell/sidebar/workspace/theme/test files and this report; no server or contract behavior was changed.

## Concerns

No blocking concerns. Deprecation warnings are pre-existing and outside the explicit Task 10 MVP scope.

## Fix round: saved-layout scope safety

- Reproduced the cross-project defect with project A owning the only saved layout, then selecting project B: A's tab remained visible and B reused A's saved layout ID/project scope.
- Changed saved-layout selection so a valid selected session only accepts layouts whose populated `projectId`, `workspaceId`, and `sessionId` scopes all match that session. Matching layouts are chosen by specificity; an explicitly unscoped global layout remains eligible. The first-layout fallback now applies only when no valid session is selected.
- Revalidated the chosen layout at the save boundary. A stale layout can no longer contribute its ID or scope; a new selected project receives a new project-scoped layout ID.
- Cleared the current Dockview layout when changing to a selected scope with no saved layout, so panels restored for another project do not remain as tabs.
- Added a red/green two-project regression proving A restores before selection, B starts clean after selection, B saves under `layout-p2`/`p2`, and no B state overwrites A's layout.

Fix-round verification:

- Focused Task 10 suite: 4 files passed, 10 tests passed.
- `web:typecheck`: passed.
- `git diff --check`: passed.
