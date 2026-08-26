import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  developerReviewFeedbackSchema,
  idSchema,
  isoTimestampSchema,
  type DeveloperBlockerReport,
  type DeveloperCompletionReport,
  type DeveloperExecutionCycle,
  type DeveloperReviewFeedback,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type CycleRow = {
  id: string;
  attempt_id: string;
  ordinal: number;
  mode: string;
  authorized_by_json: string;
  authorization_command_id: string;
  policy_version: string;
  project_instructions_content: string;
  project_instructions_revision: number;
  task_snapshot_revision: number;
  task_snapshot_title: string;
  task_snapshot_description: string;
  task_snapshot_acceptance_criteria_json: string;
  workspace_id: string;
  permission_mode: string;
  started_at: string;
  ended_at: string | null;
  terminal_disposition: string | null;
  completion_report_id: string | null;
  blocker_report_id: string | null;
  terminal_command_id: string | null;
  terminal_event_id: string | null;
};

type CompletionReportRow = {
  id: string;
  cycle_id: string;
  summary: string;
  criterion_results_json: string;
  verification_json: string;
  limitations: string;
  workspace_state_json: string;
  reviewer_notes: string | null;
  created_at: string;
};

type BlockerReportRow = {
  id: string;
  cycle_id: string;
  reason: string;
  evidence: string;
  attempted_work: string;
  suggested_human_action: string;
  preserve_workspace: number;
  created_at: string;
};

type FeedbackRow = {
  id: string;
  cycle_id: string;
  task_id: string;
  kind: string;
  feedback: string;
  actor_json: string;
  command_id: string;
  created_at: string;
};

type CloseCycle = Pick<
  DeveloperExecutionCycle,
  | 'endedAt'
  | 'terminalDisposition'
  | 'completionReportId'
  | 'blockerReportId'
  | 'terminalCommandId'
  | 'terminalEventId'
>;

const toCycle = (row: CycleRow): DeveloperExecutionCycle =>
  developerExecutionCycleSchema.parse({
    id: row.id,
    attemptId: row.attempt_id,
    ordinal: row.ordinal,
    mode: row.mode,
    authorizedBy: JSON.parse(row.authorized_by_json),
    authorizationCommandId: row.authorization_command_id,
    policyVersion: row.policy_version,
    projectInstructions: {
      content: row.project_instructions_content,
      revision: row.project_instructions_revision,
    },
    taskSnapshot: {
      revision: row.task_snapshot_revision,
      title: row.task_snapshot_title,
      description: row.task_snapshot_description,
      acceptanceCriteria: JSON.parse(
        row.task_snapshot_acceptance_criteria_json,
      ),
    },
    workspaceId: row.workspace_id,
    permissionMode: row.permission_mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    terminalDisposition: row.terminal_disposition,
    completionReportId: row.completion_report_id,
    blockerReportId: row.blocker_report_id,
    terminalCommandId: row.terminal_command_id,
    terminalEventId: row.terminal_event_id,
  });

const toCompletionReport = (
  row: CompletionReportRow,
): DeveloperCompletionReport =>
  developerCompletionReportSchema.parse({
    id: row.id,
    cycleId: row.cycle_id,
    summary: row.summary,
    criterionResults: JSON.parse(row.criterion_results_json),
    verification: JSON.parse(row.verification_json),
    limitations: row.limitations,
    workspaceState: JSON.parse(row.workspace_state_json),
    reviewerNotes: row.reviewer_notes,
    createdAt: row.created_at,
  });

const toBlockerReport = (row: BlockerReportRow): DeveloperBlockerReport =>
  developerBlockerReportSchema.parse({
    id: row.id,
    cycleId: row.cycle_id,
    reason: row.reason,
    evidence: row.evidence,
    attemptedWork: row.attempted_work,
    suggestedHumanAction: row.suggested_human_action,
    preserveWorkspace: row.preserve_workspace === 1,
    createdAt: row.created_at,
  });

const toFeedback = (row: FeedbackRow): DeveloperReviewFeedback =>
  developerReviewFeedbackSchema.parse({
    id: row.id,
    cycleId: row.cycle_id,
    taskId: row.task_id,
    kind: row.kind,
    feedback: row.feedback,
    actor: JSON.parse(row.actor_json),
    commandId: row.command_id,
    createdAt: row.created_at,
  });

export class DeveloperExecutionRepository {
  private readonly insertCycle;
  private readonly selectCycle;
  private readonly selectActiveBySession;
  private readonly selectByTask;
  private readonly closeActiveCycle;
  private readonly insertCompletionReport;
  private readonly insertBlockerReport;
  private readonly insertFeedback;
  private readonly selectCompletionReportsByTask;
  private readonly selectBlockerReportsByTask;
  private readonly selectFeedbackByTask;

  constructor(private readonly database: Database) {
    this.insertCycle = database.prepare(`
      INSERT INTO developer_execution_cycles (
        id, attempt_id, ordinal, mode, authorized_by_json,
        authorization_command_id, policy_version,
        project_instructions_content, project_instructions_revision,
        task_snapshot_revision, task_snapshot_title, task_snapshot_description,
        task_snapshot_acceptance_criteria_json, workspace_id, permission_mode,
        started_at, ended_at, terminal_disposition, completion_report_id,
        blocker_report_id, terminal_command_id, terminal_event_id
      ) VALUES (
        @id, @attemptId, @ordinal, @mode, @authorizedByJson,
        @authorizationCommandId, @policyVersion,
        @projectInstructionsContent, @projectInstructionsRevision,
        @taskSnapshotRevision, @taskSnapshotTitle, @taskSnapshotDescription,
        @taskSnapshotAcceptanceCriteriaJson, @workspaceId, @permissionMode,
        @startedAt, @endedAt, @terminalDisposition, @completionReportId,
        @blockerReportId, @terminalCommandId, @terminalEventId
      )
    `);
    this.selectCycle = database.prepare(
      'SELECT * FROM developer_execution_cycles WHERE id = ?',
    );
    this.selectActiveBySession = database.prepare(`
      SELECT cycle.*
      FROM developer_execution_cycles AS cycle
      JOIN task_attempts AS attempt ON attempt.id = cycle.attempt_id
      WHERE attempt.session_id = ? AND cycle.ended_at IS NULL
    `);
    this.selectByTask = database.prepare(`
      SELECT cycle.*
      FROM developer_execution_cycles AS cycle
      JOIN task_attempts AS attempt ON attempt.id = cycle.attempt_id
      WHERE attempt.task_id = ?
      ORDER BY attempt.ordinal, cycle.ordinal, cycle.id
    `);
    this.closeActiveCycle = database.prepare(`
      UPDATE developer_execution_cycles
      SET ended_at = @endedAt,
          terminal_disposition = @terminalDisposition,
          completion_report_id = @completionReportId,
          blocker_report_id = @blockerReportId,
          terminal_command_id = @terminalCommandId,
          terminal_event_id = @terminalEventId
      WHERE id = @id AND ended_at IS NULL
    `);
    this.insertCompletionReport = database.prepare(`
      INSERT INTO developer_completion_reports (
        id, cycle_id, summary, criterion_results_json, verification_json,
        limitations, workspace_state_json, reviewer_notes, created_at
      ) VALUES (
        @id, @cycleId, @summary, @criterionResultsJson, @verificationJson,
        @limitations, @workspaceStateJson, @reviewerNotes, @createdAt
      )
    `);
    this.insertBlockerReport = database.prepare(`
      INSERT INTO developer_blocker_reports (
        id, cycle_id, reason, evidence, attempted_work,
        suggested_human_action, preserve_workspace, created_at
      ) VALUES (
        @id, @cycleId, @reason, @evidence, @attemptedWork,
        @suggestedHumanAction, @preserveWorkspace, @createdAt
      )
    `);
    this.insertFeedback = database.prepare(`
      INSERT INTO developer_review_feedback (
        id, cycle_id, task_id, kind, feedback, actor_json, command_id, created_at
      ) VALUES (
        @id, @cycleId, @taskId, @kind, @feedback, @actorJson, @commandId, @createdAt
      )
    `);
    this.selectCompletionReportsByTask = database.prepare(`
      SELECT report.*
      FROM developer_completion_reports AS report
      JOIN developer_execution_cycles AS cycle ON cycle.id = report.cycle_id
      JOIN task_attempts AS attempt ON attempt.id = cycle.attempt_id
      WHERE attempt.task_id = ?
      ORDER BY attempt.ordinal, cycle.ordinal, report.created_at, report.id
    `);
    this.selectBlockerReportsByTask = database.prepare(`
      SELECT report.*
      FROM developer_blocker_reports AS report
      JOIN developer_execution_cycles AS cycle ON cycle.id = report.cycle_id
      JOIN task_attempts AS attempt ON attempt.id = cycle.attempt_id
      WHERE attempt.task_id = ?
      ORDER BY attempt.ordinal, cycle.ordinal, report.created_at, report.id
    `);
    this.selectFeedbackByTask = database.prepare(`
      SELECT feedback.*
      FROM developer_review_feedback AS feedback
      JOIN developer_execution_cycles AS cycle ON cycle.id = feedback.cycle_id
      JOIN task_attempts AS attempt ON attempt.id = cycle.attempt_id
      WHERE attempt.task_id = ?
      ORDER BY attempt.ordinal, cycle.ordinal, feedback.created_at, feedback.id
    `);
  }

  createCycle(cycle: DeveloperExecutionCycle): DeveloperExecutionCycle {
    const value = developerExecutionCycleSchema.parse(cycle);
    this.insertCycle.run(this.toCycleParameters(value));
    return value;
  }

  getCycle(id: string): DeveloperExecutionCycle | undefined {
    const row = this.selectCycle.get(idSchema.parse(id)) as
      | CycleRow
      | undefined;
    return row ? toCycle(row) : undefined;
  }

  getActiveCycleBySession(
    sessionId: string,
  ): DeveloperExecutionCycle | undefined {
    const row = this.selectActiveBySession.get(idSchema.parse(sessionId)) as
      | CycleRow
      | undefined;
    return row ? toCycle(row) : undefined;
  }

  closeCycle(
    id: string,
    update: CloseCycle,
  ): DeveloperExecutionCycle | undefined {
    const current = this.getCycle(id);
    if (!current || current.endedAt !== null) return undefined;
    const endedAt = isoTimestampSchema.parse(update.endedAt);
    const value = developerExecutionCycleSchema.parse({
      ...current,
      ...update,
      endedAt,
    });
    if (value.endedAt === null) {
      throw new TypeError('Developer cycle end time is required when closing');
    }
    const result = this.closeActiveCycle.run({
      id: value.id,
      ...this.toCycleParameters(value),
    });
    return result.changes === 1 ? value : undefined;
  }

  appendCompletionReport(
    report: DeveloperCompletionReport,
  ): DeveloperCompletionReport {
    const value = developerCompletionReportSchema.parse(report);
    this.insertCompletionReport.run({
      ...value,
      criterionResultsJson: JSON.stringify(value.criterionResults),
      verificationJson: JSON.stringify(value.verification),
      workspaceStateJson: JSON.stringify(value.workspaceState),
    });
    return value;
  }

  appendBlockerReport(report: DeveloperBlockerReport): DeveloperBlockerReport {
    const value = developerBlockerReportSchema.parse(report);
    this.insertBlockerReport.run({
      ...value,
      preserveWorkspace: value.preserveWorkspace ? 1 : 0,
    });
    return value;
  }

  appendFeedback(feedback: DeveloperReviewFeedback): DeveloperReviewFeedback {
    const value = developerReviewFeedbackSchema.parse(feedback);
    this.insertFeedback.run({
      ...value,
      actorJson: JSON.stringify(value.actor),
    });
    return value;
  }

  listByTask(taskId: string): DeveloperExecutionCycle[] {
    return (this.selectByTask.all(idSchema.parse(taskId)) as CycleRow[]).map(
      toCycle,
    );
  }

  listCompletionReportsByTask(taskId: string): DeveloperCompletionReport[] {
    return (
      this.selectCompletionReportsByTask.all(
        idSchema.parse(taskId),
      ) as CompletionReportRow[]
    ).map(toCompletionReport);
  }

  listBlockerReportsByTask(taskId: string): DeveloperBlockerReport[] {
    return (
      this.selectBlockerReportsByTask.all(
        idSchema.parse(taskId),
      ) as BlockerReportRow[]
    ).map(toBlockerReport);
  }

  listFeedbackByTask(taskId: string): DeveloperReviewFeedback[] {
    return (
      this.selectFeedbackByTask.all(idSchema.parse(taskId)) as FeedbackRow[]
    ).map(toFeedback);
  }

  private toCycleParameters(cycle: DeveloperExecutionCycle) {
    return {
      ...cycle,
      authorizedByJson: JSON.stringify(cycle.authorizedBy),
      projectInstructionsContent: cycle.projectInstructions.content,
      projectInstructionsRevision: cycle.projectInstructions.revision,
      taskSnapshotRevision: cycle.taskSnapshot.revision,
      taskSnapshotTitle: cycle.taskSnapshot.title,
      taskSnapshotDescription: cycle.taskSnapshot.description,
      taskSnapshotAcceptanceCriteriaJson: JSON.stringify(
        cycle.taskSnapshot.acceptanceCriteria,
      ),
    };
  }
}
