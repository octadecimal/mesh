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

Lifecycle authority is explicit. A Developer agent may move its current task to
`review` only by submitting a complete criterion report through its scoped
control. A human may accept reviewed work as `done`. The bounded autonomous-
review policy may complete verified work only after a structured QA verdict; it
does not gain general task-editing or scheduling authority.

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

## QA review workflow

Configure **QA instructions** and the project **Review policy** in project
settings. Both values are revisioned, and each QA cycle records the exact task,
acceptance criteria, Developer report, QA instructions, built-in policy version,
and review policy it received. Later settings changes affect future cycles only.
Repository-specific QA instructions can name verification commands and
conventions, but cannot broaden workspace, source-authoring, billing, or task
authority.

Choose `manual` when a human should control every handoff. After the current
Developer cycle submits for review, select **Start QA** in the task drawer. Mesh
creates a separate QA session and cycle in the Developer attempt's exact
workspace. QA can read the submitted source and request named verification
commands through Mesh's constrained runner, but receives no shell and cannot
write source, create another worktree, commit, merge, or create a pull request.
Mesh captures Git-tracked source at launch, after each verification command,
and immediately before verdict persistence. A capture is accepted only when
two consecutive full observations (forward, then reverse) agree on the tracked
path set, per-file metadata, and content. Capture retries are bounded; ongoing
churn pauses review and prevents a verdict. Ordinary filesystems do not provide
a cross-file transaction here, so the accepted pair proves stability across
those observations rather than locking the workspace. A write after the
accepted observation is a new concurrent mutation; Mesh does not claim
filesystem-transaction atomicity. Its structured report covers every
snapshotted acceptance criterion and records evidence, verification performed,
residual risks, and workspace state.
After a verified verdict, a human may accept the task as done. After a rejection,
a human chooses the appropriate Developer rework action. Manual mode never
advances or resumes work merely because a verdict arrived.

Choose `autonomous_review` only after confirming that automatic QA and Developer
resumes may consume Claude subscription quota. The policy change governs future
actions and does not silently process a task already waiting in review; enable
automation explicitly for that task when desired. In a healthy enabled loop,
Mesh starts QA after the current Developer submission commits, moves a verified
task to `done`, and resumes the same Developer session after rejection. It does
not choose another task, create a fresh attempt, or switch workspaces.

The autonomous rejection budget is three QA rejections since the latest human-
authorized initial Developer launch or human rework decision. The first and
second rejection may resume the same Developer session. The third records the
report and pauses automation with the task still in `review`; no fourth role
cycle starts. A new human rework decision resets the budget. Switching the
project policy to `manual` or selecting **Pause automation** prevents future
automatic actions without silently interrupting a session already running;
session interruption remains a separate visible command.

When automation is paused or disabled for a task under the autonomous project
policy, a human may start QA explicitly; that launch is audited and does not
reenable automatic follow-up. If a QA runtime dies without a verdict,
reconciliation shows a repair warning. After confirming the runtime is no
longer live, **Mark QA interrupted** closes the cycle without fabricating a
verdict, fails its pending automatic launch action, preserves its history, and
allows a later human QA retry.

Use the QA panel and **Execution history** to inspect the active role, exact
workspace, policy snapshot, remaining rejection budget, chronological Developer
and QA cycles, criterion-by-criterion evidence, linked session transcript,
automatic actions, and pause or repair reason. These durable reports and events,
not transcript prose or process exit, determine the task outcome. Refresh and
reconnect replay the same project history in order.

Recovery is deliberately conservative. QA startup failure keeps the QA session,
cycle, and diagnostics while preserving the prior task truth. Developer resume
failure keeps the rejection and feedback and leaves the task in `review`.
Interrupted or outcome-unknown QA, audit failure, a missing or ambiguous
workspace, workspace identity mismatch, and unexpected source changes all pause
the loop with work and evidence preserved. Inspect the task, both linked
sessions, reports, diagnostics, and workspace before using the offered state-
specific repair action. Recovery never infers a verdict, deletes history,
creates a fallback attempt, or bypasses workspace ownership checks.

## Subscription-only operation

Mesh uses the installed Claude subscription through the Claude Agent SDK. It
does not support an API-key or pay-per-token fallback. This applies equally to
starting Developer, starting QA, and the resume paths after rejection or
unblock. Startup now requires the SDK to positively report a first-party
subscription and no API-key source. Environment keys, API-key helpers, and
keys managed by `/login` are all refused; ambiguous account metadata also fails
closed. Remove the conflicting key outside Mesh, verify the intended Claude
subscription login is active, and restart Mesh. Manual QA consumes subscription quota when a human
starts it. Enabled autonomous review may consume quota for each automatic QA
start and each Developer resume; the explicit consent, rejection ceiling, and
pause control bound that behavior.

Multiple live sessions that share a folder can modify the same files. Mesh warns about this collision; prefer an isolated worktree when sessions may overlap. Mesh-created worktrees are preserved on archive and on failed or ambiguous cleanup. Deletion removes one only after explicit confirmation and ownership/path checks; otherwise remove or preserve it manually with Git after inspecting its changes.

On backend shutdown, live sessions are interrupted before the database closes. If a process stops without completing that sequence, the next start records a durable `backend_restart` transition from the previous live state to `interrupted`. Closing a panel or browser does not stop its backend session.

## Verification

The normal local and CI gate is:

```powershell
corepack pnpm verify
```

It runs formatting, lint, type checking, unit tests, builds, and deterministic
Chromium acceptance tests. The acceptance fixture uses the production-built
server and web assets, a temporary SQLite database and temporary Git
repositories, and an in-process fake Claude driver available only under
explicit test configuration. It covers explicit import, task launch and failure
retention, manual QA, bounded autonomous rejection/rework, verified completion,
and refresh recovery without contacting Claude or consuming Claude subscription
quota. Failure traces and screenshots are retained under
`tmp/playwright/session-platform`.

Windows Chromium is the required acceptance environment. The same test suite is the portable basis for future macOS/Linux matrix entries.

The real Claude smoke is separate and opt-in:

```powershell
$env:MESH_RUN_CLAUDE_SMOKE = '1'
corepack pnpm nx external-smoke server
```

This consumes real subscription capacity and can hit subscription limits. Never add it to `pnpm verify`, CI defaults, or an API-key-backed fallback.
