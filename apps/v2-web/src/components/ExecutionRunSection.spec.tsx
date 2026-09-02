import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ApprovedDeliveryPlan,
  BoardView,
  ExecutionRunView,
  ResolvedWorkerProfileSnapshot,
  StartExecutionRunCommand,
} from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { ExecutionRunSection } from './ExecutionRunSection';

const projectId = '11111111-1111-4111-8111-111111111111';
const firstTaskId = '22222222-2222-4222-8222-222222222222';
const secondTaskId = '33333333-3333-4333-8333-333333333333';
const profileId = '44444444-4444-4444-8444-444444444444';

const board = {
  projectId,
  deliveryPlanRevision: 2,
  stale: false,
  filter: { revision: 3 },
  cards: [
    {
      taskId: firstTaskId,
      taskCurrentRevision: 1,
      title: 'Build API',
      lifecycle: 'pending',
      dependencies: [],
    },
    {
      taskId: secondTaskId,
      taskCurrentRevision: 2,
      title: 'Connect UI',
      lifecycle: 'pending',
      dependencies: [
        {
          direction: 'prerequisite',
          otherTaskId: firstTaskId,
          otherTaskTitle: 'Build API',
          otherTaskLifecycle: 'pending',
        },
      ],
    },
  ],
} as unknown as BoardView;

const deliveryPlan = {
  plan: {
    id: '55555555-5555-4555-8555-555555555555',
    revision: 2,
  },
  taskContracts: [
    { id: firstTaskId, title: 'Build API' },
    { id: secondTaskId, title: 'Connect UI' },
  ],
} as ApprovedDeliveryPlan;

const profile = {
  profileId,
  profileRevision: 4,
  document: {
    metadata: { displayName: 'Todo Developer' },
    spec: { assignmentKinds: ['developer_task'] },
  },
} as ResolvedWorkerProfileSnapshot;

const run = {
  run: {
    id: '66666666-6666-4666-8666-666666666666',
    projectId,
    revision: 5,
    lifecycle: 'running',
    concurrencyLimit: 2,
    counts: {
      waiting: 1,
      launchPending: 0,
      active: 1,
      completed: 0,
      attentionRequired: 0,
      notStarted: 0,
    },
    attention: { code: 'task_failed', message: 'API task needs attention.' },
  },
  items: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      taskId: firstTaskId,
      lifecycle: 'active',
      prerequisiteTaskIds: [],
      developerAttemptId: '88888888-8888-4888-8888-888888888888',
      attention: null,
    },
    {
      id: '99999999-9999-4999-8999-999999999999',
      taskId: secondTaskId,
      lifecycle: 'waiting',
      prerequisiteTaskIds: [firstTaskId],
      developerAttemptId: null,
      attention: null,
    },
  ],
} as unknown as ExecutionRunView;

describe('ExecutionRunSection', () => {
  it('requires a dependency-closed, profiled, capacity-confirmed selection', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn();
    render(
      <ExecutionRunSection
        board={board}
        deliveryPlan={deliveryPlan}
        profiles={[profile]}
        runs={[]}
        connectionReady
        submitting={false}
        onCommand={onCommand}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'Run Connect UI' }));
    expect(screen.getByText('Select prerequisite Build API.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Run Build API' }));
    await user.selectOptions(
      screen.getByLabelText('Profile for Build API'),
      profileId,
    );
    await user.selectOptions(
      screen.getByLabelText('Profile for Connect UI'),
      profileId,
    );
    await user.clear(screen.getByLabelText('Parallel workers'));
    await user.type(screen.getByLabelText('Parallel workers'), '4');
    await user.click(
      screen.getByRole('checkbox', {
        name: 'I confirmed subscription capacity for this run',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    const command = onCommand.mock.calls[0]?.[0] as StartExecutionRunCommand;
    expect(command).toMatchObject({
      type: 'execution_run.start',
      concurrencyLimit: 4,
      subscriptionCapacityConfirmed: true,
      selections: [
        { taskId: firstTaskId, profileId, profileRevision: 4 },
        { taskId: secondTaskId, profileId, profileRevision: 4 },
      ],
    });
  });

  it('shows capacity, ordered item evidence, and confirms Stop before sending it', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn();
    render(
      <ExecutionRunSection
        board={board}
        deliveryPlan={deliveryPlan}
        profiles={[profile]}
        runs={[run]}
        connectionReady
        submitting={false}
        onCommand={onCommand}
      />,
    );

    expect(
      screen.getByText(/1 active · 1 waiting · 0 attention required/),
    ).toBeVisible();
    expect(screen.getByText('1 of 2 workers occupied')).toBeVisible();
    expect(screen.getByText('0 launch pending · 0 not started')).toBeVisible();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Build API · active');
    expect(items[0]).toHaveTextContent('Developer attempt');
    expect(items[1]).toHaveTextContent('Connect UI · waiting');
    expect(items[1]).toHaveTextContent('Waiting for Build API');
    expect(screen.getByRole('link', { name: 'Build API' })).toHaveAttribute(
      'href',
      `#board-task-${firstTaskId}`,
    );
    expect(
      screen.getByRole('link', { name: 'Developer attempt' }),
    ).toHaveAttribute(
      'href',
      '#developer-attempt-88888888-8888-4888-8888-888888888888',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'API task needs attention.',
    );
    await user.click(screen.getByRole('button', { name: 'Pause run' }));
    expect(onCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'execution_run.pause',
        expectedRunRevision: 5,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Confirm stop' }));
    expect(onCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'execution_run.stop',
        expectedRunRevision: 5,
      }),
    );
  });

  it('retains completed run history with terminal item outcomes', () => {
    const completed = {
      ...run,
      run: {
        ...run.run,
        lifecycle: 'completed',
        completionReason: 'stopped',
        counts: {
          waiting: 0,
          launchPending: 0,
          active: 0,
          completed: 1,
          attentionRequired: 0,
          notStarted: 1,
        },
      },
      items: [
        { ...run.items[0], lifecycle: 'completed' },
        {
          ...run.items[1],
          lifecycle: 'not_started',
          prerequisiteTaskIds: [],
        },
      ],
    } as ExecutionRunView;

    render(
      <ExecutionRunSection
        board={board}
        deliveryPlan={deliveryPlan}
        profiles={[profile]}
        runs={[completed]}
        connectionReady
        submitting={false}
        onCommand={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Completed runs' }),
    ).toBeVisible();
    expect(
      screen.getByText(/stopped · 1 completed · 1 not started/),
    ).toBeVisible();
    expect(screen.getAllByRole('listitem')[1]).toHaveTextContent(
      'Connect UI · not started',
    );
  });
});
