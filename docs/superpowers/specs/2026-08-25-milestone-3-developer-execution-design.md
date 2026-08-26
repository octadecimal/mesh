# Milestone 3 Developer Execution Design

**Date:** 2026-08-25
**Status:** Draft for written review

## Product outcome

Milestone 3 lets a human delegate one ready task to a policy-constrained
Developer, then receive a durable review submission or blocker report. The
human retains planning, acceptance, unblocking, and rework authority.

This milestone adds the first role-specific execution policy without adding an
autonomous scheduler or a general role framework. Manual launch is the first
trigger policy. A later autonomous loop may select work and invoke the same
audited launch and resume commands without changing Developer execution
semantics.

## Goals

- Let a human explicitly start a Developer on a selected ready task.
- Give the Developer authority only over its assigned task and active execution
  cycle.
- Let the Developer submit structured completion evidence for human review.
- Let the Developer truthfully block its task with evidence and a suggested
  human action.
- Keep final acceptance, review rejection, unblocking, and rework strategy
  human-controlled.
- Support a built-in Developer policy plus project-specific instructions.
- Snapshot the task contract, policy version, and project instructions for each
  execution so historical behavior remains reproducible.
- Support both same-session resume and fresh-attempt rework while preserving
  prior reports and feedback.
- Preserve audit-before-publication, subscription-only operation, repository
  safety, and restart recovery.
- Establish stable boundaries that a later scheduler can invoke without
  introducing scheduling behavior now.

## Non-goals

- Automatic task claiming, polling, queues, or autonomous execution loops.
- PM or QA agents.
- Agent authority to accept work, mark a task done, unblock work, or modify an
  unrelated task.
- Task dependencies, dependency-aware ordering, or scheduling.
- A general role, prompt-profile, model-profile, or workflow framework.
- Configurable Developer models or permission policies at the project level.
- Inferring task outcomes from transcript text or session termination.
- Enabling API-key or pay-per-token billing.

## Architecture and authority

Developer execution belongs inside the existing task domain. It extends the
current task-attempt model and composes the existing session runtime; it does
not create a parallel orchestration service or agent-run aggregate.

A human launches a ready task through the existing audited attempt flow. Mesh
assigns the attempt a durable `developer` role and records which human
authorized it. The attempt receives a snapshot of the task execution contract,
the built-in Developer policy version, the current project Developer
instructions, and the selected runtime and workspace configuration.

The active Developer session receives two Mesh-owned controls:

- `submit_for_review(completionReport)`
- `mark_blocked(blockerReport)`

The controls translate into typed internal commands. The task service owns
authorization and lifecycle decisions; the Claude adapter only exposes the
tools and translates valid tool input. The server binds each command to the
calling session, attempt, task, and execution cycle instead of trusting IDs
supplied by the model.

Authority is divided as follows:

- A human selects and launches work, edits project instructions, unblocks a
  task, accepts work as done, rejects work, and chooses how rework proceeds.
- A Developer executes only its assigned task and may submit that task for
  review or mark it blocked.
- A future scheduler may receive separate authority to select and invoke the
  same launch or resume boundary. That policy is outside Milestone 3.

Launching a Developer does not grant general task-transition authority. A
Developer cannot mutate task content, change manual rank or priority, affect
another task, clear a blocker, accept its own work, or issue arbitrary lifecycle
transitions.

## Project Developer instructions

Each project stores optional Developer instructions as Markdown or plain text,
with a revision and update metadata. The built-in Developer policy defines
safety, role authority, control usage, and the expected execution/reporting
behavior. Project instructions add repository-specific conventions such as
test commands or contribution practices.

Project instructions are subordinate to Mesh's built-in safety policy, task
scope, workspace boundary, and permission mode. They cannot enable API billing,
broaden filesystem ownership, grant additional task authority, or weaken audit
persistence.

Updating project instructions affects future execution cycles only. Each cycle
stores the exact instructions and revision it received. An explicit resume uses
the current task contract and project instructions and records a new snapshot;
prior snapshots remain immutable.

## Durable model

Milestone 3 extends `TaskAttempt` with role-specific execution history rather
than creating a separate agent-run model. Existing Milestone 2 attempts remain
valid and decode without Developer fields.

A Developer attempt records:

- Role: `developer`.
- The human actor that authorized its initial launch.
- Runtime session and workspace references already owned by the attempt flow.
- An ordered collection of immutable execution cycles.

Each execution cycle records:

- Stable ID and ordinal within the attempt.
- Mode: `new` or `resume`.
- Authorizing human actor and command ID.
- Built-in Developer policy version.
- Snapshotted project-instruction content and revision.
- Snapshotted task revision, description, and acceptance criteria.
- Runtime configuration relevant to reproducibility, including workspace and
  permission mode.
- Start and terminal timestamps.
- Terminal disposition: `submitted_for_review`, `blocked`, or absent while the
  cycle is active or interrupted without a Developer disposition.
- References to its report, durable control command, and resulting project
  event.

Only one execution cycle for an attempt may be active. Only the active cycle of
the task's current attempt may use Developer controls.

### Completion report

A completion report is append-only and contains:

- Summary of changes.
- One result for each snapshotted acceptance criterion, including status and
  evidence.
- Verification commands and their outcomes.
- Known limitations or residual risks.
- Workspace state summary, including uncommitted changes and whether commits
  were created.
- Optional reviewer notes.

Submission requires a result for every criterion. A criterion result may report
that the criterion was not met, but the report must say so explicitly; Mesh
does not infer success from prose or process exit.

### Blocker report

A blocker report is append-only and contains:

- Concise reason.
- Supporting evidence.
- Work already attempted.
- Suggested human action.
- Whether workspace changes must be preserved.

The task's ordinary blocked condition remains the current board projection.
The report provides immutable attempt-specific evidence behind that condition.

Reports are never edited in place. Rework creates another execution cycle and
another report. Corrections are new audited records rather than replacements.

## Attempt-scoped control capability

Mesh exposes the two Developer tools through the existing Claude session
integration. At execution-cycle start, the server creates an opaque,
attempt-scoped capability and installs it into the runtime integration without
including it in prompts, transcripts, browser payloads, diagnostics, or durable
events.

The capability resolves server-side to one session, attempt, task, and active
execution cycle. It is invalidated when the cycle reaches a terminal
disposition, the session stops, the attempt is superseded, or the backend
restarts. A restart never reconstructs a live capability from durable data. A
human must explicitly resume work to create a new cycle and capability.

The capability is runtime authorization, not durable identity. Durable actor,
command, report, transition, and event records remain the audit truth. Tool
input carries the report and an idempotency ID, but does not choose the target
task or actor.

## Launch flow

Starting a Developer is a human command:

1. Confirm the project is active and the selected task is `ready`, unblocked,
   current at the expected revision, and authorized for the human actor.
2. Validate repository identity, selected shared or isolated workspace, and
   permission mode through the existing safety boundaries.
3. Resolve the current built-in policy and project-instruction revision.
4. Snapshot the task execution contract, policy version, project instructions,
   and runtime configuration onto a new Developer attempt and execution cycle.
5. Create the session and durable attempt association.
6. Start the runtime with the task contract, Developer policy, project
   instructions, and scoped controls.
7. After startup succeeds, persist the task transition from `ready` to
   `in_progress`.
8. Publish session and project events only after their required audit writes
   succeed.

This preserves Milestone 2 launch ordering. Startup failure retains the failed
session and attempt, leaves the task ready, and records diagnostics. If the
runtime starts but the required task transition cannot persist, Mesh interrupts
the runtime and records an explicit repair condition for any ambiguous outcome.

## Review submission flow

`submit_for_review` succeeds only when:

- The capability resolves to the calling active session and cycle.
- The attempt is the current attempt for its task.
- The task is `in_progress`, unblocked, and at the expected revision.
- The cycle has no terminal disposition.
- The completion report is valid and covers every snapshotted criterion.

Mesh stores the report, closes the execution cycle as
`submitted_for_review`, appends the `in_progress -> review` task transition,
and appends the ordered project events in one SQLite transaction. Publication
occurs only after the transaction commits. A duplicate idempotency ID returns
the original result without adding another report or transition.

The linked session may remain readable and available for human questions, but
its terminal execution-cycle capability cannot submit or block again. Further
Developer work requires an explicit human-authorized resume or new attempt.

## Blocking flow

`mark_blocked` uses the same ownership, current-attempt, revision, and
single-terminal-disposition checks. Mesh stores the blocker report, closes the
cycle as `blocked`, applies the task's orthogonal blocked condition, and appends
the project events in one transaction.

After persistence, Mesh cleanly stops or interrupts the active runtime while
preserving its session, workspace, and attempt history. If runtime cleanup is
ambiguous, the task remains truthfully blocked and Mesh records a repair
condition rather than claiming the process stopped. The Developer cannot
unblock the task or reuse the closed capability.

When the blocker is resolved, a human supplies an unblock reason and chooses
whether to resume the same attempt or start a fresh one. Unblocking and starting
the selected execution path are one product command: the task must not be left
unblocked and `in_progress` without either a live cycle or an explicit startup
failure. Resume creates a new cycle and capability on the existing session;
fresh execution preserves the blocked attempt and uses the safe new-attempt
launch flow.

## Human review and rework

Only a human may accept a task in review as `done`. A human may instead reject
the submission with non-empty feedback and choose one of two rework paths.

### Resume the same attempt

Mesh appends the review feedback, transitions the task to `in_progress`, and
creates a new immutable execution cycle on the same attempt and session. The
cycle snapshots the current task contract and project instructions and receives
a new capability. Mesh delivers the rejection feedback with that execution
contract to the resumed session.

If the prior session cannot safely resume, the command fails with an actionable
error and leaves the task in review. Mesh does not silently convert the request
to a new attempt.

### Start a new attempt

Mesh appends the review feedback and starts a fresh Developer attempt through
the normal safe launch composition. The previous attempt, its cycles, reports,
and feedback remain immutable history. The task moves from review into the new
attempt's `in_progress` state only after startup succeeds. A failed fresh launch
does not discard the review state or previous evidence.

The UI makes the two choices explicit. This human choice can later become an
input to a separately authorized scheduler without changing either execution
path.

## Failure handling and recovery

- Invalid, expired, replayed, cross-session, or superseded capabilities fail
  closed and do not reveal whether another target exists.
- Stale revisions reject the command and return authoritative task state for
  resynchronization.
- Malformed or incomplete reports create no durable disposition or transition.
- Report, transition, and project-event writes are atomic. Persistence failure
  prevents publication and stops unsafe runtime continuation.
- Duplicate control commands return the recorded response.
- Session completion without a Developer control command does not advance or
  block the task. It produces an operator-visible repair condition when the
  task remains in progress without a live cycle.
- Backend restart invalidates all capabilities and reconciles active Developer
  cycles against canonical session state. It never infers completion from a
  transcript or terminal process state.
- Project-instruction revision conflicts reject human edits or launches rather
  than silently overwriting another change.
- Workspaces with changes are preserved on failed launch, blocking, rework,
  interruption, and ambiguous cleanup according to existing ownership rules.

## Realtime and browser projection

Developer attempts, cycles, reports, feedback, instruction revisions, and
repair conditions join the existing project snapshot and ordered project-event
stream. The session stream remains authoritative for runtime lifecycle,
messages, tool activity, and diagnostics. The browser joins the projections by
stable IDs and never treats transient tool progress or transcript text as task
truth.

A sequence gap refreshes the affected project snapshot. Reconnect restores
project and session projections independently before resolving their links.
Capabilities never appear in either projection.

The task drawer adds:

- A `Start Developer` action for an eligible ready task.
- Project Developer-instruction editing with revision-conflict feedback.
- Active Developer cycle, session state, and workspace navigation.
- Structured completion and blocker reports.
- Human actions to accept, reject and resume, or reject and start fresh.
- Visible pending, stale, disconnected, failed, and repair states.

The board continues to change only after durable project events. Optimistic UI
may show a command as pending but must not present an unpersisted transition as
canonical.

## Verification strategy

Contract tests cover:

- Project Developer configuration and revisions.
- Developer attempt and execution-cycle snapshots.
- Completion and blocker reports.
- Developer control commands and actor metadata.
- New project-event and snapshot variants.
- Backward-compatible decoding of Milestone 2 projects and attempts.

Focused backend tests prove:

- Only a human can launch or resume a Developer in this milestone.
- A capability controls exactly one active execution cycle.
- A Developer can affect only its assigned task.
- Completion requires one explicit result per snapshotted criterion.
- Review submission and blocking persist atomically with project events.
- Duplicate commands are idempotent.
- Expired, replayed, cross-session, stale-revision, and post-restart controls
  fail closed.
- Audit-write failure prevents publication and stops unsafe continuation.
- Resume preserves prior reports and feedback within the same attempt.
- Fresh rework preserves the entire prior attempt.
- Project-instruction changes affect future cycle snapshots only.
- Restart reconciliation reports unresolved cycles without guessing outcomes.

Web tests cover launch eligibility, instruction editing and revision conflicts,
active-cycle state, structured reports, acceptance, both rejection paths,
blocking, pending and failure feedback, reconnect, and repair states.

An integrated fake-driver path imports a temporary repository, configures
Developer instructions, creates and readies a task, launches a Developer,
submits a completion report, rejects and resumes with feedback, submits again,
accepts the task, and refreshes the browser to prove the complete audit trail
survives. A second focused path proves Developer blocking and human recovery.

Tests use temporary repositories and databases and never use the operator's
runtime database, credentials, worktree, or Claude subscription. The normal
gate remains `corepack pnpm verify`. The real Claude smoke remains opt-in and
outside default verification.

## Affected surfaces

- **Contracts:** project Developer configuration, attempt cycles, reports,
  commands, events, snapshots, and typed errors.
- **Commands:** human launch/resume/rework authorization and scoped Developer
  report commands.
- **Runtime:** role policy injection, control exposure, interruption, resume,
  capability invalidation, and restart reconciliation.
- **Claude boundary:** typed translation between Mesh-owned tools and internal
  commands; no task policy decisions.
- **Persistence:** additive migrations, immutable cycles and reports, revision
  checks, idempotency, atomic transitions, and ordered project events.
- **Realtime:** durable Developer projections alongside independent session
  lifecycle and transient tool activity.
- **Web:** project instructions, launch action, report display, review/rework
  choices, blocking, and repair feedback.
- **Workspace safety:** existing identity, ownership, isolation, preservation,
  and cleanup rules remain authoritative.
- **Operating modes:** Windows paths, fake and real drivers, fresh and upgraded
  databases, restart, disconnect, and failed startup.
- **Reverse states:** submit/reject/resume, submit/reject/new attempt,
  block/unblock, startup failure/retry, and interruption/recovery.
- **Documentation:** architecture and operating guidance must describe
  Developer authority and retain the human-only acceptance boundary.

## Deferred roadmap

A later autonomous milestone may add a scheduler that selects eligible work and
invokes the same launch and resume commands under an explicit, audited policy.
It must define contention, leases or claims, concurrency, retry limits, pause
and stop behavior, and quota-aware backoff. None of those concerns enter the
Developer execution policy in Milestone 3.

PM and QA roles require separate authority designs. Task dependencies,
generalized agent profiles, configurable models, multi-repository projects, and
workflow customization remain independent roadmap items.

## Milestone stop condition

Milestone 3 is complete when a human can delegate one ready task to a
policy-constrained Developer, receive a durable structured review submission or
blocker, and control acceptance or either rework path, while Mesh preserves
authority, audit ordering, workspace safety, restart truth, and a stable launch
boundary for future autonomous loops.
