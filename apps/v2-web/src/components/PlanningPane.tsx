import { useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  PlanningCycleView,
  PlanningProposal,
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

function titleCase(value: string) {
  return value
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function proposalCard(proposal: PlanningProposal) {
  const endpoint = (value: { recordId: string } | { proposalKey: string }) =>
    'recordId' in value ? value.recordId : value.proposalKey;
  return (
    <article className="intent-ledger-card" aria-labelledby="proposal-heading">
      <h3 id="proposal-heading">Proposal revision {proposal.revision}</h3>
      <p>{proposal.summary}</p>
      <dl>
        <div>
          <dt>Intent changes</dt>
          <dd>
            {proposal.diff.intentChanges.length === 0
              ? 'No intent changes'
              : proposal.diff.intentChanges.map(titleCase).join(', ')}
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
                Added: {endpoint(relationship.from)} {relationship.kind}{' '}
                {endpoint(relationship.to)}
              </li>
            ))}
            {proposal.diff.relationshipChanges.removed.map((relationship) => (
              <li
                key={`removed-${relationship.kind}-${endpoint(relationship.from)}-${endpoint(relationship.to)}`}
              >
                Removed: {endpoint(relationship.from)} {relationship.kind}{' '}
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
              {source.rationale}
            </li>
          ))}
        </ul>
      </section>
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
  executions = [],
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
  executions?: readonly WorkerExecution[];
  onSubmitTurn: (message: string, profile?: ProfileSelection) => void;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  onAbandon: (cycleId: string) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState('');
  const [profileId, setProfileId] = useState(profiles[0]?.profileId ?? '');
  const [requestingRevision, setRequestingRevision] = useState(false);
  const lifecycle = cycle?.cycle.lifecycle;
  const proposal = latestProposal(cycle);
  const latestExecutionId = cycle?.turns.at(-1)?.executionId;
  const latestExecution = executions.find(
    (execution) => execution.id === latestExecutionId,
  );
  const connected = connection.status === 'ready';
  const commandDisabled = !connected || submitting;
  const accepting =
    lifecycle === undefined ||
    lifecycle === 'discovering' ||
    lifecycle === 'awaiting_human';
  const canShowForm = accepting || requestingRevision;
  const nonterminal =
    lifecycle !== undefined &&
    !['approved', 'proposal_rejected', 'abandoned'].includes(lifecycle);
  const proposalReady =
    lifecycle === 'awaiting_approval' &&
    proposal?.lifecycle === 'awaiting_approval';
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || commandDisabled) return;
    const selected = profiles.find(
      (profile) => profile.profileId === profileId,
    );
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
      {historyTruncated ? <p>Planning history is truncated.</p> : null}
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
      {proposal ? proposalCard(proposal) : null}
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
            onClick={() => onReject(proposal.id)}
          >
            Reject proposal
          </button>
        </p>
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
          <p>Mesh did not retry the execution after restart.</p>
          {latestExecutionId ? <p>Execution {latestExecutionId}</p> : null}
          {latestExecution?.failure ? (
            <p>{latestExecution.failure.message}</p>
          ) : null}
          <p>Abandon this cycle to start a new one.</p>
        </section>
      ) : null}
      {nonterminal ? (
        <button
          type="button"
          disabled={commandDisabled}
          onClick={() => onAbandon(cycle.cycle.id)}
        >
          Abandon cycle
        </button>
      ) : null}
    </section>
  );
}
