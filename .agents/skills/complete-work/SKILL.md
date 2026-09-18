---
name: complete-work
description: Use when approved Mesh implementation is ready for delivery through an open pull request and current passing CI, or when resuming CI repair or an explicitly approved post-test merge.
---

# Complete Work

Close a finished Mesh branch with evidence. Run every step directly; there is no
wrapper script. Work through PR preparation and CI repair until the current
revision is ready for hands-on testing. Report a concrete blocker when safe
progress is unavailable; never claim an action succeeded without checking it.

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

The primary checkout is `C:\code\mesh`. Under `AGENTS.md`, an implementation
request or approval authorizes normal verification, intended commits, push, PR
creation/update, and CI repair without another publishing prompt. Preserve explicit
plan-only, local-only, no-push, or no-PR limits; a mockup preference or visual
approval alone does not authorize implementation. Skill selection alone does not
authorize unrelated work, merge, cleanup, or restart. Stop if the branch
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

If a matching PR already exists, push the intended commits normally with
`git push origin <branch>` and update its description to match the final change.
In both cases, compare `git rev-parse HEAD` with the PR's `headRefOid`; require
equality before evaluating CI or handing off. A green remote PR that lacks the
local commit is not verification of the finished work.

The standing implementation-delivery authorization or an explicit complete-work
request covers normal commit, push, and PR creation. It does **not** authorize
merging, cleanup, or switching the test stack to `master`. Those actions require
a later approval given after the user reports completing hands-on testing of
this PR. Approval given before testing, urgency, a green local suite, or green CI
does not satisfy the post-test approval gate. It also does not authorize
including unrelated changes, bypassing failed checks, force-pushing, or
weakening branch protection.

## 2. Reach current passing CI

Require all of the following:

- The working tree is clean (`git status --short`) after preparation.
- The PR is open and mergeable.
- Expected checks from the workflow and repository requirements exist and pass
  for the current `headRefOid`, which equals local `HEAD`. Empty checks, stale
  successes, and skipped required jobs are not a pass.
- No check is pending, queued, or in progress. Run `gh pr checks --watch` and
  re-evaluate current-head evidence when CI finishes; do not hand off while waiting.
- No check concluded failure, error, or cancellation. Diagnose and repair ordinary
  failures within scope, run affected local checks, commit/push the repair, and
  observe the new head's checks. Delegate routine fixes to the implementation
  worker when the active harness supports it. Do not offer a bypass as the normal
  response, weaken checks, or treat prior local verification as CI evidence.
- If the branch is behind `master`, run `gh pr update-branch`, then fetch the task
  branch and fast-forward its clean worktree to `origin/<branch>`. If a safe
  fast-forward is unavailable, reconcile the divergence without discarding work.
  Verify the integrated revision, wait for its checks, and re-evaluate the gate.

Reuse fresh local verification when its contents and environment remain unchanged;
run the appropriate checks when evidence is missing or repairs invalidate it.
Missing credentials, external CI outages, or repairs beyond the approved scope
can require the maintainer. Report that exact blocker and completed evidence;
never label the branch ready while expected current-head checks have not passed.

## 3. Make the PR available for hands-on testing

After current-head CI passes, UI/runtime changes require a running test stack
and a clickable UI URL before handing off; do not ask whether to start it or
merely supply startup commands. Honor an explicit no-run instruction and report
that limitation. A blocked launch is not a ready-for-testing result: diagnose
ordinary startup failures and report the concrete blocker if safe progress ends.

Start or safely reuse Mesh from the feature worktree,
not `master`, using the safe listener inspection, subscription-only checks,
build, launch, and health-check procedure in Step 6, but substitute the verified
feature-worktree root for build and process working directories. Set
`MESH_WORKSPACE_ROOT` to the verified primary checkout root so the test server
can safely import the primary repository and any linked worktree beneath it.
Do not remove or switch the feature worktree while its test stack is running.
Reuse an existing stack only after verifying its worktree, current PR revision,
and UI plus API health. Do not restart an active operator stack to make room;
preserve live sessions and data. Use an isolated preview data directory when
startup could recover or mutate operator state, and disclose that isolated data
will not contain existing sessions. Do not start live Claude work for health checks.
For documentation-only changes, skip the runtime and provide a file/review
walkthrough.

Keep the verified stack running across the handoff using the available background
process mechanism; report any actual lifetime limitation. Verify the UI page and
both API paths in Step 6 immediately before reporting readiness.

Produce the tailored walkthrough from Step 7, including clickable UI and PR URLs
and exact success criteria. Then stop and wait. The required gate is two facts from the
user after testing this PR:

1. They completed the hands-on test.
2. They explicitly approve merging this PR.

Do not treat silence, a request to “complete work,” prior approval, CI success,
or the agent's own browser testing as either fact. Preserve the PR, branch, and
worktree while waiting.

## 4. Re-check and merge after post-test approval

After receiving both facts for the current revision, re-run Step 2 so the merge
decision uses current GitHub state. Repair or wait on outstanding checks before
merging. If changes invalidate the tested revision, obtain renewed hands-on
testing and explicit merge approval of the new revision.

Use Mesh's standard merge method:

```powershell
gh pr merge --squash --delete-branch
```

Confirm the PR reports `MERGED` before cleanup.

## 5. Sync main and clean up

Run repository coordination commands from `C:\code\mesh`, never by switching the
linked worktree itself to `master`:

```powershell
git -C C:/code/mesh checkout master
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

## 6. Restart Mesh from master when runtime behavior changed

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

Stop only processes whose command lines and observed state prove they are stale,
task-owned Mesh processes with no live work. Never infer staleness from a port or
another branch's path alone. If port 3737 belongs to an unrelated or ambiguous
process, stop the skill and report
the conflict. Never kill an unknown listener.

Prefer UI port 4200. If it belongs to an unrelated process, choose the first free
loopback port from 4201 upward and use that same origin for the backend. Then:

```powershell
Set-Location C:\code\mesh
corepack pnpm install --frozen-lockfile
corepack pnpm nx build server
$env:NODE_ENV = 'development'
$env:MESH_DEV_ORIGIN = "http://127.0.0.1:<ui-port>"
$env:MESH_WORKSPACE_ROOT = 'C:\code\mesh'
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

Both must return HTTP 200, and the UI root must load successfully. Also confirm
listener command lines point at the primary checkout (feature worktree in Step 3).
Background processes may terminate when the agent session ends;
surface that lifecycle limitation.

## 7. Produce the manual walkthrough

Read the current PR title, body, files, and diff:

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

Before post-test approval, report the open PR, current CI state, preserved branch
and worktree, test-stack status, and tailored walkthrough. After approval and
merge, report the merged PR, synced `master` commit, worktree/branch cleanup or
exact self-rooted leftovers, and the post-merge restart decision. Include stack
process/health status and UI URL only when the relevant runtime step ran.

## Quick reference

| Condition                    | Action                                           |
| ---------------------------- | ------------------------------------------------ |
| Finished changes uncommitted | Verify, review, stage intended paths, and commit |
| No matching PR               | Push and create one against `master`             |
| CI pending                   | Watch, then re-evaluate the full gate            |
| CI failed                    | Diagnose, repair, push, and watch current CI     |
| PR behind                    | Update branch and re-check CI                    |
| Human test not completed     | Preserve PR/worktree; provide walkthrough; wait  |
| Human tested, no approval    | Preserve PR/worktree; wait for explicit approval |
| Human tested and approved    | Re-check current gate, then squash merge          |
| Docs/metadata-only PR        | Skip restart; report file-scope evidence         |
| Unknown port owner           | Stop; do not kill it                             |
| API billing override present | Stop; subscription-only policy is not satisfied  |
| Self-rooted worktree lock    | Continue with exact leftovers documented         |

## Common mistakes

- Guessing `--merge` instead of using Mesh's required squash merge.
- Treating complete-work invocation, green CI, or pre-test approval as merge
  authority.
- Cleaning the branch or worktree before the human test and approval gate.
- Treating previous local tests as permission to skip current PR checks.
- Requiring or exposing an Anthropic API key.
- Starting Docker or an invented stack command instead of Mesh's Nx/Vite stack.
- Running the post-merge stack from a soon-to-be-removed worktree.
- Killing a listener based only on its port number.
- Reporting self-rooted cleanup as successful when the folder or branch remains.
