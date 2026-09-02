import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  boardViewSchema,
  type BoardView,
  type ResolvedWorkerProfileSnapshot,
} from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { BoardPane } from './BoardPane';

const projectId = '11111111-1111-4111-8111-111111111111';
const milestoneOne = '22222222-2222-4222-8222-222222222222';
const milestoneTwo = '33333333-3333-4333-8333-333333333333';
const requirementId = '44444444-4444-4444-8444-444444444444';

const developerProfile = {
  profileId: '88888888-8888-4888-8888-888888888888',
  projectId,
  profileRevision: 2,
  baseProfileId: null,
  baseRevision: null,
  document: {
    apiVersion: 'mesh.dev/v1alpha1',
    kind: 'WorkerProfile',
    metadata: {
      name: 'developer',
      displayName: 'Developer',
      scope: 'project',
    },
    spec: {
      assignmentKinds: ['developer_task'],
      preferredRuntime: { harness: 'fake', model: 'fake-v1' },
      alternatives: [],
      requiredCapabilities: [],
      skills: { preferred: [], required: [] },
      instructions: 'Implement one task.',
      outputSchema: 'mesh.dev/developer-report/v1',
    },
  },
  digest: 'd'.repeat(64),
} satisfies ResolvedWorkerProfileSnapshot;

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
      screen.getAllByText(
        'Requirements: Preserve completed tasks · revision 3',
      ),
    ).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: /^Start/ }),
    ).not.toBeInTheDocument();

    const details = screen.getByRole('button', {
      name: 'View Show Todo details',
    });
    await user.click(details);
    expect(screen.getByRole('heading', { name: 'Task details' })).toHaveFocus();
    expect(screen.getByText(/Acceptance: Todo items appear\./)).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Close task details' }),
    );
    expect(details).toHaveFocus();
  });

  it('renders every server blocker in order with its matching task name', () => {
    const blocked = board.cards[1];
    const multiBlocked = {
      ...board,
      cards: [
        board.cards[0],
        {
          ...blocked,
          readiness: {
            state: 'blocked',
            blockers: [
              ...blocked.readiness.blockers,
              {
                kind: 'dependency_incomplete',
                dependencyId: '88888888-8888-4888-8888-888888888888',
                prerequisiteTaskId: '99999999-9999-4999-8999-999999999999',
              },
            ],
          },
          dependencies: [
            ...blocked.dependencies,
            {
              dependencyId: '88888888-8888-4888-8888-888888888888',
              dependencyRevision: 1,
              direction: 'prerequisite',
              otherTaskId: '99999999-9999-4999-8999-999999999999',
              otherTaskTitle: 'Validate Todo',
              otherTaskLifecycle: 'pending',
            },
          ],
        },
      ],
    } as BoardView;

    render(
      <BoardPane
        board={multiBlocked}
        connection={{ status: 'ready' }}
        submitting={false}
        onApplyFilter={vi.fn()}
      />,
    );

    const reasons = within(
      screen.getByLabelText('Readiness for Show Todo'),
    ).getAllByRole('listitem');
    expect(reasons.map((reason) => reason.textContent)).toEqual([
      'Blocked by Persist Todo',
      'Blocked by Validate Todo',
    ]);
  });

  it('composes the selected task Developer controls without changing Board cards optimistically', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(
      <BoardPane
        board={board}
        connection={{ status: 'ready' }}
        submitting={false}
        onApplyFilter={vi.fn()}
        developer={{
          attempts: [],
          reports: [],
          executions: [],
          profiles: [developerProfile],
          projectCursors: { domain: 7, runtime: 9 },
          activityByExecutionId: {},
          onStart,
          onInterrupt: vi.fn(),
          onReplace: vi.fn(),
        }}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'View Persist Todo details' }),
    );

    expect(
      screen.getByRole('region', { name: 'Developer for Persist Todo' }),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Start Developer attempt' }),
    );
    expect(onStart).toHaveBeenCalledWith(board.cards[0], developerProfile);
    expect(screen.getByText('No Developer attempts yet.')).toBeVisible();
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

    expect(screen.getAllByText('old-label · historical, 0 tasks')).toHaveLength(
      2,
    );
    const applied = screen.getByLabelText('Applied Board filters');
    expect(applied).toHaveTextContent('old-label · historical, 0 tasks');
    expect(
      within(applied).getByRole('button', {
        name: 'Clear old-label filter',
      }),
    ).toBeVisible();
    await user.click(screen.getByLabelText('Foundation · 1 task'));
    await user.click(
      within(applied).getByRole('button', {
        name: 'Clear old-label filter',
      }),
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

  it('announces result counts and errors without stealing filter focus', () => {
    const props = {
      board,
      connection: { status: 'ready' } as const,
      submitting: false,
      onApplyFilter: vi.fn(),
    };
    const { rerender } = render(<BoardPane {...props} />);
    const apply = screen.getByRole('button', { name: 'Apply filters' });
    apply.focus();

    rerender(<BoardPane {...props} error="Filter conflict" />);

    expect(screen.getByText(/Showing 2 of 2 tasks/)).toHaveAttribute(
      'aria-live',
      'polite',
    );
    expect(screen.getByText('Filter conflict')).toHaveAttribute(
      'aria-live',
      'assertive',
    );
    expect(apply).toHaveFocus();
  });

  it.each([
    {
      name: 'intent required',
      board: boardViewSchema.parse({
        ...board,
        deliveryPlanRevision: null,
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
      }),
      connection: { status: 'ready' } as const,
      submitting: false,
      message: 'Approve project intent and requirements to plan delivery.',
      apply: 'absent',
    },
    {
      name: 'plan empty',
      board: boardViewSchema.parse({
        ...board,
        emptyReason: 'plan_empty',
        totalTaskCount: 0,
        matchedTaskCount: 0,
        facets: {
          ...board.facets,
          milestones: [],
          taskLifecycles: board.facets.taskLifecycles.map((option) => ({
            ...option,
            matchingTaskCount: 0,
          })),
          readiness: board.facets.readiness.map((option) => ({
            ...option,
            matchingTaskCount: 0,
          })),
          priorities: board.facets.priorities.map((option) => ({
            ...option,
            matchingTaskCount: 0,
          })),
          labels: board.facets.labels.map((option) => ({
            ...option,
            matchingTaskCount: 0,
          })),
          requirements: board.facets.requirements.map((option) => ({
            ...option,
            matchingTaskCount: 0,
          })),
        },
        cards: [],
      }),
      connection: { status: 'ready' } as const,
      submitting: false,
      message: 'The approved delivery plan has no active tasks.',
      apply: 'enabled',
    },
    {
      name: 'filter empty',
      board: boardViewSchema.parse({
        ...board,
        emptyReason: 'filter_empty',
        matchedTaskCount: 0,
        cards: [],
      }),
      connection: { status: 'ready' } as const,
      submitting: false,
      message: 'No tasks match the applied Board filters.',
      apply: 'enabled',
    },
    {
      name: 'stale connection',
      board,
      connection: {
        status: 'stale',
        message: 'Board projection is stale.',
      } as const,
      submitting: false,
      message: 'Board projection is stale.',
      apply: 'disabled',
    },
    {
      name: 'submitting',
      board,
      connection: { status: 'ready' } as const,
      submitting: true,
      message: 'A project command is in progress.',
      apply: 'disabled',
    },
  ])('renders the $name branch without changing server truth', (state) => {
    render(
      <BoardPane
        board={state.board}
        connection={state.connection}
        submitting={state.submitting}
        onApplyFilter={vi.fn()}
      />,
    );

    expect(screen.getByText(state.message)).toBeVisible();
    const apply = screen.queryByRole('button', { name: 'Apply filters' });
    if (state.apply === 'absent') expect(apply).not.toBeInTheDocument();
    else if (state.apply === 'disabled') expect(apply).toBeDisabled();
    else expect(apply).toBeEnabled();
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
