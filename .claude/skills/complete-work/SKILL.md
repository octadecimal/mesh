---
name: complete-work
description: Use when a development branch is finished — opens or verifies its PR, gates on CI, brings up the live stack and writes a change-specific walkthrough so a human can try the change in a browser, waits for their sign-off, then squash-merges and cleans up the branch. Invoke as /complete-work.
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

  The title becomes the squash commit subject in step 6, so it must be a valid
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

## 3. Live stack — ASK FIRST

**Do not start the stack without asking.** `npm run dev` spawns a real `claude`
child process against the user's subscription, so it costs quota. Ask:

> CI is green and the PR is ready to merge. Want me to bring up the live stack so
> you can try the change in a browser first? This spawns a real `claude` process
> and spends subscription quota.

If they decline, print the commands and move to step 4.

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

## 4. Change-specific walkthrough

Read what is about to be merged:

```
gh pr view <number> --json title,body,files
gh pr diff <number>
```

Write a walkthrough tailored to **this** change, not a generic tour. The
user runs it by hand — it is the evidence for the sign-off in step 5, so
every claim in it must be something they can see for themselves:

- **URLs:** `http://127.0.0.1:5173`, plus the LAN URL `http://<this-machine-ip>:5173`
  — the user often browses from another machine, so never assume localhost on
  their end. Find the IP with `hostname -I`.
- **Where to look:** the pane or element this change affects.
- **What to do:** the concrete inputs or clicks that exercise it.
- **What "correct" looks like:** the observable behavior that confirms it works.
- **Caveats:** anything the change depends on that is not currently running.

If the user declined the live stack in step 3, still write the walkthrough —
prefixed with the commands they need to start it themselves.

## 5. Human sign-off — STOP AND WAIT

**Nothing merges until a human has tried it.** Post the walkthrough, then stop
the turn and wait for their verdict. Do not merge in the same turn that you
wrote the walkthrough, and do not treat silence, a thumbs-up on some earlier
step, or your own passing tests as sign-off. CI proves the code runs; this step
proves it does the thing the user actually wanted.

Ask plainly:

> Try it in the browser and tell me how it looks. I will merge once you confirm.

Then act on what comes back:

- **They confirm it works** — proceed to step 6.
- **They report a problem** — STOP the merge. Treat it as the real bug it is:
  diagnose, fix on this same branch, push, then re-run from step 2. The PR stays
  open throughout.
- **They decline to test** (declined the stack in step 3, or explicitly say to
  merge without trying it) — that is a valid answer and it is theirs to give.
  Say plainly that the change is going in unverified by a human, and proceed.

## 6. Merge

```
gh pr merge --squash --delete-branch
```

Squash-merges and deletes the remote branch. If the squash subject was not
already set from the PR title, supply one in Conventional Commits form.

## 7. Clean up locally

`gh pr merge --delete-branch` in step 6 deleted **both** the local and the
remote branch, and switched this checkout off the branch it deleted. So this
step mostly confirms that rather than repeating it. Mesh uses a single checkout
— there are no worktrees to remove.

Sync master and drop the stale remote ref:

```
git checkout master   # usually already here; gh switched for you
git pull
git fetch --prune
```

Then check whether the local branch actually went:

```
git branch --list <branch>
```

- **No output?** Cleanup is done — say so and move on. Do NOT run
  `git branch -d`; it fails with `branch '<branch>' not found`, and that error
  is noise, not a problem to report as a failure.
- **Still listed?** gh could not delete it — typically the working tree was
  dirty, or the merge was run from a different checkout. Delete it now:
  ```
  git branch -d <branch>
  ```
  `-d` refuses a branch git does not consider merged, which is the normal case
  after a **squash** merge, because the commit on master is a new object.
  Confirm the PR is merged first:
  ```
  gh pr view <number> --json state --jq .state
  ```
  Only once that prints `MERGED`, use `git branch -D <branch>`. Never reach for
  `-D` without that confirmation.

If `git checkout master` fails because the working tree is dirty, STOP and
report — do not stash the user's changes.

If the live stack from step 3 is still running, leave it running — the squash
commit carries the same code the user just verified, so nothing needs a restart.

## Done

Report a short summary: PR number merged, who verified it in the browser (or
that it went in unverified at the user's direction), branch cleanup status, and
whether the live stack is still up and on which URLs.
