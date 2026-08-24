import type { ServerMessage } from '@mesh-session-platform/contracts';

import { MeshSocket } from './socket';

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

describe('MeshSocket', () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  it('subscribes with current cursors and delivers only contract-valid frames', () => {
    const messages: ServerMessage[] = [];
    const diagnostics: string[] = [];
    const socket = new MeshSocket({
      url: 'ws://mesh.test/api/realtime',
      webSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      cursors: () => ({ 'session-1': 4 }),
      onMessage: (message) => messages.push(message),
      onDiagnostic: (message) => diagnostics.push(message),
    });

    socket.connect();
    const connection = FakeSocket.instances[0];
    connection.open();
    connection.receive(healthMessage);
    connection.receive({ protocolVersion: 1, type: 'events', payload: { events: [{}] } });

    expect(JSON.parse(connection.sent[0])).toEqual({
      protocolVersion: 1,
      type: 'subscribe',
      payload: { cursors: { 'session-1': 4 } },
    });
    expect(messages).toEqual([healthMessage]);
    expect(diagnostics).toHaveLength(1);
    socket.close();
  });

  it('requests snapshot replacement when the server requires resync', () => {
    let resyncs = 0;
    const socket = new MeshSocket({
      url: 'ws://mesh.test/api/realtime',
      webSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      cursors: () => ({}),
      onMessage: () => undefined,
      onDiagnostic: () => undefined,
      resync: () => {
        resyncs += 1;
        return Promise.resolve();
      },
    });

    socket.connect();
    const connection = FakeSocket.instances[0];
    connection.open();
    connection.receive({
      protocolVersion: 1,
      type: 'resync.required',
      payload: { sessionId: 'session-1', reason: 'retention expired' },
    });

    expect(resyncs).toBe(1);
    socket.close();
  });
});
