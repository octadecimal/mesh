import { randomUUID } from 'node:crypto';

import {
  idSchema,
  isoTimestampSchema,
  taskActorSchema,
  taskAttemptSchema,
  type TaskActor,
  type TaskAttempt,
  type TaskAttemptSource,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type TaskAttemptRow = {
  id: string;
  task_id: string;
  session_id: string;
  ordinal: number;
  source: string;
  actor_json: string;
  created_at: string;
  unlinked_at: string | null;
  unlinked_by_json: string | null;
  unlink_reason: string | null;
};

const toTaskAttempt = (row: TaskAttemptRow): TaskAttempt =>
  taskAttemptSchema.parse({
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    source: row.source,
    actor: JSON.parse(row.actor_json),
    createdAt: row.created_at,
    unlinkedAt: row.unlinked_at,
    unlinkedBy: row.unlinked_by_json ? JSON.parse(row.unlinked_by_json) : null,
    unlinkReason: row.unlink_reason,
  });

export class TaskAttemptRepository {
  private readonly insert;
  private readonly selectById;
  private readonly selectCurrentBySession;
  private readonly selectByTask;
  private readonly nextOrdinal;
  private readonly unlinkById;

  constructor(private readonly database: Database) {
    this.insert = database.prepare(`
      INSERT INTO task_attempts (
        id, task_id, session_id, ordinal, source, actor_json, created_at,
        unlinked_at, unlinked_by_json, unlink_reason
      ) VALUES (
        @id, @taskId, @sessionId, @ordinal, @source, @actorJson, @createdAt,
        @unlinkedAt, @unlinkedByJson, @unlinkReason
      )
    `);
    this.selectById = database.prepare('SELECT * FROM task_attempts WHERE id = ?');
    this.selectCurrentBySession = database.prepare(
      'SELECT * FROM task_attempts WHERE session_id = ? AND unlinked_at IS NULL',
    );
    this.selectByTask = database.prepare(
      'SELECT * FROM task_attempts WHERE task_id = ? ORDER BY ordinal',
    );
    this.nextOrdinal = database.prepare(
      'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM task_attempts WHERE task_id = ?',
    );
    this.unlinkById = database.prepare(`
      UPDATE task_attempts
      SET unlinked_at = @unlinkedAt, unlinked_by_json = @unlinkedByJson,
          unlink_reason = @unlinkReason
      WHERE id = @id AND unlinked_at IS NULL
    `);
  }

  create(attempt: TaskAttempt): TaskAttempt {
    const value = taskAttemptSchema.parse(attempt);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const ordinal = (this.nextOrdinal.get(value.taskId) as { ordinal: number })
        .ordinal;
      if (value.ordinal !== ordinal) {
        throw new Error(`Task attempt ordinal must be ${ordinal}`);
      }
      this.insert.run(this.toParameters(value));
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  createForTask(
    taskId: string,
    sessionId: string,
    source: TaskAttemptSource,
    actor: TaskActor,
  ): TaskAttempt {
    const parsedTaskId = idSchema.parse(taskId);
    const ordinal = (this.nextOrdinal.get(parsedTaskId) as { ordinal: number })
      .ordinal;
    return this.create({
      id: idSchema.parse(randomUUID()),
      taskId: parsedTaskId,
      sessionId: idSchema.parse(sessionId),
      ordinal,
      source,
      actor: taskActorSchema.parse(actor),
      createdAt: new Date().toISOString(),
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
    });
  }

  getCurrentBySession(sessionId: string): TaskAttempt | undefined {
    const row = this.selectCurrentBySession.get(
      idSchema.parse(sessionId),
    ) as TaskAttemptRow | undefined;
    return row ? toTaskAttempt(row) : undefined;
  }

  listByTask(taskId: string): TaskAttempt[] {
    return (this.selectByTask.all(idSchema.parse(taskId)) as TaskAttemptRow[]).map(
      toTaskAttempt,
    );
  }

  unlink(id: string, actor: TaskActor, reason: string, at: string): TaskAttempt {
    const current = this.get(id);
    if (!current) throw new Error(`Task attempt '${id}' was not found`);
    const value = taskAttemptSchema.parse({
      ...current,
      unlinkedAt: isoTimestampSchema.parse(at),
      unlinkedBy: taskActorSchema.parse(actor),
      unlinkReason: reason,
    });
    const result = this.unlinkById.run({
      id: value.id,
      unlinkedAt: value.unlinkedAt,
      unlinkedByJson: JSON.stringify(value.unlinkedBy),
      unlinkReason: value.unlinkReason,
    });
    if (result.changes !== 1) {
      throw new Error(`Task attempt '${value.id}' is already unlinked`);
    }
    return value;
  }

  private get(id: string): TaskAttempt | undefined {
    const row = this.selectById.get(idSchema.parse(id)) as TaskAttemptRow | undefined;
    return row ? toTaskAttempt(row) : undefined;
  }

  private toParameters(attempt: TaskAttempt) {
    return {
      ...attempt,
      actorJson: JSON.stringify(attempt.actor),
      unlinkedAt: attempt.unlinkedAt,
      unlinkedByJson: attempt.unlinkedBy
        ? JSON.stringify(attempt.unlinkedBy)
        : null,
      unlinkReason: attempt.unlinkReason,
    };
  }
}
