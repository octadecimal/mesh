# Milestone 6 PM Planning and Task Dependencies Design

**Date:** 2026-08-27
**Status:** Draft for written review

## Summary

Milestone 6 adds a proposal-only Project Manager planning loop. An operator
gives Mesh a project goal and optional constraints, a read-only PM session
examines the repository and current task board, and the PM submits a structured,
versioned plan. The operator may request revisions, reject the plan, or approve
it. Approval creates new backlog tasks and their dependency edges atomically.

Unapproved agent output never becomes canonical task state. The PM cannot edit
files, change existing tasks, approve its own proposal, or launch work. Existing
task, Developer, QA, project-run, session, persistence, and realtime authorities
remain in place.

Task dependencies are concrete task-domain policy rather than a generalized
workflow graph. Dependencies gate readiness and future launch eligibility, but
they do not silently move tasks, interrupt active attempts, admit tasks into an
already-authorized finite run, or create continuous scheduling behavior.

## Context

Mesh now supports durable sessions, repository-backed task boards, constrained
Developer execution, QA and bounded rework, and finite project runs. The major
missing role in the original product vision is project planning: operators must
still translate a goal into executable task contracts and order those contracts
manually.

Planning is a distinct authority boundary. A PM needs broad read access to the
repository and current board, but its output is uncertain until a human reviews
it. Writing draft agent output directly into the board would mix proposals with
canonical work, make rejection ambiguous, and complicate audit history.

The existing task lifecycle also has no first-class way to express that one
task must finish before another can begin. Manual rank is useful presentation
order, but it is not an execution dependency and must remain independent from
one.

## Goals

- Let an operator start a PM planning cycle from a project goal and optional
  constraints and non-goals.
- Give the PM read-only access to the project repository and a durable snapshot
  of the current task board.
- Require the PM to submit a structured plan through an explicit capability
  rather than infer a plan from transcript text.
- Preserve every proposal revision, operator feedback item, approval decision,
  rejection, cancellation, and repair condition as durable project history.
- Let an operator request revisions from the same PM session when resumable.
- Apply an approved plan as new backlog tasks and same-project dependency edges
  in one transaction.
- Reject approval when the board context used for planning is stale.
- Prevent dependency cycles, cross-project edges, self-dependencies, and
  retroactive dependency changes to active work.
- Extend readiness and launch checks with incomplete-prerequisite evidence.
- Preserve subscription-only operation, audit-before-publication ordering,
  workspace safety, idempotency, reconnect convergence, and truthful restart
  recovery.

## Non-goals

- PM edits, cancellation, reprioritization, or reordering of existing tasks.
- PM approval of its own proposal or autonomous plan application.
- Automatic transitions from `backlog` to `ready` when dependencies complete.
- Automatic demotion or interruption when a completed prerequisite is reopened.
- Admission of newly actionable tasks into an existing finite project run.
- Continuous, cross-project, quota-aware, or forecast-based scheduling.
- Commit creation, pull-request preparation, merge, or worktree cleanup.
- Multi-repository projects or cross-project dependencies.
- General role, workflow, prompt-profile, model-profile, or graph frameworks.
- API-key or pay-per-token billing.

## Product decisions

### Proposal-first planning

PM output lives in a durable planning aggregate until an operator approves it.
The task board contains only canonical tasks. Proposal revisions are immutable;
feedback produces a later revision rather than rewriting history.

### Additive first milestone

An approved proposal may create tasks. It may make a new task depend on another
new task or an existing same-project task. It cannot modify an existing task or
make an existing task depend on newly proposed work. This keeps application
additive and avoids granting planning authority over work already in progress.

### Explicit lifecycle remains authoritative

Approved tasks begin in `backlog`. Dependencies add readiness problems and
launch constraints, but never move a task automatically. Operators continue to
use the existing lifecycle commands to mark complete task contracts `ready`.

### Concrete policy before abstraction

The PM service, proposal schema, and dependency rules remain explicit parts of
the project task domain. Mesh does not extract a general agent-role or workflow
framework in this milestone. Shared low-level path, audit, session, and
capability mechanics may be reused without generalizing product policy.

## Domain model

### Planning cycle

A planning cycle contains:

- Stable ID and owning project ID.
- Operator-authored goal, constraints, and non-goals.
- A versioned PM policy identifier.
- Ordered immutable board-base revisions and the current base identity.
- Ordered planning-session associations, including the current session.
- Lifecycle status and revision.
- Latest proposal ordinal.
- Operator feedback history.
- Optional attention or repair evidence.
- Actor and timestamps for every control decision.

Only one nonterminal planning cycle may exist for a project. Planning may begin
while other project work continues because it is read-only. The UI must warn
that subsequent board changes can make approval stale.

The planning lifecycle is:

```text
planning -> awaiting_review -> revising -> awaiting_review
    |              |              |
    +--------------+--------------+-> attention_required
    |              |              |
    +--------------+--------------+-> cancelled
                   +-----------------> approved
                   +-----------------> rejected
```

`approved`, `rejected`, and `cancelled` are terminal. `attention_required` is
recoverable only through an explicit operator retry, resume, rejection, or
cancellation command. Recovery never guesses a proposal or approval outcome.

### Planning base revision

Each planning base revision stores the repository identity and a normalized
task-board snapshot containing:

- Every current task ID and revision in board order.
- Each task's lifecycle and blocked condition.
- Existing dependency edges.
- The project archive state and planning-relevant policy revisions.

Planning start captures base revision one. Every operator revision request
captures a new immutable base revision, even when the normalized board is
unchanged, and supplies it to the PM with the feedback and prior proposal. A
proposal records the exact base identity used to produce it.

Approval compares the current normalized board with the approved proposal's
stored base. Planning events themselves do not make the base stale. Any task creation, edit,
transition, block change, reordering, dependency change, or relevant project
policy change does. The stale result identifies the added, removed, and changed
task IDs and whether dependency or policy state changed.

This intentionally conservative rule prevents application of a plan whose PM
reasoned over different canonical work. The operator requests a refreshed
revision instead of overriding the mismatch.

### Proposal revision

A proposal revision contains:

- Stable ID, planning-cycle ID, and monotonically increasing ordinal.
- The planning-cycle revision, planning-base identity, and capability generation
  that authorized it.
- Ordered proposed tasks.
- Dependency edges expressed with proposal-local task keys or existing task
  IDs.
- Plan-level assumptions, risks, and intentionally excluded work.
- Submission timestamp and the PM session that submitted it.

Each proposed task contains a unique local key, title, Markdown description,
ordered acceptance criteria, priority, labels, rationale, and explicit mapping
back to the project goal. Its task contract must satisfy the same title,
description, acceptance-criteria, and priority requirements required to enter
`ready`, even though approved tasks initially enter `backlog`.

A proposal is limited to 50 tasks and 200 dependency edges. Oversized or
invalid submissions are rejected through the PM tool without creating a
proposal revision. The limits bound human review, payload size, graph
validation, and approval transactions.

### Task dependency

A task dependency records a dependent task and one prerequisite task. The pair
is unique. Both tasks must belong to the same project, and the resulting graph
must remain acyclic.

Proposal application may create an edge only when the dependent is a task from
that proposal. The prerequisite may be another proposed task or a current,
non-cancelled existing task.

After approval, an operator may add or remove dependency edges only while the
dependent task is in `backlog` or `ready` and has no active attempt. Removing an
edge changes current dependency truth but does not remove its durable project
event history.

## Authority and ownership

| Owner | Authority |
| --- | --- |
| Operator | Start planning; provide goals and constraints; request revisions; approve, reject, cancel, retry, or resume; edit dependencies within policy. |
| PM session | Read repository and board context; submit a structured proposal for its exact planning cycle and capability generation. |
| `PlanningExecutionService` | Authorize and compose PM session start/resume, snapshot planning context, issue and revoke proposal capabilities, and reconcile session outcomes. |
| `PlanApprovalService` | Validate operator authority, proposal and board freshness, task contracts, and dependency graph; atomically apply an approved proposal. |
| Task lifecycle policy | Own content readiness and incomplete-prerequisite problems used by transitions and launch checks. |
| Existing task and attempt services | Remain authoritative for canonical tasks, legal lifecycle transitions, attempts, and session composition. |
| Existing project-run service | Remains authoritative for finite run membership, capacity, and launch scheduling. |

The PM cannot write repository files, create or edit canonical tasks, edit
dependencies, change project settings, start attempts or runs, approve its own
proposal, interrupt unrelated sessions, or invoke Developer or QA outcome
tools.

## PM session and capability boundary

Planning uses a dedicated shared-folder session rooted at the project's
canonical repository. It does not create a worktree because it has no source
write authority.

The PM policy permits repository inspection through the existing constrained
read surfaces and explicitly denies source-authoring tools, mutating shell
operations, network expansion, and Mesh lifecycle commands. Low-level path
containment and command classification may reuse existing read-only QA safety
mechanics, but PM authority remains a separate policy.

Before starting or resuming Claude, `PlanningExecutionService` persists the
planning state, session association, policy version, base snapshot, and an audit
event. Only after commit may it start or resume the subscription-backed session.
Startup failure preserves the failed session and diagnostics and moves the plan
to `attention_required`.

The PM receives one local structured tool, conceptually
`submit_project_plan`. Its ephemeral capability binds:

- Planning-cycle ID and revision.
- PM session ID.
- Planning-base identity.
- Policy version and capability generation.
- Expiration and one-accepted-submission semantics.

The capability is never persisted as a reusable credential. Restart, revision
request, cancellation, proposal acceptance, or session replacement invalidates
it. A resumed or replacement session receives a freshly authorized generation.

Transcript text, process exit, or session completion never creates a proposal.
Only a valid structured tool call may do so.

## Workflows

### Start planning

1. The operator supplies a goal and optional constraints and non-goals, then
   confirms that planning consumes Claude subscription capacity.
2. The server validates human authority, active-project state, one-active-plan
   policy, repository identity, billing safety, and read-only session policy.
3. In one transaction, it creates the planning cycle, stores the normalized
   board base, creates or associates the session record, appends the project
   event, and reserves the idempotent command result.
4. After commit and publication, it starts the PM session with the goal, policy,
   board snapshot, repository path, and proposal capability.
5. Startup failure records durable diagnostics and attention evidence. It never
   manufactures a proposal or changes the board.

### Submit a proposal

1. The PM calls the structured proposal tool.
2. The service re-reads the planning cycle and verifies the capability, session,
   lifecycle state, revision, generation, and payload limits.
3. It validates complete task contracts, proposal-local references,
   same-project existing references, uniqueness, and acyclicity.
4. In one transaction, it appends the immutable proposal, changes the planning
   cycle to `awaiting_review`, revokes the generation, and appends a
   `project.plan_changed` event.
5. It publishes only after commit. Invalid payloads return structured problems
   and leave the current generation usable so the PM can correct its call.

### Request a revision

1. The operator submits non-empty feedback against the current planning and
   proposal revisions.
2. The server captures a new immutable board-base revision and, in the same
   transaction, persists the feedback, moves the plan to `revising`, revokes
   any older capability, and appends the project event before runtime action.
3. It resumes the same PM session with the feedback, prior proposal context,
   and refreshed board base when the session is resumable.
4. If same-session resume is unavailable, the plan enters
   `attention_required`. The operator may authorize a fresh replacement session
   that receives the base snapshot, proposal history, and feedback without
   changing the planning-cycle identity.
5. The next valid submission becomes a new immutable proposal ordinal.

### Approve a proposal

Approval requires the latest proposal ordinal and expected planning revision.
`PlanApprovalService` revalidates:

- Human actor authority and active project state.
- `awaiting_review` lifecycle and latest proposal identity.
- Exact board-base freshness.
- Task-contract completeness and configured proposal limits.
- Existing prerequisite existence, project ownership, and non-cancelled state.
- The combined current and proposed dependency graph remains acyclic.
- No colliding idempotency key or already-applied proposal exists.

One SQLite transaction then:

1. Reserves the approval command.
2. Allocates stable task IDs in proposal order.
3. Creates every task in `backlog` with operator approval as its creation actor
   and the planning cycle as provenance.
4. Maps proposal-local keys and creates dependency edges.
5. Marks the planning cycle `approved` and records the created-ID mapping.
6. Appends the plan approval event, one existing-style task creation event per
   task, and dependency-change events containing each new task's complete
   prerequisite set.
7. Completes the idempotent command result.

Only after commit are those ordered events published. Any failure rolls back the
entire application. Duplicate delivery returns the original task-ID mapping and
does not create more tasks or edges.

### Reject or cancel

Reject is a terminal review decision and requires a reason. It preserves all
proposal revisions and feedback without touching the board.

Cancel is available before approval. Its transaction changes the lifecycle,
records the actor and reason, revokes planning authority, and appends the event.
Only after commit may Mesh request interruption of the dedicated PM session. An
interruption failure is recorded diagnostically; it does not restore proposal
authority or affect unrelated sessions.

## Dependency policy

The existing content requirements remain prerequisites for entering `ready`.
Task readiness additionally reports every prerequisite that is not `done`.
Transitioning a task from `backlog` to `ready` fails with structured dependency
problems until all prerequisites are complete.

Attempt launch and project-run eligibility re-read dependency truth even if a
task is already in `ready`. This handles the reverse state where a prerequisite
was `done` when the dependent became ready and was later reopened. The dependent
stays visibly `ready`, but new launch is rejected until all prerequisites are
again `done`. Mesh does not silently demote it.

An already active Developer or QA attempt is never interrupted because a
prerequisite is reopened. Its history remains truthful. Dependency edits are
unavailable while the dependent has active work or has progressed beyond
`ready`, preventing retroactive mutation of an executing contract.

Milestone 5 runs retain frozen membership. Only tasks that are ready, unblocked,
and dependency-actionable at run authorization enter the run. Tasks that become
actionable later require a later operator-authorized run.

## Contracts, commands, and events

Shared contracts add schemas for planning cycles, proposal revisions, proposal
tasks, dependencies, structured validation problems, and planning summaries.

Operator commands are explicit and idempotent:

- `project.plan.start`
- `project.plan.request_revision`
- `project.plan.approve`
- `project.plan.reject`
- `project.plan.cancel`
- `project.plan.resume`
- `project.plan.retry`
- `task.dependency.add`
- `task.dependency.remove`

Every mutation carries the expected aggregate or task revision. Stable errors
distinguish unauthorized actors, lifecycle conflicts, stale plans, invalid
proposals, proposal limits, dependency cycles, dependency conflicts, billing
conflicts, and repair-required states.

Project events add `project.plan_changed` and `task.dependencies_changed`.
Existing task-created events remain the canonical creation events. Approval
persists the complete ordered event batch before publishing any member of it.
Replay uses the same sequence and idempotency semantics as existing project
history.

Project snapshots carry the active plan, compact terminal plan summaries, and
current dependency edges. Full immutable proposal and feedback history is
loaded on demand from a read-only HTTP endpoint so repeated planning cycles do
not make every reconnect payload grow without bound.

## Persistence and restart recovery

A migration adds planning cycles, planning-session associations, proposal
revisions, proposal tasks, proposal dependency references, operator feedback,
task dependencies, and the indexes and uniqueness constraints required by
their invariants.

Foreign keys preserve project and task ownership. Database constraints enforce
unique proposal ordinals, unique proposal-local keys, one nonterminal planning
cycle per project, unique dependency pairs, and one approval mapping per
proposal task. Graph acyclicity and board freshness require transactional
service validation because they span rows.

On restart, reconciliation compares every nonterminal plan with canonical
session state:

- `awaiting_review` remains reviewable without a live session.
- Formerly live `planning` or `revising` sessions follow existing interrupted
  session recovery and move the plan to `attention_required` unless a committed
  proposal already established `awaiting_review`.
- Ephemeral proposal capabilities are invalid and cannot be reconstructed from
  old process state.
- An explicit operator resume or retry revalidates project, repository,
  billing, plan, and board authority before issuing a fresh generation.
- `approved`, `rejected`, and `cancelled` plans never restart runtime work.

Audit persistence failure trips the existing global audit barrier and prevents
new planning, task, dependency, and runtime mutations from continuing unsafely.

## Realtime and web experience

The project workspace adds a focused planning panel above the existing board.
Starting a plan collects the goal, optional constraints and non-goals, and the
subscription-capacity acknowledgement. It states that the PM can read the
repository but cannot edit it.

The active view shows planning status, the associated session, attention
evidence, and a route to the normal transcript. Transcript content is clearly
separate from the structured proposal.

Proposal review shows:

- Ordered task summaries with expandable descriptions and criteria.
- Prerequisite and dependent lists using task titles and stable keys.
- Assumptions, risks, exclusions, and goal mappings.
- Operator feedback and differences between proposal revisions.
- Base-snapshot freshness and exact stale changes when known.

Approve, Request changes, Reject, Cancel, Resume, and Retry appear only when
authorized by current lifecycle state. Command-pending state stays local, while
canonical state changes only through project events or resync. Disconnect and
archived-project states are read-only.

After approval, existing task cards show unmet-prerequisite counts. The task
drawer lists prerequisites and dependents, links to those tasks, explains why a
task cannot become ready or launch, and exposes audited dependency editing only
in allowed states. The milestone adds no graph visualization dependency.

## Failure handling

- Invalid project, archive state, repository identity, billing environment, or
  actor authority rejects planning before session start.
- Runtime startup failure preserves the failed session and diagnostics and
  creates no proposal.
- Invalid structured submissions return field, reference, limit, or graph
  problems without creating a revision.
- Stale planning or proposal revisions reject commands and return current
  authoritative state.
- Stale board approval creates no task, edge, or approval event and returns a
  bounded change summary.
- Approval persistence failure rolls back the plan, tasks, edges, events, and
  command result together.
- Publication failure after commit is recoverable through durable replay; it
  never authorizes duplicate application.
- Capability mismatch, replay, expiry, or reuse rejects the PM call without
  trusting transcript context.
- Missing or inconsistent planning/session rows become explicit repair states;
  recovery does not delete ambiguous history.
- Project archive is rejected while a planning cycle is nonterminal. The
  operator must reject or cancel it first.

## Affected surfaces

- **Contracts:** planning, proposal, dependency, command, event, snapshot, and
  stable error schemas change.
- **Commands:** HTTP validation and command handling add operator planning and
  dependency mutations plus structured error mapping.
- **Runtime:** PM session composition, capability generation, interruption, and
  restart reconciliation are new; existing session authority is retained.
- **Persistence:** a reversible migration and repositories store planning,
  proposal, feedback, approval mapping, and dependency history.
- **Realtime:** project snapshots, ordered events, replay, and resync project
  plan and dependency state.
- **Web:** the project workspace gains planning review and dependency evidence;
  archived and disconnected behavior remains read-only.
- **Workspace safety:** PM sessions use the canonical repository through an
  enforced read-only policy and never create or clean worktrees.
- **Operating modes:** deterministic tests use the fake driver and temporary
  repositories and databases. Real Claude planning remains opt-in.
- **Reverse states:** revision after proposal, cancellation during planning,
  prerequisite reopening, dependency removal, disconnect/reconnect, and
  failure/recovery are explicit.
- **Documentation:** architecture and session-platform guidance must describe PM
  authority, proposal review, dependency gating, and opt-in smoke behavior.

## Verification strategy

Focused contract tests prove schema limits, local-key references, dependency
payloads, command revisions, event parsing, and snapshot round trips.

Repository and migration tests prove clean creation, upgrade of existing
databases, constraints, immutable proposal revisions, idempotent approval
mapping, dependency history, and transaction rollback.

Domain and service tests prove:

- Human-only controls and PM-only structured submission.
- Read-only PM permission behavior and repository containment.
- Audit-before-runtime and audit-before-publication ordering.
- Correct capability generation, invalidation, expiry, and replay rejection.
- Proposal validation, limits, existing-task references, and graph cycle
  detection.
- Same-session revision and explicit fresh-session recovery.
- Exact board-staleness detection and bounded change reporting.
- Atomic approval and duplicate-command idempotency.
- Dependency-aware readiness, attempt launch, and run preflight.
- Prerequisite reopening without silent demotion or active interruption.
- Cancellation, archive conflicts, restart reconciliation, and repair states.

Realtime and reducer tests prove ordered projection, duplicate delivery,
disconnect/reconnect, replay gaps, resync, compact planning summaries, and
on-demand proposal history.

Component tests cover the planning form, subscription warning, active and
attention states, proposal details, revision comparisons, stale evidence,
authoritative pending behavior, dependency lists, accessibility, and read-only
states.

An integrated Playwright scenario uses only the fake driver and temporary data:
start planning, submit a proposal, request a revision, submit a corrected
proposal, approve it, observe tasks and dependencies after refresh, reject an
unmet-dependent readiness transition, complete its prerequisite, and then move
the dependent task to ready. A separate scenario proves stale approval creates
nothing.

The normal complete gate is `corepack pnpm verify`. The real Claude planning
smoke test is opt-in, consumes subscription capacity, and must not run in
default verification or CI.

## Milestone stop condition

Milestone 6 is complete when an operator can give a goal to a read-only PM,
receive and revise a durable structured proposal, approve it atomically into
new backlog tasks and dependency edges, and understand exactly why a dependent
task cannot become ready or launch.

Every proposal, feedback item, approval decision, task creation, dependency
change, and failure must remain inspectable, idempotent, restart-safe,
subscription-backed, and constrained by existing project, task, session, and
workspace authority. Unapproved PM output must never become task truth.

## Deferred roadmap

A later milestone may let PM proposals modify existing backlog work under a
separate conflict and approval design. Another may make dependency completion
admit new work into a continuous or multi-wave scheduler with quota-aware
backoff and escalation. Delivery operations such as commit and pull-request
preparation require their own explicit authority and post-test human approval.

A general role or workflow framework should be extracted only if concrete PM,
Developer, QA, orchestration, and delivery implementations demonstrate repeated
mechanics whose duplication is less clear and safe than a shared boundary.
