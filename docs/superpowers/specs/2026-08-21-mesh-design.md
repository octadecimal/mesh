# Mesh — Design

Date: 2026-08-21
Status: Approved for implementation planning

## Goal

A local application that wraps the Claude Code CLI so that a single human can
run a small team of agents against one repository, watch them work, and steer
them through a kanban board. It runs in a browser first and is wrapped as a
desktop app later.

The human talks only to a project manager agent. Developer and QA agents are
observed, never chatted with directly. Conversations between agents are visible
in a sidebar and persist on disk.

## Hard constraints

- **Subscription only.** No pay-per-token Anthropic API usage. Authentication is
  the existing Claude Code OAuth credential.
- **Quota is the binding resource**, not compute. The account is a Max 20x plan,
  which supports roughly three to five concurrent developer agents.
- **One target repository at a time.** The repository path is configurable. The
  first target is Mesh itself, so the project is self-hosting from the second
  milestone onward.

## Probe findings

All of the following were measured against Claude Code 2.1.239 on 2026-08-21.
Probe code was throwaway and is not retained.

### Subscription authentication works headless

Running `claude -p --output-format stream-json --verbose` with no
`ANTHROPIC_API_KEY` in the environment succeeds and is billed against the
subscription. Quota state arrives as a first-class stream event:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
 "resetsAt":1787388600,"rateLimitType":"five_hour","overageStatus":"rejected"}}
```

`result.total_cost_usd` is still populated. It is notional under a subscription
and must not be presented as money spent.

### Subagents are conversational, not one-shot

`SendMessage` addressed to a subagent's `task_id` resumes that subagent with its
transcript intact and produces a further reply. The same `task_id` is reused
across invocations. Bidirectional agent-to-agent messaging is therefore native
and requires no custom message bus.

### Subagent activity is fully observable

Every subagent event carries `parent_tool_use_id`, so a parent stream can be
demultiplexed into per-agent panes. The lifecycle feed consists of:

- `task_started` — `task_id`, `tool_use_id`, `subagent_type`, `spawn_depth`,
  `is_backgrounded`, and the dispatch `prompt`
- `task_updated` — status patches
- `task_notification` — status, `output_file`, `summary`, and per-task
  `usage { total_tokens, tool_uses, duration_ms }`
- `background_tasks_changed` — the live roster
- `result.subagent_stats` — spawned, completed, failed, killed, and refused
  counts, including `refused.concurrency_limit`

### Concurrency is not capped at five

Five background subagents dispatched in one message all ran concurrently. The
roster grew to five before draining, and `refused.concurrency_limit` was zero.
Behaviour above five is unverified.

### Worktree isolation forks from base HEAD

`isolation: "worktree"` places each agent at
`<repo>/.claude/worktrees/agent-<task_id>` on branch
`worktree-agent-<task_id>`. All five probe worktrees were created from the same
commit as `master`.

Two consequences:

1. A QA agent given its own worktree would not see the developer's work.
2. Worktrees and branches persist after the task completes. Nothing prunes them
   automatically, so Mesh owns their lifecycle.

Branches are named by `task_id`, not by ticket. Mesh records the mapping and
displays ticket identifiers.

### Token economics favour long-lived processes

| Run | cache_creation | cache_read |
| --- | --- | --- |
| Cold start, full MCP servers and skills | 66,821 | 0 |
| Cold start, no MCP servers | 50,468 | 0 |
| Second turn in the same process | 534 | 50,467 |

Cold start is paid once per process and then served from a one-hour ephemeral
cache. Spawning a process per ticket would pay roughly 50,000 tokens every time.
Agent processes must therefore be long-lived.

### Agents can be defined inline

`--agents '{"name":{"description":...,"prompt":...,"tools":[...],"model":...}}'`
defines a persona at spawn time with a per-agent tool allowlist. No agent files
on disk are required, and the allowlist is enforced by the runtime rather than
by prompt discipline.

### Live input injection works

`--input-format stream-json` accepts newline-delimited user messages on stdin.
Context is retained across them and one `result` event is emitted per turn,
giving a clean turn boundary for the UI.

### Two dead ends

- `--bare` disables OAuth entirely (`apiKeySource: none`, "Not logged in"). It
  cannot be used to reduce cold-start overhead on a subscription.
- `--permission-mode bypassPermissions` is blocked by the local permission
  classifier. A `--allowedTools` allowlist works and is the better model
  regardless.

An isolated `CLAUDE_CONFIG_DIR` per agent was not tested; the credential symlink
required was blocked by the permission classifier.

## Architecture

### Topology

One long-lived `claude` process is the project manager. Mesh, a Node server,
owns it: it spawns the process with `--input-format stream-json
--output-format stream-json`, writes the human's messages to its stdin, and
reads its event stream.

Developer and QA agents are background subagents of that process, defined inline
via `--agents`. Developers receive `isolation: "worktree"`.

The human talks only to the project manager. Developer and QA panes are
read-only projections of the same stream.

### Capability model

Roles are separated by tool allowlist, enforced by the runtime:

- **Project manager** — board tools, `Agent`, `TaskOutput`, `SendMessage`. No
  `Edit` or `Write`; it does not touch code.
- **Developer** — `Read`, `Edit`, `Write`, `Bash`, `ticket_note`, and its single
  board transition. No general board tools.
- **QA** — `Read`, `Bash`, `ticket_note`, and its two board transitions. No
  write access to code.

The session-level `--allowedTools` allowlist sets the ceiling; the per-agent
`tools` list narrows it further.

### The board is a state machine

Transitions are typed, and each role holds a small set of edges. Mesh validates
every transition against the allowed edge set, so no agent can invent one.

| Actor | Edges |
| --- | --- |
| Human | `backlog → ready` |
| Project manager | triage, assign, priority, `rejected → in_progress`, any state `→ blocked` |
| Developer | `in_progress → ready_to_test` |
| QA | `ready_to_test → verified`, `ready_to_test → rejected` |

This replaces a single-writer model. It is a stronger guarantee, and it takes
the project manager off the critical path so a ticket can advance while that
agent is busy or compacting.

### Columns dispatch; the project manager judges

Each column carries a dispatch rule that Mesh executes deterministically at zero
token cost:

- `ready` — dispatch a developer
- `ready_to_test` — dispatch QA into the developer's worktree
- `rejected` — notify the project manager
- `verified` — prune the worktree and branch, notify the human

The project manager is invoked only for judgement: triage, arbitration, and
deciding whether a rejection means rework or a specification problem.

### QA shares the developer's worktree

QA does not receive `isolation: "worktree"`, because a fresh worktree would fork
from base HEAD and contain none of the developer's work. QA runs inside the
developer's worktree with `Read` and `Bash` only. This is safe because the
developer is parked while the ticket sits in `ready_to_test`, so there is no
concurrent writer. It also allows QA to test an uncommitted tree, which is what
is wanted during iteration.

The alternative — the developer commits to its branch and Mesh creates a QA
worktree from that branch — is deferred.

### Storage

```
.mesh/
  config.json           target repo, agent roster, model per role, PM session id
  tickets/T-001.md      source of truth for state and thread
  events.jsonl          append-only machine feed
  runs/<task_id>.json   worktree, branch, transcript path
```

`.mesh/` sits at the target repository root and is gitignored. Git worktrees
contain only tracked files from their branch, so an untracked `.mesh/` exists
solely in the main checkout and is unaffected by branch switching anywhere.
Committing it would fork the board across every worktree.

A ticket file carries state in frontmatter and the conversation below it:

```markdown
---
id: T-001
state: ready_to_test
assignee: dev-2
task_id: a77fbf404e98dc1ef
worktree: .claude/worktrees/agent-a77fbf404e98dc1ef
---
## Brief
## Acceptance
- [ ] gauge shows five_hour reset

## Thread
### 10:04:12Z · pm → dev-2 · dispatch
### 10:09:40Z · dev-2 → pm · receipt
### 10:09:41Z · system · transition
```

Markdown is chosen over a database primarily so the ticket corpus is directly
indexable for semantic retrieval. Each thread entry is an `###` section, which
makes an individual message a retrievable chunk across the whole history.

Only Mesh writes these files. Agents call `ticket_note`; Mesh stamps and appends.
Mesh also appends without being asked, from the stream it already observes:
`task_started.prompt` becomes the dispatch entry, and `task_notification.summary`
plus the subagent's final text becomes the receipt. Capture therefore survives an
agent that forgets to log.

`events.jsonl` is not a duplicate. It carries `task_notification.usage` and
`rate_limit_event`, which together provide quota accounting per ticket and per
agent.

Agents never read the store directly; every access is an MCP call into Mesh. The
storage format is therefore internal to Mesh and reversible.

### Migration path to a database

Markdown is expected to be replaced by SQLite once the board grows. Three things
keep that migration cheap:

1. All file input and output lives in `store.ts`. Migration is a swap of one
   module.
2. Mesh is the only writer and serialises every board mutation through one queue,
   so the read-check-write of a transition cannot interleave. Writes go to a
   temporary file and are renamed, so a crash cannot truncate a ticket.
3. The trigger is known: reading every ticket to build the sidebar feed is fine
   into the hundreds. Slowness, or a need for cross-ticket analytics, is the
   signal. Migration replays the files and retains them as an export.

### Dispatch loop

1. The human drags `T-001` to `ready`. Mesh validates the edge, writes the
   transition, and fires the column rule.
2. Mesh writes to the project manager's stdin: dispatch `T-001`, prefix the
   `Agent` prompt with `[T-001]`, plus the brief and acceptance criteria.
3. The project manager calls `Agent` with `subagent_type: "dev"`,
   `run_in_background: true`, `isolation: "worktree"`.
4. Mesh observes `task_started`, parses the `[T-001]` tag, binds `task_id` to the
   ticket, records the worktree and branch in `runs/`, and appends the dispatch
   entry to the thread.
5. The developer works. Its events carry `parent_tool_use_id`, which Mesh routes
   to that ticket's live pane.
6. On completion Mesh reads `task_notification` for summary, tokens, and
   duration, and appends the receipt. The developer fires its one transition to
   `ready_to_test`.
7. The `ready_to_test` rule dispatches QA into the developer's worktree.
8. QA fires `verified` or `rejected`. A rejection notifies the project manager. A
   verification prunes the worktree and branch and notifies the human.

Two properties of this loop are worth naming.

**The project manager is a relay in steps 2 and 3.** Mesh has already decided;
the project manager merely holds the `Agent` tool. This costs a few hundred
tokens per dispatch and exists only because Mesh cannot spawn subagents itself.

**Backpressure is required.** Mesh caps concurrent dispatches at five and queues
the remainder at `ready`. Without the cap, a busy morning of dragging cards
drains the five-hour window. The cap is a fixed constant from M2, when dispatch
first exists; M5 makes it configurable and couples it to the quota governor.

### Failure and lifecycle

**Project manager restart.** The session identifier is persisted in
`config.json`; Mesh restarts with `--resume`. This is cheap because the board
lives on disk rather than in that agent's context.

**Crash reconciliation on boot.** A ticket in `in_progress` whose `task_id` no
longer exists is orphaned. Mesh does not redispatch it, because the worktree may
hold real uncommitted work. It moves the ticket to `blocked (orphaned)`, writes a
thread entry, and surfaces `git -C <worktree> diff --stat` on the card. The human
decides whether to resume or discard.

**Compaction.** The project manager will compact. Mesh re-primes it afterwards
with a short board summary of open tickets, states, and assignees.

**Permissions.** Anything outside the allowlist is denied and appears in
`result.permission_denials`, which Mesh renders on the card as an attempted and
denied action.

**Quota governor.** Mesh holds the dispatch queue whenever `rate_limit_event`
reports a status other than `allowed`, and displays the reset time.

**Stuck agents.** Each task has a wall-clock timeout. Killing is another project
manager relay, since it holds `TaskStop`. If that agent is itself wedged, Mesh
kills the process and reconciles on restart via the orphan path.

**Worktree hygiene.** Prune on `verified` or abandonment, and sweep orphans at
boot.

### Known seam

The project manager sits on the critical path for dispatch, kill, and re-prime.
Each of these is Mesh knowing what it wants and asking a language model to press
the button. If that friction becomes annoying, the remedy is separate developer
processes that Mesh spawns directly, which removes the relay. This is not a
first-version concern, but it is where the design would be reworked.

## Stack

Node 24 is already installed and strips TypeScript natively, so the server needs
no build step. The frontend is Vite and React; the board has drag interactions,
several live-streaming panes, and a merged feed.

Transport is Server-Sent Events plus REST rather than WebSocket. Traffic is
overwhelmingly server to client; the client sends a handful of actions as plain
POST requests. SSE reconnects on its own and is far less code.

MCP is served over HTTP from inside Mesh and handed to the project manager via
`--mcp-config`, which avoids a stdio bridge process.

```
supervisor.ts   spawn the PM process, stdin/stdout, resume, restart
stream.ts       NDJSON parsing, demultiplex on parent_tool_use_id
store.ts        every ticket file read and write, serialised
board.ts        state machine, legal edges, column rules
mcp.ts          board tools exposed to agents
api.ts          REST and SSE
web/            React frontend
```

## Build order

- **M1 — viewer.** Spawn the project manager, render its stream, type into it. No
  board. Proves the supervisor, the demultiplexer, and the UI shell, and is
  useful on its own.
- **M2 — board and dispatch.** Markdown store, state machine, drag fires a
  transition, Mesh injects the dispatch, `[T-001]` correlation, live developer
  pane. Mesh is pointed at itself here and dogfooding begins.
- **M3 — threads and worktrees.** Receipts from `task_notification`, thread
  append, worktree records, orphan reconciliation on boot.
- **M4 — QA.** The role, the two columns, the rejection loop.
- **M5 — governor.** Quota holds, the concurrency cap, cleanup sweeps.

M1 and M2 carry the risk. M3 onwards is mostly bookkeeping.

## Open questions

These are cheap to answer now and expensive to discover late.

1. Does the CLI accept an HTTP MCP transport via `--mcp-config`? Blocks the board
   tools. Verify in M1.
2. Does `PostCompact` fire in headless mode? Decides whether re-priming after
   compaction is automatic or manual. Verify in M1.
3. Does the stream emit a live, answerable permission request, or only
   after-the-fact `permission_denials`? Verify in M2.
4. What is the real concurrency ceiling above five subagents? Verify before M5.

## Rejected alternatives

**One process per agent, with a custom message bus.** Rejected because the human
only needs to talk to the project manager. Per-agent chat was the sole capability
that separate processes offered over native subagents; without that requirement,
the approach costs a supervisor, a stream multiplexer, restart logic, five cold
starts instead of one, and a bus that `SendMessage` already provides. It remains
the fallback if the project manager relay becomes intolerable.

**MongoDB for the board.** Rejected. A daemon, a connection string, and an
operational surface, for a few dozen tickets with one writer on one machine.
SQLite is the correct database if one is needed, and markdown is preferred for
now because it is directly indexable for semantic retrieval.

**Autonomous project manager judgement from day one.** Deferred rather than
rejected. The project manager process exists from M1, because it is the process
the human talks to and the only one that can spawn subagents. What is deferred is
its discretion: through M2 and M3 the human drives every dispatch by moving
cards, and the project manager acts largely as a relay. Triage, arbitration, and
rejection handling are introduced once it is clear what routing the human
actually performs by hand.
