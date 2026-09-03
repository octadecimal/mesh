import type {
  ApprovedIntentLedger,
  LedgerRecordRevision,
} from '@mesh/v2-contracts';

import './intent-ledger.css';

const groups = [
  ['requirement', 'Requirements'],
  ['decision', 'Decisions'],
  ['assumption', 'Assumptions'],
  ['question', 'Questions'],
  ['risk', 'Risks'],
] as const;

const relationshipLabels: Record<string, string> = {
  refines: 'refines',
  depends_on: 'depends on',
  conflicts_with: 'conflicts with',
  supersedes: 'supersedes',
  duplicates: 'duplicates',
  constrains: 'constrains',
};

function humanize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function list(values: readonly string[]) {
  return values.length === 0 ? 'None' : values.join(' · ');
}

function metadata(record: LedgerRecordRevision) {
  const content = record.content;
  if (content.type === 'requirement')
    return `Requirement · ${humanize(content.kind)} · ${humanize(content.status)} · ${humanize(content.priority)}`;
  if (content.type === 'assumption')
    return `Assumption · ${humanize(content.status)} · ${humanize(content.confidence)}`;
  if (content.type === 'question')
    return `Question · ${humanize(content.status)}${content.resolution ? ` · ${content.resolution}` : ''}`;
  if (content.type === 'risk')
    return `Risk · ${humanize(content.status)} · ${humanize(content.severity)} · ${content.mitigation}`;
  return `Decision · ${humanize(content.status)}`;
}

export function RequirementsPane({
  intentLedger,
  loading = false,
  error,
}: {
  intentLedger: ApprovedIntentLedger | null;
  loading?: boolean;
  error?: string;
}) {
  if (loading)
    return (
      <section
        className="intent-ledger-pane"
        aria-labelledby="requirements-heading"
      >
        <h2 id="requirements-heading">Requirements</h2>
        <p role="status">Loading requirements…</p>
      </section>
    );
  if (error)
    return (
      <section
        className="intent-ledger-pane"
        aria-labelledby="requirements-heading"
      >
        <h2 id="requirements-heading">Requirements</h2>
        <p className="v2-warning" role="alert">
          {error}
        </p>
      </section>
    );
  if (!intentLedger)
    return (
      <section
        className="intent-ledger-pane"
        aria-labelledby="requirements-heading"
      >
        <h2 id="requirements-heading">Requirements</h2>
        <p>No approved intent or requirements yet.</p>
      </section>
    );
  const labels = new Map(
    intentLedger.records.map((record) => [
      record.recordId,
      `${record.recordId} · ${humanize(record.content.type)} · ${record.content.statement}`,
    ]),
  );
  return (
    <section
      className="intent-ledger-pane"
      aria-labelledby="requirements-heading"
    >
      <h2 id="requirements-heading">Requirements</h2>
      <section className="intent-ledger-approved" aria-label="Approved intent">
        <h3>
          Approved intent · revision {intentLedger.projectIntent.revision}
        </h3>
        <dl>
          <div>
            <dt>Goal</dt>
            <dd>{intentLedger.projectIntent.content.goal}</dd>
          </div>
          <div>
            <dt>Target users</dt>
            <dd>{list(intentLedger.projectIntent.content.targetUsers)}</dd>
          </div>
          <div>
            <dt>Desired capabilities</dt>
            <dd>
              {list(intentLedger.projectIntent.content.desiredCapabilities)}
            </dd>
          </div>
          <div>
            <dt>Constraints</dt>
            <dd>{list(intentLedger.projectIntent.content.constraints)}</dd>
          </div>
          <div>
            <dt>Non-goals</dt>
            <dd>{list(intentLedger.projectIntent.content.nonGoals)}</dd>
          </div>
          <div>
            <dt>Success conditions</dt>
            <dd>
              {list(intentLedger.projectIntent.content.successConditions)}
            </dd>
          </div>
          <div>
            <dt>Rationale</dt>
            <dd>{intentLedger.projectIntent.content.rationale}</dd>
          </div>
        </dl>
        <details className="intent-ledger-history">
          <summary>Approval history</summary>
          <dl>
            <div>
              <dt>Intent ID</dt>
              <dd>{intentLedger.projectIntent.id}</dd>
            </div>
            <div>
              <dt>Project ID</dt>
              <dd>{intentLedger.projectIntent.projectId}</dd>
            </div>
            <div>
              <dt>Proposal ID</dt>
              <dd>{intentLedger.projectIntent.proposalId}</dd>
            </div>
            <div>
              <dt>Approved by</dt>
              <dd>{intentLedger.projectIntent.approvedBy}</dd>
            </div>
            <div>
              <dt>Approved at</dt>
              <dd>
                <time dateTime={intentLedger.projectIntent.approvedAt}>
                  {intentLedger.projectIntent.approvedAt}
                </time>
              </dd>
            </div>
          </dl>
          <ul aria-label="Approved intent provenance">
            {intentLedger.projectIntent.content.provenance.map((source) => (
              <li key={`${source.turnId}-${source.rationale}`}>
                {source.turnId} · {source.rationale}
              </li>
            ))}
          </ul>
        </details>
      </section>
      <details className="intent-ledger-history">
        <summary>Ledger revision {intentLedger.ledger.revision}</summary>
        <dl>
          <div>
            <dt>Ledger ID</dt>
            <dd>{intentLedger.ledger.id}</dd>
          </div>
          <div>
            <dt>Project ID</dt>
            <dd>{intentLedger.ledger.projectId}</dd>
          </div>
          <div>
            <dt>Proposal ID</dt>
            <dd>{intentLedger.ledger.proposalId}</dd>
          </div>
          <div>
            <dt>Approved by</dt>
            <dd>{intentLedger.ledger.approvedBy}</dd>
          </div>
          <div>
            <dt>Approved at</dt>
            <dd>
              <time dateTime={intentLedger.ledger.approvedAt}>
                {intentLedger.ledger.approvedAt}
              </time>
            </dd>
          </div>
        </dl>
      </details>
      {intentLedger.records.length === 0 ? (
        <p>No ledger records are in this approved revision.</p>
      ) : null}
      {groups.map(([type, title]) => {
        const records = intentLedger.records.filter(
          (record) => record.content.type === type,
        );
        return (
          <section key={type} aria-labelledby={`${type}-heading`}>
            <h3 id={`${type}-heading`}>
              {title} · {records.length}
            </h3>
            {records.length === 0 ? (
              <p>No {title.toLowerCase()}.</p>
            ) : (
              <ul className="intent-ledger-records">
                {records.map((record) => {
                  const headingId = `${type}-${record.recordId}-heading`;
                  return (
                    <li key={record.recordId}>
                      <article
                        className="intent-ledger-card"
                        aria-labelledby={headingId}
                      >
                        <h4 id={headingId}>{record.content.statement}</h4>
                        <dl className="intent-ledger-metadata">
                          <div>
                            <dt>Rationale</dt>
                            <dd>{record.content.rationale}</dd>
                          </div>
                          <div>
                            <dt>Metadata</dt>
                            <dd>{metadata(record)}</dd>
                          </div>
                        </dl>
                        <details className="intent-ledger-history">
                          <summary>Revision and provenance</summary>
                          <p>Revision {record.revision}</p>
                          <dl>
                            <div>
                              <dt>Record ID</dt>
                              <dd>{record.recordId}</dd>
                            </div>
                            <div>
                              <dt>Project ID</dt>
                              <dd>{record.projectId}</dd>
                            </div>
                            <div>
                              <dt>Proposal ID</dt>
                              <dd>{record.proposalId}</dd>
                            </div>
                            <div>
                              <dt>Approved by</dt>
                              <dd>{record.approvedBy}</dd>
                            </div>
                            <div>
                              <dt>Approved at</dt>
                              <dd>
                                <time dateTime={record.approvedAt}>
                                  {record.approvedAt}
                                </time>
                              </dd>
                            </div>
                          </dl>
                          <ul
                            aria-label={`Provenance for ${record.content.statement}`}
                          >
                            {record.provenance.map((source) => (
                              <li key={`${source.turnId}-${source.rationale}`}>
                                {source.turnId} · {source.rationale}
                              </li>
                            ))}
                          </ul>
                        </details>
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      <section
        className="intent-ledger-relationships"
        aria-labelledby="relationships-heading"
      >
        <h3 id="relationships-heading">Relationships</h3>
        {intentLedger.relationships.length === 0 ? (
          <p>No relationships in this revision.</p>
        ) : (
          <ul>
            {intentLedger.relationships.map((relationship) => {
              const target =
                labels.get(relationship.toRecordId) ?? relationship.toRecordId;
              return (
                <li
                  key={`${relationship.kind}-${relationship.fromRecordId}-${relationship.toRecordId}`}
                >
                  <span>
                    {labels.get(relationship.fromRecordId) ??
                      relationship.fromRecordId}
                  </span>{' '}
                  <span>
                    {relationshipLabels[relationship.kind]}{' '}
                    {relationship.toRecordId}
                  </span>
                  {target === relationship.toRecordId ? null : (
                    <span>{target.slice(relationship.toRecordId.length)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
