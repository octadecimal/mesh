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

function metadata(record: LedgerRecordRevision) {
  const content = record.content;
  if (content.type === 'requirement')
    return `${content.kind} · ${content.status} · ${content.priority}`;
  if (content.type === 'assumption')
    return `${content.status} · ${content.confidence}`;
  if (content.type === 'question')
    return `${content.status}${content.resolution ? ` · ${content.resolution}` : ''}`;
  if (content.type === 'risk')
    return `${content.status} · ${content.severity} · ${content.mitigation}`;
  return content.status;
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
      record.content.statement,
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
        <p>{intentLedger.projectIntent.content.goal}</p>
        <p>{intentLedger.projectIntent.content.rationale}</p>
      </section>
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
                            {source.rationale}
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
                {relationship.kind}{' '}
                {labels.get(relationship.toRecordId) ?? relationship.toRecordId}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
