# Milestone 2 Task Board Design

**Date:** 2026-08-25
**Status:** Draft for written review

## Product outcome

Milestone 2 turns Mesh's durable session platform into a human-operated delivery workspace. A user imports a repository as a project, records execution-ready tasks on a board, and launches or links durable session attempts from those tasks.

The milestone is a thin end-to-end hybrid: useful human task management now, with the contracts and audit records needed for autonomous PM, Developer, and QA actors later. It does not add agent roles, automatic task selection, dependency scheduling, or autonomous lifecycle progression.

## Goals

- Give each imported repository a durable task board.
- Support a compact delivery lifecycle with explicit readiness rules.
- Preserve every task transition, blocked condition, and session attempt as audit history.
- Launch a session attempt from a ready task without falsely advancing the task when startup fails.
- Allow an existing same-repository Mesh session to be linked manually to a task.
- Rebuild the board from a backend snapshot plus ordered durable events.
- Make later autonomous operation an authorization-policy extension rather than a replacement task model.
- Preserve existing projects, sessions, worktrees, and operator changes through migration and failure recovery.

## Non-goals

- PM, Developer, or QA agent identities and role behavior.
- Autonomous transitions into review or done.
- Task dependencies, dependency-aware ordering, or automatic scheduling.
- Multi-repository projects.
- Estimates, sprint planning, task hierarchies, or generalized workflow configuration.
- Permanent project or task deletion.
- Replacing the existing session runtime, session event stream, or workspace UI.

## Architecture and ownership

Task management is a new domain inside the existing backend, not a separate service. It uses the same contract, command-validation, durable-persistence, error-mapping, and realtime boundaries as the session platform while remaining internally separate from session runtime concerns.

- A `Project` is a durable aggregate anchored to one validated local Git repository.
- A project owns its tasks, project event sequence, and board ordering.
- A `Task` owns its lifecycle, execution-ready content, priority, manual rank, blocked condition, and transition history.
- A `TaskAttempt` links exactly one task to exactly one Mesh session. A task may have many attempts; a session belongs to at most one current task association.
- A session remains the canonical source for runtime lifecycle and diagnostics. Attempts reference sessions instead of copying their runtime state.
- SQLite and the backend own canonical project, task, attempt, and transition state.
- The browser owns drafts, filters, selection, and temporary interaction state. It reconstructs the board from backend snapshots and ordered events.
- Task transitions are policy-authorized commands. Milestone 2 authorizes a human operator; later policies may authorize system or agent actors through the same command and audit path.

`packages/contracts` remains the boundary between the backend and browser. Task code may issue commands to the existing session application boundary but must not manipulate driver internals or publish session events itself.

## Project import and migration

The user explicitly imports a local Git repository to create a project. Session discovery may suggest repository paths, but suggestion discovery does not create durable projects. Import canonicalizes and validates the path, confirms Git repository identity, and prevents the same repository from being imported through alternative path spellings.

The existing session platform already persists automatically discovered `Project` records. The database migration extends those records in place and treats them as imported so sessions and layouts retain their project IDs. It adds repository identity, project timestamps, revision, and optional archive metadata without replacing existing IDs. Existing `discoveredAt` and discovery metadata remain available as provenance.

A project archive is a reversible container operation. Archived projects and their history remain readable, but they reject task edits and new attempts. Archiving is rejected while a project has running task attempts.

Milestone 2 supports one repository per project. Contracts use stable project and repository identity fields that do not preclude a future multi-repository model, but no repository collection or cross-repository task behavior is introduced now.

## Domain model

### Project

A project contains:

- Stable ID and display name.
- Canonical repository path and durable repository identity.
- Existing discovery provenance.
- Revision number for optimistic concurrency.
- Creation, update, and optional archive timestamps.

Repository identity must use the existing workspace-safety path boundary and Git metadata rather than display strings alone. Import and link commands fail closed when identity is ambiguous.

### Task

A task contains:

- Stable ID and owning project ID.
- Title and Markdown description.
- An ordered collection of acceptance criteria.
- Priority: `low`, `normal`, `high`, or `urgent`.
- Manual rank independent of priority.
- Lifecycle state.
- Optional labels and operator notes.
- Optional blocked condition.
- Revision number and timestamps.

The task lifecycle is:

```text
backlog -> ready -> in_progress -> review -> done
```

`cancelled` is terminal for normal progression. A human may deliberately restore a cancelled task to `backlog` with a reason. Backward transitions in the primary flow are allowed with a recorded reason so review rejection and rework are explicit.

A task may enter `ready` only when it has a non-empty title, description, at least one acceptance criterion, and a priority. This validation belongs to the backend contract; the browser previews the same missing fields for immediate feedback.

Blocked is an orthogonal condition, not a lifecycle state. Blocking records a non-empty reason, actor, and timestamp while leaving the task in its current board column. Unblocking is a separate audited command. A blocked task cannot launch a new attempt until unblocked.

### Task attempt

A task attempt contains:

- Stable ID, task ID, and session ID.
- Monotonic ordinal within the task.
- Creation source: `launched` or `linked`.
- Creation actor and timestamp.
- Optional unlink timestamp, actor, and reason for correcting a manual association.

Attempt outcome is projected from the linked session and is not independently editable. A partial uniqueness constraint ensures a session has at most one current task association. Historical unlinked associations remain auditable.

### Task transition

A transition is append-only and contains:

- Stable ID, task ID, previous state, and next state.
- Actor type, actor ID, and optional display metadata.
- Required reason where policy demands one.
- Command ID and timestamp.

Milestone 2 recognizes a human operator actor. The schema reserves explicit `system` and `agent` actor types for later policy implementations, but those actors receive no autonomous authority in this milestone.

### Board ordering and future dependencies

Manual rank and priority are independent. Dragging a card within a column changes rank; priority remains an explicit task property. Stable fractional or neighbor-based rank values should avoid rewriting an entire column for each move.

Future dependency edges may produce an actionable-order projection or constrain autonomous selection. They must not overwrite the operator's manual rank. No dependency table, blocked-by inference, or scheduling rule is part of Milestone 2.

## Commands and authorization

Project commands cover import, rename, archive, and restore. Task commands cover create, edit, reorder, block, unblock, transition, launch attempt, link an existing session, and unlink an incorrect manual association.

Every mutation carries:

- A unique command or idempotency ID.
- The expected aggregate revision when updating existing state.
- Actor identity and actor type.

The backend validates authorization, aggregate revision, lifecycle rules, repository identity, and command idempotency before mutation. A stale revision returns the current authoritative record so the browser can resynchronize rather than overwrite another change.

Transitions into `review` and `done` require the human-operator policy in Milestone 2. Session completion may inform the UI but does not prove task completion and never advances task state automatically. Later autonomous mode adds policy implementations for authorized PM or QA actors; it does not add alternate transition endpoints.

There is no permanent project or task deletion command in this milestone.

## Attempt launch flow

Launching an attempt is one backend product operation:

1. Confirm the project is active and the task is `ready`, unblocked, current at the expected revision, and authorized for the actor.
2. Validate the selected shared workspace or Mesh-owned worktree configuration using existing workspace-safety rules.
3. Create the session and durable task-attempt association.
4. Start the session using the existing session application boundary.
5. After startup succeeds, persist the transition from `ready` to `in_progress`.
6. Publish task and session events only after their required audit writes succeed.

If startup fails, Mesh retains the failed session and attempt association, leaves the task `ready`, and returns a typed failure with diagnostics. The operation is atomic at the product-outcome level, although process startup cannot participate in a SQLite transaction.

If startup succeeds but the `in_progress` transition cannot be persisted, Mesh interrupts the new runtime and records recovery diagnostics. Startup must not continue when the attempt's required audit writes fail.

Manual linking verifies that the session and project resolve to the same repository identity and that the session has no current task association. Linking does not change task lifecycle state. Unlinking requires a reason and never erases the historical association.

## Persistence and project events

New normalized tables store tasks, task attempts, task transitions, and durable project events. Project schema changes use additive, compatibility-safe SQLite migrations and preserve all existing project and session references.

Task-management events use a monotonic per-project sequence separate from the per-session event sequence. Event variants cover project changes, task changes, lifecycle transitions, block changes, ordering changes, and attempt association changes.

Each task command persists its canonical records, transition or history records, and normalized project events in one SQLite transaction before publishing. Duplicate command IDs return the recorded response without applying state twice. Raw operational diagnostics remain available for failures that cannot be represented solely by normalized events.

## Realtime and browser projection

The project snapshot contains the project, active and historical tasks needed by the selected filters, current attempt associations, and a per-project event cursor. The browser applies ordered project events after that cursor. A sequence gap or incompatible projection triggers a fresh project snapshot.

The existing session snapshot, history, diagnostics, and realtime event stream remain authoritative for session runtime. Opening a task attempt navigates to that session through existing workspace behavior. The browser joins task and session projections by stable IDs; neither stream impersonates the other.

Browser disconnect does not affect task attempts or sessions. Reconnection restores both project and session projections independently and then resolves their links.

## Web experience

The project workspace opens on a full-width board with columns for `backlog`, `ready`, `in_progress`, and `review`. Completed and cancelled tasks appear in filtered views rather than permanent columns. Blocked tasks remain in their current column with a prominent marker and reason.

Cards show title, priority, labels, blocked status, and attempt summary. Dragging within a column changes manual rank. Dragging between columns requests a validated transition and remains visibly pending until the backend accepts and persists it.

Selecting a card opens a right-side detail drawer over the board. The drawer contains:

- Editable description and acceptance criteria.
- Priority, labels, status, block controls, and transition actions.
- Attempt timeline with projected session state and outcome.
- Start-attempt and link-existing-session actions.
- Immutable transition history.
- A route to open a linked session in the existing session workspace.

Creating a backlog task requires only a title. Moving it to ready highlights any missing execution-contract fields. Starting an attempt reuses the existing safe workspace and permission-mode controls.

Project import begins with a repository picker or an explicit import action on a repository suggestion from session discovery. Archived projects are read-only by default and can be restored explicitly.

## Failure handling and recovery

- Invalid repository import returns a typed path or repository-identity error and creates nothing.
- Duplicate import identifies the existing project.
- Stale revisions reject the command and return current authoritative state.
- Invalid transitions return allowed transitions and leave state unchanged.
- Failed startup retains the failed session and attempt and leaves the task ready.
- Persistence failure stops publication and prevents unsafe runtime continuation.
- Realtime gaps trigger project snapshot resynchronization.
- Linking rejects cross-repository, already-linked, missing, and ambiguous sessions.
- Project archive is rejected while a task attempt has a running session.
- Done and cancelled tasks reject new attempts until deliberately returned to an active state.

On backend restart, reconciliation compares task attempts with canonical session lifecycle. It interrupts formerly live sessions through the existing recovery policy and identifies inconsistent attempt/task combinations as explicit repair conditions. Recovery never guesses that a completed session satisfied acceptance criteria or automatically moves a task.

## Verification strategy

Contract tests prove schemas, readiness validation, lifecycle transitions, actor metadata, event variants, and backward-compatible decoding of existing session payloads.

Focused backend tests cover:

- Existing-project migration and explicit repository import identity.
- Duplicate and ambiguous repository handling.
- Task creation, edits, ranking, blocking, cancellation, restoration, and stale revisions.
- Append-only transition history and command idempotency.
- One-current-task-per-session constraints and preserved unlink history.
- Successful attempt startup and transition to `in_progress`.
- Startup failure, audit-write failure, runtime interruption, and restart reconciliation.
- Per-project event ordering, replay, gaps, and snapshot recovery.
- Project archival protections.

Web tests cover board projection, filtering, drag outcomes, rejected transitions, readiness validation, drawer behavior, attempt history, and reconnect resynchronization.

An integrated fake-driver test imports a temporary repository, creates and readies a task, launches an isolated attempt, observes its session, moves it through review to done, and refreshes the browser without losing board state. Tests use temporary repositories and databases and never use the operator's runtime database, credentials, active worktree, or Claude subscription.

The normal full gate is `corepack pnpm verify`. The real Claude smoke test remains opt-in and outside default verification.

## Affected surfaces

- **Contracts:** project extensions plus task, attempt, transition, command, HTTP, snapshot, and realtime schemas.
- **Commands:** import, task mutation, attempt association, lifecycle validation, authorization, idempotency, and typed errors.
- **Runtime:** attempt launch composition, failure interruption, and restart reconciliation; the driver contract remains unchanged unless implementation evidence proves otherwise.
- **Persistence:** additive migration, repositories, uniqueness constraints, revisions, transactions, ordering, and project event replay.
- **Realtime:** a durable per-project stream alongside the existing per-session stream.
- **Web:** project import, board projection, task drawer, transition feedback, attempt history, and archived views.
- **Workspace safety:** canonical repository identity and existing shared/worktree validation.
- **Operating modes:** Windows paths, fake and real drivers, and fresh and migrated databases.
- **Reverse states:** block/unblock, cancel/restore, archive/restore, link/unlink, forward/rework transitions, and failure/recovery.
- **Documentation:** architecture and session-platform guidance must describe the task layer and its separation from future orchestration.

## Deferred roadmap

The next role-oriented milestone may attach PM, Developer, and QA identities and policies to these tasks and attempts. Autonomous mode can then authorize task selection and lifecycle commands through the same audited command boundary.

A later dependency milestone may add task edges and actionable-order projections without replacing manual rank. Multi-repository projects, generalized workflows, and orchestration policy remain separate design problems and require their own specifications.
