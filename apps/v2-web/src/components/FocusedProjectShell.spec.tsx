import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import {
  deliveryPlanPlanningCycleViewSchema,
  type DeliveryPlanPlanningCycleView,
  type PlanningCycleView,
  type V2ProjectSnapshot,
  type WorkerExecution,
  type WorkerExecutionLifecycle,
} from '@mesh/v2-contracts';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { ProjectArtifact } from '../app/routes';
import { FocusedProjectShell as ProjectShell } from './FocusedProjectShell';

type ProjectShellProps = ComponentProps<typeof ProjectShell>;

function FocusedProjectShell({
  artifact = 'board',
  onNavigateArtifact = vi.fn(),
  onNavigate = vi.fn(),
  ...props
}: Omit<ProjectShellProps, 'artifact' | 'onNavigateArtifact' | 'onNavigate'> &
  Partial<
    Pick<ProjectShellProps, 'artifact' | 'onNavigateArtifact' | 'onNavigate'>
  >) {
  return (
    <ProjectShell
      {...props}
      artifact={artifact}
      onNavigateArtifact={onNavigateArtifact}
      onNavigate={onNavigate}
    />
  );
}

const executionFixture = {
  id: '22222222-2222-4222-8222-222222222222',
  assignment: {
    kind: 'foundation-check',
    projectId: '11111111-1111-4111-8111-111111111111',
    title: 'Todo foundation worker',
    instructions: 'Verify the Todo foundation.',
    fakeScenario: 'todo-foundation-v1',
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
  deliveryPlan: null,
  board: {
    projectId: '11111111-1111-4111-8111-111111111111',
    deliveryPlanRevision: null,
    stale: false,
    emptyReason: 'intent_required',
    filter: null,
    totalTaskCount: 0,
    matchedTaskCount: 0,
    facets: {
      milestones: [],
      taskLifecycles: [],
      readiness: [],
      priorities: [],
      labels: [],
      requirements: [],
    },
    cards: [],
  },
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
      outputSchema: 'mesh.dev/pm-discovery-report/v1',
    },
  },
  digest: 'a'.repeat(64),
} as V2ProjectSnapshot['profiles'][number];

const planningCycle = {
  purpose: {
    kind: 'intent',
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
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
  deliveryPlanProposals: [],
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

const awaitingIntentReviewCycle = (() => {
  const cycle = terminalPlanningCycle('approved');
  return {
    ...cycle,
    cycle: {
      ...cycle.cycle,
      lifecycle: 'awaiting_approval',
      endedAt: null,
    },
    proposals: cycle.proposals.map((proposal) => ({
      ...proposal,
      lifecycle: 'awaiting_approval' as const,
      decidedAt: null,
    })),
  } as PlanningCycleView;
})();

const awaitingDeliveryReviewCycle: DeliveryPlanPlanningCycleView =
  deliveryPlanPlanningCycleViewSchema.parse({
    purpose: {
      kind: 'delivery_plan',
      baseDeliveryPlanId: null,
      baseDeliveryPlanRevision: null,
    },
    cycle: {
      ...planningCycle.cycle,
      id: '70707070-7070-4070-8070-707070707070',
      lifecycle: 'awaiting_approval',
      baseProjectIntentRevision: 1,
      baseLedgerRevision: 1,
      latestProposalRevision: 1,
    },
    turns: [
      {
        id: '75757575-7575-4575-8575-757575757575',
        projectId: snapshot.project.id,
        planningCycleId: '70707070-7070-4070-8070-707070707070',
        ordinal: 1,
        actor: 'human',
        message: 'Plan delivery.',
        launchState: 'execution_bound',
        executionId: executionFixture.id,
        createdAt: '2026-08-28T00:00:01.000Z',
      },
      {
        id: '74747474-7474-4474-8474-747474747474',
        projectId: snapshot.project.id,
        planningCycleId: '70707070-7070-4070-8070-707070707070',
        ordinal: 2,
        actor: 'pm',
        message: 'Review this delivery plan.',
        launchState: null,
        executionId: executionFixture.id,
        createdAt: '2026-08-28T00:00:02.000Z',
      },
    ],
    questions: [],
    proposals: [],
    deliveryPlanProposals: [
      {
        id: '71717171-7171-4171-8171-717171717171',
        projectId: snapshot.project.id,
        planningCycleId: '70707070-7070-4070-8070-707070707070',
        revision: 1,
        lifecycle: 'awaiting_approval',
        base: {
          projectIntentId: '72727272-7272-4272-8272-727272727272',
          projectIntentRevision: 1,
          ledgerId: '73737373-7373-4373-8373-737373737373',
          ledgerRevision: 1,
          deliveryPlan: { id: null, revision: null },
        },
        proposedPlan: {
          summary: 'Deliver the approved intent.',
          milestones: [
            {
              operation: 'create',
              key: 'delivery',
              content: {
                title: 'Delivery',
                outcome: 'The approved intent is delivered.',
                stopCondition: 'The delivery criteria pass.',
                exclusions: [],
                ordinal: 1,
              },
            },
          ],
          tasks: [
            {
              operation: 'create',
              key: 'deliver-intent',
              content: {
                milestone: { kind: 'proposal', key: 'delivery' },
                title: 'Deliver intent',
                outcome: 'The approved intent works.',
                acceptanceCriteria: ['The intent is delivered.'],
                verificationCriteria: ['Verify the delivered intent.'],
                priority: 'must',
                labels: [],
                ownedSurfaces: ['Delivery'],
                prohibitedSurfaces: [],
                expectedArtifacts: ['Focused test'],
                ordinal: 1,
              },
            },
          ],
          dependencies: [],
          traces: [
            {
              kind: 'milestone_covers',
              milestone: { kind: 'proposal', key: 'delivery' },
              requirement: {
                recordId: '76767676-7676-4676-8676-767676767676',
                recordRevision: 1,
              },
            },
            {
              kind: 'task_satisfies',
              task: { kind: 'proposal', key: 'deliver-intent' },
              requirement: {
                recordId: '76767676-7676-4676-8676-767676767676',
                recordRevision: 1,
              },
            },
          ],
        },
        reservations: {
          milestones: [
            {
              key: 'delivery',
              id: '77777777-7777-4777-8777-777777777777',
            },
          ],
          tasks: [
            {
              key: 'deliver-intent',
              id: '78787878-7878-4878-8878-787878787878',
            },
          ],
          dependencies: [],
        },
        diff: {
          milestones: {
            create: 1,
            reuse: 0,
            revise: 0,
            retire: 0,
            reactivate: 0,
          },
          tasks: {
            create: 1,
            reuse: 0,
            revise: 0,
            retire: 0,
            reactivate: 0,
          },
          dependencies: {
            create: 0,
            reuse: 0,
            revise: 0,
            retire: 0,
            reactivate: 0,
          },
          traceCreateCount: 2,
          traceRemoveCount: 0,
        },
        createdByTurnId: '74747474-7474-4474-8474-747474747474',
        createdByExecutionId: executionFixture.id,
        createdAt: '2026-08-28T00:00:02.000Z',
        decision: { kind: 'pending' },
      },
    ],
  });

describe('FocusedProjectShell', () => {
  it('uses URL-controlled project artifacts with roving keyboard navigation', async () => {
    const user = userEvent.setup();
    const onNavigateArtifact = vi.fn();
    const onNavigate = vi.fn();

    render(
      <FocusedProjectShell
        artifact="overview"
        model={{ status: 'ready', snapshot, interrupt: { enabled: true } }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
        onNavigateArtifact={onNavigateArtifact}
        onNavigate={onNavigate}
      />,
    );

    expectTypeOf<
      Parameters<typeof ProjectShell>[0]['artifact']
    >().toEqualTypeOf<ProjectArtifact>();
    expectTypeOf<'inbox'>().not.toMatchTypeOf<ProjectArtifact>();
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(overview).toHaveAttribute('aria-current', 'page');
    expect(overview).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(snapshot.project.repositoryPath)).toBeVisible();
    expect(screen.getByText('Connected')).toBeVisible();
    expect(screen.getByText(/Domain cursor 4/)).toBeVisible();
    expect(screen.getByText(/runtime cursor 12/)).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Requirements' }));
    expect(onNavigateArtifact).toHaveBeenCalledWith('requirements');
    overview.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(overview).toHaveFocus();
    expect(onNavigateArtifact.mock.calls.map(([artifact]) => artifact)).toEqual(
      ['requirements', 'requirements', 'runs', 'overview'],
    );
  });

  it('passes URL-selected run detail only to the Runs artifact', () => {
    const completed = {
      ...executionFixture,
      id: '99999999-9999-4999-8999-999999999999',
      lifecycle: 'completed',
      updatedAt: '2026-08-28T00:00:10.000Z',
      endedAt: '2026-08-28T00:00:10.000Z',
    } as WorkerExecution;

    render(
      <FocusedProjectShell
        artifact="runs"
        selectedId={completed.id}
        model={{
          status: 'ready',
          snapshot: {
            ...snapshot,
            executions: [executionFixture, completed],
          },
          interrupt: { enabled: true },
        }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
        onNavigateArtifact={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    const panel = screen.getByRole('tabpanel', { name: 'Runs' });
    expect(within(panel).getByRole('tab', { name: 'History' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      within(screen.getByRole('region', { name: 'Run details' })).getByText(
        'Completed',
      ),
    ).toBeVisible();
  });

  it.each([
    ['approved', 'Proposal approved.'],
    ['proposal_rejected', 'Proposal rejected.'],
    ['abandoned', 'This planning cycle was abandoned.'],
  ] as const)(
    'shows %s history and the ordinary new-cycle form without granting terminal command authority',
    (lifecycle, status) => {
      const terminalCycle = terminalPlanningCycle(lifecycle);

      const { container } = render(
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
      fireEvent.click(screen.getByRole('button', { name: 'Project manager' }));

      expect(screen.getByText(status)).toBeVisible();
      expect(
        screen.getByText(`Visible ${lifecycle} planning transcript.`),
      ).toBeVisible();
      expect(
        screen.getByRole('heading', { name: 'Intent history' }),
      ).toBeVisible();
      expect(screen.getByRole('heading', { name: 'Intent' })).toBeVisible();
      expect(screen.getByLabelText('Project manager profile')).toBeVisible();
      expect(screen.getByLabelText('Message to project manager')).toBeVisible();
      const ids = [...container.querySelectorAll<HTMLElement>('[id]')].map(
        ({ id }) => id,
      );
      expect(new Set(ids).size).toBe(ids.length);
      for (const relationship of container.querySelectorAll<HTMLElement>(
        '[aria-labelledby]',
      )) {
        const labelledBy = relationship.getAttribute('aria-labelledby');
        if (labelledBy === null)
          throw new Error('Expected labelled relationship');
        for (const id of labelledBy.split(' ')) {
          expect(ids.filter((candidate) => candidate === id)).toHaveLength(1);
        }
      }
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
        artifact="plans"
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
      fireEvent.click(screen.getByRole('button', { name: 'Project manager' }));

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
        artifact="plans"
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

  it('preserves project callbacks and live execution activity', async () => {
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

    expect(
      screen.queryByText('Available in a later milestone'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Approve project intent and requirements to plan delivery.',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Project manager' }),
    ).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute(
      'aria-current',
      'page',
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
      expect(
        within(
          screen.getByRole('article', { name: 'Todo foundation worker' }),
        ).getByRole('status'),
      ).toHaveTextContent(lifecycle);
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
      assignment: {
        kind: 'foundation-check',
        projectId: snapshot.project.id,
        title: 'Completed Todo worker',
        instructions: 'Verify the completed Todo foundation.',
        fakeScenario: 'todo-foundation-v1',
      },
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

  it('keeps one project manager drawer mounted beside every artifact', async () => {
    const user = userEvent.setup();
    const shell = (artifact: ProjectArtifact) => (
      <ProjectShell
        model={{ status: 'ready', snapshot, interrupt: { enabled: true } }}
        artifact={artifact}
        onNavigateArtifact={vi.fn()}
        onNavigate={vi.fn()}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />
    );
    const view = render(shell('overview'));

    expect(
      screen.getByRole('button', { name: 'Project manager' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Project manager' }));
    expect(
      screen.getByRole('dialog', { name: 'Project manager · Todo' }),
    ).toBeVisible();

    view.rerender(shell('board'));
    expect(
      screen.getByRole('dialog', { name: 'Project manager · Todo' }),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Close project manager' }),
    );

    view.rerender(shell('plans'));
    expect(screen.getByRole('heading', { name: 'Plans' })).toBeVisible();
    expect(
      screen.queryByRole('textbox', { name: 'Message to project manager' }),
    ).not.toBeInTheDocument();
  });

  it('routes pinned Plans revision requests to the sole matching drawer composer', async () => {
    localStorage.setItem('mesh.v2.pm-pinned', 'true');
    const user = userEvent.setup();
    const { container } = render(
      <ProjectShell
        artifact="plans"
        model={{
          status: 'ready',
          interrupt: { enabled: true },
          snapshot: {
            ...snapshot,
            profiles: [pmProfile],
            planningCycles: [
              awaitingIntentReviewCycle,
              awaitingDeliveryReviewCycle,
            ],
          },
        }}
        onNavigateArtifact={vi.fn()}
        onNavigate={vi.fn()}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    const intentReview = screen
      .getByRole('heading', { name: 'Intent' })
      .closest('section');
    const deliveryReview = screen
      .getByRole('heading', { name: 'Planning' })
      .closest('section');
    if (!intentReview || !deliveryReview)
      throw new Error('Expected both Plans review sections');

    await user.click(
      within(deliveryReview).getByRole('button', { name: 'Request revision' }),
    );
    let drawer = screen.getByRole('complementary', {
      name: 'Project manager · Todo',
    });
    expect(
      within(drawer).getByRole('tab', { name: 'Delivery Plan' }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getAllByRole('textbox', { name: 'Message to project manager' }),
    ).toHaveLength(1);
    expect(
      within(drawer).getByRole('textbox', {
        name: 'Message to project manager',
      }),
    ).toHaveFocus();
    expect(
      new Set([...container.querySelectorAll('[id]')].map(({ id }) => id)).size,
    ).toBe(container.querySelectorAll('[id]').length);

    await user.click(
      within(drawer).getByRole('button', { name: 'Close project manager' }),
    );
    await user.click(
      within(intentReview).getByRole('button', { name: 'Request revision' }),
    );
    drawer = screen.getByRole('complementary', {
      name: 'Project manager · Todo',
    });
    expect(within(drawer).getByRole('tab', { name: 'Intent' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getAllByRole('textbox', { name: 'Message to project manager' }),
    ).toHaveLength(1);
    expect(
      within(drawer).getByRole('textbox', {
        name: 'Message to project manager',
      }),
    ).toHaveFocus();
    expect(
      new Set([...container.querySelectorAll('[id]')].map(({ id }) => id)).size,
    ).toBe(container.querySelectorAll('[id]').length);
    localStorage.removeItem('mesh.v2.pm-pinned');
  });
});
