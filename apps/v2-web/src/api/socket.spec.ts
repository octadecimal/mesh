import {
  V2_PROTOCOL_VERSION,
  type ServerRealtimeMessage,
} from '@mesh/v2-contracts';

import { createV2Socket, type WebSocketLike } from './socket';

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
}

describe('createV2Socket', () => {
  it('sends both independent cursors in every reconnect hello', () => {
    const sockets: FakeSocket[] = [];
    const socket = createV2Socket({
      url: 'ws://mesh.test/api/v2/realtime',
      projectId,
      cursors: { domain: 3, runtime: 8 },
      dispatch: vi.fn(),
      socketFactory: () => {
        const created = new FakeSocket();
        sockets.push(created);
        return created;
      },
    });

    sockets[0]?.open();
    socket.reconnect();
    sockets[1]?.open();

    const expected = JSON.stringify({
      type: 'v2.subscribe',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      cursors: { domain: 3, runtime: 8 },
    });
    expect(sockets.map(({ sent }) => sent)).toEqual([[expected], [expected]]);
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
});
