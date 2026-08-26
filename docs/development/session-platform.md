# Session platform development

## Prerequisites and local flow

Install Node.js 22+, Corepack/pnpm, Git, and Chromium for Playwright. From the repository root:

```powershell
corepack pnpm install
corepack pnpm exec playwright install chromium
corepack pnpm nx dev server
corepack pnpm nx dev web
```

The server listens only on a loopback address. Its default origin is `http://127.0.0.1:3737`; the development web origin is exactly `http://127.0.0.1:4200`. Runtime data defaults to `~/.mesh-session-platform/session-platform.sqlite`. Override the directory with `MESH_DATA_DIR` or the database filename with `MESH_DATABASE_PATH`.

## Project and task operation

Use **Import repository** to create a durable project from a local Git
repository. Repository discovery only supplies suggestions; it never creates a
project. A project owns its tasks and ordered project-event stream. Each task
attempt remains in immutable history and links the task to one session, while
the session keeps its own lifecycle and event stream.

To run a task, give it a title, description, at least one acceptance criterion,
and a priority, then move it to `ready`. Launch chooses the existing shared or
isolated-worktree workspace composition and a permission mode. Mesh persists the
session and attempt before starting the fake or real driver, and moves the task
to `in_progress` only after startup succeeds. A startup failure leaves the task
`ready`, keeps the failed launch's attempt visible, and allows a later explicit
attempt. For overlapping work, prefer an isolated worktree and inspect any
preserved worktree before cleanup.

Milestone 2 completion is human-only. An agent session can do the work, but only
a human actor may move a task to `review` or `done`. Do not automate those
transitions; the actor and policy contracts exist so a later milestone can add
authority explicitly.

On restart, Mesh reconciles attempts against durable session truth. It reports
`startup_outcome_unknown` when a retained launch has no trustworthy startup
outcome, and `task_in_progress_without_live_session` when an in-progress task no
longer has a live current session. These repair conditions are operator-visible;
do not delete history or guess the missing outcome. Inspect the task, attempt,
session diagnostics, and preserved workspace before choosing a human recovery
action.

## Developer execution workflow

Configure **Developer instructions** on the project before starting work. The
editor saves a revisioned project value, so a stale save is rejected instead of
overwriting a newer edit. Instructions apply to future Developer cycles. Every
cycle records the exact instruction revision and content it received; editing
the project while a Developer is running does not rewrite that cycle's prompt or
history.

To start Developer, make the task `ready`, complete its title, description,
acceptance criteria, and priority, and clear any blocker. In the task drawer,
choose a shared workspace or isolated worktree and a permission mode, then select
**Start Developer**. Mesh creates a session, attempt, and first execution cycle
before starting Claude. The cycle's prompt contains the frozen task and project
instructions and exposes only the scoped `submit_for_review` and `mark_blocked`
controls. If startup fails, the durable attempt and diagnostics remain visible;
Mesh does not claim that the task is running.

Use **Execution history** as the durable review record. Each entry identifies
the attempt, cycle, session, workspace, permission mode, task revision,
instruction revision, and terminal disposition. A completion report maps every
acceptance criterion to its result and evidence and records verification,
limitations, and workspace state. A blocker report records why progress stopped,
the evidence gathered, recovery guidance, and workspace state. Opening the
linked session shows the separate runtime transcript; it does not replace the
project report.

When a completion report moves the task to `review`, inspect the report,
workspace, and session as needed. **Accept as done** completes the task. To
reject it, enter actionable feedback and choose either **Resume the same
Developer attempt** or **Start a new Developer attempt**. Resume requires the
original session's Claude resume ID and the same cycle workspace; a new attempt
requires a new workspace and permission selection. Either choice persists the
feedback and starts a new cycle with the current task and project-instruction
truth. Previous cycles and reports remain immutable history.

When Developer reports a blocker, the task stays `in_progress` with a durable
blocked condition. Resolve the external issue first, enter an unblock reason,
then choose **Resume the blocked attempt** or **Start a new attempt after
unblock**. Mesh records the feedback and new cycle before starting work. A failed
resume or new launch closes the failed cycle and restores the prior review or
blocked truth when it can do so safely; an uncertain cleanup becomes an explicit
repair state.

`developer_cycle_without_live_session` means durable project truth says a cycle
is active but no live session can continue it. Do not manufacture a completion
or delete its history. Inspect the attempt, session diagnostics, and workspace,
preserve any files, and use the offered human recovery only after deciding which
state is trustworthy. Startup, task-transition, or cleanup uncertainty is
handled the same way: retain the evidence and workspace until an operator can
reconcile it.

## Subscription-only operation

Mesh uses the installed Claude subscription through the Claude Agent SDK. It
does not support an API-key or pay-per-token fallback. This applies equally to
starting Developer and to the resume paths after rejection or unblock. If
`ANTHROPIC_API_KEY` is present, new and resumed sessions are refused. Remove the
variable outside Mesh, verify the intended Claude subscription is active, and
restart Mesh.

Multiple live sessions that share a folder can modify the same files. Mesh warns about this collision; prefer an isolated worktree when sessions may overlap. Mesh-created worktrees are preserved on archive and on failed or ambiguous cleanup. Deletion removes one only after explicit confirmation and ownership/path checks; otherwise remove or preserve it manually with Git after inspecting its changes.

On backend shutdown, live sessions are interrupted before the database closes. If a process stops without completing that sequence, the next start records a durable `backend_restart` transition from the previous live state to `interrupted`. Closing a panel or browser does not stop its backend session.

## Verification

The normal local and CI gate is:

```powershell
corepack pnpm verify
```

It runs formatting, lint, type checking, unit tests, builds, and deterministic Chromium acceptance tests. The acceptance fixture uses the production-built server and web assets, a temporary SQLite database and temporary Git repositories, and an in-process fake Claude driver available only under explicit test configuration. It covers explicit import, task launch and failure retention, human review/completion, and refresh recovery without contacting Claude. Failure traces and screenshots are retained under `tmp/playwright/session-platform`.

Windows Chromium is the required acceptance environment. The same test suite is the portable basis for future macOS/Linux matrix entries.

The real Claude smoke is separate and opt-in:

```powershell
$env:MESH_RUN_CLAUDE_SMOKE = '1'
corepack pnpm nx external-smoke server
```

This consumes real subscription capacity and can hit subscription limits. Never add it to `pnpm verify`, CI defaults, or an API-key-backed fallback.
