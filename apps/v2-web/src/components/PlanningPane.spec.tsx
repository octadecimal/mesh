import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  PlanningCycleView,
  WorkerProfileSummary,
} from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { PlanningPane } from './PlanningPane';

const projectId = '11111111-1111-4111-8111-111111111111';
const cycleId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const turnId = '44444444-4444-4444-8444-444444444444';
const executionId = '55555555-5555-4555-8555-555555555555';

const profile = {
  profileId: '66666666-6666-4666-8666-666666666666',
  projectId: null,
  scope: 'global',
  name: 'todo-pm',
  displayName: 'Todo PM',
  approvedRevision: 1,
} as WorkerProfileSummary;

const baseCycle = {
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
      id: '88888888-8888-4888-888888888888',
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
} as PlanningCycleView;

const awaitingApprovalCycle = {
  ...baseCycle,
  cycle: {
    ...baseCycle.cycle,
    lifecycle: 'awaiting_approval',
    latestProposalRevision: 1,
  },
  turns: [
    ...baseCycle.turns,
    {
      id: '99999999-9999-4999-8999-999999999999',
      projectId,
      planningCycleId: cycleId,
      ordinal: 3,
      actor: 'pm',
      message: 'I have a complete proposal.',
      launchState: null,
      executionId,
      createdAt: '2026-08-29T00:00:02.000Z',
    },
  ],
  proposals: [
    {
      id: proposalId,
      projectId,
      planningCycleId: cycleId,
      revision: 1,
      lifecycle: 'awaiting_approval',
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      summary: 'A focused individual Todo workflow.',
      projectIntent: {
        goal: 'Help people complete Todo items.',
        targetUsers: ['Individuals'],
        desiredCapabilities: ['Add tasks'],
        constraints: [],
        nonGoals: ['Team collaboration'],
        successConditions: ['A task can be completed'],
        rationale: 'Keep the first release small.',
        provenance: [
          {
            kind: 'conversation_turn',
            turnId,
            rationale: 'The operator asked for Todo.',
          },
        ],
      },
      records: [],
      relationships: [],
      diff: {
        intentChanges: ['goal', 'desiredCapabilities'],
        recordChanges: { create: 2, revise: 0, reuse: 0 },
        relationshipChanges: { added: [], removed: [] },
      },
      createdByTurnId: '99999999-9999-4999-8999-999999999999',
      createdByExecutionId: executionId,
      rejectionFeedback: null,
      createdAt: '2026-08-29T00:00:02.000Z',
      decidedAt: null,
    },
  ],
} as PlanningCycleView;

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
    });

    expect(
      screen.getByText('A focused individual Todo workflow.'),
    ).toBeVisible();
    expect(screen.getByText('Goal, Desired Capabilities')).toBeVisible();
    expect(screen.getByText(/Create 2 .* revise 0 .* reuse 0/)).toBeVisible();
    expect(screen.getByText('The operator asked for Todo.')).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Reject proposal' }));

    expect(onApprove).toHaveBeenCalledWith(proposalId);
    expect(onSubmitTurn).toHaveBeenCalledWith('Clarify offline behavior');
    expect(onReject).toHaveBeenCalledWith(proposalId);
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

  it('projects pending, active, attention, terminal, and history-limit lifecycle guidance without local authority', () => {
    const { rerender } = renderPane({
      cycle: {
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
      },
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
        cycle={{
          ...baseCycle,
          cycle: {
            ...baseCycle.cycle,
            lifecycle: 'execution_active',
            activeExecutionId: executionId,
          },
          questions: [],
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
    expect(screen.getByRole('status')).toHaveTextContent(
      'Project manager is working',
    );

    rerender(
      <PlanningPane
        cycle={{
          ...baseCycle,
          cycle: { ...baseCycle.cycle, lifecycle: 'attention_required' },
          questions: [],
        }}
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
        cycle={{
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
    expect(screen.getByText('Proposal approved.')).toBeVisible();

    rerender(
      <PlanningPane
        cycle={{
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
    expect(screen.getByText('Proposal rejected.')).toBeVisible();

    rerender(
      <PlanningPane
        cycle={{
          ...baseCycle,
          cycle: {
            ...baseCycle.cycle,
            lifecycle: 'abandoned',
            endedAt: '2026-08-29T00:00:03.000Z',
          },
        }}
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
    expect(screen.getByText('Planning history is truncated.')).toBeVisible();
    expect(
      screen.getByText('This planning cycle was abandoned.'),
    ).toBeVisible();
  });
});
