import {
  rawDiagnosticSchema,
  sessionEventSchema,
  type RawDiagnostic,
  type LifecycleState,
  type SessionEvent,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import { DiagnosticRepository } from './diagnostic-repository.js';

export type SessionEventDraft = {
  id: string;
  occurredAt: string;
  type: SessionEvent['type'];
  payload: unknown;
};

type EventRow = {
  id: string;
  session_id: string;
  sequence: number;
  occurred_at: string;
  type: string;
  payload_json: string;
};

const toEvent = (row: EventRow): SessionEvent =>
  sessionEventSchema.parse({
    protocolVersion: 1,
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });

export class EventRepository {
  private readonly nextSequence;
  private readonly insertStatement;
  private readonly updateSessionTimestamp;
  private readonly selectAfter;

  constructor(
    private readonly database: Database,
    private readonly diagnostics = new DiagnosticRepository(database),
  ) {
    this.nextSequence = database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM session_events WHERE session_id = ?',
    );
    this.insertStatement = database.prepare(`
      INSERT INTO session_events (id, session_id, sequence, occurred_at, type, payload_json)
      VALUES (@id, @sessionId, @sequence, @occurredAt, @type, @payloadJson)
    `);
    this.updateSessionTimestamp = database.prepare(
      `UPDATE sessions SET
        lifecycle_state = COALESCE(@lifecycleState, lifecycle_state),
        claude_resume_id = COALESCE(@claudeResumeId, claude_resume_id),
        updated_at = @updatedAt
      WHERE id = @sessionId`,
    );
    this.selectAfter = database.prepare(
      'SELECT * FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence',
    );
  }

  append(
    sessionId: string,
    draft: SessionEventDraft,
    rawDiagnostic: RawDiagnostic,
    sessionUpdate?: {
      lifecycleState?: LifecycleState;
      claudeResumeId?: string;
    },
  ): SessionEvent {
    const diagnostic = rawDiagnosticSchema.parse(rawDiagnostic);
    if (diagnostic.sessionId !== sessionId) {
      throw new Error('Raw diagnostic session must match the event session');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const sequence = (
        this.nextSequence.get(sessionId) as { sequence: number }
      ).sequence;
      const event = sessionEventSchema.parse({
        ...draft,
        protocolVersion: 1,
        sessionId,
        sequence,
      });
      this.diagnostics.insert({
        ...diagnostic,
        normalizedEventId: undefined,
      });
      this.insertStatement.run({
        id: event.id,
        sessionId,
        sequence,
        occurredAt: event.occurredAt,
        type: event.type,
        payloadJson: JSON.stringify(event.payload),
      });
      this.diagnostics.linkToEvent(diagnostic.id, event.id);
      this.updateSessionTimestamp.run({
        sessionId,
        lifecycleState: sessionUpdate?.lifecycleState ?? null,
        claudeResumeId: sessionUpdate?.claudeResumeId ?? null,
        updatedAt: new Date().toISOString(),
      });
      this.database.exec('COMMIT');
      return event;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  after(sessionId: string, sequence: number): SessionEvent[] {
    return (this.selectAfter.all(sessionId, sequence) as EventRow[]).map(
      toEvent,
    );
  }
}
