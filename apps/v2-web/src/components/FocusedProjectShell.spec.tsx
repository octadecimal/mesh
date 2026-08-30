import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  PlanningCycleView,
  V2ProjectSnapshot,
  WorkerExecution,
  WorkerExecutionLifecycle,
} from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { FocusedProjectShell } from './FocusedProjectShell';

const executionFixture = {
  id: '22222222-2222-4222-8222-222222222222',
  assignment: {
    title: 'Todo foundation worker',
  },
  lifecycle: 'running',
  resolvedSkills: [],
  adapterId: 'fake',
  nativeHandle: null,
  revision: 4,
  lastRuntimeSequence: 12,
  lastAdapterCursor: 8,
} as WorkerExecution;

const snapshot: V2ProjectSnapshot = {
  protocolVersion: 'mesh.v2/1',
  project: {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Todo',
    repositoryIdentity: 'todo-identity',
    repositoryPath: 'C:\\repos\\todo',
    gitCommonDirectory: 'C:\\repos\\todo\\.git',
    headCommit: 'a'.repeat(40),
    revision: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  },
  profiles: [],
  executions: [executionFixture],
  attentionItems: [
    {
      executionId: executionFixture.id,
      code: 'required_skill_unavailable',
      message: 'Required skill is unavailable.',
    },
  ],
  planningCycles: [],
  planningHistoryTruncated: false,
  intentLedger: null,
  cursors: { domain: 4, runtime: 12 },
};

const pmProfile = {
  profileId: '33333333-3333-4333-8333-333333333333',
  projectId: snapshot.project.id,
  profileRevision: 1,
  baseProfileId: null,
  baseRevision: null,
  document: {
    apiVersion: 'mesh.dev/v1alpha1',
    kind: 'WorkerProfile',
    metadata: {
      name: 'project-manager',
      displayName: 'Project manager',
      scope: 'project',
    },
    spec: {
      assignmentKinds: ['pm_discovery'],
      preferredRuntime: { harness: 'fake', model: 'deterministic' },
      alternatives: [],
      requiredCapabilities: [],
      skills: { preferred: [], required: [] },
      instructions: 'Discover intent.',
      outputSchema: 'mesh.pm-discovery-report/v1',
    },
  },
  digest: 'a'.repeat(64),
} as V2ProjectSnapshot['profiles'][number];

const planningCycle = {
  cycle: {
    id: '44444444-4444-4444-8444-444444444444',
    projectId: snapshot.project.id,
    lifecycle: 'awaiting_human',
    revision: 2,
    profileId: pmProfile.profileId,
    profileRevision: 1,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 0,
    activeExecutionId: null,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:01.000Z',
    endedAt: null,
  },
  turns: [],
  questions: [],
  proposals: [],
} as PlanningCycleView;

const terminalPlanningCycle = (
  lifecycle: 'approved' | 'proposal_rejected' | 'abandoned',
): PlanningCycleView => ({
  ...planningCycle,
  cycle: {
    ...planningCycle.cycle,
    lifecycle,
    revision: 3,
    latestProposalRevision: 1,
    updatedAt: '2026-08-28T00:00:03.000Z',
    endedAt: '2026-08-28T00:00:03.000Z',
  },
  turns: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      projectId: snapshot.project.id,
      planningCycleId: planningCycle.cycle.id,
      ordinal: 1,
      actor: 'human',
      message: `Visible ${lifecycle} planning transcript.`,
      launchState: 'consumed',
      executionId: null,
      createdAt: '2026-08-28T00:00:01.000Z',
    },
  ],
  proposals: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      projectId: snapshot.project.id,
      planningCycleId: planningCycle.cycle.id,
      revision: 1,
      lifecycle:
        lifecycle === 'approved'
          ? 'approved'
          : lifecycle === 'proposal_rejected'
            ? 'rejected'
            : 'superseded',
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      summary: `Visible ${lifecycle} proposal.`,
      projectIntent: {
        goal: 'Retain terminal planning history.',
        targetUsers: ['Operator'],
        desiredCapabilities: ['Review prior planning'],
        constraints: [],
        nonGoals: [],
        successConditions: ['Terminal history remains visible'],
        rationale: 'Planning history is durable authority.',
        provenance: [
          {
            kind: 'conversation_turn',
            turnId: '55555555-5555-4555-8555-555555555555',
            rationale: 'The prior human turn.',
          },
        ],
      },
      records: [],
      relationships: [],
      diff: {
        intentChanges: [],
        recordChanges: { create: 0, revise: 0, reuse: 0 },
        relationshipChanges: { added: [], removed: [] },
      },
      createdByTurnId: '55555555-5555-4555-8555-555555555555',
      createdByExecutionId: executionFixture.id,
      rejectionFeedback:
        lifecycle === 'proposal_rejected' ? 'Keep the scope smaller.' : null,
      createdAt: '2026-08-28T00:00:02.000Z',
      decidedAt: '2026-08-28T00:00:03.000Z',
    },
  ],
});

describe('FocusedProjectShell', () => {
  it.each([
    ['approved', 'Proposal approved.'],
    ['proposal_rejected', 'Proposal rejected.'],
    ['abandoned', 'This planning cycle was abandoned.'],
  ] as const)(
    'shows %s history and the ordinary new-cycle form without granting terminal command authority',
    (lifecycle, status) => {
      const terminalCycle = terminalPlanningCycle(lifecycle);

      render(
        <FocusedProjectShell
          model={{
            status: 'ready',
            interrupt: { enabled: true },
            snapshot: {
              ...snapshot,
              profiles: [pmProfile],
              planningCycles: [terminalCycle],
            },
          }}
          onDeselect={vi.fn()}
          onInterrupt={vi.fn()}
        />,
      );

      expect(screen.getByText(status)).toBeVisible();
      expect(
        screen.getByText(`Visible ${lifecycle} planning transcript.`),
      ).toBeVisible();
      expect(screen.getByText(`Visible ${lifecycle} proposal.`)).toBeVisible();
      expect(screen.getByLabelText('Project manager profile')).toBeVisible();
      expect(screen.getByLabelText('Message to project manager')).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Abandon cycle' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Approve proposal' }),
      ).not.toBeInTheDocument();
    },
  );

  it('derives history-limit guidance from the active cycle', () => {
    const boundedCycle = {
      ...planningCycle,
      turns: Array.from({ length: 32 }, (_, index) => ({
        id: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
        projectId: snapshot.project.id,
        planningCycleId: planningCycle.cycle.id,
        ordinal: index + 1,
        actor: 'human' as const,
        message: `Turn ${index + 1}`,
        launchState: 'consumed' as const,
        executionId: null,
        createdAt: '2026-08-28T00:00:01.000Z',
      })),
    };

    render(
      <FocusedProjectShell
        model={{
          status: 'ready',
          interrupt: { enabled: true },
          snapshot: {
            ...snapshot,
            profiles: [pmProfile],
            planningCycles: [boundedCycle],
          },
        }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'This cycle reached its history limit. Abandon it to begin a new cycle.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByLabelText('Project manager profile'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abandon cycle' })).toBeVisible();
  });

  it.each([
    ['failed', 'Project manager runtime failed.'],
    ['completed', 'Project manager output was missing.'],
    ['completed', 'Project manager output was malformed.'],
    ['completed', 'Project manager output belonged to another execution.'],
  ] as const)(
    'offers a human retry after %s recovery attention: %s',
    (lifecycle, message) => {
      const attentionCycle = {
        ...planningCycle,
        cycle: {
          ...planningCycle.cycle,
          lifecycle: 'attention_required' as const,
        },
        turns: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            projectId: snapshot.project.id,
            planningCycleId: planningCycle.cycle.id,
            ordinal: 1,
            actor: 'human' as const,
            message: 'Plan Todo.',
            launchState: 'execution_bound' as const,
            executionId: executionFixture.id,
            createdAt: '2026-08-28T00:00:01.000Z',
          },
        ],
      };
      const recoveredExecution = {
        ...executionFixture,
        lifecycle,
        failure:
          lifecycle === 'failed' ? { code: 'internal_error', message } : null,
      } as WorkerExecution;

      render(
        <FocusedProjectShell
          model={{
            status: 'ready',
            interrupt: { enabled: true },
            snapshot: {
              ...snapshot,
              profiles: [pmProfile],
              executions: [recoveredExecution],
              attentionItems: [
                {
                  executionId: executionFixture.id,
                  code: 'internal_error',
                  message,
                },
              ],
              planningCycles: [attentionCycle],
            },
          }}
          onDeselect={vi.fn()}
          onInterrupt={vi.fn()}
        />,
      );

      expect(screen.getAllByText(message)[0]).toBeVisible();
      expect(screen.getByLabelText('Message to project manager')).toBeVisible();
      expect(
        screen.queryByText('Abandon this cycle to start a new one.'),
      ).not.toBeInTheDocument();
    },
  );

  it('keeps ambiguous execution authority abandon-only with its durable diagnostic', () => {
    const operationId = '88888888-8888-4888-8888-888888888888';
    const probeReason = 'Execution has no native handle';
    const diagnostic = `${operationId}: ${probeReason}`;
    const attentionCycle = {
      ...planningCycle,
      cycle: {
        ...planningCycle.cycle,
        lifecycle: 'attention_required' as const,
      },
      turns: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          projectId: snapshot.project.id,
          planningCycleId: planningCycle.cycle.id,
          ordinal: 1,
          actor: 'human' as const,
          message: 'Plan Todo.',
          launchState: 'execution_bound' as const,
          executionId: executionFixture.id,
          createdAt: '2026-08-28T00:00:01.000Z',
        },
      ],
    };

    render(
      <FocusedProjectShell
        model={{
          status: 'ready',
          interrupt: { enabled: true },
          snapshot: {
            ...snapshot,
            profiles: [pmProfile],
            executions: [
              {
                ...executionFixture,
                lifecycle: 'attention_required',
                failure: null,
              } as WorkerExecution,
            ],
            attentionItems: [
              {
                executionId: executionFixture.id,
                code: 'internal_error',
                message: diagnostic,
              },
            ],
            planningCycles: [attentionCycle],
          },
        }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );

    expect(
      screen.getByText(`Operation ${operationId}: ${probeReason}`),
    ).toBeVisible();
    expect(
      screen.queryByLabelText('Message to project manager'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Abandon this cycle to start a new one.'),
    ).toBeVisible();
  });

  it('shows future panes, handles keyboard tabs, and calls deselect and interrupt callbacks', async () => {
    const user = userEvent.setup();
    const onDeselect = vi.fn();
    const onInterrupt = vi.fn();
    render(
      <FocusedProjectShell
        model={{ status: 'ready', snapshot, interrupt: { enabled: true } }}
        onDeselect={onDeselect}
        onInterrupt={onInterrupt}
        activityByExecutionId={{
          [executionFixture.id]: {
            childActivities: [
              {
                id: 'child-1',
                title: 'Read package.json',
                lifecycle: 'running',
              },
            ],
            runtimeActivity: [
              {
                id: '55555555-5555-4555-8555-555555555555',
                projectId: snapshot.project.id,
                executionId: executionFixture.id,
                diagnosticId: '66666666-6666-4666-8666-666666666666',
                sequence: 13,
                adapterCursor: 9,
                occurredAt: '2026-08-28T00:00:09.000Z',
                type: 'worker_execution.completed',
                payload: { outcome: 'completed' },
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getAllByText('Available in a later milestone')).toHaveLength(
      1,
    );
    expect(
      screen.getByRole('complementary', { name: 'PM Chat' }),
    ).toHaveTextContent('Project manager');
    const boardTab = screen.getByRole('tab', { name: 'Board' });
    await user.click(boardTab);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveFocus();
    expect(
      screen.getByRole('tabpanel', { name: 'Requirements' }),
    ).toHaveTextContent('No approved intent or requirements yet.');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveFocus();
    expect(boardTab).toHaveAttribute('id', 'project-pane-tab-board');
    expect(boardTab).toHaveAttribute(
      'aria-controls',
      'project-pane-panel-board',
    );
    expect(
      screen.queryByRole('button', { name: /start|approve|create/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deselect project' }));
    await user.click(
      screen.getByRole('button', { name: 'Interrupt execution' }),
    );
    expect(onDeselect).toHaveBeenCalledOnce();
    expect(onInterrupt).toHaveBeenCalledWith(executionFixture);
    expect(
      screen.getByRole('region', { name: 'Attention items' }),
    ).toHaveTextContent('Required skill is unavailable.');
    expect(
      screen.getByRole('list', {
        name: 'Child activity for Todo foundation worker',
      }),
    ).toHaveTextContent('Read package.json');
    expect(
      screen.getByRole('list', {
        name: 'Runtime activity for Todo foundation worker',
      }),
    ).toHaveTextContent('Execution completed');
  });

  it.each([
    'created',
    'starting',
    'running',
    'interrupting',
    'completed',
    'failed',
    'interrupted',
    'attention_required',
  ] as const)(
    'renders the %s execution lifecycle',
    (lifecycle: WorkerExecutionLifecycle) => {
      render(
        <FocusedProjectShell
          model={{
            status: 'ready',
            interrupt: { enabled: true },
            snapshot: {
              ...snapshot,
              executions: [{ ...executionFixture, lifecycle }],
            },
          }}
          onDeselect={vi.fn()}
          onInterrupt={vi.fn()}
        />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(lifecycle);
    },
  );

  it('renders loading, stale, and disconnected shell states with disabled mutation reasons', () => {
    const { rerender } = render(
      <FocusedProjectShell
        model={{ status: 'loading', projectId: snapshot.project.id }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading project');

    rerender(
      <FocusedProjectShell
        model={{ status: 'stale', snapshot, message: 'Resyncing project' }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Interrupt execution' }),
    ).toBeDisabled();
    expect(screen.getAllByText('Resyncing project')[0]).toBeVisible();
    expect(
      screen.getByText(
        'Wait for a fresh project snapshot before interrupting.',
      ),
    ).toBeVisible();

    rerender(
      <FocusedProjectShell
        model={{ status: 'disconnected', snapshot, message: 'Connection lost' }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Interrupt execution' }),
    ).toBeDisabled();
    expect(
      screen.getByText('Reconnect before interrupting an execution.'),
    ).toBeVisible();
  });

  it('uses the ready presentation reason when interrupting is unavailable', () => {
    render(
      <FocusedProjectShell
        model={{
          status: 'ready',
          snapshot,
          interrupt: {
            enabled: false,
            disabledReason: 'Audit barrier is active.',
          },
        }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Interrupt execution' }),
    ).toBeDisabled();
    expect(screen.getByText('Audit barrier is active.')).toBeVisible();
  });

  it('interrupts only the running execution in a mixed lifecycle list', async () => {
    const user = userEvent.setup();
    const onInterrupt = vi.fn();
    const completedExecution = {
      ...executionFixture,
      id: '44444444-4444-4444-8444-444444444444',
      assignment: { title: 'Completed Todo worker' },
      lifecycle: 'completed',
      revision: 5,
    } as WorkerExecution;
    render(
      <FocusedProjectShell
        model={{
          status: 'ready',
          interrupt: { enabled: true },
          snapshot: {
            ...snapshot,
            executions: [executionFixture, completedExecution],
          },
        }}
        onDeselect={vi.fn()}
        onInterrupt={onInterrupt}
      />,
    );

    const runningRow = screen
      .getByRole('article', { name: 'Todo foundation worker' })
      .closest('li');
    const completedRow = screen
      .getByRole('article', { name: 'Completed Todo worker' })
      .closest('li');
    expect(runningRow).not.toBeNull();
    expect(completedRow).not.toBeNull();
    if (runningRow === null || completedRow === null) {
      throw new Error('Expected an execution list row for each execution');
    }
    const runningInterrupt = within(runningRow).getByRole('button', {
      name: 'Interrupt execution',
    });
    const completedInterrupt = within(completedRow).getByRole('button', {
      name: 'Interrupt execution',
    });

    expect(runningInterrupt).toBeEnabled();
    expect(completedInterrupt).toBeDisabled();
    expect(completedInterrupt).toHaveAccessibleDescription(
      'Only running executions can be interrupted.',
    );
    await user.click(completedInterrupt);
    await user.click(runningInterrupt);
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(onInterrupt).toHaveBeenCalledWith(executionFixture);
  });
});
