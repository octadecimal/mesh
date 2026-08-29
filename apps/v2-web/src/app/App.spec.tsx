import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  V2_PROTOCOL_VERSION,
  runtimeEventSchema,
  v2ProjectSnapshotSchema,
  v2SystemSnapshotSchema,
  workerExecutionSchema,
  type ServerRealtimeMessage,
  type V2CommandEnvelope,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { V2HttpError, type V2Api } from '../api/client';
import type { WebSocketLike } from '../api/socket';
import { App, type AppHistory, type AppLocation } from './App';

const projectId = '11111111-1111-4111-8111-111111111111';
const executionId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';

const project = {
  id: projectId,
  displayName: 'Todo',
  repositoryIdentity: 'todo-identity',
  repositoryPath: 'C:\\repos\\todo',
  gitCommonDirectory: 'C:\\repos\\todo\\.git',
  headCommit: 'a'.repeat(40),
  revision: 1,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

const execution = workerExecutionSchema.parse({
  id: executionId,
  projectId,
  profileId,
  profileRevision: 1,
  assignment: {
    kind: 'foundation-check',
    projectId,
    title: 'Todo foundation worker',
    instructions: 'Inspect the Todo repository.',
    fakeScenario: 'todo-foundation-v1',
  },
  profileSnapshot: {
    profileId,
    projectId: null,
    profileRevision: 1,
    baseProfileId: null,
    baseRevision: null,
    document: {
      apiVersion: 'mesh.dev/v1alpha1',
      kind: 'WorkerProfile',
      metadata: {
        name: 'todo-worker',
        displayName: 'Todo worker',
        scope: 'global',
      },
      spec: {
        assignmentKinds: ['foundation-check'],
        preferredRuntime: { harness: 'fake', model: 'deterministic' },
        alternatives: [],
        requiredCapabilities: ['execution.stream'],
        skills: {
          preferred: [{ id: 'test-driven-development' }],
          required: [{ id: 'verification-before-completion' }],
        },
        instructions: 'Inspect.',
        outputSchema: 'mesh.dev/foundation-report/v1',
      },
    },
    digest: 'b'.repeat(64),
  },
  skillRequests: {
    preferred: [{ id: 'test-driven-development' }],
    required: [{ id: 'verification-before-completion' }],
  },
  resolvedSkills: [
    {
      requested: { id: 'test-driven-development' },
      mode: 'preferred',
      resolution: {
        kind: 'mesh-native-fallback',
        workflow: 'mesh.foundation-check/v1',
      },
    },
    {
      requested: { id: 'verification-before-completion' },
      mode: 'required',
      resolution: { kind: 'unavailable', reason: 'Not installed' },
    },
  ],
  capabilitySnapshot: {
    adapterId: 'fake',
    capabilities: ['execution.stream'],
    skills: [],
    exactResume: true,
  },
  adapterId: 'fake',
  model: 'deterministic',
  nativeHandle: 'opaque-handle',
  lifecycle: 'running',
  revision: 4,
  lastAdapterCursor: 5,
  lastRuntimeSequence: 5,
  replacementForExecutionId: null,
  failure: null,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:05.000Z',
  endedAt: null,
});

const systemSnapshot = v2SystemSnapshotSchema.parse({
  protocolVersion: V2_PROTOCOL_VERSION,
  health: { status: 'ok' },
  projects: [project],
  globalProfiles: [
    {
      profileId,
      projectId: null,
      scope: 'global',
      name: 'todo-worker',
      displayName: 'Todo worker',
      approvedRevision: 1,
    },
  ],
});

const projectSnapshot = v2ProjectSnapshotSchema.parse({
  protocolVersion: V2_PROTOCOL_VERSION,
  project,
  profiles: [execution.profileSnapshot],
  executions: [execution],
  attentionItems: [
    {
      executionId,
      code: 'required_skill_unavailable',
      message: 'Required verification skill is unavailable.',
    },
  ],
  cursors: { domain: 3, runtime: 5 },
});

class FakeLocation extends EventTarget implements AppLocation {
  constructor(
    public pathname = '/',
    public protocol = 'http:',
    public host = 'mesh.test',
  ) {
    super();
  }
}

const navigation = (pathname = '/') => {
  const location = new FakeLocation(pathname);
  const history: AppHistory = {
    pushState: vi.fn((_, __, url) => {
      location.pathname = String(url);
    }),
  };
  return { location, history };
};

class FakeSocket extends EventTarget implements WebSocketLike {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: string[] = [];
  close = vi.fn(() => this.dispatchEvent(new Event('close')));

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.dispatchEvent(new Event('open'));
  }

  message(message: ServerRealtimeMessage) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(message) }),
    );
  }

  disconnect() {
    this.dispatchEvent(new Event('close'));
  }
}

const createSocketFactory = () => {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const socketFactory = vi.fn((url: string) => {
    urls.push(url);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  return { socketFactory, sockets, urls };
};

const defaultCommand = async (envelope: V2CommandEnvelope) => {
  if (envelope.command.type === 'project.register') {
    return {
      ok: true as const,
      commandType: 'project.register' as const,
      project,
    };
  }
  if (envelope.command.type === 'worker_execution.interrupt') {
    return {
      ok: true as const,
      commandType: 'worker_execution.interrupt' as const,
      execution,
    };
  }
  return {
    ok: false as const,
    commandType: envelope.command.type,
    error: {
      code: 'invalid_request' as const,
      message: 'Unsupported test command.',
    },
  };
};

const createApi = () => {
  const api: V2Api = {
    systemSnapshot: vi.fn(async () => systemSnapshot),
    projectSnapshot: vi.fn(async () => projectSnapshot),
    command: vi.fn(defaultCommand),
  };
  return api;
};

const renderApp = ({
  pathname = '/',
  api = createApi(),
}: {
  pathname?: string;
  api?: V2Api;
} = {}) => {
  const { location, history } = navigation(pathname);
  const sockets = createSocketFactory();
  const view = render(
    <App
      api={api}
      socketFactory={sockets.socketFactory}
      location={location}
      history={history}
    />,
  );
  return { api, location, history, ...sockets, ...view };
};

const subscribed = (): ServerRealtimeMessage => ({
  type: 'v2.subscribed',
  protocolVersion: V2_PROTOCOL_VERSION,
  projectId,
  cursors: projectSnapshot.cursors,
});

afterEach(() => vi.restoreAllMocks());

describe('App', () => {
  it('registers a repository, navigates from the parsed success, and subscribes from snapshot cursors', async () => {
    const user = userEvent.setup();
    const { api, history, sockets, urls } = renderApp();

    await user.type(
      await screen.findByLabelText('Repository path'),
      'C:\\repos\\todo',
    );
    await user.click(
      screen.getByRole('button', { name: 'Add and select project' }),
    );

    expect(history.pushState).toHaveBeenCalledWith(
      null,
      '',
      `/projects/${projectId}`,
    );
    expect(await screen.findByText('Todo foundation worker')).toBeVisible();
    expect(api.projectSnapshot).toHaveBeenCalledWith(
      projectId,
      expect.any(AbortSignal),
    );
    expect(urls).toEqual(['ws://mesh.test/api/v2/realtime']);

    act(() => sockets[0]?.open());
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toMatchObject({
      projectId,
      cursors: { domain: 3, runtime: 5 },
    });
  });

  it('loads a direct project URL from system and project truth and rejects unknown projects locally', async () => {
    const direct = renderApp({ pathname: `/projects/${projectId}` });
    expect(await screen.findByRole('heading', { name: 'Todo' })).toBeVisible();
    expect(direct.api.systemSnapshot).toHaveBeenCalledOnce();
    expect(direct.api.projectSnapshot).toHaveBeenCalledWith(
      projectId,
      expect.any(AbortSignal),
    );
    direct.unmount();

    const unknownId = '99999999-9999-4999-8999-999999999999';
    const unknown = renderApp({ pathname: `/projects/${unknownId}` });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unknown project',
    );
    expect(unknown.api.projectSnapshot).not.toHaveBeenCalled();
    expect(unknown.socketFactory).not.toHaveBeenCalled();
  });

  it('deselects and follows popstate without retaining the old project connection', async () => {
    const user = userEvent.setup();
    const app = renderApp({ pathname: `/projects/${projectId}` });
    expect(await screen.findByRole('heading', { name: 'Todo' })).toBeVisible();
    expect(app.sockets).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Deselect project' }));
    expect(app.history.pushState).toHaveBeenCalledWith(null, '', '/');
    expect(
      await screen.findByRole('heading', { name: 'Choose a project' }),
    ).toBeVisible();
    expect(app.sockets[0]?.close).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Select Todo' }));
    expect(await screen.findByRole('heading', { name: 'Todo' })).toBeVisible();
    app.location.pathname = '/';
    act(() => app.location.dispatchEvent(new PopStateEvent('popstate')));
    expect(
      await screen.findByRole('heading', { name: 'Choose a project' }),
    ).toBeVisible();
    expect(app.sockets[1]?.close).toHaveBeenCalledOnce();
  });

  it('aborts a deferred registration when route ownership changes and ignores its late success', async () => {
    const user = userEvent.setup();
    let resolveCommand!: (
      result: Awaited<ReturnType<V2Api['command']>>,
    ) => void;
    const api = createApi();
    vi.mocked(api.command).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const app = renderApp({ api });

    await user.type(
      await screen.findByLabelText('Repository path'),
      'C:\\repos\\deferred',
    );
    await user.click(
      screen.getByRole('button', { name: 'Add and select project' }),
    );
    await waitFor(() => expect(api.command).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.command).mock.calls[0]?.[1];

    await user.click(screen.getByRole('button', { name: 'Select Todo' }));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    await user.click(
      await screen.findByRole('button', { name: 'Deselect project' }),
    );

    act(() =>
      resolveCommand({
        ok: true,
        commandType: 'project.register',
        project,
      }),
    );
    await waitFor(() => expect(app.history.pushState).toHaveBeenCalledTimes(2));
    expect(app.location.pathname).toBe('/');
  });

  it('aborts a deferred interrupt when its project route is deselected', async () => {
    const user = userEvent.setup();
    let resolveCommand!: (
      result: Awaited<ReturnType<V2Api['command']>>,
    ) => void;
    const api = createApi();
    vi.mocked(api.command).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const app = renderApp({ pathname: `/projects/${projectId}`, api });
    const interrupt = await screen.findByRole('button', {
      name: 'Interrupt execution',
    });
    act(() => {
      app.sockets[0]?.open();
      app.sockets[0]?.message(subscribed());
    });
    await user.click(interrupt);
    const signal = vi.mocked(api.command).mock.calls[0]?.[1];

    await user.click(screen.getByRole('button', { name: 'Deselect project' }));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    act(() =>
      resolveCommand({
        ok: true,
        commandType: 'worker_execution.interrupt',
        execution,
      }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Choose a project' }),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders selector loading, failure, and empty states with safe registration controls', async () => {
    let resolveSnapshot!: (snapshot: typeof systemSnapshot) => void;
    const api = createApi();
    vi.mocked(api.systemSnapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const loading = renderApp({ api });
    expect(screen.getByRole('status')).toHaveTextContent('Loading projects');
    expect(
      screen.getByRole('button', { name: 'Add and select project' }),
    ).toBeDisabled();
    act(() =>
      resolveSnapshot(
        v2SystemSnapshotSchema.parse({ ...systemSnapshot, projects: [] }),
      ),
    );
    expect(
      await screen.findByText('No projects have been added yet.'),
    ).toBeVisible();
    loading.unmount();

    const failedApi = createApi();
    vi.mocked(failedApi.systemSnapshot).mockRejectedValueOnce(
      new Error('Snapshot unavailable'),
    );
    renderApp({ api: failedApi });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Snapshot unavailable',
    );
    expect(
      screen.getByRole('button', { name: 'Add and select project' }),
    ).toBeDisabled();
  });

  it('renders root transport failure as disconnected and parsed HTTP failure as an error', async () => {
    const offlineApi = createApi();
    vi.mocked(offlineApi.systemSnapshot).mockRejectedValueOnce(
      new TypeError('Network unavailable'),
    );
    const offline = renderApp({ api: offlineApi });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Network unavailable',
      ),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add and select project' }),
    ).toBeDisabled();
    offline.unmount();

    const rejectedApi = createApi();
    vi.mocked(rejectedApi.systemSnapshot).mockRejectedValueOnce(
      new V2HttpError(503, 'internal_error', 'Snapshot rejected'),
    );
    renderApp({ api: rejectedApi });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Snapshot rejected',
    );
  });

  it('disables interruption while disconnected or stale and sends the exact running revision', async () => {
    const user = userEvent.setup();
    const disconnected = renderApp({ pathname: `/projects/${projectId}` });
    const button = await screen.findByRole('button', {
      name: 'Interrupt execution',
    });
    expect(button).toBeDisabled();

    act(() => {
      disconnected.sockets[0]?.open();
      disconnected.sockets[0]?.message(subscribed());
    });
    expect(button).toBeEnabled();
    act(() => disconnected.sockets[0]?.disconnect());
    expect(button).toBeDisabled();
    expect(
      screen.getByText('Reconnect before interrupting an execution.'),
    ).toBeVisible();
    disconnected.unmount();

    const app = renderApp({ pathname: `/projects/${projectId}` });
    const activeButton = await screen.findByRole('button', {
      name: 'Interrupt execution',
    });
    act(() => {
      app.sockets[0]?.open();
      app.sockets[0]?.message(subscribed());
    });

    act(() => {
      app.sockets[0]?.message({
        type: 'v2.runtime_event',
        protocolVersion: V2_PROTOCOL_VERSION,
        projectId,
        event: {
          id: '44444444-4444-4444-8444-444444444444',
          projectId,
          executionId,
          diagnosticId: '55555555-5555-4555-8555-555555555555',
          sequence: 7,
          adapterCursor: 7,
          occurredAt: '2026-08-28T00:00:07.000Z',
          type: 'worker_execution.output',
          payload: { text: 'gap' },
        },
      });
    });
    expect(activeButton).toBeDisabled();

    await waitFor(() => expect(app.sockets).toHaveLength(2));
    act(() => {
      app.sockets[1]?.open();
      app.sockets[1]?.message(subscribed());
    });
    expect(activeButton).toBeEnabled();
    await user.click(activeButton);
    await waitFor(() =>
      expect(apiInterruptEnvelope(app.api)).toMatchObject({
        command: {
          type: 'worker_execution.interrupt',
          projectId,
          executionId,
          expectedRevision: 4,
        },
      }),
    );
  });

  it('shows attention, fallback, required-skill, child activity, diagnostics, and inert future panes', async () => {
    const user = userEvent.setup();
    const app = renderApp({ pathname: `/projects/${projectId}` });
    expect(await screen.findByText('Preferred skill fallback')).toBeVisible();
    expect(screen.getByText('Required skill unavailable')).toBeVisible();
    expect(
      screen.getByText('Required verification skill is unavailable.'),
    ).toBeVisible();
    expect(screen.getAllByText('Available in a later milestone')).toHaveLength(
      3,
    );
    expect(
      screen.queryByRole('button', { name: /start|approve|create/i }),
    ).not.toBeInTheDocument();

    act(() =>
      app.sockets[0]?.message({
        type: 'v2.runtime_event',
        protocolVersion: V2_PROTOCOL_VERSION,
        projectId,
        event: {
          id: '44444444-4444-4444-8444-444444444444',
          projectId,
          executionId,
          diagnosticId: '55555555-5555-4555-8555-555555555555',
          sequence: 6,
          adapterCursor: 6,
          occurredAt: '2026-08-28T00:00:06.000Z',
          type: 'worker_execution.child_started',
          payload: { childId: 'child-1', title: 'Inspect package layout' },
        },
      }),
    );
    expect(await screen.findByText('Inspect package layout')).toBeVisible();
    await user.click(screen.getByText('Diagnostics'));
    expect(
      screen.getByText('55555555-5555-4555-8555-555555555555'),
    ).toBeVisible();
  });

  it('shows runtime completion, output, child, and adapter diagnostics before domain lifecycle catches up', async () => {
    const app = renderApp({ pathname: `/projects/${projectId}` });
    expect(await screen.findByText('Todo foundation worker')).toBeVisible();

    const runtimeEvent = (
      sequence: number,
      event: Pick<
        Extract<ServerRealtimeMessage, { type: 'v2.runtime_event' }>['event'],
        'type' | 'payload'
      >,
    ) => {
      act(() =>
        app.sockets[0]?.message({
          type: 'v2.runtime_event',
          protocolVersion: V2_PROTOCOL_VERSION,
          projectId,
          event: runtimeEventSchema.parse({
            id: `44444444-4444-4444-8444-${String(sequence).padStart(12, '0')}`,
            projectId,
            executionId,
            diagnosticId: '55555555-5555-4555-8555-555555555555',
            sequence,
            adapterCursor: sequence,
            occurredAt: `2026-08-28T00:00:${String(sequence).padStart(2, '0')}.000Z`,
            ...event,
          }),
        }),
      );
    };

    runtimeEvent(6, {
      type: 'worker_execution.child_started',
      payload: { childId: 'todo-check', title: 'Todo check' },
    });
    runtimeEvent(7, {
      type: 'worker_execution.output',
      payload: { text: 'Inspecting Todo repository.' },
    });
    runtimeEvent(8, {
      type: 'worker_execution.adapter_failed',
      payload: { code: 'fake_failure', message: 'Harness failed.' },
    });
    runtimeEvent(9, {
      type: 'worker_execution.completed',
      payload: { outcome: 'completed' },
    });

    const activity = await screen.findByRole('list', {
      name: 'Runtime activity events',
    });
    expect(
      within(activity).getByText('Child started: Todo check'),
    ).toBeVisible();
    expect(
      within(activity).getByText('Inspecting Todo repository.'),
    ).toBeVisible();
    expect(
      within(activity).getByText(
        'Adapter failed: fake_failure — Harness failed.',
      ),
    ).toBeVisible();
    expect(
      within(activity).getByText('Execution completed: completed'),
    ).toBeVisible();
    const executionArticle = screen.getByRole('article', {
      name: 'Todo foundation worker',
    });
    expect(within(executionArticle).getByRole('status')).toHaveTextContent(
      'running',
    );

    act(() =>
      app.sockets[0]?.message({
        type: 'v2.domain_event',
        protocolVersion: V2_PROTOCOL_VERSION,
        projectId,
        event: {
          id: '77777777-7777-4777-8777-777777777777',
          projectId,
          sequence: 4,
          occurredAt: '2026-08-28T00:00:10.000Z',
          type: 'worker_execution.lifecycle_changed',
          payload: {
            execution: {
              ...execution,
              lifecycle: 'completed',
              revision: 5,
              lastAdapterCursor: 9,
              lastRuntimeSequence: 9,
              updatedAt: '2026-08-28T00:00:10.000Z',
              endedAt: '2026-08-28T00:00:10.000Z',
            },
          },
        },
      }),
    );
    await waitFor(() =>
      expect(within(executionArticle).getByRole('status')).toHaveTextContent(
        'completed',
      ),
    );
  });

  it('retains a UUID for unknown transport retry, replaces it for changed intent, and retires parsed failures', async () => {
    const user = userEvent.setup();
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ];
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      const id = ids.shift();
      if (!id) throw new Error('Unexpected UUID request.');
      return id;
    });
    const api = createApi();
    vi.mocked(api.command)
      .mockRejectedValueOnce(new Error('Malformed transport response'))
      .mockRejectedValueOnce(new Error('Still unavailable'))
      .mockResolvedValueOnce({
        ok: false,
        commandType: 'project.register',
        error: {
          code: 'repository_invalid',
          message: 'Repository is invalid.',
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        commandType: 'project.register',
        error: {
          code: 'repository_invalid',
          message: 'Repository is invalid.',
        },
      });
    const app = renderApp({ api });
    const input = await screen.findByLabelText('Repository path');
    const submit = screen.getByRole('button', {
      name: 'Add and select project',
    });

    await user.type(input, 'C:\\repos\\first');
    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Malformed transport response',
    );
    await user.click(submit);
    expect(api.command).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: idsForCalls(api)[0] }),
      expect.any(AbortSignal),
    );
    expect(idsForCalls(api)[0]).toBe(idsForCalls(api)[1]);

    await user.clear(input);
    await user.type(input, 'C:\\repos\\second');
    await user.click(submit);
    expect(idsForCalls(api)[2]).not.toBe(idsForCalls(api)[1]);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Repository is invalid.',
    );
    expect(app.history.pushState).not.toHaveBeenCalled();

    await user.click(submit);
    expect(idsForCalls(api)[3]).not.toBe(idsForCalls(api)[2]);
  });

  it('retires a UUID after parsed HTTP rejection and disables mutations after an audit barrier response', async () => {
    const user = userEvent.setup();
    const ids = [
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ];
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      const id = ids.shift();
      if (!id) throw new Error('Unexpected UUID request.');
      return id;
    });
    const api = createApi();
    vi.mocked(api.command)
      .mockRejectedValueOnce(
        new V2HttpError(503, 'internal_error', 'Command service unavailable'),
      )
      .mockRejectedValueOnce(
        new V2HttpError(503, 'audit_barrier_tripped', 'Audit writes failed.'),
      );
    renderApp({ api });
    const input = await screen.findByLabelText('Repository path');
    const submit = screen.getByRole('button', {
      name: 'Add and select project',
    });
    await user.type(input, 'C:\\repos\\todo');

    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Command service unavailable',
    );
    await user.click(submit);
    expect(idsForCalls(api)[1]).not.toBe(idsForCalls(api)[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Audit writes failed.',
    );
    expect(submit).toBeDisabled();
  });

  it('disables all interrupt controls when any projected execution is not running or audit health is unsafe', async () => {
    const terminalApi = createApi();
    vi.mocked(terminalApi.projectSnapshot).mockResolvedValueOnce(
      v2ProjectSnapshotSchema.parse({
        ...projectSnapshot,
        executions: [
          execution,
          {
            ...execution,
            id: '66666666-6666-4666-8666-666666666666',
            lifecycle: 'completed',
            revision: 5,
            endedAt: '2026-08-28T00:00:08.000Z',
          },
        ],
      }),
    );
    const terminal = renderApp({
      pathname: `/projects/${projectId}`,
      api: terminalApi,
    });
    expect(await screen.findAllByText('Todo foundation worker')).toHaveLength(
      2,
    );
    act(() => {
      terminal.sockets[0]?.open();
      terminal.sockets[0]?.message(subscribed());
    });
    expect(
      screen
        .getAllByRole('button', { name: 'Interrupt execution' })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    terminal.unmount();

    const unsafeApi = createApi();
    vi.mocked(unsafeApi.systemSnapshot).mockResolvedValueOnce(
      v2SystemSnapshotSchema.parse({
        ...systemSnapshot,
        health: {
          status: 'audit_barrier_tripped',
          error: {
            code: 'audit_barrier_tripped',
            message: 'Audit writes failed.',
          },
        },
      }),
    );
    const unsafe = renderApp({
      pathname: `/projects/${projectId}`,
      api: unsafeApi,
    });
    await screen.findByText('Todo foundation worker');
    act(() => {
      unsafe.sockets[0]?.open();
      unsafe.sockets[0]?.message(subscribed());
    });
    expect(
      screen.getByRole('button', { name: 'Interrupt execution' }),
    ).toBeDisabled();
  });
});

function idsForCalls(api: V2Api) {
  return vi
    .mocked(api.command)
    .mock.calls.map(([envelope]) => envelope.idempotencyKey);
}

function apiInterruptEnvelope(api: V2Api) {
  return vi
    .mocked(api.command)
    .mock.calls.map(([envelope]) => envelope)
    .find(({ command }) => command.type === 'worker_execution.interrupt');
}
