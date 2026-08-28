import { randomUUID } from 'node:crypto';

import {
  domainEventDraftSchema,
  domainEventSchema,
  nonNegativeIntegerSchema,
  projectEventCursorsSchema,
  projectIdSchema,
  rawDiagnosticDraftSchema,
  rawDiagnosticSchema,
  retainedDomainWindowSchema,
  retainedRuntimeWindowSchema,
  runtimeEventDraftSchema,
  runtimeEventSchema,
  type DomainEvent,
  type DomainEventDraft,
  type ProjectEventCursors,
  type RawDiagnostic,
  type RawDiagnosticDraft,
  type RetainedDomainWindow,
  type RetainedRuntimeWindow,
  type RuntimeEvent,
  type RuntimeEventDraft,
} from '@mesh/v2-contracts';

import type { V2Database } from '../db/database.js';
import { canonicalJson } from './canonical-json.js';

type DomainEventRow = {
  id: string;
  project_id: string;
  sequence: number;
  occurred_at: string;
  type: string;
  payload_json: string;
};

type RuntimeEventRow = DomainEventRow & {
  execution_id: string;
  diagnostic_id: string;
  adapter_cursor: number;
};

type RawDiagnosticRow = {
  id: string;
  project_id: string;
  execution_id: string | null;
  adapter_id: string;
  adapter_cursor: number | null;
  received_at: string;
  payload_json: string;
};

const toDomainEvent = (row: DomainEventRow): DomainEvent =>
  domainEventSchema.parse({
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });

const toRuntimeEvent = (row: RuntimeEventRow): RuntimeEvent =>
  runtimeEventSchema.parse({
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    diagnosticId: row.diagnostic_id,
    sequence: row.sequence,
    adapterCursor: row.adapter_cursor,
    occurredAt: row.occurred_at,
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });

const toRawDiagnostic = (row: RawDiagnosticRow): RawDiagnostic =>
  rawDiagnosticSchema.parse({
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    adapterId: row.adapter_id,
    adapterCursor: row.adapter_cursor,
    receivedAt: row.received_at,
    payload: JSON.parse(row.payload_json),
  });

const assertTransaction = (database: V2Database) => {
  if (!database.inTransaction) {
    throw new Error('Event store transaction is not active');
  }
};

export class V2EventStore {
  private readonly advanceSequence;
  private readonly insertDomain;
  private readonly insertDiagnostic;
  private readonly insertRuntime;

  constructor(private readonly database: V2Database) {
    this.advanceSequence = database.prepare(`
      INSERT INTO event_streams (project_id, stream_kind, high_water)
      VALUES (@projectId, @streamKind, 1)
      ON CONFLICT(project_id, stream_kind) DO UPDATE
      SET high_water = high_water + 1
      RETURNING high_water AS sequence
    `);
    this.insertDomain = database.prepare(`
      INSERT INTO domain_events (
        id, project_id, sequence, occurred_at, type, payload_json
      ) VALUES (
        @id, @projectId, @sequence, @occurredAt, @type, @payloadJson
      )
    `);
    this.insertDiagnostic = database.prepare(`
      INSERT INTO raw_diagnostics (
        id, project_id, execution_id, adapter_id, adapter_cursor,
        received_at, payload_json
      ) VALUES (
        @id, @projectId, @executionId, @adapterId, @adapterCursor,
        @receivedAt, @payloadJson
      )
    `);
    this.insertRuntime = database.prepare(`
      INSERT INTO runtime_events (
        id, project_id, execution_id, diagnostic_id, sequence,
        adapter_cursor, occurred_at, type, payload_json
      ) VALUES (
        @id, @projectId, @executionId, @diagnosticId, @sequence,
        @adapterCursor, @occurredAt, @type, @payloadJson
      )
    `);
  }

  appendDomainInTransaction(
    projectId: string,
    draft: DomainEventDraft,
  ): DomainEvent {
    assertTransaction(this.database);
    const parsedProjectId = projectIdSchema.parse(projectId);
    const parsedDraft = domainEventDraftSchema.parse(draft);
    if (parsedDraft.projectId !== parsedProjectId) {
      throw new Error('Domain event project must match the append project');
    }
    const sequence = this.nextSequence(parsedProjectId, 'domain');
    const event = domainEventSchema.parse({
      ...parsedDraft,
      id: randomUUID(),
      sequence,
    });
    this.insertDomain.run({
      id: event.id,
      projectId: event.projectId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      type: event.type,
      payloadJson: canonicalJson(event.payload),
    });
    return event;
  }

  appendRuntimeWithDiagnosticInTransaction(
    projectId: string,
    diagnostic: RawDiagnosticDraft,
    draft: RuntimeEventDraft,
  ): RuntimeEvent {
    assertTransaction(this.database);
    const parsedProjectId = projectIdSchema.parse(projectId);
    const parsedDiagnostic = rawDiagnosticDraftSchema.parse(diagnostic);
    const parsedDraft = runtimeEventDraftSchema.parse(draft);
    if (
      parsedDiagnostic.projectId !== parsedProjectId ||
      parsedDraft.projectId !== parsedProjectId
    ) {
      throw new Error('Runtime event project must match the append project');
    }
    if (parsedDiagnostic.executionId !== parsedDraft.executionId) {
      throw new Error('Runtime diagnostic execution must match the event');
    }
    if (parsedDiagnostic.adapterCursor !== parsedDraft.adapterCursor) {
      throw new Error('Runtime diagnostic cursor must match the event');
    }

    const storedDiagnostic = rawDiagnosticSchema.parse({
      ...parsedDiagnostic,
      id: randomUUID(),
    });
    this.insertDiagnostic.run({
      id: storedDiagnostic.id,
      projectId: storedDiagnostic.projectId,
      executionId: storedDiagnostic.executionId,
      adapterId: storedDiagnostic.adapterId,
      adapterCursor: storedDiagnostic.adapterCursor,
      receivedAt: storedDiagnostic.receivedAt,
      payloadJson: canonicalJson(storedDiagnostic.payload),
    });

    const sequence = this.nextSequence(parsedProjectId, 'runtime');
    const event = runtimeEventSchema.parse({
      ...parsedDraft,
      id: randomUUID(),
      diagnosticId: storedDiagnostic.id,
      sequence,
    });
    this.insertRuntime.run({
      id: event.id,
      projectId: event.projectId,
      executionId: event.executionId,
      diagnosticId: event.diagnosticId,
      sequence: event.sequence,
      adapterCursor: event.adapterCursor,
      occurredAt: event.occurredAt,
      type: event.type,
      payloadJson: canonicalJson(event.payload),
    });
    return event;
  }

  domainAfter(projectId: string, sequence: number): RetainedDomainWindow {
    const project = projectIdSchema.parse(projectId);
    const cursor = nonNegativeIntegerSchema.parse(sequence);
    const water = this.waterMarks(project, 'domain', 'domain_events');
    const events = (
      this.database
        .prepare(
          'SELECT * FROM domain_events WHERE project_id = ? AND sequence > ? ORDER BY sequence',
        )
        .all(project, cursor) as DomainEventRow[]
    ).map(toDomainEvent);
    return retainedDomainWindowSchema.parse({ ...water, events });
  }

  runtimeAfter(projectId: string, sequence: number): RetainedRuntimeWindow {
    const project = projectIdSchema.parse(projectId);
    const cursor = nonNegativeIntegerSchema.parse(sequence);
    const water = this.waterMarks(project, 'runtime', 'runtime_events');
    const events = (
      this.database
        .prepare(
          'SELECT * FROM runtime_events WHERE project_id = ? AND sequence > ? ORDER BY sequence',
        )
        .all(project, cursor) as RuntimeEventRow[]
    ).map(toRuntimeEvent);
    return retainedRuntimeWindowSchema.parse({ ...water, events });
  }

  cursors(projectId: string): ProjectEventCursors {
    const project = projectIdSchema.parse(projectId);
    const rows = this.database
      .prepare(
        'SELECT stream_kind, high_water FROM event_streams WHERE project_id = ?',
      )
      .all(project) as { stream_kind: 'domain' | 'runtime'; high_water: number }[];
    const byKind = new Map(rows.map((row) => [row.stream_kind, row.high_water]));
    return projectEventCursorsSchema.parse({
      domain: byKind.get('domain') ?? 0,
      runtime: byKind.get('runtime') ?? 0,
    });
  }

  diagnosticById(id: string): RawDiagnostic | undefined {
    const row = this.database
      .prepare('SELECT * FROM raw_diagnostics WHERE id = ?')
      .get(id) as RawDiagnosticRow | undefined;
    return row ? toRawDiagnostic(row) : undefined;
  }

  private nextSequence(
    projectId: string,
    streamKind: 'domain' | 'runtime',
  ): number {
    return (
      this.advanceSequence.get({ projectId, streamKind }) as { sequence: number }
    ).sequence;
  }

  private waterMarks(
    projectId: string,
    streamKind: 'domain' | 'runtime',
    eventTable: 'domain_events' | 'runtime_events',
  ) {
    const highWater = (
      this.database
        .prepare(
          `SELECT COALESCE(
            (SELECT high_water FROM event_streams
             WHERE project_id = ? AND stream_kind = ?),
            0
          ) AS high_water`,
        )
        .get(projectId, streamKind) as { high_water: number }
    ).high_water;
    const lowWater = (
      this.database
        .prepare(
          `SELECT COALESCE(MIN(sequence), ?) AS low_water
           FROM ${eventTable} WHERE project_id = ?`,
        )
        .get(highWater + 1, projectId) as { low_water: number }
    ).low_water;
    return { lowWater, highWater };
  }
}
