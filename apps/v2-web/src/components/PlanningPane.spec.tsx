import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  approvedIntentLedgerSchema,
  planningCycleViewSchema,
  workerProfileSummarySchema,
} from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { PlanningPane } from './PlanningPane';

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
