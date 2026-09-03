import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GlobalRunSummary } from '../app/global-projection';
import type { GlobalProjectSnapshotState } from '../app/use-global-project-snapshots';
import { projectSnapshotFixture } from '../test/project-snapshot-fixture';
import { GlobalRunsPage } from './GlobalRunsPage';
import { RunsView } from './RunsView';

const runs: readonly GlobalRunSummary[] = [
  {
    executionId: 'history-1',
    projectId: 'project-a',
    projectName: 'Alpha',
    title: 'Implement task T-21',
    lifecycle: 'interrupted',
    active: false,
    updatedAt: '2026-08-28T00:00:03.000Z',
    href: '/projects/project-a/runs?run=history-1',
  },
  {
    executionId: 'active-1',
    projectId: 'project-a',
    projectName: 'Alpha',
    title: 'Build controls',
    lifecycle: 'running',
    active: true,
    updatedAt: '2026-08-28T00:00:02.000Z',
    href: '/projects/project-a/runs?run=active-1',
  },
  {
    executionId: 'active-2',
    projectId: 'project-b',
    projectName: 'Beta',
    title: 'Verify release',
    lifecycle: 'starting',
    active: true,
    updatedAt: '2026-08-28T00:00:01.000Z',
    href: '/projects/project-b/runs?run=active-2',
  },
];

describe('RunsView', () => {
  it('opens on active runs and navigates from history through canonical links', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(<RunsView runs={runs} onNavigate={onNavigate} />);

    expect(screen.getByRole('tab', { name: 'Active 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('region', { name: 'Run details' }),
    ).toHaveTextContent('Build controls');
    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(
      screen.getByRole('region', { name: 'Run details' }),
    ).toHaveTextContent('Interrupted');
    await user.click(
      screen.getByRole('link', { name: /implement task T-21/i }),
    );
    expect(onNavigate).toHaveBeenCalledWith(runs[0].href);
  });

  it('filters runs by project and names empty active and history states', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RunsView runs={runs} projectId="project-b" onNavigate={vi.fn()} />,
    );

    expect(screen.getByRole('tab', { name: 'Active 1' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Verify release/i })).toBeVisible();
    expect(screen.queryByText('Build controls')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByText('No run history.')).toBeVisible();

    rerender(<RunsView runs={[]} onNavigate={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: 'Active 0' }));
    expect(screen.getByText('No active runs.')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByText('No run history.')).toBeVisible();
  });

  it('falls back to the first history row when there are no active runs', () => {
    render(<RunsView runs={[runs[0]]} onNavigate={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('region', { name: 'Run details' }),
    ).toHaveTextContent('Implement task T-21');
  });

  it('keeps a URL-selected row selected when refreshed rows remain', () => {
    const { rerender } = render(
      <RunsView runs={runs} selectedId="active-1" onNavigate={vi.fn()} />,
    );

    expect(screen.getByRole('tab', { name: 'Active 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('region', { name: 'Run details' }),
    ).toHaveTextContent('Build controls');

    rerender(
      <RunsView runs={runs} selectedId="history-1" onNavigate={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    rerender(
      <RunsView
        runs={[runs[2], runs[0], runs[1]]}
        selectedId="history-1"
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('region', { name: 'Run details' }),
    ).toHaveTextContent('Implement task T-21');
  });
});

describe('GlobalRunsPage', () => {
  const refresh = vi.fn();
  const state = (
    overrides: Partial<GlobalProjectSnapshotState>,
  ): GlobalProjectSnapshotState => ({
    status: 'ready',
    snapshots: [],
    failures: [],
    refreshing: false,
    refresh,
    ...overrides,
  });

  it('shows initial loading without an empty-state flash', () => {
    render(
      <GlobalRunsPage
        state={state({ status: 'loading', refreshing: true })}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading runs');
    expect(screen.queryByText('No active runs.')).toBeNull();
  });

  it('retains runs and project-scoped failures while refreshing manually', async () => {
    const user = userEvent.setup();
    refresh.mockClear();

    render(
      <GlobalRunsPage
        state={state({
          snapshots: [projectSnapshotFixture],
          failures: [
            {
              projectId: projectSnapshotFixture.project.id,
              message: 'Offline',
            },
          ],
          refreshing: true,
        })}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      projectSnapshotFixture.project.displayName,
    );
    expect(
      screen.getByRole('link', { name: /Todo foundation worker/i }),
    ).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing runs');
    await user.click(screen.getByRole('button', { name: 'Refresh runs' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
