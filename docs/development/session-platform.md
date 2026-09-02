# Session platform development

This guide documents the established V1 session platform. Its `server`, `web`,
and `e2e` commands and `MESH_*` settings do not apply to V2. For the parallel V2
Milestone 1 foundation, see [V2 foundation development](v2-foundation.md).

## Prerequisites and local flow

Install Node.js 22+, Corepack/pnpm, Git, and Chromium for Playwright. From the repository root:

```powershell
corepack pnpm install
corepack pnpm exec playwright install chromium
corepack pnpm nx dev server
corepack pnpm nx dev web
```

The server listens only on a loopback address. Its default origin is `http://127.0.0.1:3737`; the development web origin is exactly `http://127.0.0.1:4200`. Runtime data defaults to `~/.mesh-session-platform/session-platform.sqlite`. Override the directory with `MESH_DATA_DIR` or the database filename with `MESH_DATABASE_PATH`.

Mesh approves one Git executable at server startup and reuses it for repository
and QA operations. Set `MESH_GIT_EXECUTABLE` to an absolute executable path for
a custom, portable, LocalAppData, or Nix installation. If it is omitted, Mesh
examines only absolute startup `PATH` entries; empty, relative, and
workspace-contained entries are ignored. Approval canonicalizes the executable,
records its identity outside the configured workspace root, and is revalidated
before each use. Runtime execution does not rediscover Git through `PATH`,
`SystemRoot`, or repository configuration. Restart Mesh after changing the
setting or installation.

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

### PM planning and task dependencies

Use **Start planning** to ask a PM role for a structured proposal against the
current imported repository and task/policy base. Confirm the displayed Claude
subscription-capacity warning before starting. The PM receives read-only
repository access plus one scoped `submit_project_plan` control. It receives no
Claude SDK built-in filesystem tools; Mesh-owned bounded controls provide read,
glob, and text search while rejecting absolute paths, traversal, unsafe glob
grammar, and symlink or junction escapes. Mesh revalidates opened-handle and
root/parent/target identity around each access, and cancellation or session end
revokes the controls. The PM cannot write files, change canonical tasks or
dependencies, approve or reject a proposal, or launch Developer work. A
transcript or a completed PM process is not a plan outcome; only a validated
structured submission becomes reviewable.

Review the proposed tasks, prerequisite graph, assumptions, risks, exclusions,
and revision history. **Request changes** records operator feedback, captures a
fresh immutable base, and resumes the PM with newly scoped authority. **Approve
plan** rechecks that base against current canonical task and policy truth. If
anything changed during review, approval fails as stale and creates no proposal
task or dependency rows. A valid approval creates the complete proposal graph
as backlog tasks in one transaction. **Reject plan** preserves the terminal plan
history without materializing it. **Cancel planning** first revokes the PM's
submission capability, then interrupts the linked runtime, so an interrupt-time
submission cannot race cancellation.

Planning lifecycle and audit ordering are server-owned. Start, revision,
submission, approval, rejection, cancellation, resume, and retry commit their
plan state and ordered project events before publication. Bases and proposal
revisions are immutable. PM capability tokens and live handlers are in-memory
only: restart invalidates them rather than reconstructing authority. A plan in
`awaiting_review` therefore survives restart and remains reviewable without a
live PM. A formerly live `planning` or `revising` plan becomes
`attention_required`; inspect the linked session and diagnostics, then choose
the explicit **Resume planning** or **Retry planning** operation. Neither repair
manufactures a proposal or reuses stale capability authority.

Dependencies become canonical task truth only after approval. Every
prerequisite must be `done` before its dependent can move to `ready`, launch
manually, or appear in a new project-run preview. The board and task drawer show
the unmet prerequisites and keep the ready action disabled. If a prerequisite
is reopened after a dependent has already advanced, Mesh does not roll back the
dependent or interrupt active work. The reopened edge instead blocks that
dependent's next launch and excludes it from future run previews until the
prerequisite is done again.

Project-run waves remain finite across dependency changes. Satisfying a
prerequisite after a run starts does not append the newly eligible dependent to
that run's frozen membership; authorize another run after reviewing the fresh
preview. Likewise, reopening a prerequisite does not rewrite an existing run's
frozen history or interrupt its active item, but readiness is revalidated at
the next launch boundary and unsafe new work fails closed.

### Finite project runs

Use **Start run** to authorize the current ordered set of eligible ready tasks.
Inspect the preview first: authorization sends the previewed task ids and
revisions as `expectedTasks`, together with the displayed project QA policy
revision and every task's review-automation status and generation. A task edit,
reorder, policy change, or automation change makes the command stale instead of
silently changing the run. Choose bounded concurrency and confirm that the run
may consume Claude subscription capacity. Membership and order are then frozen;
tasks created or made ready later wait for a future run. Before each queued item
launches, Mesh compares that frozen authorization with current policy and
automation truth. A mismatch terminalizes only that item as attention required
without creating an attempt.

Start, resume, and each new claim preflight the shared billing environment and
resolve the project's authoritative repository identity before authorizing or
claiming work. The approved Git executable enumerates the complete registered
worktree set and resolves `HEAD` to a commit. A billing conflict, an
unsafe/mismatched or incomplete repository topology, or an unborn `HEAD`
rejects Start before the workspace root or run is created. Resume and restart
drain keep the existing run paused with `billing_conflict` or
`repository_unsafe` so the operator can repair the condition without losing the
frozen queue.

Each run item launches in a deterministic Mesh-owned Git worktree beneath the
configured base directory's `.mesh-project-runs` folder. The run and item ids
give every Developer/QA chain a distinct branch and path, so concurrent items
do not edit the imported repository or one another's files. Before Git worktree
creation, an immediate reservation transaction checks the resolved path for
live occupancy and commits a pending workspace plus idle session. Mesh then
creates the filesystem worktree. A second immediate transaction activates the
reservation and creates the attempt, execution cycle, and audit history. If Git
or the second transaction fails, Mesh preserves the reservation or worktree for
reconciliation instead of claiming atomicity across SQLite and the filesystem.

Project-run reservation fails closed on any live session already using its
planned path. In the reverse direction, manual create and resume fail closed
before placing a second live session at a path backed by a pending or active
Mesh-owned worktree, even when the selected workspace is a shared alias.
Ordinary shared-folder overlap remains warning-only. Resume performs that
occupancy check, applies the selected workspace and permission, and durably
records the legal transition to live `starting` state in one immediate
transaction. The transaction commits before Mesh calls the driver, so another
create or resume observes the reservation while driver resume is pending. A
known driver-resume rejection records ordered diagnostics and transitions the
session to `failed`; the same session can then retry through the normal resume
path. A cancelled pending resume keeps its live reservation until the driver
settles and is closed, then durably transitions through `interrupting` to
`interrupted`. The configured project-run root must be outside, and not equal
to, every worktree registered to the project's Git common directory. If
`.mesh-project-runs` would be nested inside any associated worktree, preflight
reports `repository_unsafe` before root creation, authorization, resume, or
claiming; set `MESH_WORKSPACE_ROOT` to a safe parent directory.

`launch_pending` and `active` items both occupy capacity. Completed autonomous
review releases a slot as completed. Manual review, disabled per-task
automation, a Developer blocker, the rejection ceiling, and paused review
automation release a slot as attention required, allowing later queued work to
progress. These attention states require an operator decision outside the
finite run; the run does not retry or invent a resolution.

**Pause run** durably records `operator_paused` and prevents new launches while
current launches and sessions settle. While paused, reconciliation continues to
repair and observe `launch_pending` and `active` items, but never claims queued
items. Refresh or backend restart preserves the run id, frozen queue, item
results, and pause reason. **Resume run** continues that same queue after
reviewing the reason. **Stop run** marks queued items not started, launches no
replacements, drains already occupied items, and preserves the completed
stopped run in project history. A restart ambiguity or an unexpected extra
current attempt instead pauses with an explicit reason such as
`launch_outcome_unknown`; inspect the attempts, diagnostics, and workspaces
before resuming.

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
workspace. QA receives no Claude SDK built-in tools or inherited filesystem MCP
configuration. It can read, list, and search the submitted source only through
bounded Mesh controls that reject absolute paths, traversal, and symlink or
junction escapes. Mesh revalidates the opened object, its parent, and the
workspace root before and after reads or directory enumeration so concurrent
path swaps fail closed. Search traversal has independent directory, entry,
queue, file, and match caps, streams rather than materializes large directories,
and stops and closes its directory handle with its owning QA cycle. It may
request named verification commands through Mesh's constrained runner. File
listing also streams entries, returns at most 500 plus a one-entry truncation
lookahead, and closes its handle when the owning cycle is cancelled. QA
workspace listing or search cancellation reports
`qa_workspace_operation_cancelled` and pauses review without a verdict. QA
receives no shell and cannot write source, create another worktree, commit,
merge, or create a pull request. Ambiguous
joined option values are treated as workspace paths, including missing paths
whose deepest existing ancestor is a link. Interactive, watch, server, and
authoring-style command forms are rejected. Every verification child has a
five-minute wall-clock bound and a 64,000-byte limit per output stream, and is
cancelled with the owning QA runtime. Timeout, output overflow, or cancellation
durably pauses review without recording a verdict. On Windows, vetted package
manager commands use canonical bundled JavaScript launchers through the
installed Node executable, with shell execution disabled. Git uses the single
startup approval described above; every spawn revalidates the executable's
canonical path and identity, and workspace-local copies cannot replace it. If
the approval is unavailable when manual QA first captures its baseline, the
command returns `503 qa_verification_executable_unavailable` with setup guidance
and creates no command reservation, QA session, cycle, or project event. The
same idempotency key can be retried after the operator repairs the approved Git
capability. This pre-reservation probe is bounded and read-only; Mesh still
performs the full authoritative baseline capture inside the audited launch
command. If an already-active cycle loses its approval, Mesh refuses the child
and durably pauses QA.
Before launch, Mesh proves that the canonical owned-process-tree terminator is
functional. If that capability is missing or later fails, Mesh uses only the
exact owned PID as a bounded fallback and durably pauses QA rather than assuming
termination.

Mesh captures Git-tracked source at launch, after each verification command,
and immediately before verdict persistence. A capture is accepted only when
two consecutive full observations (forward, then reverse) agree on the tracked
path set, per-file metadata, and content. Capture retries are bounded; ongoing
churn pauses review and prevents a verdict. Ordinary filesystems do not provide
a cross-file transaction here, so the accepted pair proves stability across
those observations rather than locking the workspace. A write after the
accepted observation is a new concurrent mutation; Mesh does not claim
filesystem-transaction atomicity. A tracked symbolic link contributes its own
identity and target text to the snapshot without exposing the target; regular
tracked files are streamed through an opened handle with metadata checked before
and after hashing. Mesh then revalidates the canonical workspace root, full
path, and parent identity, which exposes a parent swapped to an external link
even if the original parent is restored before path inspection. Broken link
components whose lexical targets escape the workspace are rejected even when
those targets do not exist, and every indexed link object's canonical parent
must remain inside the assigned workspace. Cancellation is rechecked after the
last canonical revalidation and immediately before an observation or stable
hash can be accepted. Its structured report covers every snapshotted acceptance
criterion and records evidence, verification performed, residual risks, and
workspace state.

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
starting or resuming PM planning, starting Developer, starting QA, and the
resume paths after rejection or unblock. Startup now requires the SDK to
positively report a first-party subscription and no API-key source. Environment
keys, API-key helpers, and keys managed by `/login` are all refused; ambiguous
account metadata also fails closed. Remove the conflicting key outside Mesh,
verify the intended Claude subscription login is active, and restart Mesh. PM
planning and manual QA consume subscription quota when a human starts them.
Enabled autonomous review may consume quota for each automatic QA start and
each Developer resume; the explicit consent, rejection ceiling, and pause
control bound that behavior.

A finite project run can start several Developer sessions up to its confirmed
concurrency and can also trigger autonomous QA or Developer rework. The start
dialog therefore requires a separate capacity confirmation. Pause and Stop
bound future launches; they do not erase subscription work already started.

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
quota. The PM acceptance path records the exact read-only role/tool
configuration and invokes the scoped proposal callback in process. It proves
start, revision, approval, stale rejection without partial rows, dependency
readiness, restart repair, and cancel-before-interrupt ordering without a Claude
executable, credentials, or subscription traffic. The finite-run acceptance
path additionally proves concurrency two,
autonomous completion, manual and blocker attention, later queue progress,
Pause/Resume, browser refresh, backend restart, Stop/drain, durable history, and
an absent API-billing environment. It uses only the fake driver, a temporary Git
repository, and a temporary SQLite database. Failure traces and screenshots are retained under
`tmp/playwright/session-platform`.

The parallel V2 M4 acceptance path has the same fake-only safety boundary. It
uses a fixture-owned repository, database, managed-worktree root, ports, and
processes to prove Developer reservation-before-Git ordering, restart recovery,
interruption and replacement, strict report settlement, canonical task
completion, retained-gap resync, and isolated blocked or invalid output. It does
not invoke the installed Claude executable, use operator worktrees or runtime
state, or exercise the M5 scheduler or M6 behavior.

Windows Chromium is the required acceptance environment. The same test suite is the portable basis for future macOS/Linux matrix entries.

The real Claude smoke is separate and opt-in:

```powershell
$env:MESH_RUN_CLAUDE_SMOKE = '1'
corepack pnpm nx external-smoke server
```

This consumes real subscription capacity and can hit subscription limits. Use
it only when an operator deliberately budgets a real-driver smoke; deterministic
fake acceptance is the normal planning and workflow proof. Never add it to
`pnpm verify`, CI defaults, or an API-key-backed fallback.
