import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { Session } from '@mesh-session-platform/contracts';

import { SessionWorkspace } from './SessionWorkspace';

describe('SessionWorkspace', () => {
  it('renders session panels through the real Dockview host', () => {
    const { container } = render(
      <SessionWorkspace sessions={sessions} selectedSessionId="s1" />,
    );

    expect(container.querySelector('.dv-dockview')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Session A' })).toBeDefined();
  });

  it('serializes the real Dockview layout after a panel is opened', async () => {
    const onSaveLayout = vi.fn();
    render(
      <SessionWorkspace
        sessions={sessions}
        selectedSessionId="s1"
        sidebar={{ filter: 'mesh' }}
        onSaveLayout={onSaveLayout}
      />,
    );

    await waitFor(() => expect(onSaveLayout).toHaveBeenCalled());
    expect(onSaveLayout.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        dockview: expect.objectContaining({ grid: expect.any(Object) }),
        sidebar: { filter: 'mesh' },
        visiblePanels: ['s1'],
      }),
    );
  });

  it('updates an open panel when the session lifecycle changes', async () => {
    const running = session('running');
    const { rerender } = render(
      <SessionWorkspace
        sessions={[running]}
        selectedSessionId={running.id}
        promptDrafts={{ [running.id]: 'continue' }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled();

    rerender(
      <SessionWorkspace
        sessions={[session('failed')]}
        selectedSessionId={running.id}
        promptDrafts={{ [running.id]: 'continue' }}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Send prompt' }),
      ).toBeDisabled(),
    );
  });
});

const session = (lifecycleState: Session['lifecycleState']): Session => ({
  id: 's-live',
  projectId: 'p1',
  workspaceId: 'w1',
  title: 'Live session',
  permissionMode: 'interactive',
  lifecycleState,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
});

const sessions = [
  { id: 's1', title: 'Session A' },
  { id: 's2', title: 'Session B' },
  { id: 's3', title: 'Session C' },
];
