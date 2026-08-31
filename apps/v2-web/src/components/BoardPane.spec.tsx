import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boardViewSchema } from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { BoardPane } from './BoardPane';

const projectId = '11111111-1111-4111-8111-111111111111';
const milestoneOne = '22222222-2222-4222-8222-222222222222';
const milestoneTwo = '33333333-3333-4333-8333-333333333333';
const requirementId = '44444444-4444-4444-8444-444444444444';

const board = boardViewSchema.parse({
  projectId,
  deliveryPlanRevision: 2,
  stale: false,
  emptyReason: null,
  filter: {
    projectId,
    revision: 3,
    milestoneIds: [],
    taskLifecycles: ['pending'],
    readiness: [],
    priorities: [],
    labels: ['old-label'],
    requirementRecordIds: [],
    updatedAt: '2026-08-30T00:00:00.000Z',
  },
  totalTaskCount: 2,
  matchedTaskCount: 2,
  facets: {
    milestones: [
      {
        value: milestoneOne,
        label: 'Foundation',
        selected: false,
        matchingTaskCount: 1,
        milestoneRevision: 1,
        lifecycle: 'active',
        historical: false,
      },
      {
        value: milestoneTwo,
        label: 'Experience',
        selected: false,
        matchingTaskCount: 1,
        milestoneRevision: 1,
        lifecycle: 'active',
        historical: false,
      },
    ],
    taskLifecycles: [
      {
        value: 'pending',
        label: 'Pending',
        selected: true,
        matchingTaskCount: 2,
      },
      {
        value: 'completed',
        label: 'Completed',
        selected: false,
        matchingTaskCount: 0,
      },
      {
        value: 'retired',
        label: 'Retired',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    readiness: [
      {
        value: 'actionable',
        label: 'Actionable',
        selected: false,
        matchingTaskCount: 1,
      },
      {
        value: 'blocked',
        label: 'Blocked',
        selected: false,
        matchingTaskCount: 1,
      },
      {
        value: 'inactive',
        label: 'Inactive',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    priorities: [
      { value: 'must', label: 'Must', selected: false, matchingTaskCount: 1 },
      {
        value: 'should',
        label: 'Should',
        selected: false,
        matchingTaskCount: 1,
      },
      { value: 'could', label: 'Could', selected: false, matchingTaskCount: 0 },
    ],
    labels: [
      {
        value: 'backend',
        label: 'backend',
        selected: false,
        matchingTaskCount: 1,
        historical: false,
      },
      {
        value: 'old-label',
        label: 'old-label',
        selected: true,
        matchingTaskCount: 0,
        historical: true,
      },
      {
        value: 'web',
        label: 'web',
        selected: false,
        matchingTaskCount: 1,
        historical: false,
      },
    ],
    requirements: [
      {
        value: requirementId,
        label: 'Preserve completed tasks',
        selected: false,
        matchingTaskCount: 2,
        recordRevision: 3,
        requirementKind: 'quality',
        historical: false,
      },
    ],
  },
  cards: [
    {
      taskId: '55555555-5555-4555-8555-555555555555',
      taskContractRevision: 1,
      taskCurrentRevision: 1,
      milestoneId: milestoneOne,
      milestoneRevision: 1,
      title: 'Persist Todo',
      outcome: 'Todo state survives refresh.',
      lifecycle: 'pending',
      priority: 'must',
      labels: ['backend'],
      readiness: { state: 'actionable', blockers: [] },
      dependencies: [],
      detail: {
        acceptanceCriteria: ['Todo items are durable.'],
        verificationCriteria: ['Refresh the built app.'],
        ownedSurfaces: ['Todo persistence'],
        prohibitedSurfaces: ['Execution runtime'],
        expectedArtifacts: ['Persistence tests'],
        milestoneOutcome: 'Todo data is durable.',
        milestoneStopCondition: 'Refresh preserves Todo items.',
        milestoneExclusions: ['Execution automation'],
        requirementTraces: [
          {
            recordId: requirementId,
            recordRevision: 3,
            title: 'Preserve completed tasks',
          },
        ],
      },
    },
    {
      taskId: '66666666-6666-4666-8666-666666666666',
      taskContractRevision: 1,
      taskCurrentRevision: 1,
      milestoneId: milestoneTwo,
      milestoneRevision: 1,
      title: 'Show Todo',
      outcome: 'Todo items are visible.',
      lifecycle: 'pending',
      priority: 'should',
      labels: ['web'],
      readiness: {
        state: 'blocked',
        blockers: [
          {
            kind: 'dependency_incomplete',
            dependencyId: '77777777-7777-4777-8777-777777777777',
            prerequisiteTaskId: '55555555-5555-4555-8555-555555555555',
          },
        ],
      },
      dependencies: [
        {
          dependencyId: '77777777-7777-4777-8777-777777777777',
          dependencyRevision: 1,
          direction: 'prerequisite',
          otherTaskId: '55555555-5555-4555-8555-555555555555',
          otherTaskTitle: 'Persist Todo',
          otherTaskLifecycle: 'pending',
        },
      ],
      detail: {
        acceptanceCriteria: ['Todo items appear.'],
        verificationCriteria: ['Render the Todo list.'],
        ownedSurfaces: ['Todo view'],
        prohibitedSurfaces: ['Execution runtime'],
        expectedArtifacts: ['View tests'],
        milestoneOutcome: 'Todo work is usable.',
        milestoneStopCondition: 'Operators can complete a task.',
        milestoneExclusions: [],
        requirementTraces: [
          {
            recordId: requirementId,
            recordRevision: 3,
            title: 'Preserve completed tasks',
          },
        ],
      },
    },
  ],
});

describe('BoardPane', () => {
  it('groups the caller-ordered multi-milestone board and exposes durable reasons and details', async () => {
    const user = userEvent.setup();
    render(
      <BoardPane
        board={board}
        connection={{ status: 'ready' }}
        submitting={false}
        onApplyFilter={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('group')).toHaveLength(6);
    expect(screen.getByRole('heading', { name: 'Foundation' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Experience' })).toBeVisible();
    expect(screen.getByText('Actionable')).toBeVisible();
    expect(screen.getByText(/Blocked by Persist Todo/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /^Start/ }),
    ).not.toBeInTheDocument();

    const details = screen.getByRole('button', {
      name: 'View Show Todo details',
    });
    await user.click(details);
    expect(screen.getByText(/Acceptance: Todo items appear\./)).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Close task details' }),
    );
    expect(details).toHaveFocus();
  });

  it('keeps draft filters local and submits one complete canonical selection', async () => {
    const user = userEvent.setup();
    const onApplyFilter = vi.fn();
    render(
      <BoardPane
        board={board}
        connection={{ status: 'ready' }}
        submitting={false}
        onApplyFilter={onApplyFilter}
      />,
    );

    expect(screen.getByText('old-label · historical, 0 tasks')).toBeVisible();
    expect(screen.getByLabelText('Applied Board filters')).toHaveTextContent(
      'old-label',
    );
    await user.click(screen.getByLabelText('Foundation · 1 task'));
    await user.click(
      screen.getByRole('button', { name: 'Clear old-label filter' }),
    );
    expect(screen.getByLabelText('Applied Board filters')).toHaveTextContent(
      'old-label',
    );
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(onApplyFilter).toHaveBeenCalledWith({
      type: 'board_filter.set',
      projectId,
      expectedFilterRevision: 3,
      filter: {
        milestoneIds: [milestoneOne],
        taskLifecycles: ['pending'],
        readiness: [],
        priorities: [],
        labels: [],
        requirementRecordIds: [],
      },
    });
  });

  it('shows explicit loading, pre-plan, empty, stale, and connection states', () => {
    const { rerender } = render(
      <BoardPane
        connection={{ status: 'loading' }}
        submitting={false}
        onApplyFilter={vi.fn()}
      />,
    );
    expect(screen.getByText('Board is loading.')).toBeVisible();

    rerender(
      <BoardPane
        board={{
          projectId,
          deliveryPlanRevision: null,
          stale: false,
          emptyReason: 'planning_required',
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
        }}
        connection={{ status: 'ready' }}
        submitting={false}
        onApplyFilter={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Approve a delivery plan to populate the Board.'),
    ).toBeVisible();

    rerender(
      <BoardPane
        board={{ ...board, stale: true }}
        connection={{
          status: 'disconnected',
          message: 'Board is disconnected.',
        }}
        submitting={false}
        onApplyFilter={vi.fn()}
      />,
    );
    expect(screen.getByText('Approved plan is stale.')).toBeVisible();
    expect(screen.getByText('Board is disconnected.')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Apply filters' }),
    ).toBeDisabled();
  });
});
