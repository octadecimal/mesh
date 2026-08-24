import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSnapshot } from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { createMeshStore } from '../state/store';
import App from './app';

describe('App', () => {
  it('renders the minimal Mesh application shell', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Mesh' })).toBeDefined();
    expect(screen.getByText('Session platform')).toBeDefined();
  });

  it('hiding a panel does not send an interrupt command', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot);
    const api = createApi();
    render(
      <App store={store} api={api} />,
    );

    await user.click(screen.getByRole('button', { name: /Session A/ }));
    await user.click(screen.getByRole('button', { name: 'Close Session A panel' }));

    expect(api.command).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.interrupt' }),
    );
  });

  it('persists real Dockview JSON through MeshApi with Hookstate selection and sidebar state', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot);
    store.state.unreadSessionIds.set({ s1: true });
    const api = createApi();
    render(<App store={store} api={api} />);

    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'Session');
    await user.click(screen.getByRole('button', { name: /Session A/ }));

    await waitFor(() => expect(api.command).toHaveBeenCalled());
    const command = api.command.mock.calls.at(-1)?.[0];
    expect(command).toEqual(
      expect.objectContaining({
        type: 'layout.save',
        payload: expect.objectContaining({
          id: 'layout-1',
          projectId: 'p1',
          dockview: expect.objectContaining({ grid: expect.any(Object) }),
          sidebar: { filter: 'Session' },
          visiblePanels: ['s1'],
        }),
      }),
    );
    expect(store.state.selectedSessionId.get()).toBe('s1');
    expect(store.state.unreadSessionIds.s1.get()).toBe(false);
  });
});

const project = {
  id: 'p1',
  displayName: 'Mesh',
  repositoryPath: '/mesh',
  discoveredAt: '2026-08-24T00:00:00.000Z',
  discoveryMetadata: {},
};
const workspace = { id: 'w1', projectId: 'p1', type: 'shared' as const, path: '/mesh' };
const session = {
  id: 's1',
  projectId: 'p1',
  workspaceId: 'w1',
  title: 'Session A',
  permissionMode: 'interactive' as const,
  lifecycleState: 'running' as const,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

const snapshot: SessionSnapshot = {
  protocolVersion: 1,
  projects: [project],
  workspaces: [workspace],
  sessions: [session],
  events: [],
  pendingApprovals: [],
  lastSequenceBySession: {},
  layouts: [
    {
      id: 'layout-1',
      projectId: 'p1',
      dockview: {},
      sidebar: { filter: '' },
      visiblePanels: [],
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
  ],
};

const createApi = () => ({
  command: vi.fn().mockResolvedValue({
    protocolVersion: 1,
    commandType: 'layout.save',
    result: {},
    warnings: [],
  }),
});
