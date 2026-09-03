import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { V2ProjectSnapshot } from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { projectSnapshotFixture } from '../test/project-snapshot-fixture';
import { InboxPage } from './InboxPage';

const refresh = vi.fn();

const decisionSnapshot = {
  ...projectSnapshotFixture,
  executions: [],
  attentionItems: [],
  planningCycles: [
    {
      purpose: { kind: 'intent' },
      cycle: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        lifecycle: 'awaiting_approval',
        revision: 7,
        updatedAt: '2026-08-28T00:00:07.000Z',
      },
      proposals: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          lifecycle: 'awaiting_approval',
          revision: 1,
          summary: 'Review this proposal',
        },
      ],
    },
  ],
  board: {
    ...projectSnapshotFixture.board,
    emptyReason: null,
    cards: [
      {
        taskId: 'T-21',
        taskCurrentRevision: 8,
        title: 'Ship inbox',
        outcome: 'Operators can find work across projects.',
        readiness: { state: 'actionable' },
      },
    ],
  },
} as V2ProjectSnapshot;

const quietSnapshot = {
  ...projectSnapshotFixture,
  executions: [],
  attentionItems: [],
  planningCycles: [],
  board: { ...projectSnapshotFixture.board, cards: [] },
} as V2ProjectSnapshot;

const state = (
  snapshots: readonly V2ProjectSnapshot[],
  overrides: Partial<{
    status: 'idle' | 'loading' | 'ready';
    failures: readonly { projectId: string; message: string }[];
    refreshing: boolean;
  }> = {},
) => ({
  status: 'ready' as const,
  snapshots,
  failures: [],
  refreshing: false,
  refresh,
  ...overrides,
});

describe('InboxPage', () => {
  it('shows initial loading without an empty-state flash', () => {
    render(
      <InboxPage
        state={state([], { status: 'loading', refreshing: true })}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading Inbox');
    expect(screen.queryByText('No projects have been added yet.')).toBeNull();
  });

  it('distinguishes no projects from a quiet Inbox', () => {
    const { rerender } = render(
      <InboxPage state={state([])} onNavigate={vi.fn()} />,
    );
    expect(screen.getByText('No projects have been added yet.')).toBeVisible();

    rerender(<InboxPage state={state([quietSnapshot])} onNavigate={vi.fn()} />);
    expect(screen.getByText('No project needs attention.')).toBeVisible();
  });

  it('keeps healthy attention usable beside a project-scoped failure', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(
      <InboxPage
        state={state([decisionSnapshot], {
          failures: [
            {
              projectId: decisionSnapshot.project.id,
              projectName: decisionSnapshot.project.displayName,
              message: 'Offline',
            },
          ],
        })}
        onNavigate={onNavigate}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Needs attention' }),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      decisionSnapshot.project.displayName,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Offline');
    await user.click(screen.getByRole('link', { name: 'Review in project' }));
    expect(onNavigate).toHaveBeenCalledWith(
      `/projects/${decisionSnapshot.project.id}/plans`,
    );
  });

  it('filters the master list and selects one detail at a time', async () => {
    const user = userEvent.setup();
    const alpha = {
      ...decisionSnapshot,
      project: {
        ...decisionSnapshot.project,
        id: '22222222-2222-4222-8222-222222222222',
        displayName: 'Alpha',
      },
      planningCycles: [],
    } as V2ProjectSnapshot;

    render(
      <InboxPage
        state={state([decisionSnapshot, alpha])}
        onNavigate={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('region', { name: 'Attention details' }),
    ).toHaveTextContent('Decision needed');
    await user.selectOptions(screen.getByLabelText('Category'), 'ready');
    expect(
      screen.queryByRole('button', { name: /Decision needed/i }),
    ).toBeNull();
    await user.selectOptions(
      screen.getByLabelText('Project'),
      decisionSnapshot.project.id,
    );
    await user.click(screen.getByRole('button', { name: /Ship inbox/i }));
    expect(
      screen.getByRole('region', { name: 'Attention details' }),
    ).toHaveTextContent('Operators can find work across projects.');
  });

  it('retains content during refresh and exposes explicit refresh', async () => {
    const user = userEvent.setup();
    refresh.mockClear();

    render(
      <InboxPage
        state={state([decisionSnapshot], { refreshing: true })}
        onNavigate={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('region', { name: 'Attention details' }),
    ).toHaveTextContent('Decision needed');
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing Inbox');
    await user.click(screen.getByRole('button', { name: 'Refresh Inbox' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
