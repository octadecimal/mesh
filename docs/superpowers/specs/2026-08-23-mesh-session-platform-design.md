# Mesh Session Platform Design

**Date:** 2026-08-23
**Status:** Draft for written review

## Product vision

Mesh is a local project workspace for managing software delivery through visible, controllable Claude Code agents. Its eventual workflow includes a task board, a Project Manager agent that delegates work, Developer agents that implement tasks in isolated workspaces, QA agents that validate acceptance criteria, and an auditable lifecycle for rework, completion, and human intervention.

The session manager described here is the first foundation, not the final product. It gives humans and future orchestration code the same durable, observable way to create, resume, control, and inspect Claude sessions.

## Delivery decomposition

The product is divided into five ordered sub-projects:

1. Session runtime and workspace.
2. Projects and task board.
3. Agent roles and task assignment.
4. Delegation, QA, rework, and completion orchestration.
5. Automation policies for concurrency, usage, escalation, scheduling, and reporting.

This specification covers only sub-project 1. It preserves stable identifiers and contracts for later phases but does not scaffold task, role, board, or orchestration implementations.

## Goals

- Discover, inspect, resume, and create Claude Code sessions from a local web interface.
- Present structured messages, tool activity, permissions, errors, and status.
- Retain a collapsible read-only diagnostic view of raw SDK and process events.
- Keep active sessions running when the browser closes or reconnects.
- Group sessions by project or repository.
- Let a new session use either a shared folder or an isolated Git worktree.
- Let each session choose interactive approvals, safe auto-approval, or the inherited Claude default.
- Restore workspace layout and support one or two visible session panes.
- Use the user's Claude Max subscription without automatic pay-per-token fallback.
- Target Windows first while keeping process, path, and terminal boundaries portable.
- Establish session command and event contracts that future PM and QA orchestration must use.

## Non-goals

- Task entities or a task board.
- Project Manager, Developer, or QA role behavior.
- Agent-to-agent messaging or delegation.
- Autonomous QA and rework loops.
- Remote hosting, LAN access, accounts, or authentication.
- More than two simultaneously visible session groups.
- A live interactive terminal or embedded Claude Code TUI.
- Automatic API-credit or pay-per-token fallback.
- Automatic cleanup of dirty or ambiguous worktrees.
- Production packaging as Electron in this phase.

## Technology choices

The repository will be an Nx TypeScript workspace with these initial projects:

- `apps/web`: React and Vite client.
- `apps/server`: local Node backend.
- `packages/contracts`: versioned command, event, and shared data schemas.

The web client uses:

- `dockview-react` for session tabs, groups, optional two-pane layouts, drag and drop, and serialized layout restoration.
- Radix UI primitives for accessible dialogs, menus, selects, collapsibles, tooltips, scroll areas, and permission prompts.
- Tailwind CSS for application styling, design tokens, and a thin theme over Dockview CSS variables.
- Hookstate for client projections and transient UI state.

The backend uses the Claude Agent SDK through a narrow `ClaudeSessionDriver` interface. A future headless CLI driver may implement the same interface if the SDK exposes a blocking limitation. The MVP does not parse an interactive terminal presentation.

SQLite stores canonical application metadata, normalized events, diagnostics, and layouts. Claude Code remains the owner of its native transcripts and resume identity.

Nx provides project graph enforcement, task orchestration, caching, affected checks, and aggregate verification. Additional libraries are extracted only after real reuse or ownership boundaries appear.

## Architecture and ownership

The local backend is the sole authority for Claude processes, session lifecycle, persistence, permissions, repository paths, and Git worktrees. Its lifetime is independent of browser connections.

The browser communicates with the backend over loopback HTTP and WebSocket connections. It can be discarded and reconstructed from a backend snapshot plus ordered events.

`packages/contracts` separates the two applications. The browser never imports backend internals, and the backend never depends on React or Hookstate.

State ownership is explicit:

- Hookstate owns client projections, selected sessions, filters, prompt drafts, and transient notifications.
- Dockview owns panel and group geometry through its serialization API.
- The backend and SQLite own canonical sessions, lifecycle state, normalized events, approvals, and raw diagnostics.
- Claude Code owns native transcript files and Claude resume IDs.

Future task and orchestration layers issue commands and consume events through the same contracts as the human UI. They must not bypass persistence, permissions, lifecycle rules, or audit history.

## Workspace interface

A permanent sidebar groups sessions by project or repository and shows title, lifecycle status, unread activity, workspace type, and approval needs. It provides project/session filtering and a new-session action.

The main area is a Dockview workspace. A session opens as a panel and normally occupies one group. Users may split the workspace into two visible groups and drag session panels between them. The MVP prevents a third visible group while allowing additional sessions as tabs.

Each session panel contains:

1. Repository path, shared-folder or worktree status, and permission mode.
2. Structured transcript of user messages, assistant messages, tool activity, results, approvals, and errors.
3. Inline approval cards with the actions supported by the active permission policy.
4. A collapsible, read-only raw diagnostics section.
5. A prompt composer and explicit session actions.

Closing a panel only hides it. It does not terminate the backend session. Stopping or interrupting a session is a separate explicit action.

## Domain records

The MVP persists six core record types:

### Project

A stable application ID, display name, canonical repository or folder path, and discovery metadata. In this phase a project is a repository grouping, not a task-management aggregate.

### Workspace

A stable ID, project reference, workspace type (`shared` or `worktree`), absolute path, Git branch and worktree metadata, ownership, and cleanup state.

### Session

A stable application session ID, optional Claude resume ID, project and workspace references, title, permission mode, lifecycle state, and timestamps.

### SessionEvent

An immutable normalized event containing a stable event ID, session ID, monotonically increasing per-session sequence number, timestamp, event type, and typed payload. Variants cover messages, tool calls, tool results, approvals, status transitions, errors, and diagnostics.

### RawDiagnostic

The original SDK or process payload, linked to a normalized event when applicable. Raw objects never become the client contract.

### SavedLayout

Dockview serialization plus sidebar and visible-panel preferences.

Later task and orchestration records will reference `projectId`, `sessionId`, `workspaceId`, and event sequences without changing session ownership. A worktree is a workspace type, not a separate identity.

History and raw diagnostics remain local until explicitly deleted. Archiving preserves history while hiding a session from normal views. Destructive deletion is separate and confirmed. There is no automatic retention policy in the MVP.

## Commands and events

HTTP supplies commands and state snapshots. Initial commands include:

- Discover projects and Claude sessions.
- Create a session.
- Resume a session.
- Send a prompt.
- Interrupt a session.
- Approve or deny a permission request.
- Archive or explicitly delete a session.
- Fetch history or diagnostics.
- Save workspace layout.

Every mutating command carries an idempotency key.

WebSocket supplies session events, process status, permission requests, project discovery changes, and connection health. Each event includes a stable session ID and per-session sequence number.

On reconnect, the client requests events after its last applied sequence. If that range is unavailable, it replaces its local projection with a fresh snapshot. Event application is idempotent.

## Session lifecycle

Session states are:

- `idle`
- `starting`
- `running`
- `waiting_for_approval`
- `interrupting`
- `completed`
- `failed`
- `interrupted`
- `archived`

Discovery merges Claude transcript metadata with application records and project grouping. Creating or resuming a session selects a workspace and permission mode, then starts exactly one session driver.

The backend persists each normalized event before updating projections and broadcasting it. Browser disconnection does not affect the process. On reconnect, snapshot and sequence reconciliation restore the view without duplication.

A backend restart cannot preserve an in-memory Agent SDK process. Sessions that appeared live before shutdown become `interrupted`, not `running`. The user may explicitly resume them from their Claude session IDs. Mesh never automatically replays a prompt because replay could duplicate tool side effects.

## Claude subscription boundary

The app is designed to use the locally authenticated Claude Max subscription. It does not accept or configure an Anthropic API key.

At startup, the backend detects `ANTHROPIC_API_KEY` and other known API-billing configuration that would override subscription authentication. It refuses to launch Claude sessions until the conflict is removed or the user deliberately changes authentication outside Mesh.

Subscription limit responses block the affected session and show reset information when available. Mesh does not retry limit failures in a loop and does not offer automatic usage-credit fallback.

## Permissions

Each session selects one of three modes:

- Interactive approvals.
- Safe auto-approval.
- Inherit Claude Code's configured default.

Permission requests are persisted before presentation. Reconnection cannot lose a pending decision. The UI keeps an audit trail of requested, approved, denied, and expired actions.

Unknown tools, unsupported SDK events, and ambiguous permission requests fail closed. They remain visible in diagnostics and require explicit approval when a decision is possible.

## Failure handling

- SDK or child-process crash: preserve partial output, mark the session `interrupted`, and offer manual resume.
- Browser disconnect: continue running and persisting the session.
- Graceful backend shutdown: request interruption, persist terminal state, then terminate after a bounded timeout.
- Unexpected backend termination: reconcile formerly live sessions to `interrupted` on restart.
- Database write failure: stop accepting prompts and approval decisions because the audit trail is no longer trustworthy.
- Malformed SDK event: quarantine the raw payload, record a diagnostic event, and preserve sequence consistency.
- Duplicate event: discard it idempotently without advancing state twice.
- Unsupported Claude capability: report a typed capability error rather than silently degrading behavior.

## Filesystem and Git safety

All repository and workspace paths are resolved and validated as absolute paths before use.

Shared repositories are never automatically deleted or moved. Concurrent sessions attached to one shared folder receive a prominent collision warning.

Worktree creation records Mesh ownership. Worktree removal requires a stopped session, a clean worktree, and explicit confirmation. Dirty, missing, or ambiguous worktrees are preserved and reported for manual resolution.

Platform-specific filesystem, process, and Git behavior sits behind adapters so Windows is the first tested platform without becoming a core-domain assumption.

## Local security

The backend binds only to loopback. It serves the browser client itself and restricts accepted HTTP origins and WebSocket connections to that local origin. The MVP has no login because it is single-machine and single-user.

Raw diagnostics and transcripts may contain repository content and tool arguments. They remain local and are not exposed through a network listener.

## Testing strategy

### Unit and contract tests

Vitest covers event normalization, lifecycle transitions, reconnect sequencing, permission decisions, path validation, Hookstate projections, and shared command/event schemas.

### Backend integration tests

A deterministic fake `ClaudeSessionDriver` exercises create, resume, streaming, approvals, interruption, crashes, and restart recovery without consuming Claude usage. SQLite tests use temporary databases and cover migrations and transaction failures. Git tests use temporary repositories and include Windows path behavior.

### Client tests

React component tests cover transcript rendering, tool events, approval cards, status indicators, diagnostics, and session-creation controls.

### End-to-end tests

Playwright covers project discovery, creating and resuming sessions, shared-folder and worktree choices, Dockview restoration, two-pane behavior, reconnect recovery, and browser refresh while a session is active.

### External smoke tests

A small opt-in suite checks the installed Claude Agent SDK and subscription authentication. It is excluded from normal CI because it consumes subscription capacity and depends on an external service.

### Required gates

Nx runs formatting, linting, type checking, unit and contract tests, builds, deterministic integration tests, and end-to-end tests. Aggregate verification must pass before completion.

## MVP acceptance criteria

The MVP is complete when it can:

1. Discover and open an existing Claude Code session.
2. Create a session in a shared folder or an isolated Git worktree.
3. Exchange structured messages and show raw diagnostics.
4. Handle interactive approvals and selectable permission modes.
5. Keep an active session alive across browser refresh and closure.
6. Restore history and Dockview layout.
7. Show interruption and recovery truthfully after backend failure.
8. Refuse accidental API-key billing configuration.
9. Display one or two session panes on Windows.
10. Expose stable session commands and events suitable for later board and orchestration layers.

## Deferred roadmap

The next specification should add projects as task-management aggregates and define the board and task lifecycle. Later specifications will attach PM, Developer, and QA roles to those tasks, then introduce orchestration and policy layers. Each phase must build on the audited session contracts defined here.
