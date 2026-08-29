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
- conversation-turn provenance and source-material provenance references;
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
7. **What does rejection do?** It terminalizes that proposal revision without
   changing canonical intent. A new human turn may continue the same planning
   cycle and produce a later proposal.
8. **What happens after a crash between accepting a human turn and launching
   its execution?** The turn remains `launch_pending`. A deterministic drain,
   invoked after the command and during startup, replays the derived execution
   start idempotently and binds the resulting execution.

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
discovering -> execution_active -> awaiting_human
           \-> execution_active -> awaiting_approval
awaiting_approval -> execution_active     (revision request)
awaiting_approval -> approved             (human only)
awaiting_approval -> proposal_rejected    (human only)
execution_active -> attention_required    (invalid/missing output or runtime failure)
attention_required -> execution_active    (new human retry turn)
```

`discovering`, `awaiting_human`, `awaiting_approval`, and
`attention_required` accept another human turn. A turn increments the cycle
revision, is persisted as `launch_pending`, and freezes the latest approved
intent revision, ledger revision, next proposal revision, and prior conversation
through IDs in its PM assignment. Creating a cycle also freezes an explicitly
selected approved PM profile ID and revision; later turns reuse that snapshot
and never silently follow a newer profile. Binding an execution moves it to
`execution_active`. A valid question report moves it to `awaiting_human`; a
valid proposal report moves it to `awaiting_approval`.

`approved` is terminal for the cycle. `proposal_rejected` rejects the latest
proposal but preserves all history; a new cycle is required for later work.
There is no cancel command in M2 because stopping a finite fake execution and
managing provider processes is not needed by the stop condition. Existing M1
execution interruption remains available for diagnostics, but it cannot imply a
planning outcome.

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
- Decision: no extra lifecycle or solution authority is inferred; its approved
  statement constrains requirements only through explicit edges.
- Assumption: `confidence` is `low`, `medium`, or `high`.
- Question: `resolution` is either absent or human-readable text.
- Risk: `severity` is `low`, `medium`, or `high`, with a required `mitigation`.

Proposal content for a new or revised requirement uses status `proposed`.
Approval rewrites only that proposed status to `approved`. Later proposals may
explicitly create immutable `superseded`, `rejected`, or `retired` requirement
revisions. Records are never physically deleted by the planning domain.

Each revision has one or more provenance references. M2 accepts
`conversation_turn` and `source_material` references. A reference records the
source ID and a short rationale; conversation references must belong to the
same project and planning cycle. M2 stores source-material references but does
not ingest files or URLs.

### Ledger revision

`LedgerRevision` is immutable and contains project, revision, proposal,
approval metadata, exact record memberships, and exact edges. Each membership
points to one immutable record revision. An approved proposal may:

- reuse an existing member at its current revision;
- revise an existing record at an expected revision;
- create a new stable record identity and first revision.

Every member in the base ledger must appear in the proposed snapshot. Removal
is expressed by a new rejected, superseded, or retired requirement revision,
not omission. The server allocates IDs for proposed new records when the
proposal is persisted and returns those IDs in the review projection; they are
not canonical ledger members until approval.

Requirement edges are directed and typed exactly as `refines`, `depends_on`,
`conflicts_with`, `supersedes`, or `duplicates`. Both endpoints must be
requirements in the same proposed snapshot. Decision constraint edges are
directed `decision -> requirement` and have the sole type `constrains`.
Duplicate identical edges and self-edges fail validation. Coverage, milestones,
tasks, criteria, and evidence are not legal endpoints in M2.

## PM Execution and Structured Output

### Frozen assignment

The existing `WorkerExecution.assignment` union gains
`PmDiscoveryAssignment`:

```ts
type PmDiscoveryAssignment = {
  kind: 'pm_discovery';
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

`PmReportConsumer.consume(execution, runtimeEvent)` is the only consumer. It:

1. checks the event and execution project match;
2. checks assignment kind and exact cycle, turn, cycle revision, proposal
   revision, and schema bindings;
3. parses the report strictly and resolves all record references;
4. validates base membership, record types/revisions, provenance ownership,
   relationship legality, and proposal completeness;
5. in one `BEGIN IMMEDIATE` transaction inserts the immutable receipt, PM turn,
   questions or proposal, updates the cycle, appends the ordered domain event,
   and commits;
6. publishes only the committed event.

The receipt key is the execution ID. Re-delivery of the same output digest is a
no-op. A second different output for the same execution is rejected and cannot
replace the first. Malformed or wrongly bound output stores a rejected receipt
and moves only the planning cycle to `attention_required`; it cannot create a
proposal or canonical revision. If any persistence write or event append fails,
the whole receipt transaction rolls back and nothing is published. The central
audit barrier still applies to raw runtime input before this consumer runs.

Completion without one accepted receipt is not planning success. When the
execution ends, a planning-specific terminal check moves the cycle to
`attention_required` if no valid report was consumed.

## Persistence and Transaction Ordering

Migration `002_intent_ledger.sql` is appended to the V2 migration ledger;
`001_foundation.sql` is never edited. It adds:

- `planning_cycles`;
- `planning_turns`;
- `planning_questions`;
- `planning_proposals`;
- `pm_output_receipts`;
- `project_intent_revisions` and `project_intent_provenance`;
- `ledger_records`, `ledger_record_revisions`, and
  `ledger_record_revision_provenance`;
- `ledger_revisions` and `ledger_revision_members`;
- `ledger_revision_relationships`.

Foreign keys preserve project, cycle, execution, turn, proposal, record, and
revision ownership. Unique constraints enforce one turn sequence, one proposal
revision, one output receipt per execution, one record revision, one project
intent revision, one ledger revision, one record membership per ledger
revision, and one normalized relationship per ledger revision. JSON payloads
are canonicalized before storage and parsed through shared contracts on read.

Human turn acceptance orders writes as follows:

1. reserve or replay the human command;
2. validate the current cycle and canonical base;
3. append the human turn and set `launch_pending`;
4. append the ordered `planning_cycle.changed` event;
5. store the command result and commit;
6. publish the event;
7. drain the pending turn through a derived idempotent M1 execution-start
   command, then bind its execution in a second transaction and publish the
   committed binding event.

Startup performs the same pending-launch drain after M1 execution
reconciliation and before accepting commands. A crash at any boundary either
replays a stored command result or finds a durable pending turn; it cannot
silently lose or multiply the execution.

Proposal approval uses one immediate transaction:

1. replay-check the command and assert human actor;
2. re-read the exact cycle, proposal, current intent, current ledger, record
   revisions, and relationship endpoints;
3. allocate new record identities, insert all new immutable record revisions
   and provenance;
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
  feedback.

Stable failures include not found, stale cycle, stale proposal, stale canonical
base, proposal invalid, output invalid, and approval forbidden. Exact codes are
declared in `packages/v2-contracts` and mapped by the existing `/api/v2/commands`
route; transport does not invent lifecycle rules.

The domain event union adds:

- `planning_cycle.changed`, carrying the current cycle plus only the newly
  appended turn/questions/proposal needed for incremental projection;
- `intent_ledger.approved`, carrying the approved intent/ledger projection and
  terminal cycle/proposal state.

The existing project sequence orders these with M1 project/profile/execution
events. The runtime stream adds only
`worker_execution.structured_output`; raw adapter input and its diagnostic are
persisted before publication exactly as in M1.

`V2ProjectSnapshot` adds planning cycles with turns, questions, and proposal
history plus `intentLedger`, which is absent before first approval. The
Requirements projection is therefore reconstructed entirely from one snapshot
and ordered domain events. Reconnect uses the existing subscription message,
domain/runtime cursors, retained windows, gap detection, and resync route. No
new socket or transport is introduced.

## Recovery and Reverse States

- **Start/restart:** pending human turns are re-drained idempotently; M1
  execution reconciliation runs first. A valid already-consumed receipt is not
  consumed again.
- **Question/answer:** questions remain immutable when the next human turn is
  added. Answers are conversation turns, not in-place question edits.
- **Proposal/revision:** a human turn from `awaiting_approval` requests a new
  complete proposal. The old proposal remains reviewable and becomes
  `superseded` only when the new one is durably accepted.
- **Approve/reject:** approval creates one new canonical snapshot; rejection
  creates none. Both target exact revisions and are idempotent.
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
- a labeled multiline human-message field and send button;
- explicit empty, loading, disconnected, stale, execution-active,
  attention-required, rejected, and approved states.

Request revision sends a normal human turn; it never sends a partial approval.
Approve and Reject remain disabled whenever the projection is disconnected,
stale, not on the latest proposal, or already submitting. Errors are rendered
in an `aria-live` region and focus returns to the relevant heading or input.

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
human-only envelopes, event coherence, and snapshot round trips.

### Persistence and domain

Focused tests cover fresh migration, upgrade from exact migration 1, unchanged
`001_foundation.sql`, immutable intent/record/ledger revisions, complete
membership, provenance, relationship constraints, idempotent turn launches,
question and proposal receipts, stale bases, revision requests, rejection,
human approval, agent self-approval rejection, duplicate/malformed output, and
injected receipt/approval/event failure rollback.

### Runtime and fake harness

Focused tests prove one finite PM execution per human turn, strict structured
output before completion, malformed and duplicate fixture modes, no persistent
native planning session, raw-diagnostic-before-runtime-event ordering, and
completion-without-receipt attention.

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
- `PmReportConsumer` is planning-specific; no generic consumer registry.
- Proposals are complete desired snapshots and approval is all-or-nothing.
- `ProjectIntent`, ledger, record revisions, memberships, edges, proposals,
  receipts, and turns are immutable history.
- Canonical IDs are server-owned; proposal-local keys resolve when a proposal
  is persisted.
- Only human command envelopes approve or reject.
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
