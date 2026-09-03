# Mesh V2 UI Overhaul Design

**Status:** Approved for implementation planning

**Date:** 2026-09-02

## Purpose

Replace the milestone-oriented V2 browser shell with an operator-facing
workspace that answers the first question Mesh should answer: **what needs my
attention?** The overhaul preserves the existing V2 domain, command, audit,
persistence, and realtime behavior. It reorganizes and restyles those existing
capabilities instead of introducing a second source of truth.

## Current State

The V2 browser currently proves each milestone's behavior in one focused
project shell. The root route selects or registers a project. A selected
project permanently places intent and delivery-planning conversations in a
left pane, Board and Requirements in tabs, and profiles, executions, and
attention details below them. The shell is functional and accessible, but its
information hierarchy follows implementation milestones rather than operator
tasks.

The main composition is concentrated in `apps/v2-web/src/app/App.tsx` and
`FocusedProjectShell.tsx`. Existing leaf components already own the important
behavior:

- `PlanningPane` and `DeliveryPlanningPane` own PM conversations and proposal
  actions.
- `RequirementsPane` owns the approved intent ledger.
- `BoardPane` and `DeveloperSection` own Board filtering, task detail, and
  developer commands.
- `ExecutionActivity` owns durable and transient execution evidence.
- `useProjectConnection` owns project snapshot, replay, reconnect, and resync.

The redesign keeps those behaviors and changes their composition.

## Goals

- Make cross-project attention the global landing experience.
- Keep running agents visible in a separate, active-first view.
- Give each project an overview and artifact-oriented navigation.
- Make the project manager available throughout a selected project without
  permanently consuming workspace width.
- Establish a coherent responsive visual system with System, Light, and Dark
  themes.
- Preserve current safety boundaries, durable truth, commands, and reconnect
  behavior.

## Non-goals

- No new server endpoint, global event stream, contract, migration, or durable
  UI state.
- No new command or inline global action. Global cards navigate to the
  canonical project artifact where the existing command is performed.
- No React router, component library, icon package, CSS framework, or general
  design-system package.
- No redesign of domain language, planning policy, Board readiness, execution
  lifecycle, or audit behavior.
- No dashboards, analytics, notification service, or saved global filters.

## Information Architecture

### Global shell

A persistent narrow rail contains three destinations:

1. **Inbox** — the default route and cross-project attention queue.
2. **Runs** — active agents first, with recent completed history available.
3. **Projects** — registered repositories and repository registration.

System health and the theme selector remain in the application header. The
project manager is absent from every global route because it has no safe
project context there.

### Routes

```text
/                                      Global Inbox
/runs                                  Global Runs
/projects                              Projects and registration
/projects/:projectId                   Project Overview
/projects/:projectId/requirements      Approved requirements ledger
/projects/:projectId/plans             Intent and delivery plans
/projects/:projectId/board             Task Board
/projects/:projectId/runs              Project-filtered Runs
```

The existing History API integration is extended with native URL parsing and
`URLSearchParams`; no routing dependency is added. A valid URL is the source of
truth for the selected global page, project, artifact, and task or run detail
when a detail is linkable.

### Global Inbox

The Inbox uses a master-detail layout. The left side lists ranked attention
items and exposes simple category and project filters. The right side explains
the selected item, its durable context, and the destination action. Selecting
the primary control navigates to the authoritative project artifact; it never
approves, interrupts, retries, or mutates directly from the global view.

Attention items are a pure client projection from persisted project
snapshots. The initial categories are:

1. audit or ambiguous-runtime attention already exposed by the project
   snapshot;
2. failed or attention-required developer attempts and executions;
3. intent or delivery-plan proposals awaiting a human decision;
4. stale approved planning material that requires operator review; and
5. Board tasks that are ready for an operator to start.

Items are ordered by category severity, then newest relevant durable revision
or event cursor, then project display name and stable identity. The projection
does not claim an item is acknowledged or resolved; disappearance from the
next durable snapshot is the only resolution signal.

Empty Inbox copy states that no project needs attention. A partially
unavailable project appears as a project-scoped warning and does not hide
healthy results.

### Global Runs

Runs opens on **Active** and shows active agent executions across projects.
Each row names the project, assignment, lifecycle, elapsed time, and latest
available durable stage. Selecting a row opens its project-scoped run detail,
where the existing project connection supplies transient activity and durable
execution evidence.

A **History** tab shows recent completed, failed, and interrupted executions
already present in the fetched snapshots. It is a recent-history convenience,
not a replacement for durable diagnostics or an unbounded audit browser.

### Projects

Projects replaces the current root selector. It lists registered repositories,
their path, and a small snapshot-derived status summary. Registration keeps
the existing explicit path form, validation, audit barrier, idempotency, and
error handling. Successful registration navigates to the new project
Overview.

### Project workspace

The project header shows display name, canonical repository path, connection
state, and cursor diagnostics without allowing diagnostics to dominate the
page. Horizontal artifact navigation contains:

- **Overview** — local attention, approved intent/plan summaries, current
  lifecycle, and next actions;
- **Requirements** — the existing approved ledger reorganized for scanning by
  requirement, decision, assumption, question, and risk;
- **Plans** — current intent and delivery-plan state, detailed proposals,
  approval and rejection controls, approved artifacts, and history;
- **Board** — existing server-owned readiness and filtering with a clearer
  master-detail task presentation; and
- **Runs** — the global Runs presentation filtered to the selected project.

The Overview is the default project route. Project tabs are URL-backed and
keyboard navigable. Existing command availability and disabled reasons remain
owned by the current project model.

### Project manager drawer

The PM drawer exists only while a project is selected and is always bound to
that project. It composes the existing intent and delivery-planning cycles and
submit-turn commands rather than creating a new conversation model. **Intent**
and **Delivery Plan** sections expose their respective conversation history and
composer; the section with the active cycle opens by default. Proposal notices
in the drawer link to Plans, where detailed review and lifecycle actions remain
canonical.

The project header exposes one PM control:

- **Auto-hidden:** the drawer opens over the workspace, closes with Escape or
  its close control, and restores focus to the PM control.
- **Pinned:** the drawer occupies the right column while the central artifact
  remains usable.
- **Narrow viewport:** it is always an overlay even when the stored preference
  is pinned.

The pin preference is stored locally. The mounted project workspace retains
the selected PM section and draft while navigating among that project's
artifacts. Drafts are scoped by project and kept in `sessionStorage` so a
reload in the same browser session does not destroy unsent input or leak it to
another project.

## Visual System

The approved direction is a high-contrast hybrid shell:

- a stable dark global rail separates application navigation from project
  content;
- light and dark work canvases share the same hierarchy and semantic tokens;
- indigo identifies selection and primary action;
- green, amber, and red are reserved for explicit status semantics;
- typography, spacing, borders, and elevation provide hierarchy before color;
  and
- dense identifiers and paths use the existing system monospace stack only
  where they improve scanning.

CSS custom properties define one semantic token set. The selector offers
**System**, **Light**, and **Dark**. System follows
`prefers-color-scheme`; an explicit choice is saved in `localStorage`. System
is the default when no choice is saved. No server preference or theme package
is introduced.

Motion is limited to brief drawer and selection transitions and is disabled by
`prefers-reduced-motion`.

## Component Boundaries

The implementation should split composition, not rewrite behavior:

```text
App
  AppShell
    GlobalNavigation
    ApplicationHeader
    InboxPage
    GlobalRunsPage
    ProjectsPage
    ProjectWorkspace
      ProjectHeader
      ProjectNavigation
      ProjectOverview
      RequirementsPane
      PlansPage
        PlanningPane
        DeliveryPlanningPane
      BoardPane
      ProjectRunsPage
      ProjectManagerDrawer
```

`App` retains system snapshot loading, route ownership, and registration
command wiring. `ProjectWorkspace` retains `useProjectConnection` and the
existing project command callbacks. The current planning components are split
along their existing responsibilities: reusable conversation sections feed
the PM drawer, while proposal detail and approve/reject/abandon controls feed
Plans. Board, developer, and execution components remain the behavior owners.

Two small pure modules are justified:

- route parsing/formatting for the expanded native routes; and
- global snapshot projection for attention items and run summaries.

Reusable visual primitives should be plain semantic markup and CSS classes.
Do not create a generalized UI component layer merely to restyle a handful of
screens.

## Global Snapshot Loading

The existing system snapshot lists projects but does not contain their
attention or run details. Global pages therefore load existing project
snapshots with `Promise.allSettled` only while needed:

```text
enter Inbox or Runs
  -> read projects from the system snapshot
  -> fetch each existing project snapshot with cancellation
  -> retain successes and project-scoped failures
  -> project snapshots feed pure attention/run projections
```

Inbox refreshes on entry, window focus, and explicit refresh. Global Runs
refreshes every five seconds while visible and stops immediately when hidden
or unmounted. Overlapping requests are cancelled rather than queued. Project
routes continue using their current snapshot, durable replay, transient
activity, reconnect, and resync flow.

This per-project polling is the deliberate small-system choice for a local
operator with a modest registered-project count. A server-owned global summary
or event stream is warranted only after measured project count or refresh cost
makes polling inadequate.

## State and Failure Behavior

- Loading, empty, partial, stale, disconnected, and command-failure states are
  distinct and visible.
- A failed project snapshot contributes a warning to a global page while other
  project data remains usable.
- Global refresh preserves the previous successful projection until the new
  settled result is available; it does not replace content with a loading
  flash.
- A stale or disconnected project keeps its last durable snapshot visible,
  labels it clearly, and disables unsafe commands through the existing
  availability model.
- Audit barrier state is globally prominent and disables all mutations.
- Command errors stay next to the initiating control. Safe retries reuse the
  existing idempotency behavior.
- Browser back/forward owns navigation. Route changes cancel stale global
  loads and project commands according to the existing ownership pattern.
- Unknown projects or artifact routes show a useful error and a route back to
  Projects; they never silently select another project.

## Accessibility and Responsive Behavior

- Global and project navigation use landmarks, current-page semantics, and
  visible focus indicators.
- Project artifact tabs retain arrow, Home, and End keyboard behavior.
- Drawer open/close manages focus and exposes an accessible label tied to the
  selected project.
- Status is always conveyed with text as well as color. All theme combinations
  meet WCAG AA contrast for normal text and controls.
- The application remains usable at 200% zoom and a 320 CSS-pixel viewport.
- On narrow screens the global rail condenses, master-detail views stack, and
  the PM drawer becomes an overlay. No command becomes pointer-only.
- Reduced-motion preferences disable nonessential transitions.

## Verification

### Pure projection tests

- attention classification, severity ordering, stable tie-breaking, and
  artifact destinations;
- active and history run summaries;
- partial snapshot failures and empty project lists; and
- route parsing and formatting, including encoded project identifiers and
  invalid URLs.

### Component tests

- global rail and browser back/forward navigation;
- Inbox loading, empty, partial, selected-detail, and refresh states;
- active-first Runs polling, cancellation, History, and project filtering;
- Projects registration success and existing failure states;
- project Overview and artifact routing;
- project-only PM availability, project binding, pinning, focus restoration,
  draft isolation, and narrow-screen overlay behavior;
- System/Light/Dark selection and stored preference; and
- stale, disconnected, audit-barrier, command-disabled, and retry states.

Existing focused tests for planning, requirements, Board, developer attempts,
execution activity, replay, resync, and command idempotency remain in force.

### Integrated browser checks

Using only temporary repositories, temporary databases, and the fake driver:

1. an Inbox decision navigates to the matching project proposal;
2. a global active run navigates to project-scoped live activity;
3. project artifact navigation preserves the project-bound PM drawer and
   draft;
4. partial global failure, project disconnect, and audit barrier remain clear
   and safe;
5. light, dark, keyboard, 200% zoom, and narrow-screen paths remain usable.

Iteration uses the narrow V2 web target. Completion requires
`corepack pnpm verify`. Visual evidence for both themes and narrow layout is
captured only when a pull request is requested.

## Affected Surfaces

- **Web:** substantial V2 route, composition, projection, styling, and test
  changes.
- **Realtime:** existing project connection behavior is reused without contract
  changes.
- **Commands:** existing validation, command handling, idempotency, and error
  mapping are preserved.
- **Contracts:** unchanged.
- **Runtime and persistence:** unchanged.
- **Workspace safety:** repository registration and canonical path display keep
  their current checks.
- **Operating modes:** development and production V2 builds, Windows paths,
  fake driver, fresh database, and existing database remain covered by current
  behavior plus the new UI checks.
- **Documentation:** architecture and operator guidance describe the new route
  and attention model.

## Acceptance Criteria

- The root route is an attention-first global Inbox across registered
  projects.
- Global Runs shows active agents first and recent completed history without a
  new global realtime protocol.
- Projects and registration have their own global destination.
- Every project opens on Overview and exposes Requirements, Plans, Board, and
  Runs as horizontal artifact navigation.
- The PM drawer is available on every project artifact, unavailable globally,
  always project-bound, auto-hideable, pinnable, and responsive.
- System, Light, and Dark themes use one accessible semantic token system and
  preserve operator preference locally.
- Existing durable truth, audit barriers, command safety, reconnect, replay,
  resync, and domain behavior are unchanged.
- Focused tests and integrated fake-driver checks prove navigation, state,
  accessibility, and failure behavior.
