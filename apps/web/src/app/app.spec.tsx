import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  type SessionSnapshot,
} from '@mesh-session-platform/contracts';
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

  it('opens a project board and keeps its session workspace reachable', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot);
    render(<App store={store} api={createApi()} />);

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p1');

    expect(screen.getByRole('region', { name: 'Mesh board' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(
      screen.getByRole('main', { name: 'Session workspace' }),
    ).toBeDefined();
  });

  it('renders the loaded task board, sends task commands, and forwards selection', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot);
    const api = createApi();
    const onSelectTask = vi.fn();
    api.projectSnapshot.mockResolvedValue({
      protocolVersion: 1,
      project,
      tasks: [boardTask],
      attempts: [boardAttempt],
      transitions: [],
      repairs: [],
      cursor: 1,
    });
    render(<App store={store} api={api} onSelectTask={onSelectTask} />);

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p1');
    await user.click(
      await screen.findByRole('button', { name: 'Open Board task' }),
    );
    expect(onSelectTask).toHaveBeenCalledWith('board-task');
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Move Board task to' }),
      'ready',
    );
    expect(api.command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.transition',
        payload: expect.objectContaining({
          taskId: 'board-task',
          expectedRevision: 1,
          nextState: 'ready',
        }),
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Open Board task' }));
    await user.click(screen.getByRole('button', { name: 'Open Session A' }));
    expect(
      screen.getByRole('main', { name: 'Session workspace' }),
    ).toBeDefined();
  });

  it('saves developer instructions with the current project revision and disables them when disconnected', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(snapshot);
    store.setConnectionHealth('connected');
    const api = createApi();
    api.projectSnapshot.mockResolvedValue({
      protocolVersion: 1,
      project,
      tasks: [],
      attempts: [],
      transitions: [],
      repairs: [],
      cursor: 1,
    });
    render(<App store={store} api={api} />);

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p1');
    const instructions = await screen.findByLabelText('Developer instructions');
    await user.clear(instructions);
    await user.type(instructions, 'Run focused web tests.');
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));

    await waitFor(() =>
      expect(api.command).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'project.developer_instructions.update',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            content: 'Run focused web tests.',
            actor: taskActorSchema.parse({
              type: 'human',
              id: 'operator',
              displayName: 'Operator',
            }),
          },
        }),
      ),
    );

    store.setConnectionHealth('disconnected');
    await waitFor(() => expect(instructions).toBeDisabled());
  });

  it('does not carry a pending developer-instruction save into a switched project', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<{
      protocolVersion: 1;
      commandType: string;
      result: Record<string, never>;
      warnings: [];
    }>();
    const store = createMeshStore(crossProjectSnapshot);
    store.setConnectionHealth('connected');
    const api = createApi();
    api.projectSnapshot.mockImplementation((projectId) =>
      Promise.resolve({
        protocolVersion: 1,
        project: projectId === 'p1' ? project : projectB,
        tasks: [],
        attempts: [],
        transitions: [],
        repairs: [],
        cursor: 1,
      }),
    );
    api.command.mockImplementation((command) =>
      command.type === 'project.developer_instructions.update'
        ? pendingSave.promise
        : Promise.resolve({
            protocolVersion: 1,
            commandType: command.type,
            result: {},
            warnings: [],
          }),
    );
    render(<App store={store} api={api} />);

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p1');
    const projectAInstructions = await screen.findByLabelText(
      'Developer instructions',
    );
    await user.type(projectAInstructions, 'Pending A.');
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(
      screen.getByRole('button', { name: 'Saving instructions…' }),
    ).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p2');
    const projectBInstructions = await screen.findByLabelText(
      'Developer instructions',
    );
    expect(projectBInstructions).toHaveValue('Project B instructions.');
    expect(projectBInstructions).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Saving instructions…' }),
    ).toBeNull();

    pendingSave.reject(new Error('Project A save failed.'));
    await waitFor(() =>
      expect(screen.queryByText('Project A save failed.')).toBeNull(),
    );
  });

  it('keeps an archived project board read-only and restores it explicitly', async () => {
    const user = userEvent.setup();
    const archivedStore = createMeshStore({
      ...snapshot,
      projects: [
        {
          ...project,
          archivedAt: '2026-08-25T00:00:00.000Z',
          revision: 2,
        },
      ],
    });
    const api = createApi();
    api.projectSnapshot.mockResolvedValue({
      protocolVersion: 1,
      project: {
        ...project,
        archivedAt: '2026-08-25T00:00:00.000Z',
        revision: 2,
      },
      tasks: [boardTask],
      attempts: [],
      transitions: [],
      repairs: [],
      cursor: 0,
    });
    render(<App store={archivedStore} api={api} />);

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p1');
    const board = screen.getByRole('region', { name: 'Mesh board' });
    const readOnlyDescription = screen.getByText(/read-only until restored/i);
    expect(board).toHaveAttribute('aria-describedby', readOnlyDescription.id);
    expect(
      within(board).queryByText('Board tasks will appear here.'),
    ).toBeNull();
    expect(
      within(board).getByRole('combobox', { name: 'Move Board task to' }),
    ).toBeDisabled();
    expect(
      within(board).getByLabelText('Developer instructions'),
    ).toBeDisabled();
    expect(
      within(board).getByRole('button', { name: 'Restore project' }),
    ).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Restore project' }));
    await waitFor(() =>
      expect(api.command).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'project.restore',
          payload: expect.objectContaining({
            projectId: 'p1',
            expectedRevision: 2,
          }),
        }),
      ),
    );
    archivedStore.replaceProjectSnapshot({
      protocolVersion: 1,
      project: { ...project, revision: 3 },
      tasks: [],
      attempts: [],
      transitions: [],
      repairs: [],
      cursor: 1,
    });
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Mesh board' }),
      ).not.toHaveAttribute('aria-describedby'),
    );
    expect(
      screen.queryByRole('button', { name: 'Restore project' }),
    ).toBeNull();
  });

  it('loads the selected project snapshot before showing its board', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(crossProjectSnapshot);
    const api = createApi();
    api.projectSnapshot.mockResolvedValue({
      protocolVersion: 1,
      project: projectB,
      tasks: [],
      attempts: [],
      transitions: [],
      repairs: [],
      cursor: 3,
    });
    render(<App store={store} api={api} />);

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p2');

    await waitFor(() => expect(api.projectSnapshot).toHaveBeenCalledWith('p2'));
    expect(screen.getByRole('region', { name: 'Other board' })).toBeDefined();
  });

  it('keeps the current board visible until a switched project snapshot resolves', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(crossProjectSnapshot);
    const api = createApi();
    const nextProject = deferred<{
      protocolVersion: 1;
      project: typeof projectB;
      tasks: [];
      attempts: [];
      transitions: [];
      repairs: [];
      cursor: number;
    }>();
    api.projectSnapshot
      .mockResolvedValueOnce({
        protocolVersion: 1,
        project,
        tasks: [],
        attempts: [],
        transitions: [],
        repairs: [],
        cursor: 1,
      })
      .mockImplementationOnce(() => nextProject.promise);
    render(<App store={store} api={api} />);

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p1');
    expect(
      await screen.findByRole('region', { name: 'Mesh board' }),
    ).toBeDefined();
    await user.selectOptions(screen.getByLabelText('Selected project'), 'p2');

    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading Other project…',
    );
    expect(screen.getByRole('region', { name: 'Mesh board' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Other board' })).toBeNull();

    nextProject.resolve({
      protocolVersion: 1,
      project: projectB,
      tasks: [],
      attempts: [],
      transitions: [],
      repairs: [],
      cursor: 2,
    });
    expect(
      await screen.findByRole('region', { name: 'Other board' }),
    ).toBeDefined();
    expect(api.projectSnapshot).toHaveBeenLastCalledWith('p2');
  });

  it('shows a retryable board-local error when a project snapshot rejects', async () => {
    const user = userEvent.setup();
    const store = createMeshStore(crossProjectSnapshot);
    const api = createApi();
    api.projectSnapshot
      .mockRejectedValueOnce(new Error('Project snapshot is unavailable'))
      .mockResolvedValueOnce({
        protocolVersion: 1,
        project: projectB,
        tasks: [],
        attempts: [],
        transitions: [],
        repairs: [],
        cursor: 2,
      });
    render(<App store={store} api={api} />);

    await user.selectOptions(screen.getByLabelText('Selected project'), 'p2');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project snapshot is unavailable',
    );
    expect(screen.queryByRole('region', { name: 'Other board' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry project' }));

    expect(
      await screen.findByRole('region', { name: 'Other board' }),
    ).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.projectSnapshot).toHaveBeenCalledTimes(2);
  });
});

const deferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const project = {
  id: 'p1',
  displayName: 'Mesh',
  repositoryPath: '/mesh',
  revision: 1,
  discoveredAt: '2026-08-24T00:00:00.000Z',
  discoveryMetadata: {},
  developerInstructions: {
    content: '',
    revision: 1,
    updatedAt: '2026-08-24T00:00:00.000Z',
    updatedBy: null,
  },
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

const boardTask = taskSchema.parse({
  id: 'board-task',
  projectId: 'p1',
  title: 'Board task',
  description: 'Render the task board.',
  acceptanceCriteria: ['The board is visible.'],
  priority: 'high',
  rank: 'a',
  lifecycleState: 'backlog',
  labels: ['web'],
  notes: '',
  blocked: null,
  revision: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
});
const boardAttempt = taskAttemptSchema.parse({
  id: 'board-attempt',
  taskId: boardTask.id,
  sessionId: session.id,
  ordinal: 1,
  source: 'linked',
  actor: taskActorSchema.parse({ type: 'human', id: 'operator' }),
  createdAt: '2026-08-24T00:00:00.000Z',
  unlinkedAt: null,
  unlinkedBy: null,
  unlinkReason: null,
});

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
  developerInstructions: {
    ...project.developerInstructions,
    content: 'Project B instructions.',
  },
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
  projectSnapshot: vi.fn().mockResolvedValue({
    protocolVersion: 1,
    project,
    tasks: [],
    attempts: [],
    transitions: [],
    repairs: [],
    cursor: 0,
  }),
  discover: vi.fn(),
});
