## Worktree Policy

Every unit of work that becomes a pull request is done in its own git worktree.
No exceptions — docs-only and chore changes included. The main checkout at the
repository root stays on `master` and is never used for feature work.

Create the worktree from an up-to-date `master`:

```
git fetch origin master
git worktree add .claude/worktrees/<slug> -b <branch> origin/master
cd .claude/worktrees/<slug>
npm ci
```

`<slug>` is the branch name with `/` replaced by `-`, so `feat/pane-resize`
lives in `.claude/worktrees/feat-pane-resize`.

Agents running in Claude Code use the `EnterWorktree` tool instead. It creates
the same layout under `.claude/worktrees/` and switches the session into it.

Constraints that follow from this layout:

- `.claude/worktrees/` is gitignored. Never commit a worktree.
- `node_modules/` is not shared between worktrees. Run `npm ci` in a fresh one
  before `npm test`, `npx tsc --noEmit`, or `npm run build:web`.
- The dev server binds fixed ports — 4317 for the API, 5173 for the frontend —
  so only one worktree can run the live stack at a time. Stop one before
  starting another.
- Remove the worktree once its pull request is merged. `git worktree remove`
  runs from the main checkout, and it must happen before the local branch can
  be deleted, because git refuses to delete a branch that is checked out
  anywhere. `.claude/skills/complete-work/SKILL.md` covers the full sequence.

## Code Exploration Policy

Always use jCodeMunch-MCP for code navigation. Never fall back to Read, Grep, Glob, or Bash for code exploration.
**Exception:** use `Read` when you are about to edit a file — the harness requires a `Read` before `Edit`/`Write`. Use jCodeMunch to *find and understand* code, then `Read` only the file you are changing.

This server runs the **front door** surface: three tools reach every jCodeMunch capability, so the tool list stays small and the catalogue is fetched only when you need it.

**Start any session:**
1. `order { "action": "resolve_repo", "args": { "path": "." } }` — confirm the project is indexed. If it is not: `order { "action": "index_folder", "args": { "path": "." } }`

**Then, for any task:**
- Know what you want → `order { "action": "<name>", "args": { ... } }`
- Know the goal, not the tool → `route { "query": "your task in a sentence" }` picks the action and shapes the arguments
- Want to see what exists → `menu { "query": "what you are trying to do" }` returns matching actions with example arguments
- Want the whole catalogue and the usage rules → `jcodemunch_guide`

`menu` and `jcodemunch_guide` list every action this server can run, including ones absent from your tool list. That is expected: the front door is the way to call them.

**Interpreting results:**
- A `verdict` of `no_implementation_found` is evidence of absence. Report the gap; do not re-search with different wording.
- A `verdict` of `degraded` means a channel was unavailable, so absence is NOT proven. Read the note before relying on the result.
- `source: ""` alongside `source_status` means the body could not be read, not that the symbol is empty.

**After editing files:**
- With PostToolUse hooks installed (Claude Code), edited files are reindexed automatically.
- Otherwise `order { "action": "register_edit", "args": { "paths": [...] } }` after an edit, batched for bulk changes.

**Announce your model once per session** so the server can size its answers: `announce_model { "model": "<your-model-id>" }`.

## Testing Policy

`npm test` and `npm run test:e2e` replay recorded streams from
`tests/fixtures/streams/` and never spawn a real `claude` process. Both are
free to run at any time.

Two commands launch a real `claude` child and spend the user's subscription
quota. Never run either without explicit permission:

- `npm run dev` — the server owns a live project manager process
- `npm run test:e2e:real` — the opt-in browser test against the real CLI

`src/index.ts` honours `MESH_CLAUDE_BIN` and `MESH_CLAUDE_ARGS`, which point the
supervisor at a stub binary. That is how the end-to-end suite exercises the real
entry point for free; leave both unset in normal use.

## Commit Policy

Every commit in this repository uses the Conventional Commits format:

```
<type>(<optional scope>): <description>
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`.

Rules:

- Description is imperative mood, lower case, no trailing period.
- Breaking changes append `!` after the type or scope, and explain the break in
  the commit body.
- Keep the subject line at 72 characters or fewer; put detail in the body.
- Never sign a commit as an agent. Do not add `Co-Authored-By` trailers naming
  Claude, Claude Code, Codex, Copilot, or any other assistant, and do not add
  "Generated with ..." footers. The commit author is the human running the tool,
  and the message body carries no tool attribution.

If history is created that does not follow this format, rewrite it before
pushing.
