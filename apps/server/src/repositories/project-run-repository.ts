import {
  idSchema,
  isoTimestampSchema,
  projectRunItemSchema,
  projectRunSchema,
  type ProjectRun,
  type ProjectRunItem,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type ProjectRunRow = {
  id: string;
  project_id: string;
  state: string;
  revision: number;
  concurrency: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  completion_reason: string | null;
  pause_reason: string | null;
};

type ProjectRunItemRow = {
  id: string;
  run_id: string;
  project_id: string;
  task_id: string;
  task_revision: number;
  policy_revision: number;
  task_automation_generation: number;
  task_automation_status: ProjectRunItem['taskAutomationStatus'];
  queue_position: number;
  status: string;
  attempt_id: string | null;
  session_id: string | null;
  launch_idempotency_key: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  outcome_reason: string | null;
};

type CreateProjectRunItemInput = {
  id: string;
  taskId: string;
  taskRevision: number;
  policyRevision: number;
  taskAutomationGeneration: number;
  taskAutomationStatus?: ProjectRunItem['taskAutomationStatus'];
  queuePosition: number;
  launchIdempotencyKey: string;
};

export type CreateProjectRunInput = {
  id: string;
  projectId: string;
  concurrency: number;
  startedAt: string;
  state?: 'running' | 'completed';
  completedAt?: string;
  completionReason?: string;
  items: readonly CreateProjectRunItemInput[];
};

export type ClaimNextRunItemInput = {
  runId: string;
  expectedRunRevision: number;
  occurredAt: string;
};

export type LinkRunItemLaunchInput = {
  runId: string;
  itemId: string;
  expectedRunRevision: number;
  attemptId: string;
  sessionId: string;
  occurredAt: string;
};

export type ResetRunItemLaunchClaimInput = {
  runId: string;
  itemId: string;
  expectedRunRevision: number;
  occurredAt: string;
};

export type FinishRunItemInput = {
  runId: string;
  itemId: string;
  expectedRunRevision: number;
  status: 'completed' | 'attention_required' | 'not_started';
  outcomeReason: string;
  occurredAt: string;
};

export type ChangeProjectRunStateInput = {
  runId: string;
  expectedRunRevision: number;
  state: 'running' | 'paused' | 'draining' | 'completed';
  pauseReason?: string;
  completionReason?: string;
  occurredAt: string;
};

export type ClaimedRunItem = { run: ProjectRun; item: ProjectRunItem };

export type ProjectRunCounts = {
  queued: number;
  launchPending: number;
  active: number;
  completed: number;
  attentionRequired: number;
  notStarted: number;
};

const assertPositiveInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
};

const assertNonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
};

const toItem = (row: ProjectRunItemRow): ProjectRunItem =>
  projectRunItemSchema.parse({
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    policyRevision: row.policy_revision,
    taskAutomationGeneration: row.task_automation_generation,
    taskAutomationStatus: row.task_automation_status,
    queuePosition: row.queue_position,
    status: row.status,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    launchIdempotencyKey: row.launch_idempotency_key,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcomeReason: row.outcome_reason,
  });

export class ProjectRunRepository {
  constructor(private readonly database: Database) {}

  get(id: string): ProjectRun | undefined {
    const row = this.database
      .prepare('SELECT * FROM project_runs WHERE id = ?')
      .get(idSchema.parse(id)) as ProjectRunRow | undefined;
    return row ? this.toRun(row) : undefined;
  }

  getActiveByProject(projectId: string): ProjectRun | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM project_runs
        WHERE project_id = ? AND state IN ('running', 'paused', 'draining')`,
      )
      .get(idSchema.parse(projectId)) as ProjectRunRow | undefined;
    return row ? this.toRun(row) : undefined;
  }

  listByProject(projectId: string): ProjectRun[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM project_runs WHERE project_id = ? ORDER BY started_at, id',
        )
        .all(idSchema.parse(projectId)) as ProjectRunRow[]
    ).map((row) => this.toRun(row));
  }

  create(input: CreateProjectRunInput): ProjectRun {
    const runId = idSchema.parse(input.id);
    const projectId = idSchema.parse(input.projectId);
    const state = input.state ?? 'running';
    assertPositiveInteger(input.concurrency, 'Run concurrency');
    const startedAt = isoTimestampSchema.parse(input.startedAt);
    const completedAt =
      state === 'completed'
        ? isoTimestampSchema.parse(input.completedAt)
        : null;
    const completionReason =
      state === 'completed'
        ? this.nonEmpty(input.completionReason, 'Run completion reason')
        : null;
    const items = input.items.map((item) => ({
      ...item,
      taskAutomationStatus: item.taskAutomationStatus ?? 'disabled',
      id: idSchema.parse(item.id),
      taskId: idSchema.parse(item.taskId),
      launchIdempotencyKey: idSchema.parse(item.launchIdempotencyKey),
    }));
    const itemIds = new Set<string>();
    const positions = new Set<number>();
    const taskIds = new Set<string>();
    for (const item of items) {
      const itemId = item.id;
      const taskId = item.taskId;
      assertPositiveInteger(item.taskRevision, 'Task revision');
      assertPositiveInteger(item.policyRevision, 'Policy revision');
      assertNonNegativeInteger(
        item.taskAutomationGeneration,
        'Task automation generation',
      );
      assertNonNegativeInteger(item.queuePosition, 'Queue position');
      if (
        itemIds.has(itemId) ||
        positions.has(item.queuePosition) ||
        taskIds.has(taskId)
      ) {
        throw new TypeError(
          'Run items require unique ids, tasks, and queue positions',
        );
      }
      itemIds.add(itemId);
      positions.add(item.queuePosition);
      taskIds.add(taskId);
    }
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO project_runs (
        id, project_id, state, revision, concurrency, started_at, updated_at,
        completed_at, completion_reason
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          projectId,
          state,
          input.concurrency,
          startedAt,
          startedAt,
          completedAt,
          completionReason,
        );
      const taskProject = this.database.prepare(
        'SELECT project_id FROM tasks WHERE id = ?',
      );
      const insertItem = this.database.prepare(`INSERT INTO project_run_items (
        id, run_id, project_id, task_id, task_revision, policy_revision,
        task_automation_generation, queue_position, status, attempt_id, session_id,
        task_automation_status,
        launch_idempotency_key, claimed_at, started_at, finished_at, outcome_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`);
      for (const item of items) {
        const taskId = item.taskId;
        const task = taskProject.get(taskId) as
          | { project_id: string }
          | undefined;
        if (!task || task.project_id !== projectId) {
          throw new Error(
            `Task '${taskId}' does not belong to project '${projectId}'`,
          );
        }
        insertItem.run(
          item.id,
          runId,
          projectId,
          taskId,
          item.taskRevision,
          item.policyRevision,
          item.taskAutomationGeneration,
          item.queuePosition,
          item.taskAutomationStatus,
          item.launchIdempotencyKey,
        );
      }
      const run = this.get(runId);
      if (!run) throw new Error('Created project run was not found');
      return run;
    });
  }

  claimNext(input: ClaimNextRunItemInput): ClaimedRunItem | undefined {
    const runId = idSchema.parse(input.runId);
    const occurredAt = isoTimestampSchema.parse(input.occurredAt);
    assertPositiveInteger(input.expectedRunRevision, 'Expected run revision');
    return this.transaction(() => {
      const run = this.get(runId);
      if (
        !run ||
        run.revision !== input.expectedRunRevision ||
        run.state !== 'running'
      )
        return undefined;
      const inFlight = this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM project_run_items WHERE run_id = ? AND status IN ('launch_pending', 'active')",
        )
        .get(runId) as { count: number };
      if (inFlight.count >= run.concurrency) return undefined;
      const itemRow = this.database
        .prepare(
          "SELECT * FROM project_run_items WHERE run_id = ? AND status = 'queued' ORDER BY queue_position, id LIMIT 1",
        )
        .get(runId) as ProjectRunItemRow | undefined;
      if (!itemRow) return undefined;
      const claimed = this.database
        .prepare(
          "UPDATE project_run_items SET status = 'launch_pending', claimed_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(occurredAt, itemRow.id);
      if (
        claimed.changes !== 1 ||
        !this.bumpRevision(runId, input.expectedRunRevision, occurredAt)
      )
        return undefined;
      const next = this.get(runId);
      const item = next?.items.find(({ id }) => id === itemRow.id);
      return next && item ? { run: next, item } : undefined;
    });
  }

  resetLaunchClaim(input: ResetRunItemLaunchClaimInput): ProjectRun {
    const runId = idSchema.parse(input.runId);
    const itemId = idSchema.parse(input.itemId);
    const occurredAt = isoTimestampSchema.parse(input.occurredAt);
    assertPositiveInteger(input.expectedRunRevision, 'Expected run revision');
    return this.transaction(() => {
      const run = this.get(runId);
      if (!run || run.revision !== input.expectedRunRevision) {
        throw new Error('Project run revision does not match');
      }
      const result = this.database
        .prepare(
          `UPDATE project_run_items
        SET status = 'queued', claimed_at = NULL
        WHERE id = ? AND run_id = ? AND status = 'launch_pending'
          AND attempt_id IS NULL AND session_id IS NULL
          AND EXISTS (
            SELECT 1 FROM project_runs
            WHERE project_runs.id = project_run_items.run_id
              AND project_runs.state IN ('running', 'paused')
          )
          AND NOT EXISTS (
            SELECT 1 FROM task_attempts
            WHERE task_attempts.task_id = project_run_items.task_id
              AND task_attempts.unlinked_at IS NULL
          )`,
        )
        .run(itemId, runId);
      if (
        result.changes !== 1 ||
        !this.bumpRevision(runId, input.expectedRunRevision, occurredAt)
      ) {
        throw new Error('Project run launch claim cannot be reset');
      }
      const next = this.get(runId);
      if (!next) throw new Error('Reset project run was not found');
      return next;
    });
  }

  linkLaunch(input: LinkRunItemLaunchInput): ProjectRun {
    const runId = idSchema.parse(input.runId);
    const itemId = idSchema.parse(input.itemId);
    const attemptId = idSchema.parse(input.attemptId);
    const sessionId = idSchema.parse(input.sessionId);
    const occurredAt = isoTimestampSchema.parse(input.occurredAt);
    assertPositiveInteger(input.expectedRunRevision, 'Expected run revision');
    return this.transaction(() => {
      const run = this.get(runId);
      if (!run || run.revision !== input.expectedRunRevision)
        throw new Error('Project run revision does not match');
      const result = this.database
        .prepare(
          `UPDATE project_run_items
        SET status = 'active', attempt_id = ?, session_id = ?, started_at = ?
        WHERE id = ? AND run_id = ? AND status = 'launch_pending'
          AND EXISTS (
            SELECT 1
            FROM task_attempts
            JOIN sessions ON sessions.id = task_attempts.session_id
            WHERE task_attempts.id = ?
              AND task_attempts.task_id = project_run_items.task_id
              AND task_attempts.session_id = ?
              AND task_attempts.source_json IS NOT NULL
              AND json_extract(task_attempts.source_json, '$.type') = 'project_run'
              AND json_extract(task_attempts.source_json, '$.runId') = project_run_items.run_id
              AND json_extract(task_attempts.source_json, '$.runItemId') = project_run_items.id
              AND sessions.project_id = project_run_items.project_id
          )`,
        )
        .run(
          attemptId,
          sessionId,
          occurredAt,
          itemId,
          runId,
          attemptId,
          sessionId,
        );
      if (
        result.changes !== 1 ||
        !this.bumpRevision(runId, input.expectedRunRevision, occurredAt)
      ) {
        throw new Error('Project run item launch cannot be linked');
      }
      const next = this.get(runId);
      if (!next) throw new Error('Linked project run was not found');
      return next;
    });
  }

  finishItem(input: FinishRunItemInput): ProjectRun {
    const runId = idSchema.parse(input.runId);
    const itemId = idSchema.parse(input.itemId);
    const occurredAt = isoTimestampSchema.parse(input.occurredAt);
    const outcomeReason = this.nonEmpty(
      input.outcomeReason,
      'Run item outcome reason',
    );
    assertPositiveInteger(input.expectedRunRevision, 'Expected run revision');
    return this.transaction(() => {
      const run = this.get(runId);
      if (!run || run.revision !== input.expectedRunRevision)
        throw new Error('Project run revision does not match');
      const result = this.database
        .prepare(
          `UPDATE project_run_items
        SET status = ?, finished_at = ?, outcome_reason = ?
        WHERE id = ? AND run_id = ? AND status IN ('queued', 'launch_pending', 'active')`,
        )
        .run(input.status, occurredAt, outcomeReason, itemId, runId);
      if (
        result.changes !== 1 ||
        !this.bumpRevision(runId, input.expectedRunRevision, occurredAt)
      ) {
        throw new Error('Project run item cannot be finished');
      }
      const next = this.get(runId);
      if (!next) throw new Error('Finished project run was not found');
      return next;
    });
  }

  changeState(input: ChangeProjectRunStateInput): ProjectRun | undefined {
    const runId = idSchema.parse(input.runId);
    const occurredAt = isoTimestampSchema.parse(input.occurredAt);
    assertPositiveInteger(input.expectedRunRevision, 'Expected run revision');
    const completedAt = input.state === 'completed' ? occurredAt : null;
    const completionReason =
      input.state === 'completed'
        ? this.nonEmpty(input.completionReason, 'Run completion reason')
        : null;
    const pauseReason =
      input.state === 'paused'
        ? this.nonEmpty(input.pauseReason, 'Run pause reason')
        : null;
    return this.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE project_runs
        SET state = ?, revision = revision + 1, updated_at = ?, completed_at = ?, completion_reason = ?, pause_reason = ?
        WHERE id = ? AND revision = ? AND state != 'completed'`,
        )
        .run(
          input.state,
          occurredAt,
          completedAt,
          completionReason,
          pauseReason,
          runId,
          input.expectedRunRevision,
        );
      return result.changes === 1 ? this.get(runId) : undefined;
    });
  }

  reconcileCounts(runId: string): ProjectRunCounts {
    const parsedRunId = idSchema.parse(runId);
    const counts = this.database
      .prepare(
        `SELECT
      SUM(status = 'queued') AS queued,
      SUM(status = 'launch_pending') AS launch_pending,
      SUM(status = 'active') AS active,
      SUM(status = 'completed') AS completed,
      SUM(status = 'attention_required') AS attention_required,
      SUM(status = 'not_started') AS not_started
      FROM project_run_items WHERE run_id = ?`,
      )
      .get(parsedRunId) as Record<string, number | null>;
    return {
      queued: counts.queued ?? 0,
      launchPending: counts.launch_pending ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      attentionRequired: counts.attention_required ?? 0,
      notStarted: counts.not_started ?? 0,
    };
  }

  private toRun(row: ProjectRunRow): ProjectRun {
    const items = this.database
      .prepare(
        'SELECT * FROM project_run_items WHERE run_id = ? ORDER BY queue_position, id',
      )
      .all(row.id) as ProjectRunItemRow[];
    return projectRunSchema.parse({
      id: row.id,
      projectId: row.project_id,
      state: row.state,
      revision: row.revision,
      concurrency: row.concurrency,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      completionReason: row.completion_reason,
      pauseReason: row.pause_reason,
      items: items.map(toItem),
    });
  }

  private bumpRevision(
    id: string,
    expectedRevision: number,
    updatedAt: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE project_runs
      SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
        )
        .run(updatedAt, id, expectedRevision).changes === 1
    );
  }

  private transaction<Result>(execute: () => Result): Result {
    if (this.database.inTransaction) return execute();
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

  private nonEmpty(value: string | undefined, label: string): string {
    if (!value?.trim()) throw new TypeError(`${label} is required`);
    return value;
  }
}
