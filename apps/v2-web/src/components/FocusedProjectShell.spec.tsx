import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
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
  cursors: { domain: 4, runtime: 12 },
};

describe('FocusedProjectShell', () => {
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
      3,
    );
    expect(
      screen.getByRole('complementary', { name: 'PM Chat' }),
    ).toBeVisible();
    const boardTab = screen.getByRole('tab', { name: 'Board' });
    await user.click(boardTab);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveFocus();
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
    expect(screen.getByText('Resyncing project')).toBeVisible();
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
