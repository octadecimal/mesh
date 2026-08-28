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

type ExecutionCursorRow = {
  project_id: string;
  adapter_id: string;
  last_adapter_cursor: number;
  last_runtime_sequence: number;
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
  private readonly selectExecutionCursor;
  private readonly updateExecutionCursor;

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
    this.selectExecutionCursor = database.prepare(`
      SELECT project_id, adapter_id, last_adapter_cursor, last_runtime_sequence
      FROM worker_executions
      WHERE id = ?
    `);
    this.updateExecutionCursor = database.prepare(`
      UPDATE worker_executions
      SET last_adapter_cursor = @adapterCursor,
          last_runtime_sequence = @runtimeSequence,
          updated_at = @updatedAt
      WHERE id = @executionId
        AND project_id = @projectId
        AND adapter_id = @adapterId
        AND last_adapter_cursor = @previousAdapterCursor
        AND last_runtime_sequence = @previousRuntimeSequence
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
    const execution = this.selectExecutionCursor.get(
      parsedDraft.executionId,
    ) as ExecutionCursorRow | undefined;
    if (!execution) throw new Error('Runtime event execution was not found');
    if (execution.project_id !== parsedProjectId) {
      throw new Error(
        'Runtime execution project must match the append project',
      );
    }
    if (execution.adapter_id !== parsedDiagnostic.adapterId) {
      throw new Error('Runtime execution adapter must match the diagnostic');
    }
    if (parsedDraft.adapterCursor <= execution.last_adapter_cursor) {
      throw new Error(
        'Runtime adapter cursor must advance the execution cursor',
      );
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
    const cursorUpdate = this.updateExecutionCursor.run({
      executionId: event.executionId,
      projectId: event.projectId,
      adapterId: parsedDiagnostic.adapterId,
      adapterCursor: event.adapterCursor,
      runtimeSequence: event.sequence,
      updatedAt: event.occurredAt,
      previousAdapterCursor: execution.last_adapter_cursor,
      previousRuntimeSequence: execution.last_runtime_sequence,
    });
    if (cursorUpdate.changes !== 1) {
      throw new Error('Runtime execution cursor update lost coherence');
    }
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
      .all(project) as {
      stream_kind: 'domain' | 'runtime';
      high_water: number;
    }[];
    const byKind = new Map(
      rows.map((row) => [row.stream_kind, row.high_water]),
    );
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
      this.advanceSequence.get({ projectId, streamKind }) as {
        sequence: number;
      }
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
