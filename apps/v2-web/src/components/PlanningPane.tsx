import { useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  ApprovedIntentLedger,
  LedgerRecordContent,
  PlanningCycleView,
  PlanningProposal,
  ProposedLedgerEndpoint,
  WorkerExecution,
  WorkerProfileSummary,
} from '@mesh/v2-contracts';

import './intent-ledger.css';

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
  recovery?:
    | { kind: 'ambiguous_start'; operation: string }
    | { kind: 'retryable'; message: string };
  executions?: readonly WorkerExecution[];
  approvedIntentLedger?: ApprovedIntentLedger | null;
  onSubmitTurn: (message: string, profile?: ProfileSelection) => void;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string, feedback: string) => void;
  onAbandon: (cycleId: string) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState('');
  const [profileId, setProfileId] = useState(profiles[0]?.profileId ?? '');
  const [requestingRevision, setRequestingRevision] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionFeedback, setRejectionFeedback] = useState('');
  const lifecycle = cycle?.cycle.lifecycle;
  const proposal = latestProposal(cycle);
  const latestExecutionId = cycle?.turns.at(-1)?.executionId;
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
    <section className="intent-ledger-pane" aria-labelledby="pm-chat-heading">
      <h2 id="pm-chat-heading" ref={headingRef} tabIndex={-1}>
        PM Chat
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
