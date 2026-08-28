import {
  V2_PROTOCOL_VERSION,
  type ServerRealtimeMessage,
  type V2ProjectSnapshot,
} from '@mesh/v2-contracts';

import { createV2Socket, type WebSocketLike } from './socket';
import { createV2Store } from '../state/store';

const projectId = '00000000-0000-4000-8000-000000000001';
const otherProjectId = '00000000-0000-4000-8000-000000000002';
const executionId = '00000000-0000-4000-8000-000000000003';
const runtimeId = '00000000-0000-4000-8000-000000000004';
const diagnosticId = '00000000-0000-4000-8000-000000000005';

class FakeSocket extends EventTarget implements WebSocketLike {
  static readonly OPEN = 1;
  readonly OPEN = FakeSocket.OPEN;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  close = vi.fn();

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.dispatchEvent(new Event('open'));
  }

  message(value: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(value) }),
    );
  }

  rawMessage(data: string) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

describe('createV2Socket', () => {
  it('sends both independent cursors in every reconnect hello', () => {
    const sockets: FakeSocket[] = [];
    let currentCursors = { domain: 3, runtime: 8 };
    const socket = createV2Socket({
      url: 'ws://mesh.test/api/v2/realtime',
      projectId,
      cursors: { domain: 3, runtime: 8 },
      cursorSource: { getCursors: () => currentCursors },
      dispatch: vi.fn(),
      socketFactory: () => {
        const created = new FakeSocket();
        sockets.push(created);
        return created;
      },
    });

    sockets[0]?.open();
    currentCursors = { domain: 4, runtime: 9 };
    socket.reconnect();
    sockets[1]?.open();

    const initial = JSON.stringify({
      type: 'v2.subscribe',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      cursors: { domain: 3, runtime: 8 },
    });
    const reconnected = JSON.stringify({
      type: 'v2.subscribe',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      cursors: { domain: 4, runtime: 9 },
    });
    expect(sockets.map(({ sent }) => sent)).toEqual([
      [initial],
      [reconnected],
    ]);
    expect(sockets[0]?.close).toHaveBeenCalledOnce();
  });

  it('dispatches retained replay and live runtime completion identically', () => {
    const sockets: FakeSocket[] = [];
    const dispatch = vi.fn();
    createV2Socket({
      url: 'ws://mesh.test/api/v2/realtime',
      projectId,
      cursors: { domain: 2, runtime: 5 },
      dispatch,
      socketFactory: () => {
        const created = new FakeSocket();
        sockets.push(created);
        return created;
      },
    });
    const completion: ServerRealtimeMessage = {
      type: 'v2.runtime_event',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      event: {
        id: runtimeId,
        projectId,
        executionId,
        diagnosticId,
        sequence: 6,
        adapterCursor: 6,
        occurredAt: '2026-08-28T00:00:06.000Z',
        type: 'worker_execution.completed',
        payload: { outcome: 'completed' },
      },
    };

    sockets[0]?.message(completion);
    sockets[0]?.message(completion);

    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: 'runtime.event',
      event: completion.event,
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: 'runtime.event',
      event: completion.event,
    });
  });

  it('fails closed on invalid payloads and project mismatches', () => {
    const sockets: FakeSocket[] = [];
    const dispatch = vi.fn();
    createV2Socket({
      url: 'ws://mesh.test/api/v2/realtime',
      projectId,
      cursors: { domain: 0, runtime: 0 },
      dispatch,
      socketFactory: () => {
        const created = new FakeSocket();
        sockets.push(created);
        return created;
      },
    });

    sockets[0]?.message({ unexpected: true });
    sockets[0]?.message({
      type: 'v2.resync_required',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId: otherProjectId,
      reason: 'project_mismatch',
    });

    expect(dispatch.mock.calls).toEqual([
      [{ type: 'resync.required', reason: 'invalid_payload' }],
      [{ type: 'resync.required', reason: 'project_mismatch' }],
    ]);
  });

  it('fails closed on malformed JSON syntax', () => {
    const sockets: FakeSocket[] = [];
    const dispatch = vi.fn();
    createV2Socket({
      url: 'ws://mesh.test/api/v2/realtime',
      projectId,
      cursors: { domain: 0, runtime: 0 },
      dispatch,
      socketFactory: () => {
        const created = new FakeSocket();
        sockets.push(created);
        return created;
      },
    });

    sockets[0]?.rawMessage('{"type":');

    expect(dispatch).toHaveBeenCalledWith({
      type: 'resync.required',
      reason: 'invalid_payload',
    });
  });

  it('projects replay and live completion once through the real store', () => {
    const sockets: FakeSocket[] = [];
    const store = createV2Store(projectId);
    const execution = {
      id: executionId,
      projectId,
      profileId: '00000000-0000-4000-8000-000000000006',
      profileRevision: 1,
      assignment: {
        kind: 'foundation-check' as const,
        projectId,
        title: 'Foundation',
        instructions: 'Verify foundation.',
        fakeScenario: 'todo-foundation-v1' as const,
      },
      profileSnapshot: {
        profileId: '00000000-0000-4000-8000-000000000006',
        projectId: null,
        profileRevision: 1,
        baseProfileId: null,
        baseRevision: null,
        document: {
          apiVersion: 'mesh.dev/v1alpha1' as const,
          kind: 'WorkerProfile' as const,
          metadata: {
            name: 'foundation',
            displayName: 'Foundation',
            scope: 'global' as const,
          },
          spec: {
            assignmentKinds: ['foundation-check'] as const,
            preferredRuntime: { harness: 'fake', model: 'fake-v1' },
            alternatives: [],
            requiredCapabilities: [],
            skills: { preferred: [], required: [] },
            instructions: 'Verify foundation.',
            outputSchema: 'mesh.foundation/v1',
          },
        },
        digest: 'a'.repeat(64),
      },
      skillRequests: { preferred: [], required: [] },
      resolvedSkills: [],
      capabilitySnapshot: {
        adapterId: 'fake',
        capabilities: [],
        skills: [],
        exactResume: true,
      },
      adapterId: 'fake',
      model: 'fake-v1',
      nativeHandle: 'fake:v1:handle',
      lifecycle: 'running' as const,
      revision: 2,
      lastAdapterCursor: 5,
      lastRuntimeSequence: 5,
      replacementForExecutionId: null,
      failure: null,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:05.000Z',
      endedAt: null,
    };
    const snapshot = {
      protocolVersion: V2_PROTOCOL_VERSION,
      project: {
        id: projectId,
        displayName: 'Mesh',
        repositoryIdentity: 'repo-1',
        repositoryPath: 'C:\\code\\mesh',
        gitCommonDirectory: 'C:\\code\\mesh\\.git',
        headCommit: 'a'.repeat(40),
        revision: 1,
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      },
      profiles: [],
      executions: [execution],
      attentionItems: [],
      cursors: { domain: 2, runtime: 5 },
    } satisfies V2ProjectSnapshot;
    store.dispatch({ type: 'snapshot.received', snapshot });
    createV2Socket({
      url: 'ws://mesh.test/api/v2/realtime',
      projectId,
      cursors: snapshot.cursors,
      cursorSource: store,
      dispatch: store.dispatch,
      socketFactory: () => {
        const created = new FakeSocket();
        sockets.push(created);
        return created;
      },
    });
    const completion: ServerRealtimeMessage = {
      type: 'v2.runtime_event',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      event: {
        id: runtimeId,
        projectId,
        executionId,
        diagnosticId,
        sequence: 6,
        adapterCursor: 6,
        occurredAt: '2026-08-28T00:00:06.000Z',
        type: 'worker_execution.completed',
        payload: { outcome: 'completed' },
      },
    };

    sockets[0]?.message(completion);
    sockets[0]?.message(completion);

    expect(store.getState().runtimeCursor).toBe(6);
    expect(store.getState().activity).toEqual([completion.event]);
    expect(store.getState().executions[0]?.lifecycle).toBe('running');
  });

  it('does not advertise a schema-valid event rejected by the store', () => {
    const sockets: FakeSocket[] = [];
    const store = createV2Store(projectId);
    const socket = createV2Socket({
      url: 'ws://mesh.test/api/v2/realtime',
      projectId,
      cursors: { domain: 0, runtime: 0 },
      dispatch: store.dispatch,
      socketFactory: () => {
        const created = new FakeSocket();
        sockets.push(created);
        return created;
      },
    });
    sockets[0]?.open();
    sockets[0]?.message({
      type: 'v2.domain_event',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      event: {
        id: '00000000-0000-4000-8000-000000000012',
        projectId,
        sequence: 1,
        occurredAt: '2026-08-28T00:00:07.000Z',
        type: 'worker_profile.revision_approved',
        payload: {
          profileRevision: {
            profileId: '00000000-0000-4000-8000-000000000013',
            scope: 'project',
            projectId,
            name: 'extended-profile',
            displayName: 'Extended Profile',
            revision: 1,
            sourceYaml: 'apiVersion: mesh.dev/v1alpha1',
            document: {
              apiVersion: 'mesh.dev/v1alpha1',
              kind: 'WorkerProfile',
              metadata: {
                name: 'extended-profile',
                displayName: 'Extended Profile',
                scope: 'project',
              },
              extends: { profile: 'global/foundation', revision: 1 },
              spec: { instructions: 'Project override.' },
            },
            baseProfileId: '00000000-0000-4000-8000-000000000014',
            baseRevision: 1,
            approvedBy: { kind: 'human' },
            approvedAt: '2026-08-28T00:00:07.000Z',
            digest: 'b'.repeat(64),
          },
        },
      },
    });

    expect(store.getState().domainCursor).toBe(0);
    expect(store.getState().connection).toEqual({
      status: 'stale',
      reason: 'profile_projection_incomplete',
    });

    socket.reconnect();
    sockets[1]?.open();
    expect(JSON.parse(sockets[1]?.sent[0] ?? '{}')).toMatchObject({
      cursors: { domain: 0, runtime: 0 },
    });
  });
});
