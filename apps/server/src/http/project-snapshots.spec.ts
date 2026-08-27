import { afterEach, describe, expect, it } from 'vitest';
import {
  attemptRepairSchema,
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  developerReviewFeedbackSchema,
  idSchema,
  projectSchema,
  qaExecutionCycleSchema,
  qaReportSchema,
  reviewAutomationActionSchema,
  sessionSchema,
  taskAttemptSchema,
  taskSchema,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { openDatabase } from '../db/database.js';
import { ProjectEventRepository } from '../repositories/project-event-repository.js';
import { createTestRepositories } from '../test/create-test-database.js';
import {
  buildProjectSnapshot,
  readProjectHistory,
} from './project-snapshots.js';

const now = '2026-08-24T00:00:00.000Z';
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const seed = () => {
  const repositories = createTestRepositories();
  cleanups.push(repositories.dispose);
  const project = repositories.projects.create(
    projectSchema.parse({
      id: 'p1',
      displayName: 'Mesh',
      repositoryPath: 'C:/code/mesh',
      discoveredAt: now,
      discoveryMetadata: {},
    }),
  );
  const task = repositories.tasks.create(
    taskSchema.parse({
      id: 't1',
      projectId: project.id,
      title: 'Atomic snapshot',
      description: '',
      acceptanceCriteria: [],
      priority: 'normal',
      rank: 'a',
      lifecycleState: 'backlog',
      labels: [],
      notes: '',
      blocked: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const append = (events: ProjectEventRepository, id: string) =>
    events.append(project.id, {
      protocolVersion: 1,
      id,
      projectId: project.id,
      occurredAt: now,
      type: 'task.changed',
      payload: { task },
    });
  append(repositories.projectEvents, 'event-1');
  const writerDatabase = openDatabase(repositories.path);
  const writerEvents = new ProjectEventRepository(writerDatabase);
  cleanups.push(() => writerDatabase.close());
  return { repositories, project, task, writerEvents, append };
};

const boundProxy = <Target extends object>(
  target: Target,
  interleaveOn: string,
  interleave: () => void,
): Target => {
  let interleaved = false;
  return new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, current, args) as unknown;
        if (property === interleaveOn && !interleaved) {
          interleaved = true;
          interleave();
        }
        return result;
      };
    },
  });
};

describe('project snapshot read consistency', () => {
  it('projects the current developer instructions through the project contract', () => {
    const fixture = seed();
    const updated = fixture.repositories.projects.updateDeveloperInstructions(
      fixture.project.id,
      fixture.project.revision,
      {
        content: 'Run the focused server test before handoff.',
        updatedAt: '2026-08-24T00:01:00.000Z',
        updatedBy: { type: 'human', id: idSchema.parse('operator') },
      },
    );
    if (!updated) throw new Error('Expected developer instructions to update');

    expect(
      buildProjectSnapshot(fixture.repositories, fixture.project.id).project
        .developerInstructions,
    ).toEqual({
      content: 'Run the focused server test before handoff.',
      revision: 2,
      updatedAt: '2026-08-24T00:01:00.000Z',
      updatedBy: { type: 'human', id: 'operator' },
    });
  });

  it('projects manual QA defaults and the current QA configuration', () => {
    const fixture = seed();

    expect(
      buildProjectSnapshot(fixture.repositories, fixture.project.id).project
        .qaConfiguration,
    ).toEqual({
      instructions: {
        content: '',
        revision: 1,
        updatedAt: now,
        updatedBy: null,
      },
      reviewPolicy: 'manual',
      revision: 1,
      updatedAt: now,
      updatedBy: null,
    });

    const updated = fixture.repositories.projects.updateQaConfiguration(
      fixture.project.id,
      1,
      {
        instructions: { content: 'Check every acceptance criterion.' },
        reviewPolicy: 'autonomous_review',
      },
      { type: 'human', id: idSchema.parse('qa-operator') },
    );
    if (!updated) throw new Error('Expected QA configuration to update');

    expect(
      buildProjectSnapshot(fixture.repositories, fixture.project.id).project
        .qaConfiguration,
    ).toMatchObject({
      instructions: {
        content: 'Check every acceptance criterion.',
        revision: 2,
        updatedBy: { type: 'human', id: 'qa-operator' },
      },
      reviewPolicy: 'autonomous_review',
      revision: 2,
      updatedBy: { type: 'human', id: 'qa-operator' },
    });
  });

  it('projects complete ordered project-run history with configured limits and project isolation', () => {
    const fixture = seed();
    const otherProject = fixture.repositories.projects.create(
      projectSchema.parse({
        id: 'p2',
        displayName: 'Other',
        repositoryPath: 'C:/code/other',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    fixture.repositories.projectRuns.create({
      id: 'run-history-b',
      projectId: fixture.project.id,
      state: 'completed',
      concurrency: 1,
      startedAt: '2026-08-24T00:02:00.000Z',
      completedAt: '2026-08-24T00:03:00.000Z',
      completionReason: 'queue_finished',
      items: [],
    });
    fixture.repositories.projectRuns.create({
      id: 'run-history-a',
      projectId: fixture.project.id,
      state: 'completed',
      concurrency: 2,
      startedAt: '2026-08-24T00:01:00.000Z',
      completedAt: '2026-08-24T00:01:30.000Z',
      completionReason: 'stopped',
      items: [],
    });
    fixture.repositories.projectRuns.create({
      id: 'run-active',
      projectId: fixture.project.id,
      concurrency: 3,
      startedAt: '2026-08-24T00:04:00.000Z',
      items: [],
    });
    fixture.repositories.projectRuns.create({
      id: 'run-other',
      projectId: otherProject.id,
      concurrency: 1,
      startedAt: '2026-08-24T00:00:00.000Z',
      items: [],
    });

    const snapshot = buildProjectSnapshot(
      { ...fixture.repositories, projectRunMaxConcurrency: 3 },
      fixture.project.id,
    );

    expect(snapshot.runs.map(({ id }) => id)).toEqual([
      'run-history-a',
      'run-history-b',
      'run-active',
    ]);
    expect(snapshot.projectRunLimits).toEqual({ maxConcurrency: 3 });
    expect(snapshot.runs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'run-other' })]),
    );
  });

  it('returns repair records in snapshots and durable project history', () => {
    const fixture = seed();
    const repair = attemptRepairSchema.parse({
      taskId: fixture.task.id,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      reason: 'task_in_progress_without_live_session',
    });
    fixture.repositories.projectEvents.append(fixture.project.id, {
      protocolVersion: 1,
      id: 'repair-event-1',
      projectId: fixture.project.id,
      occurredAt: now,
      type: 'task.attempt_repair_detected',
      payload: { repair },
    });

    expect(
      buildProjectSnapshot(
        { ...fixture.repositories, repairs: [repair] },
        fixture.project.id,
      ).repairs,
    ).toEqual([repair]);
    expect(
      readProjectHistory(fixture.repositories, fixture.project.id, { after: 1 })
        .events,
    ).toEqual([
      expect.objectContaining({
        type: 'task.attempt_repair_detected',
        payload: { repair },
      }),
    ]);
  });

  it('returns complete ordered Developer history for every project task', () => {
    const fixture = seed();
    fixture.repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-1',
        projectId: fixture.project.id,
        type: 'shared',
        path: 'C:/code/mesh',
      }),
    );
    fixture.repositories.sessions.create(
      sessionSchema.parse({
        id: 'session-1',
        projectId: fixture.project.id,
        workspaceId: 'workspace-1',
        title: 'Developer attempt',
        permissionMode: 'interactive',
        lifecycleState: 'completed',
        createdAt: now,
        updatedAt: now,
      }),
    );
    fixture.repositories.attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-1',
        taskId: fixture.task.id,
        sessionId: 'session-1',
        ordinal: 1,
        source: 'launched',
        actor: { type: 'human', id: 'operator' },
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: 'developer',
      }),
    );
    const cycle = (id: string, ordinal: number) =>
      developerExecutionCycleSchema.parse({
        id,
        attemptId: 'attempt-1',
        ordinal,
        mode: ordinal === 1 ? 'new' : 'resume',
        authorizedBy: { type: 'human', id: 'operator' },
        authorizationCommandId: `authorize-${ordinal}`,
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: 'Keep the history.', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: fixture.task.title,
          description: fixture.task.description,
          acceptanceCriteria: [
            { id: 'criterion-1', text: 'History survives refresh.' },
          ],
        },
        workspaceId: 'workspace-1',
        permissionMode: 'interactive',
        startedAt: `2026-08-24T00:0${ordinal}:00.000Z`,
        endedAt: null,
        terminalDisposition: null,
        completionReportId: null,
        blockerReportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      });
    const firstCycle = fixture.repositories.developerExecutions.createCycle(
      cycle('cycle-1', 1),
    );
    const completion =
      fixture.repositories.developerExecutions.appendCompletionReport(
        developerCompletionReportSchema.parse({
          id: 'completion-1',
          cycleId: firstCycle.id,
          summary: 'First pass is ready.',
          criterionResults: [
            { criterionId: 'criterion-1', status: 'met', evidence: 'Passed.' },
          ],
          verification: [
            { command: 'pnpm test', outcome: 'passed', output: 'ok' },
          ],
          limitations: '',
          workspaceState: {
            summary: 'Clean.',
            hasUncommittedChanges: false,
            commitsCreated: true,
          },
          reviewerNotes: null,
          createdAt: '2026-08-24T00:02:00.000Z',
        }),
      );
    fixture.repositories.developerExecutions.closeCycle(firstCycle.id, {
      endedAt: '2026-08-24T00:02:00.000Z',
      terminalDisposition: 'submitted_for_review',
      completionReportId: completion.id,
      blockerReportId: null,
      terminalCommandId: idSchema.parse('submit-1'),
      terminalEventId: idSchema.parse('developer-event-1'),
    });
    const feedback = fixture.repositories.developerExecutions.appendFeedback(
      developerReviewFeedbackSchema.parse({
        id: 'feedback-1',
        cycleId: firstCycle.id,
        taskId: fixture.task.id,
        kind: 'rejection',
        feedback: 'Show the reconnect path.',
        actor: { type: 'human', id: 'reviewer' },
        commandId: 'reject-1',
        createdAt: '2026-08-24T00:03:00.000Z',
      }),
    );
    const secondCycle = fixture.repositories.developerExecutions.createCycle(
      cycle('cycle-2', 2),
    );
    const blocker =
      fixture.repositories.developerExecutions.appendBlockerReport(
        developerBlockerReportSchema.parse({
          id: 'blocker-1',
          cycleId: secondCycle.id,
          reason: 'Missing fixture.',
          evidence: 'The fixture is absent.',
          attemptedWork: 'Checked the test assets.',
          suggestedHumanAction: 'Provide the fixture.',
          preserveWorkspace: true,
          createdAt: '2026-08-24T00:05:00.000Z',
        }),
      );
    fixture.repositories.developerExecutions.closeCycle(secondCycle.id, {
      endedAt: '2026-08-24T00:05:00.000Z',
      terminalDisposition: 'blocked',
      completionReportId: null,
      blockerReportId: blocker.id,
      terminalCommandId: idSchema.parse('block-1'),
      terminalEventId: idSchema.parse('developer-event-2'),
    });

    const snapshot = buildProjectSnapshot(
      fixture.repositories,
      fixture.project.id,
    );

    expect(snapshot.developerCycles.map(({ id }) => id)).toEqual([
      'cycle-1',
      'cycle-2',
    ]);
    expect(snapshot.developerCompletionReports).toEqual([completion]);
    expect(snapshot.developerBlockerReports).toEqual([blocker]);
    expect(snapshot.developerReviewFeedback).toEqual([feedback]);
    expect(JSON.stringify(snapshot)).not.toContain('capability');
  });

  it('returns complete project-local QA history through batched reads', () => {
    const fixture = seed();
    fixture.repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-1',
        projectId: fixture.project.id,
        type: 'shared',
        path: 'C:/code/mesh',
      }),
    );
    fixture.repositories.sessions.create(
      sessionSchema.parse({
        id: 'session-1',
        projectId: fixture.project.id,
        workspaceId: 'workspace-1',
        title: 'Developer attempt',
        permissionMode: 'interactive',
        lifecycleState: 'completed',
        createdAt: now,
        updatedAt: now,
      }),
    );
    fixture.repositories.attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-1',
        taskId: fixture.task.id,
        sessionId: 'session-1',
        ordinal: 1,
        source: 'launched',
        actor: { type: 'human', id: 'operator' },
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: 'developer',
      }),
    );
    const qaCycle = qaExecutionCycleSchema.parse({
      id: 'qa-cycle-1',
      taskId: fixture.task.id,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      ordinal: 1,
      authorizedBy: { type: 'human', id: 'operator' },
      authorizationCommandId: 'qa-launch-1',
      policyVersion: 'qa-policy-v1',
      qaInstructions: { content: 'Verify reconnect.', revision: 1 },
      taskSnapshot: {
        revision: 1,
        title: fixture.task.title,
        description: fixture.task.description,
        acceptanceCriteria: [
          { id: 'criterion-1', text: 'QA history survives refresh.' },
        ],
      },
      developerCompletionReportId: 'completion-1',
      workspaceId: 'workspace-1',
      reviewPolicy: 'autonomous_review',
      reviewPolicyRevision: 1,
      automationGeneration: 1,
      rejectionOrdinal: 0,
      startedAt: now,
      endedAt: null,
      terminalDisposition: null,
      reportId: null,
      terminalCommandId: null,
      terminalEventId: null,
    });
    fixture.repositories.qaExecutions.createCycle(qaCycle);
    const qaReport = fixture.repositories.qaExecutions.insertReport(
      qaReportSchema.parse({
        id: 'qa-report-1',
        cycleId: qaCycle.id,
        disposition: 'verified',
        criterionResults: [
          {
            criterionId: 'criterion-1',
            status: 'passed',
            evidence: 'Focused test passed.',
          },
        ],
        verificationCommands: [{ command: 'pnpm test', outcome: 'passed' }],
        limitations: [],
        residualRisks: [],
        workspaceBefore: 'clean',
        workspaceAfter: 'clean',
        createdAt: '2026-08-24T00:02:00.000Z',
      }),
    );
    const terminalCycle = fixture.repositories.qaExecutions.completeCycle(
      qaCycle.id,
      {
        endedAt: '2026-08-24T00:02:00.000Z',
        terminalDisposition: 'verified',
        reportId: qaReport.id,
        terminalCommandId: 'qa-verdict-1',
        terminalEventId: 'qa-event-1',
      },
    );
    if (!terminalCycle) throw new Error('Expected QA cycle to complete');
    const pendingAction =
      fixture.repositories.qaExecutions.insertAutomationAction(
        reviewAutomationActionSchema.parse({
          id: 'automation-action-1',
          idempotencyKey: 'task-1:attempt-1:qa-cycle-1:complete:1',
          projectId: fixture.project.id,
          taskId: fixture.task.id,
          attemptId: 'attempt-1',
          sourceCycleId: qaCycle.id,
          actionKind: 'complete_task',
          generation: 1,
          status: 'pending',
          errorCode: null,
          createdAt: '2026-08-24T00:02:00.000Z',
          completedAt: null,
        }),
      );
    const completedAction =
      fixture.repositories.qaExecutions.completeAutomationAction(
        pendingAction.id,
        {
          status: 'completed',
          errorCode: null,
          completedAt: '2026-08-24T00:03:00.000Z',
        },
      );
    if (!completedAction) throw new Error('Expected action to complete');

    const otherProject = fixture.repositories.projects.create(
      projectSchema.parse({
        id: 'p2',
        displayName: 'Other',
        repositoryPath: 'C:/code/other',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const otherTask = fixture.repositories.tasks.create(
      taskSchema.parse({
        id: 't2',
        projectId: otherProject.id,
        title: 'Other task',
        description: '',
        acceptanceCriteria: [],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'backlog',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    fixture.repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-2',
        projectId: otherProject.id,
        type: 'shared',
        path: 'C:/code/other',
      }),
    );
    fixture.repositories.sessions.create(
      sessionSchema.parse({
        id: 'session-2',
        projectId: otherProject.id,
        workspaceId: 'workspace-2',
        title: 'Other attempt',
        permissionMode: 'interactive',
        lifecycleState: 'completed',
        createdAt: now,
        updatedAt: now,
      }),
    );
    fixture.repositories.attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-2',
        taskId: otherTask.id,
        sessionId: 'session-2',
        ordinal: 1,
        source: 'launched',
        actor: { type: 'human', id: 'operator' },
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: 'developer',
      }),
    );
    fixture.repositories.qaExecutions.createCycle(
      qaExecutionCycleSchema.parse({
        ...qaCycle,
        id: 'qa-cycle-2',
        taskId: otherTask.id,
        attemptId: 'attempt-2',
        sessionId: 'session-2',
        workspaceId: 'workspace-2',
      }),
    );
    fixture.repositories.qaExecutions.insertAutomationAction(
      reviewAutomationActionSchema.parse({
        ...pendingAction,
        id: 'automation-action-2',
        idempotencyKey: 'task-2:attempt-2:qa-cycle-2:complete:1',
        projectId: otherProject.id,
        taskId: otherTask.id,
        attemptId: 'attempt-2',
        sourceCycleId: 'qa-cycle-2',
        actionKind: 'complete_task',
      }),
    );

    const cycleReads: string[][] = [];
    const reportReads: string[][] = [];
    const actionReads: string[][] = [];
    const qaExecutions = {
      listCyclesForAttempts: (attemptIds: readonly string[]) => {
        cycleReads.push([...attemptIds]);
        return fixture.repositories.qaExecutions.listCyclesForAttempts(
          attemptIds,
        );
      },
      listReportsForAttempts: (attemptIds: readonly string[]) => {
        reportReads.push([...attemptIds]);
        return fixture.repositories.qaExecutions.listReportsForAttempts(
          attemptIds,
        );
      },
      listAutomationActionsForTasks: (taskIds: readonly string[]) => {
        actionReads.push([...taskIds]);
        return fixture.repositories.qaExecutions.listAutomationActionsForTasks(
          taskIds,
        );
      },
    };

    const snapshot = buildProjectSnapshot(
      { ...fixture.repositories, qaExecutions },
      fixture.project.id,
    );

    expect(snapshot.qaCycles).toEqual([terminalCycle]);
    expect(snapshot.qaReports).toEqual([qaReport]);
    expect(snapshot.reviewAutomationActions).toEqual([completedAction]);
    expect(cycleReads).toEqual([['attempt-1']]);
    expect(reportReads).toEqual([['attempt-1']]);
    expect(actionReads).toEqual([[fixture.task.id]]);
  });

  it('keeps snapshot projections and cursor in one SQLite read view', () => {
    const fixture = seed();
    const tasks = boundProxy(fixture.repositories.tasks, 'listByProject', () =>
      fixture.append(fixture.writerEvents, 'event-2'),
    );

    const snapshot = buildProjectSnapshot(
      {
        ...fixture.repositories,
        tasks,
      },
      fixture.project.id,
    );

    expect(snapshot.cursor).toBe(1);
    expect(fixture.writerEvents.latestSequence(fixture.project.id)).toBe(2);
  });

  it('keeps history events and cursor at one captured high-water mark', () => {
    const fixture = seed();
    const projectEvents = new Proxy(fixture.repositories.projectEvents, {
      get(current, property) {
        const value = Reflect.get(current, property, current) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, current, args) as unknown;
          if (property === 'after' || property === 'retainedAfter') {
            fixture.append(fixture.writerEvents, 'event-2');
          }
          return result;
        };
      },
    });

    const history = readProjectHistory(
      { ...fixture.repositories, projectEvents },
      fixture.project.id,
      { after: 0 },
    );

    expect(history.events.map(({ sequence }) => sequence)).toEqual([1]);
    expect(history.cursor).toBe(1);
    expect(fixture.writerEvents.latestSequence(fixture.project.id)).toBe(2);
  });
});
