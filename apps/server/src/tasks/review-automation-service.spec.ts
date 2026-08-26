import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  projectSchema,
  qaExecutionCycleSchema,
  qaReportSchema,
  reviewAutomationActionSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { EventPublisher } from '../runtime/event-publisher.js';
import { createTestRepositories } from '../test/create-test-database.js';
import {
  planQaVerdict,
  ReviewAutomationService,
} from './review-automation-service.js';

const now = '2026-08-26T16:00:00.000Z';
const human = taskActorSchema.parse({ type: 'human', id: 'operator-1' });

describe('ReviewAutomationService', () => {
  const disposals: Array<() => void> = [];

  afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

  const setup = (options?: {
    policy?: 'manual' | 'autonomous_review';
    automationStatus?: 'disabled' | 'enabled' | 'paused';
    rejectionCount?: number;
    resumeFailure?: Error;
  }) => {
    const repositories = createTestRepositories();
    disposals.push(() => repositories.dispose());
    const project = repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project',
        repositoryPath: 'C:/code/project',
        discoveredAt: now,
        discoveryMetadata: {},
        qaConfiguration: {
          instructions: {
            content: 'Verify the change.',
            revision: 1,
            updatedAt: now,
            updatedBy: human,
          },
          reviewPolicy: options?.policy ?? 'autonomous_review',
          revision: 1,
          updatedAt: now,
          updatedBy: human,
        },
      }),
    );
    const task = repositories.tasks.create(
      taskSchema.parse({
        id: 'task-1',
        projectId: project.id,
        title: 'Automate review',
        description: 'Run bounded QA.',
        acceptanceCriteria: ['Automation remains bounded.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'review',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        reviewAutomation: {
          status: options?.automationStatus ?? 'enabled',
          generation: 2,
          rejectionCount: options?.rejectionCount ?? 0,
          pauseReason: null,
          updatedAt: now,
        },
      }),
    );
    const workspace = repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-1',
        projectId: project.id,
        type: 'shared',
        path: 'C:/code/project',
      }),
    );
    const developerSession = repositories.sessions.create(
      sessionSchema.parse({
        id: 'developer-session',
        projectId: project.id,
        workspaceId: workspace.id,
        title: 'Developer',
        permissionMode: 'safe_auto',
        lifecycleState: 'interrupted',
        claudeResumeId: 'claude-developer-1',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = repositories.attempts.createForTask(
      task.id,
      developerSession.id,
      'launched',
      human,
      'developer',
    );
    const developerCycle = repositories.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'developer-cycle-1',
        attemptId: attempt.id,
        ordinal: 1,
        mode: 'new',
        authorizedBy: human,
        authorizationCommandId: 'developer-launch-1',
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: task.title,
          description: task.description,
          acceptanceCriteria: [
            { id: 'criterion-1', text: task.acceptanceCriteria[0] },
          ],
        },
        workspaceId: workspace.id,
        permissionMode: developerSession.permissionMode,
        startedAt: now,
        endedAt: now,
        terminalDisposition: 'submitted_for_review',
        completionReportId: 'developer-report-1',
        blockerReportId: null,
        terminalCommandId: 'developer-submit-1',
        terminalEventId: 'developer-event-1',
      }),
    );
    repositories.developerExecutions.appendCompletionReport(
      developerCompletionReportSchema.parse({
        id: 'developer-report-1',
        cycleId: developerCycle.id,
        summary: 'Ready for QA.',
        criterionResults: [
          { criterionId: 'criterion-1', status: 'met', evidence: 'Done.' },
        ],
        verification: [],
        limitations: '',
        workspaceState: {
          summary: 'Changes ready.',
          hasUncommittedChanges: false,
          commitsCreated: true,
        },
        reviewerNotes: null,
        createdAt: now,
      }),
    );

    const launch = vi.fn(async () => ({ taskId: task.id }));
    const completedResumeCommands = new Set<string>();
    let resumeStarts = 0;
    const resume = vi.fn(async (input: { commandId: string }) => {
      if (completedResumeCommands.has(input.commandId)) {
        return { taskId: task.id };
      }
      if (options?.resumeFailure) throw options.resumeFailure;
      const current = repositories.tasks.get(task.id);
      if (!current) throw new Error('Expected current task');
      resumeStarts += 1;
      completedResumeCommands.add(input.commandId);
      repositories.tasks.update(
        { ...current, lifecycleState: 'in_progress', updatedAt: now },
        current.revision,
      );
      return { taskId: task.id };
    });
    let nextId = 0;
    const publisher = new EventPublisher();
    const service = new ReviewAutomationService({
      ...repositories,
      qaExecutionService: { launch },
      developerReworkService: { resume },
      publisher,
      now: () => now,
      createId: () => `automation-${++nextId}`,
    });

    const rejectedCycle = (options?: {
      automationGeneration?: number;
      rejectionOrdinal?: number;
    }) => {
      repositories.sessions.create(
        sessionSchema.parse({
          id: 'qa-session-1',
          projectId: project.id,
          workspaceId: workspace.id,
          title: 'QA',
          permissionMode: 'safe_auto',
          lifecycleState: 'interrupted',
          createdAt: now,
          updatedAt: now,
        }),
      );
      const cycle = repositories.qaExecutions.createCycle(
        qaExecutionCycleSchema.parse({
          id: 'qa-cycle-1',
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: 'qa-session-1',
          ordinal: 1,
          authorizedBy: { type: 'system', id: 'review-loop' },
          authorizationCommandId: 'qa-launch-1',
          policyVersion: 'qa-policy-v1',
          qaInstructions: { content: '', revision: 1 },
          taskSnapshot: developerCycle.taskSnapshot,
          developerCompletionReportId: 'developer-report-1',
          workspaceId: workspace.id,
          reviewPolicy: 'autonomous_review',
          reviewPolicyRevision: 1,
          automationGeneration: options?.automationGeneration ?? 2,
          rejectionOrdinal: options?.rejectionOrdinal ?? 0,
          startedAt: now,
          endedAt: null,
          terminalDisposition: null,
          reportId: null,
          terminalCommandId: null,
          terminalEventId: null,
        }),
      );
      const report = repositories.qaExecutions.insertReport(
        qaReportSchema.parse({
          id: 'qa-report-1',
          cycleId: cycle.id,
          disposition: 'rejected',
          criterionResults: [
            {
              criterionId: 'criterion-1',
              status: 'failed',
              evidence: 'Focused test failed.',
            },
          ],
          verificationCommands: [
            { command: 'corepack pnpm test', outcome: 'failed' },
          ],
          limitations: [],
          residualRisks: ['Regression remains.'],
          workspaceBefore: 'state-1',
          workspaceAfter: 'state-1',
          createdAt: now,
        }),
      );
      return repositories.qaExecutions.completeCycle(cycle.id, {
        endedAt: now,
        terminalDisposition: 'rejected',
        reportId: report.id,
        terminalCommandId: 'qa-verdict-1',
        terminalEventId: 'qa-event-1',
      })!;
    };

    const pendingResumeAction = (cycle: ReturnType<typeof rejectedCycle>) => {
      const action = reviewAutomationActionSchema.parse({
        id: 'resume-action-1',
        idempotencyKey: `${task.id}:${attempt.id}:${cycle.id}:resume_developer:2`,
        projectId: project.id,
        taskId: task.id,
        attemptId: attempt.id,
        sourceCycleId: cycle.id,
        actionKind: 'resume_developer',
        generation: 2,
        status: 'pending',
        errorCode: null,
        createdAt: now,
        completedAt: null,
      });
      return repositories.qaExecutions.insertAutomationAction(action);
    };

    const recordCompletedResume = (commandId: string) => {
      completedResumeCommands.add(commandId);
      resumeStarts += 1;
      const current = repositories.tasks.get(task.id);
      if (!current) throw new Error('Expected current task');
      repositories.tasks.update(
        { ...current, lifecycleState: 'in_progress', updatedAt: now },
        current.revision,
      );
    };

    return {
      attempt,
      developerCycle,
      developerSession,
      launch,
      project,
      pendingResumeAction,
      recordCompletedResume,
      rejectedCycle,
      repositories,
      resume,
      resumeStarts: () => resumeStarts,
      service,
      task,
    };
  };

  it('does nothing after Developer submission in manual mode', async () => {
    const context = setup({ policy: 'manual' });

    await expect(
      context.service.afterDeveloperSubmission({
        taskId: context.task.id,
        cycleId: context.developerCycle.id,
      }),
    ).resolves.toBeUndefined();
    expect(context.launch).not.toHaveBeenCalled();
    expect(
      context.repositories.qaExecutions.listPendingAutomationActions(),
    ).toEqual([]);
  });

  it('durably launches autonomous QA once for the current Developer cycle', async () => {
    const context = setup();
    const input = {
      taskId: context.task.id,
      cycleId: context.developerCycle.id,
    };

    const first = await context.service.afterDeveloperSubmission(input);
    const currentTask = context.repositories.tasks.get(context.task.id)!;
    context.repositories.tasks.update(
      {
        ...currentTask,
        reviewAutomation: {
          ...currentTask.reviewAutomation,
          generation: currentTask.reviewAutomation.generation + 1,
        },
      },
      currentTask.revision,
    );
    const duplicate = await context.service.afterDeveloperSubmission(input);

    expect(duplicate).toEqual(first);
    expect(context.launch).toHaveBeenCalledTimes(1);
    expect(context.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: context.task.id,
        expectedRevision: context.task.revision,
        trigger: 'autonomous_policy',
        actor: { type: 'system', id: 'review-loop' },
      }),
    );
    expect(
      context.repositories.qaExecutions.listPendingAutomationActions(),
    ).toEqual([]);
  });

  it.each(['disabled', 'paused'] as const)(
    'does not launch autonomous QA when task automation is %s',
    async (automationStatus) => {
      const context = setup({ automationStatus });
      await expect(
        context.service.afterDeveloperSubmission({
          taskId: context.task.id,
          cycleId: context.developerCycle.id,
        }),
      ).resolves.toBeUndefined();
      expect(context.launch).not.toHaveBeenCalled();
    },
  );

  it('rejects a stale Developer source cycle before creating an action', async () => {
    const context = setup();

    await expect(
      context.service.afterDeveloperSubmission({
        taskId: context.task.id,
        cycleId: 'stale-developer-cycle',
      }),
    ).rejects.toMatchObject({ code: 'review_automation_paused' });
    expect(context.launch).not.toHaveBeenCalled();
  });

  it('continues a rejected verdict through the same-session resume boundary once', async () => {
    const context = setup();
    const cycle = context.rejectedCycle();
    context.pendingResumeAction(cycle);

    const first = await context.service.afterQaVerdict({
      taskId: context.task.id,
      cycleId: cycle.id,
    });
    const duplicate = await context.service.continueRejectedVerdict({
      taskId: context.task.id,
      cycleId: cycle.id,
    });

    expect(duplicate).toEqual(first);
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: context.task.id,
        kind: 'rejection',
        actor: { type: 'system', id: 'review-loop' },
        automation: { sourceCycleId: cycle.id, generation: 2 },
      }),
    );
    expect(
      context.repositories.qaExecutions.listPendingAutomationActions(),
    ).toEqual([]);
  });

  it('does nothing after a QA verdict without a pending Developer resume action', async () => {
    const context = setup();
    const cycle = context.rejectedCycle();

    await expect(
      context.service.afterQaVerdict({
        taskId: context.task.id,
        cycleId: cycle.id,
      }),
    ).resolves.toBeUndefined();
    expect(context.resumeStarts()).toBe(0);
  });

  it('fails the durable action and pauses after resume failure', async () => {
    const context = setup({ resumeFailure: new Error('resume unavailable') });
    const cycle = context.rejectedCycle();
    context.pendingResumeAction(cycle);

    await expect(
      context.service.continueRejectedVerdict({
        taskId: context.task.id,
        cycleId: cycle.id,
      }),
    ).rejects.toThrow('resume unavailable');
    expect(context.repositories.tasks.get(context.task.id)).toMatchObject({
      lifecycleState: 'review',
      reviewAutomation: {
        status: 'paused',
        pauseReason: expect.stringContaining('resume'),
      },
    });
    expect(
      context.repositories.qaExecutions.listPendingAutomationActions(),
    ).toEqual([]);
  });

  it('terminalizes a pending action by replaying a completed downstream resume', async () => {
    const context = setup();
    const cycle = context.rejectedCycle();
    const action = context.pendingResumeAction(cycle);
    context.recordCompletedResume(action.idempotencyKey);

    const recovered = await context.service.continueRejectedVerdict({
      taskId: context.task.id,
      cycleId: cycle.id,
    });

    expect(recovered).toMatchObject({ id: action.id, status: 'completed' });
    expect(context.resumeStarts()).toBe(1);
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(
      context.repositories.qaExecutions.listPendingAutomationActions(),
    ).toEqual([]);
  });

  it.each(['policy', 'state'] as const)(
    'fails and pauses a pending action after a changed %s preflight',
    async (change) => {
      const context = setup({
        resumeFailure: new Error(`changed ${change} preflight`),
      });
      const cycle = context.rejectedCycle();
      const action = context.pendingResumeAction(cycle);
      if (change === 'policy') {
        context.repositories.projects.updateQaConfiguration(
          context.project.id,
          context.project.qaConfiguration.revision,
          {
            instructions: {
              content: context.project.qaConfiguration.instructions.content,
            },
            reviewPolicy: 'manual',
          },
          human,
        );
      } else {
        const current = context.repositories.tasks.get(context.task.id);
        if (!current) throw new Error('Expected current task');
        context.repositories.tasks.update(
          { ...current, lifecycleState: 'in_progress', updatedAt: now },
          current.revision,
        );
      }

      await expect(
        context.service.continueRejectedVerdict({
          taskId: context.task.id,
          cycleId: cycle.id,
        }),
      ).rejects.toThrow(`changed ${change} preflight`);

      expect(context.resumeStarts()).toBe(0);
      expect(
        context.repositories.qaExecutions.getAutomationAction(action.id),
      ).toMatchObject({ status: 'failed' });
      expect(
        context.repositories.qaExecutions.listPendingAutomationActions(),
      ).toEqual([]);
      expect(context.repositories.tasks.get(context.task.id)).toMatchObject({
        reviewAutomation: { status: 'paused' },
      });
    },
  );

  it('enables review automation as an idempotent human command', async () => {
    const context = setup({ automationStatus: 'disabled' });
    const input = {
      commandId: 'enable-automation-1',
      taskId: context.task.id,
      expectedRevision: context.task.revision,
      actor: human,
    };

    const enabled = await context.service.enable(input);
    const duplicate = await context.service.enable(input);

    expect(duplicate).toEqual(enabled);
    expect(enabled).toMatchObject({
      task: {
        id: context.task.id,
        reviewAutomation: {
          status: 'enabled',
          generation: 3,
          rejectionCount: 0,
          pauseReason: null,
        },
      },
      event: {
        type: 'task.review_automation_changed',
        payload: { action: null },
      },
    });
    expect(
      context.repositories.projectEvents.after(context.project.id, 0),
    ).toContainEqual(enabled.event);
  });

  it('preserves the rejection ceiling across a human pause and re-enable', () => {
    const context = setup({ rejectionCount: 2 });
    const paused = context.service.pause({
      commandId: 'pause-at-ceiling',
      taskId: context.task.id,
      expectedRevision: context.task.revision,
      actor: human,
    });
    const enabled = context.service.enable({
      commandId: 'enable-at-ceiling',
      taskId: context.task.id,
      expectedRevision: paused.task.revision,
      actor: human,
    });

    expect(enabled.task.reviewAutomation.rejectionCount).toBe(2);

    const cycle = context.rejectedCycle({
      automationGeneration: enabled.task.reviewAutomation.generation,
      rejectionOrdinal: 2,
    });
    const report = context.repositories.qaExecutions.getReport(
      cycle.reportId ?? '',
    );
    if (!report) throw new Error('Expected rejected QA report');
    const ids = ['ceiling-action', 'ceiling-event'];
    context.repositories.database.exec('BEGIN IMMEDIATE');
    let plan: ReturnType<typeof planQaVerdict>;
    try {
      plan = planQaVerdict(
        {
          task: enabled.task,
          attempt: context.attempt,
          cycle,
          report,
          commandId: 'third-rejection',
          occurredAt: now,
        },
        {
          projects: context.repositories.projects,
          tasks: context.repositories.tasks,
          qaExecutions: context.repositories.qaExecutions,
          transitions: context.repositories.transitions,
          projectEvents: context.repositories.projectEvents,
          createId: () => ids.shift() ?? 'unexpected-id',
        },
      );
      context.repositories.database.exec('COMMIT');
    } catch (error) {
      context.repositories.database.exec('ROLLBACK');
      throw error;
    }

    expect(plan.task.reviewAutomation).toMatchObject({
      status: 'paused',
      rejectionCount: 3,
      pauseReason: 'Three autonomous QA rejections require a human decision.',
    });
    expect(plan.action).toMatchObject({
      actionKind: 'pause_automation',
      status: 'completed',
    });
    expect(context.resumeStarts()).toBe(0);
  });

  it('pauses future automation without interrupting the active session', async () => {
    const context = setup();
    const before = context.repositories.sessions.get(
      context.developerSession.id,
    );

    const paused = await context.service.pause({
      commandId: 'pause-automation-1',
      taskId: context.task.id,
      expectedRevision: context.task.revision,
      actor: human,
    });

    expect(paused.task.reviewAutomation).toMatchObject({
      status: 'paused',
      generation: 3,
      rejectionCount: 0,
      pauseReason: 'Paused by operator-1.',
    });
    expect(
      context.repositories.sessions.get(context.developerSession.id),
    ).toEqual(before);
  });

  it('does not resume Developer work after a human pauses a pending rejection action', async () => {
    const context = setup();
    const cycle = context.rejectedCycle();
    context.pendingResumeAction(cycle);
    const current = context.repositories.tasks.get(context.task.id);
    if (!current) throw new Error('Expected current task');
    context.service.pause({
      commandId: 'pause-before-resume',
      taskId: current.id,
      expectedRevision: current.revision,
      actor: human,
    });

    await expect(
      context.service.continueRejectedVerdict({
        taskId: context.task.id,
        cycleId: cycle.id,
      }),
    ).rejects.toMatchObject({ code: 'review_automation_paused' });
    expect(context.resumeStarts()).toBe(0);
    expect(context.repositories.tasks.get(context.task.id)).toMatchObject({
      reviewAutomation: { status: 'paused' },
    });
  });

  it('rejects non-human automation controls and stale revisions with current task truth', async () => {
    const context = setup({ automationStatus: 'disabled' });

    expect(() =>
      context.service.enable({
        commandId: 'enable-system',
        taskId: context.task.id,
        expectedRevision: context.task.revision,
        actor: taskActorSchema.parse({ type: 'system', id: 'review-loop' }),
      }),
    ).toThrow(
      expect.objectContaining({ code: 'task_transition_unauthorized' }),
    );

    const current = context.repositories.tasks.get(context.task.id);
    if (!current) throw new Error('Expected current task');
    context.repositories.tasks.update(
      { ...current, notes: 'Concurrent update.' },
      current.revision,
    );
    expect(() =>
      context.service.pause({
        commandId: 'pause-stale',
        taskId: context.task.id,
        expectedRevision: current.revision,
        actor: human,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'task_revision_conflict',
        task: expect.objectContaining({
          id: context.task.id,
          revision: current.revision + 1,
        }),
      }),
    );
  });
});
