import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSnapshot } from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { createMeshStore } from '../state/store';
import App from './app';

describe('App', () => {
  it('renders a useful empty workspace with direct session actions', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Mesh' })).toBeDefined();
    expect(
      screen.getByRole('heading', { name: 'Start a Claude session' }),
    ).toBeDefined();
    expect(screen.getByText(/workspace stays active/i)).toBeDefined();

    await user.click(
      screen.getByRole('button', { name: 'Create your first session' }),
    );
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeDefined();
  });

  it('hiding a panel does not send an interrupt command', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot);
    const api = createApi();
    render(<App store={store} api={api} />);

    await user.click(screen.getByRole('button', { name: /Session A/ }));
    await user.click(
      screen.getByRole('button', { name: 'Close Session A panel' }),
    );

    expect(api.command).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.interrupt' }),
    );
  });

  it('keeps new session open when creation warns about a shared workspace collision', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot);
    const api = createApi();
    api.command.mockImplementation((command) =>
      Promise.resolve({
        protocolVersion: 1,
        commandType: command.type,
        result: {},
        warnings:
          command.type === 'session.create'
            ? [
                {
                  code: 'shared_workspace_collision',
                  message: 'This shared folder is already used by Session A.',
                },
              ]
            : [],
      }),
    );
    render(<App store={store} api={api} />);

    await user.click(screen.getByRole('button', { name: 'New session' }));
    await user.selectOptions(screen.getByLabelText('Project'), 'p1');
    await user.type(screen.getByLabelText('Shared folder path'), '/mesh');
    await user.selectOptions(
      screen.getByLabelText('Permission mode'),
      'interactive',
    );
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    await waitFor(() =>
      expect(
        screen.getByText('This shared folder is already used by Session A.'),
      ).toBeDefined(),
    );
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull(),
    );
  });

  it('persists real Dockview JSON through MeshApi with Hookstate selection and sidebar state', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot);
    store.state.unreadSessionIds.set({ s1: true });
    const api = createApi();
    render(<App store={store} api={api} />);

    await user.type(
      screen.getByRole('searchbox', { name: 'Filter sessions' }),
      'Session',
    );
    await user.click(screen.getByRole('button', { name: /Session A/ }));

    await waitFor(() =>
      expect(api.command).toHaveBeenCalledWith(
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
      ),
    );
    expect(store.state.selectedSessionId.get()).toBe('s1');
    expect(store.state.unreadSessionIds.s1.get()).toBe(false);
  });

  it("keeps project A's restored layout isolated when project B becomes selected", async () => {
    const user = userEvent.setup();
    const store = createMeshStore(crossProjectSnapshot);
    const api = createApi();
    render(<App store={store} api={api} />);

    expect(await screen.findByRole('tab', { name: 'Session A' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: /Session B/ }));

    expect(await screen.findByRole('tab', { name: 'Session B' })).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Session A' })).toBeNull(),
    );
    await waitFor(() =>
      expect(
        api.command.mock.calls
          .map(([command]) => command)
          .find((command) => command.payload.projectId === 'p2'),
      ).toEqual(
        expect.objectContaining({
          type: 'layout.save',
          payload: expect.objectContaining({
            id: 'layout-p2',
            projectId: 'p2',
            visiblePanels: ['s2'],
          }),
        }),
      ),
    );
    expect(
      api.command.mock.calls
        .map(([command]) => command)
        .filter((command) => command.payload.id === 'layout-a')
        .every(
          (command) =>
            command.payload.projectId === 'p1' &&
            command.payload.visiblePanels.length === 1 &&
            command.payload.visiblePanels[0] === 's1',
        ),
    ).toBe(true);
  });
});

const project = {
  id: 'p1',
  displayName: 'Mesh',
  repositoryPath: '/mesh',
  discoveredAt: '2026-08-24T00:00:00.000Z',
  discoveryMetadata: {},
};
const workspace = {
  id: 'w1',
  projectId: 'p1',
  type: 'shared' as const,
  path: '/mesh',
};
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

const projectB = {
  ...project,
  id: 'p2',
  displayName: 'Other',
  repositoryPath: '/other',
};
const workspaceB = {
  ...workspace,
  id: 'w2',
  projectId: 'p2',
  path: '/other',
};
const sessionB = {
  ...session,
  id: 's2',
  projectId: 'p2',
  workspaceId: 'w2',
  title: 'Session B',
};

const crossProjectSnapshot: SessionSnapshot = {
  ...snapshot,
  projects: [project, projectB],
  workspaces: [workspace, workspaceB],
  sessions: [session, sessionB],
  layouts: [
    {
      id: 'layout-a',
      projectId: 'p1',
      dockview: {
        grid: {
          root: {
            type: 'branch',
            size: 100,
            data: [
              {
                type: 'leaf',
                size: 100,
                data: { id: 'group-a', views: ['s1'], activeView: 's1' },
              },
            ],
          },
          height: 100,
          width: 100,
          orientation: 'HORIZONTAL',
        },
        panels: {
          s1: {
            id: 's1',
            contentComponent: 'session',
            title: 'Session A',
            params: { sessionId: 's1' },
          },
        },
        activeGroup: 'group-a',
      },
      sidebar: { filter: '' },
      visiblePanels: ['s1'],
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
