import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  PM_DISCOVERY_REPORT_SCHEMA,
  V2_PROTOCOL_VERSION,
  planningCycleViewSchema,
  resolvedWorkerProfileSnapshotSchema,
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

const pmProfile = resolvedWorkerProfileSnapshotSchema.parse({
  ...execution.profileSnapshot,
  profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  document: {
    ...execution.profileSnapshot.document,
    metadata: {
      ...execution.profileSnapshot.document.metadata,
      name: 'project-manager',
      displayName: 'Project manager',
    },
    spec: {
      ...execution.profileSnapshot.document.spec,
      assignmentKinds: ['pm_discovery'],
      outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
    },
  },
  digest: 'c'.repeat(64),
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
  planningCycles: [],
  planningHistoryTruncated: false,
  intentLedger: null,
  cursors: { domain: 3, runtime: 5 },
});

const terminalPlanningCycle = planningCycleViewSchema.parse({
  cycle: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    projectId,
    lifecycle: 'abandoned',
    revision: 2,
    profileId: pmProfile.profileId,
    profileRevision: pmProfile.profileRevision,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 0,
    activeExecutionId: null,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:01.000Z',
    endedAt: '2026-08-28T00:00:01.000Z',
  },
  turns: [],
  questions: [],
  proposals: [],
});

const activePlanningCycle = planningCycleViewSchema.parse({
  cycle: {
    ...terminalPlanningCycle.cycle,
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    lifecycle: 'awaiting_approval',
    revision: 4,
    latestProposalRevision: 1,
    updatedAt: '2026-08-28T00:00:04.000Z',
    endedAt: null,
  },
  turns: [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      projectId,
      planningCycleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ordinal: 1,
      actor: 'human',
      message: 'Plan Todo.',
      launchState: 'execution_bound',
      executionId,
      createdAt: '2026-08-28T00:00:02.000Z',
    },
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      projectId,
      planningCycleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ordinal: 2,
      actor: 'pm',
      message: 'Approve this proposal.',
      launchState: null,
      executionId,
      createdAt: '2026-08-28T00:00:03.000Z',
    },
  ],
  questions: [],
  proposals: [
    {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      projectId,
      planningCycleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      revision: 1,
      lifecycle: 'awaiting_approval',
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      summary: 'A durable Todo product.',
      projectIntent: {
        goal: 'Track Todo items.',
        targetUsers: ['Individuals'],
        desiredCapabilities: ['Add Todo items'],
        constraints: [],
        nonGoals: [],
        successConditions: ['Todo items can be completed'],
        rationale: 'The operator requested Todo.',
        provenance: [
          {
            kind: 'conversation_turn',
            turnId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            rationale: 'Initial request.',
          },
        ],
      },
      records: [],
      relationships: [],
      diff: {
        intentChanges: [],
        recordChanges: { create: 0, revise: 0, reuse: 0 },
        relationshipChanges: { added: [], removed: [] },
      },
      createdByTurnId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      createdByExecutionId: executionId,
      rejectionFeedback: null,
      createdAt: '2026-08-28T00:00:03.000Z',
      decidedAt: null,
    },
  ],
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
    runtimeReplay: vi.fn(async () => ({
      lowWater: projectSnapshot.cursors.runtime + 1,
      highWater: projectSnapshot.cursors.runtime,
      events: [],
    })),
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
  it('targets only the actual active cycle when terminal history is newer', async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.projectSnapshot = vi.fn(async () =>
      v2ProjectSnapshotSchema.parse({
        ...projectSnapshot,
        profiles: [...projectSnapshot.profiles, pmProfile],
        planningCycles: [terminalPlanningCycle, activePlanningCycle],
      }),
    );
    const app = renderApp({ pathname: `/projects/${projectId}`, api });
    expect(await screen.findByRole('heading', { name: 'Todo' })).toBeVisible();
    act(() => {
      app.sockets[0]?.open();
      app.sockets[0]?.message(subscribed());
    });

    await user.click(screen.getByRole('button', { name: 'Approve proposal' }));
    await waitFor(() => expect(api.command).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.command).mock.calls[0]?.[0].command).toMatchObject({
      type: 'planning_proposal.approve',
      planningCycleId: activePlanningCycle.cycle.id,
      expectedCycleRevision: activePlanningCycle.cycle.revision,
    });

    await user.click(screen.getByRole('button', { name: 'Reject proposal' }));
    await user.type(
      screen.getByLabelText('Rejection feedback'),
      'Keep it small.',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(api.command).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.command).mock.calls[1]?.[0].command).toMatchObject({
      type: 'planning_proposal.reject',
      planningCycleId: activePlanningCycle.cycle.id,
      expectedCycleRevision: activePlanningCycle.cycle.revision,
    });

    await user.click(screen.getByRole('button', { name: 'Abandon cycle' }));
    await waitFor(() => expect(api.command).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.command).mock.calls[2]?.[0].command).toMatchObject({
      type: 'planning_cycle.abandon',
      planningCycleId: activePlanningCycle.cycle.id,
      expectedCycleRevision: activePlanningCycle.cycle.revision,
    });
  });

  it('submits planning through the generic command API without optimistic transcript changes', async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.projectSnapshot = vi.fn(async () => ({
      ...projectSnapshot,
      profiles: [...projectSnapshot.profiles, pmProfile],
      planningCycles: [terminalPlanningCycle],
    }));
    const app = renderApp({ pathname: `/projects/${projectId}`, api });
    expect(await screen.findByRole('heading', { name: 'Todo' })).toBeVisible();
    act(() => {
      app.sockets[0]?.open();
      app.sockets[0]?.message(subscribed());
    });
    await user.selectOptions(
      screen.getByLabelText('Project manager profile'),
      pmProfile.profileId,
    );
    await user.type(
      screen.getByLabelText('Message to project manager'),
      'Plan a durable Todo product.',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(api.command).toHaveBeenCalledOnce());
    expect(api.command).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.submit_turn',
          projectId,
          expectedCycleRevision: null,
          profileId: pmProfile.profileId,
          profileRevision: pmProfile.profileRevision,
          message: 'Plan a durable Todo product.',
        },
      }),
      expect.any(AbortSignal),
    );
    expect(screen.getByLabelText('Message to project manager')).toHaveValue(
      'Plan a durable Todo product.',
    );
  });

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

  it('hydrates retained child, diagnostic, and completion activity on direct reload', async () => {
    const retained = [
      runtimeEventSchema.parse({
        id: '44444444-4444-4444-8444-000000000003',
        projectId,
        executionId,
        diagnosticId: '55555555-5555-4555-8555-555555555555',
        sequence: 3,
        adapterCursor: 3,
        occurredAt: '2026-08-28T00:00:03.000Z',
        type: 'worker_execution.child_started',
        payload: { childId: 'todo-check', title: 'Todo check' },
      }),
      runtimeEventSchema.parse({
        id: '44444444-4444-4444-8444-000000000004',
        projectId,
        executionId,
        diagnosticId: '55555555-5555-4555-8555-555555555555',
        sequence: 4,
        adapterCursor: 4,
        occurredAt: '2026-08-28T00:00:04.000Z',
        type: 'worker_execution.child_finished',
        payload: { childId: 'todo-check', outcome: 'completed' },
      }),
      runtimeEventSchema.parse({
        id: '44444444-4444-4444-8444-000000000005',
        projectId,
        executionId,
        diagnosticId: '55555555-5555-4555-8555-555555555555',
        sequence: 5,
        adapterCursor: 5,
        occurredAt: '2026-08-28T00:00:05.000Z',
        type: 'worker_execution.completed',
        payload: { outcome: 'completed' },
      }),
    ];
    const api = createApi();
    vi.mocked(api.runtimeReplay).mockImplementation(async (_, after) => ({
      lowWater: 3,
      highWater: 5,
      events: retained.filter(({ sequence }) => sequence > after),
    }));
    const app = renderApp({ pathname: `/projects/${projectId}`, api });

    expect(await screen.findByText('child.started')).toBeVisible();
    const child = screen.getByRole('list', {
      name: 'Child activity for Todo foundation worker',
    });
    expect(child).toHaveTextContent('Todo check completed');
    expect(screen.getByText('Execution completed')).toBeVisible();
    await userEvent.setup().click(screen.getByText('Diagnostics'));
    expect(
      screen.getByText('55555555-5555-4555-8555-555555555555'),
    ).toBeVisible();
    act(() => app.sockets[0]?.open());
    expect(JSON.parse(app.sockets[0]?.sent[0] ?? '{}')).toMatchObject({
      cursors: { domain: 3, runtime: 5 },
    });
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

  it('ignores a stale system snapshot after replacing the API', async () => {
    let resolveStale!: (snapshot: typeof systemSnapshot) => void;
    const staleApi = createApi();
    vi.mocked(staleApi.systemSnapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    const currentApi = createApi();
    vi.mocked(currentApi.systemSnapshot).mockResolvedValueOnce(
      v2SystemSnapshotSchema.parse({
        ...systemSnapshot,
        health: {
          status: 'audit_barrier_tripped',
          error: {
            code: 'audit_barrier_tripped',
            message: 'Current audit writes failed.',
          },
        },
        projects: [],
      }),
    );
    const app = renderApp({ api: staleApi });
    const staleSignal = vi.mocked(staleApi.systemSnapshot).mock.calls[0]?.[0];

    app.rerender(
      <App
        api={currentApi}
        socketFactory={app.socketFactory}
        location={app.location}
        history={app.history}
      />,
    );
    expect(
      await screen.findByText('No projects have been added yet.'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Add and select project' }),
    ).toBeDisabled();
    expect(staleSignal?.aborted).toBe(true);

    await act(async () => resolveStale(systemSnapshot));

    expect(screen.getByText('No projects have been added yet.')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Add and select project' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Select Todo' }),
    ).not.toBeInTheDocument();
  });

  it('disables interruption while disconnected or stale and sends the exact running revision', async () => {
    const user = userEvent.setup();
    const disconnected = renderApp({ pathname: `/projects/${projectId}` });
    const button = await screen.findByRole('button', {
      name: 'Interrupt execution',
    });
    expect(button).toBeDisabled();
    expect(
      screen.getAllByText('Connecting to project events.')[0],
    ).toBeVisible();
    expect(
      screen.queryByText('Reconnect before interrupting an execution.'),
    ).not.toBeInTheDocument();

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

  it('shows attention, activity, diagnostics, planning, and the Board placeholder', async () => {
    const user = userEvent.setup();
    const app = renderApp({ pathname: `/projects/${projectId}` });
    expect(await screen.findByText('Preferred skill fallback')).toBeVisible();
    expect(screen.getByText('Required skill unavailable')).toBeVisible();
    expect(
      screen.getByText('Required verification skill is unavailable.'),
    ).toBeVisible();
    expect(screen.getAllByText('Available in a later milestone')).toHaveLength(
      1,
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
    const childActivity = await screen.findByRole('list', {
      name: 'Child activity for Todo foundation worker',
    });
    expect(
      within(childActivity).getByText('Inspect package layout'),
    ).toBeVisible();
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
      name: 'Runtime activity for Todo foundation worker',
    });
    expect(within(activity).getByText('child.started')).toBeVisible();
    expect(within(activity).getByText('Todo check')).toBeVisible();
    expect(
      within(activity).getByText('Inspecting Todo repository.'),
    ).toBeVisible();
    expect(
      within(activity).getByText('Execution failed: Harness failed.'),
    ).toBeVisible();
    expect(within(activity).getByText('Execution completed')).toBeVisible();
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

  it('enables only running execution interrupts and disables all controls when audit health is unsafe', async () => {
    const user = userEvent.setup();
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
    const buttons = screen.getAllByRole('button', {
      name: 'Interrupt execution',
    });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
    await user.click(buttons[0]);
    expect(apiInterruptEnvelope(terminalApi)).toMatchObject({
      command: { expectedRevision: 4, executionId },
    });
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

  it('uses the accepted production V1 guidance route', async () => {
    renderApp();
    expect(
      await screen.findByRole('link', { name: 'V1 operating guidance' }),
    ).toHaveAttribute('href', '/guidance/v1-session-platform.md');
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
