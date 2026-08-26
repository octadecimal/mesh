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

  it('persists immutable terminal reports', () => {
    const repo = setup();
    repositories.push(repo);
    repo.qaExecutions.createCycle(cycle(1));
    const original = repo.qaExecutions.insertReport(report());

    expect(repo.qaExecutions.getReport(original.id)).toEqual(original);
    expect(repo.qaExecutions.listReportsForAttempts(['attempt-1'])).toEqual([
      original,
    ]);
    expect(() => repo.qaExecutions.insertReport(report())).toThrow();
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
