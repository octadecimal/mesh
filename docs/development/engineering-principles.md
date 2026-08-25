# Engineering principles

These are Mesh's default implementation preferences. They guide judgement when
the task does not dictate a choice; maintainers may override them explicitly.
Safety and billing constraints in `AGENTS.md` remain mandatory.

## Optimize for obvious behavior

Prefer code whose control flow and ownership can be understood locally. A
straightforward function with concrete types is usually better than a reusable
framework that supports one use case. Names should describe domain behavior,
not patterns used to implement it.

- Make invalid states difficult to construct and illegal transitions explicit.
- Prefer inferred local types; annotate public boundaries and ambiguous values.
- Avoid `any`, unchecked casts, and parallel representations of the same state.
- Keep side effects at boundaries and make their ordering visible.
- Comments explain constraints, invariants, or surprising external behavior.
  Do not narrate code that already explains itself.
- Delete obsolete paths when their replacement is proven; do not maintain two
  architectures indefinitely as a precaution.

## Keep modules cohesive

A module should have one reason to change and a small public surface. Split a
file when distinct responsibilities can be named and tested independently, not
to meet a line-count target. Keep code that changes together near each other.

Before adding an abstraction, answer:

1. What concrete variation or duplication does it handle today?
2. Which module owns it and which modules consume it?
3. Can its contract be described more simply than its implementation?
4. Does it reduce coupling, or merely rename and redistribute it?

If those answers are weak, keep the direct implementation. Two similar pieces
of code are not automatically a reusable concept; wait until the shared rule is
clear.

## Respect existing boundaries

Follow the component ownership in `architecture.md`:

- Shared wire shapes live in contracts.
- External SDK and platform details stay in adapters.
- Active-runtime lifecycle rules live in the runtime transition model.
- SQL stays behind repositories.
- Client state projects durable server truth.
- React components do not become alternate domain controllers.

Avoid bypassing an owner because reaching it requires a slightly larger change.
If a boundary is wrong, improve it deliberately and test the new contract.

## Make narrow changes

Start from the user's observable requirement and trace only the paths it
affects. Prefer a complete vertical slice over broad horizontal scaffolding.
Do not bundle cosmetic cleanup, dependency upgrades, file moves, or unrelated
refactors with behavioral work.

When nearby code blocks a clean implementation, make the smallest preparatory
refactor that exposes the needed seam. Preserve behavior with tests, then make
the requested change. A refactor should leave the system in a valid,
independently reviewable state.

## Handle failures at the right level

Validate data where it crosses a trust boundary. Preserve actionable context
when translating errors, but do not leak credentials, raw internal exceptions,
or sensitive paths to clients. Avoid catch-all recovery that converts data loss
or invariant violations into apparent success.

Distinguish:

- expected user errors, returned in stable typed form;
- transient transport failures, which can reconnect or retry safely;
- subscription and permission limits, which require visible operator action;
- persistence, lifecycle, and ownership failures, which stop unsafe mutation;
- unexpected defects, which retain diagnostic evidence.

Retries require idempotency, a bounded policy, and an observable terminal
failure. Arbitrary polling and sleeps are not synchronization mechanisms.

## Test behavior, not structure

Use the cheapest reliable test boundary:

1. Pure unit tests for schemas, transitions, reducers, policies, and
   normalization.
2. Focused integration tests for repositories, runtime orchestration, routes,
   replay, and recovery.
3. Deterministic browser acceptance tests for critical user workflows that
   cross server and web boundaries.
4. Real Claude smoke tests only when explicitly authorized and the fake driver
   cannot answer the question.

A good test fails for the behavior being changed, passes for the intended
reason, and remains stable under normal scheduling variation. Assert observable
outcomes rather than private implementation details. Use events, acknowledgments,
or worker drains for asynchronous completion instead of elapsed-time guesses.

Bug fixes should normally reproduce the defect in a focused test before the
implementation changes. Refactors preserve the existing test signal; add tests
only where the contract was previously unprotected.

## Verify proportionally

During iteration, run the closest affected project or test file. Before handoff,
expand verification according to risk:

- Documentation-only: formatting/link checks and inspection of the rendered
  Markdown structure.
- One isolated module: focused tests plus its lint and typecheck target.
- Shared contracts or cross-layer behavior: all affected consumers and builds.
- Persistence, recovery, permissions, paths, or lifecycle: focused regression
  coverage plus the normal complete verification gate.
- User workflow: deterministic end-to-end coverage when unit/integration proof
  is insufficient.

Do not claim success from stale output. Report the exact commands run, relevant
results, skipped checks, and any warnings that may matter later.

## Finish cleanly

Before handing off a change:

- Review the diff for accidental scope growth and duplicated logic.
- Check every applicable surface listed in `AGENTS.md`.
- Remove debug output, temporary fixtures, screenshots, and scratch files.
- Ensure docs describe the implemented system rather than the plan that led to
  it.
- Leave the worktree and repository state understandable to the next person.
