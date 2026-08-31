import { render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  approvedDeliveryPlanSchema,
  approvedIntentLedgerSchema,
  deliveryPlanPlanningCycleViewSchema,
  planningCycleViewSchema,
  type PlanningCycleView,
  type PlanningProposal,
  workerProfileSummarySchema,
} from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { DeliveryPlanningPane, PlanningPane } from './PlanningPane';

const projectId = '11111111-1111-4111-8111-111111111111';
const cycleId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const turnId = '44444444-4444-4444-8444-444444444444';
const executionId = '55555555-5555-4555-8555-555555555555';
const secondExecutionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const createRecordId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const reviseRecordId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const reuseRecordId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const provenance = [
  {
    kind: 'conversation_turn' as const,
    turnId,
    rationale: 'The operator asked for Todo.',
  },
];

const profile = workerProfileSummarySchema.parse({
  profileId: '66666666-6666-4666-8666-666666666666',
  projectId: null,
  scope: 'global',
  name: 'todo-pm',
  displayName: 'Todo PM',
  approvedRevision: 1,
});

const baseCycle = planningCycleViewSchema.parse({
  cycle: {
    id: cycleId,
    projectId,
    lifecycle: 'awaiting_human',
    revision: 3,
    profileId: profile.profileId,
    profileRevision: 1,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 0,
    activeExecutionId: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:01.000Z',
    endedAt: null,
  },
  purpose: {
    kind: 'intent',
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
  turns: [
    {
      id: turnId,
      projectId,
      planningCycleId: cycleId,
      ordinal: 1,
      actor: 'human',
      message: 'Build a useful Todo app.',
      launchState: 'execution_bound',
      executionId,
      createdAt: '2026-08-29T00:00:00.000Z',
    },
    {
      id: '77777777-7777-4777-8777-777777777777',
      projectId,
      planningCycleId: cycleId,
      ordinal: 2,
      actor: 'pm',
      message: 'Who will use it?',
      launchState: null,
      executionId,
      createdAt: '2026-08-29T00:00:01.000Z',
    },
  ],
  questions: [
    {
      id: '88888888-8888-4888-8888-888888888888',
      projectId,
      planningCycleId: cycleId,
      turnId: '77777777-7777-4777-8777-777777777777',
      key: 'audience',
      prompt: 'Who will use it?',
      rationale: 'Audience determines the workflow.',
      choices: ['Individuals', 'Teams'],
    },
  ],
  proposals: [],
  deliveryPlanProposals: [],
});

const approvedIntentLedger = approvedIntentLedgerSchema.parse({
  projectIntent: {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    projectId,
    revision: 1,
    proposalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    approvedBy: 'human',
    approvedAt: '2026-08-28T00:00:00.000Z',
    content: {
      goal: 'Track Todo items.',
      targetUsers: ['Individuals'],
      desiredCapabilities: ['Add tasks'],
      constraints: [],
      nonGoals: [],
      successConditions: ['Tasks can be completed'],
      rationale: 'Start with a useful baseline.',
      provenance,
    },
  },
  ledger: {
    id: '12121212-1212-4212-8212-121212121212',
    projectId,
    revision: 1,
    proposalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    approvedBy: 'human',
    approvedAt: '2026-08-28T00:00:00.000Z',
  },
  records: [
    {
      recordId: reviseRecordId,
      projectId,
      revision: 2,
      proposalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      approvedBy: 'human',
      approvedAt: '2026-08-28T00:00:00.000Z',
      content: {
        type: 'decision',
        statement: 'Keep the interface focused.',
        rationale: 'A small surface is easier to learn.',
        status: 'active',
      },
      provenance,
    },
    {
      recordId: reuseRecordId,
      projectId,
      revision: 3,
      proposalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      approvedBy: 'human',
      approvedAt: '2026-08-28T00:00:00.000Z',
      content: {
        type: 'requirement',
        statement: 'Preserve completed tasks.',
        rationale: 'Users need durable progress.',
        kind: 'quality',
        status: 'approved',
        priority: 'must',
      },
      provenance,
    },
  ],
  relationships: [],
});

const awaitingApprovalCycle = planningCycleViewSchema.parse({
  ...baseCycle,
  cycle: {
    ...baseCycle.cycle,
    lifecycle: 'awaiting_approval',
    baseProjectIntentRevision: 1,
    baseLedgerRevision: 1,
    latestProposalRevision: 1,
  },
  turns: [
    ...baseCycle.turns,
    {
      id: '13131313-1313-4313-8313-131313131313',
      projectId,
      planningCycleId: cycleId,
      ordinal: 3,
      actor: 'human',
      message: 'Include offline use.',
      launchState: 'execution_bound',
      executionId: secondExecutionId,
      createdAt: '2026-08-29T00:00:02.000Z',
    },
    {
      id: '99999999-9999-4999-8999-999999999999',
      projectId,
      planningCycleId: cycleId,
      ordinal: 4,
      actor: 'pm',
      message: 'I have a complete proposal.',
      launchState: null,
      executionId: secondExecutionId,
      createdAt: '2026-08-29T00:00:03.000Z',
    },
  ],
  proposals: [
    {
      id: proposalId,
      projectId,
      planningCycleId: cycleId,
      revision: 1,
      lifecycle: 'awaiting_approval',
      baseProjectIntentRevision: 1,
      baseLedgerRevision: 1,
      summary: 'A focused individual Todo workflow.',
      projectIntent: {
        goal: 'Help people complete Todo items.',
        targetUsers: ['Individuals', 'Students'],
        desiredCapabilities: ['Add tasks', 'Complete tasks'],
        constraints: ['Works offline'],
        nonGoals: ['Team collaboration'],
        successConditions: ['A task can be completed'],
        rationale: 'Keep the first release small.',
        provenance,
      },
      records: [
        {
          operation: 'create',
          key: 'offline-capability',
          recordId: createRecordId,
          content: {
            type: 'requirement',
            statement: 'Add tasks while offline.',
            rationale: 'The app must work without a connection.',
            kind: 'functional',
            status: 'proposed',
            priority: 'must',
          },
          provenance,
        },
        {
          operation: 'revise',
          recordId: reviseRecordId,
          expectedRevision: 2,
          content: {
            type: 'decision',
            statement: 'Keep the offline interface focused.',
            rationale: 'The primary workflow should remain simple.',
            status: 'active',
          },
          provenance,
        },
        {
          operation: 'reuse',
          recordId: reuseRecordId,
          expectedRevision: 3,
        },
      ],
      relationships: [
        {
          kind: 'constrains',
          from: { recordId: reviseRecordId },
          to: { proposalKey: 'offline-capability' },
        },
        {
          kind: 'depends_on',
          from: { proposalKey: 'offline-capability' },
          to: { recordId: reuseRecordId },
        },
      ],
      diff: {
        intentChanges: [
          'goal',
          'targetUsers',
          'desiredCapabilities',
          'constraints',
          'nonGoals',
          'successConditions',
          'rationale',
          'provenance',
        ],
        recordChanges: { create: 1, revise: 1, reuse: 1 },
        relationshipChanges: {
          added: [
            {
              kind: 'constrains',
              from: { recordId: reviseRecordId },
              to: { proposalKey: 'offline-capability' },
            },
          ],
          removed: [
            {
              kind: 'refines',
              from: { proposalKey: 'offline-capability' },
              to: { recordId: reuseRecordId },
            },
          ],
        },
      },
      createdByTurnId: '99999999-9999-4999-8999-999999999999',
      createdByExecutionId: secondExecutionId,
      rejectionFeedback: null,
      createdAt: '2026-08-29T00:00:03.000Z',
      decidedAt: null,
    },
  ],
});

function renderPane(
  overrides: Partial<Parameters<typeof PlanningPane>[0]> = {},
) {
  const callbacks = {
    onSubmitTurn: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onAbandon: vi.fn(),
  };
  const result = render(
    <PlanningPane
      cycle={baseCycle}
      connection={{ status: 'ready' }}
      profiles={[profile]}
      submitting={false}
      {...callbacks}
      {...overrides}
    />,
  );
  return { ...callbacks, rerender: result.rerender };
}

describe('PlanningPane', () => {
  it('keeps sibling pane labels and relationships unique while preserving the default heading', () => {
    const terminalCycle: PlanningCycleView = {
      ...baseCycle,
      cycle: {
        ...baseCycle.cycle,
        lifecycle: 'approved',
        endedAt: '2026-08-29T00:00:02.000Z',
      },
    };
    const callbacks = {
      onSubmitTurn: vi.fn(),
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onAbandon: vi.fn(),
    };
    const { container } = render(
      <>
        <PlanningPane
          cycle={terminalCycle}
          connection={{ status: 'ready' }}
          profiles={[]}
          submitting={false}
          headingLabel="PM Chat history"
          {...callbacks}
        />
        <PlanningPane
          connection={{ status: 'ready' }}
          profiles={[profile]}
          submitting={false}
          {...callbacks}
        />
      </>,
    );

    expect(
      screen.getByRole('heading', { name: 'PM Chat history' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'PM Chat' })).toBeVisible();
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
  });

  it('starts discovery with an accessible profile selection and submits a human turn', async () => {
    const user = userEvent.setup();
    const { onSubmitTurn } = renderPane({ cycle: undefined });

    await user.selectOptions(
      screen.getByLabelText('Project manager profile'),
      profile.profileId,
    );
    await user.type(
      screen.getByLabelText('Message to project manager'),
      'Build a Todo app',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSubmitTurn).toHaveBeenCalledWith('Build a Todo app', {
      profileId: profile.profileId,
      profileRevision: 1,
    });
    expect(
      screen.getByRole('group', { name: 'Project manager profile' }),
    ).toBeVisible();
  });

  it('renders transcript questions and populates the draft from a choice without submitting', async () => {
    const user = userEvent.setup();
    const { onSubmitTurn } = renderPane();

    expect(
      screen.getByRole('list', { name: 'Planning conversation' }),
    ).toHaveTextContent('Build a useful Todo app.');
    expect(screen.getByText('Audience determines the workflow.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Individuals' }));

    expect(screen.getByLabelText('Message to project manager')).toHaveValue(
      'Individuals',
    );
    expect(onSubmitTurn).not.toHaveBeenCalled();
  });

  it('renders a complete proposal and delegates single approve, revision, and reject actions', async () => {
    const user = userEvent.setup();
    const { onApprove, onReject, onSubmitTurn } = renderPane({
      cycle: awaitingApprovalCycle,
      approvedIntentLedger,
    });

    expect(
      screen.getByText('A focused individual Todo workflow.'),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Goal, Target Users, Desired Capabilities, Constraints, Non Goals, Success Conditions, Rationale, Provenance',
      ),
    ).toBeVisible();
    expect(screen.getByText(/Create 1 .* revise 1 .* reuse 1/)).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Proposal provenance' }),
    ).toHaveTextContent('The operator asked for Todo.');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve proposal' }));
    await user.click(screen.getByRole('button', { name: 'Request revision' }));
    await user.type(
      screen.getByLabelText('Message to project manager'),
      'Clarify offline behavior',
    );
    await user.click(
      screen.getByRole('button', { name: 'Send revision request' }),
    );

    expect(onApprove).toHaveBeenCalledWith(proposalId);
    expect(onSubmitTurn).toHaveBeenCalledWith('Clarify offline behavior');
    expect(onReject).not.toHaveBeenCalled();
  });

  it('composes with strict branded proposal and cycle command handlers', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn<(id: PlanningProposal['id']) => void>();
    const onReject =
      vi.fn<(id: PlanningProposal['id'], feedback: string) => void>();
    const onAbandon = vi.fn<(id: PlanningCycleView['cycle']['id']) => void>();
    render(
      <PlanningPane
        cycle={awaitingApprovalCycle}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmitTurn={vi.fn()}
        onApprove={onApprove}
        onReject={onReject}
        onAbandon={onAbandon}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Approve proposal' }));
    await user.click(screen.getByRole('button', { name: 'Abandon cycle' }));
    expect(onApprove).toHaveBeenCalledWith(proposalId);
    expect(onAbandon).toHaveBeenCalledWith(cycleId);
  });

  it('renders every intent field and operation-specific record and relationship details', () => {
    renderPane({ cycle: awaitingApprovalCycle, approvedIntentLedger });

    const proposedIntent = screen.getByRole('region', {
      name: 'Proposed intent revision 1',
    });
    for (const value of [
      'Individuals',
      'Students',
      'Add tasks',
      'Complete tasks',
      'Works offline',
      'Team collaboration',
      'A task can be completed',
    ])
      expect(proposedIntent).toHaveTextContent(value);

    const proposedRecords = screen.getByRole('region', {
      name: 'Proposed records for revision 1',
    });
    for (const value of [
      'Create · offline-capability',
      'Add tasks while offline.',
      'Revise · expected revision 2',
      'Keep the offline interface focused.',
      'Reuse · approved revision 3',
      'Preserve completed tasks.',
    ])
      expect(proposedRecords).toHaveTextContent(value);

    const finalRelationships = screen.getByRole('region', {
      name: 'Proposed relationships for revision 1',
    });
    expect(finalRelationships).toHaveTextContent(
      `${reviseRecordId} · Decision · Keep the offline interface focused. constrains offline-capability · Requirement · Add tasks while offline.`,
    );
    expect(finalRelationships).toHaveTextContent(
      `offline-capability · Requirement · Add tasks while offline. depends on ${reuseRecordId} · Requirement · Preserve completed tasks.`,
    );
    expect(
      screen.getByRole('region', { name: 'Relationship diff' }),
    ).toHaveTextContent(
      `Removed: offline-capability · Requirement · Add tasks while offline. refines ${reuseRecordId} · Requirement · Preserve completed tasks.`,
    );
  });

  it('requires rejection feedback and forwards it with the proposal ID', async () => {
    const user = userEvent.setup();
    const { onReject } = renderPane({ cycle: awaitingApprovalCycle });
    await user.click(screen.getByRole('button', { name: 'Reject proposal' }));
    expect(
      screen.getByRole('button', { name: 'Confirm rejection' }),
    ).toBeDisabled();
    await user.type(
      screen.getByLabelText('Rejection feedback'),
      'Not sufficient for release.',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(onReject).toHaveBeenCalledWith(
      proposalId,
      'Not sufficient for release.',
    );
  });

  it('hides a requested revision form when the authoritative proposal is no longer awaiting approval', async () => {
    const user = userEvent.setup();
    const { rerender } = renderPane({ cycle: awaitingApprovalCycle });
    await user.click(screen.getByRole('button', { name: 'Request revision' }));
    expect(
      screen.getByRole('button', { name: 'Send revision request' }),
    ).toBeVisible();
    rerender(
      <PlanningPane
        cycle={{
          ...planningCycleViewSchema.parse({
            ...awaitingApprovalCycle,
            cycle: {
              ...awaitingApprovalCycle.cycle,
              lifecycle: 'launch_pending',
            },
            turns: [
              ...awaitingApprovalCycle.turns,
              {
                id: '14141414-1414-4414-8414-141414141414',
                projectId,
                planningCycleId: cycleId,
                ordinal: 5,
                actor: 'human',
                message: 'Clarify offline behavior.',
                launchState: 'launch_pending',
                executionId: null,
                createdAt: '2026-08-29T00:00:04.000Z',
              },
            ],
          }),
        }}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Send revision request' }),
    ).not.toBeInTheDocument();
  });

  it('uses a profile that arrives late in the same instance to submit the initial turn', async () => {
    const user = userEvent.setup();
    const { onSubmitTurn, rerender } = renderPane({
      cycle: undefined,
      profiles: [],
    });
    expect(
      screen.getByText('No project manager profiles are available.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    rerender(
      <PlanningPane
        cycle={undefined}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmitTurn={onSubmitTurn}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    await user.type(
      screen.getByLabelText('Message to project manager'),
      'Plan the Todo app',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSubmitTurn).toHaveBeenCalledWith('Plan the Todo app', {
      profileId: profile.profileId,
      profileRevision: 1,
    });
  });

  it('submits a human retry turn from retryable attention', async () => {
    const user = userEvent.setup();
    const attentionCycle = planningCycleViewSchema.parse({
      ...baseCycle,
      cycle: { ...baseCycle.cycle, lifecycle: 'attention_required' },
      questions: [],
    });
    const { onSubmitTurn } = renderPane({
      cycle: attentionCycle,
      recovery: {
        kind: 'retryable',
        message: 'The PM output was malformed.',
      },
    });
    await user.type(
      screen.getByLabelText('Message to project manager'),
      'Try the proposal again',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSubmitTurn).toHaveBeenCalledWith('Try the proposal again');
  });

  it('disables mutation actions for disconnected, stale, and submitting projections while retaining the reason', () => {
    const { rerender } = render(
      <PlanningPane
        cycle={awaitingApprovalCycle}
        connection={{ status: 'disconnected', message: 'Connection lost' }}
        profiles={[profile]}
        submitting={false}
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Approve proposal' }),
    ).toBeDisabled();
    expect(screen.getByText('Connection lost')).toBeVisible();

    rerender(
      <PlanningPane
        cycle={awaitingApprovalCycle}
        connection={{ status: 'stale', message: 'Refreshing planning state' }}
        profiles={[profile]}
        submitting={true}
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Reject proposal' }),
    ).toBeDisabled();
    expect(screen.getByText('Refreshing planning state')).toBeVisible();
  });

  it('returns focus to the PM heading for a live error', () => {
    const { rerender } = renderPane();

    rerender(
      <PlanningPane
        cycle={baseCycle}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        error="Planning command failed"
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'PM Chat' })).toHaveFocus();
  });

  it('preserves the draft when a command fails without a projection change', async () => {
    const user = userEvent.setup();
    const { rerender } = renderPane();
    await user.type(
      screen.getByLabelText('Message to project manager'),
      'Keep this draft',
    );

    rerender(
      <PlanningPane
        cycle={baseCycle}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        error="Planning command failed"
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Message to project manager')).toHaveValue(
      'Keep this draft',
    );
  });

  it('clears the draft when cycle identity, revision, or lifecycle changes', async () => {
    const user = userEvent.setup();
    const callbacks = {
      onSubmitTurn: vi.fn(),
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onAbandon: vi.fn(),
    };
    const { rerender } = renderPane(callbacks);
    const input = () => screen.getByLabelText('Message to project manager');

    await user.type(input(), 'Revision draft');
    const revisedCycle = planningCycleViewSchema.parse({
      ...baseCycle,
      cycle: { ...baseCycle.cycle, revision: baseCycle.cycle.revision + 1 },
    });
    rerender(
      <PlanningPane
        cycle={revisedCycle}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        {...callbacks}
      />,
    );
    expect(input()).toHaveValue('');

    await user.type(input(), 'Lifecycle draft');
    const attentionCycle = planningCycleViewSchema.parse({
      ...revisedCycle,
      cycle: { ...revisedCycle.cycle, lifecycle: 'attention_required' },
      questions: [],
    });
    rerender(
      <PlanningPane
        cycle={attentionCycle}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        recovery={{ kind: 'retryable', message: 'Retry planning.' }}
        {...callbacks}
      />,
    );
    expect(input()).toHaveValue('');

    await user.type(input(), 'Cycle identity draft');
    const nextCycleId = '15151515-1515-4515-8515-151515151515';
    const nextCycle = planningCycleViewSchema.parse({
      ...attentionCycle,
      cycle: { ...attentionCycle.cycle, id: nextCycleId },
      turns: attentionCycle.turns.map((turn) => ({
        ...turn,
        planningCycleId: nextCycleId,
      })),
      questions: attentionCycle.questions.map((question) => ({
        ...question,
        planningCycleId: nextCycleId,
      })),
    });
    rerender(
      <PlanningPane
        cycle={nextCycle}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        recovery={{ kind: 'retryable', message: 'Retry planning.' }}
        {...callbacks}
      />,
    );
    expect(input()).toHaveValue('');
  });

  it('clears the draft when the latest turn identity or launch state changes', async () => {
    const user = userEvent.setup();
    const callbacks = {
      onSubmitTurn: vi.fn(),
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onAbandon: vi.fn(),
    };
    const attentionCycle = planningCycleViewSchema.parse({
      ...baseCycle,
      cycle: { ...baseCycle.cycle, lifecycle: 'attention_required' },
      questions: [],
    });
    const { rerender } = renderPane({
      cycle: attentionCycle,
      recovery: { kind: 'retryable', message: 'Retry planning.' },
      ...callbacks,
    });
    const input = () => screen.getByLabelText('Message to project manager');

    await user.type(input(), 'Turn identity draft');
    const latestHumanTurn = {
      id: '16161616-1616-4616-8616-161616161616',
      projectId,
      planningCycleId: cycleId,
      ordinal: 3,
      actor: 'human',
      message: 'Retry the plan.',
      launchState: 'launch_pending',
      executionId: null,
      createdAt: '2026-08-29T00:00:04.000Z',
    } as const;
    const pendingTurnCycle = planningCycleViewSchema.parse({
      ...attentionCycle,
      turns: [...attentionCycle.turns, latestHumanTurn],
    });
    rerender(
      <PlanningPane
        cycle={pendingTurnCycle}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        recovery={{ kind: 'retryable', message: 'Retry planning.' }}
        {...callbacks}
      />,
    );
    expect(input()).toHaveValue('');

    await user.type(input(), 'Turn state draft');
    const boundTurnCycle = planningCycleViewSchema.parse({
      ...pendingTurnCycle,
      turns: [
        ...pendingTurnCycle.turns.slice(0, -1),
        {
          ...latestHumanTurn,
          launchState: 'execution_bound',
          executionId: secondExecutionId,
        },
      ],
    });
    rerender(
      <PlanningPane
        cycle={boundTurnCycle}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        recovery={{ kind: 'retryable', message: 'Retry planning.' }}
        {...callbacks}
      />,
    );
    expect(input()).toHaveValue('');
  });

  it('renders ambiguous operation evidence with abandon as the only available action', async () => {
    const user = userEvent.setup();
    const attentionCycle = planningCycleViewSchema.parse({
      ...baseCycle,
      cycle: { ...baseCycle.cycle, lifecycle: 'attention_required' },
      questions: [],
    });
    const { onAbandon } = renderPane({
      cycle: attentionCycle,
      recovery: { kind: 'ambiguous_start', operation: 'operation-123' },
    });
    expect(screen.getByText('Operation operation-123')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Send message' }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Abandon cycle' }));
    expect(onAbandon).toHaveBeenCalledWith(cycleId);
  });

  it('renders history-limit guidance separately and permits abandonment', () => {
    renderPane({ historyLimitReached: true });
    expect(
      screen.getByText(
        'This cycle reached its history limit. Abandon it to begin a new cycle.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Abandon cycle' })).toBeEnabled();
  });

  it('projects pending, active, attention, and terminal lifecycle guidance without local authority', () => {
    const { rerender } = renderPane({
      cycle: planningCycleViewSchema.parse({
        ...baseCycle,
        cycle: { ...baseCycle.cycle, lifecycle: 'launch_pending' },
        turns: [
          {
            ...baseCycle.turns[0],
            launchState: 'launch_pending',
            executionId: null,
          },
        ],
        questions: [],
      }),
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Starting project manager…',
    );
    expect(
      screen.queryByRole('button', { name: 'Send message' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abandon cycle' })).toBeEnabled();

    rerender(
      <PlanningPane
        cycle={planningCycleViewSchema.parse({
          ...baseCycle,
          cycle: {
            ...baseCycle.cycle,
            lifecycle: 'execution_active',
            activeExecutionId: executionId,
          },
          turns: [baseCycle.turns[0]],
          questions: [],
        })}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Project manager is working',
    );

    rerender(
      <PlanningPane
        cycle={planningCycleViewSchema.parse({
          ...baseCycle,
          cycle: { ...baseCycle.cycle, lifecycle: 'attention_required' },
          questions: [],
        })}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        error="Execution e-1; operation o-1"
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Mesh did not retry the execution after restart.'),
    ).toBeVisible();
    expect(
      screen.getByText('Abandon this cycle to start a new one.'),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Execution e-1; operation o-1',
    );

    rerender(
      <PlanningPane
        cycle={planningCycleViewSchema.parse({
          ...awaitingApprovalCycle,
          cycle: {
            ...awaitingApprovalCycle.cycle,
            lifecycle: 'approved',
            endedAt: '2026-08-29T00:00:03.000Z',
          },
          proposals: [
            {
              ...awaitingApprovalCycle.proposals[0],
              lifecycle: 'approved',
              decidedAt: '2026-08-29T00:00:03.000Z',
            },
          ],
        })}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(screen.getByText('Proposal approved.')).toBeVisible();

    rerender(
      <PlanningPane
        cycle={planningCycleViewSchema.parse({
          ...awaitingApprovalCycle,
          cycle: {
            ...awaitingApprovalCycle.cycle,
            lifecycle: 'proposal_rejected',
            endedAt: '2026-08-29T00:00:03.000Z',
          },
          proposals: [
            {
              ...awaitingApprovalCycle.proposals[0],
              lifecycle: 'rejected',
              rejectionFeedback: 'Not now.',
              decidedAt: '2026-08-29T00:00:03.000Z',
            },
          ],
        })}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(screen.getByText('Proposal rejected.')).toBeVisible();

    rerender(
      <PlanningPane
        cycle={planningCycleViewSchema.parse({
          ...baseCycle,
          cycle: {
            ...baseCycle.cycle,
            lifecycle: 'abandoned',
            endedAt: '2026-08-29T00:00:03.000Z',
          },
        })}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        historyTruncated
        onSubmitTurn={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Planning snapshot history is truncated.'),
    ).toBeVisible();
    expect(
      screen.getByText('This planning cycle was abandoned.'),
    ).toBeVisible();
  });
});

const deliveryCycle = deliveryPlanPlanningCycleViewSchema.parse({
  cycle: {
    ...baseCycle.cycle,
    lifecycle: 'awaiting_approval',
    baseProjectIntentRevision: 1,
    baseLedgerRevision: 1,
    latestProposalRevision: 1,
  },
  purpose: {
    kind: 'delivery_plan',
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
  turns: baseCycle.turns,
  questions: [],
  proposals: [],
  deliveryPlanProposals: [
    {
      id: proposalId,
      projectId,
      planningCycleId: cycleId,
      revision: 1,
      lifecycle: 'awaiting_approval',
      base: {
        projectIntentId: approvedIntentLedger.projectIntent.id,
        projectIntentRevision: 1,
        ledgerId: approvedIntentLedger.ledger.id,
        ledgerRevision: 1,
        deliveryPlan: { id: null, revision: null },
      },
      proposedPlan: {
        summary: 'Deliver Todo across two milestones.',
        milestones: [
          {
            operation: 'create',
            key: 'foundation',
            content: {
              title: 'Foundation',
              outcome: 'Todo data is durable.',
              stopCondition: 'Refresh preserves Todo items.',
              exclusions: ['Execution automation'],
              ordinal: 1,
            },
          },
          {
            operation: 'create',
            key: 'experience',
            content: {
              title: 'Experience',
              outcome: 'Todo work is usable.',
              stopCondition: 'Operators can complete a task.',
              exclusions: [],
              ordinal: 2,
            },
          },
        ],
        tasks: [
          {
            operation: 'create',
            key: 'persist-todo',
            content: {
              milestone: { kind: 'proposal', key: 'foundation' },
              title: 'Persist Todo',
              outcome: 'Todo state survives refresh.',
              acceptanceCriteria: ['Todo items are durable.'],
              verificationCriteria: ['Refresh the built app.'],
              priority: 'must',
              labels: ['backend'],
              ownedSurfaces: ['Todo persistence'],
              prohibitedSurfaces: ['Execution runtime'],
              expectedArtifacts: ['Persistence tests'],
              ordinal: 1,
            },
          },
          {
            operation: 'create',
            key: 'show-todo',
            content: {
              milestone: { kind: 'proposal', key: 'experience' },
              title: 'Show Todo',
              outcome: 'Todo items are visible.',
              acceptanceCriteria: ['Todo items appear.'],
              verificationCriteria: ['Render the Todo list.'],
              priority: 'should',
              labels: ['web'],
              ownedSurfaces: ['Todo view'],
              prohibitedSurfaces: ['Execution runtime'],
              expectedArtifacts: ['View tests'],
              ordinal: 1,
            },
          },
        ],
        dependencies: [
          {
            operation: 'create',
            key: 'foundation-before-experience',
            prerequisite: { kind: 'proposal', key: 'persist-todo' },
            dependent: { kind: 'proposal', key: 'show-todo' },
          },
        ],
        traces: [
          {
            kind: 'milestone_covers',
            milestone: { kind: 'proposal', key: 'foundation' },
            requirement: { recordId: reuseRecordId, recordRevision: 3 },
          },
          {
            kind: 'task_satisfies',
            task: { kind: 'proposal', key: 'persist-todo' },
            requirement: { recordId: reuseRecordId, recordRevision: 3 },
          },
          {
            kind: 'milestone_covers',
            milestone: { kind: 'proposal', key: 'experience' },
            requirement: { recordId: reuseRecordId, recordRevision: 3 },
          },
          {
            kind: 'task_satisfies',
            task: { kind: 'proposal', key: 'show-todo' },
            requirement: { recordId: reuseRecordId, recordRevision: 3 },
          },
        ],
      },
      reservations: {
        milestones: [
          {
            key: 'foundation',
            id: '20202020-2020-4020-8020-202020202020',
          },
          {
            key: 'experience',
            id: '21212121-2121-4121-8121-212121212121',
          },
        ],
        tasks: [
          {
            key: 'persist-todo',
            id: '22222222-2222-4222-8222-222222222223',
          },
          {
            key: 'show-todo',
            id: '23232323-2323-4323-8323-232323232323',
          },
        ],
        dependencies: [
          {
            key: 'foundation-before-experience',
            id: '24242424-2424-4424-8424-242424242424',
          },
        ],
      },
      diff: {
        milestones: {
          create: 2,
          reuse: 0,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        tasks: { create: 2, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
        dependencies: {
          create: 1,
          reuse: 0,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        traceCreateCount: 4,
        traceRemoveCount: 0,
      },
      createdByTurnId: '77777777-7777-4777-8777-777777777777',
      createdByExecutionId: executionId,
      createdAt: '2026-08-30T00:00:02.000Z',
      decision: { kind: 'pending' },
    },
  ],
});

const approvedPlanId = 'abababab-abab-4bab-8bab-abababababab';
const approvedMilestoneIds = [
  '12121212-1212-4212-8212-121212121212',
  '13131313-1313-4313-8313-131313131313',
] as const;
const approvedTaskIds = [
  '14141414-1414-4414-8414-141414141414',
  '15151515-1515-4515-8515-151515151515',
] as const;
const approvedDependencyId = '25252525-2525-4525-8525-252525252525';
const approvedPlanProposalId = '26262626-2626-4626-8626-262626262626';
const approvedDeliveryPlan = approvedDeliveryPlanSchema.parse({
  plan: {
    id: approvedPlanId,
    projectId,
    revision: 2,
    projectIntentId: approvedIntentLedger.projectIntent.id,
    projectIntentRevision: 1,
    ledgerId: approvedIntentLedger.ledger.id,
    ledgerRevision: 1,
    baseDeliveryPlanRevision: 1,
    proposalId: approvedPlanProposalId,
    summary: 'Existing Todo delivery plan.',
    approvedBy: 'human',
    approvedAt: '2026-08-29T23:00:00.000Z',
  },
  milestones: [
    {
      id: approvedMilestoneIds[0],
      projectId,
      revision: 3,
      lifecycle: 'active',
      title: 'Existing Foundation',
      outcome: 'Existing data remains durable.',
      stopCondition: 'Existing persistence checks pass.',
      exclusions: ['Execution automation'],
      ordinal: 1,
      proposalId: approvedPlanProposalId,
      deliveryPlanRevision: 2,
      approvedAt: '2026-08-29T23:00:00.000Z',
    },
    {
      id: approvedMilestoneIds[1],
      projectId,
      revision: 4,
      lifecycle: 'active',
      title: 'Existing Experience',
      outcome: 'Existing Todo work remains usable.',
      stopCondition: 'Existing interaction checks pass.',
      exclusions: ['Collaboration'],
      ordinal: 2,
      proposalId: approvedPlanProposalId,
      deliveryPlanRevision: 2,
      approvedAt: '2026-08-29T23:00:00.000Z',
    },
  ],
  taskContracts: [
    {
      id: approvedTaskIds[0],
      projectId,
      revision: 5,
      contractRevision: 5,
      revisionKind: 'plan_contract',
      lifecycle: 'pending',
      milestoneId: approvedMilestoneIds[0],
      title: 'Existing Persistence',
      outcome: 'Existing Todo state survives refresh.',
      acceptanceCriteria: ['Existing Todo items are durable.'],
      verificationCriteria: ['Run existing persistence checks.'],
      priority: 'must',
      labels: ['backend'],
      ownedSurfaces: ['Todo persistence'],
      prohibitedSurfaces: ['Execution runtime'],
      expectedArtifacts: ['Persistence tests'],
      ordinal: 1,
      source: {
        kind: 'plan',
        proposalId: approvedPlanProposalId,
        deliveryPlanRevision: 2,
      },
      createdAt: '2026-08-29T23:00:00.000Z',
    },
    {
      id: approvedTaskIds[1],
      projectId,
      revision: 6,
      contractRevision: 6,
      revisionKind: 'plan_contract',
      lifecycle: 'pending',
      milestoneId: approvedMilestoneIds[1],
      title: 'Existing Interface',
      outcome: 'Existing Todo items remain visible.',
      acceptanceCriteria: ['Existing Todo items appear.'],
      verificationCriteria: ['Run existing interface checks.'],
      priority: 'should',
      labels: ['web'],
      ownedSurfaces: ['Todo view'],
      prohibitedSurfaces: ['Execution runtime'],
      expectedArtifacts: ['View tests'],
      ordinal: 1,
      source: {
        kind: 'plan',
        proposalId: approvedPlanProposalId,
        deliveryPlanRevision: 2,
      },
      createdAt: '2026-08-29T23:00:00.000Z',
    },
  ],
  dependencies: [
    {
      id: approvedDependencyId,
      projectId,
      revision: 7,
      prerequisiteTaskId: approvedTaskIds[0],
      dependentTaskId: approvedTaskIds[1],
      lifecycle: 'active',
      proposalId: approvedPlanProposalId,
      deliveryPlanRevision: 2,
      approvedAt: '2026-08-29T23:00:00.000Z',
    },
  ],
  traces: [
    ...approvedMilestoneIds.map((milestoneId, index) => ({
      kind: 'milestone_covers' as const,
      milestoneId,
      milestoneRevision: index === 0 ? 3 : 4,
      requirement: { recordId: reuseRecordId, recordRevision: 3 },
    })),
    ...approvedTaskIds.map((taskId, index) => ({
      kind: 'task_satisfies' as const,
      taskId,
      taskContractRevision: index === 0 ? 5 : 6,
      requirement: { recordId: reuseRecordId, recordRevision: 3 },
    })),
  ],
  milestoneDependencies: [
    {
      prerequisiteMilestoneId: approvedMilestoneIds[0],
      dependentMilestoneId: approvedMilestoneIds[1],
      throughTaskDependencyIds: [approvedDependencyId],
    },
  ],
});

describe('DeliveryPlanningPane', () => {
  it('keeps terminal history inspectable while starting an exact current-base replan', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const terminalCycle = deliveryPlanPlanningCycleViewSchema.parse({
      ...deliveryCycle,
      cycle: {
        ...deliveryCycle.cycle,
        lifecycle: 'approved',
        endedAt: '2026-08-30T00:00:04.000Z',
      },
      deliveryPlanProposals: [
        {
          ...deliveryCycle.deliveryPlanProposals[0],
          lifecycle: 'approved',
          decision: {
            kind: 'approved',
            decidedBy: 'human',
            decidedAt: '2026-08-30T00:00:04.000Z',
          },
        },
      ],
    });

    render(
      <DeliveryPlanningPane
        projectId={projectId}
        cycle={terminalCycle}
        approvedIntentLedger={approvedIntentLedger}
        deliveryPlan={approvedDeliveryPlan}
        planStale
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmit={onSubmit}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.getByText(/Proposal revision 1 · Approved/)).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Replan current requirements' }),
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCycleRevision: null,
        expectedProjectIntentId: approvedIntentLedger.projectIntent.id,
        expectedProjectIntentRevision:
          approvedIntentLedger.projectIntent.revision,
        expectedLedgerId: approvedIntentLedger.ledger.id,
        expectedLedgerRevision: approvedIntentLedger.ledger.revision,
        expectedDeliveryPlan: { id: approvedPlanId, revision: 2 },
      }),
    );
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('planningCycleId');
  });

  it('explains proposal replacement and cycle-abandonment supersession', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const successorId = '16161616-1616-4616-8616-161616161616';
    const replacementHistory = deliveryPlanPlanningCycleViewSchema.parse({
      ...deliveryCycle,
      cycle: { ...deliveryCycle.cycle, latestProposalRevision: 2 },
      deliveryPlanProposals: [
        {
          ...deliveryCycle.deliveryPlanProposals[0],
          lifecycle: 'superseded',
          decision: {
            kind: 'superseded',
            reason: 'replacement_accepted',
            supersededByProposalId: successorId,
            decidedAt: '2026-08-30T00:00:03.000Z',
          },
        },
        {
          ...deliveryCycle.deliveryPlanProposals[0],
          id: successorId,
          revision: 2,
          createdAt: '2026-08-30T00:00:03.000Z',
        },
      ],
    });
    const props = {
      projectId,
      approvedIntentLedger,
      deliveryPlan: null,
      planStale: false,
      connection: { status: 'ready' } as const,
      profiles: [profile],
      submitting: false,
      onSubmit: vi.fn(),
      onApprove,
      onReject: vi.fn(),
      onAbandon: vi.fn(),
    };
    const { rerender } = render(
      <DeliveryPlanningPane {...props} cycle={replacementHistory} />,
    );

    await user.selectOptions(screen.getByLabelText('Proposal revision'), '1');
    expect(
      screen.getByText('Superseded by proposal revision 2.'),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Viewing historical proposal revision 1. Select proposal revision 2 to make a decision.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Approve full plan' }),
    ).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Proposal revision'), '2');
    expect(
      screen.getByText('Decision controls apply to proposal revision 2.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve full plan' }));
    expect(onApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: successorId,
        expectedProposalRevision: 2,
      }),
    );

    const abandonedHistory = deliveryPlanPlanningCycleViewSchema.parse({
      ...deliveryCycle,
      cycle: {
        ...deliveryCycle.cycle,
        lifecycle: 'abandoned',
        endedAt: '2026-08-30T00:00:04.000Z',
      },
      deliveryPlanProposals: [
        {
          ...deliveryCycle.deliveryPlanProposals[0],
          lifecycle: 'superseded',
          decision: {
            kind: 'superseded',
            reason: 'cycle_abandoned',
            supersededByProposalId: null,
            decidedAt: '2026-08-30T00:00:04.000Z',
          },
        },
      ],
    });
    rerender(<DeliveryPlanningPane {...props} cycle={abandonedHistory} />);
    expect(
      screen.getByText('Superseded because this planning cycle was abandoned.'),
    ).toBeVisible();
  });

  it('resolves reused approved members and groups complete tasks under milestones in proposal order', () => {
    const reuseCycle = deliveryPlanPlanningCycleViewSchema.parse({
      ...deliveryCycle,
      purpose: {
        kind: 'delivery_plan',
        baseDeliveryPlanId: approvedPlanId,
        baseDeliveryPlanRevision: 2,
      },
      deliveryPlanProposals: [
        {
          ...deliveryCycle.deliveryPlanProposals[0],
          base: {
            ...deliveryCycle.deliveryPlanProposals[0].base,
            deliveryPlan: { id: approvedPlanId, revision: 2 },
          },
          proposedPlan: {
            ...deliveryCycle.deliveryPlanProposals[0].proposedPlan,
            milestones: [
              {
                operation: 'reuse',
                milestoneId: approvedMilestoneIds[1],
                expectedRevision: 4,
              },
              {
                operation: 'reuse',
                milestoneId: approvedMilestoneIds[0],
                expectedRevision: 3,
              },
            ],
            tasks: [
              {
                operation: 'reuse',
                taskId: approvedTaskIds[0],
                expectedContractRevision: 5,
                expectedCurrentRevision: 5,
              },
              {
                operation: 'reuse',
                taskId: approvedTaskIds[1],
                expectedContractRevision: 6,
                expectedCurrentRevision: 6,
              },
            ],
            dependencies: [
              {
                operation: 'reuse',
                dependencyId: approvedDependencyId,
                expectedRevision: 7,
              },
            ],
            traces: [
              ...approvedMilestoneIds.map((milestoneId) => ({
                kind: 'milestone_covers' as const,
                milestone: { kind: 'canonical' as const, milestoneId },
                requirement: {
                  recordId: reuseRecordId,
                  recordRevision: 3,
                },
              })),
              ...approvedTaskIds.map((taskId) => ({
                kind: 'task_satisfies' as const,
                task: { kind: 'canonical' as const, taskId },
                requirement: {
                  recordId: reuseRecordId,
                  recordRevision: 3,
                },
              })),
            ],
          },
          reservations: { milestones: [], tasks: [], dependencies: [] },
          diff: {
            milestones: {
              create: 0,
              reuse: 2,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            tasks: {
              create: 0,
              reuse: 2,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            dependencies: {
              create: 0,
              reuse: 1,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            traceCreateCount: 0,
            traceRemoveCount: 0,
          },
        },
      ],
    });

    const { rerender } = render(
      <DeliveryPlanningPane
        projectId={projectId}
        cycle={reuseCycle}
        approvedIntentLedger={approvedIntentLedger}
        deliveryPlan={approvedDeliveryPlan}
        planStale={false}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmit={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    const milestones = screen.getAllByRole('listitem', {
      name: /Existing (Experience|Foundation)/,
    });
    expect(milestones[0]).toHaveAccessibleName(/Existing Experience/);
    expect(milestones[1]).toHaveAccessibleName(/Existing Foundation/);
    expect(within(milestones[0]).getByText('Existing Interface')).toBeVisible();
    expect(
      within(milestones[0]).getByText(
        'Acceptance: Existing Todo items appear.',
      ),
    ).toBeVisible();
    expect(
      within(milestones[0]).getByText(
        'Verification: Run existing interface checks.',
      ),
    ).toBeVisible();
    expect(
      within(milestones[0]).getByText(
        'Stop condition: Existing interaction checks pass.',
      ),
    ).toBeVisible();
    expect(
      within(milestones[1]).getByText('Existing Persistence'),
    ).toBeVisible();
    expect(
      screen.getByText(
        `Reuse ${approvedDependencyId} · expected revision 7 · Existing Persistence (${approvedTaskIds[0]}) → Existing Interface (${approvedTaskIds[1]})`,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        `Intent ${approvedIntentLedger.projectIntent.id} · revision 1 · requirement ledger ${approvedIntentLedger.ledger.id} · revision 1 · delivery plan ${approvedPlanId} · revision 2`,
      ),
    ).toBeVisible();

    const reviseCycle = deliveryPlanPlanningCycleViewSchema.parse({
      ...reuseCycle,
      deliveryPlanProposals: [
        {
          ...reuseCycle.deliveryPlanProposals[0],
          proposedPlan: {
            ...reuseCycle.deliveryPlanProposals[0].proposedPlan,
            dependencies: [
              {
                operation: 'revise',
                dependencyId: approvedDependencyId,
                expectedRevision: 7,
                lifecycle: 'active',
              },
            ],
          },
          diff: {
            ...reuseCycle.deliveryPlanProposals[0].diff,
            dependencies: {
              create: 0,
              reuse: 0,
              revise: 1,
              retire: 0,
              reactivate: 0,
            },
          },
        },
      ],
    });
    rerender(
      <DeliveryPlanningPane
        projectId={projectId}
        cycle={reviseCycle}
        approvedIntentLedger={approvedIntentLedger}
        deliveryPlan={approvedDeliveryPlan}
        planStale={false}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmit={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        `Revise ${approvedDependencyId} · expected revision 7 · active · Existing Persistence (${approvedTaskIds[0]}) → Existing Interface (${approvedTaskIds[1]})`,
      ),
    ).toBeVisible();
  });

  it('focuses the action-specific control when a planning command fails', async () => {
    const user = userEvent.setup();
    const props = {
      projectId,
      cycle: deliveryCycle,
      approvedIntentLedger,
      deliveryPlan: null,
      planStale: false,
      connection: { status: 'ready' } as const,
      profiles: [profile],
      submitting: false,
      onSubmit: vi.fn(),
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onAbandon: vi.fn(),
    };
    const { rerender, unmount } = render(<DeliveryPlanningPane {...props} />);
    rerender(<DeliveryPlanningPane {...props} error="Approval conflict" />);
    expect(screen.getByText('Approval conflict')).toHaveAttribute(
      'aria-live',
      'assertive',
    );
    expect(
      screen.getByRole('heading', { name: /Proposal revision 1/ }),
    ).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Reject proposal' }));
    rerender(<DeliveryPlanningPane {...props} error="Rejection conflict" />);
    expect(screen.getByLabelText('Rejection feedback')).toHaveFocus();
    unmount();

    const second = render(<DeliveryPlanningPane {...props} />);
    await user.click(screen.getByRole('button', { name: 'Request revision' }));
    second.rerender(
      <DeliveryPlanningPane {...props} error="Revision conflict" />,
    );
    expect(screen.getByLabelText('Message to project manager')).toHaveFocus();
  });

  it('gates and submits a new delivery planning cycle with exact frozen bases', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <DeliveryPlanningPane
        projectId={projectId}
        approvedIntentLedger={approvedIntentLedger}
        deliveryPlan={null}
        planStale={false}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmit={onSubmit}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Plan delivery' }));
    expect(screen.getByLabelText('Message to project manager')).toHaveValue(
      'Propose a delivery plan for the approved intent and requirement ledger.',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'planning_cycle.submit_plan_turn',
      projectId,
      expectedCycleRevision: null,
      profileId: profile.profileId,
      profileRevision: 1,
      expectedProjectIntentId: approvedIntentLedger.projectIntent.id,
      expectedProjectIntentRevision: 1,
      expectedLedgerId: approvedIntentLedger.ledger.id,
      expectedLedgerRevision: 1,
      expectedDeliveryPlan: { id: null, revision: null },
      message:
        'Propose a delivery plan for the approved intent and requirement ledger.',
    });
  });

  it('closes a pending cycle form and gates messages while PM execution starts', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const props = {
      projectId,
      approvedIntentLedger,
      deliveryPlan: null,
      planStale: false,
      connection: { status: 'ready' } as const,
      profiles: [profile],
      submitting: false,
      onSubmit,
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onAbandon: vi.fn(),
    };
    const { rerender } = render(<DeliveryPlanningPane {...props} />);

    await user.click(screen.getByRole('button', { name: 'Plan delivery' }));
    expect(screen.getByLabelText('Message to project manager')).toBeVisible();

    const launchPending = deliveryPlanPlanningCycleViewSchema.parse({
      ...deliveryCycle,
      cycle: {
        ...deliveryCycle.cycle,
        lifecycle: 'launch_pending',
        latestProposalRevision: 0,
      },
      turns: [
        {
          id: turnId,
          projectId,
          planningCycleId: cycleId,
          ordinal: 1,
          actor: 'human',
          message: 'Propose the delivery plan.',
          launchState: 'launch_pending',
          executionId: null,
          createdAt: '2026-08-30T00:00:01.000Z',
        },
      ],
      deliveryPlanProposals: [],
    });
    rerender(<DeliveryPlanningPane {...props} cycle={launchPending} />);
    expect(
      screen.queryByLabelText('Message to project manager'),
    ).not.toBeInTheDocument();

    rerender(
      <DeliveryPlanningPane
        {...props}
        cycle={deliveryPlanPlanningCycleViewSchema.parse({
          ...launchPending,
          cycle: {
            ...launchPending.cycle,
            lifecycle: 'execution_active',
            activeExecutionId: executionId,
          },
          turns: [
            {
              ...launchPending.turns[0],
              launchState: 'execution_bound',
              executionId,
            },
          ],
        })}
      />,
    );
    expect(
      screen.queryByLabelText('Message to project manager'),
    ).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('explains requirements and profile gates', () => {
    render(
      <DeliveryPlanningPane
        projectId={projectId}
        approvedIntentLedger={{ ...approvedIntentLedger, records: [] }}
        deliveryPlan={null}
        planStale={false}
        connection={{ status: 'ready' }}
        profiles={[]}
        submitting={false}
        onSubmit={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'Approve at least one current requirement before planning delivery.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('No compatible PM profiles are available.'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Plan delivery' }),
    ).toBeDisabled();
  });

  it('submits a replacement against the exact approved plan base', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const planId = 'abababab-abab-4bab-8bab-abababababab';
    render(
      <DeliveryPlanningPane
        projectId={projectId}
        approvedIntentLedger={approvedIntentLedger}
        deliveryPlan={{
          ...approvedDeliveryPlan,
          plan: { ...approvedDeliveryPlan.plan, id: planId, revision: 2 },
        }}
        planStale={false}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmit={onSubmit}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Approved delivery plan revision 2 · current'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Replace plan' }));
    expect(screen.getByLabelText('Message to project manager')).toHaveValue(
      'Revise the approved delivery plan against the current intent and requirement ledger.',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDeliveryPlan: { id: planId, revision: 2 },
      }),
    );
  });

  it('renders the complete proposal and emits atomic approval or feedback commands', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onAbandon = vi.fn();
    const onSubmit = vi.fn();
    render(
      <DeliveryPlanningPane
        projectId={projectId}
        cycle={deliveryCycle}
        approvedIntentLedger={approvedIntentLedger}
        deliveryPlan={null}
        planStale={false}
        connection={{ status: 'ready' }}
        profiles={[profile]}
        submitting={false}
        onSubmit={onSubmit}
        onApprove={onApprove}
        onReject={onReject}
        onAbandon={onAbandon}
      />,
    );

    expect(
      screen.getByText(/Proposal revision 1 · Awaiting approval/),
    ).toBeVisible();
    expect(screen.getByLabelText('Proposal revision')).toHaveValue('1');
    expect(screen.getByText('Foundation')).toBeVisible();
    expect(screen.getByText('Persist Todo')).toBeVisible();
    expect(
      screen.getByText(
        `Intent ${approvedIntentLedger.projectIntent.id} · revision 1 · requirement ledger ${approvedIntentLedger.ledger.id} · revision 1 · delivery plan not yet approved`,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'foundation-before-experience: Persist Todo (persist-todo) → Show Todo (show-todo)',
      ),
    ).toBeVisible();
    expect(screen.getAllByText(new RegExp(reuseRecordId))).toHaveLength(4);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve full plan' }));
    expect(onApprove).toHaveBeenCalledWith({
      type: 'plan_proposal.approve',
      projectId,
      planningCycleId: cycleId,
      expectedCycleRevision: 3,
      proposalId,
      expectedProposalRevision: 1,
      expectedProjectIntentId: approvedIntentLedger.projectIntent.id,
      expectedProjectIntentRevision: 1,
      expectedLedgerId: approvedIntentLedger.ledger.id,
      expectedLedgerRevision: 1,
      expectedDeliveryPlan: { id: null, revision: null },
    });

    await user.click(screen.getByRole('button', { name: 'Request revision' }));
    await user.type(
      screen.getByLabelText('Message to project manager'),
      'Split the experience milestone.',
    );
    await user.click(
      screen.getByRole('button', { name: 'Send revision request' }),
    );
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'planning_cycle.submit_plan_turn',
      projectId,
      planningCycleId: cycleId,
      expectedCycleRevision: 3,
      message: 'Split the experience milestone.',
    });

    await user.click(screen.getByRole('button', { name: 'Reject proposal' }));
    expect(screen.getByLabelText('Rejection feedback')).toHaveAttribute(
      'maxLength',
      '4096',
    );
    fireEvent.change(screen.getByLabelText('Rejection feedback'), {
      target: { value: 'x'.repeat(4097) },
    });
    expect(
      screen.getByRole('button', { name: 'Confirm rejection' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(onReject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Rejection feedback'), {
      target: { value: 'Split the second milestone.' },
    });
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(onReject).toHaveBeenCalledWith({
      type: 'plan_proposal.reject',
      projectId,
      planningCycleId: cycleId,
      expectedCycleRevision: 3,
      proposalId,
      expectedProposalRevision: 1,
      feedback: 'Split the second milestone.',
    });

    await user.click(screen.getByRole('button', { name: 'Abandon cycle' }));
    expect(onAbandon).toHaveBeenCalledWith({
      type: 'planning_cycle.abandon',
      projectId,
      planningCycleId: cycleId,
      expectedCycleRevision: 3,
    });
  });
});
