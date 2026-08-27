import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  developerReviewFeedbackSchema,
  projectSchema,
  qaExecutionCycleSchema,
  qaReportSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  type DeveloperBlockerReport,
  type DeveloperCompletionReport,
  type DeveloperExecutionCycle,
  type DeveloperReviewFeedback,
  type MutatingCommand,
  type QaExecutionCycle,
  type QaReport,
  type Task,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { DeveloperExecutionPanel } from './DeveloperExecutionPanel';

describe('DeveloperExecutionPanel', () => {
  it('launches only an eligible ready task and reuses fresh-work workspace controls', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const readyTask = taskFor({ lifecycleState: 'ready' });
    const rendered = renderPanel({ task: readyTask, onCommand });

    const start = screen.getByRole('button', { name: 'Start Developer' });
    expect(start).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText('Workspace type'),
      'worktree',
    );
    await user.type(screen.getByLabelText('Branch'), 'task/developer-ui');
    await user.type(
      screen.getByLabelText('Worktree path'),
      'C:\\mesh-worktrees\\developer-ui',
    );
    await user.selectOptions(
      screen.getByLabelText('Developer permission mode'),
      'safe_auto',
    );
    await user.click(start);

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.developer.launch',
      payload: {
        taskId: task.id,
        expectedRevision: 1,
        title: task.title,
        permissionMode: 'safe_auto',
        workspace: {
          type: 'worktree',
          repositoryPath: project.repositoryPath,
          path: 'C:\\mesh-worktrees\\developer-ui',
          branch: 'task/developer-ui',
          startPoint: 'HEAD',
        },
        actor,
      },
    });

    rendered.rerender(
      panelElement({
        task: taskFor({ lifecycleState: 'review', revision: 2 }),
        attempts: [developerAttempt],
        cycles: [completionCycle],
        completionReports: [completionReport],
        onCommand,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    await user.type(
      screen.getByLabelText('Rejection feedback'),
      'Cover the disconnected path.',
    );
    await user.click(screen.getByLabelText('Start a new Developer attempt'));

    expect(screen.getByLabelText('Repository')).toHaveValue(
      project.repositoryPath,
    );
    expect(screen.getByLabelText('Branch')).toHaveValue('task/developer-ui');
    expect(screen.getByLabelText('Worktree path')).toHaveValue(
      'C:\\mesh-worktrees\\developer-ui',
    );
    expect(screen.getByLabelText('Developer permission mode')).toHaveValue(
      'safe_auto',
    );
    await user.click(screen.getByRole('button', { name: 'Reject submission' }));

    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'task.developer.reject_new',
      payload: {
        taskId: task.id,
        expectedRevision: 2,
        feedback: 'Cover the disconnected path.',
        title: task.title,
        permissionMode: 'safe_auto',
        workspace: {
          type: 'worktree',
          repositoryPath: project.repositoryPath,
          path: 'C:\\mesh-worktrees\\developer-ui',
          branch: 'task/developer-ui',
          startPoint: 'HEAD',
        },
        actor,
      },
    });
  });

  it('renders every cycle chronologically with complete report, blocker, and feedback evidence', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    renderPanel({
      task: taskFor({
        lifecycleState: 'in_progress',
        blocked: {
          reason: 'Needs operator input',
          actor: developerActor,
          blockedAt: later,
        },
      }),
      attempts: [secondAttempt, developerAttempt],
      cycles: [blockedCycle, completionCycle],
      completionReports: [completionReport],
      blockerReports: [blockerReport],
      feedback: [reviewFeedback],
      onOpenSession,
    });

    const history = screen.getByRole('region', {
      name: 'Developer execution history',
    });
    const cycleCards = within(history).getAllByRole('article');
    expect(cycleCards.map((card) => card.getAttribute('aria-label'))).toEqual([
      'Developer attempt 1 cycle 1',
      'Developer attempt 2 cycle 1',
    ]);

    expect(cycleCards[0]).toHaveTextContent('Implemented the workflow.');
    expect(cycleCards[0]).toHaveTextContent('Keyboard controls');
    expect(cycleCards[0]).toHaveTextContent('Not met');
    expect(cycleCards[0]).toHaveTextContent('corepack pnpm nx test web');
    expect(cycleCards[0]).toHaveTextContent('Passed');
    expect(cycleCards[0]).toHaveTextContent('One visual pass remains.');
    expect(cycleCards[0]).toHaveTextContent('Workspace has one local commit.');
    expect(cycleCards[0]).toHaveTextContent(/Uncommitted changes\s*No/);
    expect(cycleCards[0]).toHaveTextContent(/Commits created\s*Yes/);
    expect(cycleCards[0]).toHaveTextContent('Use semantic headings.');
    expect(cycleCards[0]).toHaveTextContent('Cover the disconnected path.');

    expect(cycleCards[1]).toHaveTextContent('Needs a product decision.');
    expect(cycleCards[1]).toHaveTextContent('The API has two valid shapes.');
    expect(cycleCards[1]).toHaveTextContent('Compared both call sites.');
    expect(cycleCards[1]).toHaveTextContent('Choose the stable payload.');
    expect(cycleCards[1]).toHaveTextContent(/Preserve workspace\s*Yes/);
    expect(cycleCards[1]).toHaveTextContent('Workspace workspace-2');
    expect(cycleCards[1]).toHaveTextContent(/Session\s*Blocked Developer/);

    await user.click(
      within(cycleCards[1]).getByRole('button', {
        name: 'Open Blocked Developer',
      }),
    );
    expect(onOpenSession).toHaveBeenCalledWith(blockedSession.id);
  });

  it('accepts review with the current task revision and human actor', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderPanel({
      task: taskFor({ lifecycleState: 'review', revision: 4 }),
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      onCommand,
    });

    await user.click(screen.getByRole('button', { name: 'Accept as done' }));

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.developer.accept',
      payload: {
        taskId: task.id,
        expectedRevision: 4,
        actor,
      },
    });
  });

  it('shows only the human decision authorized by the latest matching QA state', () => {
    const verifiedCycle = qaExecutionCycleSchema.parse({
      ...qaCycle,
      id: 'qa-cycle-verified',
      terminalDisposition: 'verified',
      reportId: 'qa-report-verified',
    });
    const activeCycle = qaExecutionCycleSchema.parse({
      ...qaCycle,
      id: 'qa-cycle-active',
      endedAt: null,
      terminalDisposition: null,
      reportId: null,
      terminalCommandId: null,
      terminalEventId: null,
    });
    const rendered = renderPanel({
      task: taskFor({ lifecycleState: 'review' }),
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      qaCycles: [qaCycle],
      qaReports: [qaReport],
    });

    expect(screen.queryByRole('button', { name: 'Accept as done' })).toBeNull();
    expect(screen.getByLabelText('Rejection feedback')).toBeDefined();

    rendered.rerender(
      panelElement({
        task: taskFor({ lifecycleState: 'review' }),
        attempts: [developerAttempt],
        cycles: [completionCycle],
        completionReports: [completionReport],
        qaCycles: [verifiedCycle],
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Accept as done' }),
    ).toBeDefined();
    expect(screen.queryByLabelText('Rejection feedback')).toBeNull();

    rendered.rerender(
      panelElement({
        task: taskFor({ lifecycleState: 'review' }),
        attempts: [developerAttempt],
        cycles: [completionCycle],
        completionReports: [completionReport],
        qaCycles: [activeCycle],
      }),
    );
    expect(screen.queryByRole('button', { name: 'Accept as done' })).toBeNull();
    expect(screen.queryByLabelText('Rejection feedback')).toBeNull();
  });

  it('does not expose Developer review or recovery commands without matching durable reports', () => {
    const rendered = renderPanel({
      task: taskFor({ lifecycleState: 'review' }),
    });

    expect(screen.queryByRole('button', { name: 'Accept as done' })).toBeNull();
    expect(screen.queryByLabelText('Rejection feedback')).toBeNull();

    rendered.rerender(
      panelElement({
        task: taskFor({
          lifecycleState: 'in_progress',
          blocked: {
            reason: 'Ordinary task blocker',
            actor,
            blockedAt: later,
          },
        }),
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Unblock Developer' }),
    ).toBeNull();
  });

  it.each([
    [
      'description is missing',
      taskFor({ lifecycleState: 'ready', description: '' }),
    ],
    [
      'acceptance criteria are missing',
      taskFor({ lifecycleState: 'ready', acceptanceCriteria: [] }),
    ],
    [
      'the task is blocked',
      taskFor({
        lifecycleState: 'ready',
        blocked: {
          reason: 'Waiting for input',
          actor,
          blockedAt: later,
        },
      }),
    ],
  ])(
    'keeps Start Developer disabled when %s',
    async (_label, ineligibleTask) => {
      const user = userEvent.setup();
      renderPanel({ task: ineligibleTask });

      await user.selectOptions(
        screen.getByLabelText('Developer permission mode'),
        'interactive',
      );

      expect(
        screen.getByRole('button', { name: 'Start Developer' }),
      ).toBeDisabled();
    },
  );

  it('requires explicit rejection feedback and resume/new path choice', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderPanel({
      task: taskFor({ lifecycleState: 'review', revision: 3 }),
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      onCommand,
    });

    const reject = screen.getByRole('button', { name: 'Reject submission' });
    expect(reject).toBeDisabled();
    await user.type(
      screen.getByLabelText('Rejection feedback'),
      'Add the missing keyboard test.',
    );
    expect(reject).toBeDisabled();
    await user.click(
      screen.getByLabelText('Resume the same Developer attempt'),
    );
    await user.click(reject);

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.developer.reject_resume',
      payload: {
        taskId: task.id,
        expectedRevision: 3,
        feedback: 'Add the missing keyboard test.',
        actor,
      },
    });
  });

  it('requires an unblock reason and explicit recovery path', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderPanel({
      task: taskFor({
        lifecycleState: 'in_progress',
        revision: 5,
        blocked: {
          reason: blockerReport.reason,
          actor: developerActor,
          blockedAt: later,
        },
      }),
      attempts: [secondAttempt],
      cycles: [blockedCycle],
      blockerReports: [blockerReport],
      onCommand,
    });

    const unblock = screen.getByRole('button', { name: 'Unblock Developer' });
    expect(unblock).toBeDisabled();
    await user.type(
      screen.getByLabelText('Unblock reason'),
      'Use the stable payload.',
    );
    await user.click(screen.getByLabelText('Resume the blocked attempt'));
    await user.click(unblock);

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.developer.unblock_resume',
      payload: {
        taskId: task.id,
        expectedRevision: 5,
        feedback: 'Use the stable payload.',
        actor,
      },
    });
  });

  it.each([
    ['archived', { readOnly: true, connected: true }],
    ['disconnected', { readOnly: false, connected: false }],
  ])('keeps Developer actions disabled while %s', (_label, state) => {
    renderPanel({
      task: taskFor({ lifecycleState: 'review' }),
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      ...state,
    });

    expect(
      screen.getByRole('button', { name: 'Accept as done' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Rejection feedback')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      state.readOnly ? 'read-only' : 'disconnected',
    );
  });

  it('retires a pending request when its durable outcome arrives before a transport rejection', async () => {
    const user = userEvent.setup();
    const accepted = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(accepted.promise);
    const rendered = renderPanel({
      task: taskFor({ lifecycleState: 'review', revision: 3 }),
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      onCommand,
    });

    await user.click(screen.getByRole('button', { name: 'Accept as done' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'waiting for project update',
    );

    rendered.rerender(
      panelElement({
        task: taskFor({ lifecycleState: 'done', revision: 4 }),
        attempts: [developerAttempt],
        cycles: [completionCycle],
        completionReports: [completionReport],
        onCommand,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

    await act(async () =>
      accepted.reject({
        code: 'command_failed',
        message: 'The transport closed after the event was delivered.',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('Implemented the workflow.')).toBeDefined();
  });

  it('reconciles a durable outcome that projects after the transport rejection renders', async () => {
    const user = userEvent.setup();
    const accepted = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(accepted.promise);
    const rendered = renderPanel({
      task: taskFor({ lifecycleState: 'review', revision: 3 }),
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      onCommand,
    });

    await user.click(screen.getByRole('button', { name: 'Accept as done' }));
    await act(async () =>
      accepted.reject({
        code: 'command_failed',
        message: 'The transport closed before React projected the event.',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The transport closed before React projected the event.',
    );

    rendered.rerender(
      panelElement({
        task: taskFor({ lifecycleState: 'done', revision: 4 }),
        attempts: [developerAttempt],
        cycles: [completionCycle],
        completionReports: [completionReport],
        onCommand,
      }),
    );

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Implemented the workflow.')).toBeDefined();
  });

  it('keeps an action pending until durable projection and retains canonical state on typed failure', async () => {
    const user = userEvent.setup();
    const accepted = deferred<unknown>();
    const onCommand = vi
      .fn()
      .mockReturnValueOnce(accepted.promise)
      .mockRejectedValueOnce({
        code: 'developer_recovery_invalid',
        message: 'The Developer attempt can no longer be resumed.',
      });
    const reviewTask = taskFor({ lifecycleState: 'review', revision: 3 });
    const rendered = renderPanel({
      task: reviewTask,
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      onCommand,
    });

    await user.click(screen.getByRole('button', { name: 'Accept as done' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'waiting for project update',
    );
    await act(async () => accepted.resolve(undefined));
    expect(screen.getByRole('status')).toHaveTextContent(
      'waiting for project update',
    );

    rendered.rerender(
      panelElement({
        task: taskFor({ lifecycleState: 'done', revision: 4 }),
        attempts: [developerAttempt],
        cycles: [completionCycle],
        completionReports: [completionReport],
        onCommand,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

    rendered.rerender(
      panelElement({
        task: reviewTask,
        attempts: [developerAttempt],
        cycles: [completionCycle],
        completionReports: [completionReport],
        onCommand,
      }),
    );
    await user.type(screen.getByLabelText('Rejection feedback'), 'Try again.');
    await user.click(
      screen.getByLabelText('Resume the same Developer attempt'),
    );
    await user.click(screen.getByRole('button', { name: 'Reject submission' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Developer attempt can no longer be resumed.',
    );
    expect(screen.getByLabelText('Rejection feedback')).toHaveValue(
      'Try again.',
    );
    expect(
      screen.getByLabelText('Resume the same Developer attempt'),
    ).toBeChecked();
    expect(screen.getByText('Implemented the workflow.')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Accept as done' }),
    ).toBeEnabled();
  });

  it('clears successful rejection feedback and path before the same task next review cycle', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const nextReviewCycle = cycle({
      id: 'cycle-3',
      ordinal: 2,
      mode: 'resume',
      startedAt: third,
      endedAt: third,
      completionReportId: 'completion-2',
      terminalCommandId: 'command-submit-2',
      terminalEventId: 'event-submit-2',
    });
    const nextCompletionReport = developerCompletionReportSchema.parse({
      ...completionReport,
      id: 'completion-2',
      cycleId: nextReviewCycle.id,
      createdAt: third,
    });
    const projectedFeedback = developerReviewFeedbackSchema.parse({
      ...reviewFeedback,
      id: 'feedback-2',
      feedback: 'Add the missing keyboard test.',
      commandId: 'command-reject-2',
      createdAt: third,
    });
    const rendered = renderPanel({
      task: taskFor({ lifecycleState: 'review', revision: 3 }),
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      onCommand,
    });

    await user.type(
      screen.getByLabelText('Rejection feedback'),
      'Add the missing keyboard test.',
    );
    await user.click(
      screen.getByLabelText('Resume the same Developer attempt'),
    );
    await user.click(screen.getByRole('button', { name: 'Reject submission' }));

    rendered.rerender(
      panelElement({
        task: taskFor({ lifecycleState: 'review', revision: 4 }),
        attempts: [developerAttempt],
        cycles: [completionCycle, nextReviewCycle],
        completionReports: [completionReport, nextCompletionReport],
        feedback: [projectedFeedback],
        onCommand,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

    expect(screen.getByLabelText('Rejection feedback')).toHaveValue('');
    expect(
      screen.getByLabelText('Resume the same Developer attempt'),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText('Start a new Developer attempt'),
    ).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Reject submission' }),
    ).toBeDisabled();
  });

  it('clears successful unblock feedback and path before the same task is blocked again', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const resumedCycle = cycle({
      id: 'cycle-3',
      attemptId: secondAttempt.attempt.id,
      ordinal: 2,
      mode: 'resume',
      startedAt: third,
      endedAt: null,
      terminalDisposition: null,
      completionReportId: null,
      blockerReportId: null,
      terminalCommandId: null,
      terminalEventId: null,
    });
    const reblockedCycle = cycle({
      id: 'cycle-4',
      attemptId: secondAttempt.attempt.id,
      ordinal: 3,
      mode: 'resume',
      workspaceId: 'workspace-2',
      startedAt: fourth,
      endedAt: fourth,
      terminalDisposition: 'blocked',
      completionReportId: null,
      blockerReportId: 'blocker-2',
      terminalCommandId: 'command-block-2',
      terminalEventId: 'event-block-2',
    });
    const projectedFeedback = developerReviewFeedbackSchema.parse({
      ...reviewFeedback,
      id: 'feedback-unblock',
      cycleId: blockedCycle.id,
      kind: 'unblock',
      feedback: 'Use the stable payload.',
      commandId: 'command-unblock',
      createdAt: third,
    });
    const nextBlockerReport = developerBlockerReportSchema.parse({
      ...blockerReport,
      id: 'blocker-2',
      cycleId: reblockedCycle.id,
      createdAt: fourth,
    });
    const rendered = renderPanel({
      task: taskFor({
        lifecycleState: 'in_progress',
        revision: 5,
        blocked: {
          reason: blockerReport.reason,
          actor: developerActor,
          blockedAt: later,
        },
      }),
      attempts: [secondAttempt],
      cycles: [blockedCycle],
      blockerReports: [blockerReport],
      onCommand,
    });

    await user.type(
      screen.getByLabelText('Unblock reason'),
      'Use the stable payload.',
    );
    await user.click(screen.getByLabelText('Resume the blocked attempt'));
    await user.click(screen.getByRole('button', { name: 'Unblock Developer' }));

    rendered.rerender(
      panelElement({
        task: taskFor({ lifecycleState: 'in_progress', revision: 6 }),
        attempts: [secondAttempt],
        cycles: [blockedCycle, resumedCycle],
        blockerReports: [blockerReport],
        feedback: [projectedFeedback],
        onCommand,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

    rendered.rerender(
      panelElement({
        task: taskFor({
          lifecycleState: 'in_progress',
          revision: 7,
          blocked: {
            reason: nextBlockerReport.reason,
            actor: developerActor,
            blockedAt: fourth,
          },
        }),
        attempts: [secondAttempt],
        cycles: [blockedCycle, resumedCycle, reblockedCycle],
        blockerReports: [blockerReport, nextBlockerReport],
        feedback: [projectedFeedback],
        onCommand,
      }),
    );

    expect(screen.getByLabelText('Unblock reason')).toHaveValue('');
    expect(
      screen.getByLabelText('Resume the blocked attempt'),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText('Start a new attempt after unblock'),
    ).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Unblock Developer' }),
    ).toBeDisabled();
  });

  it('surfaces Developer repair warnings without hiding execution history', () => {
    renderPanel({
      attempts: [developerAttempt],
      cycles: [completionCycle],
      completionReports: [completionReport],
      repairs: [
        {
          taskId: task.id,
          attemptId: developerAttempt.attempt.id,
          sessionId: developerSession.id,
          reason: 'developer_cycle_without_live_session',
        },
      ],
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'cycle is in progress without a live session',
    );
    expect(screen.getByText('Implemented the workflow.')).toBeDefined();
  });
});

const timestamp = '2026-08-25T00:00:00.000Z';
const later = '2026-08-25T01:00:00.000Z';
const third = '2026-08-25T02:00:00.000Z';
const fourth = '2026-08-25T03:00:00.000Z';
const actor = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
});
const developerActor = taskActorSchema.parse({
  type: 'agent',
  id: 'developer-1',
  displayName: 'Developer',
});
const project = projectSchema.parse({
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:\\mesh',
  repositoryIdentity: 'mesh',
  discoveredAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const task = taskSchema.parse({
  id: 'task-1',
  projectId: project.id,
  title: 'Developer workflow',
  description: 'Build the Developer workflow UI.',
  acceptanceCriteria: ['Reports stay visible', 'Keyboard controls'],
  priority: 'high',
  rank: 'a',
  lifecycleState: 'ready',
  labels: ['web'],
  notes: '',
  blocked: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const taskFor = (overrides: Partial<Task> = {}) =>
  taskSchema.parse({ ...task, ...overrides });
const developerSession = sessionSchema.parse({
  id: 'session-1',
  projectId: project.id,
  workspaceId: 'workspace-1',
  title: 'Developer run',
  permissionMode: 'interactive',
  lifecycleState: 'completed',
  createdAt: timestamp,
  updatedAt: timestamp,
});
const blockedSession = sessionSchema.parse({
  ...developerSession,
  id: 'session-2',
  workspaceId: 'workspace-2',
  title: 'Blocked Developer',
  lifecycleState: 'interrupted',
  updatedAt: later,
});
const developerAttempt = {
  attempt: taskAttemptSchema.parse({
    id: 'attempt-1',
    taskId: task.id,
    sessionId: developerSession.id,
    ordinal: 1,
    source: 'launched',
    actor,
    createdAt: timestamp,
    unlinkedAt: null,
    unlinkedBy: null,
    unlinkReason: null,
    role: 'developer',
  }),
  session: developerSession,
};
const secondAttempt = {
  attempt: taskAttemptSchema.parse({
    ...developerAttempt.attempt,
    id: 'attempt-2',
    sessionId: blockedSession.id,
    ordinal: 2,
    createdAt: later,
  }),
  session: blockedSession,
};
const cycle = (
  overrides: Partial<DeveloperExecutionCycle> = {},
): DeveloperExecutionCycle =>
  developerExecutionCycleSchema.parse({
    id: 'cycle-1',
    attemptId: developerAttempt.attempt.id,
    ordinal: 1,
    mode: 'new',
    authorizedBy: actor,
    authorizationCommandId: 'command-launch',
    policyVersion: 'developer-policy-v1',
    projectInstructions: { content: 'Keep UI focused.', revision: 2 },
    taskSnapshot: {
      revision: 1,
      title: task.title,
      description: task.description,
      acceptanceCriteria: [
        { id: 'criterion-1', text: 'Reports stay visible' },
        { id: 'criterion-2', text: 'Keyboard controls' },
      ],
    },
    workspaceId: 'workspace-1',
    permissionMode: 'interactive',
    startedAt: timestamp,
    endedAt: later,
    terminalDisposition: 'submitted_for_review',
    completionReportId: 'completion-1',
    blockerReportId: null,
    terminalCommandId: 'command-submit',
    terminalEventId: 'event-submit',
    ...overrides,
  });
const completionCycle = cycle();
const blockedCycle = cycle({
  id: 'cycle-2',
  attemptId: secondAttempt.attempt.id,
  workspaceId: 'workspace-2',
  startedAt: later,
  terminalDisposition: 'blocked',
  completionReportId: null,
  blockerReportId: 'blocker-1',
  terminalCommandId: 'command-block',
  terminalEventId: 'event-block',
});
const completionReport: DeveloperCompletionReport =
  developerCompletionReportSchema.parse({
    id: 'completion-1',
    cycleId: completionCycle.id,
    summary: 'Implemented the workflow.',
    criterionResults: [
      {
        criterionId: 'criterion-1',
        status: 'met',
        evidence: 'History renders.',
      },
      {
        criterionId: 'criterion-2',
        status: 'not_met',
        evidence: 'One control remains.',
      },
    ],
    verification: [
      {
        command: 'corepack pnpm nx test web',
        outcome: 'passed',
        output: '12 tests passed',
      },
    ],
    limitations: 'One visual pass remains.',
    workspaceState: {
      summary: 'Workspace has one local commit.',
      hasUncommittedChanges: false,
      commitsCreated: true,
    },
    reviewerNotes: 'Use semantic headings.',
    createdAt: later,
  });
const qaCycle: QaExecutionCycle = qaExecutionCycleSchema.parse({
  id: 'qa-cycle-1',
  taskId: task.id,
  attemptId: developerAttempt.attempt.id,
  sessionId: 'qa-session-1',
  ordinal: 1,
  authorizedBy: actor,
  authorizationCommandId: 'qa-launch-command',
  policyVersion: 'qa-policy-v1',
  qaInstructions: { content: 'Verify every criterion.', revision: 1 },
  taskSnapshot: completionCycle.taskSnapshot,
  developerCompletionReportId: completionReport.id,
  workspaceId: 'workspace-1',
  reviewPolicy: 'manual',
  reviewPolicyRevision: 1,
  automationGeneration: 0,
  rejectionOrdinal: 1,
  startedAt: '2026-08-25T00:02:00.000Z',
  endedAt: '2026-08-25T00:03:00.000Z',
  terminalDisposition: 'rejected',
  reportId: 'qa-report-1',
  terminalCommandId: 'qa-verdict-command',
  terminalEventId: 'qa-verdict-event',
});
const qaReport: QaReport = qaReportSchema.parse({
  id: 'qa-report-1',
  cycleId: qaCycle.id,
  disposition: 'rejected',
  criterionResults: completionCycle.taskSnapshot.acceptanceCriteria.map(
    (criterion, index) => ({
      criterionId: criterion.id,
      status: index === 0 ? 'failed' : 'passed',
      evidence: index === 0 ? 'History order is wrong.' : 'Controls are safe.',
    }),
  ),
  verificationCommands: [],
  limitations: [],
  residualRisks: [],
  workspaceBefore: 'clean:abc',
  workspaceAfter: 'clean:abc',
  createdAt: '2026-08-25T00:03:00.000Z',
});
const blockerReport: DeveloperBlockerReport =
  developerBlockerReportSchema.parse({
    id: 'blocker-1',
    cycleId: blockedCycle.id,
    reason: 'Needs a product decision.',
    evidence: 'The API has two valid shapes.',
    attemptedWork: 'Compared both call sites.',
    suggestedHumanAction: 'Choose the stable payload.',
    preserveWorkspace: true,
    createdAt: later,
  });
const reviewFeedback: DeveloperReviewFeedback =
  developerReviewFeedbackSchema.parse({
    id: 'feedback-1',
    cycleId: completionCycle.id,
    taskId: task.id,
    kind: 'rejection',
    feedback: 'Cover the disconnected path.',
    actor,
    commandId: 'command-reject',
    createdAt: later,
  });

type PanelOptions = {
  task?: Task;
  attempts?: (typeof developerAttempt)[];
  cycles?: DeveloperExecutionCycle[];
  completionReports?: DeveloperCompletionReport[];
  qaCycles?: QaExecutionCycle[];
  qaReports?: QaReport[];
  blockerReports?: DeveloperBlockerReport[];
  feedback?: DeveloperReviewFeedback[];
  repairs?: Array<{
    taskId: string;
    attemptId: string;
    sessionId: string;
    reason: 'developer_cycle_without_live_session';
  }>;
  connected?: boolean;
  readOnly?: boolean;
  onCommand?: (command: MutatingCommand) => Promise<unknown> | void;
  onOpenSession?: (sessionId: string) => void;
};

const panelElement = (options: PanelOptions = {}) => (
  <DeveloperExecutionPanel
    project={project}
    task={options.task ?? task}
    attempts={options.attempts ?? []}
    cycles={options.cycles ?? []}
    completionReports={options.completionReports ?? []}
    qaCycles={options.qaCycles ?? []}
    qaReports={options.qaReports ?? []}
    blockerReports={options.blockerReports ?? []}
    feedback={options.feedback ?? []}
    repairs={options.repairs ?? []}
    connected={options.connected ?? true}
    readOnly={options.readOnly ?? false}
    onCommand={options.onCommand ?? vi.fn().mockResolvedValue(undefined)}
    onOpenSession={options.onOpenSession}
  />
);

const renderPanel = (options: PanelOptions = {}) =>
  render(panelElement(options));

const deferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
it('places QA cycles into the immutable Developer and QA chronology', () => {
  renderPanel({
    attempts: [developerAttempt],
    cycles: [completionCycle],
    completionReports: [completionReport],
    qaCycles: [qaCycle],
    qaReports: [qaReport],
  });

  const developer = screen.getByRole('article', {
    name: 'Developer attempt 1 cycle 1',
  });
  const qa = screen.getByRole('article', {
    name: 'QA attempt 1 cycle 1',
  });
  expect(
    developer.compareDocumentPosition(qa) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(qa).getByText('QA rejected')).toBeVisible();
});
