# Mesh V2 Manual Parallel Development Runbook

**Status:** Work in progress for maintainer use

**Date:** 2026-08-27

**Audience:** The operator coordinating multiple coding-agent sessions manually
or through Codex task orchestration before Mesh V2 can perform this coordination
itself.

## Purpose

This runbook is a copy-paste operating procedure for developing Mesh V2 with
multiple independent sessions and harnesses. It turns the architecture's future
workflow into a safe manual process:

1. one coordinator designs and decomposes a milestone;
2. independent workers implement dependency-ready task packets in parallel;
3. reviewers assess exact commits against frozen task contracts;
4. workers address structured rework;
5. an integrator combines accepted commits and runs the wave gate;
6. the operator explicitly authorizes pull requests and merges.

The canonical architecture is
[Mesh V2 Architecture](../specs/2026-08-27-mesh-v2-architecture-design.md).
This runbook does not replace it.

## Choose an Operating Mode

This runbook supports two modes with the same task contracts and safety gates:

- **Codex overnight mode:** one visible Codex task receives upfront authority
  for an approved wave and creates and manages other visible Codex tasks for
  workers, reviewers, rework, and local integration without interactive gates.
- **Manual harness-agnostic mode:** the operator creates each Codex, Claude Code,
  or other harness session and routes the generated prompts and handoffs.

Use Codex overnight mode when every top-level session can run as a Codex task,
the coordinator has task-management tools, and the milestone design and plan
are already approved and merged. Use manual mode for planning, mixed harnesses,
or whenever task tools are unavailable. Overnight mode must stop cleanly rather
than replacing visible tasks with opaque internal subagents.

## Operating Rules

Follow these rules for every milestone and wave:

- Plan one milestone in detail at a time. Do not generate implementation plans
  for all future milestones up front.
- Parallelize dependency-ready tasks, not ambiguous outcomes. If two tasks need
  an unsettled interface, settle and land that interface first.
- Use a separate top-level session and worktree for every worker, reviewer that
  needs to run code, and integration unit.
- Start every wave from one frozen commit that was the current
  `origin/master` when the wave was authorized.
- Do not let a worker silently rebase, merge, broaden scope, or edit another
  worker's owned surfaces.
- Workers never edit the milestone design, implementation plan, or execution
  manifest. The coordinator owns planning state.
- Workers do not create pull requests, push branches, merge, or delete
  worktrees unless the operator explicitly authorizes that action.
- Use fake harnesses, temporary repositories, and temporary databases in normal
  tests. Never invoke real subscription-backed agent traffic as an incidental
  test.
- Preserve dirty, ambiguous, or unowned work. Stop and report uncertainty
  instead of cleaning it up.
- A worker's success report is not acceptance. Review, evidence, integration,
  and the relevant test gate determine acceptance.
- Do not launch `dispatching-parallel-agents` inside worker sessions. The
  operator in manual mode, or the explicitly authorized Codex orchestrator in
  automated mode, is the top-level dispatcher until Mesh owns that
  responsibility.

## Which Skills to Use Manually

Before Mesh V2 exists, some infrastructure skills are appropriate because the
operator and sessions must perform that work themselves.

| Session | Preferred skills |
| --- | --- |
| Coordinator | `brainstorming`, then `writing-plans` |
| Worker | `using-git-worktrees`, `test-driven-development`, `verification-before-completion` |
| Reviewer | the harness's code-review workflow and focused verification |
| Rework worker | `receiving-code-review`, then `verification-before-completion` |
| Integrator | `using-git-worktrees`, `verification-before-completion`, then `finishing-a-development-branch` when authorized |

Use skills as bounded execution guidance. The milestone design, task packet,
repository rules, and operator authorization remain authoritative. A skill must
not expand a session's assignment. If a named native skill is unavailable, the
session must report that fact rather than pretend to invoke it. It follows the
equivalent explicit runbook contract unless the frozen execution packet marks
the skill as required, in which case it stops before work begins.

## Codex Automated Overnight Mode

### What it automates

The Codex orchestrator may, without further interactive approval:

- create and title visible Codex tasks for approved worker, reviewer, and
  integrator assignments;
- send frozen task packets and structured rework to those tasks;
- wait for task progress and read task handoffs;
- maintain the task-to-session status map;
- apply the runbook's deterministic review, rework, and local integration
  routing;
- queue work when the authorized wave exceeds available concurrency.

The overnight authorization is intentionally broad for local, reversible work
inside the frozen milestone plan. It does not authorize changing frozen scope,
creating or merging pull requests, pushing branches, deleting worktrees,
resolving semantic conflicts, enabling paid API billing, handling credentials,
or substituting another harness. These are hard stops rather than interactive
approval prompts.

### Start the orchestrator

Prerequisites:

1. The architecture, this runbook, approved milestone design, and approved
   implementation plan are available on `origin/master`.
2. The implementation plan defines at least one dependency-ready parallel wave.
3. You are using a Codex environment with visible task-management capabilities.

Start one new Codex task in the Mesh repository. Name it, for example,
`M1 Codex Orchestrator`. Paste the following prompt, replacing only the
milestone number and title:

```text
You are the unattended Codex task orchestrator for Mesh V2 Milestone
{{MILESTONE_NUMBER}}: {{MILESTONE_TITLE}}.

I explicitly authorize you to run one dependency-ready milestone wave
unattended. Use the available Codex task-management tools to create, title,
inspect, wait on, and message visible Codex tasks for workers, reviewers,
rework, and local integration. In the Codex UI these may be called tasks; tool
names may call them threads.

Do not pause for ordinary implementation choices, task creation, review routing,
rework, or local integration within the approved plan. Make the smallest
reversible choice consistent with the frozen requirements and record every
assumption in the final report.

This authorization covers local task orchestration, code and documentation
edits within assigned surfaces, tests using fake or temporary resources, local
commits, review, rework, and a local integration branch. It does not authorize
pull request creation, pushing, merging, destructive cleanup, paid API billing,
credential access or modification, scope expansion, or other external side
effects.

Canonical inputs:
- AGENTS.md
- docs/superpowers/specs/2026-08-27-mesh-v2-architecture-design.md
- docs/superpowers/runbooks/2026-08-27-mesh-v2-manual-parallel-development.md
- the approved milestone design and implementation plan named by their current
  paths in the architecture roadmap or repository documentation

Operating model:
1. You are the coordinator for this overnight wave. Do not implement product
   code or review your own integration.
2. Use visible, independently manageable Codex tasks for every top-level worker,
   reviewer, and integrator. Do not substitute internal subagents for those
   roles. A task may use a bounded native subagent only when its frozen packet
   explicitly permits that assistance; the parent retains all ownership.
3. Discover the available task-management capabilities before scheduling. Look
   for semantic equivalents of create task, title task, inspect/read task, wait
   for tasks, and send a message to a task. Current tool names may include
   create_thread, set_thread_title, read_thread, wait_threads, and
   send_message_to_thread. Do not create a test task merely to probe support.
4. If visible task creation or monitoring is unavailable, stop and tell me to
   continue with the runbook's manual mode. Do not pretend a task was created.
5. Treat each created task as user-owned and visible. Track its milestone, wave,
   task ID, Codex task ID, branch, base commit, latest commit, lifecycle,
   review verdict, and attention state.
6. Respect both the execution packet's concurrency limit and the environment's
   available capacity. Queue excess ready tasks rather than exceeding either.
7. Use bounded waits for active tasks and avoid busy polling. Surface only
   meaningful progress, completion, failure, or requests for attention.
8. If I send a new instruction while tasks are running, determine whether it
   changes scope or adds information. Do not silently invalidate frozen work.

Preflight:
1. Read all canonical inputs and inspect the relevant repository architecture
   and recent history using repository-prescribed navigation tools.
2. Fetch `origin/master` and verify that it contains the architecture, this
   runbook, the approved milestone design, and the approved implementation plan.
   If design or plan approval cannot be established from durable repository
   state, stop before creating tasks and tell me to complete Phases 1 and 2
   manually.
3. Identify the first dependency-ready wave that is not already implemented.
   Validate its task contracts, file and interface ownership, acceptance
   criteria, verification commands, integration order, and concurrency limit.
4. Freeze the current `origin/master` commit and generate the Manual Execution
   Packet internally. Do not ask me to approve it; the merged plan and this
   prompt are the authorization.
5. If the wave has no safe parallel work, run its single ready task through the
   same worker, review, rework, and integration process rather than inventing
   parallelism.

Wave orchestration:
1. Create one visible Codex task per dependency-ready worker assignment, up to
   the allowed concurrency. Use the completely filled worker prompt contract in
   Phase 3 of the runbook. Give every task its exact base commit, owned and
   prohibited surfaces, acceptance criteria, verification, and handoff schema.
2. Title tasks with milestone, wave, task ID, and role. Record every returned
   task identifier before creating more work.
3. Do not create later-wave tasks. Do not give two workers overlapping ownership
   unless the approved plan explicitly serializes their changes.
4. Wait for worker progress. For an ordinary reversible implementation choice,
   choose the smallest option consistent with the frozen plan, send it to the
   worker, and record the assumption. If a decision would change scope,
   authority, a shared contract, or a safety invariant, mark only the affected
   task blocked and continue unrelated tasks.
5. When a worker returns a TASK HANDOFF, verify that it identifies the frozen
   base, branch, exact commit, changed surfaces, acceptance evidence, test
   results, and unverified items. A handoff is not acceptance.
6. For every review-ready worker commit, create a separate visible reviewer task
   using the filled Phase 5 reviewer prompt. The reviewer must inspect the exact
   commit in an isolated checkout and must not edit it.
7. If review returns rework, send the structured findings to the original worker
   task using the Phase 6 prompt. Reuse that task and worktree when trustworthy.
   Create a replacement worker task only when the original cannot continue, and
   preserve the same task identity, frozen scope, and history.
8. Send every rework commit through a new reviewer task. Do not let a reviewer
   fix its own findings.
9. After every task is accepted, revalidate the frozen base and task set. Create
   one visible integrator task using the filled Phase 7 prompt. The integrator
   combines only the reviewed commits in deterministic order and returns an
   INTEGRATION HANDOFF.
10. Inspect the integration handoff and supporting repository evidence. If the
    integration gate passes, preserve the local integration branch and stop
    before push or pull-request creation.
11. Do not start a dependent later wave from the unmerged integration branch.
    One overnight authorization covers one frozen wave. A later wave begins only
    after this wave is reviewed by me and merged to `origin/master`.

Failure and fallback rules:
- If a Codex task tool is missing or fails, preserve known task IDs and state,
  record the failure, continue work that does not need that capability, and give
  me the exact manual prompt needed to resume.
- If a task is interrupted, inspect its durable messages and repository state
  before resuming or replacing it.
- If origin/master differs from the frozen base before integration, mark
  integration blocked; do not silently rebase. Continue gathering evidence from
  already-running tasks where safe.
- If tasks overlap unexpectedly or require a shared interface change, pause the
  affected tasks and return to planning.
- If a task reports success without its required structured handoff and
  evidence, request the missing report; do not mark it accepted.
- Never delete a task, branch, process, or worktree whose ownership or state is
  ambiguous.
- You cannot create or control Claude Code or other non-Codex sessions. Do not
  assign external-harness work during an unattended Codex-only wave.

Hard-stop conditions for an affected task or integration:
- ambiguous user-owned or dirty work;
- a required change outside assigned surfaces or approved scope;
- a schema, protocol, lifecycle, permission, billing, credential, or workspace
  safety decision not settled by the frozen plan;
- missing required skill or harness capability;
- semantic merge conflict or base drift;
- verification that would invoke real external-agent traffic or another paid
  API;
- destructive cleanup or any external write.

When a hard stop affects one task, block that task and continue independent
tasks. When it invalidates the frozen base, shared contract, or whole wave, stop
creating new tasks, allow safe read-only verification to finish, and preserve
all state for morning review.

Communication:
- Keep a concise durable orchestration ledger mapping task IDs to Codex tasks,
  branches, commits, reviews, rework, and integration state.
- Do not wake or interrupt me for ordinary status. Continue until the wave is
  locally integrated or no safe progress remains.
- At completion, return a MORNING HANDOFF containing the frozen base, every task
  and Codex task ID, commits, review verdicts, rework history, integration branch
  and head, verification commands and results, assumptions, blocked items,
  unverified risks, and the exact next operator action.
- Do not claim the wave complete merely because tasks exited. Completion
  requires the integration handoff and wave-level evidence.

Begin now with capability discovery and preflight. If preflight passes, run the
first dependency-ready wave unattended through local integration. Do not create
a pull request or merge.
```

### What you still do as the operator

Before starting the overnight task, you still:

- complete and merge the milestone design and implementation plan;
- ensure the next wave is acceptable for unattended local execution;
- leave the repository and relevant worktrees in an unambiguous state.

In the morning, you review the `MORNING HANDOFF`, resolve blocked decisions,
perform hands-on testing when appropriate, and explicitly authorize any push,
pull request, merge, or cleanup. You may open any created task in the sidebar,
but routine coordination should flow through the orchestrator so its ledger
remains coherent.

### Overnight-mode fallback

If preflight finds that visible task tools, the approved plan, or a safe frozen
wave are unavailable, overnight execution does not begin. Continue at Phase 1
below or use the recorded manual prompts. If automation fails after tasks have
started, do not recreate them blindly. Give the orchestrator's task ledger to a
manual coordinator and follow the recovery procedures in this document.

## Session Roles

### Operator

You are the operator. In manual mode you create sessions, paste prompts, and
route worker reports. In overnight mode the Codex orchestrator performs those
mechanical steps for one preauthorized wave. You approve and merge the design
and plan before launch, then review the morning evidence before authorizing any
external write, pull request, merge, or cleanup.

### Coordinator

The coordinator is the PM and scheduler, operated through a human-driven session
or a Codex orchestrator. It owns the milestone design, implementation plan,
dependency graph, task contracts, wave authorization, prompt generation, and
disposition of reports. It does not implement product code.

Keep one coordinator session alive for the entire milestone. If it is lost,
start a replacement from the approved design, plan, frozen base commit, and the
latest operator status table.

### Worker

A worker owns exactly one task packet. It implements and verifies that task in
an isolated worktree, commits the result, and returns a structured handoff. It
does not integrate its work or make cross-task product decisions.

### Reviewer

A reviewer inspects one exact worker commit or a small, explicitly listed commit
set. It compares the implementation with the frozen task packet and reports
findings. It does not silently fix the implementation.

### Integrator

The integrator combines only reviewed commits in the coordinator's declared
order. It handles mechanical integration within scope, stops on semantic
conflicts, and runs the wave-level gate. It does not approve its own result or
create a pull request without operator authorization.

## Naming Sessions

Use names that make ownership obvious:

```text
M1 Coordinator
M1-W1-T01 Contracts Worker
M1-W1-T02 Persistence Worker
M1-W1-T01 Reviewer
M1 Wave 1 Integrator
```

`M1` is the milestone, `W1` is the wave, and `T01` is the task. Use the IDs from
the coordinator's execution packet rather than inventing new ones.

## Phase 0: Land the Shared Documentation

Do not launch implementation workers until the architecture, milestone design,
and implementation plan they must follow are available from `origin/master`.

For the initial V2 effort, first review the architecture and this runbook. When
you want the documentation branch prepared as a pull request, return to the
documentation session and paste:

```text
I have reviewed the Mesh V2 architecture and manual parallel-development
runbook. Prepare this documentation branch as a pull request for review. Follow
the repository's completion workflow, do not merge it, and report the exact
verification performed.
```

Review that pull request. When you explicitly approve it, follow the
repository's post-review merge procedure. Begin milestone planning only after
the resulting commit is present on `origin/master`.

## Phase 1: Start the Milestone Coordinator

Create one new session in the Mesh repository. Name it using the milestone,
such as `M1 Coordinator`. Paste the following prompt, replacing only the
milestone number and title:

```text
You are the coordinator for Mesh V2 Milestone {{MILESTONE_NUMBER}}:
{{MILESTONE_TITLE}}.

Your role is planning and coordination only. Do not implement product code.

First:
1. Read and follow AGENTS.md.
2. Read docs/superpowers/specs/2026-08-27-mesh-v2-architecture-design.md.
3. Read docs/superpowers/runbooks/2026-08-27-mesh-v2-manual-parallel-development.md.
4. Inspect the current repository architecture and relevant recent history using
   the repository-prescribed navigation tools.
5. Use the Superpowers brainstorming workflow. Treat this milestone as an
   architectural subproject and ask me one consequential question at a time.

Produce a milestone design that defines:
- the outcome and explicit stop condition;
- in-scope and deferred behavior;
- domain and persistence boundaries;
- contracts and interfaces other tasks will consume;
- failure, recovery, and reverse states;
- test strategy and acceptance evidence;
- V1 mechanisms to reuse and V1 concepts not to carry forward;
- the smallest coherent vertical slice.

Present the design in reviewable sections and wait for my approval as required
by the brainstorming workflow. Do not write an implementation plan or touch
implementation files until the written milestone design is approved.
```

### What you do next

The coordinator will ask questions and present design sections. Answer the
questions. Challenge assumptions that introduce a generic framework or work not
required by the milestone stop condition.

When the in-chat design is acceptable, paste:

```text
I approve this milestone design. Write it to the repository's standard
Superpowers specification location, self-review it for placeholders,
contradictions, ambiguity, and excess scope, commit only the design document in
the required isolated worktree, and ask me to review the written specification.
Do not begin implementation planning yet.
```

Open and review the committed specification. If corrections are needed, request
them in the coordinator session. When the written specification is acceptable,
paste:

```text
I approve the written milestone specification. Use the Superpowers
writing-plans workflow to create the detailed implementation plan. The plan must
be dependency-aware and organized into execution waves. It must identify exact
task outcomes, owned and prohibited surfaces, interfaces, acceptance criteria,
verification commands, and handoff evidence. Mark which tasks are safe to run
in parallel and explain every ordering constraint. Do not implement the plan.
```

Review the implementation plan with special attention to file overlap and
unsettled interfaces. A task is not parallel-ready merely because its title
sounds independent.

## Phase 2: Land the Milestone Design and Plan

The design and plan must be shared, immutable inputs before workers start. Ask
the coordinator to prepare its documentation branch for a pull request only
after both documents are reviewed:

```text
I have reviewed and approved the milestone design and implementation plan.
Prepare the documentation branch as a pull request. Do not merge it. Verify that
only the approved planning documents are included and report all checks.
```

Review and merge the planning pull request through the repository's normal
process. Do not continue until your local `origin/master` contains it.

Then return to the coordinator session and paste:

```text
The approved milestone design and implementation plan are now merged to
origin/master. Fetch current origin/master and record its exact commit as the
frozen base for the first dependency-ready wave.

Generate a Manual Execution Packet for Wave 1. Do not start or simulate workers.
The packet must contain:
1. the frozen base commit;
2. the wave ID and ordered task IDs;
3. why every task in the wave is dependency-ready;
4. an overlap audit for owned files and interfaces;
5. one completely filled, copy-paste worker prompt per task;
6. the required worker handoff schema;
7. one copy-paste reviewer prompt per task;
8. the deterministic integration order;
9. wave-level verification and stop conditions;
10. conditions that require returning to the coordinator instead of proceeding.

Use separate durable sessions as the top-level workers. Worker prompts must not
delegate top-level ownership to native subagents. Do not leave placeholders for
me to fill in.
```

The coordinator's response is the executable packet. Save it in your task notes
or leave the coordinator session open. Do not edit worker prompts unless you
also ask the coordinator to update the frozen packet.

## Phase 3: Launch a Parallel Worker Wave

For each task in the authorized wave:

1. Start a separate new session in the Mesh repository.
2. Name it with the milestone, wave, task ID, and short role.
3. Paste the corresponding filled worker prompt from the execution packet.
4. Let the session work independently.

Start all tasks in the same wave without waiting for earlier tasks in that wave
to finish. Do not start tasks from later waves.

The coordinator-generated prompts should follow this contract. This template is
included for auditing; use the filled prompts from the coordinator rather than
manually filling it:

```text
You are Worker {{TASK_ID}} for Mesh V2 {{MILESTONE_ID}}, Wave {{WAVE_ID}}.

Assignment:
{{EXACT_TASK_OUTCOME}}

Frozen inputs:
- Base commit: {{BASE_COMMIT}}
- Architecture: {{ARCHITECTURE_PATH}}
- Milestone design: {{MILESTONE_SPEC_PATH}}
- Implementation plan task: {{PLAN_PATH_AND_TASK}}
- Required requirement or contract revisions: {{FROZEN_REVISIONS}}

Owned surfaces:
{{OWNED_SURFACES}}

Prohibited surfaces:
{{PROHIBITED_SURFACES}}

Acceptance criteria:
{{ACCEPTANCE_CRITERIA}}

Required verification:
{{VERIFICATION_COMMANDS}}

Instructions:
1. Read and follow AGENTS.md and every frozen input above before editing.
2. The design is already approved. Do not reopen product or architecture scope.
   If frozen inputs conflict or are ambiguous, stop and report the conflict.
3. Use the harness-native worktree capability when available. Otherwise use the
   repository's using-git-worktrees procedure. Detect existing isolation first;
   never create a nested worktree. Confirm that your starting HEAD is exactly
   {{BASE_COMMIT}} before editing.
4. Use test-driven-development for implementation behavior and
   verification-before-completion before reporting success. These skills guide
   technique but do not expand this assignment.
5. Change only the owned surfaces. If correct implementation requires a
   prohibited or unassigned surface, stop and request a coordinator decision.
6. Preserve all unrelated and ambiguous user work. Never reset, delete, clean,
   rebase, merge, or force-update shared state.
7. Do not launch additional top-level sessions or use
   dispatching-parallel-agents. Use native subagents only when this packet
   explicitly authorizes bounded internal assistance; they inherit your scope
   and authority.
8. Use fake drivers, temporary repositories, and temporary databases. Do not
   invoke real subscription-backed agent traffic as a test.
9. Run the listed focused checks and any additional checks directly required by
   your changes.
10. Commit the completed task using the repository's Conventional Commit rules.
    Do not push, create a pull request, merge, or remove the worktree.

Return exactly this handoff structure:

TASK HANDOFF
Task: {{TASK_ID}}
Status: ready_for_review | blocked
Branch: <branch>
Commit: <full commit SHA or none>
Base: {{BASE_COMMIT}}
Outcome: <concise result>
Changed surfaces:
- <path and purpose>
Acceptance evidence:
- <criterion and evidence>
Verification:
- <command>: <exit status and concise result>
Unverified:
- <anything not verified, or none>
Risks or decisions:
- <item, or none>
Review focus:
- <highest-risk areas>
```

## Phase 4: Collect Worker Handoffs

Do not infer completion from a quiet or closed session. Wait for every worker in
the wave to return a `TASK HANDOFF`.

Maintain a small operator status table outside worker branches:

```text
| Task | Session | Branch | Commit | Worker status | Review | Integrated |
|------|---------|--------|--------|---------------|--------|------------|
| T01  |         |        |        |               |        |            |
```

When every running worker has reported or a worker needs help, return to the
coordinator and paste:

```text
Here are the current Wave {{WAVE_ID}} worker handoffs. Treat them as reports,
not proof. Compare them with the frozen execution packet and classify each task
as blocked, incomplete, ready for review, or requiring a coordinator decision.
Do not integrate anything.

{{PASTE_ALL_TASK_HANDOFFS_HERE}}

For every task ready for review, return its already-filled reviewer prompt,
updated with the exact commit SHA. For every other task, give me one copy-paste
message to send to the appropriate existing worker session. Flag any changed
dependency or overlap that invalidates the rest of the wave.
```

If a worker reports a contradiction in the plan, do not ask that worker to make
the product decision. Route it to the coordinator. If the answer changes a
frozen contract used by multiple workers, pause affected tasks and reissue the
wave rather than letting implementations diverge.

## Phase 5: Review Each Task

For each task marked ready for review:

1. Start a new reviewer session.
2. Name it with the task ID and `Reviewer`.
3. Paste the filled reviewer prompt returned by the coordinator.

The coordinator-generated reviewer prompt should follow this contract:

```text
You are the read-only reviewer for Mesh V2 task {{TASK_ID}}.

Review target:
- Base commit: {{BASE_COMMIT}}
- Worker commit: {{WORKER_COMMIT}}
- Task contract: {{PLAN_PATH_AND_TASK}}
- Architecture: {{ARCHITECTURE_PATH}}
- Milestone design: {{MILESTONE_SPEC_PATH}}

Instructions:
1. Read and follow AGENTS.md.
2. Use the harness-native worktree capability when available, or the
   repository's worktree procedure otherwise, to establish an isolated review
   checkout at {{WORKER_COMMIT}}. Detect existing isolation first. Verify the
   checkout's HEAD before running code; if the exact commit is unavailable,
   stop and report that instead of reviewing another state.
3. Inspect the exact diff from {{BASE_COMMIT}} to {{WORKER_COMMIT}} and the
   relevant surrounding code. Do not trust the worker handoff as proof.
4. Review correctness, task-contract compliance, regression risk, boundary
   violations, workspace safety, lifecycle and persistence effects, reverse
   states, and test adequacy.
5. Run the narrowest checks needed to validate material claims. Do not invoke
   real external agent traffic.
6. Do not edit files, commit, push, create a pull request, or integrate work.
7. Report only actionable findings. If there are none, say so explicitly and
   identify any residual verification gap.

Return exactly:

REVIEW HANDOFF
Task: {{TASK_ID}}
Commit: {{WORKER_COMMIT}}
Verdict: accept | rework | blocked
Findings:
- [severity] <path:line> <problem, impact, and required correction>
Contract coverage:
- <criterion>: satisfied | unsatisfied | unverified — <evidence>
Verification:
- <command>: <exit status and concise result>
Residual risks:
- <risk, or none>
```

## Phase 6: Route Rework

If review returns `rework`, go back to the original worker session whenever
possible. Paste:

```text
Continue task {{TASK_ID}} on the same branch and worktree. Use the
receiving-code-review workflow: verify each finding technically before editing,
ask only if a finding is ambiguous or conflicts with the frozen task contract,
and do not broaden scope.

Reviewer handoff:
{{PASTE_REVIEW_HANDOFF_HERE}}

Address accepted findings with focused regression proof, rerun the task's full
verification, commit the rework as a new Conventional Commit, and return a new
TASK HANDOFF including both the original and latest commit SHAs. Do not push,
create a pull request, merge, or remove the worktree.
```

Send the resulting commit set through a new review pass. Do not ask the reviewer
to fix its own findings.

If the original worker session is unavailable, ask the coordinator for a
replacement-worker prompt containing the original task packet, all known
commits, and the review handoff. A replacement is part of the same task; it does
not create a new scope.

## Phase 7: Authorize Integration

When every task in the wave has an `accept` review verdict, paste all final
worker and review handoffs into the coordinator session:

```text
All Wave {{WAVE_ID}} tasks have completed review. Validate the handoffs against
the frozen execution packet. If and only if every task is accepted and the
frozen base remains valid, generate one completely filled integration prompt.

The prompt must include the exact frozen base, accepted commit SHAs,
deterministic integration order, expected surfaces, conflict policy, wave-level
verification commands, and stop condition. Do not integrate the commits or
authorize a pull request yourself.

{{PASTE_FINAL_TASK_AND_REVIEW_HANDOFFS_HERE}}
```

Start a new session named for the milestone and wave integrator. Paste the
filled integration prompt. It should follow this contract:

```text
You are the integrator for Mesh V2 {{MILESTONE_ID}}, Wave {{WAVE_ID}}.

Frozen base: {{BASE_COMMIT}}
Accepted commits in integration order:
{{ORDERED_COMMITS}}

Expected combined surfaces:
{{EXPECTED_SURFACES}}

Wave verification:
{{WAVE_VERIFICATION_COMMANDS}}

Wave stop condition:
{{WAVE_STOP_CONDITION}}

Instructions:
1. Read and follow AGENTS.md, the architecture, milestone design, implementation
   plan, and accepted review handoffs.
2. Use an isolated worktree. Confirm that the fetched origin/master is exactly
   {{BASE_COMMIT}}. If it differs, stop and report base drift; do not silently
   rebase or reinterpret prior review.
3. Integrate only the listed commits in the listed order.
4. Resolve purely mechanical conflicts only when the accepted behavior is
   unambiguous. Stop on semantic, contract, migration, or ownership conflicts.
5. Verify the combined diff contains no unreviewed or unexpected surfaces.
6. Run every wave-level verification command. Use fake or temporary runtime
   resources and never invoke real external agent traffic by default.
7. If a focused integration correction is required and clearly within the
   accepted contracts, implement it with regression proof and commit it
   separately. Otherwise stop and request coordinator rework.
8. Do not push, create a pull request, merge, or remove any worker worktree.

Return exactly:

INTEGRATION HANDOFF
Milestone: {{MILESTONE_ID}}
Wave: {{WAVE_ID}}
Status: ready_for_operator | blocked
Branch: <branch>
Head: <full commit SHA>
Integrated commits:
- <SHA in order>
Integration-only changes:
- <SHA and purpose, or none>
Verification:
- <command>: <exit status and concise result>
Stop condition: satisfied | unsatisfied — <evidence>
Unexpected surfaces: <none or list>
Risks and unverified items:
- <item, or none>
```

## Phase 8: Prepare, Test, and Merge the Wave

Review the integration handoff. If it is blocked, return it to the coordinator.
If it is ready and you want a pull request prepared for hands-on testing, paste
this into the integration session:

```text
I have reviewed the integration handoff and explicitly authorize preparing a
pull request for this wave. Use the repository's complete-work workflow. Re-run
the required verification, inspect the final diff and commit history, push only
the integration branch, create the pull request, and give me exact hands-on test
instructions. Do not merge the pull request.
```

Perform the requested hands-on testing. If testing finds a problem, report it in
the integration session and route the resulting fix through review again.

Only after hands-on testing succeeds, explicitly authorize the merge in the
integration session:

```text
I completed the requested hands-on testing and it passed. I explicitly approve
merging this pull request now. Follow the repository's completion workflow,
verify the server-authoritative pull-request state and required checks, merge
without assistant attribution, and report the resulting master commit. Inspect
all owned worktrees before proposing any cleanup; do not delete ambiguous work.
```

After the merge, fetch `origin/master`. That merge commit becomes the candidate
base for the next wave. Do not start the next wave until the coordinator checks
the milestone dependency graph and explicitly authorizes it.

## Phase 9: Start the Next Wave

Return to the coordinator and paste:

```text
Wave {{COMPLETED_WAVE_ID}} is merged to origin/master at
{{MASTER_COMMIT}}. Reconcile the result with the approved milestone plan and
stop condition.

If the next dependency-ready wave can proceed without changing approved scope
or interfaces, freeze the current origin/master commit and generate the next
Manual Execution Packet using the same format. If implementation evidence
invalidated the plan, stop and propose a planning revision for my approval
before generating worker prompts.
```

Repeat Phases 3 through 9 until the milestone stop condition is satisfied.

## Phase 10: Close the Milestone

When the coordinator believes the milestone stop condition is satisfied, ask it
for a milestone evidence review:

```text
Audit the completed milestone against its approved outcome, stop condition,
requirements, and implementation plan. Use repository evidence rather than
session summaries. Identify every merged pull request, verification result,
deferred item, unresolved risk, and documentation update.

Do not declare the milestone complete if required evidence is missing. If the
gate passes, produce a concise milestone completion report and recommend the
smallest next planning step. Do not begin designing the next milestone until I
approve the report.
```

After approving the completion report, start a fresh coordinator session for
the next milestone and repeat this runbook. Do not reuse a long-running
coordinator across milestones; the approved documents and repository history
are the durable handoff.

## When to Pause the Whole Wave

Pause affected workers and return to the coordinator when any of these occurs:

- the frozen base is no longer the expected `origin/master`;
- two workers need to edit the same owned surface;
- an interface assumed by multiple tasks changes;
- a task requires an unapproved schema, protocol, or lifecycle change;
- a worker discovers user-owned or ambiguous work in its target workspace;
- a required harness capability or skill is unavailable;
- normal verification would consume real subscription quota;
- an audit, persistence, permission, billing, or path-safety invariant is in
  doubt;
- integration requires a semantic conflict resolution;
- the milestone stop condition can no longer be met within approved scope.

Do not solve a wave-wide problem independently in one worker session.

## Recovery Procedures

### A worker session is lost

Keep its branch and worktree untouched. Ask the coordinator for a replacement
prompt containing the frozen task packet, known commit, and remaining work. The
replacement must inspect existing state before editing.

### A worker finishes against the wrong base

Do not rebase automatically. Send the commit and observed base to the
coordinator. It decides whether review remains valid, the task must be replayed,
or the wave must be reissued.

### Two tasks overlap unexpectedly

Pause both if either can still change the shared surface. The coordinator must
split ownership, serialize the tasks, or establish and land a shared contract
before work resumes.

### A reviewer and worker disagree

Return the technical evidence to the coordinator. Do not resolve the dispute by
majority vote or deference. The frozen requirement and task contract determine
whether a plan clarification or implementation correction is needed.

### Integration fails after every task passed review

Treat this as evidence that task isolation or interface assumptions were
incomplete. Do not hide the issue in a broad integration fix. Ask the
coordinator to create a bounded rework task and review it normally.

### The coordinator session is lost

Start a replacement coordinator. Give it the architecture, milestone design,
implementation plan, frozen base, operator status table, and all handoffs. Ask
it to reconcile durable repository state before issuing new work.

## Operator Checklist

Before launching a wave:

- [ ] Architecture, milestone design, and plan are on `origin/master`.
- [ ] The coordinator recorded one exact frozen base commit.
- [ ] Every task has explicit outcome, ownership, exclusions, and evidence.
- [ ] Every task is dependency-ready.
- [ ] File and interface overlap was audited.
- [ ] Worker prompts are completely filled and immutable for the wave.
- [ ] No task requires real external-agent traffic in default verification.

Before integration:

- [ ] Every worker returned a commit-based handoff.
- [ ] Every accepted commit has an independent review handoff.
- [ ] Rework commits were reviewed again.
- [ ] Base drift and unexpected surfaces were checked.
- [ ] The coordinator generated the integration order and gate.

Before merge:

- [ ] The integration session ran the complete wave gate.
- [ ] The final diff contains only expected surfaces.
- [ ] A pull request was explicitly authorized.
- [ ] Required automated checks passed.
- [ ] The operator completed hands-on testing.
- [ ] Merge was explicitly approved after testing.
- [ ] Worktree cleanup targets were inspected and unambiguous.

## The Manual Model Mesh V2 Should Replace

This process is intentionally explicit. It gives Mesh V2 a concrete operating
model to automate:

- the coordinator becomes the PM and concrete domain services;
- milestone designs and plans become approved durable proposals;
- execution packets become frozen assignments and `ExecutionRun` waves;
- worker sessions become `WorkerExecution` records;
- worktrees become automatic workspace reservations;
- handoffs become structured reports and evidence;
- review sessions become `QaAttempt` records;
- rework becomes a durable attempt loop;
- integration prompts become integration authority;
- the operator status table becomes the Board and attention queue.

Record friction, ambiguity, and repeated manual decisions while using this
runbook. Those observations are product requirements for Mesh V2, not reasons
to weaken the manual safety boundaries.
