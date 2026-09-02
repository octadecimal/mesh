import {
  type BoardTaskCard,
  type DeveloperAttempt,
  type DeveloperReportRecord,
  type ResolvedWorkerProfileSnapshot,
  type WorkerExecution,
} from '@mesh/v2-contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DeveloperSection } from './DeveloperSection';

const projectId = '11111111-1111-4111-8111-111111111111';
const taskId = '55555555-5555-4555-8555-555555555555';
const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const executionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const replacementExecutionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const profileId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const now = '2026-09-01T18:00:00.000Z';

const card: BoardTaskCard = {
  taskId,
  taskContractRevision: 3,
  taskCurrentRevision: 4,
  milestoneId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  milestoneRevision: 2,
  title: 'Persist Todo',
  outcome: 'A durable todo is saved.',
  lifecycle: 'pending',
  priority: 'must',
  labels: ['persistence'],
  readiness: { state: 'actionable', blockers: [] },
  dependencies: [],
  detail: {
    acceptanceCriteria: ['The todo survives restart.'],
    verificationCriteria: ['Run the focused restart test.'],
    ownedSurfaces: ['src/todo.ts'],
    prohibitedSurfaces: [],
    expectedArtifacts: ['Todo persistence tests'],
    milestoneOutcome: 'Todos survive restart.',
    milestoneStopCondition: 'The focused restart test passes.',
    milestoneExclusions: [],
    requirementTraces: [
      {
        recordId: '17171717-1717-4171-8171-171717171717',
        recordRevision: 2,
        title: 'Durable todos',
      },
    ],
  },
};

const developerProfile = {
  profileId,
  profileRevision: 3,
  projectId,
  baseProfileId: null,
  baseRevision: null,
  document: {
    apiVersion: 'mesh.dev/v1alpha1',
    kind: 'WorkerProfile',
    metadata: {
      name: 'todo-developer',
      displayName: 'Todo Developer',
      scope: 'project',
    },
    spec: {
      assignmentKinds: ['developer_task'],
      preferredRuntime: { harness: 'fake', model: 'fake-v1' },
      alternatives: [],
      requiredCapabilities: [],
      skills: { preferred: [], required: [] },
      instructions: 'Implement the assigned task only.',
      outputSchema: 'mesh.dev/developer-report/v1',
    },
  },
  digest: 'c'.repeat(64),
} satisfies ResolvedWorkerProfileSnapshot;

const planningProfile = {
  ...developerProfile,
  profileId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  profileRevision: 1,
  document: {
    ...developerProfile.document,
    metadata: {
      ...developerProfile.document.metadata,
      name: 'planner',
      displayName: 'Planner',
    },
    spec: {
      ...developerProfile.document.spec,
      assignmentKinds: ['pm_plan'],
      outputSchema: 'mesh.dev/pm-plan-report/v1',
    },
  },
} satisfies ResolvedWorkerProfileSnapshot;

const assignment = {
  kind: 'developer_task' as const,
  projectId,
  attemptId,
  taskId,
  taskContractRevision: card.taskContractRevision,
  taskCurrentRevision: 4,
  deliveryPlanId: '12121212-1212-4121-8121-121212121212',
  deliveryPlanRevision: 7,
  requirementRevisions: [
    {
      recordId: card.detail.requirementTraces[0].recordId,
      recordRevision: card.detail.requirementTraces[0].recordRevision,
    },
  ],
  baseCommit: '1'.repeat(40),
  workspacePath: 'C:\\worktrees\\persist-todo',
  title: card.title,
  outcome: card.outcome,
  acceptanceCriteria: card.detail.acceptanceCriteria,
  verification: card.detail.verificationCriteria,
  expectedArtifacts: card.detail.expectedArtifacts,
  outputSchema: 'mesh.dev/developer-report/v1' as const,
};

const execution = {
  id: executionId,
  projectId,
  profileId,
  profileRevision: 3,
  assignment,
  profileSnapshot: developerProfile,
  skillRequests: { preferred: [], required: [] },
  resolvedSkills: [],
  capabilitySnapshot: {
    adapterId: 'fake',
    capabilities: [],
    skills: [],
    exactResume: true,
  },
  adapterId: 'fake',
  model: 'fake-v1',
  nativeHandle: 'fake:v1:developer',
  lifecycle: 'running',
  revision: 2,
  lastAdapterCursor: 2,
  lastRuntimeSequence: 2,
  replacementForExecutionId: null,
  failure: null,
  createdAt: now,
  updatedAt: now,
  endedAt: null,
} satisfies WorkerExecution;

const activeAttempt = {
  id: attemptId,
  projectId,
  taskId,
  ordinal: 1,
  lifecycle: 'active',
  revision: 5,
  deliveryPlanId: assignment.deliveryPlanId,
  deliveryPlanRevision: assignment.deliveryPlanRevision,
  intentRevision: 2,
  ledgerRevision: 3,
  taskContractRevision: card.taskContractRevision,
  taskCurrentRevision: card.taskCurrentRevision,
  requirementRevisions: assignment.requirementRevisions,
  baseCommit: assignment.baseCommit,
  profileId,
  profileRevision: 3,
  assignment,
  workspace: {
    attemptId,
    repositoryPath: 'C:\\repos\\todo',
    repositoryIdentity: 'repo-1',
    branch: 'mesh/persist-todo',
    path: assignment.workspacePath,
    baseCommit: assignment.baseCommit,
    lifecycle: 'ready',
    ownershipToken: 'owned-by-mesh',
    observedHead: '2'.repeat(40),
    observedDirty: true,
    failure: null,
    revision: 2,
    createdAt: now,
    updatedAt: now,
  },
  executionIds: [executionId],
  controllingExecutionId: executionId,
  reportIds: [],
  attention: null,
  createdAt: now,
  updatedAt: now,
  endedAt: null,
} satisfies DeveloperAttempt;

const completionReport = {
  id: '13131313-1313-4131-8131-131313131313',
  report: {
    schema: 'mesh.dev/developer-report/v1',
    disposition: 'completed',
    attemptId,
    executionId,
    taskId,
    taskContractRevision: card.taskContractRevision,
    requirementCoverage: [
      {
        recordId: card.detail.requirementTraces[0].recordId,
        recordRevision: card.detail.requirementTraces[0].recordRevision,
        passed: true,
        evidence: [{ summary: 'SQLite row is restored.' }],
      },
    ],
    criterionCoverage: [
      {
        index: 0,
        text: card.detail.acceptanceCriteria[0],
        passed: true,
        evidence: [{ summary: 'Restart test passes.' }],
      },
    ],
    changedArtifacts: [{ path: 'src/todo.ts', summary: 'Persists todos.' }],
    verification: [
      {
        command: 'pnpm test',
        passed: true,
        evidence: [{ summary: 'Focused suite passed.' }],
      },
    ],
    unresolvedConcerns: ['A broader retention policy is deferred.'],
    workspace: { headCommit: '2'.repeat(40), dirty: true },
  },
  recordedAt: now,
} satisfies DeveloperReportRecord;

const blockedReport = {
  id: '15151515-1515-4151-8151-151515151515',
  report: {
    schema: 'mesh.dev/developer-report/v1',
    disposition: 'blocked',
    attemptId,
    executionId,
    taskId,
    taskContractRevision: card.taskContractRevision,
    blocker: 'The database fixture is unavailable.',
    evidence: [{ summary: 'The fixture path does not exist.' }],
    suggestedNextAction: 'Restore the fixture, then replace the execution.',
    preserveWorkspace: true,
    workspace: { headCommit: '2'.repeat(40), dirty: true },
  },
  recordedAt: now,
} satisfies DeveloperReportRecord;

const readyConnection = {
  status: 'ready' as const,
};

const baseProps = {
  card,
  attempts: [],
  reports: [],
  executions: [],
  profiles: [developerProfile, planningProfile],
  projectCursors: { domain: 4, runtime: 2 },
  activityByExecutionId: {},
  connection: readyConnection,
  submitting: false,
  onStart: vi.fn(),
  onInterrupt: vi.fn(),
  onReplace: vi.fn(),
};

describe('DeveloperSection', () => {
  it('offers only exact compatible Developer profiles and waits for server truth after keyboard start', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<DeveloperSection {...baseProps} onStart={onStart} />);

    const section = screen.getByRole('region', {
      name: `Developer for ${card.title}`,
    });
    expect(section).toBeVisible();
    expect(
      screen.getByRole('option', { name: /Todo Developer/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole('option', { name: /Planner/ }),
    ).not.toBeInTheDocument();

    await user.tab();
    expect(
      screen.getByRole('combobox', { name: 'Developer profile' }),
    ).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole('button', { name: 'Start Developer attempt' }),
    ).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onStart).toHaveBeenCalledWith(developerProfile);
    expect(screen.queryByText(/attempt 1/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start Developer attempt' }),
    ).toBeEnabled();
  });

  it('shows active progress, linked execution activity, dirty workspace truth, and interrupt control', () => {
    const onInterrupt = vi.fn();
    render(
      <DeveloperSection
        {...baseProps}
        attempts={[activeAttempt]}
        executions={[execution]}
        activityByExecutionId={{
          [executionId]: {
            childActivities: [
              {
                id: 'child-1',
                title: 'Run focused tests',
                lifecycle: 'running',
              },
            ],
          },
        }}
        onInterrupt={onInterrupt}
      />,
    );

    expect(
      screen.getByRole('status', { name: 'Developer attempt state' }),
    ).toHaveTextContent('Active');
    expect(screen.getByRole('heading', { name: card.title })).toBeVisible();
    expect(screen.getByText('Run focused tests')).toBeVisible();
    expect(screen.getByText(/dirty: yes/i)).toBeVisible();

    fireEvent.click(
      screen.getByRole('button', { name: 'Interrupt attempt 1' }),
    );
    expect(onInterrupt).toHaveBeenCalledWith(activeAttempt);
  });

  it('renders replacement chronology and enables replacement only for an interrupted execution', () => {
    const interruptedExecution = {
      ...execution,
      lifecycle: 'interrupted',
      revision: 3,
      endedAt: now,
    } satisfies WorkerExecution;
    const replacementExecution = {
      ...interruptedExecution,
      id: replacementExecutionId,
      replacementForExecutionId: executionId,
    } satisfies WorkerExecution;
    const interruptedAttempt = {
      ...activeAttempt,
      lifecycle: 'interrupted',
      revision: 6,
      executionIds: [executionId, replacementExecutionId],
      controllingExecutionId: replacementExecutionId,
      endedAt: now,
    } satisfies DeveloperAttempt;
    const onReplace = vi.fn();

    render(
      <DeveloperSection
        {...baseProps}
        attempts={[interruptedAttempt]}
        executions={[interruptedExecution, replacementExecution]}
        onReplace={onReplace}
      />,
    );

    expect(screen.getByText('Execution 1')).toBeVisible();
    expect(screen.getByText('Execution 2')).toBeVisible();
    expect(screen.getByText(/replaces execution 1/i)).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Replace attempt 1 execution' }),
    );
    expect(onReplace).toHaveBeenCalledWith(interruptedAttempt);
  });

  it('keeps interrupt and replacement visible with server-ineligible reasons', () => {
    const interruptedExecution = {
      ...execution,
      lifecycle: 'interrupted',
      revision: 3,
      endedAt: now,
    } satisfies WorkerExecution;
    const { rerender } = render(
      <DeveloperSection
        {...baseProps}
        attempts={[activeAttempt]}
        executions={[interruptedExecution]}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Interrupt attempt 1' }),
    ).toBeDisabled();
    expect(
      screen.getByText('The controlling execution is not running.'),
    ).toBeVisible();

    rerender(
      <DeveloperSection
        {...baseProps}
        attempts={[
          {
            ...activeAttempt,
            lifecycle: 'interrupted',
            workspace: {
              ...activeAttempt.workspace,
              lifecycle: 'attention_required',
              failure: {
                code: 'workspace_attention',
                message: 'Workspace requires operator review.',
              },
            },
            endedAt: now,
          },
        ]}
        executions={[interruptedExecution]}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Replace attempt 1 execution' }),
    ).toBeDisabled();
    expect(
      screen.getByText('The managed workspace is not ready for replacement.'),
    ).toBeVisible();
  });

  it('renders completed evidence, blocked guidance, and attention-required reasons', () => {
    const { rerender } = render(
      <DeveloperSection
        {...baseProps}
        attempts={[
          {
            ...activeAttempt,
            lifecycle: 'completed',
            reportIds: [completionReport.id],
            endedAt: now,
          },
        ]}
        reports={[completionReport]}
      />,
    );

    expect(screen.getByText(/src\/todo\.ts.*Persists todos\./)).toBeVisible();
    expect(screen.getByText(/Restart test passes\./)).toBeVisible();
    expect(screen.getByText(/SQLite row is restored\./)).toBeVisible();
    expect(screen.getByText(/pnpm test.*passed/)).toBeVisible();
    expect(screen.getAllByText(/head 2222222/i)).toHaveLength(2);

    rerender(
      <DeveloperSection
        {...baseProps}
        attempts={[
          {
            ...activeAttempt,
            lifecycle: 'blocked',
            reportIds: [blockedReport.id],
            endedAt: now,
          },
        ]}
        reports={[blockedReport]}
      />,
    );
    expect(
      screen.getByText('The database fixture is unavailable.'),
    ).toBeVisible();
    expect(screen.getByText(/restore the fixture/i)).toBeVisible();
    expect(screen.getByText(/workspace will be preserved/i)).toBeVisible();

    rerender(
      <DeveloperSection
        {...baseProps}
        attempts={[
          {
            ...activeAttempt,
            lifecycle: 'attention_required',
            attention: {
              code: 'developer_workspace_identity_mismatch',
              message: 'Workspace identity no longer matches.',
            },
            endedAt: now,
          },
        ]}
      />,
    );
    expect(
      screen.getByText(/Workspace identity no longer matches\./),
    ).toBeVisible();
  });

  it.each([
    [
      'disconnected',
      {
        status: 'disconnected' as const,
        message: 'Project connection is disconnected.',
      },
      false,
      card,
      [],
      [developerProfile],
      'Project connection is disconnected.',
    ],
    [
      'stale',
      {
        status: 'stale' as const,
        message: 'Refreshing current project truth.',
      },
      false,
      card,
      [],
      [developerProfile],
      'Refreshing current project truth.',
    ],
    [
      'submitting',
      readyConnection,
      true,
      card,
      [],
      [developerProfile],
      'A project command is in progress.',
    ],
    [
      'non-actionable task',
      readyConnection,
      false,
      {
        ...card,
        readiness: {
          state: 'blocked' as const,
          blockers: [{ kind: 'plan_not_approved' as const }],
        },
      },
      [],
      [developerProfile],
      'Task is not actionable.',
    ],
    [
      'controlling attempt',
      readyConnection,
      false,
      card,
      [activeAttempt],
      [developerProfile],
      'This task already has a controlling Developer attempt.',
    ],
    [
      'no compatible profile',
      readyConnection,
      false,
      card,
      [],
      [planningProfile],
      'No compatible approved Developer profile is available.',
    ],
  ])(
    'shows a visible disabled reason when %s',
    (_, connection, submitting, taskCard, attempts, profiles, reason) => {
      render(
        <DeveloperSection
          {...baseProps}
          card={taskCard as BoardTaskCard}
          connection={connection}
          submitting={submitting}
          attempts={attempts}
          profiles={profiles}
        />,
      );

      expect(
        screen.getByRole('button', { name: 'Start Developer attempt' }),
      ).toBeDisabled();
      expect(screen.getByText(reason)).toBeVisible();
    },
  );

  it('moves focus to an assertive command error without hiding the selected task', () => {
    const { rerender } = render(<DeveloperSection {...baseProps} />);

    rerender(
      <DeveloperSection
        {...baseProps}
        error="Task changed. Refreshing current project truth."
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveFocus();
    expect(
      screen.getByRole('region', { name: `Developer for ${card.title}` }),
    ).toBeVisible();
  });
});
