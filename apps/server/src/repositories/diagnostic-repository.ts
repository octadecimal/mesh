import {
  rawDiagnosticSchema,
  type RawDiagnostic,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type DiagnosticRow = {
  id: string;
  session_id: string;
  normalized_event_id: string | null;
  captured_at: string;
  payload_json: string;
};

const toDiagnostic = (row: DiagnosticRow): RawDiagnostic =>
  rawDiagnosticSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    normalizedEventId: row.normalized_event_id ?? undefined,
    capturedAt: row.captured_at,
    payload: JSON.parse(row.payload_json),
  });

export class DiagnosticRepository {
  private readonly insertStatement;
  private readonly linkStatement;
  private readonly selectBySession;

  constructor(private readonly database: Database) {
    this.insertStatement = database.prepare(`
      INSERT INTO raw_diagnostics (
        id, session_id, normalized_event_id, captured_at, payload_json
      ) VALUES (
        @id, @sessionId, @normalizedEventId, @capturedAt, @payloadJson
      )
    `);
    this.linkStatement = database.prepare(
      'UPDATE raw_diagnostics SET normalized_event_id = ? WHERE id = ?',
    );
    this.selectBySession = database.prepare(
      'SELECT * FROM raw_diagnostics WHERE session_id = ? ORDER BY captured_at, id',
    );
  }

  insert(diagnostic: RawDiagnostic): RawDiagnostic {
    const value = rawDiagnosticSchema.parse(diagnostic);
    this.insertStatement.run({
      ...value,
      normalizedEventId: value.normalizedEventId ?? null,
      payloadJson: JSON.stringify(value.payload),
    });
    return value;
  }

  linkToEvent(diagnosticId: string, eventId: string): void {
    this.linkStatement.run(eventId, diagnosticId);
  }

  list(sessionId: string): RawDiagnostic[] {
    return (this.selectBySession.all(sessionId) as DiagnosticRow[]).map(toDiagnostic);
  }
}
