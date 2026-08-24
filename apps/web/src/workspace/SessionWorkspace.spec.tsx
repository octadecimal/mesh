import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

import { SessionWorkspace } from './SessionWorkspace';

describe('SessionWorkspace', () => {
  it('renders session panels through the real Dockview host', () => {
    const { container } = render(
      <SessionWorkspace sessions={sessions} selectedSessionId="s1" />,
    );

    expect(container.querySelector('.dv-dockview')).not.toBeNull();
    expect(screen.getByText('Session s1')).toBeDefined();
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
});

const sessions = [
  { id: 's1', title: 'Session A' },
  { id: 's2', title: 'Session B' },
  { id: 's3', title: 'Session C' },
];
