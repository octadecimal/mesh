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
  role: string | null;
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
    role: row.role,
  });

const withRole = `
  SELECT task_attempts.*,
         CASE WHEN EXISTS (
           SELECT 1 FROM developer_execution_cycles
           WHERE developer_execution_cycles.attempt_id = task_attempts.id
         ) THEN 'developer' ELSE NULL END AS role
  FROM task_attempts
`;

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
    this.selectById = database.prepare(`${withRole} WHERE id = ?`);
    this.selectCurrentBySession = database.prepare(
      `${withRole} WHERE session_id = ? AND unlinked_at IS NULL`,
    );
    this.selectByTask = database.prepare(
      `${withRole} WHERE task_id = ? ORDER BY ordinal`,
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
    return this.inImmediateTransaction(() => this.insertWithOrdinal(value));
  }

  createForTask(
    taskId: string,
    sessionId: string,
    source: TaskAttemptSource,
    actor: TaskActor,
    role: TaskAttempt['role'] = null,
  ): TaskAttempt {
    const parsedTaskId = idSchema.parse(taskId);
    const parsedSessionId = idSchema.parse(sessionId);
    const parsedActor = taskActorSchema.parse(actor);
    const create = () => {
      const ordinal = (
        this.nextOrdinal.get(parsedTaskId) as { ordinal: number }
      ).ordinal;
      const attempt = taskAttemptSchema.parse({
        id: idSchema.parse(randomUUID()),
        taskId: parsedTaskId,
        sessionId: parsedSessionId,
        ordinal,
        source,
        actor: parsedActor,
        createdAt: new Date().toISOString(),
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role,
      });
      this.insert.run(this.toParameters(attempt));
      return attempt;
    };
    return this.database.inTransaction
      ? create()
      : this.inImmediateTransaction(create);
  }

  getCurrentBySession(sessionId: string): TaskAttempt | undefined {
    const row = this.selectCurrentBySession.get(idSchema.parse(sessionId)) as
      | TaskAttemptRow
      | undefined;
    return row ? toTaskAttempt(row) : undefined;
  }

  listByTask(taskId: string): TaskAttempt[] {
    return (
      this.selectByTask.all(idSchema.parse(taskId)) as TaskAttemptRow[]
    ).map(toTaskAttempt);
  }

  listBySession(sessionId: string): TaskAttempt[] {
    return (
      this.database
        .prepare(`${withRole} WHERE session_id = ? ORDER BY ordinal, id`)
        .all(sessionId) as TaskAttemptRow[]
    ).map(toTaskAttempt);
  }

  unlink(
    id: string,
    actor: TaskActor,
    reason: string,
    at: string,
  ): TaskAttempt {
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
    const row = this.selectById.get(idSchema.parse(id)) as
      | TaskAttemptRow
      | undefined;
    return row ? toTaskAttempt(row) : undefined;
  }

  private insertWithOrdinal(attempt: TaskAttempt): TaskAttempt {
    const ordinal = (
      this.nextOrdinal.get(attempt.taskId) as { ordinal: number }
    ).ordinal;
    if (attempt.ordinal !== ordinal) {
      throw new Error(`Task attempt ordinal must be ${ordinal}`);
    }
    this.insert.run(this.toParameters(attempt));
    return attempt;
  }

  private inImmediateTransaction<Result>(execute: () => Result): Result {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = execute();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
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
