# Mesh architecture

This document is the current working map for contributors and coding agents.
Keep it aligned with the implemented system. Design specs record why a feature
was proposed; this document records how the repository works now.

## System shape

Mesh is a local Node and React application. A Fastify server owns durable
session state and Claude driver processes. The browser sends validated commands
over HTTP, receives snapshots over HTTP, and follows durable events plus
transient streaming deltas over a WebSocket connection.

The live-session server event flow is:

```text
browser action
  -> shared command contract
  -> Fastify route and command handler
  -> session registry/runtime
  -> Claude driver
  -> normalized domain event
  -> atomic event + diagnostic persistence
  -> realtime publisher
  -> web projection
```

The client begins from a snapshot. On reconnect it sends its durable cursors and
receives replay; a detected gap or `resync.required` triggers a fresh snapshot.
Text deltas may be transient, while lifecycle, messages, permissions, errors,
and other server-backed session events are durable. Selection, filters, drafts,
notifications, unread flags, and in-progress streaming text are intentionally
local interaction state. A browser view is a projection, not the source of
truth.

Not every browser action enters this flow. Selection, filters, and drafts stay
local. Layout, archive, and delete commands take repository-backed paths that do
not start or drive a Claude session.

## Boundaries

### Contracts

`packages/contracts` owns data shared across process boundaries: domain types,
commands, events, HTTP payloads, and realtime protocol messages. A wire-level
change starts here and is followed through server producers, web consumers, and
tests. Keep contracts declarative and free of server or UI behavior.

### HTTP and realtime transport

`apps/server/src/http` validates commands and maps failures to stable responses.
`apps/server/src/realtime` handles connection, replay, and publication. These
are transport boundaries: translate and validate here, but keep lifecycle and
storage rules in their owning modules.

The server accepts only configured local origins. Origin checks and the stop-
accepting barrier protect live command and socket entry points during shutdown;
do not work around them in feature code.

### Runtime and lifecycle

`apps/server/src/runtime` owns active sessions, their legal runtime transitions,
recovery, and the ordering between persistence and publication. Active-runtime
lifecycle changes belong in the explicit transition model. Archive, delete, and
layout commands use their repositories outside this runtime event path. Avoid
scattered boolean state or UI-only interpretations of whether an active session
is running, interrupted, waiting for approval, or terminal.

Driver events are untrusted boundary data. `apps/server/src/claude` adapts the
Claude Agent SDK, normalizes events, and applies permission policy. Keep SDK-
specific shapes at this boundary so the rest of Mesh speaks its own contracts.
The fake driver implements the same behavioral interface for deterministic
tests.

### Persistence

`apps/server/src/db` owns SQLite setup and migrations.
`apps/server/src/repositories` owns durable reads and writes. Repositories hide
SQL from runtime and transport code; they do not decide product lifecycle.

State-bearing driver input is written with its raw diagnostic before it is
published. This audit barrier is intentional: if durable persistence fails,
Mesh must not continue presenting an unaudited state as successful.

Migrations are forward-moving, deterministic, and safe for existing databases.
Do not edit an applied migration to change history; add the next migration and
cover both fresh and upgraded databases.

### Web projection

`apps/web/src/api` owns transport clients. `apps/web/src/state` owns projection,
replay/resync behavior, selection, filters, drafts, and connection health.
`apps/web/src/sessions` and `apps/web/src/workspace` render and compose those
states. Components should express interaction and presentation rather than
reimplementing server lifecycle rules.

Treat disconnect, stale snapshot, invalid payload, empty data, loading,
permission requests, and terminal states as first-class UI states. Reconnect
must converge on server truth rather than assuming every transient delta was
received.

### Platform operations

`apps/server/src/platform` owns filesystem paths, Git/worktree operations,
process execution, and billing-environment checks. This is a high-risk boundary:
validate resolved paths and ownership before mutation, keep subprocess calls
explicit, and return actionable errors instead of guessing.

## Repository map

```text
apps/server/                     Fastify API, runtime, drivers, persistence
  src/claude/                    Claude SDK boundary and fake driver
  src/db/                        SQLite creation and migrations
  src/http/                      commands, routes, snapshots, HTTP errors
  src/platform/                  paths, Git, processes, billing safeguards
  src/realtime/                  WebSocket hub and durable replay
  src/repositories/              persistent data access
  src/runtime/                   lifecycle, registry, recovery, publication
apps/web/                        React/Vite client
  src/api/                       HTTP and WebSocket clients
  src/state/                     client projection and resynchronization
  src/sessions/                  session interaction and transcript UI
  src/workspace/                 workspace composition and layout
packages/contracts/              shared schemas, commands, events, protocols
docs/development/                current contributor and operational guidance
docs/superpowers/specs/          approved historical/product designs
docs/superpowers/plans/          implementation plans, not runtime truth
```

Tests live beside their subjects. Prefer a focused test at the boundary that
owns the rule. Cross-process behavior belongs in acceptance coverage only when
unit or integration tests cannot provide equivalent confidence.

## Where complexity belongs

Complexity caused by Claude SDK events, Git, the filesystem, SQLite, HTTP, and
WebSockets belongs in their adapters. The domain core should work with explicit
Mesh types and deterministic transitions. The UI should project server truth,
not invent a second lifecycle.

Create a new layer only when it has a clear responsibility, at least one real
consumer, and a boundary that can be explained without reading its internals.
Prefer adding a small function to the owning module over introducing a manager,
service, registry, strategy, or generic framework whose purpose is merely to
move code elsewhere.

## Durable documentation

Update this document when component ownership or the system flow changes.
Update `docs/development/session-platform.md` when setup, operating, or
verification behavior changes. Use a design spec for a meaningful future
architecture decision; once implemented, reconcile the durable development
docs so agents do not need to infer current behavior from historical plans.
