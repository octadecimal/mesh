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

type RetainedProjectEventRow = ProjectEventRow & {
  low_water: number;
  high_water: number;
};

export type RetainedProjectEventWindow = {
  events: ProjectEvent[];
  lowWater: number;
  highWater: number;
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
  private readonly advanceSequence;
  private readonly insert;
  private readonly selectAfter;
  private readonly selectRetainedAfter;
  private readonly selectLatestSequence;

  constructor(private readonly database: Database) {
    this.advanceSequence = database.prepare(`
      INSERT INTO project_event_streams (project_id, high_water)
      VALUES (?, 1)
      ON CONFLICT(project_id) DO UPDATE
      SET high_water = high_water + 1
      RETURNING high_water AS sequence
    `);
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
    this.selectRetainedAfter = database.prepare(`
      WITH stream AS (
        SELECT COALESCE(
          (SELECT high_water FROM project_event_streams WHERE project_id = @projectId),
          0
        ) AS high_water
      ), retained AS (
        SELECT MIN(sequence) AS low_water
        FROM project_events
        WHERE project_id = @projectId
      )
      SELECT
        COALESCE(retained.low_water, stream.high_water + 1) AS low_water,
        stream.high_water,
        event.id,
        event.project_id,
        event.sequence,
        event.occurred_at,
        event.type,
        event.payload_json
      FROM stream
      CROSS JOIN retained
      LEFT JOIN project_events AS event
        ON event.project_id = @projectId AND event.sequence > @sequence
      ORDER BY event.sequence
    `);
    this.selectLatestSequence = database.prepare(
      'SELECT COALESCE((SELECT high_water FROM project_event_streams WHERE project_id = ?), 0) AS sequence',
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

  retainedAfter(
    projectId: string,
    sequence: number,
  ): RetainedProjectEventWindow {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new TypeError(
        'Project event sequence must be a non-negative integer',
      );
    }
    const rows = this.selectRetainedAfter.all({
      projectId: idSchema.parse(projectId),
      sequence,
    }) as Array<RetainedProjectEventRow & { id: string | null }>;
    const first = rows[0];
    if (!first) throw new Error('Project event retained window is unavailable');
    return {
      events: rows
        .filter((row): row is RetainedProjectEventRow => row.id !== null)
        .map(toProjectEvent),
      lowWater: first.low_water,
      highWater: first.high_water,
    };
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
    const sequence = (
      this.advanceSequence.get(projectId) as { sequence: number }
    ).sequence;
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
