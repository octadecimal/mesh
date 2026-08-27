# Milestone 4 QA Execution Design

**Date:** 2026-08-26
**Status:** Draft for written review

## Prerequisite

Milestone 4 builds on the approved Milestone 3 Developer execution design and
its implementation. The Milestone 4 implementation must begin from a revision
that contains Milestone 3's Developer cycles, structured completion reports,
capability binding, human review and rework commands, and durable project-event
projection. This document is committed independently from `origin/master` so
the design does not depend on an unmerged implementation branch.

## Product outcome

Milestone 4 adds policy-constrained QA execution to the existing task workflow.
A QA agent verifies a Developer submission in the Developer's exact workspace,
records a durable criterion-level verdict, and cannot modify the implementation
or task contract.

Projects choose between two review policies:

- `manual`: humans start QA and decide what follows every QA verdict.
- `autonomous_review`: Mesh starts QA when a Developer submits for review, marks
  verified work done, and resumes the same Developer session after rejection.

Autonomous review is a bounded review-and-rework policy, not a scheduler. Humans
still choose tasks and authorize their initial Developer launches.

## Goals

- Run QA against the current Developer attempt's exact workspace.
- Give QA source-reading and verification authority without source-authoring
  authority.
- Require a structured result and evidence for every snapshotted acceptance
  criterion.
- Preserve every Developer and QA cycle as immutable task-attempt history.
- Pause after QA outcomes in manual mode.
- Complete verified work and resume rejected work in autonomous-review mode.
- Stop autonomous rework after three QA rejections.
- Preserve audit ordering, subscription-only operation, workspace safety,
  idempotency, reconnect behavior, and truthful restart recovery.
- Keep commands and outcomes explicit so a later orchestrator can invoke them.

## Non-goals

- Automatic selection or initial launch of ready tasks.
- Project-wide queues, concurrent scheduling, claims, leases, priorities,
  backpressure, quota forecasting, or quota-aware scheduling.
- PM agents or a general role, workflow, prompt-profile, or orchestration
  framework.
- Task dependencies or multi-repository projects.
- QA code modification, task editing, or acceptance-criteria editing.
- Automatic fresh-attempt or alternate-workspace fallback.
- Automatic commits, worktree cleanup, merges, or pull requests.
- API-key or pay-per-token billing.

## Architecture and authority

QA execution belongs inside the existing task domain. It extends the current
task attempt with QA cycles and reports and composes the session runtime. It
does not introduce a workflow-run aggregate or background scheduler.

The task-domain QA service owns lifecycle, authorization, report validation,
atomic persistence, and project-event production. The Claude adapter exposes
only the controls allowed for an active QA capability and translates typed tool
input. The server binds every control to the calling session, task, attempt, and
QA cycle; it never trusts model-supplied ownership identifiers.

Authority is divided as follows:

| Actor or policy | Authority |
| --- | --- |
| Human | Start QA in manual mode; accept verified work; choose rework after rejection; resolve paused, failed, or interrupted automation; change future project QA instructions and review policy. |
| QA | Execute verification in the assigned workspace; submit one structured `verified` or `rejected` report for its active cycle. |
| Manual policy | Persist and display the QA verdict, then pause without advancing or resuming work. |
| Autonomous-review policy | Launch QA after Developer review submission; move verified work to `done`; resume the same Developer session after rejection; pause on the third rejection or any unsafe failure. |
| Developer | Retains Milestone 3 authority only during an active Developer cycle. Its capability is invalid while QA controls the task. |

QA receives no source-authoring tools and cannot edit task content, change rank
or priority, affect another task, clear blockers, choose a different workspace,
clean a worktree, commit, merge, or create a pull request. Verification commands
may create ordinary ignored build or test artifacts. The QA report records
workspace changes so unexpected source changes fail the verdict and pause the
loop rather than being accepted as QA output.

## Project QA configuration

Each project stores:

- QA instructions as Markdown or plain text, with revision and update metadata.
- Review policy: `manual` or `autonomous_review`.
- Policy revision and update metadata.

The built-in QA policy defines safety, authority, report requirements, and
verification behavior. Project instructions add repository-specific commands
and conventions but cannot broaden permissions, workspace ownership, billing,
or lifecycle authority.

Configuration changes affect future cycles only. Each QA cycle snapshots the
exact instruction content and revision, review policy and revision, and built-in
QA policy version that it received.

Switching to `manual` immediately prevents new automatic actions but does not
silently terminate a running session. Switching to `autonomous_review` does not
retroactively process tasks already in review. A human must explicitly enable
automation for each such task, avoiding surprise subscription usage.

## Durable model

Milestone 4 adds an ordered collection of QA cycles to the current task attempt.
It preserves the alternating Developer and QA timeline without creating a
generic workflow model. Milestone 2 attempts and Milestone 3 Developer attempts
continue to decode without QA fields.

Each QA cycle records:

- Stable ID and ordinal within the attempt.
- Authorizing human or autonomous-policy action.
- QA session ID and the current Developer workspace identity.
- Snapshotted task revision, description, and acceptance criteria.
- The Developer completion report being verified.
- Built-in QA policy version and snapshotted project QA instructions.
- Snapshotted review policy and policy revision.
- Autonomous rejection ordinal and automation generation.
- Start and terminal timestamps.
- Terminal disposition: `verified`, `rejected`, or absent while active or
  interrupted without a trustworthy verdict.
- References to its durable report, control command, task transition, and
  project events.

Only one role cycle may control a task at a time. Only the active QA cycle of the
current task attempt may use QA controls.

### QA report

A QA report is append-only and contains:

- One result for every snapshotted acceptance criterion, with `passed` or
  `failed` status and supporting evidence.
- Verification commands and their observed outcomes.
- Overall `verified` or `rejected` disposition.
- Skipped checks, limitations, and residual risks.
- Workspace state before and after verification.

`verified` requires every criterion result to be `passed`. A report with one or
more failed criteria must be `rejected`. Skipped checks must be explicit and
cannot support verification. Mesh validates the structured report; it never
infers QA success from prose, transcript text, tool output, or session exit.

## Execution flow

### Starting QA

1. A Developer submits a valid Milestone 3 completion report and the task enters
   `review`.
2. Manual mode exposes a human `Start QA` action. Autonomous-review mode creates
   the equivalent durable policy action after the Developer transaction commits.
3. Mesh validates that the attempt is current, the task is unblocked and in
   review, the workspace is the Developer attempt's exact safe workspace, and
   no role cycle controls the task.
4. Mesh persists the QA cycle and session before starting the driver.
5. QA runs in the Developer workspace with source-reading tools and permission
   to execute verification commands, but without source-authoring tools. It
   receives no isolated worktree because a new worktree would not contain the
   Developer's changes.

### Verified outcome

Mesh validates the capability and complete report, then stores the report,
closes the QA cycle, and appends ordered project events in one transaction.

- In manual mode the task remains in `review` with a `QA verified` projection.
  A human may accept it as `done` using the existing audited acceptance command.
- In autonomous-review mode the same transaction appends the authorized
  `review -> done` transition.

The terminal QA capability is invalidated only after durable commit.

### Rejected outcome

Mesh stores the rejection report, closes the QA cycle, and appends ordered
project events atomically.

- In manual mode the task remains in `review`. A human reads the report and
  chooses a Milestone 3 rework path.
- In autonomous-review mode, for the first and second autonomous rejection,
  Mesh appends QA feedback and prepares a new immutable Developer cycle for the
  same session. The task transitions to `in_progress` only after runtime startup
  succeeds, matching Milestone 3's truthful launch behavior.
- On the third autonomous rejection, Mesh records `automation_paused`, preserves
  the task in review with all evidence, and requires a human decision. It does
  not start another Developer cycle.

If same-session resume is unavailable, stale, ambiguous, or unsafe, automation
pauses. Mesh never silently creates a fresh attempt or switches workspaces.

The rejection ceiling counts autonomous QA rejections since the most recent
human-authorized initial Developer launch or human rework decision. A new human
rework decision resets the budget.

## Automation trigger and idempotency

Automatic review actions react to committed task-domain outcomes through a
narrow policy component. The component does not scan for arbitrary ready work or
own a project queue. It handles only the current task's post-Developer and
post-QA follow-up.

Each automatic action uses a durable idempotency key derived from the task,
attempt, source cycle, action kind, and automation generation. Before acting,
the task service re-reads current durable state and confirms that the triggering
cycle remains current. Duplicate delivery, reconnect, replay, or restart returns
the original result without creating another QA or Developer cycle.

This explicit boundary is suitable for a later orchestration service. A future
scheduler can invoke the same launch and resume commands under a broader audited
policy; Milestone 4 does not implement its leases, concurrency, queue, or quota
semantics.

## Failure and recovery

- QA startup failure retains the session, QA cycle, and diagnostics, leaves the
  prior task truth intact, and pauses automation.
- Developer resume failure retains the QA rejection, feedback, and failed cycle
  diagnostics, leaves the task in `review`, and pauses automation.
- An interrupted or outcome-unknown QA cycle becomes an explicit repair
  condition. Restart never guesses a verdict or automatically repeats work.
- Duplicate and stale controls fail closed or return their original idempotent
  result as appropriate.
- Audit persistence failure prevents publication and stops the affected runtime
  from continuing unsafely.
- Missing, dirty-but-unexpected, ambiguous, unowned, or mismatched workspaces
  pause the loop and preserve all work.
- API-billing environment conflicts block QA or Developer driver creation.
- A human can pause future automation immediately. Interrupting an already
  running session remains a separate visible action with its existing audit
  behavior.

Repair commands are narrow and state-specific. They do not delete history,
rewrite reports, infer success, or bypass workspace ownership checks.

## Realtime and web projection

QA configuration, cycles, reports, verdicts, automatic actions, rejection
budget, and pause conditions are durable project state. They flow through the
existing project snapshot and ordered project-event stream. A reconnect replays
from the project cursor; a gap refreshes only that project's snapshot.

The task drawer adds a QA panel showing:

- Current role and active cycle.
- Review policy and remaining autonomous rejection budget.
- QA eligibility and the next automatic action.
- Chronological Developer and QA cycles.
- Developer evidence beside QA verdict and evidence for each criterion.
- Startup, interruption, resume, workspace, and automation-pause conditions.
- Safe actions appropriate to the current mode and state.

Project settings add revisioned QA instructions and the review-policy selector.
Enabling autonomous review requires explicit confirmation that it may consume
Claude subscription quota. Autonomous mode retains an immediate `Pause
automation` control and never hides the sessions, commands, reports, or
transitions it produced.

Manual mode exposes `Start QA`, human acceptance after verification, human
rework choice after rejection, and state-specific repair actions. Autonomous
mode shows pending and active automatic actions without requiring clicks during
a healthy bounded review loop.

## Persistence and compatibility

The schema migration is additive. Existing projects default to empty QA
instructions and `manual` review policy. Existing attempts contain no QA cycles
and preserve their prior decoding and behavior.

Repositories own QA configuration, cycles, reports, automatic-action records,
and repair state. Task services own policy and lifecycle decisions. The realtime
and HTTP layers transport validated commands and durable outcomes but do not
infer task or QA state.

All report, cycle, transition, automatic-action, and project-event writes that
represent one outcome commit in a single SQLite transaction before publication.

## Verification strategy

Contract tests cover:

- Backward-compatible project and attempt decoding.
- QA configuration revisions and review-policy values.
- QA cycles, reports, criterion coverage, and disposition consistency.
- Human, QA, and autonomous-policy command authority.
- Project snapshot and event variants.

Focused backend tests prove:

- QA controls exactly one active cycle for one current task attempt.
- QA receives no source-authoring tools or unrelated-task capability; ordinary
  verification artifacts are reported and unexpected source changes pause the
  loop.
- QA runs only in the Developer attempt's verified workspace.
- Manual verification and rejection pause without unauthorized transitions.
- Autonomous verification transitions to done.
- First and second autonomous rejection resume the same Developer session.
- Third rejection pauses without starting another cycle.
- A human rework decision resets the autonomous rejection budget.
- Mode changes affect future actions without rewriting cycle snapshots.
- Duplicate events and restart replay do not duplicate work.
- Startup, resume, audit, workspace, and outcome-unknown failures pause safely.
- Audit writes precede realtime publication.

Web tests cover QA settings, revision conflicts, explicit automation consent,
eligibility, active roles, criterion comparison, remaining rejection budget,
manual actions, autonomous progress, pause controls, reconnect, and repair
states.

A deterministic fake-driver acceptance path imports a temporary repository,
launches a Developer, receives a completion report, automatically launches QA,
records rejection, resumes the same Developer session, receives a new report,
automatically launches QA again, verifies the work, reaches `done`, and refreshes
the browser to prove the complete audit trail survives. Focused paths cover
manual mode and the three-rejection pause.

Normal verification uses temporary repositories, a temporary database, and the
fake driver. It never contacts Claude or consumes subscription quota. The real
Claude smoke remains separate and opt-in.

## Affected surfaces

- **Contracts:** QA configuration, cycles, reports, commands, project events,
  snapshots, errors, and backward-compatible defaults.
- **Commands:** human QA launch, QA verdicts, review-policy updates, automation
  pause/enable, and state-specific repair with explicit actor policy.
- **Runtime:** QA session composition, capability binding, Developer parking and
  resume, interruption, and startup failure.
- **Persistence:** additive migration, atomic outcome writes, idempotent automatic
  actions, ordering, and restart repair state.
- **Realtime:** durable QA projection, replay, reconnect, and project-local
  resynchronization.
- **Web:** settings, consent, QA history, evidence comparison, automation status,
  pause controls, and failure feedback.
- **Workspace safety:** exact Developer-workspace reuse, read-only QA, ownership
  validation, and preservation on ambiguity.
- **Operating modes:** manual and autonomous review, fake and real drivers,
  shared and isolated Developer workspaces, fresh and existing databases, and
  Windows paths.
- **Reverse states:** enable/disable automation, verify/reject, pause/recover,
  connect/disconnect, and failure/restart.
- **Documentation:** architecture and operating guidance for QA authority,
  automation, recovery, and subscription usage.

## Deferred roadmap

A later orchestration milestone may add automatic ready-task selection,
concurrency, claims or leases, project queues, pause and stop semantics, retry
policy across tasks, and quota-aware backoff. It should invoke the explicit
Developer and QA command boundaries established by Milestones 3 and 4.

A general workflow or role framework should be extracted only after Developer,
QA, PM, and orchestration implementations demonstrate repeated mechanics that
cannot remain clear as concrete task-domain policies. It is not an assumed
destination.

PM authority, task dependencies, generalized model profiles, multi-repository
projects, and workflow customization remain separate roadmap decisions.

## Milestone stop condition

Milestone 4 is complete when a human can run a trustworthy Developer-to-QA
workflow in manual mode, or explicitly opt a task into a bounded autonomous
review-and-rework loop that can safely reach `done` without human clicks. Every
decision must remain durable, inspectable, idempotent, restart-safe,
subscription-backed, and constrained to the task's verified workspace. The loop
must pause after three QA rejections or any condition whose safe outcome cannot
be proven.
