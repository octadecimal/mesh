import { randomUUID } from 'node:crypto';

import type { LifecycleState } from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type LiveSessionRow = { id: string; lifecycle_state: LifecycleState };

export const recoverInterruptedSessions = (database: Database): number => {
  const sessions = database
    .prepare(
      `
    SELECT id, lifecycle_state FROM sessions
    WHERE lifecycle_state IN ('starting', 'running', 'waiting_for_approval', 'interrupting')
    ORDER BY id
  `,
    )
    .all() as LiveSessionRow[];
  if (sessions.length === 0) return 0;

  const nextSequence = database.prepare(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM session_events WHERE session_id = ?',
  );
  const insertDiagnostic = database.prepare(`
    INSERT INTO raw_diagnostics (id, session_id, normalized_event_id, captured_at, payload_json)
    VALUES (@id, @sessionId, NULL, @capturedAt, @payloadJson)
  `);
  const linkDiagnostic = database.prepare(
    'UPDATE raw_diagnostics SET normalized_event_id = ? WHERE id = ?',
  );
  const insertEvent = database.prepare(`
    INSERT INTO session_events (id, session_id, sequence, occurred_at, type, payload_json)
    VALUES (@id, @sessionId, @sequence, @occurredAt, 'session.status', @payloadJson)
  `);
  const updateSession = database.prepare(
    "UPDATE sessions SET lifecycle_state = 'interrupted', updated_at = ? WHERE id = ?",
  );

  database.exec('BEGIN IMMEDIATE');
  try {
    for (const session of sessions) {
      const occurredAt = new Date().toISOString();
      const eventId = `event-${randomUUID()}`;
      const diagnosticId = `diagnostic-${randomUUID()}`;
      const sequence = (nextSequence.get(session.id) as { sequence: number })
        .sequence;
      insertDiagnostic.run({
        id: diagnosticId,
        sessionId: session.id,
        capturedAt: occurredAt,
        payloadJson: JSON.stringify({
          kind: 'recovery',
          reason: 'backend_restart',
          from: session.lifecycle_state,
        }),
      });
      insertEvent.run({
        id: eventId,
        sessionId: session.id,
        sequence,
        occurredAt,
        payloadJson: JSON.stringify({
          from: session.lifecycle_state,
          to: 'interrupted',
          reason: 'backend_restart',
        }),
      });
      linkDiagnostic.run(eventId, diagnosticId);
      updateSession.run(occurredAt, session.id);
    }
    database.exec('COMMIT');
    return sessions.length;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};
