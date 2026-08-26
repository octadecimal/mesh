import {
  projectSchema,
  projectChangedEventSchema,
  qaExecutionCycleSchema,
  qaReportSchema,
  reviewAutomationActionSchema,
  sessionSchema,
  taskAttemptSchema,
  taskSchema,
  workspaceSchema,
  type QaExecutionCycle,
  type QaReport,
  type ReviewAutomationAction,
} from '@mesh-session-platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestRepositories } from '../test/create-test-database.js';

const at = '2026-08-26T00:00:00.000Z';

const setup = (options?: { failProjectEventInsert?: boolean }) => {
  const repo = createTestRepositories(options);
  repo.projects.create(
    projectSchema.parse({
      id: 'project-1',
      displayName: 'Project',
      repositoryPath: 'C:/code/project',
      discoveredAt: at,
      discoveryMetadata: {},
    }),
  );
  repo.workspaces.create(
    workspaceSchema.parse({
      id: 'workspace-1',
      projectId: 'project-1',
      type: 'shared',
      path: 'C:/code/project',
    }),
  );
  repo.sessions.create(
    sessionSchema.parse({
      id: 'session-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      title: 'Task',
      permissionMode: 'interactive',
      lifecycleState: 'running',
      createdAt: at,
      updatedAt: at,
    }),
  );
  repo.tasks.create(
    taskSchema.parse({
      id: 'task-1',
      projectId: 'project-1',
      title: 'Task',
      description: 'Verify persistence.',
      acceptanceCriteria: ['Persist QA records'],
      priority: 'normal',
      rank: 'a',
      lifecycleState: 'review',
      labels: [],
      notes: '',
      blocked: null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    }),
  );
  repo.attempts.create(
    taskAttemptSchema.parse({
      id: 'attempt-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      ordinal: 1,
      source: 'launched',
      actor: { type: 'human', id: 'human-1' },
      createdAt: at,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
      role: null,
    }),
  );
  return repo;
};

const cycle = (ordinal: number): QaExecutionCycle =>
  qaExecutionCycleSchema.parse({
    id: `cycle-${ordinal}`,
    taskId: 'task-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    ordinal,
    authorizedBy: { type: 'human', id: 'human-1' },
    authorizationCommandId: `command-${ordinal}`,
    policyVersion: 'qa-policy-v1',
    qaInstructions: { content: 'Run focused tests.', revision: 1 },
    taskSnapshot: {
      revision: 1,
      title: 'Task',
      description: 'Verify persistence.',
      acceptanceCriteria: [{ id: 'criterion-1', text: 'Persist QA records' }],
    },
    developerCompletionReportId: 'developer-report-1',
    workspaceId: 'workspace-1',
    reviewPolicy: 'manual',
    reviewPolicyRevision: 1,
    automationGeneration: 0,
    rejectionOrdinal: 0,
    startedAt: at,
    endedAt: null,
    terminalDisposition: null,
    reportId: null,
    terminalCommandId: null,
    terminalEventId: null,
  });

const report = (cycleId = 'cycle-1'): QaReport =>
  qaReportSchema.parse({
    id: `report-${cycleId}`,
    cycleId,
    disposition: 'verified',
    criterionResults: [
      { criterionId: 'criterion-1', status: 'passed', evidence: 'Passed.' },
    ],
    verificationCommands: [{ command: 'pnpm test', outcome: 'passed' }],
    limitations: [],
    residualRisks: [],
    workspaceBefore: 'clean',
    workspaceAfter: 'clean',
    createdAt: at,
  });

const action = (): ReviewAutomationAction =>
  reviewAutomationActionSchema.parse({
    id: 'action-1',
    idempotencyKey: 'action-key-1',
    projectId: 'project-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    sourceCycleId: 'cycle-1',
    actionKind: 'launch_qa',
    generation: 0,
    status: 'pending',
    errorCode: null,
    createdAt: at,
    completedAt: null,
  });

describe('QaExecutionRepository', () => {
  const repositories: Array<ReturnType<typeof createTestRepositories>> = [];

  afterEach(() => repositories.splice(0).forEach((repo) => repo.dispose()));

  it('lists cycles for attempts in ordinal order', () => {
    const repo = setup();
    repositories.push(repo);
    const firstCycle = repo.qaExecutions.createCycle(cycle(1));
    const secondCycle = repo.qaExecutions.createCycle(cycle(2));

    expect(repo.qaExecutions.listCyclesForAttempts(['attempt-1'])).toEqual([
      firstCycle,
      secondCycle,
    ]);
  });

  it('creates only active cycles and rejects direct terminal-cycle inserts', () => {
    const repo = setup();
    repositories.push(repo);
    const terminalCycle = qaExecutionCycleSchema.parse({
      ...cycle(1),
      endedAt: at,
      terminalDisposition: 'verified',
      reportId: 'report-cycle-1',
      terminalCommandId: 'command-terminal-1',
      terminalEventId: 'event-terminal-1',
    });

    expect(() => repo.qaExecutions.createCycle(terminalCycle)).toThrow(
      'QA cycles must be created active',
    );
    expect(() =>
      repo.database
        .prepare(
          `INSERT INTO qa_execution_cycles (
            id, task_id, attempt_id, session_id, ordinal, snapshot_json,
            review_policy, automation_generation, rejection_ordinal, disposition,
            started_at, terminal_at, report_id, terminal_command_id, terminal_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'terminal-cycle-sql',
          'task-1',
          'attempt-1',
          'session-1',
          1,
          '{}',
          'manual',
          0,
          0,
          'verified',
          at,
          at,
          'report-cycle-1',
          'command-terminal-1',
          'event-terminal-1',
        ),
    ).toThrow('QA terminal report must match its cycle and disposition');
  });

  it('persists immutable terminal reports', () => {
    const repo = setup();
    repositories.push(repo);
    repo.qaExecutions.createCycle(cycle(1));
    const original = repo.qaExecutions.insertReport(report());

    expect(repo.qaExecutions.getReport(original.id)).toEqual(original);
    expect(repo.qaExecutions.listReportsForAttempts(['attempt-1'])).toEqual([
      original,
    ]);
    expect(() =>
      repo.qaExecutions.insertReport({ ...report(), id: 'report-conflict' }),
    ).toThrow();
    expect(() =>
      repo.database
        .prepare('UPDATE qa_reports SET report_json = ? WHERE id = ?')
        .run('{}', original.id),
    ).toThrow('QA reports are immutable');
  });

  it('closes an active cycle with its terminal metadata', () => {
    const repo = setup();
    repositories.push(repo);
    repo.qaExecutions.createCycle(cycle(1));
    const terminalReport = repo.qaExecutions.insertReport(report());

    expect(
      repo.qaExecutions.completeCycle('cycle-1', {
        endedAt: at,
        terminalDisposition: 'verified',
        reportId: terminalReport.id,
        terminalCommandId: 'command-terminal-1',
        terminalEventId: 'event-terminal-1',
      }),
    ).toMatchObject({
      endedAt: at,
      terminalDisposition: 'verified',
      reportId: terminalReport.id,
    });
  });

  it('rejects terminal reports that are missing, belong to another cycle, or disagree with the disposition', () => {
    const repo = setup();
    repositories.push(repo);
    repo.qaExecutions.createCycle(cycle(1));
    repo.qaExecutions.createCycle(cycle(2));

    const terminal = {
      endedAt: at,
      terminalDisposition: 'verified' as const,
      reportId: 'missing-report',
      terminalCommandId: 'command-terminal-1',
      terminalEventId: 'event-terminal-1',
    };
    expect(() => repo.qaExecutions.completeCycle('cycle-1', terminal)).toThrow(
      'Terminal QA report must exist for the completed cycle and disposition',
    );

    const otherCycleReport = repo.qaExecutions.insertReport(report('cycle-1'));
    expect(() =>
      repo.qaExecutions.completeCycle('cycle-2', {
        ...terminal,
        reportId: otherCycleReport.id,
      }),
    ).toThrow(
      'Terminal QA report must exist for the completed cycle and disposition',
    );

    const rejectedReport = repo.qaExecutions.insertReport(
      qaReportSchema.parse({ ...report('cycle-2'), disposition: 'rejected' }),
    );
    expect(() =>
      repo.qaExecutions.completeCycle('cycle-2', {
        ...terminal,
        reportId: rejectedReport.id,
      }),
    ).toThrow(
      'Terminal QA report must exist for the completed cycle and disposition',
    );
  });

  it('returns the original action for a duplicate idempotency key', () => {
    const repo = setup();
    repositories.push(repo);
    repo.qaExecutions.createCycle(cycle(1));
    const original = repo.qaExecutions.insertAutomationAction(action());
    const duplicate = { ...action(), id: 'action-2' };

    expect(repo.qaExecutions.insertAutomationAction(duplicate)).toEqual(
      original,
    );
    expect(repo.qaExecutions.listPendingAutomationActions()).toEqual([
      original,
    ]);
    expect(
      repo.qaExecutions.completeAutomationAction('action-1', {
        status: 'completed',
        errorCode: null,
        completedAt: at,
      }),
    ).toMatchObject({ status: 'completed', completedAt: at });
    expect(repo.qaExecutions.listPendingAutomationActions()).toEqual([]);
  });

  it('enforces durable automation action states', () => {
    const repo = setup();
    repositories.push(repo);
    repo.qaExecutions.createCycle(cycle(1));

    expect(() =>
      repo.qaExecutions.insertAutomationAction(
        reviewAutomationActionSchema.parse({
          ...action(),
          id: 'invalid-pending',
          idempotencyKey: 'invalid-pending-key',
          errorCode: 'unexpected',
        }),
      ),
    ).toThrow('Pending automation actions may not have completion metadata');
    expect(() =>
      repo.database
        .prepare(
          `INSERT INTO review_automation_actions (
            id, idempotency_key, project_id, task_id, attempt_id, source_cycle_id,
            action_kind, generation, status, error_code, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'invalid-durable-action',
          'invalid-durable-action-key',
          'project-1',
          'task-1',
          'attempt-1',
          'cycle-1',
          'launch_qa',
          0,
          'completed',
          'unexpected',
          at,
          null,
        ),
    ).toThrow();

    const failed = repo.qaExecutions.insertAutomationAction(
      reviewAutomationActionSchema.parse({
        ...action(),
        id: 'failed-action',
        idempotencyKey: 'failed-action-key',
      }),
    );
    expect(
      repo.qaExecutions.completeAutomationAction(failed.id, {
        status: 'failed',
        errorCode: 'launch_failed',
        completedAt: at,
      }),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'launch_failed',
      completedAt: at,
    });
  });

  it('rolls back a report when a later project event insertion fails', () => {
    const repo = setup({ failProjectEventInsert: true });
    repositories.push(repo);
    repo.qaExecutions.createCycle(cycle(1));

    repo.database.exec('BEGIN IMMEDIATE');
    try {
      repo.qaExecutions.insertReport(report());
      const { id, sequence, ...event } = projectChangedEventSchema.parse({
        protocolVersion: 1,
        id: 'event-1',
        projectId: 'project-1',
        sequence: 1,
        occurredAt: at,
        type: 'project.changed',
        payload: { project: repo.projects.get('project-1')! },
      });
      expect(() =>
        repo.projectEvents.appendInTransaction('project-1', event),
      ).toThrow('project event insert failed');
    } finally {
      repo.database.exec('ROLLBACK');
    }

    expect(repo.qaExecutions.getReport('report-cycle-1')).toBeUndefined();
  });
});
