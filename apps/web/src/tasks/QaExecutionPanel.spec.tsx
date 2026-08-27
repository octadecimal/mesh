import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  developerCompletionReportSchema,
  projectSchema,
  qaExecutionCycleSchema,
  qaReportSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  type QaExecutionCycle,
  type QaReport,
  type ReviewAutomationAction,
  type ReviewAutomationState,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { QaExecutionPanel } from './QaExecutionPanel';

const timestamp = '2026-08-26T00:00:00.000Z';
const later = '2026-08-26T00:01:00.000Z';
const actor = taskActorSchema.parse({ type: 'human', id: 'operator' });
const project = projectSchema.parse({
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:\\code\\mesh',
  discoveredAt: timestamp,
  revision: 4,
  qaConfiguration: {
    instructions: {
      content: 'Verify carefully.',
      revision: 2,
      updatedAt: timestamp,
      updatedBy: actor,
    },
    reviewPolicy: 'manual',
    revision: 2,
    updatedAt: timestamp,
    updatedBy: actor,
  },
});
const task = taskSchema.parse({
  id: 'task-1',
  projectId: project.id,
  title: 'QA workflow',
  description: 'Review a developer submission.',
  acceptanceCriteria: ['History renders', 'Controls are safe'],
  priority: 'high',
  rank: 'a',
  lifecycleState: 'review',
  labels: [],
  notes: '',
  blocked: null,
  revision: 7,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const developerSession = sessionSchema.parse({
  id: 'developer-session',
  projectId: project.id,
  workspaceId: 'workspace-1',
  title: 'Developer run',
  permissionMode: 'interactive',
  lifecycleState: 'completed',
  createdAt: timestamp,
  updatedAt: timestamp,
});
const qaSession = sessionSchema.parse({
  ...developerSession,
  id: 'qa-session',
  title: 'QA run',
  lifecycleState: 'completed',
  updatedAt: later,
});
const attempt = {
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
const developerReport = developerCompletionReportSchema.parse({
  id: 'developer-report',
  cycleId: 'developer-cycle',
  summary: 'Implemented the UI.',
  criterionResults: [
    {
      criterionId: 'criterion-1',
      status: 'met',
      evidence: 'Developer evidence one.',
    },
    {
      criterionId: 'criterion-2',
      status: 'met',
      evidence: 'Developer evidence two.',
    },
  ],
  verification: [],
  limitations: '',
  workspaceState: {
    summary: 'Clean workspace.',
    hasUncommittedChanges: false,
    commitsCreated: true,
  },
  reviewerNotes: '',
  createdAt: timestamp,
});

const cycleFor = (overrides: Partial<QaExecutionCycle> = {}) =>
  qaExecutionCycleSchema.parse({
    id: 'qa-cycle-1',
    taskId: task.id,
    attemptId: attempt.attempt.id,
    sessionId: qaSession.id,
    ordinal: 1,
    authorizedBy: actor,
    authorizationCommandId: 'launch-command',
    policyVersion: 'qa-policy-v1',
    qaInstructions: { content: 'Verify carefully.', revision: 2 },
    taskSnapshot: {
      revision: 7,
      title: task.title,
      description: task.description,
      acceptanceCriteria: [
        { id: 'criterion-1', text: 'History renders' },
        { id: 'criterion-2', text: 'Controls are safe' },
      ],
    },
    developerCompletionReportId: developerReport.id,
    workspaceId: 'workspace-1',
    reviewPolicy: 'manual',
    reviewPolicyRevision: 2,
    automationGeneration: 0,
    rejectionOrdinal: 0,
    startedAt: timestamp,
    endedAt: later,
    terminalDisposition: 'verified',
    reportId: 'qa-report-1',
    terminalCommandId: 'verdict-command',
    terminalEventId: 'verdict-event',
    ...overrides,
  });
const cycle = cycleFor();
const reportFor = (overrides: Partial<QaReport> = {}) =>
  qaReportSchema.parse({
    id: 'qa-report-1',
    cycleId: cycle.id,
    disposition: 'verified',
    criterionResults: [
      {
        criterionId: 'criterion-1',
        status: 'passed',
        evidence: 'QA evidence one.',
      },
      {
        criterionId: 'criterion-2',
        status: 'passed',
        evidence: 'QA evidence two.',
      },
    ],
    verificationCommands: [
      { command: 'corepack pnpm nx test web', outcome: 'passed' },
    ],
    limitations: ['Visual inspection remains.'],
    residualRisks: ['None material.'],
    workspaceBefore: 'clean:abc',
    workspaceAfter: 'clean:abc',
    createdAt: later,
    ...overrides,
  });
const report = reportFor();

describe('QaExecutionPanel', () => {
  it('starts eligible manual QA and exposes only the verified acceptance action', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderPanel({ cycles: [], reports: [], onCommand });

    await user.click(screen.getByRole('button', { name: 'Start QA' }));
    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.qa.launch',
      payload: { taskId: task.id, expectedRevision: 7, actor },
    });

    rerender(panel({ cycles: [cycle], reports: [report], onCommand }));
    expect(
      screen.queryByRole('button', { name: 'Start QA' }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Accept verified work' }),
    );
    await waitFor(() =>
      expect(onCommand).toHaveBeenLastCalledWith({
        type: 'task.developer.accept',
        payload: { taskId: task.id, expectedRevision: 7, actor },
      }),
    );
  });

  it('shows autonomous budget, pending action, immediate pause, failures, and repairs', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const automation: ReviewAutomationState & {
      actions: ReviewAutomationAction[];
    } = {
      status: 'enabled',
      generation: 2,
      rejectionCount: 1,
      pauseReason: null,
      updatedAt: later,
      actions: [
        {
          id: 'action-1',
          idempotencyKey: 'idem-1',
          projectId: project.id,
          taskId: task.id,
          attemptId: attempt.attempt.id,
          sourceCycleId: cycle.id,
          actionKind: 'resume_developer',
          generation: 2,
          status: 'pending',
          errorCode: null,
          createdAt: later,
          completedAt: null,
        },
        {
          id: 'action-2',
          idempotencyKey: 'idem-2',
          projectId: project.id,
          taskId: task.id,
          attemptId: attempt.attempt.id,
          sourceCycleId: cycle.id,
          actionKind: 'launch_qa',
          generation: 1,
          status: 'failed',
          errorCode: 'qa_start_failed',
          createdAt: timestamp,
          completedAt: later,
        },
      ],
    };
    renderPanel({
      project: {
        ...project,
        qaConfiguration: {
          ...project.qaConfiguration,
          reviewPolicy: 'autonomous_review',
        },
      },
      automation,
      repairs: [
        {
          taskId: task.id,
          attemptId: attempt.attempt.id,
          sessionId: qaSession.id,
          reason: 'review_automation_action_incomplete',
        },
      ],
      onCommand,
    });

    expect(screen.getByText('2 autonomous rejections remaining')).toBeVisible();
    expect(
      screen.getByText(/upcoming automatic action: resume developer/i),
    ).toBeVisible();
    expect(screen.getByText(/qa_start_failed/i)).toBeVisible();
    expect(screen.getByText(/automation repair needed/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Pause automation' }));
    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.review_automation.pause',
      payload: { taskId: task.id, expectedRevision: 7, actor },
    });
  });

  it('opens the affected QA session from a repair warning', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    renderPanel({
      repairs: [
        {
          taskId: task.id,
          attemptId: attempt.attempt.id,
          sessionId: qaSession.id,
          reason: 'qa_session_workspace_mismatch',
        },
      ],
      onOpenSession,
    });

    await user.click(
      screen.getByRole('button', { name: 'Open affected QA session' }),
    );
    expect(onOpenSession).toHaveBeenCalledWith(qaSession.id);
  });

  it('compares Developer and QA evidence and warns about rejection, workspace changes, and resume failure', () => {
    const rejectedCycle = cycleFor({
      terminalDisposition: 'rejected',
      rejectionOrdinal: 1,
    });
    const rejectedReport = reportFor({
      disposition: 'rejected',
      criterionResults: [
        {
          criterionId: 'criterion-1',
          status: 'failed',
          evidence: 'QA found missing history.',
        },
        {
          criterionId: 'criterion-2',
          status: 'passed',
          evidence: 'Controls are safe.',
        },
      ],
      workspaceAfter: 'dirty:def',
    });
    renderPanel({ cycles: [rejectedCycle], reports: [rejectedReport] });

    expect(screen.getByText('QA rejected')).toBeVisible();
    const criterion = screen.getByRole('listitem', { name: 'History renders' });
    expect(
      within(criterion).getByText('Developer evidence one.'),
    ).toBeVisible();
    expect(
      within(criterion).getByText('QA found missing history.'),
    ).toBeVisible();
    expect(screen.getByText(/unexpected source changes/i)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Resume Developer rework' }),
    ).toBeEnabled();
  });

  it('offers QA for a newer Developer submission instead of acting on an old verdict', () => {
    const newerDeveloperReport = developerCompletionReportSchema.parse({
      ...developerReport,
      id: 'developer-report-2',
      cycleId: 'developer-cycle-2',
      summary: 'Addressed the QA rejection.',
      createdAt: '2026-08-26T00:04:00.000Z',
    });
    const rejectedCycle = cycleFor({ terminalDisposition: 'rejected' });
    const rejectedReport = reportFor({
      disposition: 'rejected',
      criterionResults: [
        {
          criterionId: 'criterion-1',
          status: 'failed',
          evidence: 'Old rejection.',
        },
        {
          criterionId: 'criterion-2',
          status: 'passed',
          evidence: 'Controls are safe.',
        },
      ],
    });

    renderPanel({
      cycles: [rejectedCycle],
      reports: [rejectedReport],
      developerCompletionReports: [developerReport, newerDeveloperReport],
    });

    expect(screen.getByRole('button', { name: 'Start QA' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Resume Developer rework' }),
    ).not.toBeInTheDocument();
  });
});

type PanelOptions = Partial<React.ComponentProps<typeof QaExecutionPanel>>;
const panel = (options: PanelOptions = {}) => (
  <QaExecutionPanel
    project={options.project ?? project}
    task={options.task ?? task}
    attempts={options.attempts ?? [attempt]}
    sessions={options.sessions ?? [developerSession, qaSession]}
    cycles={options.cycles ?? [cycle]}
    reports={options.reports ?? [report]}
    developerCompletionReports={
      options.developerCompletionReports ?? [developerReport]
    }
    automation={options.automation}
    repairs={options.repairs ?? []}
    connected={options.connected ?? true}
    readOnly={options.readOnly ?? false}
    onCommand={options.onCommand ?? vi.fn()}
    onOpenSession={options.onOpenSession}
  />
);
const renderPanel = (options: PanelOptions = {}) => render(panel(options));
