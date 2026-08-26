import type {
  ProjectEvent,
  ProjectSnapshot,
  ServerMessage,
  SessionSnapshot,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { MeshSocket } from './socket';
import { createResyncCoordinator } from '../state/resync';
import { createMeshStore } from '../state/store';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.onclose?.();
  }

  open() {
    this.onopen?.();
  }

  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }
}

const healthMessage: ServerMessage = {
  protocolVersion: 1,
  type: 'connection.health',
  payload: { status: 'connected', observedAt: '2026-08-24T00:00:00.000Z' },
};

const project = {
  id: 'project-1',
  displayName: 'Project one',
  repositoryPath: 'C:/code/project-one',
  repositoryIdentity: 'project-one',
  discoveredAt: '2026-08-24T00:00:00.000Z',
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  archivedAt: null,
  discoveryMetadata: {},
  revision: 1,
};

const otherProject = {
  ...project,
  id: 'project-2',
  displayName: 'Project two',
};

const sessionSnapshot = {
  protocolVersion: 1,
  projects: [project, otherProject],
  workspaces: [],
  sessions: [],
  events: [],
  pendingApprovals: [],
  lastSequenceBySession: { 'session-1': 4 },
  layouts: [],
} satisfies SessionSnapshot;

const refreshedProjectSnapshot = {
  protocolVersion: 1,
  project,
  tasks: [],
  attempts: [],
  transitions: [],
  repairs: [],
  cursor: 3,
} satisfies ProjectSnapshot;

const nextProjectEvent: ProjectEvent = {
  protocolVersion: 1,
  id: 'project-event-4',
  projectId: project.id,
  sequence: 4,
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'task.changed',
  payload: {
    task: {
      id: 'task-1',
      projectId: project.id,
      title: 'Task one',
      description: '',
      acceptanceCriteria: [],
      priority: 'normal',
      rank: 'a',
      lifecycleState: 'backlog',
      labels: [],
      notes: '',
      blocked: null,
      revision: 1,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
  },
};

describe('MeshSocket', () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  it('subscribes with current cursors and delivers only contract-valid frames', () => {
    const messages: ServerMessage[] = [];
    const diagnostics: string[] = [];
    const options = {
      url: 'ws://mesh.test/api/realtime',
      webSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      cursors: () => ({ 'session-1': 4 }),
      projectCursors: () => ({ 'project-1': 9 }),
      onMessage: (message) => messages.push(message),
      onDiagnostic: (message) => diagnostics.push(message),
    };
    const socket = new MeshSocket(options);

    socket.connect();
    const connection = FakeSocket.instances[0];
    connection.open();
    connection.receive(healthMessage);
    connection.receive({
      protocolVersion: 1,
      type: 'events',
      payload: { events: [{}] },
    });

    expect(JSON.parse(connection.sent[0])).toEqual({
      protocolVersion: 1,
      type: 'subscribe',
      cursors: { 'session-1': 4 },
      projectCursors: { 'project-1': 9 },
    });
    expect(messages).toEqual([healthMessage]);
    expect(diagnostics).toHaveLength(1);
    socket.close();
  });

  it('refreshes only the project named by a project resync frame', async () => {
    const refreshed: string[] = [];
    const options = {
      url: 'ws://mesh.test/api/realtime',
      webSocket: (url: string) => new FakeSocket(url) as unknown as WebSocket,
      cursors: () => ({}),
      onMessage: () => undefined,
      onDiagnostic: () => undefined,
      projectResync: async (projectId: string) => {
        refreshed.push(projectId);
      },
    };
    const socket = new MeshSocket(options);

    socket.connect();
    const connection = FakeSocket.instances[0];
    connection.open();
    connection.receive({
      protocolVersion: 1,
      type: 'project.resync_required',
      payload: { projectId: 'project-1', reason: 'event_sequence_gap' },
    });

    await Promise.resolve();

    expect(refreshed).toEqual(['project-1']);
    socket.close();
  });

  it('resubscribes after project refresh with the new cursor before applying the next project event', async () => {
    const store = createMeshStore(sessionSnapshot);
    let resolveProjectSnapshot: (snapshot: ProjectSnapshot) => void;
    const pendingProjectSnapshot = new Promise<ProjectSnapshot>((resolve) => {
      resolveProjectSnapshot = resolve;
    });
    let projectSnapshotRequests = 0;
    const coordinator = createResyncCoordinator(
      {
        snapshot: async () => sessionSnapshot,
        projectSnapshot: async () => {
          projectSnapshotRequests += 1;
          return pendingProjectSnapshot;
        },
      },
      store,
    );
    let eventQueue = Promise.resolve();
    let reconnects = 0;
    const socket = new MeshSocket({
      url: 'ws://mesh.test/api/realtime',
      webSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      cursors: () =>
        store.state.lastSequenceBySession.get({ noproxy: true }) as Record<
          string,
          number
        >,
      projectCursors: () =>
        store.state.projectCursors.get({ noproxy: true }) as Record<
          string,
          number
        >,
      onMessage: (message) => {
        if (message.type === 'project.event') {
          eventQueue = eventQueue.then(async () => {
            await coordinator.applyProjectEvent(message.payload.event);
          });
        }
      },
      onDiagnostic: () => undefined,
      onReconnect: () => {
        reconnects += 1;
      },
      projectResync: coordinator.refreshProject,
    });

    socket.connect();
    const firstConnection = FakeSocket.instances[0];
    firstConnection.open();
    firstConnection.receive({
      protocolVersion: 1,
      type: 'project.resync_required',
      payload: { projectId: project.id, reason: 'event_sequence_gap' },
    });

    await vi.waitFor(() => expect(projectSnapshotRequests).toBe(1));
    resolveProjectSnapshot!(refreshedProjectSnapshot);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));

    const refreshedConnection = FakeSocket.instances[1];
    refreshedConnection.open();
    expect(JSON.parse(refreshedConnection.sent[0])).toEqual({
      protocolVersion: 1,
      type: 'subscribe',
      cursors: { 'session-1': 4 },
      projectCursors: { [project.id]: 3, [otherProject.id]: 0 },
    });
    expect(reconnects).toBe(0);

    refreshedConnection.receive({
      protocolVersion: 1,
      type: 'project.event',
      payload: { event: nextProjectEvent },
    });
    await eventQueue;

    expect(store.state.projectCursors[project.id].get()).toBe(4);
    expect(store.state.tasksById['task-1'].get()).toMatchObject({
      id: 'task-1',
      projectId: project.id,
    });
    socket.close();
  });

  it('requests snapshot replacement when the server requires resync', async () => {
    const store = createMeshStore({
      protocolVersion: 1,
      projects: [],
      workspaces: [],
      sessions: [],
      events: [],
      pendingApprovals: [],
      lastSequenceBySession: {},
      layouts: [],
    });
    store.state.promptDrafts.set({ 'session-1': 'draft survives resync' });
    let requests = 0;
    const coordinator = createResyncCoordinator(
      {
        snapshot: async () => {
          requests += 1;
          return {
            protocolVersion: 1,
            projects: [],
            workspaces: [],
            sessions: [],
            events: [],
            pendingApprovals: [],
            lastSequenceBySession: { 'session-1': 8 },
            layouts: [],
          };
        },
      },
      store,
    );
    const socket = new MeshSocket({
      url: 'ws://mesh.test/api/realtime',
      webSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      cursors: () => ({}),
      onMessage: () => undefined,
      onDiagnostic: () => undefined,
      resync: coordinator.refresh,
    });

    socket.connect();
    const connection = FakeSocket.instances[0];
    connection.open();
    connection.receive({
      protocolVersion: 1,
      type: 'resync.required',
      payload: { sessionId: 'session-1', reason: 'retention expired' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toBe(1);
    expect(store.state.lastSequenceBySession['session-1'].get()).toBe(8);
    expect(store.state.promptDrafts['session-1'].get()).toBe(
      'draft survives resync',
    );
    socket.close();
  });
});
