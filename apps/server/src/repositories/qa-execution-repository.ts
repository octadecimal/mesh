import {
  idSchema,
  qaExecutionCycleSchema,
  qaReportSchema,
  reviewAutomationActionSchema,
  type QaExecutionCycle,
  type QaReport,
  type ReviewAutomationAction,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type CycleRow = {
  id: string;
  task_id: string;
  attempt_id: string;
  session_id: string;
  ordinal: number;
  snapshot_json: string;
  review_policy: string;
  automation_generation: number;
  rejection_ordinal: number;
  disposition: string | null;
  started_at: string;
  terminal_at: string | null;
  report_id: string | null;
  terminal_command_id: string | null;
  terminal_event_id: string | null;
  interrupted_at: string | null;
  interruption_command_id: string | null;
  interruption_event_id: string | null;
};

type ReportRow = {
  id: string;
  cycle_id: string;
  report_json: string;
  created_at: string;
};

type ActionRow = {
  id: string;
  idempotency_key: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  source_developer_cycle_id: string | null;
  source_qa_cycle_id: string | null;
  action_kind: string;
  generation: number;
  status: string;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
};

type CycleSnapshot = Pick<
  QaExecutionCycle,
  | 'authorizedBy'
  | 'authorizationCommandId'
  | 'policyVersion'
  | 'qaInstructions'
  | 'taskSnapshot'
  | 'developerCompletionReportId'
  | 'workspaceId'
  | 'workspaceBaseline'
  | 'taskFingerprint'
  | 'reviewPolicyRevision'
>;

type CompleteCycle = Pick<
  QaExecutionCycle,
  | 'endedAt'
  | 'terminalDisposition'
  | 'reportId'
  | 'terminalCommandId'
  | 'terminalEventId'
>;

type InterruptCycle = Pick<
  QaExecutionCycle,
  'endedAt' | 'terminalCommandId' | 'terminalEventId'
>;

const assertDurableActionState = (
  action: ReviewAutomationAction,
): ReviewAutomationAction => {
  if (action.status === 'pending') {
    if (action.completedAt !== null || action.errorCode !== null) {
      throw new TypeError(
        'Pending automation actions may not have completion metadata',
      );
    }
    return action;
  }
  if (action.status === 'completed') {
    if (action.completedAt === null || action.errorCode !== null) {
      throw new TypeError(
        'Completed automation actions require a completion time and no error',
      );
    }
    return action;
  }
  if (action.completedAt === null || action.errorCode === null) {
    throw new TypeError(
      'Failed automation actions require a completion time and error code',
    );
  }
  return action;
};

const toCycle = (row: CycleRow): QaExecutionCycle => {
  const snapshot = JSON.parse(row.snapshot_json) as CycleSnapshot;
  return qaExecutionCycleSchema.parse({
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    ...snapshot,
    reviewPolicy: row.review_policy,
    automationGeneration: row.automation_generation,
    rejectionOrdinal: row.rejection_ordinal,
    startedAt: row.started_at,
    endedAt: row.interrupted_at ?? row.terminal_at,
    terminalDisposition: row.interrupted_at ? 'interrupted' : row.disposition,
    reportId: row.report_id,
    terminalCommandId: row.interruption_command_id ?? row.terminal_command_id,
    terminalEventId: row.interruption_event_id ?? row.terminal_event_id,
  });
};

const toReport = (row: ReportRow): QaReport => {
  const report = qaReportSchema.parse(JSON.parse(row.report_json));
  if (
    report.id !== row.id ||
    report.cycleId !== row.cycle_id ||
    report.createdAt !== row.created_at
  ) {
    throw new Error('QA report row does not match its immutable snapshot');
  }
  return report;
};

const toAction = (row: ActionRow): ReviewAutomationAction =>
  reviewAutomationActionSchema.parse({
    id: row.id,
    idempotencyKey: row.idempotency_key,
    projectId: row.project_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    sourceCycleId:
      row.source_developer_cycle_id ??
      row.source_qa_cycle_id ??
      (() => {
        throw new Error('Automation action source cycle is missing');
      })(),
    actionKind: row.action_kind,
    generation: row.generation,
    status: row.status,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });

export class QaExecutionRepository {
  private readonly insertCycle;
  private readonly selectCycle;
  private readonly completeActiveCycle;
  private readonly interruptActiveCycle;
  private readonly insertReportStatement;
  private readonly selectReport;
  private readonly selectTerminalReport;
  private readonly selectActionByIdempotencyKey;
  private readonly selectActionBySource;
  private readonly insertAction;
  private readonly completeAction;
  private readonly selectAction;
  private readonly selectPendingActions;

  constructor(private readonly database: Database) {
    this.insertCycle = database.prepare(`
      INSERT INTO qa_execution_cycles (
        id, task_id, attempt_id, session_id, ordinal, snapshot_json,
        review_policy, automation_generation, rejection_ordinal, disposition,
        started_at, terminal_at, report_id, terminal_command_id, terminal_event_id
      ) VALUES (
        @id, @taskId, @attemptId, @sessionId, @ordinal, @snapshotJson,
        @reviewPolicy, @automationGeneration, @rejectionOrdinal,
        @terminalDisposition, @startedAt, @endedAt, @reportId,
        @terminalCommandId, @terminalEventId
      )
    `);
    this.selectCycle = database.prepare(
      'SELECT * FROM qa_execution_cycles WHERE id = ?',
    );
    this.completeActiveCycle = database.prepare(`
      UPDATE qa_execution_cycles
      SET disposition = @terminalDisposition,
          terminal_at = @endedAt,
          report_id = @reportId,
          terminal_command_id = @terminalCommandId,
          terminal_event_id = @terminalEventId
      WHERE id = @id AND terminal_at IS NULL AND interrupted_at IS NULL
    `);
    this.interruptActiveCycle = database.prepare(`
      UPDATE qa_execution_cycles
      SET interrupted_at = @endedAt,
          interruption_command_id = @terminalCommandId,
          interruption_event_id = @terminalEventId
      WHERE id = @id AND terminal_at IS NULL AND interrupted_at IS NULL
    `);
    this.insertReportStatement = database.prepare(`
      INSERT INTO qa_reports (id, cycle_id, report_json, created_at)
      VALUES (@id, @cycleId, @reportJson, @createdAt)
    `);
    this.selectReport = database.prepare(
      'SELECT * FROM qa_reports WHERE id = ?',
    );
    this.selectTerminalReport = database.prepare(`
      SELECT *
      FROM qa_reports
      WHERE id = @id
        AND cycle_id = @cycleId
        AND json_extract(report_json, '$.disposition') = @disposition
    `);
    this.selectActionByIdempotencyKey = database.prepare(
      'SELECT * FROM review_automation_actions_v2 WHERE idempotency_key = ?',
    );
    this.selectActionBySource = database.prepare(`
      SELECT *
      FROM review_automation_actions_v2
      WHERE COALESCE(source_developer_cycle_id, source_qa_cycle_id) = @sourceCycleId
        AND action_kind = @actionKind
      ORDER BY generation DESC, created_at DESC, id DESC
      LIMIT 1
    `);
    this.insertAction = database.prepare(`
      INSERT INTO review_automation_actions_v2 (
        id, idempotency_key, project_id, task_id, attempt_id,
        source_developer_cycle_id, source_qa_cycle_id,
        action_kind, generation, status, error_code, created_at, completed_at
      ) VALUES (
        @id, @idempotencyKey, @projectId, @taskId, @attemptId,
        @sourceDeveloperCycleId, @sourceQaCycleId,
        @actionKind, @generation, @status, @errorCode, @createdAt, @completedAt
      ) ON CONFLICT(idempotency_key) DO NOTHING
    `);
    this.completeAction = database.prepare(`
      UPDATE review_automation_actions_v2
      SET status = @status, error_code = @errorCode, completed_at = @completedAt
      WHERE id = @id AND status = 'pending'
    `);
    this.selectAction = database.prepare(
      'SELECT * FROM review_automation_actions_v2 WHERE id = ?',
    );
    this.selectPendingActions = database.prepare(
      "SELECT * FROM review_automation_actions_v2 WHERE status = 'pending' ORDER BY created_at, id",
    );
  }

  createCycle(cycle: QaExecutionCycle): QaExecutionCycle {
    const value = qaExecutionCycleSchema.parse(cycle);
    if (
      value.endedAt !== null ||
      value.terminalDisposition !== null ||
      value.reportId !== null ||
      value.terminalCommandId !== null ||
      value.terminalEventId !== null
    ) {
      throw new TypeError('QA cycles must be created active');
    }
    this.insertCycle.run({
      ...value,
      snapshotJson: JSON.stringify(this.cycleSnapshot(value)),
    });
    return value;
  }

  getCycle(id: string): QaExecutionCycle | undefined {
    const row = this.selectCycle.get(idSchema.parse(id)) as
      | CycleRow
      | undefined;
    return row ? toCycle(row) : undefined;
  }

  getActiveCycleBySession(sessionId: string): QaExecutionCycle | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM qa_execution_cycles
         WHERE session_id = ? AND terminal_at IS NULL AND interrupted_at IS NULL
         ORDER BY ordinal DESC, id DESC LIMIT 1`,
      )
      .get(idSchema.parse(sessionId)) as CycleRow | undefined;
    return row ? toCycle(row) : undefined;
  }

  hasCycleForSession(sessionId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          'SELECT 1 FROM qa_execution_cycles WHERE session_id = ? LIMIT 1',
        )
        .get(idSchema.parse(sessionId)),
    );
  }

  listCyclesForAttempts(attemptIds: readonly string[]): QaExecutionCycle[] {
    const ids = attemptIds.map((id) => idSchema.parse(id));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return (
      this.database
        .prepare(
          `SELECT * FROM qa_execution_cycles WHERE attempt_id IN (${placeholders}) ORDER BY attempt_id, ordinal, id`,
        )
        .all(...ids) as CycleRow[]
    ).map(toCycle);
  }

  completeCycle(
    id: string,
    update: CompleteCycle,
  ): QaExecutionCycle | undefined {
    const current = this.getCycle(id);
    if (!current || current.endedAt !== null) return undefined;
    const value = qaExecutionCycleSchema.parse({ ...current, ...update });
    if (
      value.terminalDisposition === null ||
      value.reportId === null ||
      value.endedAt === null
    ) {
      throw new TypeError('Terminal QA cycle metadata is required');
    }
    const terminalReport = this.selectTerminalReport.get({
      id: value.reportId,
      cycleId: value.id,
      disposition: value.terminalDisposition,
    }) as ReportRow | undefined;
    if (!terminalReport) {
      throw new Error(
        'Terminal QA report must exist for the completed cycle and disposition',
      );
    }
    toReport(terminalReport);
    const result = this.completeActiveCycle.run(value);
    return result.changes === 1 ? value : undefined;
  }

  interruptCycle(
    id: string,
    update: InterruptCycle,
  ): QaExecutionCycle | undefined {
    const current = this.getCycle(id);
    if (!current || current.endedAt !== null) return undefined;
    const value = qaExecutionCycleSchema.parse({
      ...current,
      ...update,
      terminalDisposition: 'interrupted',
      reportId: null,
    });
    const result = this.interruptActiveCycle.run({ id: value.id, ...update });
    return result.changes === 1 ? value : undefined;
  }

  insertReport(report: QaReport): QaReport {
    const value = qaReportSchema.parse(report);
    this.insertReportStatement.run({
      id: value.id,
      cycleId: value.cycleId,
      reportJson: JSON.stringify(value),
      createdAt: value.createdAt,
    });
    return value;
  }

  getReport(id: string): QaReport | undefined {
    const row = this.selectReport.get(idSchema.parse(id)) as
      | ReportRow
      | undefined;
    return row ? toReport(row) : undefined;
  }

  getAutomationAction(id: string): ReviewAutomationAction | undefined {
    const row = this.selectAction.get(idSchema.parse(id)) as
      | ActionRow
      | undefined;
    return row ? toAction(row) : undefined;
  }

  getAutomationActionByIdempotencyKey(
    idempotencyKey: string,
  ): ReviewAutomationAction | undefined {
    const row = this.selectActionByIdempotencyKey.get(
      idSchema.parse(idempotencyKey),
    ) as ActionRow | undefined;
    return row ? toAction(row) : undefined;
  }

  getAutomationActionBySource(
    sourceCycleId: string,
    actionKind: ReviewAutomationAction['actionKind'],
  ): ReviewAutomationAction | undefined {
    const row = this.selectActionBySource.get({
      sourceCycleId: idSchema.parse(sourceCycleId),
      actionKind,
    }) as ActionRow | undefined;
    return row ? toAction(row) : undefined;
  }

  listReportsForAttempts(attemptIds: readonly string[]): QaReport[] {
    const ids = attemptIds.map((id) => idSchema.parse(id));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return (
      this.database
        .prepare(
          `
          SELECT report.*
          FROM qa_reports AS report
          JOIN qa_execution_cycles AS cycle ON cycle.id = report.cycle_id
          WHERE cycle.attempt_id IN (${placeholders})
          ORDER BY cycle.attempt_id, cycle.ordinal, report.created_at, report.id
        `,
        )
        .all(...ids) as ReportRow[]
    ).map(toReport);
  }

  listAutomationActionsForTasks(
    taskIds: readonly string[],
  ): ReviewAutomationAction[] {
    const ids = taskIds.map((id) => idSchema.parse(id));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return (
      this.database
        .prepare(
          `
          SELECT *
          FROM review_automation_actions_v2
          WHERE task_id IN (${placeholders})
          ORDER BY task_id, created_at, id
        `,
        )
        .all(...ids) as ActionRow[]
    ).map(toAction);
  }

  insertAutomationAction(
    action: ReviewAutomationAction,
  ): ReviewAutomationAction {
    const value = assertDurableActionState(
      reviewAutomationActionSchema.parse(action),
    );
    const result = this.insertAction.run({
      ...value,
      sourceDeveloperCycleId:
        value.actionKind === 'launch_qa' ? value.sourceCycleId : null,
      sourceQaCycleId:
        value.actionKind === 'launch_qa' ? null : value.sourceCycleId,
    });
    if (result.changes === 1) return value;
    const existing = this.selectActionByIdempotencyKey.get(
      value.idempotencyKey,
    ) as ActionRow | undefined;
    if (!existing) throw new Error('Automation action conflict was not found');
    return toAction(existing);
  }

  completeAutomationAction(
    id: string,
    completion: Pick<
      ReviewAutomationAction,
      'status' | 'errorCode' | 'completedAt'
    >,
  ): ReviewAutomationAction | undefined {
    const current = this.selectAction.get(idSchema.parse(id)) as
      | ActionRow
      | undefined;
    if (!current) return undefined;
    const value = assertDurableActionState(
      reviewAutomationActionSchema.parse({
        ...toAction(current),
        ...completion,
      }),
    );
    if (value.status === 'pending') {
      throw new TypeError(
        'Automation actions must complete with a terminal status',
      );
    }
    const result = this.completeAction.run(value);
    return result.changes === 1 ? value : undefined;
  }

  listPendingAutomationActions(): ReviewAutomationAction[] {
    return (this.selectPendingActions.all() as ActionRow[]).map(toAction);
  }

  private cycleSnapshot(cycle: QaExecutionCycle): CycleSnapshot {
    return {
      authorizedBy: cycle.authorizedBy,
      authorizationCommandId: cycle.authorizationCommandId,
      policyVersion: cycle.policyVersion,
      qaInstructions: cycle.qaInstructions,
      taskSnapshot: cycle.taskSnapshot,
      developerCompletionReportId: cycle.developerCompletionReportId,
      workspaceId: cycle.workspaceId,
      workspaceBaseline: cycle.workspaceBaseline,
      taskFingerprint: cycle.taskFingerprint,
      reviewPolicyRevision: cycle.reviewPolicyRevision,
    };
  }
}
