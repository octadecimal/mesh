---
name: complete-work
description: Use when a Mesh development branch is finished and the user wants it committed, proposed as a pull request if needed, merged, cleaned up, and made available for hands-on testing.
---

# Complete Work

Close a finished Mesh branch with evidence. Run every step directly; there is no
wrapper script. Create one todo per numbered step and work in order. Stop on the
first unresolved failure, report it plainly, and never claim an action succeeded
without checking its result.

## 1. Prepare the branch and PR

Record the current root, branch, linked-worktree path, primary checkout, working
tree state, commits ahead of `origin/master`, and any matching PR:

```powershell
git rev-parse --show-toplevel
git branch --show-current
git worktree list --porcelain
git status --short
git log --oneline origin/master..HEAD
gh pr list --head <branch> --state open --json number,url,title,body,state,headRefName,baseRefName,mergeStateStatus,statusCheckRollup
```

The primary checkout is `C:\code\mesh`. Before any mutation, require an explicit
user request to complete the branch through commit, PR, merge, cleanup, and
restart. Skill selection alone does not grant that authority. Stop if the branch
is detached, is `master`, is rooted at the primary checkout, or is not a linked
worktree distinct from the primary checkout. Stop if an existing open PR does
not match the current branch.

If the working tree has intended finished changes, confirm that fresh
verification appropriate to their risk passed in the current work session.
Review the complete tracked diff and read every intended untracked file. Stage
only explicit intended paths, then inspect both `git diff --cached --name-status`
and the full `git diff --cached` before committing. Stop if the staged paths or
content differ from the reviewed intent. Commit with a Conventional Commit
message that follows `AGENTS.md`. Never sweep unrelated or unreviewed files into
the commit. If verification evidence is missing or the scope is ambiguous, stop
and resolve that before committing.

If no open PR exists:

1. Confirm the branch contains at least one commit ahead of `origin/master`.
2. Push it with `git push -u origin <branch>`.
3. Create the PR with `gh pr create --base master --head <branch>`. Use a
   Conventional Commit title. In the body, state the problem, the solution, and
   the exact verification performed.
4. Re-run `gh pr view` and require an open PR whose head is the current branch
   and whose base is `master`.

The user's explicit complete-work request authorizes the normal commit, push, PR
creation, squash merge, cleanup, and any restart required by Step 5. It does not
authorize including unrelated changes, bypassing failed checks, force-pushing,
or weakening branch protection.

## 2. Apply the pre-merge gate

Require all of the following:

- The working tree is clean (`git status --short`) after preparation.
- The PR is open and mergeable.
- No check is pending, queued, or in progress. Offer `gh pr checks --watch` and
  re-evaluate if CI is still running.
- No check concluded failure, error, or cancellation. On failure, ask the user to
  choose: diagnose and fix, explicitly merge anyway, or abort. Never infer a CI
  bypass from urgency or prior local verification.
- If the branch is behind `master`, run `gh pr update-branch`, wait for checks, and
  re-evaluate the complete gate.

Do not rerun Mesh's full verification suite here. This gate trusts the fresh
milestone verification already completed before invocation and verifies GitHub's
current merge evidence.

## 3. Merge

Use Mesh's standard merge method:

```powershell
gh pr merge --squash --delete-branch
```

Confirm the PR reports `MERGED` before cleanup.

## 4. Sync main and clean up

Run repository coordination commands from `C:\code\mesh`, never by switching the
linked worktree itself to `main`:

```powershell
git -C C:/code/mesh checkout main
git -C C:/code/mesh pull --ff-only
git -C C:/code/mesh worktree remove <worktree-path>
git -C C:/code/mesh worktree prune
git -C C:/code/mesh branch -D <branch>
```

Before removal, confirm the target paths from `git worktree list --porcelain` and
that the feature worktree is clean.

If this agent session is rooted inside the worktree being removed, Windows may
lock it. Failure to remove that exact worktree and its checked-out branch is an
expected self-rooted exception: continue, report both leftovers precisely, and
give the later cleanup commands. It is not permission to force-remove any other
path.

## 5. Restart Mesh from main when runtime behavior changed

Inspect the merged PR's file list before touching processes. Restart Mesh only
when at least one changed path can affect the built application, runtime
configuration, dependencies, persisted data, or operator-visible behavior.

Skip restart and health checks when every changed path is documentation or
development metadata under this allowlist:

- `.agents/**`, `.claude/**`, `.github/**`, `.superpowers/**`, `.vscode/**`
- `docs/**`, root `*.md` files
- `.editorconfig`, `.gitignore`, `.prettierignore`, `.prettierrc.json`

If any changed path falls outside that allowlist, perform the restart. Report a
skipped restart explicitly with the file-scope evidence; do not invent a UI URL
or health result.

All commands and processes in this step use `C:\code\mesh`, never the feature
worktree. Mesh uses the locally authenticated Claude Max subscription only.
`ANTHROPIC_API_KEY` or another API-billing override is a blocker: do not unset it
silently, start a pay-per-token fallback, or claim live Claude sessions are ready.

Inspect listeners before stopping anything:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3737,4200 -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "ProcessId = <pid>" |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine
```

Stop only processes whose command lines prove they are stale Mesh processes. If
port 3737 belongs to an unrelated or ambiguous process, stop the skill and report
the conflict. Never kill an unknown listener.

Prefer UI port 4200. If it belongs to an unrelated process, choose the first free
loopback port from 4201 upward and use that same origin for the backend. Then:

```powershell
Set-Location C:\code\mesh
corepack pnpm install --frozen-lockfile
corepack pnpm nx build server
$env:NODE_ENV = 'development'
$env:MESH_DEV_ORIGIN = "http://127.0.0.1:<ui-port>"
node -e 'require("./dist/apps/server/main.js").startServer().then((server) => console.log(server.origin)).catch((error) => { console.error(error); process.exit(1); })'
corepack pnpm exec vite --config apps/web/vite.config.ts --host=127.0.0.1 --port <ui-port>
```

Launch the server and Vite through the agent's persistent background/session
mechanism. Do not open extra visible terminals. Poll rather than sleeping blindly.
Verify both direct API and proxied API responses:

```powershell
Invoke-WebRequest http://127.0.0.1:3737/api/snapshot -Headers @{ Origin = 'http://127.0.0.1:<ui-port>' }
Invoke-WebRequest http://127.0.0.1:<ui-port>/api/snapshot
```

Both must return HTTP 200. Also confirm listener command lines point at the
primary checkout. Background processes may terminate when the agent session ends;
surface that lifecycle limitation.

## 6. Produce the manual walkthrough

Read the merged PR title, body, files, and diff:

```powershell
gh pr view <number> --json title,body,files,url
gh pr diff <number>
```

Give a concise walkthrough specific to that change. For a restart-skipped
documentation or metadata change, give a file/review walkthrough instead of UI
instructions. Otherwise include:

- Exact UI URL and affected session flow.
- Concrete clicks and inputs.
- Observable success criteria.
- Relevant caveats, including subscription authentication and server lifetime.

## Completion report

Report the merged PR, synced `main` commit, worktree/branch cleanup or exact
self-rooted leftovers, restart decision with file-scope evidence, and the
tailored walkthrough. Include stack process/health status and UI URL only when
Step 5 ran.

## Quick reference

| Condition                    | Action                                           |
| ---------------------------- | ------------------------------------------------ |
| Finished changes uncommitted | Verify, review, stage intended paths, and commit |
| No matching PR               | Push and create one against `master`             |
| CI pending                   | Watch, then re-evaluate the full gate            |
| CI failed                    | Ask: fix, explicit bypass, or abort              |
| PR behind                    | Update branch and re-check CI                    |
| Docs/metadata-only PR        | Skip restart; report file-scope evidence         |
| Unknown port owner           | Stop; do not kill it                             |
| API billing override present | Stop; subscription-only policy is not satisfied  |
| Self-rooted worktree lock    | Continue with exact leftovers documented         |

## Common mistakes

- Guessing `--merge` instead of using Mesh's required squash merge.
- Treating previous local tests as permission to skip current PR checks.
- Requiring or exposing an Anthropic API key.
- Starting Docker or an invented stack command instead of Mesh's Nx/Vite stack.
- Running the post-merge stack from a soon-to-be-removed worktree.
- Killing a listener based only on its port number.
- Reporting self-rooted cleanup as successful when the folder or branch remains.
