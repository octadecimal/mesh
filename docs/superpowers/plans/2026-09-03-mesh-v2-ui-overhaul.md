# Mesh V2 UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the milestone-oriented V2 shell with an accessible,
attention-first operator workspace while preserving all existing domain,
command, audit, persistence, and project-realtime behavior.

**Architecture:** Extend the existing native History API routing, derive global
Inbox and Runs read models from existing project snapshots, and keep the
current project WebSocket projection authoritative inside project routes.
Decompose the browser composition into global pages, a project workspace, and a
project-bound PM drawer while retaining the existing leaf behavior owners.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Vitest 4, Testing Library,
Playwright, native History/URL APIs, CSS custom properties, and the already
installed Radix Dialog package.

**Spec:** `docs/superpowers/specs/2026-09-02-mesh-v2-ui-overhaul-design.md`

## Global Constraints

- Keep `packages/v2-contracts`, `apps/v2-server`, SQLite persistence, command
  schemas, and project realtime transport unchanged.
- Never add or fall back to an API-billed Anthropic credential.
- Use only existing project snapshots for global Inbox and Runs data.
- Global pages never issue project mutations; they navigate to the canonical
  project artifact.
- Add no router, component library, icon package, CSS framework, or server-side
  preference.
- Preserve audit barriers, explicit disabled reasons, idempotency, stale-state
  behavior, replay, reconnect, and resync.
- Use System, Light, and Dark themes from one semantic CSS token set; System is
  the default.
- Keep status text independent of color and meet WCAG AA in both explicit
  themes.
- Use temporary repositories, temporary databases, and the fake driver for all
  automated tests.

---

## Planned File Structure

### New files

- `apps/v2-web/src/app/routes.ts` — parse and format every global and project
  route.
- `apps/v2-web/src/app/routes.spec.ts` — route round-trip and invalid-path
  tests.
- `apps/v2-web/src/app/global-projection.ts` — pure attention and run summary
  projection.
- `apps/v2-web/src/app/global-projection.spec.ts` — projection ordering,
  classification, and destination tests.
- `apps/v2-web/src/test/project-snapshot-fixture.ts` — shared, schema-validated
  project snapshot fixtures extracted from the existing application tests.
- `apps/v2-web/src/app/use-global-project-snapshots.ts` — cancellable,
  visibility-aware snapshot loading and polling.
- `apps/v2-web/src/app/use-global-project-snapshots.spec.tsx` — settled partial
  result, refresh, polling, and cancellation tests.
- `apps/v2-web/src/components/AppShell.tsx` — global rail, application header,
  project breadcrumb, and page frame.
- `apps/v2-web/src/components/AppShell.spec.tsx` — navigation and current-page
  semantics.
- `apps/v2-web/src/components/ThemeSelect.tsx` — System/Light/Dark preference
  control.
- `apps/v2-web/src/components/ThemeSelect.spec.tsx` — system resolution and
  local preference tests.
- `apps/v2-web/src/components/InboxPage.tsx` — global attention master-detail
  page.
- `apps/v2-web/src/components/InboxPage.spec.tsx` — Inbox state and navigation
  tests.
- `apps/v2-web/src/components/RunsView.tsx` — reusable active/history run list
  and selected detail.
- `apps/v2-web/src/components/RunsView.spec.tsx` — run view filtering and
  selection tests.
- `apps/v2-web/src/components/GlobalRunsPage.tsx` — global Runs page wrapper.
- `apps/v2-web/src/components/ProjectsPage.tsx` — page composition around the
  existing project selector and registration form.
- `apps/v2-web/src/components/ProjectOverview.tsx` — project-local attention,
  approved-state, and next-action summary.
- `apps/v2-web/src/components/ProjectOverview.spec.tsx` — overview state tests.
- `apps/v2-web/src/components/ProjectManagerDrawer.tsx` — project-bound PM
  conversation tabs, overlay, pinning, focus, and drafts.
- `apps/v2-web/src/components/ProjectManagerDrawer.spec.tsx` — drawer boundary
  and interaction tests.
- `apps/v2-web/src/components/PlansPane.tsx` — canonical intent and delivery
  proposal review surface.
- `apps/v2-web/src/components/PlansPane.spec.tsx` — proposal review placement
  tests.

### Existing files with focused changes

- `apps/v2-web/src/app/App.tsx` and `App.spec.tsx` — compose routes, global
  snapshots, pages, and existing commands.
- `apps/v2-web/src/components/FocusedProjectShell.tsx` and its spec — become the
  project workspace frame with Overview and artifact navigation.
- `apps/v2-web/src/components/PlanningPane.tsx` and its spec — expose explicit
  conversation and review surfaces without changing commands.
- `apps/v2-web/src/components/BoardPane.tsx` and its spec — master-detail task
  presentation while keeping server-owned filters and readiness.
- `apps/v2-web/src/components/RequirementsPane.tsx` and its spec — scannable
  ledger presentation without changing ledger semantics.
- `apps/v2-web/src/components/DeveloperSection.tsx`,
  `ExecutionActivity.tsx`, and their specs — presentation and accessible labels
  only.
- `apps/v2-web/src/styles.css`, `intent-ledger.css`, and
  `planning-board.css` — approved V3 semantic tokens and responsive styling.
- `e2e-v2/src/v2-foundation.spec.ts` — integrated attention-first navigation,
  PM, theme, failure, and responsive checks.
- `docs/development/architecture.md` and
  `docs/development/session-platform.md` — new browser route and operating
  model.

---

### Task 1: Add the native route model

**Files:**

- Create: `apps/v2-web/src/app/routes.ts`
- Create: `apps/v2-web/src/app/routes.spec.ts`

**Interfaces:**

- Consumes: browser pathname/search strings and project IDs.
- Produces: `AppRoute`, `ProjectArtifact`, `parseAppRoute(pathname, search)`,
  and `appHref(route)` for every later composition task. Board task and Run
  selections use native query strings so refresh and back/forward preserve the
  selected detail.

- [ ] **Step 1: Write failing route round-trip tests**

```ts
import { describe, expect, it } from 'vitest';

import { appHref, parseAppRoute } from './routes';

describe('V2 application routes', () => {
  it.each([
    ['/', { page: 'inbox' }],
    ['/runs', { page: 'runs' }],
    ['/projects', { page: 'projects' }],
    ['/projects/project%2Fone', {
      page: 'project',
      projectId: 'project/one',
      artifact: 'overview',
    }],
    ['/projects/project%2Fone/requirements', {
      page: 'project',
      projectId: 'project/one',
      artifact: 'requirements',
    }],
    ['/projects/project%2Fone/plans', {
      page: 'project',
      projectId: 'project/one',
      artifact: 'plans',
    }],
    ['/projects/project%2Fone/board', {
      page: 'project',
      projectId: 'project/one',
      artifact: 'board',
    }],
    ['/projects/project%2Fone/runs', {
      page: 'project',
      projectId: 'project/one',
      artifact: 'runs',
    }],
  ] as const)('parses %s', (pathname, route) => {
    expect(parseAppRoute(pathname)).toEqual(route);
    expect(appHref(route)).toBe(pathname);
  });

  it.each([
    ['/projects/p/board', '?task=T-21', {
      page: 'project',
      projectId: 'p',
      artifact: 'board',
      selectedId: 'T-21',
    }],
    ['/projects/p/runs', '?run=run%2F21', {
      page: 'project',
      projectId: 'p',
      artifact: 'runs',
      selectedId: 'run/21',
    }],
  ] as const)('preserves a selected detail for %s%s', (pathname, search, route) => {
    expect(parseAppRoute(pathname, search)).toEqual(route);
    expect(appHref(route)).toBe(`${pathname}${search}`);
  });

  it.each(['/unknown', '/projects/', '/projects/%E0%A4%A', '/projects/p/x'])(
    'rejects %s',
    (pathname) => expect(parseAppRoute(pathname)).toEqual({ page: 'not_found', pathname }),
  );
});
```

- [ ] **Step 2: Run the route test and verify it fails**

Run:

```powershell
corepack pnpm nx test v2-web -- --run src/app/routes.spec.ts
```

Expected: FAIL because `./routes` does not exist.

- [ ] **Step 3: Implement exact parsing and formatting**

```ts
export type ProjectArtifact =
  | 'overview'
  | 'requirements'
  | 'plans'
  | 'board'
  | 'runs';

export type AppRoute =
  | { page: 'inbox' }
  | { page: 'runs' }
  | { page: 'projects' }
  | {
      page: 'project';
      projectId: string;
      artifact: ProjectArtifact;
      selectedId?: string;
    }
  | { page: 'not_found'; pathname: string };

const artifactPaths = new Set<ProjectArtifact>([
  'requirements',
  'plans',
  'board',
  'runs',
]);

export function parseAppRoute(pathname: string, search = ''): AppRoute {
  if (pathname === '/') return { page: 'inbox' };
  if (pathname === '/runs') return { page: 'runs' };
  if (pathname === '/projects') return { page: 'projects' };
  const match = /^\/projects\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return { page: 'not_found', pathname };
  try {
    const projectId = decodeURIComponent(match[1]);
    const artifact = (match[2] ?? 'overview') as ProjectArtifact;
    if (!projectId || (artifact !== 'overview' && !artifactPaths.has(artifact))) {
      return { page: 'not_found', pathname };
    }
    const params = new URLSearchParams(search);
    const selectedId =
      artifact === 'board'
        ? params.get('task') ?? undefined
        : artifact === 'runs'
          ? params.get('run') ?? undefined
          : undefined;
    return selectedId
      ? { page: 'project', projectId, artifact, selectedId }
      : { page: 'project', projectId, artifact };
  } catch {
    return { page: 'not_found', pathname };
  }
}

export function appHref(route: Exclude<AppRoute, { page: 'not_found' }>) {
  if (route.page === 'inbox') return '/';
  if (route.page === 'runs') return '/runs';
  if (route.page === 'projects') return '/projects';
  const base = `/projects/${encodeURIComponent(route.projectId)}`;
  const path = route.artifact === 'overview' ? base : `${base}/${route.artifact}`;
  if (!route.selectedId) return path;
  const key = route.artifact === 'board' ? 'task' : route.artifact === 'runs' ? 'run' : null;
  return key ? `${path}?${key}=${encodeURIComponent(route.selectedId)}` : path;
}
```

- [ ] **Step 4: Run the focused tests and typecheck**

```powershell
corepack pnpm nx test v2-web -- --run src/app/routes.spec.ts
corepack pnpm nx typecheck v2-web
```

Expected: route tests and typecheck PASS.

- [ ] **Step 5: Commit the route model**

```powershell
git add apps/v2-web/src/app/routes.ts apps/v2-web/src/app/routes.spec.ts
git commit -m "feat(v2-web): add application routes"
```

---

### Task 2: Derive global attention and run summaries

**Files:**

- Create: `apps/v2-web/src/app/global-projection.ts`
- Create: `apps/v2-web/src/app/global-projection.spec.ts`
- Create: `apps/v2-web/src/test/project-snapshot-fixture.ts`
- Modify: `apps/v2-web/src/app/App.spec.tsx`

**Interfaces:**

- Consumes: `readonly V2ProjectSnapshot[]`.
- Produces: `GlobalAttentionItem`, `GlobalRunSummary`,
  `attentionFromSnapshots(snapshots)`, and `runsFromSnapshots(snapshots)`.
- Stable destinations use the `AppRoute` and `appHref` contract from Task 1.

- [ ] **Step 1: Write failing projection tests**

First extract the existing top-level schema-parsed `project`, `execution`, and
`projectSnapshot` constants from `App.spec.tsx` into
`src/test/project-snapshot-fixture.ts`, keeping their values unchanged. Export
them as `projectFixture`, `runningExecutionFixture`, and
`projectSnapshotFixture`, then import them back into `App.spec.tsx` so this is a
test-only ownership move rather than duplicate data. Use object spreads from
those exports to cover one item from each approved category. The core
assertions are:

```ts
expect(attentionFromSnapshots([snapshot])).toMatchObject([
  {
    projectId: snapshot.project.id,
    kind: 'runtime',
    href: `/projects/${snapshot.project.id}/runs?run=${runningExecution.id}`,
  },
  {
    projectId: snapshot.project.id,
    kind: 'decision',
    href: `/projects/${snapshot.project.id}/plans`,
  },
  {
    projectId: snapshot.project.id,
    kind: 'ready',
    href: `/projects/${snapshot.project.id}/board?task=T-21`,
  },
]);

expect(
  runsFromSnapshots([snapshot]).filter(({ active }) => active),
).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      projectId: snapshot.project.id,
      executionId: runningExecution.id,
      active: true,
    }),
  ]),
);
```

Also assert severity ordering, deterministic project/identity tie-breaking,
deduplication of an attempt and its controlling execution, exclusion of
inactive Board cards, and newest-first completed history.

- [ ] **Step 2: Run the projection tests and verify they fail**

```powershell
corepack pnpm nx test v2-web -- --run src/app/global-projection.spec.ts
```

Expected: FAIL because the projection module does not exist.

- [ ] **Step 3: Implement the public projection types**

```ts
import type { V2ProjectSnapshot, WorkerExecution } from '@mesh/v2-contracts';

export type GlobalAttentionKind =
  | 'runtime'
  | 'failure'
  | 'decision'
  | 'stale'
  | 'ready';

export type GlobalAttentionItem = Readonly<{
  id: string;
  projectId: string;
  projectName: string;
  kind: GlobalAttentionKind;
  title: string;
  description: string;
  href: string;
  sortRevision: number;
}>;

export type GlobalRunSummary = Readonly<{
  executionId: string;
  projectId: string;
  projectName: string;
  title: string;
  lifecycle: WorkerExecution['lifecycle'];
  active: boolean;
  updatedAt: string;
  href: string;
}>;

export function attentionFromSnapshots(
  snapshots: readonly V2ProjectSnapshot[],
): readonly GlobalAttentionItem[];

export function runsFromSnapshots(
  snapshots: readonly V2ProjectSnapshot[],
): readonly GlobalRunSummary[];
```

Implement the five categories from the spec. Treat execution lifecycles
`starting` and `running` as active. Use `card.readiness.state === 'actionable'`
for ready Board items. Use the latest nonterminal planning cycle and its latest
awaiting proposal for decisions. Deduplicate by the stable `id`, sort by the
explicit kind order below, and then use `sortRevision`, project name, and ID.

```ts
const attentionOrder: Record<GlobalAttentionKind, number> = {
  runtime: 0,
  failure: 1,
  decision: 2,
  stale: 3,
  ready: 4,
};
```

- [ ] **Step 4: Run projection tests and the V2 web suite**

```powershell
corepack pnpm nx test v2-web -- --run src/app/global-projection.spec.ts
corepack pnpm nx test v2-web
```

Expected: projection tests and all existing V2 web tests PASS.

- [ ] **Step 5: Commit the global projections**

```powershell
git add apps/v2-web/src/app/global-projection.ts apps/v2-web/src/app/global-projection.spec.ts apps/v2-web/src/test/project-snapshot-fixture.ts apps/v2-web/src/app/App.spec.tsx
git commit -m "feat(v2-web): derive global attention"
```

---

### Task 3: Load global project snapshots safely

**Files:**

- Create: `apps/v2-web/src/app/use-global-project-snapshots.ts`
- Create: `apps/v2-web/src/app/use-global-project-snapshots.spec.tsx`

**Interfaces:**

- Consumes: existing `V2Api.projectSnapshot`, system-snapshot project list,
  `enabled`, and `pollIntervalMs`.
- Produces: `GlobalProjectSnapshotState` and
  `useGlobalProjectSnapshots(options)` for Inbox and Runs.

- [ ] **Step 1: Write failing hook tests**

```tsx
const { result, rerender, unmount } = renderHook(
  ({ enabled, pollIntervalMs }) =>
    useGlobalProjectSnapshots({
      api,
      projects: [alpha, beta],
      enabled,
      pollIntervalMs,
    }),
  { initialProps: { enabled: true, pollIntervalMs: 5_000 } },
);

await waitFor(() => expect(result.current.status).toBe('ready'));
expect(result.current.snapshots).toEqual([alphaSnapshot]);
expect(result.current.failures).toEqual([
  { projectId: beta.id, message: 'Project unavailable.' },
]);

await act(() => vi.advanceTimersByTimeAsync(5_000));
expect(api.projectSnapshot).toHaveBeenCalledTimes(4);

rerender({ enabled: false, pollIntervalMs: 5_000 });
expect(lastSignal.aborted).toBe(true);
unmount();
```

Add tests for `Promise.allSettled` partial success, stable previous content
during refresh, manual `refresh()`, window-focus refresh when
`pollIntervalMs === 0`, no overlap between requests, and unmount cancellation.

- [ ] **Step 2: Run the hook test and verify it fails**

```powershell
corepack pnpm nx test v2-web -- --run src/app/use-global-project-snapshots.spec.tsx
```

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement the state contract and loader**

```ts
export type GlobalProjectSnapshotFailure = Readonly<{
  projectId: string;
  message: string;
}>;

export type GlobalProjectSnapshotState = Readonly<{
  status: 'idle' | 'loading' | 'ready';
  snapshots: readonly V2ProjectSnapshot[];
  failures: readonly GlobalProjectSnapshotFailure[];
  refreshing: boolean;
  refresh(): void;
}>;

export function useGlobalProjectSnapshots({
  api,
  projects,
  enabled,
  pollIntervalMs,
}: {
  api: Pick<V2Api, 'projectSnapshot'>;
  projects: readonly Project[];
  enabled: boolean;
  pollIntervalMs: 0 | 5000;
}): GlobalProjectSnapshotState;
```

Use one `AbortController` per generation. Abort the prior generation before a
manual, focus, interval, route, or unmount refresh. Retain the prior successful
snapshots until all current requests settle. Convert unknown errors through
the existing `errorMessage` behavior rather than exposing exception objects.

- [ ] **Step 4: Run hook tests, all V2 web tests, and typecheck**

```powershell
corepack pnpm nx test v2-web -- --run src/app/use-global-project-snapshots.spec.tsx
corepack pnpm nx test v2-web
corepack pnpm nx typecheck v2-web
```

Expected: all commands PASS and fake timers leave no pending interval.

- [ ] **Step 5: Commit the global loader**

```powershell
git add apps/v2-web/src/app/use-global-project-snapshots.ts apps/v2-web/src/app/use-global-project-snapshots.spec.tsx
git commit -m "feat(v2-web): load global project state"
```

---

### Task 4: Establish the shell and theme system

**Files:**

- Create: `apps/v2-web/src/components/AppShell.tsx`
- Create: `apps/v2-web/src/components/AppShell.spec.tsx`
- Create: `apps/v2-web/src/components/ThemeSelect.tsx`
- Create: `apps/v2-web/src/components/ThemeSelect.spec.tsx`
- Modify: `apps/v2-web/src/styles.css`

**Interfaces:**

- Consumes: `AppRoute`, navigation callback, system health, and optional
  project metadata.
- Produces: global application chrome and
  `ThemePreference = 'system' | 'light' | 'dark'`.

- [ ] **Step 1: Write failing theme tests**

```tsx
render(<ThemeSelect storage={storage} media={media} />);
expect(document.documentElement.dataset.theme).toBe('dark');

await user.selectOptions(screen.getByLabelText('Theme'), 'light');
expect(document.documentElement.dataset.theme).toBe('light');
expect(storage.setItem).toHaveBeenCalledWith('mesh.v2.theme', 'light');
```

Cover absent preference, valid stored preference, invalid stored value,
System media changes, and listener cleanup.

- [ ] **Step 2: Write failing shell navigation tests**

```tsx
render(
  <AppShell
    route={{ page: 'inbox' }}
    health={{ status: 'ok' }}
    onNavigate={onNavigate}
  >
    <p>Inbox body</p>
  </AppShell>,
);

expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute(
  'aria-current',
  'page',
);
await user.click(screen.getByRole('link', { name: 'Runs' }));
expect(onNavigate).toHaveBeenCalledWith('/runs');
expect(screen.queryByRole('button', { name: /project manager/i })).toBeNull();
```

- [ ] **Step 3: Run the component tests and verify they fail**

```powershell
corepack pnpm nx test v2-web -- --run src/components/ThemeSelect.spec.tsx src/components/AppShell.spec.tsx
```

Expected: FAIL because both components do not exist.

- [ ] **Step 4: Implement the theme selector without a dependency**

```ts
export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'mesh.v2.theme';

export const resolvedTheme = (
  preference: ThemePreference,
  prefersDark: boolean,
) => (preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference);
```

`ThemeSelect` reads storage once, defaults to System, subscribes to
`matchMedia('(prefers-color-scheme: dark)')` only while System is active, sets
`document.documentElement.dataset.theme`, and renders a native labeled
`<select>`.

- [ ] **Step 5: Implement the shell and approved semantic tokens**

`AppShell` renders a `<nav aria-label="Global navigation">`, an application
header, health text, the theme selector, and `<main>` children. Use anchors for
real destinations and call `preventDefault()` before the injected native
navigation callback.

Replace literal palette values in `styles.css` with the approved tokens:

```css
:root {
  color-scheme: light;
  --canvas: #f7f8fb;
  --surface: #ffffff;
  --surface-muted: #f0f2f7;
  --border: #dfe4ec;
  --text: #172033;
  --text-muted: #708096;
  --accent: #4f46e5;
  --accent-muted: #e8e7ff;
  --success: #198754;
  --warning: #d68a18;
  --danger: #d94d61;
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --canvas: #090d16;
  --surface: #101725;
  --surface-muted: #0d1421;
  --border: #263149;
  --text: #f0f4fa;
  --text-muted: #8996aa;
  --accent: #8b83ff;
  --accent-muted: #302e71;
  --success: #4ed38a;
  --warning: #f2b84b;
  --danger: #ee6a7a;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

Keep the global rail dark in both themes and retain the existing visible focus
outline.

- [ ] **Step 6: Run shell/theme tests and typecheck**

```powershell
corepack pnpm nx test v2-web -- --run src/components/ThemeSelect.spec.tsx src/components/AppShell.spec.tsx
corepack pnpm nx typecheck v2-web
```

Expected: tests and typecheck PASS.

- [ ] **Step 7: Commit the application shell**

```powershell
git add apps/v2-web/src/components/AppShell.tsx apps/v2-web/src/components/AppShell.spec.tsx apps/v2-web/src/components/ThemeSelect.tsx apps/v2-web/src/components/ThemeSelect.spec.tsx apps/v2-web/src/styles.css
git commit -m "feat(v2-web): add operator shell"
```

---

### Task 5: Build the global Inbox, Runs, and Projects pages

**Files:**

- Create: `apps/v2-web/src/components/InboxPage.tsx`
- Create: `apps/v2-web/src/components/InboxPage.spec.tsx`
- Create: `apps/v2-web/src/components/RunsView.tsx`
- Create: `apps/v2-web/src/components/RunsView.spec.tsx`
- Create: `apps/v2-web/src/components/GlobalRunsPage.tsx`
- Create: `apps/v2-web/src/components/ProjectsPage.tsx`
- Modify: `apps/v2-web/src/components/ProjectSelector.tsx`
- Modify: `apps/v2-web/src/components/ProjectSelector.spec.tsx`
- Modify: `apps/v2-web/src/styles.css`

**Interfaces:**

- Consumes: `GlobalProjectSnapshotState`, Task 2 projections, and existing
  `SelectorViewModel` registration callbacks.
- Produces: presentational global pages and `RunsView` reusable by the project
  workspace.

- [ ] **Step 1: Write failing Inbox tests**

```tsx
render(
  <InboxPage
    state={{
      status: 'ready',
      snapshots: [snapshot],
      failures: [{ projectId: failedProject.id, message: 'Offline' }],
      refreshing: false,
      refresh,
    }}
    onNavigate={onNavigate}
  />,
);

expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
expect(screen.getByRole('alert')).toHaveTextContent(failedProject.displayName);
await user.click(screen.getByRole('link', { name: 'Review in project' }));
expect(onNavigate).toHaveBeenCalledWith(
  `/projects/${snapshot.project.id}/plans`,
);
```

Cover initial loading, no projects, no attention, partial failure, filters,
master-detail selection, retained content during refresh, and manual refresh.

- [ ] **Step 2: Write failing reusable Runs tests**

```tsx
render(<RunsView runs={runs} onNavigate={onNavigate} />);
expect(screen.getByRole('tab', { name: 'Active 2' })).toHaveAttribute(
  'aria-selected',
  'true',
);
await user.click(screen.getByRole('tab', { name: 'History' }));
expect(screen.getByText('Interrupted')).toBeVisible();
await user.click(screen.getByRole('link', { name: /implement task T-21/i }));
expect(onNavigate).toHaveBeenCalledWith(runs[0].href);
```

Cover active-first selection, project filter, empty active/history states, and
stable selection when refreshed rows remain present.

- [ ] **Step 3: Run the page tests and verify they fail**

```powershell
corepack pnpm nx test v2-web -- --run src/components/InboxPage.spec.tsx src/components/RunsView.spec.tsx
```

Expected: FAIL because the pages do not exist.

- [ ] **Step 4: Implement the global pages**

Use semantic page contracts:

```ts
export function InboxPage({
  state,
  onNavigate,
}: {
  state: GlobalProjectSnapshotState;
  onNavigate(href: string): void;
}): React.JSX.Element;

export function RunsView({
  runs,
  projectId,
  selectedId,
  onNavigate,
}: {
  runs: readonly GlobalRunSummary[];
  projectId?: string;
  selectedId?: string;
  onNavigate(href: string): void;
}): React.JSX.Element;
```

`RunsView` selects `selectedId` when present, otherwise the first active row and
then the first history row. Row links use each summary's canonical `href`, so
selection changes are navigation rather than private component state.
`GlobalRunsPage` adds loading, partial-failure, refreshing, and explicit refresh
around `RunsView`. `ProjectsPage` supplies the page heading and status summaries
around `ProjectSelector`. Preserve the repository-path label, submission
availability, V1 guidance link, and existing registration callbacks.

- [ ] **Step 5: Apply the approved master-detail and responsive styling**

Use a two-column Inbox and Runs layout above 56rem, stack below it, and keep
minimum interactive targets at 44 CSS pixels. Keep warning text adjacent to
the affected project and never rely on the state dot alone.

- [ ] **Step 6: Run global page tests and the V2 web suite**

```powershell
corepack pnpm nx test v2-web -- --run src/components/InboxPage.spec.tsx src/components/RunsView.spec.tsx src/components/ProjectSelector.spec.tsx
corepack pnpm nx test v2-web
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the global pages**

```powershell
git add apps/v2-web/src/components/InboxPage.tsx apps/v2-web/src/components/InboxPage.spec.tsx apps/v2-web/src/components/RunsView.tsx apps/v2-web/src/components/RunsView.spec.tsx apps/v2-web/src/components/GlobalRunsPage.tsx apps/v2-web/src/components/ProjectsPage.tsx apps/v2-web/src/components/ProjectSelector.tsx apps/v2-web/src/components/ProjectSelector.spec.tsx apps/v2-web/src/styles.css
git commit -m "feat(v2-web): add global operator pages"
```

---

### Task 6: Add project Overview and artifact navigation

**Files:**

- Create: `apps/v2-web/src/components/ProjectOverview.tsx`
- Create: `apps/v2-web/src/components/ProjectOverview.spec.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.spec.tsx`
- Modify: `apps/v2-web/src/styles.css`

**Interfaces:**

- Consumes: existing `ProjectShellViewModel`, `ProjectArtifact`, project command
  projections, and Task 2 attention/run summaries.
- Produces: URL-controlled horizontal project navigation and the default
  project Overview.

- [ ] **Step 1: Write failing Overview tests**

```tsx
render(
  <ProjectOverview
    snapshot={snapshot}
    attention={attentionFromSnapshots([snapshot])}
    onNavigate={onNavigate}
  />,
);

expect(screen.getByRole('heading', { name: snapshot.project.displayName }))
  .toBeVisible();
expect(screen.getByText('14 requirements')).toBeVisible();
await user.click(screen.getByRole('link', { name: 'Review delivery plan' }));
expect(onNavigate).toHaveBeenCalledWith(
  `/projects/${snapshot.project.id}/plans`,
);
```

Cover no intent, approved intent/no plan, stale plan, actionable Board,
attention-required execution, and active execution summaries.

- [ ] **Step 2: Write failing project navigation tests**

Render `FocusedProjectShell` with `artifact="overview"` and assert five tabs,
`aria-current="page"`, arrow/Home/End movement, navigation callbacks, project
path, connection status, and visible cursor diagnostics. Assert global routes
cannot be passed as project artifacts at compile time.

- [ ] **Step 3: Run focused tests and verify they fail**

```powershell
corepack pnpm nx test v2-web -- --run src/components/ProjectOverview.spec.tsx src/components/FocusedProjectShell.spec.tsx
```

Expected: FAIL because Overview and artifact props do not exist.

- [ ] **Step 4: Implement the project workspace contract**

Extend the shell props with:

```ts
artifact: ProjectArtifact;
selectedId?: string;
onNavigateArtifact(artifact: ProjectArtifact): void;
onNavigate(href: string): void;
```

Replace the internal `activePane` state with the URL-controlled artifact and
pass `selectedId` only to Board or Runs. Keep the existing roving-tab-index
keyboard implementation, now over:

```ts
const projectArtifacts = [
  { label: 'Overview', slug: 'overview' },
  { label: 'Requirements', slug: 'requirements' },
  { label: 'Plans', slug: 'plans' },
  { label: 'Board', slug: 'board' },
  { label: 'Runs', slug: 'runs' },
] as const;
```

Move approved-profile summaries and top-level attention from the bottom of the
shell into `ProjectOverview`. Keep stale/disconnected snapshots visible and
the existing command availability derivation unchanged.

- [ ] **Step 5: Apply project header, tabs, and Overview styling**

Match the approved horizontal S2 shell. Tabs scroll horizontally at narrow
width without hiding focus. At 200% zoom, project metadata wraps instead of
overlapping connection state.

- [ ] **Step 6: Run focused tests and all V2 web tests**

```powershell
corepack pnpm nx test v2-web -- --run src/components/ProjectOverview.spec.tsx src/components/FocusedProjectShell.spec.tsx
corepack pnpm nx test v2-web
```

Expected: all tests PASS with existing Board and Requirements behavior still
reachable.

- [ ] **Step 7: Commit project navigation**

```powershell
git add apps/v2-web/src/components/ProjectOverview.tsx apps/v2-web/src/components/ProjectOverview.spec.tsx apps/v2-web/src/components/FocusedProjectShell.tsx apps/v2-web/src/components/FocusedProjectShell.spec.tsx apps/v2-web/src/styles.css
git commit -m "feat(v2-web): add project workspace"
```

---

### Task 7: Move PM conversation into a project-bound drawer

**Files:**

- Create: `apps/v2-web/src/components/ProjectManagerDrawer.tsx`
- Create: `apps/v2-web/src/components/ProjectManagerDrawer.spec.tsx`
- Create: `apps/v2-web/src/components/PlansPane.tsx`
- Create: `apps/v2-web/src/components/PlansPane.spec.tsx`
- Modify: `apps/v2-web/src/components/PlanningPane.tsx`
- Modify: `apps/v2-web/src/components/PlanningPane.spec.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.spec.tsx`
- Modify: `apps/v2-web/src/styles.css`

**Interfaces:**

- Consumes: existing intent/delivery cycles, PM profiles, planning callbacks,
  connection state, and project ID.
- Produces: `PlanningSurface = 'conversation' | 'review'`,
  `ProjectManagerDrawer`, and `PlansPane`.

- [ ] **Step 1: Split planning presentation with failing tests**

Add the required surface prop to both planning panes and assert ownership:

```tsx
render(<PlanningPane surface="conversation" {...intentProps} />);
expect(screen.getByRole('textbox', { name: 'Message to project manager' }))
  .toBeVisible();
expect(screen.queryByRole('button', { name: 'Approve proposal' })).toBeNull();

render(<PlanningPane surface="review" {...intentProps} />);
expect(screen.queryByRole('textbox', { name: 'Message to project manager' }))
  .toBeNull();
expect(screen.getByRole('button', { name: 'Approve proposal' })).toBeVisible();
```

Repeat the ownership assertions for `DeliveryPlanningPane`. Conversation mode
shows a labeled link callback when a proposal awaits review; review mode owns
approve, reject, revision selection, and abandon controls.

- [ ] **Step 2: Run planning tests and verify they fail**

```powershell
corepack pnpm nx test v2-web -- --run src/components/PlanningPane.spec.tsx
```

Expected: FAIL because `surface` is not defined.

- [ ] **Step 3: Implement the explicit planning surfaces**

```ts
export type PlanningSurface = 'conversation' | 'review';
```

Require `surface` on `PlanningPane` and `DeliveryPlanningPane`. Reuse their
existing cycle selection, proposal formatting, forms, command callbacks,
history limits, recovery, and disabled reasons. Only move markup ownership;
do not copy lifecycle or command logic into the drawer or Plans page.

- [ ] **Step 4: Write failing drawer tests**

```tsx
render(
  <ProjectManagerDrawer
    projectId={project.id}
    projectName={project.displayName}
    open
    pinned={false}
    onOpenChange={onOpenChange}
    onPinnedChange={onPinnedChange}
    intent={intentConversation}
    deliveryPlan={planConversation}
  />,
);

expect(screen.getByRole('dialog', { name: 'Project manager · Mesh' }))
  .toBeVisible();
await user.keyboard('{Escape}');
expect(onOpenChange).toHaveBeenCalledWith(false);
```

Also cover pinned `<aside>` behavior, project-bound heading, active-cycle
default tab, Intent/Delivery Plan switching, focus restoration, session draft
key `mesh.v2.pm-draft:<projectId>:<purpose>`, project switching, and forced
overlay below the narrow breakpoint.

- [ ] **Step 5: Implement the drawer and Plans page**

Use the already-installed `@radix-ui/react-dialog` only for the unpinned
overlay and its focus/escape behavior. Render the pinned state as a labeled
`<aside>`. The stored pin key is `mesh.v2.pm-pinned`; draft keys are scoped by
project and purpose in `sessionStorage`.

`PlansPane` renders both planning components in `surface="review"` and the
drawer renders them in `surface="conversation"`. A proposal notice calls:

```ts
onNavigate(`/projects/${encodeURIComponent(projectId)}/plans`);
```

- [ ] **Step 6: Integrate the drawer into every project artifact**

Mount one drawer beside the artifact outlet in `FocusedProjectShell`; do not
mount it inside each tab. Keep it mounted while artifact routes change. Hide
the trigger and drawer entirely when no project snapshot exists.

- [ ] **Step 7: Run planning, drawer, shell, and type tests**

```powershell
corepack pnpm nx test v2-web -- --run src/components/PlanningPane.spec.tsx src/components/PlansPane.spec.tsx src/components/ProjectManagerDrawer.spec.tsx src/components/FocusedProjectShell.spec.tsx
corepack pnpm nx typecheck v2-web
```

Expected: tests and typecheck PASS; proposal mutations appear only in Plans.

- [ ] **Step 8: Commit the PM drawer**

```powershell
git add apps/v2-web/src/components/ProjectManagerDrawer.tsx apps/v2-web/src/components/ProjectManagerDrawer.spec.tsx apps/v2-web/src/components/PlansPane.tsx apps/v2-web/src/components/PlansPane.spec.tsx apps/v2-web/src/components/PlanningPane.tsx apps/v2-web/src/components/PlanningPane.spec.tsx apps/v2-web/src/components/FocusedProjectShell.tsx apps/v2-web/src/components/FocusedProjectShell.spec.tsx apps/v2-web/src/styles.css
git commit -m "feat(v2-web): add project PM drawer"
```

---

### Task 8: Redesign artifact and execution presentation

**Files:**

- Modify: `apps/v2-web/src/components/RequirementsPane.tsx`
- Modify: `apps/v2-web/src/components/RequirementsPane.spec.tsx`
- Modify: `apps/v2-web/src/components/BoardPane.tsx`
- Modify: `apps/v2-web/src/components/BoardPane.spec.tsx`
- Modify: `apps/v2-web/src/components/DeveloperSection.tsx`
- Modify: `apps/v2-web/src/components/DeveloperSection.spec.tsx`
- Modify: `apps/v2-web/src/components/ExecutionActivity.tsx`
- Modify: `apps/v2-web/src/components/ExecutionActivity.spec.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.tsx`
- Modify: `apps/v2-web/src/components/FocusedProjectShell.spec.tsx`
- Modify: `apps/v2-web/src/components/intent-ledger.css`
- Modify: `apps/v2-web/src/components/planning-board.css`
- Modify: `apps/v2-web/src/styles.css`

**Interfaces:**

- Consumes: existing approved ledger, server-owned Board/filter/readiness,
  developer projections, execution activity, and Task 5 `RunsView`.
- Produces: scannable Requirements, Board master-detail, and project-filtered
  Runs without domain changes.

- [ ] **Step 1: Add failing Requirements presentation tests**

Assert category counts, semantic headings, relationship text, metadata,
history disclosure, loading, empty, and error states. Retain every existing
content assertion so presentation changes cannot omit durable ledger fields.

```tsx
expect(screen.getByRole('heading', { name: 'Requirements · 3' })).toBeVisible();
expect(screen.getByRole('heading', { name: 'Decisions · 2' })).toBeVisible();
expect(screen.getByText('depends on R-2')).toBeVisible();
```

- [ ] **Step 2: Add failing Board master-detail tests**

```tsx
render(<BoardPane {...props} />);
await user.click(screen.getByRole('button', { name: 'Open Build controls' }));
expect(screen.getByRole('region', { name: 'Task details' })).toHaveTextContent(
  'Build controls',
);
expect(screen.getByRole('region', { name: 'Developer for Build controls' }))
  .toBeVisible();
```

Assert one selected task at a time, Escape/close focus restoration, filters and
counts unchanged, disabled reasons preserved, stale Board blocking preserved,
and no task selection in empty filtered results.

- [ ] **Step 3: Add failing project Runs tests**

Render the shell with `artifact="runs"` and `selectedId={execution.id}`, assert
only the selected project's execution summaries reach `RunsView`, and retain
existing `ExecutionActivity` diagnostic, child activity, resolved skill,
runtime activity, and cursor assertions in the selected detail. For Board,
pass `selectedId` as its controlled task selection and navigate with
`appHref({ page: 'project', projectId, artifact: 'board', selectedId })` when a
card is opened; Runs uses the equivalent `run` query produced by `appHref`.

- [ ] **Step 4: Run affected tests and verify they fail**

```powershell
corepack pnpm nx test v2-web -- --run src/components/RequirementsPane.spec.tsx src/components/BoardPane.spec.tsx src/components/DeveloperSection.spec.tsx src/components/ExecutionActivity.spec.tsx src/components/FocusedProjectShell.spec.tsx
```

Expected: new presentation assertions FAIL.

- [ ] **Step 5: Implement presentation-only changes**

Keep existing data and callbacks. Requirements groups become counted sections
with compact record cards and native `<details>` for revision/history depth.
Board keeps its server-provided filter facets and cards but renders one
selected task in a neighboring detail region. Developer and execution details
use definition lists and disclosure controls instead of undifferentiated text.
Project Runs passes:

```ts
runsFromSnapshots([snapshot])
```

to `RunsView` and renders existing live `ExecutionActivity` evidence for the
selected execution.

- [ ] **Step 6: Apply responsive artifact styling**

Use component-owned CSS already present in `intent-ledger.css` and
`planning-board.css`. Stack master-detail below 56rem, preserve Board overflow,
wrap long Windows paths and identifiers, keep focus visible, and express each
warning with text plus the semantic status color.

- [ ] **Step 7: Run affected tests and the complete V2 web suite**

```powershell
corepack pnpm nx test v2-web -- --run src/components/RequirementsPane.spec.tsx src/components/BoardPane.spec.tsx src/components/DeveloperSection.spec.tsx src/components/ExecutionActivity.spec.tsx src/components/FocusedProjectShell.spec.tsx
corepack pnpm nx test v2-web
```

Expected: all tests PASS and existing behavior assertions remain intact.

- [ ] **Step 8: Commit artifact presentation**

```powershell
git add apps/v2-web/src/components/RequirementsPane.tsx apps/v2-web/src/components/RequirementsPane.spec.tsx apps/v2-web/src/components/BoardPane.tsx apps/v2-web/src/components/BoardPane.spec.tsx apps/v2-web/src/components/DeveloperSection.tsx apps/v2-web/src/components/DeveloperSection.spec.tsx apps/v2-web/src/components/ExecutionActivity.tsx apps/v2-web/src/components/ExecutionActivity.spec.tsx apps/v2-web/src/components/FocusedProjectShell.tsx apps/v2-web/src/components/FocusedProjectShell.spec.tsx apps/v2-web/src/components/intent-ledger.css apps/v2-web/src/components/planning-board.css apps/v2-web/src/styles.css
git commit -m "style(v2-web): clarify project artifacts"
```

---

### Task 9: Compose routes, global loading, and project behavior

**Files:**

- Modify: `apps/v2-web/src/app/App.tsx`
- Modify: `apps/v2-web/src/app/App.spec.tsx`
- Modify: `apps/v2-web/src/components/shell-state.ts`

**Interfaces:**

- Consumes: all prior route, loader, shell, page, and project interfaces plus
  the existing V2 API/socket/command contracts.
- Produces: the complete attention-first V2 browser while preserving command
  and realtime ownership.

- [ ] **Step 1: Add failing global composition tests**

```tsx
render(<App {...dependencies} />);
expect(await screen.findByRole('heading', { name: 'Needs attention' }))
  .toBeVisible();

await user.click(screen.getByRole('link', { name: 'Runs' }));
expect(history.pushState).toHaveBeenCalledWith(null, '', '/runs');
expect(api.projectSnapshot).toHaveBeenCalled();

await user.click(screen.getByRole('link', { name: 'Projects' }));
expect(screen.getByLabelText('Repository path')).toBeVisible();
```

Assert the global loader is enabled only for Inbox/Runs, uses `0` for Inbox and
`5000` for Runs, renders partial failures, and never creates a project socket
on global routes.

- [ ] **Step 2: Add failing project composition tests**

Navigate to every project artifact URL and assert the project socket remains a
single connection while tabs change. Open a Board task and Run, then exercise
refresh and browser back/forward to prove their `task`/`run` query selections
round-trip. Assert the PM drawer is present on every project artifact and absent
globally. Exercise unknown project, invalid artifact, encoded project ID,
route-owned command abort, stale snapshot, disconnect, resync, and audit
barrier.

- [ ] **Step 3: Run App tests and verify they fail**

```powershell
corepack pnpm nx test v2-web -- --run src/app/App.spec.tsx
```

Expected: new route and page assertions FAIL.

- [ ] **Step 4: Replace conditional root/project rendering with route composition**

Add `readonly search: string` to the existing `AppLocation` type. Parse the
pathname and query once per render, and include both in popstate route
ownership:

```ts
const route = parseAppRoute(location.pathname, location.search);
const globalSnapshots = useGlobalProjectSnapshots({
  api,
  projects: system.status === 'ready' ? system.snapshot.projects : [],
  enabled: route.page === 'inbox' || route.page === 'runs',
  pollIntervalMs: route.page === 'runs' ? 5000 : 0,
});
```

Render every ready route inside `AppShell`. Keep `ProjectConnection` as the only
owner of `useProjectConnection`, project command callbacks, freshness conflict
resync, and command cancellation. Pass `route.artifact` into
`FocusedProjectShell`; artifact navigation calls `navigate(appHref(...))` and
therefore does not remount `ProjectConnection` for the same project. Pass
`route.selectedId` to the project shell; task/run selection calls the same
native navigation path so its query is durable in browser history.

- [ ] **Step 5: Preserve registration and error ownership**

Successful registration navigates to Overview:

```ts
navigate(appHref({
  page: 'project',
  projectId: result.project.id,
  artifact: 'overview',
}));
```

Keep the current pending envelope, route generation, abort controller, audit
barrier trip, and error mapping behavior. Unknown project and invalid routes
render explicit errors with a link to `/projects`; never select a fallback.

- [ ] **Step 6: Run App tests, suite, typecheck, and build**

```powershell
corepack pnpm nx test v2-web -- --run src/app/App.spec.tsx
corepack pnpm nx test v2-web
corepack pnpm nx typecheck v2-web
corepack pnpm nx build v2-web
```

Expected: all commands PASS; the production build adds no new dependency
chunk.

- [ ] **Step 7: Commit application composition**

```powershell
git add apps/v2-web/src/app/App.tsx apps/v2-web/src/app/App.spec.tsx apps/v2-web/src/components/shell-state.ts
git commit -m "feat(v2-web): compose attention-first UI"
```

---

### Task 10: Prove the integrated experience and document it

**Files:**

- Modify: `e2e-v2/src/v2-foundation.spec.ts`
- Modify: `docs/development/architecture.md`
- Modify: `docs/development/session-platform.md`

**Interfaces:**

- Consumes: the complete V2 browser, existing `V2ProcessFixture`, fake PM and
  developer scenarios, and existing restart/replay controls.
- Produces: integrated acceptance proof and current operator/developer
  guidance.

- [ ] **Step 1: Add an Inbox-to-proposal browser scenario**

Using `V2ProcessFixture.createTodo`, register the project, create an awaiting
delivery-plan proposal through the existing fake PM flow, navigate to `/`, and
assert:

```ts
await expect(page.getByRole('heading', { name: 'Needs attention' }))
  .toBeVisible();
await page.getByRole('link', { name: 'Review in project' }).click();
await expect(page).toHaveURL(
  new RegExp(`/projects/${fixture.projectId}/plans$`),
);
await expect(
  page.getByRole('button', { name: 'Approve full plan' }),
).toBeVisible();
```

Assert no approval command is sent before the canonical Plans control is used.

- [ ] **Step 2: Add an active-run navigation scenario**

Start a fake developer attempt, navigate to `/runs`, and assert the active row
shows the project and assignment. Open it and assert the project Runs route
shows existing runtime activity and cursor evidence. Complete the fake run and
use `expect.poll` on visible lifecycle text; do not add sleeps.

- [ ] **Step 3: Add PM, theme, and responsive scenarios**

Within one project, type an unsent Intent draft, navigate from Overview to
Board, and assert the same project-bound drawer and draft remain. Assert the PM
control is absent after navigating to global Inbox. Select Dark, reload, and
assert `document.documentElement.dataset.theme === 'dark'`. At a 320 CSS-pixel
viewport and at 200% zoom, assert navigation, PM overlay, proposal action, and
Board task detail remain reachable by keyboard.

- [ ] **Step 4: Add partial/disconnected/audit scenarios**

Route one project snapshot request to a deterministic 503 and assert the Inbox
keeps healthy project attention plus a project-named alert. Reuse the existing
WebSocket hold/resync fixture to prove a stale project retains its durable
snapshot and disables commands. Reuse the existing audit barrier fixture to
prove the global banner and mutation disabling remain visible.

- [ ] **Step 5: Run the focused browser scenarios**

Give the new tests the shared title prefix `attention-first UI`, then run:

```powershell
corepack pnpm nx e2e v2-e2e -- --grep "attention-first UI"
```

Expected: the scenarios PASS against Tasks 1–9. If a scenario exposes an
integration defect, fix only the named V2 web boundary and rerun that scenario;
do not weaken locators, increase timeouts, add arbitrary waits, or change server
contracts.

- [ ] **Step 6: Update architecture and operating guidance**

Document the exact route table, snapshot aggregation boundary, Inbox
projection semantics, Runs polling interval, project-only PM scope, theme
storage keys, and the unchanged project realtime flow. Include this flow in
`architecture.md`:

```text
global Inbox or Runs
  -> existing system snapshot project list
  -> cancellable existing project snapshot reads
  -> client-only attention/run projection
  -> navigation to authoritative project artifact

project artifact
  -> existing project snapshot and durable replay
  -> existing project WebSocket subscription
  -> existing command and resync behavior
```

- [ ] **Step 7: Run documentation and full verification gates**

```powershell
corepack pnpm exec prettier --check docs/development/architecture.md docs/development/session-platform.md
corepack pnpm verify
```

Expected: formatting and the complete repository verification gate PASS. Do
not run the opt-in real Claude smoke test.

- [ ] **Step 8: Review the final diff for scope and safety**

```powershell
git diff --check
git status --short
git diff --stat origin/master...HEAD
git diff --name-only origin/master...HEAD
```

Expected: only the V2 web, V2 fake-driver browser test, and two approved docs
surfaces are changed; contracts, server, persistence, and runtime files are
absent.

- [ ] **Step 9: Commit integrated proof and documentation**

```powershell
git add e2e-v2/src/v2-foundation.spec.ts docs/development/architecture.md docs/development/session-platform.md
git commit -m "test(v2): prove attention-first UI"
```

---

## Completion Gate

Before asking for hands-on testing:

```powershell
corepack pnpm nx test v2-web
corepack pnpm nx typecheck v2-web
corepack pnpm nx build v2-web
corepack pnpm nx e2e v2-e2e -- --grep "attention-first UI"
corepack pnpm verify
git status --short --branch
```

All commands must pass, the worktree must be clean, and no real Claude session
may be started. Do not create or publish a pull request until the maintainer
explicitly requests it.
