# Mesh V2 Milestone 2: Intent and Requirement Ledger Design

**Status:** Approved by delegated campaign authority

**Date:** 2026-08-29

**Base:** `84a2fa6f702488687f95d634c4b1066d6b011a12`

**Parent architecture:**
[Mesh V2 Architecture](2026-08-27-mesh-v2-architecture-design.md)

## Outcome and Stop Condition

Milestone 2 turns a project's PM conversation into human-approved canonical
intent. A human turn starts one finite fake-backed PM `WorkerExecution`; its
strict structured report either asks durable questions or proposes one complete
`ProjectIntent` and Requirement Ledger revision. Only a human command may apply
that proposal, and approval commits the entire revision atomically.

The milestone stops when the built-process Todo fixture proves this path:

1. an operator sends an initial Todo product description;
2. the fake PM returns structured clarifying questions;
3. the operator answers in the same durable planning cycle;
4. a second finite PM execution returns a proposed intent and ledger diff;
5. the UI shows provenance, requirement relationships, and the complete
   approval boundary;
6. human approval creates one immutable `ProjectIntent` revision and one
   immutable ledger revision;
7. refresh, WebSocket replay, forced resync, and server restart reconstruct the
   same approved state and conversation history.

The proof uses only the deterministic fake harness, a temporary Todo repository,
a temporary V2 database, and built V2 server/web output. It does not contact a
real agent, inspect credentials, or consume subscription capacity.

## Scope Boundary

### In scope

- durable PM planning cycles, human and PM conversation turns, structured
  questions, proposal revisions, rejection feedback, and output receipts;
- one finite `WorkerExecution` for every human conversation turn;
- strict `mesh.dev/pm-discovery-report/v1` parsing and assignment-binding
  validation;
- immutable `ProjectIntent` revisions;
- stable ledger record identities and immutable revisions for `Requirement`,
  `Decision`, `Assumption`, `Question`, and `Risk`;
- immutable ledger revisions containing complete record membership and edge
  snapshots;
- requirement relationships `refines`, `depends_on`, `conflicts_with`,
  `supersedes`, and `duplicates`;
- decision-to-requirement `constrains` traceability;
- conversation-turn provenance references;
- complete-proposal review, human approval, rejection, and revision requests;
- PM Chat question/proposal cards and the Requirements list/detail experience;
- M1 command idempotency, immediate transactions, ordered project domain
  events, snapshots, replay/resync, fake execution, and focused shell;
- one forward V2 migration, including fresh and version-1 upgrade proof.

### Deferred

Milestone 3 owns milestones, tasks, task dependencies, requirement coverage,
readiness, scheduling, and the Board. M2 does not add placeholder domain objects
for them. The Board remains the existing placeholder.

Also deferred are imported document ingestion, advisory assignments, generated
specifications, requirement graph visualization, impact analysis, partial
proposal approval, real PM adapters, persistent provider sessions, generic
structured-output consumers, and configurable approval policy.

## Autonomous Questions and Answers

The overnight mandate replaces interactive approval waits, not the substantive
design work. These are the consequential questions and the conservative answers
used by this design.

1. **Is a planning cycle one provider session or durable Mesh state?** It is
   durable Mesh state. Every human turn launches a new finite execution, so
   restart and provider replacement do not depend on a native session handle.
2. **Should a proposal contain only changed rows or the complete desired
   ledger?** It contains the complete desired membership and edge snapshot,
   with create/revise/reuse record entries. This makes approval and review one
   deterministic atomic boundary and prevents an omitted edge from becoming an
   implicit mutation.
3. **Can a human approve selected proposal items?** No. The approval unit is one
   complete proposal revision. To accept only part, the human sends feedback
   and the PM produces a new complete revision.
4. **Does every ledger concept need a separate storage subsystem?** No. One
   discriminated record contract, one stable identity table, and one immutable
   revision table cover the five record types. Type-specific validation remains
   in the contract.
5. **How much M3 traceability enters now?** Only requirement-to-requirement
   relationships and decision-to-requirement `constrains`. Coverage by
   milestones, tasks, criteria, or evidence is excluded.
6. **How does PM output become durable domain state?** A planning-specific
   receipt consumer validates one strict report against the execution's frozen
   assignment. There is no generic output-consumer framework.
7. **What does rejection do?** It terminalizes the proposal and cycle without
   changing canonical intent. Continuing discovery starts a new cycle; revision
   feedback sent before rejection stays in the current cycle.
8. **What happens after a crash between accepting a human turn and launching
   its execution?** The turn and cycle remain non-accepting `launch_pending`.
   Startup first checks for the derived start-operation link. With no operation,
   the turn was never reserved and the drain may make one fresh reservation.
   With an existing operation, M1 reconciliation is authoritative: terminal or
   attention state binds to the cycle, and startup never retries activation.
9. **How can migration 2 store planning command results?** It rebuilds only
   `command_results` inside the migration transaction with the four M1 and four
   M2 command types in its `CHECK`, copies every M1 row unchanged, recreates its
   primary-key index, and then adds the planning schema. Migration 1 remains
   byte-for-byte immutable.
10. **What wins if Abandon races a reserved launch?** A single per-cycle launch
    coordinator orders cancellation, binding, activation, and abandonment. An
    Abandon request signals cancellation before waiting. If cancellation owns
    the reserved-start boundary, the linked starting execution and operation
    terminalize without adapter traffic; if activation already owns it,
    Abandon waits for that outcome and interrupts a running execution before
    committing the abandoned cycle.

## Approaches Considered

### Selected: immutable snapshots over stable record revisions

Each approved proposal creates a new `ProjectIntentRevision` and a new
`LedgerRevision`. The ledger revision points to exact immutable record revisions
and stores its complete relationship set. Proposals carry a complete proposed
snapshot, but reuse unchanged record revisions by reference.

This is the smallest model that preserves stable identities, historical truth,
atomic approval, stale-base detection, and deterministic replay. It also gives
M3 exact requirement revisions to reference without adding M3 objects now.

### Alternative: mutable current rows plus an audit log

This uses fewer tables, but reconstructing what a proposal approved requires
event replay and careful temporal joins. A stale approval could overwrite a
record that changed after review. The operational simplicity is illusory, so
this approach is rejected.

### Alternative: event-sourced planning aggregate only

Every conversation, proposal, record, and approval could exist solely as
events, with projections rebuilding all current state. That introduces a new
event-sourcing subsystem and migration/rebuild policy even though SQLite
revision tables and M1 ordered publication already satisfy the stop condition.
It is rejected as unnecessary.

## Authority and Lifecycle

### Planning cycle

A `PlanningCycle` is the durable human-facing discovery boundary for one
project. Its lifecycle is:

```text
discovering -> launch_pending -> execution_active -> awaiting_human
                                      \-> awaiting_approval
awaiting_human -> launch_pending           (answer)
awaiting_approval -> launch_pending        (revision request)
attention_required -> launch_pending       (human retry turn)
awaiting_approval -> approved             (human only)
awaiting_approval -> proposal_rejected    (human only)
any nonterminal state -> abandoned        (human only)
execution_active -> attention_required    (invalid/missing output or runtime failure)
launch_pending -> attention_required      (bound terminal reservation)
```

Only `discovering`, `awaiting_human`, `awaiting_approval`, and
`attention_required` accept another human turn. In the same immediate
transaction, acceptance increments the cycle revision, appends one turn with
launch state `launch_pending`, and moves the cycle itself to `launch_pending`.
That committed lifecycle is non-accepting: a distinct submit command, even with
the new revision, returns `planning_cycle_revision_conflict` at HTTP 200 with no
turn, reservation, or event write. Replay of the same idempotency key returns
the stored success. A partial unique index permits one `launch_pending` turn per
cycle, and `BEGIN IMMEDIATE` plus the lifecycle re-read makes concurrent distinct
submissions deterministic.

The pending turn freezes the latest approved intent revision, ledger revision,
next proposal revision, and prior conversation through IDs in its PM assignment.
Creating a cycle also freezes an explicitly selected approved PM profile ID and
revision; later turns reuse that snapshot and never silently follow a newer
profile. Binding an execution changes the turn to `execution_bound` and moves
the cycle to `execution_active`, or directly to `attention_required` for a
terminal reservation. A valid question report moves it to `awaiting_human`; a
valid proposal report moves it to `awaiting_approval`.

`approved`, `proposal_rejected`, and `abandoned` are terminal. A partial unique
index permits at most one nonterminal cycle per project, including
`attention_required`; creating another returns `planning_cycle_active_conflict`.
`proposal_rejected` rejects the latest proposal, while `abandoned` closes a
cycle from any nonterminal state without changing canonical intent. Both
preserve history, and only then may a new cycle begin. Abandoning an active
execution acquires the per-cycle launch interlock, completes the applicable
reserved cancellation or running interruption, and only then transactionally
persists the abandoned cycle, complete event, and command result. Cleanup
failure stores no successful Abandon result and does not move the cycle to
`abandoned`; it remains nonterminal or moves to `attention_required` under its
typed failure. Once committed, Abandon cannot reopen because cleanup preceded
the terminal commit.

One cycle accepts at most 32 human and 32 PM turns and 16 proposal revisions.
Messages remain bounded at 16 KiB and proposal/record limits remain those in
the wire contract. The immutable PM assignment contains the whole current
cycle, so these limits bound every assignment. A turn or proposal beyond the
limit returns `planning_cycle_history_limit` without a write; the human can
abandon the cycle and start another.

### Conversation and questions

Conversation turns are immutable and ordered within a cycle. A human turn owns
the submitted text and optional revision feedback. A PM turn owns the
human-readable response, the producing execution, and the accepted output
receipt. Structured questions have stable IDs within the cycle, their prompt,
rationale, optional choices, and the PM turn that asked them. A human answer is
the next ordinary human turn; no second question-answer state machine is added.

### Proposal

A proposal revision is immutable and has exactly one base tuple:

```text
(projectIntentRevision | null, ledgerRevision | null, proposalRevision)
```

It contains one complete proposed `ProjectIntent`, complete proposed ledger
membership, complete relationship set, a summary, and the server-computed diff
shown to the human. Proposal lifecycles are `awaiting_approval`, `superseded`,
`approved`, and `rejected`. Accepting a new proposal supersedes the prior
unapproved proposal in the cycle. Requesting revision does not mutate the old
proposal; the next valid proposal creates a new revision.

Approval targets one exact proposal revision. A different current canonical
base, cycle revision, or record revision is stale and changes nothing. Rejection
records human feedback and changes no canonical intent.

### Human-only authority

All V2 command envelopes continue to require `actor: { kind: 'human' }`.
`planning_proposal.approve` and `planning_proposal.reject` have no worker-facing
control and are never included in a PM assignment. The PM report schema has no
approval field; unknown fields fail strict parsing. A completed execution,
assistant statement, or proposal status can never approve canonical state.

## Canonical Domain Records

### ProjectIntent revisions

`ProjectIntentRevision` is immutable and contains:

- `projectId` and monotonically increasing `revision`;
- `goal`;
- `targetUsers[]`;
- `desiredCapabilities[]`;
- `constraints[]`;
- `nonGoals[]`;
- `successConditions[]`;
- `rationale`;
- provenance references;
- `proposalId`, `approvedBy: 'human'`, and `approvedAt`.

Every approved proposal creates a new intent revision, including the first.
There is no mutable current-intent row; the latest revision is selected by
maximum revision.

### Stable record identities and immutable revisions

`LedgerRecord` supplies stable identity, project ownership, and one type:
`requirement`, `decision`, `assumption`, `question`, or `risk`. Its immutable
`LedgerRecordRevision` supplies `recordId`, monotonically increasing `revision`,
`statement`, `rationale`, approval metadata, and type-specific fields:

- Requirement: `kind` is exactly `functional`, `quality`, `ux`, `safety`,
  `operational`, or `constraint`; `status` is exactly `proposed`, `approved`,
  `superseded`, `rejected`, or `retired`; `priority` is `must`, `should`, or
  `could`.
- Decision: `status` is `active`, `superseded`, or `retired`; its statement
  constrains requirements only through explicit edges.
- Assumption: `status` is `active`, `confirmed`, `invalidated`, or `retired`,
  and `confidence` is `low`, `medium`, or `high`.
- Question: `status` is `open`, `answered`, or `retired`; `resolution` is
  required exactly when status is `answered`.
- Risk: `status` is `open`, `mitigated`, `accepted`, or `retired`; `severity` is
  `low`, `medium`, or `high`, with a required `mitigation`.

Proposal content for a new or revised requirement uses status `proposed`.
Approval rewrites only that proposed status to `approved`. Later proposals may
explicitly create immutable `superseded`, `rejected`, or `retired` requirement
revisions. A base-ledger member may never disappear from a later complete
snapshot. The equivalent lifecycle-only revisions are decision
`superseded|retired`, assumption `confirmed|invalidated|retired`, question
`answered|retired`, and risk `mitigated|accepted|retired`. Records are never
physically deleted by the planning domain, and terminal records remain members
so history and relationships do not silently vanish.

Each revision has one or more `conversation_turn` provenance references. A
reference records a durable planning turn ID and a short rationale; the turn
must belong to the same project. No other provenance variant exists in M2.

### Ledger revision

`LedgerRevision` is immutable and contains project, revision, proposal,
approval metadata, exact record memberships, and exact edges. Each membership
points to one immutable record revision. An approved proposal may:

- reuse an existing member at its current revision;
- revise an existing record at an expected revision;
- create a new stable record identity and first revision.

Every member in the base ledger must appear in the proposed snapshot. Removal
is expressed by the type-specific lifecycle revision above, not omission. When
a proposal report is accepted, the server replaces each create-entry key with
a newly generated UUID and stores the key-to-ID mapping in a
`planning_proposal_records` reservation row. That UUID is durable proposal
state but not canonical: no `ledger_records` or ledger membership row exists
before approval. A revised proposal receives new reservations. Approval uses
the exact reserved UUIDs when it inserts `ledger_records`; rejected,
superseded, or abandoned proposal reservations never become canonical and are
never reused.

Requirement edges are typed exactly as `refines`, `depends_on`,
`conflicts_with`, `supersedes`, or `duplicates`. `refines`, `depends_on`, and
`supersedes` are directed. `conflicts_with` and `duplicates` are symmetric:
the server normalizes their endpoint IDs into lexical order before uniqueness,
storage, diffing, and event projection, so reversed duplicates are the same
edge. Both endpoints must be requirements in the same proposed snapshot.
Decision constraint edges are directed `decision -> requirement` and have the
sole type `constrains`. Duplicate normalized edges and self-edges fail
validation. Coverage, milestones, tasks, criteria, and evidence are not legal
endpoints in M2.

## PM Execution and Structured Output

### Frozen assignment

The existing `WorkerExecution.assignment` union gains
`PmDiscoveryAssignment`:

```ts
type PmDiscoveryAssignment = {
  kind: 'pm_discovery';
  projectId: string;
  outputSchema: 'mesh.dev/pm-discovery-report/v1';
  planningCycleId: string;
  humanTurnId: string;
  expectedCycleRevision: number;
  expectedProposalRevision: number;
  baseProjectIntentRevision: number | null;
  baseLedgerRevision: number | null;
  input: {
    conversation: readonly {
      turnId: string;
      actor: 'human' | 'pm';
      message: string;
    }[];
    latestProposal: PlanningProposal | null;
    approvedIntentLedger: ApprovedIntentLedger | null;
  };
};
```

The assignment contains IDs, revision bindings, and the immutable conversation,
latest-proposal, and approved-ledger input snapshot needed for that turn, not a
persistent provider session. The PM profile is an approved M1 profile and
requests read-only/product reasoning capabilities only; a prompt or profile
grants no approval authority.

The planning service, not the route or adapter, validates the frozen approved
profile. Its resolved scope must be global or this project, its
`assignmentKinds` must include `pm_discovery`, and `outputSchema` must equal
`mesh.dev/pm-discovery-report/v1`; otherwise the turn returns
`planning_profile_incompatible` without creating a turn or execution. The
profile contract adds `pm_discovery` without weakening existing
`foundation-check` validation: it accepts exactly either single-kind tuple and
requires the discovery schema for the PM tuple, while the existing foundation
tuple retains its current bounded output-schema behavior.

### `mesh.dev/pm-discovery-report/v1`

The adapter emits one `worker_execution.structured_output` runtime event before
its terminal completion. Its `payload.schema` is the literal schema name and
`payload.value` must parse as this strict discriminated shape:

```ts
type PmDiscoveryReport = {
  schema: 'mesh.dev/pm-discovery-report/v1';
  planningCycleId: string;
  humanTurnId: string;
  expectedCycleRevision: number;
  expectedProposalRevision: number;
  assistantMessage: string;
  result:
    | {
        kind: 'questions';
        questions: readonly {
          key: string;
          prompt: string;
          rationale: string;
          choices?: readonly string[];
        }[];
      }
    | {
        kind: 'proposal';
        summary: string;
        projectIntent: ProjectIntentContent;
        records: readonly ProposedLedgerMember[];
        relationships: readonly ProposedLedgerRelationship[];
      };
};

type ProposedLedgerMember =
  | { operation: 'reuse'; recordId: string; expectedRevision: number }
  | {
      operation: 'revise';
      recordId: string;
      expectedRevision: number;
      content: LedgerRecordContent;
      provenance: readonly ProvenanceInput[];
    }
  | {
      operation: 'create';
      key: string;
      content: LedgerRecordContent;
      provenance: readonly ProvenanceInput[];
    };

type ProposedLedgerEndpoint =
  | { recordId: string }
  | { proposalKey: string };

type ProposedLedgerRelationship =
  | {
      kind:
        | 'refines'
        | 'depends_on'
        | 'conflicts_with'
        | 'supersedes'
        | 'duplicates';
      from: ProposedLedgerEndpoint;
      to: ProposedLedgerEndpoint;
    }
  | {
      kind: 'constrains';
      from: ProposedLedgerEndpoint;
      to: ProposedLedgerEndpoint;
    };
```

The contract adds bounded string and collection sizes, unique question keys,
unique proposal keys, and strict unknown-field rejection. Relationship endpoint
types are checked when the proposal is consumed because they may refer to
proposal-local records.

### Receipt consumption

`PmReportConsumer.consume(execution, runtimeEvent)` is the only consumer. It
computes the output digest, then opens one `BEGIN IMMEDIATE` transaction and:

1. re-reads the execution and the authoritative cycle/turn from its frozen
   `pm_discovery` assignment;
2. checks event/execution project identity, exact cycle, turn, cycle revision,
   proposal revision, and schema bindings inside that transaction;
3. strictly parses the report and resolves all record references inside that
   transaction;
4. validates base membership, record types/revisions, provenance ownership,
   relationship legality, and proposal completeness inside that transaction;
5. on any parse, schema, binding, or semantic failure, inserts one immutable
   rejected receipt with a stable reason, moves the complete cycle to
   `attention_required`, appends `planning_cycle.changed`, and commits no PM
   turn, question, proposal, record reservation, or canonical row;
6. otherwise inserts the accepted receipt, PM turn, questions or proposal,
   updates the cycle, appends the complete-cycle event, and commits;
7. publishes only the committed event.

The receipt key is the execution ID. Re-delivery of the same output digest is a
no-op. A second different output for the same execution is rejected and cannot
replace the first. Malformed or wrongly bound output stores a rejected receipt
and moves the complete planning cycle to `attention_required`; it cannot create
a PM turn, question, proposal, record reservation, or canonical revision. A
failure inserting that rejected receipt, updating attention, or appending its
event rolls back all three writes and publishes nothing. The central audit
barrier still applies to raw runtime input before this consumer runs.

Completion without one accepted receipt is not planning success. When the
execution ends, a planning-specific terminal check moves the cycle to
`attention_required` if no valid report was consumed.

### Reservation, binding, and activation

M1 `ExecutionRuntime.start` currently reserves, starts, attaches, and begins
consuming a harness session before its promise returns. M2 therefore introduces
a narrow split in that same runtime rather than pretending its return value is
a pre-start reservation:

```ts
type ReservedExecutionStart = {
  execution: WorkerExecution;
  result: V2CommandResult;
  activationRequired: boolean;
};

ExecutionRuntime.reserveStart(
  envelope: StartExecutionEnvelope,
): Promise<ReservedExecutionStart>;
ExecutionRuntime.activateReserved(executionId: string): Promise<void>;
```

`reserveStart` performs M1 capability/skill resolution and the existing
immediate transaction that inserts the execution, durable start operation,
ordered lifecycle event, and idempotent command result. It never calls
`adapter.start`, attaches a session, or consumes events. It returns the exact
execution even when missing capabilities or skills made reservation terminal;
those expected start failures therefore remain bindable. The existing public
`start` keeps its M1 signature and behavior as a wrapper that reserves, activates
when `activationRequired`, and returns `result`, preserving foundation callers.

The durable reservation-to-execution link is the existing M1
`execution_operations` row, not the generic command result. Every reservation
created after migration 2 creates exactly one `kind: 'start'` operation whose
request stores the idempotency key and request hash and whose `execution_id`
points to the exact inserted execution. A starting reservation leaves it
`pending`; a terminal capability/skill reservation creates and finishes it
`failed` in the same transaction. Migration 2 adds a partial unique index for
the normalized start request idempotency key and request hash. `reserveStart`
replay reads the stored command result, resolves that unique operation link,
loads its execution, and returns the same `ReservedExecutionStart`; a missing or
conflicting M2/PM link trips the audit barrier rather than guessing from planning
assignment data.

Compatibility is explicit for terminal M1 foundation commands created before
migration 2, which may have a command result and execution but no start operation.
The existing public `start` wrapper retains its early replay path and returns
that stored legacy result without calling `reserveStart`; it does not need an
execution identity because no planning binding consumes it. Direct
`reserveStart` is used only for post-migration reservations and therefore never
fabricates a link for legacy history.

Project/profile lookup or an adapter capability/skill probe that cannot produce
the snapshots required by `WorkerExecution` fails before reservation with a
typed no-write error. The `start` wrapper maps it to its existing command result;
the planning launcher leaves the turn `launch_pending` for idempotent startup
retry or human abandonment. Because no execution or adapter session exists,
there is nothing to bind or consume at that boundary.

The planning launcher reserves with key `planning-turn:<turnId>`, durably binds
that exact execution to the human turn in a planning transaction, publishes
the binding event, and only then calls `activateReserved`. Binding a terminal
reservation moves the cycle directly to `attention_required` with its failure.
Adapter-start failure occurs only after binding; the runtime persists its
terminal lifecycle and notifies the planning terminal observer. Any process loss
after a starting reservation commits leaves `starting`, a pending start
operation, and no durable native handle. That state cannot distinguish a crash
before `adapter.start` from a crash after the adapter returned but before the
running/native-handle transaction. M1 reconciliation therefore remains
fail-closed: it probes unknown, finishes the start operation `unknown`, and moves
the execution to `attention_required`; planning never invokes activation for it.
No adapter event can be consumed for an unbound PM execution. A
reservation-transaction exception creates no execution or operation and leaves
the turn `launch_pending` eligible for one fresh reservation; pre-reservation
lookup/probe failure follows the same no-write rule; capability/skill rejection
binds the exact terminal execution; adapter startup or attachment failure in the
live process terminalizes the already-bound execution. These cases cover every
start-failure boundary without inventing a second execution or recovery marker.

Abandon and the pending-launch drain share one narrow per-cycle
`PlanningLaunchCoordinator`; it is not a generic job framework. Abandon first
sets the coordinator's cancellation signal, then waits for the current launch
boundary to settle. The drain checks that signal immediately after
`reserveStart`, immediately before binding, and under the same execution-level
interlock used to claim `activateReserved`. Therefore a cancellation that wins
before adapter start calls the runtime's idempotent
`cancelReserved(executionId)` and never binds or activates late. That method
accepts only an exact operation-linked `starting` execution with a pending start
operation, transitions it to `failed` with the existing
`startup_interrupted_before_start` evidence, finishes the same operation as
failed with reason `planning_cycle_abandoned`, and preserves the operation link
for replay/audit. Terminal replay is a no-op. M1 `interrupt` remains unchanged
and continues to accept only `running`.

This cancellation path is live-process arbitration only. After restart, an
operation already finished `unknown` and an execution already moved to
`attention_required` are treated as contained, auditable cleanup state;
`cancelReserved` never rewrites them or retries their activation. Abandon may
then commit after observing that no locally controllable running execution
exists.

If activation claimed the execution interlock first, Abandon waits for
activation to become durable. For a running execution it calls the narrow
runtime-owned `interruptForPlanning(executionId)` bridge; it does not call the
public human interrupt command. Under the existing per-execution interlock the
bridge captures the exact active entry (`HarnessSession` plus its consume task),
marks that entry fenced, and durably starts the internal interrupt operation.
The consume loop checks the fence after every iterator result and before every
diagnostic, event, persistence, or publication boundary, so a result delivered
after fencing is discarded rather than becoming durable planning output.

The bridge then awaits `adapter.interrupt` with the existing audit-barrier
checks, closes that exact `HarnessSession`, awaits settlement and removal of
that exact consume task, checks the barrier again, and only then terminalizes
the execution and finishes its durable internal operation consistently. Its
promise resolves only after this quiescence fence proves that the captured
session can produce no later observed, persisted, or published event. The
bridge is called only by the external planning launch coordinator, never from
inside the consume task; attempting a self-wait fails typed before fencing, so
the implementation cannot deadlock on its own task. A replay of the same
coordinator cleanup observes the already-terminal operation and is idempotent.

Adapter rejection, barrier failure, session-close failure, or consume-task
settlement/removal failure preserves the internal operation and audit
diagnostics and throws a typed planning-cleanup failure. It never reports
quiescence or permits the Abandon transaction; the execution remains
nonterminal or moves to `attention_required` according to the safely persisted
runtime failure. Abandon may instead accept an execution that was already
terminal before cleanup began. Only after cancellation, this quiescent running
cleanup, or observation of that terminal outcome may it commit the cycle,
proposal, command result, and complete-cycle event as abandoned. Thus no
adapter start or consumer write can occur after the abandoned cycle commits. A
successful Abandon leaves no starting execution, active consumer, or pending
start operation; cleanup failure leaves the cycle
non-abandoned/attention-required and auditable rather than falsely reporting
success. A process crash before the Abandon command transaction commits has no
stored successful Abandon result; startup reconciles the exact linked
terminal/running execution before another human retry.

If the process crashes after a terminal reservation commits but before planning
binding, startup finds the cycle and turn still `launch_pending`. The drain
replays the same derived key, follows the finished start-operation link to the
same terminal execution, binds it once, and moves the cycle to
`attention_required`; no new execution or activation is permitted. In-process
drains coalesce by turn ID. `activateReserved` separately coalesces concurrent
calls by execution ID only within the live process, closing the concurrent
start-before-running/attachment window without creating restart authority.

## Persistence and Transaction Ordering

Migration `002_intent_ledger.sql` is appended to the V2 migration ledger;
`001_foundation.sql` is never edited. Before adding planning tables, migration 2
performs SQLite's compatibility-safe table-rebuild sequence for
`command_results` inside the existing outer `BEGIN IMMEDIATE` transaction:

1. create `command_results_v2` with the identical columns, nullability, hash and
   JSON checks, and primary key, but a `command_type` check accepting exactly
   the four M1 types plus `planning_cycle.submit_turn`,
   `planning_proposal.approve`, `planning_proposal.reject`, and
   `planning_cycle.abandon`;
2. copy all five columns from `command_results` without transforming any value
   and let the new table constraints validate the copy;
3. drop the old table and rename `command_results_v2` to `command_results`,
   recreating primary-key uniqueness while leaving every unrelated M1
   table/index untouched;
4. continue the remaining migration statements and ledger insert in the same
   transaction, so any later failure restores the exact migration-1 table,
   rows, schema, indices, and replay behavior.

It then adds:

- `planning_cycles`;
- `planning_turns`;
- `planning_questions`;
- `planning_proposals`;
- `planning_proposal_records`;
- `pm_output_receipts`;
- `project_intent_revisions` and `project_intent_provenance`;
- `ledger_records`, `ledger_record_revisions`, and
  `ledger_record_revision_provenance`;
- `ledger_revisions` and `ledger_revision_members`;
- `ledger_revision_relationships`.

Foreign keys preserve project, cycle, execution, turn, proposal, record, and
revision ownership. Unique constraints enforce one turn sequence, one pending
turn per cycle, one proposal revision, one output receipt per execution, one
record revision, one project intent revision, one ledger revision, one record
membership per ledger revision, one reserved ID per proposal key, and one
normalized relationship per ledger revision. Partial unique indexes enforce one
nonterminal planning cycle per project and one M1 start-operation link per
idempotency-key/request-hash pair. JSON payloads are canonicalized before
storage and parsed through shared contracts on read.

The operation-link index is the expression index
`UNIQUE(json_extract(request_json, '$.idempotencyKey'),
json_extract(request_json, '$.requestHash')) WHERE kind = 'start'`. Migration
tests first validate every existing `kind: 'start'` operation request against
the M1 operation schema, so an absent key/hash fails the upgrade instead of
creating an ambiguous index entry. A legacy terminal foundation result with no
operation remains legal and exercises the wrapper-only compatibility path.

Human turn acceptance orders writes as follows:

1. reserve or replay the human command;
2. validate the current cycle and canonical base;
3. append the `launch_pending` human turn and set the cycle lifecycle to
   `launch_pending`;
4. append the ordered `planning_cycle.changed` event;
5. store the command result and commit;
6. publish the event;
7. drain the pending turn by calling `reserveStart` with the derived idempotency
   key;
8. idempotently bind the returned exact execution, change the turn to
   `execution_bound`, and move the cycle to execution-active or terminal
   attention in one planning transaction, then publish the complete-cycle
   event;
9. call `activateReserved` only after the binding commit.

At steps 7-9 the per-cycle coordinator's cancellation signal is authoritative.
A signal after reservation but before binding cancels the exact linked
reservation and suppresses binding; a signal after binding but before activation
cancels it and suppresses activation. If activation already owns the execution
interlock, Abandon waits for its durable outcome and follows the running/terminal
path described above. Only after that cleanup does the Abandon transaction
publish an abandoned cycle.

Startup first runs M1 execution reconciliation while collecting recovered
sessions without attaching them. It then runs idempotent planning
reconciliation for every bound nonterminal cycle: replay an unconsumed durable
structured-output event through `PmReportConsumer`, re-read the cycle, and move
an execution-active cycle whose reconciled execution is terminal or
`attention_required` and still has no accepted receipt to
`attention_required`. Before attachment or the general pending drain, planning
also classifies every unbound `launch_pending` turn by its deterministic start
key. If an operation link exists, it binds that exact reconciled execution and
moves the complete cycle view to `attention_required` for terminal/attention
state; it never calls `reserveStart` or `activateReserved` for that turn. If no
operation link exists, the turn remains eligible for the later fresh drain.

Only after those transactions and their committed events does startup publish
the recovery window, attach collected recovered sessions, drain only never-
reserved `launch_pending` turns through one fresh reservation/binding/live-
activation sequence, and begin accepting commands. Thus a crash after execution
terminalization cannot strand `execution_active`, either ambiguous adapter-start
window cannot duplicate a session, and durable valid output is consumed before
attention is inferred.

The pending drain claims/coalesces work by turn ID and processes one turn per
cycle. A bound turn or an unbound turn with an existing operation link is a
startup-drain no-op after planning reconciliation. Only an unbound turn with no
operation may call `reserveStart`; it calls activation only for the newly
created, newly bound nonterminal reservation while still in that live process.
There is no restart activation marker, retry, or inferred pre-invocation state.

Proposal approval uses one immediate transaction:

1. replay-check the command and assert human actor;
2. re-read the exact cycle, proposal, current intent, current ledger, record
   revisions, and relationship endpoints;
3. insert the proposal's exact reserved record IDs as canonical identities,
   then insert all new immutable record revisions and provenance;
4. insert the new immutable intent revision and provenance;
5. insert the new ledger revision, complete memberships, and complete edges;
6. mark the proposal and cycle approved;
7. append `intent_ledger.approved` with the complete approved projection;
8. store the command result and commit;
9. publish the event.

An injected failure at any step rolls back every row, including event and
command result. Stale bases, malformed content, duplicate edges, or
self-approval fail before canonical inserts. Rejection similarly commits only
proposal/cycle history, its ordered event, and command result.

## Commands, Events, Snapshots, and Realtime

The V2 command union adds:

- `planning_cycle.submit_turn` with project, optional existing cycle,
  expected cycle revision, human message, and an approved PM profile ID and
  revision when creating a cycle;
- `planning_proposal.approve` with project, cycle, proposal, expected proposal
  revision, expected intent revision, and expected ledger revision;
- `planning_proposal.reject` with the same proposal identity and human
  feedback;
- `planning_cycle.abandon` with project, cycle, and expected cycle revision.

Expected planning failures are command results and therefore preserve the M1
command-route convention of HTTP 200 with `ok: false`. Their exact codes are:

| Code | Meaning |
| --- | --- |
| `planning_cycle_not_found` | Referenced cycle does not exist in the project |
| `planning_cycle_active_conflict` | A different nonterminal cycle already exists |
| `planning_cycle_revision_conflict` | Expected cycle revision/lifecycle is stale |
| `planning_cycle_history_limit` | The bounded turn/proposal limit is exhausted |
| `planning_proposal_not_found` | Referenced proposal does not exist in the cycle |
| `planning_proposal_revision_conflict` | Expected proposal revision/lifecycle is stale |
| `planning_canonical_base_conflict` | Approved intent, ledger, or record base changed |
| `planning_profile_incompatible` | Approved profile scope, assignment kind, or output schema is invalid for PM discovery |
| `planning_proposal_invalid` | Complete membership, provenance, or relationship validation failed |

Malformed envelopes, including a non-human actor, are `invalid_request` HTTP
400. Existing origin is 403, retained-gap/stable transport conflicts are 409,
stopping/audit failures are 503, and unknown exceptions are 500. T01 owns these
codes and T05 tests this table; neither layer invents an additional mapping.

The domain event union adds:

- `planning_cycle.changed`, carrying one complete bounded `PlanningCycleView`,
  including every proposal's current lifecycle, so append, supersede, reject,
  abandon, launch-pending, binding, attention, and receipt transitions are
  replay-complete;
- `intent_ledger.approved`, carrying the approved intent/ledger projection and
  terminal cycle/proposal state.

The existing project sequence orders these with M1 project/profile/execution
events. The runtime stream adds only
`worker_execution.structured_output`; raw adapter input and its diagnostic are
persisted before publication exactly as in M1.

`V2ProjectSnapshot` adds the active cycle, if any, plus the 19 most recently
updated terminal `PlanningCycleView`s, `planningHistoryTruncated`, and
`intentLedger`, which is absent before first approval. Each cycle view is
bounded by the cycle limits above; older cycles remain durable but are not
loaded into the M2 shell. The reducer replaces a cycle view atomically on
`planning_cycle.changed` and replaces the ledger on approval. Contract,
repository, and reducer tests apply the same event sequence to an earlier
snapshot and assert byte-equivalent planning/ledger projection to a fresh final
snapshot, including proposal supersede and reject. Reconnect uses the existing
subscription message, domain/runtime cursors, retained windows, gap detection,
and resync route. No new socket or transport is introduced.

## Recovery and Reverse States

- **Start/restart:** M1 reconciles execution truth without attachment; planning
  then replays unconsumed durable output and terminal-checks every bound cycle;
  recovered sessions attach next; pending human turns drain last. A terminal
  reservation not yet bound is recovered through its unique finished start
  operation, never by allocating or inferring an execution. A valid
  already-consumed receipt is not consumed again.
- **Question/answer:** questions remain immutable when the next human turn is
  added. Answers are conversation turns, not in-place question edits.
- **Proposal/revision:** a human turn from `awaiting_approval` requests a new
  complete proposal. The old proposal remains reviewable and becomes
  `superseded` only when the new one is durably accepted.
- **Approve/reject:** approval creates one new canonical snapshot; rejection
  creates none. Both target exact revisions and are idempotent.
- **Abandon/restart:** the launch coordinator first cancels an unactivated exact
  reservation or waits for an activation it lost and invokes the internal
  runtime quiescence bridge. For a running execution, that bridge fences the
  exact active session, interrupts and closes it, and joins its consume task
  before resolving. Only then does abandonment terminalize the cycle with no
  canonical mutation. No adapter may start and no fenced consumer may write
  after that commit, no start operation remains pending, and a later cycle
  starts independently. Cleanup or quiescence failure commits no Abandon
  result/event and leaves the cycle nonterminal or attention-required; it never
  creates a terminal-then-reopen sequence.
- **Ambiguous start after restart:** M1 finishes the pending start operation
  `unknown` and moves the execution to `attention_required` whether the crash
  preceded adapter invocation or followed adapter return but preceded durable
  running/native-handle state. Planning binds/projects that exact truth to a
  complete attention-required cycle and never starts another adapter. The human
  may Abandon successfully contained attention state, then create a new cycle.
- **Runtime failure:** a missing, failed, or interrupted execution leaves the
  turn and diagnostics visible and moves the cycle to `attention_required`.
  A new human retry turn creates a new execution; no native provider session is
  resumed as planning authority.
- **Malformed output:** rejected receipt plus attention, no proposal or ledger
  mutation.
- **Duplicate output:** same digest is a no-op; a different digest is rejected,
  preserving the first accepted receipt.
- **Persistence/audit failure:** transaction rollback and central audit barrier;
  no publish after failed persistence.
- **Stale approval:** stable failure with no canonical mutation. The UI reloads
  current server truth before another decision.

## User Interface and Accessibility

The existing focused shell remains the layout owner. The left PM placeholder
becomes a planning pane with:

- an ordered human/PM transcript;
- structured question cards with rationale and optional choices;
- a proposal card showing intent changes, record create/revise/reuse counts,
  relationship changes, provenance, and the single complete approval boundary;
- Approve, Request revision, and Reject actions;
- an Abandon cycle action for any nonterminal cycle, including a cycle that has
  reached its history limit;
- a labeled multiline human-message field and send button;
- explicit empty, loading, disconnected, stale, execution-active,
  launch-pending, attention-required, rejected, and approved states.

Request revision sends a normal human turn; it never sends a partial approval.
Approve, Reject, and Abandon remain disabled whenever the projection is
disconnected, stale, or already submitting; proposal actions also require the
latest proposal. Errors are rendered in an `aria-live` region and focus returns
to the relevant heading or input.

`launch_pending` renders a visible “Starting project manager…” status, preserves
the accepted human turn, and disables Send plus every proposal action. Abandon
remains the sole enabled lifecycle action when connected and current. The UI
never optimistically returns the cycle to an accepting state while reservation,
binding, activation, or restart drain is unresolved.

An `attention_required` cycle produced by ambiguous start reconciliation states
that Mesh did not retry the execution after restart and preserves the execution
and operation diagnostics. Its primary guidance is “Abandon this cycle to start
a new one.” Connected/current Abandon remains enabled; after its cleanup-first
commit removes the single-active-cycle constraint, the ordinary new-cycle form
is available. The UI never represents unknown recovery as a retrying or running
PM.

The Requirements tab becomes a server-truth projection of the latest approved
ledger. It groups the five record types, exposes requirement kind/status and
provenance, and renders relationship text with stable record labels. It has
empty-before-approval and no-records states. It does not compute coverage,
readiness, impact, or a graph.

Existing tabs retain `role=tablist`, selected state, ArrowLeft/ArrowRight,
Home/End behavior, visible focus, and heading hierarchy. Question choices are
buttons that populate the message draft rather than silently submitting. All
actions have text labels; status does not rely on color. The Board content and
tab remain unchanged placeholders.

## V1 Reuse and Non-Reuse

M2 reuses mechanisms already proven in M1/V1: idempotent command results,
`BEGIN IMMEDIATE`, ordered project events, audit-before-publish, immutable
snapshots, replay/resync, fake harness injection, test databases, and accessible
command feedback.

M2 does not import V1 planning entities, task proposals, PM SDK/session types,
provider resume IDs, task dependencies, board state, or V1 web components. It
does not extract a shared planning framework. All new wire and implementation
code remains under `packages/v2-contracts`, `apps/v2-server`, `apps/v2-web`, and
`e2e-v2`.

## Verification Strategy

### Contracts

Contract tests prove strict successful parsing, unknown-field rejection,
collection bounds, record discrimination, exact enums, endpoint references,
human-only envelopes, event coherence, and snapshot round trips. They also
prove that an approved PM profile accepts the `pm_discovery` assignment only
with the exact discovery output schema while the existing `foundation-check`
profile behavior remains unchanged.

### Persistence and domain

Focused tests cover fresh migration, upgrade from exact migration 1, unchanged
`001_foundation.sql`, immutable intent/record/ledger revisions, complete
membership, provenance, relationship constraints, idempotent turn launches,
question and proposal receipts, stale bases, revision requests, rejection,
human approval, agent self-approval rejection, duplicate/malformed output, and
injected receipt/approval/event failure rollback. The suite additionally proves
the single-active-cycle index, history limits and abandonment, proposal-time ID
reservation without premature canonical rows, all five record lifecycle-only
removals, symmetric edge normalization, complete-cycle proposal
supersede/reject events, and byte-equivalent incremental versus final-snapshot
projection.

Migration tests seed nonempty rows and replayable results for all four M1
command types, then prove fresh and upgraded databases accept and replay all
four planning commands. They compare every seeded M1 row/result and all M1
tables/indices before and after upgrade. A forced failure after the table rebuild
must roll the transaction back to the exact migration-1 schema, rows, indices,
ledger, and replay behavior.

Concurrency tests issue two distinct turns at the same acceptable cycle revision
and prove exactly one commits `launch_pending`; the loser receives
`planning_cycle_revision_conflict` with no write. Restart tests cover a pending
turn before reservation, after a starting reservation, and after terminal
capability/skill reservation. A never-reserved turn may reserve once after
restart. Existing starting or terminal reservations bind the same linked
execution and never activate after restart.

Controlled concurrency tests pause after reservation/before binding and after
binding/before activation, signal Abandon, and prove cancellation prevents
adapter start, terminalizes the exact linked execution/start operation, and
commits one complete abandoned-cycle event with no canonical mutation. A third
case lets activation claim first and proves Abandon waits for the exact running
session to become quiescent before committing. Its fake session blocks in the
event iterator, then attempts to yield a structured PM report and completion
after interrupt. The bridge must fence the exact active entry, close the
session, await that entry's consume-task settlement/removal without self-wait,
and prove zero post-resolution diagnostic writes, domain events, receipt
consumption, or publications. Adapter rejection, audit-barrier failure,
session-close failure, consume-settlement failure, and injected cancellation or
interruption persistence failure must preserve their diagnostics and must not
store a successful Abandon result.

### Runtime and fake harness

Focused tests prove one finite PM execution per human turn, strict structured
output before completion, malformed and duplicate fixture modes, no persistent
native planning session, raw-diagnostic-before-runtime-event ordering, and
completion-without-receipt attention. Reservation tests prove that capability
and skill failures still return a bindable exact execution and that neither a
successful nor failed reservation can start an adapter or consume an event
before binding. Live-process replay tests prove every terminal and nonterminal
reservation resolves its exact execution through the durable start-operation
link. Activation-failure and concurrent-activation tests prove the bound cycle
reaches attention or one running session without a duplicate.

Startup tests use M1 reconciliation for both indistinguishable durable crash
windows: starting/pending/no-handle before adapter invocation and after adapter
return but before running/native-handle persistence. In each case no restarted
path calls `adapter.start`; the operation finishes `unknown`, the execution and
complete planning cycle reach `attention_required`, and the exact link and raw
reconciliation evidence remain auditable. Additional startup cases crash after
durable output and after execution terminalization, proving output replay and
terminal/attention planning reconciliation happen before recovered-session
attachment, fresh pending-launch drain, and command acceptance.

### Web

Reducer tests cover snapshots, incremental events, duplicates, gaps, and
resync. Component tests cover transcript/questions, complete proposal review,
disabled authority, request revision, rejection, approved requirements,
provenance/relationships, keyboard tabs, labels, focus, and live errors.

### Fake-only Todo acceptance

The existing built-process V2 Todo fixture is extended, not replaced. It uses a
test-only fake PM scenario to ask deterministic questions and then propose at
least:

- functional requirements for adding and completing Todo items;
- a UX requirement for keyboard-operable controls;
- an operational persistence requirement;
- one assumption, one decision, one question, and one risk;
- a `depends_on` requirement edge and a decision `constrains` edge;
- provenance to both human turns.

The test approves the exact proposal, restarts the server, reconnects the
browser, and asserts the same intent revision, ledger revision, records,
relationships, provenance, and transcript. It does not run a product task,
open the Board, invoke a real harness, or consume credentials.

The full implementation gate is focused V2 tests/typechecks/builds followed by
`corepack pnpm verify` and the single `v2-e2e` target. A real Claude or Codex PM
smoke test is explicitly outside default verification.

## Settled Interfaces

- Protocol stays `mesh.v2/1`; new variants extend the existing strict unions.
- PM output schema is exactly `mesh.dev/pm-discovery-report/v1`.
- Each human turn maps to exactly one finite `WorkerExecution` assignment.
- `reserveStart` returns an exact non-consuming reservation;
  `activateReserved` runs only after the PM execution binding commits.
- Every reservation, including terminal capability/skill failure, has one
  durable start-operation link to its exact execution and replay follows it.
- After process loss, any existing starting/pending/no-handle reservation uses
  M1 unknown/attention reconciliation and is never activated again; only a turn
  with no start-operation link may reserve and activate freshly.
- `command_results` is rebuilt transactionally in migration 2 with exactly the
  four M1 and four M2 command types; all M1 rows and replay semantics survive.
- One planning launch coordinator arbitrates Abandon against reserve, bind, and
  activation; `cancelReserved` closes only an unactivated linked start, while
  the internal running-only `interruptForPlanning` bridge fences and closes the
  exact active session and joins its consume task before it reports cleanup
  success. The public M1 interrupt command remains unchanged and is not this
  planning bridge.
- `PmReportConsumer` is planning-specific; no generic consumer registry.
- Proposals are complete desired snapshots and approval is all-or-nothing.
- `ProjectIntent`, ledger, record revisions, memberships, edges, proposals,
  receipts, and turns are immutable history.
- New record IDs are server-owned noncanonical proposal reservations and become
  canonical only if that exact proposal is approved.
- One project has at most one nonterminal cycle; assignments contain at most 64
  bounded turns, and project snapshots contain at most 20 bounded cycle views.
- Accepted turns commit the cycle as non-accepting `launch_pending`; drains and
  activation coalesce by turn/execution, and only Abandon remains available.
- `conflicts_with` and `duplicates` normalize lexically as symmetric edges; all
  other edges retain direction.
- Only human command envelopes approve, reject, or abandon.
- M1 domain/runtime streams, snapshots, replay/resync, and HTTP command route
  remain the transport.
- Migration 2 is forward-only; migration 1 is immutable.
- The Board and every M3 concept remain absent.

## Explicit Exclusions Preventing Milestone 3 Leakage

No M2 schema, contract, command, event, service, snapshot, component, or test
may define a milestone, task, dependency readiness calculation, requirement
coverage result, scheduler, execution run, worktree, Developer/QA attempt, or
Board card. Relationship endpoints are limited to requirements and decisions.
The Todo acceptance ends at approved intent and ledger recovery. Any
implementation that needs an M3 object has crossed this milestone's stop
condition and must return to planning rather than adding it.
