import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PlansPane } from './PlansPane';

const projectId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';
const intentCycle = {
  purpose: {
    kind: 'intent' as const,
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
  cycle: {
    id: '33333333-3333-4333-8333-333333333333',
    projectId,
    lifecycle: 'awaiting_approval' as const,
    revision: 1,
    profileId: '44444444-4444-4444-8444-444444444444',
    profileRevision: 1,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 1,
    activeExecutionId: null,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    endedAt: null,
  },
  turns: [],
  questions: [],
  deliveryPlanProposals: [],
  proposals: [
    {
      id: proposalId,
      projectId,
      planningCycleId: '33333333-3333-4333-8333-333333333333',
      revision: 1,
      lifecycle: 'awaiting_approval' as const,
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      summary: 'Keep Mesh focused.',
      projectIntent: {
        goal: 'Coordinate coding agents.',
        targetUsers: ['Operators'],
        desiredCapabilities: ['Review plans'],
        constraints: [],
        nonGoals: [],
        successConditions: ['Plans require human approval'],
        rationale: 'Human authority stays explicit.',
        provenance: [],
      },
      records: [],
      relationships: [],
      diff: {
        intentChanges: [],
        recordChanges: { create: 0, revise: 0, reuse: 0 },
        relationshipChanges: { added: [], removed: [] },
      },
      createdByTurnId: '55555555-5555-4555-8555-555555555555',
      createdByExecutionId: '66666666-6666-4666-8666-666666666666',
      rejectionFeedback: null,
      createdAt: '2026-09-03T00:00:00.000Z',
      decidedAt: null,
    },
  ],
};

describe('PlansPane', () => {
  it('is the canonical proposal-action surface without a conversation composer', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <PlansPane
        projectId={projectId}
        intent={{
          cycle: intentCycle,
          connection: { status: 'ready' },
          profiles: [],
          submitting: false,
          onSubmitTurn: vi.fn(),
          onApprove,
          onReject: vi.fn(),
          onAbandon: vi.fn(),
        }}
        deliveryPlan={{
          approvedIntentLedger: null,
          deliveryPlan: null,
          planStale: false,
          connection: { status: 'ready' },
          profiles: [],
          submitting: false,
          onSubmit: vi.fn(),
          onApprove: vi.fn(),
          onReject: vi.fn(),
          onAbandon: vi.fn(),
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Plans' })).toBeVisible();
    expect(
      screen.queryByRole('textbox', { name: 'Message to project manager' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve proposal' }));
    expect(onApprove).toHaveBeenCalledWith(proposalId);
  });
});
