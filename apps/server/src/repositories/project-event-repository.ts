import { randomUUID } from 'node:crypto';

import {
  idSchema,
  projectEventSchema,
  type ProjectEvent,
  type ProjectEventDraft,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type ProjectEventAppendDraft = ProjectEventDraft & { id?: string };

type ProjectEventRow = {
  id: string;
  project_id: string;
  sequence: number;
  occurred_at: string;
  type: string;
  payload_json: string;
};

const toProjectEvent = (row: ProjectEventRow): ProjectEvent =>
  projectEventSchema.parse({
    protocolVersion: 1,
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });

export class ProjectEventRepository {
  private readonly nextSequence;
  private readonly insert;
  private readonly selectAfter;
  private readonly selectLatestSequence;

  constructor(private readonly database: Database) {
    this.nextSequence = database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM project_events WHERE project_id = ?',
    );
    this.insert = database.prepare(`
      INSERT INTO project_events (
        id, project_id, sequence, occurred_at, type, payload_json
      ) VALUES (
        @id, @projectId, @sequence, @occurredAt, @type, @payloadJson
      )
    `);
    this.selectAfter = database.prepare(
      'SELECT * FROM project_events WHERE project_id = ? AND sequence > ? ORDER BY sequence',
    );
    this.selectLatestSequence = database.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM project_events WHERE project_id = ?',
    );
  }

  append(projectId: string, draft: ProjectEventAppendDraft): ProjectEvent {
    const parsedProjectId = idSchema.parse(projectId);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const event = this.insertEvent(parsedProjectId, draft);
      this.database.exec('COMMIT');
      return event;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  appendInTransaction(
    projectId: string,
    draft: ProjectEventAppendDraft,
  ): ProjectEvent {
    if (!this.database.inTransaction) {
      throw new Error('Project event transaction is not active');
    }
    return this.insertEvent(idSchema.parse(projectId), draft);
  }

  after(projectId: string, sequence: number): ProjectEvent[] {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new TypeError(
        'Project event sequence must be a non-negative integer',
      );
    }
    return (
      this.selectAfter.all(
        idSchema.parse(projectId),
        sequence,
      ) as ProjectEventRow[]
    ).map(toProjectEvent);
  }

  latestSequence(projectId: string): number {
    return (
      this.selectLatestSequence.get(idSchema.parse(projectId)) as {
        sequence: number;
      }
    ).sequence;
  }

  private insertEvent(
    projectId: ReturnType<typeof idSchema.parse>,
    draft: ProjectEventAppendDraft,
  ): ProjectEvent {
    const sequence = (this.nextSequence.get(projectId) as { sequence: number })
      .sequence;
    const event = projectEventSchema.parse({
      ...draft,
      id: draft.id ?? randomUUID(),
      projectId,
      sequence,
    });
    if (draft.projectId !== projectId) {
      throw new Error('Project event project must match the append project');
    }
    this.insert.run({
      id: event.id,
      projectId: event.projectId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      type: event.type,
      payloadJson: JSON.stringify(event.payload),
    });
    return event;
  }
}
