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
        <p role="alert">{error}</p>
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
      <section aria-label="Approved intent">
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
        <ul aria-label="Approved intent provenance">
          {intentLedger.projectIntent.content.provenance.map((source) => (
            <li key={`${source.turnId}-${source.rationale}`}>
              {source.turnId} · {source.rationale}
            </li>
          ))}
        </ul>
      </section>
      <p>Ledger revision {intentLedger.ledger.revision}</p>
      {intentLedger.records.length === 0 ? (
        <p>No ledger records are in this approved revision.</p>
      ) : (
        groups.map(([type, title]) => {
          const records = intentLedger.records.filter(
            (record) => record.content.type === type,
          );
          return (
            <section key={type} aria-labelledby={`${type}-heading`}>
              <h3 id={`${type}-heading`}>{title}</h3>
              {records.length === 0 ? (
                <p>No {title.toLowerCase()}.</p>
              ) : (
                <ul>
                  {records.map((record) => (
                    <li key={record.recordId} className="intent-ledger-card">
                      <h4>{record.content.statement}</h4>
                      <p>{record.content.rationale}</p>
                      <p>{metadata(record)}</p>
                      <p>Revision {record.revision}</p>
                      <ul
                        aria-label={`Provenance for ${record.content.statement}`}
                      >
                        {record.provenance.map((source) => (
                          <li key={`${source.turnId}-${source.rationale}`}>
                            {source.turnId} · {source.rationale}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
      <section aria-labelledby="relationships-heading">
        <h3 id="relationships-heading">Relationships</h3>
        {intentLedger.relationships.length === 0 ? (
          <p>No relationships in this revision.</p>
        ) : (
          <ul>
            {intentLedger.relationships.map((relationship) => (
              <li
                key={`${relationship.kind}-${relationship.fromRecordId}-${relationship.toRecordId}`}
              >
                {labels.get(relationship.fromRecordId) ??
                  relationship.fromRecordId}{' '}
                {relationshipLabels[relationship.kind]}{' '}
                {labels.get(relationship.toRecordId) ?? relationship.toRecordId}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
