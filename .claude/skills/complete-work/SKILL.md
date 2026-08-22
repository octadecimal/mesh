---
name: complete-work
description: Use when a development branch is finished — opens or verifies its PR, gates on CI, squash-merges, cleans up the branch, returns to master, optionally brings up the live stack, and writes a change-specific manual test walkthrough. Invoke as /complete-work.
---

# /complete-work

The closing ritual for a finished branch. You (the model) run every step
directly with your own tools (`gh`, `git`, `npm`). There is no script.

`master` is protected by a repository ruleset: no direct pushes, a pull request
is required, the `ci` status check must pass, and **admins are not exempt**.
Everything below assumes that — there is no path that bypasses a red build.

**Create one todo per numbered step and work them in order. STOP on the first
failure with a plain report — never press on, never claim success you did not
verify.**

## 1. Identify the branch and its PR

```
git branch --show-current
gh pr view --json number,state,headRefName,mergeStateStatus,statusCheckRollup
```

- **On `master`?** STOP — there is nothing to complete. Work happens on branches.
- **PR exists?** Go to step 2.
- **No PR?** Open one, but check these first:
  - `git status --short` is clean. If not, STOP and report the dirty files —
    never commit on the user's behalf here.
  - Every commit in `git log --oneline master..HEAD` follows Conventional
    Commits, per `AGENTS.md`. If any do not, STOP and offer to rewrite them
    before pushing.

  Then push and open the PR:

  ```
  git push -u origin <branch>
  gh pr create --base master --title "<conventional commit subject>" --body "<what and why>"
  ```

  The title becomes the squash commit subject in step 3, so it must be a valid
  Conventional Commits subject, 72 characters or fewer.

## 2. Pre-merge gate

Evaluate in order:

- **PR still open?** If `state` is `MERGED` or `CLOSED`, STOP and report. The
  branch may already be done; offer to skip ahead to cleanup if the user
  confirms.
- **CI still running?** If any check in `statusCheckRollup` is `PENDING`,
  `IN_PROGRESS`, or `QUEUED`, do not merge. Offer to watch it:
  ```
  gh pr checks --watch
  ```
  When it settles, re-evaluate this gate.
- **CI failing?** Do not silently stop. Read the failure first:
  ```
  gh run view --log-failed
  ```
  Then ASK the user which they want:
  1. **Fix it now** — diagnose, fix, push, and re-run this gate.
  2. **Abort** — stop the skill.

  There is deliberately no "merge anyway" option. The ruleset enforces `ci` for
  admins too, so the merge would be refused; offering it would be a lie.
- **Branch BEHIND master?** If `mergeStateStatus` is `BEHIND`, update it and
  re-evaluate — do not stall:
  ```
  gh pr update-branch
  ```
- **Clean and mergeable?** Confirm `git status` is clean and `mergeStateStatus`
  is `CLEAN`, then proceed.

Do not re-run the test suite here. This gate trusts that the work was validated
before the PR was opened; it confirms the PR's own CI is green.

## 3. Merge

```
gh pr merge --squash --delete-branch
```

Squash-merges and deletes the remote branch. If the squash subject was not
already set from the PR title, supply one in Conventional Commits form.

## 4. Clean up locally

Mesh uses a single checkout — there are no worktrees to remove.

```
git checkout master
git pull
git branch -d <branch>
```

`git branch -d` refuses if the branch is not merged. Because the merge was a
squash, git may not recognise the branch as merged; verify the PR shows as
merged, then use `git branch -D <branch>`. Never reach for `-D` without that
confirmation.

If `git checkout master` fails because the working tree is dirty, STOP and
report — do not stash the user's changes.

## 5. Live stack — ASK FIRST

**Do not start the stack without asking.** `npm run dev` spawns a real `claude`
child process against the user's subscription, so it costs quota. Ask:

> Merged and cleaned up. Want me to bring up the live stack so you can try it?
> This spawns a real `claude` process and spends subscription quota.

If they decline, print the commands and move to step 6.

If they accept, check `claude` is on `PATH`, then run each in the background so
they survive the turn:

```
npm run dev        # server on 127.0.0.1:4317
npm run dev:web    # frontend on 127.0.0.1:5173
```

Poll until the API answers:

```
curl -s http://127.0.0.1:4317/api/health
```

Expect `{"ok":true}`. If it does not answer, report the failure with the
server's output rather than claiming the stack is up.

**Say plainly that these background processes terminate when the Claude session
ends**, so the user is not surprised later.

## 6. Change-specific walkthrough

Read what was just merged:

```
gh pr view <number> --json title,body,files
gh pr diff <number>
```

Write a walkthrough tailored to **this** change, not a generic tour:

- **URLs:** `http://127.0.0.1:5173`, plus the LAN URL `http://<this-machine-ip>:5173`
  — the user often browses from another machine, so never assume localhost on
  their end. Find the IP with `hostname -I`.
- **Where to look:** the pane or element this change affects.
- **What to do:** the concrete inputs or clicks that exercise it.
- **What "correct" looks like:** the observable behavior that confirms it works.
- **Caveats:** anything the change depends on that is not currently running.

If the user declined the live stack in step 5, still write the walkthrough —
prefixed with the commands they need to start it themselves.

## Done

Report a short summary: PR number merged, branch cleaned up, live stack status
and URLs (or that it was not started), and the walkthrough.
