import {
  developerExecutionCycleSchema,
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

const action = (
  sourceCycleId = 'cycle-1',
  actionKind: ReviewAutomationAction['actionKind'] = 'resume_developer',
): ReviewAutomationAction =>
  reviewAutomationActionSchema.parse({
    id: 'action-1',
    idempotencyKey: 'action-key-1',
    projectId: 'project-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    sourceCycleId,
    actionKind,
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

  it('terminalizes an interrupted cycle without fabricating a verdict report', () => {
    const repo = setup();
    repositories.push(repo);
    repo.qaExecutions.createCycle(cycle(1));

    expect(
      repo.qaExecutions.interruptCycle('cycle-1', {
        endedAt: at,
        terminalCommandId: 'command-repair-1',
        terminalEventId: 'event-repair-1',
      }),
    ).toMatchObject({
      endedAt: at,
      terminalDisposition: 'interrupted',
      reportId: null,
      terminalCommandId: 'command-repair-1',
      terminalEventId: 'event-repair-1',
    });
    expect(repo.qaExecutions.getCycle('cycle-1')).toMatchObject({
      terminalDisposition: 'interrupted',
      reportId: null,
    });
    expect(
      repo.qaExecutions.interruptCycle('cycle-1', {
        endedAt: at,
        terminalCommandId: 'command-repair-2',
        terminalEventId: 'event-repair-2',
      }),
    ).toBeUndefined();
  });

  it('exposes QA session ownership and prevents session deletion from cascading history', () => {
    const repo = setup();
    repositories.push(repo);
    repo.sessions.create(
      sessionSchema.parse({
        id: 'qa-session-1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        title: 'QA',
        permissionMode: 'safe_auto',
        lifecycleState: 'completed',
        createdAt: at,
        updatedAt: at,
      }),
    );
    repo.qaExecutions.createCycle(
      qaExecutionCycleSchema.parse({ ...cycle(1), sessionId: 'qa-session-1' }),
    );

    expect(
      repo.qaExecutions.getActiveCycleBySession('qa-session-1'),
    ).toMatchObject({
      id: 'cycle-1',
    });
    expect(repo.qaExecutions.hasCycleForSession('qa-session-1')).toBe(true);
    expect(() => repo.sessions.remove('qa-session-1')).toThrow(
      'session has QA execution history',
    );
    expect(repo.qaExecutions.getCycle('cycle-1')).toBeDefined();
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

  it('persists automation actions sourced by Developer and QA cycles', () => {
    const repo = setup();
    repositories.push(repo);
    repo.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'developer-cycle-1',
        attemptId: 'attempt-1',
        ordinal: 1,
        mode: 'new',
        authorizedBy: { type: 'human', id: 'human-1' },
        authorizationCommandId: 'developer-command-1',
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: 'Task',
          description: 'Verify persistence.',
          acceptanceCriteria: [
            { id: 'criterion-1', text: 'Persist QA records' },
          ],
        },
        workspaceId: 'workspace-1',
        permissionMode: 'interactive',
        startedAt: at,
        endedAt: at,
        terminalDisposition: 'submitted_for_review',
        completionReportId: 'developer-report-1',
        blockerReportId: null,
        terminalCommandId: 'developer-terminal-1',
        terminalEventId: 'developer-event-1',
      }),
    );
    repo.qaExecutions.createCycle(cycle(1));

    expect(
      repo.qaExecutions.insertAutomationAction(
        action('developer-cycle-1', 'launch_qa'),
      ),
    ).toMatchObject({ sourceCycleId: 'developer-cycle-1' });
    expect(
      repo.qaExecutions.insertAutomationAction({
        ...action('cycle-1', 'resume_developer'),
        id: 'action-qa',
        idempotencyKey: 'action-qa-key',
      }),
    ).toMatchObject({ sourceCycleId: 'cycle-1' });
  });

  it('rejects missing Developer and QA action source cycles through foreign keys', () => {
    const repo = setup();
    repositories.push(repo);

    expect(() =>
      repo.qaExecutions.insertAutomationAction(
        action('missing-developer-cycle', 'launch_qa'),
      ),
    ).toThrow('FOREIGN KEY constraint failed');
    expect(() =>
      repo.qaExecutions.insertAutomationAction({
        ...action('missing-qa-cycle', 'resume_developer'),
        id: 'missing-qa-action',
        idempotencyKey: 'missing-qa-action-key',
      }),
    ).toThrow('FOREIGN KEY constraint failed');
  });

  it('persists review automation state with the task revision', () => {
    const repo = setup();
    repositories.push(repo);
    const task = repo.tasks.get('task-1');
    if (!task) throw new Error('Expected task');
    const updated = repo.tasks.update(
      {
        ...task,
        reviewAutomation: {
          status: 'enabled',
          generation: 4,
          rejectionCount: 2,
          pauseReason: null,
          updatedAt: at,
        },
      },
      task.revision,
    );

    expect(repo.tasks.get(task.id)?.reviewAutomation).toEqual(
      updated?.reviewAutomation,
    );
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
