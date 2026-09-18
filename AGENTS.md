# Mesh Agent Guide

Mesh is a local session platform for running, observing, and steering coding
agents against a repository. It must remain safe around real worktrees,
credentials, subscription quota, and durable session history.

`AGENTS.md` is the shared source of truth for every agent harness. Keep hard
rules and high-value defaults here. Put explanations and evolving architecture
in the linked development guides.

## Product Invariants

- **Local and subscription-backed.** Mesh uses the operator's installed Claude
  subscription. It does not silently switch to pay-per-token API billing.
- **Durable before optimistic.** Persisted session events are the audit record
  for server-backed session history. Transient streaming and local interaction
  state may be ephemeral and must not be mistaken for durable truth.
- **Safe around real work.** Preserve user changes, worktrees, credentials, and
  live sessions. Ambiguous ownership is a reason to stop, not to delete.
- **Explicit behavior.** Lifecycle transitions, permissions, contracts, and
  failure states should be visible and testable rather than implied.
- **Simple systems.** Solve the current constraint with the smallest coherent
  model. Add indirection only when it creates a real boundary or removes proven
  duplication.

These are constraints. The preferences in
[`docs/development/engineering-principles.md`](docs/development/engineering-principles.md)
are defaults that a maintainer may override.

## Before Changing Code

1. Understand the relevant behavior and its callers before editing.
2. Read
   [`docs/development/architecture.md`](docs/development/architecture.md) for
   component boundaries and the request/event flow.
3. Check whether the change crosses contracts, persistence, lifecycle,
   realtime transport, UI projections, or operational documentation.
4. Choose the smallest verification that proves the changed behavior.

Do not preserve complexity merely because it exists, and do not introduce a
framework, abstraction layer, or generalized extension point for a hypothetical
future requirement. Improve nearby structure when it directly supports the
change; leave unrelated refactors for separate work.

## High-Impact Safety Rules

1. **Never enable API billing.** Starting or resuming a live session spends
   Claude subscription quota. Never set or fall back to `ANTHROPIC_API_KEY` or
   another pay-per-token override.
2. **Never treat live state as test data.** Routine tests use the fake driver,
   temporary repositories, and temporary databases. Do not point tests at the
   operator's runtime database, credentials, or active worktree.
3. **Never delete ambiguous work.** Remove only a worktree or process that Mesh
   or the current task demonstrably owns. Inspect paths and changes first.
   Avoid name- or path-pattern process killing.
4. **Never bypass runtime audit writes.** Persist normalized driver input and
   runtime-emitted session events with their required diagnostics before
   publishing them. Audit persistence failure must stop that runtime from
   continuing unsafely.
5. **Never weaken boundaries silently.** Permission, origin, billing, path, and
   lifecycle checks are product behavior. Changes require focused tests and a
   clear explanation.

## Check Every Affected Surface

Before calling a behavior change complete, decide which of these apply:

- **Contracts:** schemas and shared types in `packages/contracts`.
- **Commands:** HTTP validation, command handling, and error mapping.
- **Runtime:** lifecycle transitions, driver behavior, interruption, and
  recovery after restart or failure.
- **Persistence:** migrations, repositories, ordering, idempotency, and audit
  diagnostics.
- **Realtime:** durable replay, transient deltas, reconnect, and resync.
- **Web:** state projection, loading/error/empty states, permissions, and user
  feedback.
- **Workspace safety:** repository paths, worktree ownership, concurrent
  sessions, archive, and deletion.
- **Operating modes:** development and production builds, Windows paths, fake
  and real drivers, fresh and existing databases.
- **Reverse states:** start/stop, create/archive/delete, approve/deny,
  connect/disconnect, and failure/recovery.
- **Documentation:** update user-visible or operational guidance when behavior
  changes.

Not every item applies. State the relevant decisions rather than mechanically
touching every layer.

## Worktree Policy

Every unit of work intended to become a pull request uses its own git worktree,
including docs and chores. The repository root remains on `master` and is not a
feature workspace.

Create a worktree from current `origin/master`:

```text
git fetch origin master
git worktree add .worktrees/<slug> -b <branch> origin/master
cd .worktrees/<slug>
corepack pnpm install --frozen-lockfile
```

Use the harness-native worktree tool when one is available. `.worktrees/` is
gitignored, and dependencies are installed separately in each worktree. Remove
a worktree only after its work is integrated or explicitly abandoned and its
changes have been inspected. The API uses port 3737; Vite prefers 4200 and may
select a higher free port.

## Code Exploration Policy

Use the jCodeMunch-MCP surface supplied by the current harness for code
navigation. Follow its briefing and prefer its semantic planning, search, and
context operations. Do not substitute broad Read, Grep, Glob, or shell
exploration. Reading the exact file being edited is allowed when the harness
requires it.

When the compact front-door surface is available, announce the model and
resolve the repository at session start:

```text
announce_model { "model": "<model-id>" }
order { "action": "resolve_repo", "args": { "path": "." } }
```

If it is not indexed, use `index_folder`. Then use `order` when the action is
known, `route` when the goal is known, and `menu` or `jcodemunch_guide` for
discovery. On a direct surface, use the equivalent operations named in the
harness briefing rather than attempting unavailable front-door tools.

- `no_implementation_found` is evidence of absence; do not keep rephrasing the
  same search.
- `degraded` means a channel was unavailable and absence is not proven.
- Empty `source` with `source_status` means the body could not be read.
- After edits, rely on installed hooks or call `register_edit` once with the
  complete changed-path batch.

## Documentation Exploration Policy

Use jDocMunch-MCP for documentation navigation. Start with `doc_list_repos` and
use `index_local` when necessary. Use `search_sections` for topics, TOC and
outline tools for structure, and section retrieval tools for content. Use
`get_broken_links` and `get_doc_coverage` for maintenance. Read exact files only
when editing or when exact line numbers are required.

If a required MCP surface is unavailable, report that limitation rather than
pretending its guarantees were met.

## Testing and Verification

`corepack pnpm test` and `corepack pnpm e2e` are deterministic and do not start
external Claude traffic. Prefer the narrowest relevant Nx target during
iteration. Run `corepack pnpm verify` for the normal complete local/CI gate when
the scope warrants it.

Backend behavior changes require focused tests. Test asynchronous behavior by
waiting on observable events or drains, not arbitrary sleeps. For user-visible
changes, exercise the integrated path when requested or when unit-level proof
cannot cover the risk. Always report what was and was not verified.

The real Claude smoke test is opt-in, consumes subscription capacity, and must
never enter default verification or CI. See
[`docs/development/session-platform.md`](docs/development/session-platform.md).

## Pull Requests and Commits

An implementation request or approval includes standing authorization to verify,
commit the intended changes, push the task branch, and open or update its pull
request. Continue through expected CI checks passing on the current PR head before
handing work back for hands-on testing. Diagnose and repair ordinary CI failures;
pending, missing, skipped required, or stale checks are not a passing result.
Report a concrete access, infrastructure, or scope blocker when progress requires
the maintainer; do not ask for routine permission to publish or repair CI.

For UI/runtime changes, start or safely reuse the feature-worktree stack as soon
as the PR is open, while CI runs. Verify the UI and API at the current PR revision
and prepare brief user-facing test steps. Once CI and stack health both pass,
provide a clickable UI URL and the short checklist with expected results.
Refresh and recheck the stack if CI repairs change the revision.
Keep the stack available for testing. Follow the complete-work startup procedure;
preserve live processes and operator data, honor explicit no-run instructions,
and report startup blockers before claiming readiness. Docs-only work needs a
file walkthrough instead.

Honor explicit plan-only, local-only, no-push, or no-PR instructions. Brainstorming
and visual approval alone do not authorize implementation. Do not offer local-only
delivery as the default or add a separate PR approval gate. Merge still requires
the maintainer's hands-on testing and explicit approval of that PR revision.

Keep one concern per pull request; UI changes should include appropriate visual
evidence. Do not commit temporary plans,
research notes, logs, screenshots, or agent scratch files unless they are an
explicit project deliverable.

Use Conventional Commits:

```text
<type>(<optional scope>): <description>
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`.

Use imperative lower-case wording, no trailing period, and at most 72
characters in the subject. Mark breaking changes with `!` and explain them in
the body. Never add assistant attribution, `Co-Authored-By` trailers naming an
agent, or generated-by footers. Rewrite nonconforming local history before
pushing.
