import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import type {
  ApprovedIntentLedger,
  ApprovedDeliveryPlan,
  AbandonPlanningCycleCommand,
  ApprovePlanProposalCommand,
  DeliveryPlanPlanningCycleView,
  DeliveryPlanProposal,
  LedgerRecordContent,
  PlanningCycleView,
  PlanningProposal,
  ProposedTaskRef,
  ProposedLedgerEndpoint,
  RejectPlanProposalCommand,
  SubmitPlanTurnCommand,
  WorkerExecution,
  WorkerProfileSummary,
} from '@mesh/v2-contracts';

import './intent-ledger.css';
import './planning-board.css';

export type PlanningConnection =
  | { status: 'ready' }
  | { status: 'loading' }
  | { status: 'disconnected' | 'stale'; message: string };

type ProfileSelection = Pick<WorkerProfileSummary, 'profileId'> & {
  profileRevision: number;
};

function latestProposal(cycle: PlanningCycleView | undefined) {
  return cycle?.proposals.at(-1);
}

function humanize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function list(values: readonly string[]) {
  return values.length === 0 ? 'None' : values.join(' · ');
}

function recordMetadata(content: LedgerRecordContent) {
  if (content.type === 'requirement')
    return `${humanize(content.kind)} · ${humanize(content.status)} · ${humanize(content.priority)}`;
  if (content.type === 'assumption')
    return `${humanize(content.status)} · ${humanize(content.confidence)}`;
  if (content.type === 'question')
    return `${humanize(content.status)}${content.resolution ? ` · ${content.resolution}` : ''}`;
  if (content.type === 'risk')
    return `${humanize(content.status)} · ${humanize(content.severity)} · ${content.mitigation}`;
  return humanize(content.status);
}

function recordContent(content: LedgerRecordContent) {
  return (
    <>
      <p>
        {humanize(content.type)} · {content.statement}
      </p>
      <p>{content.rationale}</p>
      <p>{recordMetadata(content)}</p>
    </>
  );
}

function proposalCard(
  proposal: PlanningProposal,
  approvedIntentLedger: ApprovedIntentLedger | null,
) {
  const endpoint = (value: ProposedLedgerEndpoint) => {
    const member = proposal.records.find((record) =>
      'proposalKey' in value
        ? record.operation === 'create' && record.key === value.proposalKey
        : record.operation !== 'create' && record.recordId === value.recordId,
    );
    const approvedRecord =
      member?.operation === 'reuse'
        ? approvedIntentLedger?.records.find(
            (record) =>
              record.recordId === member.recordId &&
              record.revision === member.expectedRevision,
          )
        : undefined;
    const content =
      member?.operation === 'create' || member?.operation === 'revise'
        ? member.content
        : approvedRecord?.content;
    const identity =
      'proposalKey' in value ? value.proposalKey : value.recordId;
    return content
      ? `${identity} · ${humanize(content.type)} · ${content.statement}`
      : identity;
  };
  return (
    <article
      className="intent-ledger-card"
      aria-labelledby={`proposal-heading-${proposal.id}`}
    >
      <h3 id={`proposal-heading-${proposal.id}`}>
        Proposal revision {proposal.revision} · {proposal.lifecycle}
      </h3>
      <p>{proposal.summary}</p>
      <section aria-label={`Proposed intent revision ${proposal.revision}`}>
        <h4>Proposed intent</h4>
        <dl>
          <div>
            <dt>Goal</dt>
            <dd>{proposal.projectIntent.goal}</dd>
          </div>
          <div>
            <dt>Target users</dt>
            <dd>{list(proposal.projectIntent.targetUsers)}</dd>
          </div>
          <div>
            <dt>Desired capabilities</dt>
            <dd>{list(proposal.projectIntent.desiredCapabilities)}</dd>
          </div>
          <div>
            <dt>Constraints</dt>
            <dd>{list(proposal.projectIntent.constraints)}</dd>
          </div>
          <div>
            <dt>Non-goals</dt>
            <dd>{list(proposal.projectIntent.nonGoals)}</dd>
          </div>
          <div>
            <dt>Success conditions</dt>
            <dd>{list(proposal.projectIntent.successConditions)}</dd>
          </div>
          <div>
            <dt>Rationale</dt>
            <dd>{proposal.projectIntent.rationale}</dd>
          </div>
        </dl>
      </section>
      <dl>
        <div>
          <dt>Intent changes</dt>
          <dd>
            {proposal.diff.intentChanges.length === 0
              ? 'No intent changes'
              : proposal.diff.intentChanges.map(humanize).join(', ')}
          </dd>
        </div>
        <div>
          <dt>Record changes</dt>
          <dd>
            Create {proposal.diff.recordChanges.create} · revise{' '}
            {proposal.diff.recordChanges.revise} · reuse{' '}
            {proposal.diff.recordChanges.reuse}
          </dd>
        </div>
        <div>
          <dt>Relationship changes</dt>
          <dd>
            Added {proposal.diff.relationshipChanges.added.length} · removed{' '}
            {proposal.diff.relationshipChanges.removed.length}
          </dd>
        </div>
      </dl>
      {proposal.diff.relationshipChanges.added.length ||
      proposal.diff.relationshipChanges.removed.length ? (
        <section aria-label="Relationship diff">
          <h4>Relationship diff</h4>
          <ul>
            {proposal.diff.relationshipChanges.added.map((relationship) => (
              <li
                key={`added-${relationship.kind}-${endpoint(relationship.from)}-${endpoint(relationship.to)}`}
              >
                Added: {endpoint(relationship.from)}{' '}
                {humanize(relationship.kind).toLowerCase()}{' '}
                {endpoint(relationship.to)}
              </li>
            ))}
            {proposal.diff.relationshipChanges.removed.map((relationship) => (
              <li
                key={`removed-${relationship.kind}-${endpoint(relationship.from)}-${endpoint(relationship.to)}`}
              >
                Removed: {endpoint(relationship.from)}{' '}
                {humanize(relationship.kind).toLowerCase()}{' '}
                {endpoint(relationship.to)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Proposal provenance">
        <h4>Provenance</h4>
        <ul>
          {proposal.projectIntent.provenance.map((source) => (
            <li key={`${source.turnId}-${source.rationale}`}>
              {source.turnId} · {source.rationale}
            </li>
          ))}
        </ul>
      </section>
      <section
        aria-label={`Proposed records for revision ${proposal.revision}`}
      >
        <h4>Proposed records</h4>
        {proposal.records.length === 0 ? (
          <p>No proposed records.</p>
        ) : (
          <ul>
            {proposal.records.map((record) => (
              <li key={record.recordId}>
                <p>
                  {record.operation === 'create'
                    ? `Create · ${record.key}`
                    : record.operation === 'revise'
                      ? `Revise · expected revision ${record.expectedRevision}`
                      : `Reuse · approved revision ${record.expectedRevision}`}
                </p>
                <p>Record ID {record.recordId}</p>
                {record.operation === 'reuse' ? (
                  (() => {
                    const approvedRecord = approvedIntentLedger?.records.find(
                      (candidate) =>
                        candidate.recordId === record.recordId &&
                        candidate.revision === record.expectedRevision,
                    );
                    return approvedRecord ? (
                      <>
                        {recordContent(approvedRecord.content)}
                        <ul>
                          {approvedRecord.provenance.map((source) => (
                            <li key={`${source.turnId}-${source.rationale}`}>
                              {source.turnId} · {source.rationale}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p>Approved record revision unavailable.</p>
                    );
                  })()
                ) : (
                  <>
                    {recordContent(record.content)}
                    <ul>
                      {record.provenance.map((source) => (
                        <li key={`${source.turnId}-${source.rationale}`}>
                          {source.turnId} · {source.rationale}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section
        aria-label={`Proposed relationships for revision ${proposal.revision}`}
      >
        <h4>Final relationships</h4>
        {proposal.relationships.length === 0 ? (
          <p>No final relationships.</p>
        ) : (
          <ul>
            {proposal.relationships.map((relationship) => (
              <li
                key={`${relationship.kind}-${endpoint(relationship.from)}-${endpoint(relationship.to)}`}
              >
                {endpoint(relationship.from)}{' '}
                {humanize(relationship.kind).toLowerCase()}{' '}
                {endpoint(relationship.to)}
              </li>
            ))}
          </ul>
        )}
      </section>
      {proposal.rejectionFeedback ? (
        <p>Rejection feedback: {proposal.rejectionFeedback}</p>
      ) : null}
    </article>
  );
}

export function PlanningPane({
  cycle,
  connection,
  profiles,
  submitting,
  error,
  historyTruncated = false,
  historyLimitReached = false,
  headingLabel = 'PM Chat',
  recovery,
  executions = [],
  approvedIntentLedger = null,
  onSubmitTurn,
  onApprove,
  onReject,
  onAbandon,
}: {
  cycle?: PlanningCycleView;
  connection: PlanningConnection;
  profiles: readonly WorkerProfileSummary[];
  submitting: boolean;
  error?: string;
  historyTruncated?: boolean;
  historyLimitReached?: boolean;
  headingLabel?: string;
  recovery?:
    | { kind: 'ambiguous_start'; operation: string }
    | { kind: 'retryable'; message: string };
  executions?: readonly WorkerExecution[];
  approvedIntentLedger?: ApprovedIntentLedger | null;
  onSubmitTurn: (message: string, profile?: ProfileSelection) => void;
  onApprove: (proposalId: PlanningProposal['id']) => void;
  onReject: (proposalId: PlanningProposal['id'], feedback: string) => void;
  onAbandon: (cycleId: PlanningCycleView['cycle']['id']) => void;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState('');
  const [profileId, setProfileId] = useState(profiles[0]?.profileId ?? '');
  const [requestingRevision, setRequestingRevision] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionFeedback, setRejectionFeedback] = useState('');
  const lifecycle = cycle?.cycle.lifecycle;
  const proposal = latestProposal(cycle);
  const latestTurn = cycle?.turns.at(-1);
  const latestExecutionId = latestTurn?.executionId;
  const latestExecution = executions.find(
    (execution) => execution.id === latestExecutionId,
  );
  const connected = connection.status === 'ready';
  const selected = profiles.find((profile) => profile.profileId === profileId);
  const commandDisabled = !connected || submitting || (!cycle && !selected);
  const accepting =
    lifecycle === undefined ||
    lifecycle === 'discovering' ||
    lifecycle === 'awaiting_human';
  const proposalReady =
    lifecycle === 'awaiting_approval' &&
    proposal?.lifecycle === 'awaiting_approval';
  const retryable =
    lifecycle === 'attention_required' && recovery?.kind === 'retryable';
  const canShowForm =
    accepting || (proposalReady && requestingRevision) || retryable;
  const nonterminal =
    lifecycle !== undefined &&
    !['approved', 'proposal_rejected', 'abandoned'].includes(lifecycle);
  const blockedReason = !connected
    ? connection.status === 'loading'
      ? 'Planning is loading.'
      : connection.message
    : submitting
      ? 'A planning command is in progress.'
      : undefined;

  useEffect(() => {
    if (error) headingRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!profiles.some((profile) => profile.profileId === profileId))
      setProfileId(profiles[0]?.profileId ?? '');
  }, [profileId, profiles]);
  useEffect(() => {
    setDraft('');
  }, [
    cycle?.cycle.id,
    cycle?.cycle.revision,
    lifecycle,
    latestTurn?.id,
    latestTurn?.launchState,
  ]);
  useEffect(() => {
    setRequestingRevision(false);
    setRejecting(false);
    setRejectionFeedback('');
  }, [lifecycle, proposal?.id, proposal?.revision]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || commandDisabled) return;
    if (cycle) {
      onSubmitTurn(message);
    } else if (selected) {
      onSubmitTurn(message, {
        profileId: selected.profileId,
        profileRevision: selected.approvedRevision,
      });
    }
  }

  const status =
    lifecycle === 'launch_pending'
      ? 'Starting project manager…'
      : lifecycle === 'execution_active'
        ? 'Project manager is working.'
        : lifecycle === 'approved'
          ? 'Proposal approved.'
          : lifecycle === 'proposal_rejected'
            ? 'Proposal rejected.'
            : lifecycle === 'abandoned'
              ? 'This planning cycle was abandoned.'
              : undefined;

  return (
    <section className="intent-ledger-pane" aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        {headingLabel}
      </h2>
      {error ? (
        <p role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
      {blockedReason ? (
        <p role="status" aria-live="polite">
          {blockedReason}
        </p>
      ) : null}
      {status ? (
        <p role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
      {historyTruncated ? <p>Planning snapshot history is truncated.</p> : null}
      {historyLimitReached ? (
        <p>
          This cycle reached its history limit. Abandon it to begin a new cycle.
        </p>
      ) : null}
      {cycle ? (
        <ol aria-label="Planning conversation">
          {cycle.turns.map((turn) => (
            <li key={turn.id}>
              <strong>
                {turn.actor === 'pm' ? 'Project manager' : 'You'}:
              </strong>{' '}
              {turn.message}
            </li>
          ))}
        </ol>
      ) : (
        <p>Describe the outcome you want to discover.</p>
      )}
      {cycle?.questions.length ? (
        <section aria-label="Planning questions">
          <h3>Questions</h3>
          {cycle.questions.map((question) => (
            <article key={question.id} className="intent-ledger-card">
              <h4>{question.prompt}</h4>
              <p>{question.rationale}</p>
              {question.choices ? (
                <p>
                  {question.choices.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      disabled={commandDisabled || !canShowForm}
                      onClick={() => setDraft(choice)}
                    >
                      {choice}
                    </button>
                  ))}
                </p>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
      {cycle?.proposals.map((candidate) => (
        <div key={candidate.id}>
          {proposalCard(candidate, approvedIntentLedger)}
        </div>
      ))}
      {proposalReady ? (
        <p className="intent-ledger-actions">
          <button
            type="button"
            disabled={commandDisabled}
            onClick={() => onApprove(proposal.id)}
          >
            Approve proposal
          </button>
          <button
            type="button"
            disabled={commandDisabled}
            onClick={() => setRequestingRevision(true)}
          >
            Request revision
          </button>
          <button
            type="button"
            disabled={commandDisabled}
            onClick={() => setRejecting(true)}
          >
            Reject proposal
          </button>
        </p>
      ) : null}
      {proposalReady && rejecting ? (
        <section aria-label="Reject proposal">
          <label htmlFor="rejection-feedback">Rejection feedback</label>
          <textarea
            id="rejection-feedback"
            value={rejectionFeedback}
            onChange={(event) => setRejectionFeedback(event.target.value)}
            disabled={commandDisabled}
            required
          />
          <button
            type="button"
            disabled={commandDisabled || !rejectionFeedback.trim()}
            onClick={() => onReject(proposal.id, rejectionFeedback.trim())}
          >
            Confirm rejection
          </button>
        </section>
      ) : null}
      {canShowForm ? (
        <form onSubmit={submit} aria-label="Send a message to project manager">
          {!cycle ? (
            <fieldset disabled={commandDisabled}>
              <legend>Project manager profile</legend>
              <label htmlFor="pm-profile">Project manager profile</label>
              <select
                id="pm-profile"
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.displayName} · revision {profile.approvedRevision}
                  </option>
                ))}
              </select>
              {profiles.length === 0 ? (
                <p>No project manager profiles are available.</p>
              ) : null}
            </fieldset>
          ) : null}
          <label htmlFor="pm-message">Message to project manager</label>
          <textarea
            id="pm-message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={commandDisabled}
          />
          <button type="submit" disabled={commandDisabled || !draft.trim()}>
            {requestingRevision ? 'Send revision request' : 'Send message'}
          </button>
        </form>
      ) : null}
      {lifecycle === 'attention_required' ? (
        <section aria-label="Planning recovery">
          {recovery?.kind === 'retryable' ? (
            <p>{recovery.message}</p>
          ) : (
            <>
              <p>Mesh did not retry the execution after restart.</p>
              {recovery?.kind === 'ambiguous_start' ? (
                <p>Operation {recovery.operation}</p>
              ) : null}
            </>
          )}
          {latestExecutionId ? <p>Execution {latestExecutionId}</p> : null}
          {latestExecution?.failure ? (
            <p>{latestExecution.failure.message}</p>
          ) : null}
          {recovery?.kind !== 'retryable' ? (
            <p>Abandon this cycle to start a new one.</p>
          ) : null}
        </section>
      ) : null}
      {nonterminal ? (
        <button
          type="button"
          disabled={commandDisabled}
          onClick={() => cycle && onAbandon(cycle.cycle.id)}
        >
          Abandon cycle
        </button>
      ) : null}
    </section>
  );
}

type DeliveryPlanBase = Pick<ApprovedDeliveryPlan, 'plan'>;

function proposalMemberName(
  member:
    | DeliveryPlanProposal['proposedPlan']['milestones'][number]
    | DeliveryPlanProposal['proposedPlan']['tasks'][number],
) {
  if (member.operation === 'create') return member.key;
  return 'milestoneId' in member ? member.milestoneId : member.taskId;
}

function proposalRefName(ref: ProposedTaskRef) {
  return ref.kind === 'proposal' ? ref.key : ref.taskId;
}

function DeliveryProposalCard({
  proposal,
}: {
  proposal: DeliveryPlanProposal;
}) {
  return (
    <article
      className="planning-board-card"
      aria-labelledby={`delivery-proposal-${proposal.id}`}
    >
      <h3 id={`delivery-proposal-${proposal.id}`}>
        Proposal revision {proposal.revision} · {humanize(proposal.lifecycle)}
      </h3>
      <p>{proposal.proposedPlan.summary}</p>
      <p>
        Intent revision {proposal.base.projectIntentRevision} · requirement
        ledger revision {proposal.base.ledgerRevision} · delivery plan{' '}
        {proposal.base.deliveryPlan.revision === null
          ? 'not yet approved'
          : `revision ${proposal.base.deliveryPlan.revision}`}
      </p>
      <section
        aria-label={`Milestones in proposal revision ${proposal.revision}`}
      >
        <h4>Milestones</h4>
        <ol>
          {proposal.proposedPlan.milestones.map((milestone) => (
            <li key={proposalMemberName(milestone)}>
              <strong>
                {milestone.operation === 'reuse'
                  ? milestone.milestoneId
                  : milestone.content.title}
              </strong>{' '}
              · {humanize(milestone.operation)}
              {milestone.operation === 'reuse'
                ? ` · expected revision ${milestone.expectedRevision}`
                : milestone.operation === 'revise'
                  ? ` · expected revision ${milestone.expectedRevision} · ${milestone.lifecycle}`
                  : null}
              {milestone.operation !== 'reuse' ? (
                <>
                  <p>{milestone.content.outcome}</p>
                  <p>Stop condition: {milestone.content.stopCondition}</p>
                  <p>Exclusions: {list(milestone.content.exclusions)}</p>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      <section aria-label={`Tasks in proposal revision ${proposal.revision}`}>
        <h4>Tasks</h4>
        <ol>
          {proposal.proposedPlan.tasks.map((task) => (
            <li key={proposalMemberName(task)}>
              <strong>
                {task.operation === 'reuse' ? task.taskId : task.content.title}
              </strong>{' '}
              · {humanize(task.operation)}
              {task.operation === 'reuse'
                ? ` · contract revision ${task.expectedContractRevision} · current revision ${task.expectedCurrentRevision}`
                : task.operation === 'revise'
                  ? ` · contract revision ${task.expectedContractRevision} · current revision ${task.expectedCurrentRevision} · ${task.lifecycle}`
                  : null}
              {task.operation !== 'reuse' ? (
                <>
                  <p>{task.content.outcome}</p>
                  <p>Acceptance: {list(task.content.acceptanceCriteria)}</p>
                  <p>Verification: {list(task.content.verificationCriteria)}</p>
                  <p>
                    Priority {task.content.priority} · labels{' '}
                    {list(task.content.labels)}
                  </p>
                  <p>Owned surfaces: {list(task.content.ownedSurfaces)}</p>
                  <p>
                    Prohibited surfaces: {list(task.content.prohibitedSurfaces)}
                  </p>
                  <p>
                    Expected artifacts: {list(task.content.expectedArtifacts)}
                  </p>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      <section
        aria-label={`Dependencies in proposal revision ${proposal.revision}`}
      >
        <h4>Dependencies</h4>
        {proposal.proposedPlan.dependencies.length === 0 ? (
          <p>No dependencies.</p>
        ) : (
          <ul>
            {proposal.proposedPlan.dependencies.map((dependency) => (
              <li
                key={
                  dependency.operation === 'create'
                    ? dependency.key
                    : dependency.dependencyId
                }
              >
                {dependency.operation === 'create'
                  ? `${dependency.key}: ${proposalRefName(dependency.prerequisite)} before ${proposalRefName(dependency.dependent)}`
                  : `${humanize(dependency.operation)} ${dependency.dependencyId} · expected revision ${dependency.expectedRevision}${dependency.operation === 'revise' ? ` · ${dependency.lifecycle}` : ''}`}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section
        aria-label={`Requirement traces in proposal revision ${proposal.revision}`}
      >
        <h4>Requirement traceability</h4>
        <ul>
          {proposal.proposedPlan.traces.map((trace, index) => (
            <li key={`${trace.kind}-${trace.requirement.recordId}-${index}`}>
              {humanize(trace.kind)} ·{' '}
              {trace.kind === 'milestone_covers'
                ? trace.milestone.kind === 'proposal'
                  ? trace.milestone.key
                  : trace.milestone.milestoneId
                : trace.task.kind === 'proposal'
                  ? trace.task.key
                  : trace.task.taskId}{' '}
              · requirement {trace.requirement.recordId}
              {' · '}revision {trace.requirement.recordRevision}
            </li>
          ))}
        </ul>
      </section>
      <dl>
        {(['milestones', 'tasks', 'dependencies'] as const).map((kind) => (
          <div key={kind}>
            <dt>{humanize(kind)} diff</dt>
            <dd>
              Create {proposal.diff[kind].create} · reuse{' '}
              {proposal.diff[kind].reuse} · revise {proposal.diff[kind].revise}{' '}
              · retire {proposal.diff[kind].retire} · reactivate{' '}
              {proposal.diff[kind].reactivate}
            </dd>
          </div>
        ))}
        <div>
          <dt>Trace diff</dt>
          <dd>
            Create {proposal.diff.traceCreateCount} · remove{' '}
            {proposal.diff.traceRemoveCount}
          </dd>
        </div>
      </dl>
      {proposal.decision.kind === 'rejected' ? (
        <p>Rejection feedback: {proposal.decision.feedback}</p>
      ) : null}
    </article>
  );
}

export function DeliveryPlanningPane({
  projectId,
  cycle,
  approvedIntentLedger,
  deliveryPlan,
  planStale,
  connection,
  profiles,
  submitting,
  error,
  historyLimitReached = false,
  recovery,
  onSubmit,
  onApprove,
  onReject,
  onAbandon,
}: {
  projectId: string;
  cycle?: DeliveryPlanPlanningCycleView;
  approvedIntentLedger: ApprovedIntentLedger | null;
  deliveryPlan: DeliveryPlanBase | null;
  planStale: boolean;
  connection: PlanningConnection;
  profiles: readonly WorkerProfileSummary[];
  submitting: boolean;
  error?: string;
  historyLimitReached?: boolean;
  recovery?:
    | { kind: 'ambiguous_start'; operation: string }
    | { kind: 'retryable'; message: string };
  onSubmit: (command: SubmitPlanTurnCommand) => void;
  onApprove: (command: ApprovePlanProposalCommand) => void;
  onReject: (command: RejectPlanProposalCommand) => void;
  onAbandon: (command: AbandonPlanningCycleCommand) => void;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [profileId, setProfileId] = useState(profiles[0]?.profileId ?? '');
  const [requestingRevision, setRequestingRevision] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const lifecycle = cycle?.cycle.lifecycle;
  const proposal = cycle?.deliveryPlanProposals.at(-1);
  const [selectedProposalRevision, setSelectedProposalRevision] = useState(
    proposal?.revision ?? 0,
  );
  const selectedProposal =
    cycle?.deliveryPlanProposals.find(
      ({ revision }) => revision === selectedProposalRevision,
    ) ?? proposal;
  const connected = connection.status === 'ready';
  const selectedProfile = profiles.find(
    ({ profileId: id }) => id === profileId,
  );
  const approvedRequirements =
    approvedIntentLedger?.records.filter(
      ({ content }) =>
        content.type === 'requirement' && content.status === 'approved',
    ) ?? [];
  const canStart =
    connected &&
    !submitting &&
    approvedIntentLedger !== null &&
    approvedRequirements.length > 0 &&
    selectedProfile !== undefined &&
    !cycle;
  const commandDisabled = !connected || submitting;
  const awaitingApproval =
    lifecycle === 'awaiting_approval' &&
    proposal?.lifecycle === 'awaiting_approval';
  const retryable =
    lifecycle === 'attention_required' && recovery?.kind === 'retryable';
  const canContinue =
    !historyLimitReached &&
    (lifecycle === 'discovering' ||
      lifecycle === 'awaiting_human' ||
      retryable ||
      (awaitingApproval && requestingRevision));
  const nonterminal =
    lifecycle !== undefined &&
    !['approved', 'proposal_rejected', 'abandoned'].includes(lifecycle);

  useEffect(() => {
    if (error) headingRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!profiles.some(({ profileId: id }) => id === profileId))
      setProfileId(profiles[0]?.profileId ?? '');
  }, [profileId, profiles]);
  useEffect(() => {
    setSelectedProposalRevision(proposal?.revision ?? 0);
  }, [cycle?.cycle.id, proposal?.id, proposal?.revision]);

  function openStart() {
    const replacing = deliveryPlan !== null;
    setDraft(
      replacing
        ? 'Revise the approved delivery plan against the current intent and requirement ledger.'
        : 'Propose a delivery plan for the approved intent and requirement ledger.',
    );
    setStartOpen(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || commandDisabled) return;
    if (cycle) {
      onSubmit({
        type: 'planning_cycle.submit_plan_turn',
        projectId,
        planningCycleId: cycle.cycle.id,
        expectedCycleRevision: cycle.cycle.revision,
        message,
      });
      return;
    }
    if (!canStart || !selectedProfile || !approvedIntentLedger) return;
    onSubmit({
      type: 'planning_cycle.submit_plan_turn',
      projectId,
      expectedCycleRevision: null,
      profileId: selectedProfile.profileId,
      profileRevision: selectedProfile.approvedRevision,
      expectedProjectIntentId: approvedIntentLedger.projectIntent.id,
      expectedProjectIntentRevision:
        approvedIntentLedger.projectIntent.revision,
      expectedLedgerId: approvedIntentLedger.ledger.id,
      expectedLedgerRevision: approvedIntentLedger.ledger.revision,
      expectedDeliveryPlan: deliveryPlan
        ? { id: deliveryPlan.plan.id, revision: deliveryPlan.plan.revision }
        : { id: null, revision: null },
      message,
    });
  }

  function approveProposal() {
    if (!cycle || !proposal) return;
    onApprove({
      type: 'plan_proposal.approve',
      projectId,
      planningCycleId: cycle.cycle.id,
      expectedCycleRevision: cycle.cycle.revision,
      proposalId: proposal.id,
      expectedProposalRevision: proposal.revision,
      expectedProjectIntentId: proposal.base.projectIntentId,
      expectedProjectIntentRevision: proposal.base.projectIntentRevision,
      expectedLedgerId: proposal.base.ledgerId,
      expectedLedgerRevision: proposal.base.ledgerRevision,
      expectedDeliveryPlan: proposal.base.deliveryPlan,
    });
  }

  function rejectProposal() {
    if (!cycle || !proposal || !feedback.trim()) return;
    onReject({
      type: 'plan_proposal.reject',
      projectId,
      planningCycleId: cycle.cycle.id,
      expectedCycleRevision: cycle.cycle.revision,
      proposalId: proposal.id,
      expectedProposalRevision: proposal.revision,
      feedback: feedback.trim(),
    });
  }

  const startLabel = deliveryPlan
    ? planStale
      ? 'Replan current requirements'
      : 'Replace plan'
    : 'Plan delivery';
  const status =
    lifecycle === 'launch_pending'
      ? 'Starting project manager…'
      : lifecycle === 'execution_active'
        ? 'Project manager is working.'
        : lifecycle === 'approved'
          ? 'Delivery plan approved.'
          : lifecycle === 'proposal_rejected'
            ? 'Plan proposal rejected.'
            : lifecycle === 'abandoned'
              ? 'This planning cycle was abandoned.'
              : undefined;

  return (
    <section className="planning-board-pane" aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        Planning
      </h2>
      {error ? <p role="alert">{error}</p> : null}
      {connection.status === 'loading' ? (
        <p role="status">Planning is loading.</p>
      ) : null}
      {connection.status === 'disconnected' || connection.status === 'stale' ? (
        <p role="status">{connection.message}</p>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {deliveryPlan ? (
        <p>
          Approved delivery plan revision {deliveryPlan.plan.revision}
          {planStale ? ' · stale' : ' · current'}
        </p>
      ) : (
        <p>No delivery plan is approved.</p>
      )}
      {planStale ? <p role="status">Approved plan is stale.</p> : null}
      {historyLimitReached ? (
        <p>
          This cycle reached its history limit. Abandon it to begin a new cycle.
        </p>
      ) : null}
      {lifecycle === 'attention_required' ? (
        <section aria-label="Planning recovery">
          {recovery?.kind === 'retryable' ? (
            <p>{recovery.message}</p>
          ) : (
            <>
              <p>
                Mesh did not retry the delivery planning execution after
                restart.
              </p>
              {recovery?.kind === 'ambiguous_start' ? (
                <p>Operation {recovery.operation}</p>
              ) : null}
              <p>Abandon this cycle to start a new one.</p>
            </>
          )}
        </section>
      ) : null}
      {!cycle &&
      (!approvedIntentLedger || approvedRequirements.length === 0) ? (
        <p>
          Approve at least one current requirement before planning delivery.
        </p>
      ) : null}
      {!cycle && profiles.length === 0 ? (
        <p>No compatible PM profiles are available.</p>
      ) : null}
      {!cycle ? (
        <button type="button" disabled={!canStart} onClick={openStart}>
          {startLabel}
        </button>
      ) : null}
      {cycle ? (
        <ol aria-label="Delivery planning conversation">
          {cycle.turns.map((turn) => (
            <li key={turn.id}>
              <strong>
                {turn.actor === 'pm' ? 'Project manager' : 'You'}:
              </strong>{' '}
              {turn.message}
            </li>
          ))}
        </ol>
      ) : null}
      {cycle?.questions.length ? (
        <section aria-label="Delivery planning questions">
          <h3>Questions</h3>
          {cycle.questions.map((question) => (
            <article key={question.id} className="planning-board-card">
              <h4>{question.prompt}</h4>
              <p>{question.rationale}</p>
              {question.choices?.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  disabled={commandDisabled || !canContinue}
                  onClick={() => setDraft(choice)}
                >
                  {choice}
                </button>
              ))}
            </article>
          ))}
        </section>
      ) : null}
      {cycle?.deliveryPlanProposals.length ? (
        <section aria-label="Plan proposal revision history">
          <label htmlFor="delivery-proposal-revision">Proposal revision</label>
          <select
            id="delivery-proposal-revision"
            value={selectedProposal?.revision}
            onChange={(event) =>
              setSelectedProposalRevision(Number(event.target.value))
            }
          >
            {cycle.deliveryPlanProposals.map((candidate) => (
              <option key={candidate.id} value={candidate.revision}>
                Revision {candidate.revision} · {humanize(candidate.lifecycle)}
              </option>
            ))}
          </select>
          {selectedProposal ? (
            <DeliveryProposalCard proposal={selectedProposal} />
          ) : null}
        </section>
      ) : null}
      {awaitingApproval && proposal ? (
        <div className="planning-board-actions">
          <button
            type="button"
            disabled={commandDisabled}
            onClick={approveProposal}
          >
            Approve full plan
          </button>
          <button
            type="button"
            disabled={commandDisabled}
            onClick={() => {
              setRequestingRevision(true);
              setDraft('');
            }}
          >
            Request revision
          </button>
          <button
            type="button"
            disabled={commandDisabled}
            onClick={() => setRejecting(true)}
          >
            Reject proposal
          </button>
        </div>
      ) : null}
      {awaitingApproval && proposal && rejecting ? (
        <section aria-label="Reject plan proposal">
          <label htmlFor="plan-rejection-feedback">Rejection feedback</label>
          <textarea
            id="plan-rejection-feedback"
            value={feedback}
            disabled={commandDisabled}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <button
            type="button"
            disabled={commandDisabled || !feedback.trim()}
            onClick={rejectProposal}
          >
            Confirm rejection
          </button>
        </section>
      ) : null}
      {startOpen || canContinue ? (
        <form aria-label="Send a message to project manager" onSubmit={submit}>
          {!cycle ? (
            <fieldset disabled={commandDisabled}>
              <legend>Project manager profile</legend>
              <select
                aria-label="Project manager profile"
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.displayName} · revision {profile.approvedRevision}
                  </option>
                ))}
              </select>
            </fieldset>
          ) : null}
          <label htmlFor="delivery-plan-message">
            Message to project manager
          </label>
          <textarea
            id="delivery-plan-message"
            value={draft}
            disabled={commandDisabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={commandDisabled || !draft.trim()}>
            {requestingRevision ? 'Send revision request' : 'Send message'}
          </button>
        </form>
      ) : null}
      {nonterminal ? (
        <button
          type="button"
          disabled={commandDisabled}
          onClick={() =>
            cycle &&
            onAbandon({
              type: 'planning_cycle.abandon',
              projectId,
              planningCycleId: cycle.cycle.id,
              expectedCycleRevision: cycle.cycle.revision,
            })
          }
        >
          Abandon cycle
        </button>
      ) : null}
    </section>
  );
}
