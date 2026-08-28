import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { V2ProjectSnapshot, WorkerExecution, WorkerExecutionLifecycle } from '@mesh/v2-contracts';
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
          [executionFixture.id]: { childActivities: [{ id: 'child-1', title: 'Read package.json', lifecycle: 'running' }] },
        }}
      />,
    );

    expect(screen.getAllByText('Available in a later milestone')).toHaveLength(3);
    expect(screen.getByRole('complementary', { name: 'PM Chat' })).toBeVisible();
    const boardTab = screen.getByRole('tab', { name: 'Board' });
    await user.click(boardTab);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveFocus();
    expect(boardTab).toHaveAttribute('id', 'project-pane-tab-board');
    expect(boardTab).toHaveAttribute('aria-controls', 'project-pane-panel-board');
    expect(screen.queryByRole('button', { name: /start|approve|create/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deselect project' }));
    await user.click(screen.getByRole('button', { name: 'Interrupt execution' }));
    expect(onDeselect).toHaveBeenCalledOnce();
    expect(onInterrupt).toHaveBeenCalledWith(executionFixture);
    expect(screen.getByRole('region', { name: 'Attention items' })).toHaveTextContent(
      'Required skill is unavailable.',
    );
    expect(screen.getByRole('list', { name: 'Child activity for Todo foundation worker' })).toHaveTextContent('Read package.json');
  });

  it.each(['created', 'starting', 'running', 'interrupting', 'completed', 'failed', 'interrupted', 'attention_required'] as const)(
    'renders the %s execution lifecycle',
    (lifecycle: WorkerExecutionLifecycle) => {
      render(
        <FocusedProjectShell
          model={{
            status: 'ready', interrupt: { enabled: true },
            snapshot: { ...snapshot, executions: [{ ...executionFixture, lifecycle }] },
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
    expect(screen.getByRole('button', { name: 'Interrupt execution' })).toBeDisabled();
    expect(screen.getByText('Resyncing project')).toBeVisible();
    expect(screen.getByText('Wait for a fresh project snapshot before interrupting.')).toBeVisible();

    rerender(
      <FocusedProjectShell
        model={{ status: 'disconnected', snapshot, message: 'Connection lost' }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Interrupt execution' })).toBeDisabled();
    expect(screen.getByText('Reconnect before interrupting an execution.')).toBeVisible();
  });

  it('uses the ready presentation reason when interrupting is unavailable', () => {
    render(
      <FocusedProjectShell
        model={{ status: 'ready', snapshot, interrupt: { enabled: false, disabledReason: 'Audit barrier is active.' } }}
        onDeselect={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Interrupt execution' })).toBeDisabled();
    expect(screen.getByText('Audit barrier is active.')).toBeVisible();
  });
});
