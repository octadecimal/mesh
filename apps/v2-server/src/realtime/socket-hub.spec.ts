import { EventEmitter } from 'node:events';

import {
  V2_PROTOCOL_VERSION,
  type DomainEvent,
  type RuntimeEvent,
  type ServerRealtimeMessage,
} from '@mesh/v2-contracts';
import { describe, expect, it } from 'vitest';

import { V2EventPublisher } from './event-publisher';
import { V2SocketHub, type V2SocketConnection } from './socket-hub';

const projectId = '11111111-1111-4111-8111-111111111111';
const executionId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-08-28T00:00:00.000Z';
const project = {
  id: projectId,
  displayName: 'Todo',
  repositoryIdentity: 'todo.git',
  repositoryPath: 'C:/work/todo',
  gitCommonDirectory: 'C:/work/todo/.git',
  headCommit: 'a'.repeat(40),
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const domainEvent = (sequence: number): DomainEvent => ({
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  projectId,
  sequence,
  occurredAt: timestamp,
  type: 'project.registered',
  payload: { project },
});

const runtimeEvent = (sequence: number): RuntimeEvent => ({
  id: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  projectId,
  executionId,
  diagnosticId: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  sequence,
  adapterCursor: sequence,
  occurredAt: timestamp,
  type: 'worker_execution.output',
  payload: { text: `event ${sequence}` },
});

class TestSocket extends EventEmitter implements V2SocketConnection {
  readonly sent: ServerRealtimeMessage[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  private readonly waiters: Array<{
    predicate: (message: ServerRealtimeMessage) => boolean;
    resolve: (message: ServerRealtimeMessage) => void;
  }> = [];

  send(value: string): void {
    const message = JSON.parse(value) as ServerRealtimeMessage;
    this.sent.push(message);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.emit('close');
  }

  subscribe(cursors = { domain: 0, runtime: 0 }): void {
    this.emit(
      'message',
      JSON.stringify({
        type: 'v2.subscribe',
        protocolVersion: V2_PROTOCOL_VERSION,
        projectId,
        cursors,
      }),
    );
  }

  waitFor(predicate: (message: ServerRealtimeMessage) => boolean) {
    const existing = this.sent.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ServerRealtimeMessage>((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }
}

class ThrowingSocket extends TestSocket {
  sendAttempts = 0;
  throwOnSend = false;

  override send(value: string): void {
    this.sendAttempts += 1;
    if (this.throwOnSend) throw new Error('socket send failed');
    super.send(value);
  }
}

class ThrowingCloseSocket extends ThrowingSocket {
  override close(code?: number, reason?: string): void {
    super.close(code, reason);
    throw new Error('socket close failed');
  }
}

const gate = () => {
  let entered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => (entered = resolve)),
    release: new Promise<void>((resolve) => (release = resolve)),
    markEntered: entered,
    open: release,
  };
};

describe('V2SocketHub', () => {
  it.each(['domain', 'runtime'] as const)(
    'does not lose or duplicate a %s event committed while replay is blocked',
    async (stream) => {
      const publisher = new V2EventPublisher();
      const replayGate = gate();
      let includeInterleaved = false;
      const hub = new V2SocketHub({
        publisher,
        projectExists: (id) => id === projectId,
        events: {
          domainAfter: async () => {
            if (stream === 'domain') {
              replayGate.markEntered();
              await replayGate.release;
            }
            return {
              lowWater: 1,
              highWater: stream === 'domain' && includeInterleaved ? 2 : 1,
              events:
                stream === 'domain' && includeInterleaved
                  ? [domainEvent(1), domainEvent(2)]
                  : [domainEvent(1)],
            };
          },
          runtimeAfter: async () => {
            if (stream === 'runtime') {
              replayGate.markEntered();
              await replayGate.release;
            }
            return {
              lowWater: 1,
              highWater: stream === 'runtime' && includeInterleaved ? 2 : 1,
              events:
                stream === 'runtime' && includeInterleaved
                  ? [runtimeEvent(1), runtimeEvent(2)]
                  : [runtimeEvent(1)],
            };
          },
        },
      });
      const socket = new TestSocket();
      hub.attach(socket);
      socket.subscribe();

      await replayGate.entered;
      includeInterleaved = true;
      if (stream === 'domain') publisher.domain(domainEvent(2));
      else publisher.runtime(runtimeEvent(2));
      replayGate.open();

      await socket.waitFor((message) => message.type === 'v2.subscribed');
      const sequences = socket.sent
        .filter((message) => message.type === `v2.${stream}_event`)
        .map((message) =>
          message.type === 'v2.domain_event' ||
          message.type === 'v2.runtime_event'
            ? message.event.sequence
            : -1,
        );
      expect(sequences).toEqual([1, 2]);
    },
  );

  it('requires resync for a non-contiguous buffered event', async () => {
    const publisher = new V2EventPublisher();
    const replayGate = gate();
    const hub = new V2SocketHub({
      publisher,
      projectExists: () => true,
      events: {
        domainAfter: async () => {
          replayGate.markEntered();
          await replayGate.release;
          return { lowWater: 1, highWater: 1, events: [domainEvent(1)] };
        },
        runtimeAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
      },
    });
    const socket = new TestSocket();
    hub.attach(socket);
    socket.subscribe();
    await replayGate.entered;
    publisher.domain(domainEvent(3));
    replayGate.open();

    await socket.waitFor(
      (message) =>
        message.type === 'v2.resync_required' &&
        message.reason === 'non_contiguous_buffer',
    );
    expect(socket.closed).toEqual([
      { code: 1008, reason: 'Resynchronization required' },
    ]);
  });

  it('requires resync when a retained cursor has a gap', async () => {
    const hub = new V2SocketHub({
      publisher: new V2EventPublisher(),
      projectExists: () => true,
      events: {
        domainAfter: () => ({ lowWater: 4, highWater: 5, events: [] }),
        runtimeAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
      },
    });
    const socket = new TestSocket();
    hub.attach(socket);
    socket.subscribe({ domain: 1, runtime: 0 });

    await socket.waitFor(
      (message) =>
        message.type === 'v2.resync_required' &&
        message.reason === 'retained_gap',
    );
    expect(socket.closed).toHaveLength(1);
  });

  it('removes committed listeners on socket error and hub close', async () => {
    const publisher = new V2EventPublisher();
    const hub = new V2SocketHub({
      publisher,
      projectExists: () => true,
      events: {
        domainAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
        runtimeAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
      },
    });
    const first = new TestSocket();
    hub.attach(first);
    first.subscribe();
    await first.waitFor((message) => message.type === 'v2.subscribed');
    first.emit('error', new Error('gone'));
    publisher.domain(domainEvent(1));
    expect(first.sent).toHaveLength(1);

    const second = new TestSocket();
    hub.attach(second);
    second.subscribe();
    await second.waitFor((message) => message.type === 'v2.subscribed');
    hub.close();
    publisher.runtime(runtimeEvent(1));
    expect(second.sent).toHaveLength(1);
    expect(second.closed).toHaveLength(1);
  });

  it('continues shutdown when one active socket close throws', async () => {
    const publisher = new V2EventPublisher();
    const hub = new V2SocketHub({
      publisher,
      projectExists: () => true,
      events: {
        domainAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
        runtimeAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
      },
    });
    const broken = new ThrowingCloseSocket();
    const healthy = new TestSocket();
    hub.attach(broken);
    hub.attach(healthy);
    broken.subscribe();
    healthy.subscribe();
    await Promise.all([
      broken.waitFor((message) => message.type === 'v2.subscribed'),
      healthy.waitFor((message) => message.type === 'v2.subscribed'),
    ]);

    expect(() => {
      hub.close();
      hub.close();
    }).not.toThrow();
    publisher.domain(domainEvent(1));
    publisher.runtime(runtimeEvent(1));

    expect(broken.closed).toEqual([
      { code: 1001, reason: 'Server shutting down' },
    ]);
    expect(healthy.closed).toEqual([
      { code: 1001, reason: 'Server shutting down' },
    ]);
    expect(broken.sendAttempts).toBe(1);
    expect(healthy.sent).toHaveLength(1);
  });

  it('stops a blocked replay after an asynchronous socket error', async () => {
    const publisher = new V2EventPublisher();
    const replayGate = gate();
    let domainReads = 0;
    const hub = new V2SocketHub({
      publisher,
      projectExists: () => true,
      events: {
        domainAfter: async () => {
          domainReads += 1;
          if (domainReads === 1) {
            replayGate.markEntered();
            await replayGate.release;
            return { lowWater: 1, highWater: 1, events: [domainEvent(1)] };
          }
          return { lowWater: 1, highWater: 0, events: [] };
        },
        runtimeAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
      },
    });
    const broken = new ThrowingCloseSocket();
    const healthy = new TestSocket();
    hub.attach(broken);
    broken.subscribe();
    await replayGate.entered;

    broken.emit('error', new Error('transport failed'));
    hub.attach(healthy);
    healthy.subscribe();
    await healthy.waitFor((message) => message.type === 'v2.subscribed');
    replayGate.open();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    publisher.domain(domainEvent(1));
    broken.emit('error', new Error('transport failed again'));

    expect(broken.closed).toEqual([
      { code: 1011, reason: 'Socket connection failed' },
    ]);
    expect(broken.sent).toEqual([]);
    expect(broken.sendAttempts).toBe(0);
    expect(
      healthy.sent.filter((message) => message.type === 'v2.domain_event'),
    ).toHaveLength(1);
  });

  it('removes a socket whose send fails without disrupting other listeners', async () => {
    const publisher = new V2EventPublisher();
    const hub = new V2SocketHub({
      publisher,
      projectExists: () => true,
      events: {
        domainAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
        runtimeAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
      },
    });
    const broken = new ThrowingSocket();
    const healthy = new TestSocket();
    hub.attach(broken);
    hub.attach(healthy);
    broken.subscribe();
    healthy.subscribe();
    await Promise.all([
      broken.waitFor((message) => message.type === 'v2.subscribed'),
      healthy.waitFor((message) => message.type === 'v2.subscribed'),
    ]);
    broken.throwOnSend = true;

    publisher.domain(domainEvent(1));

    expect(broken.closed).toEqual([
      { code: 1011, reason: 'Socket delivery failed' },
    ]);
    expect(
      healthy.sent.some(
        (message) =>
          message.type === 'v2.domain_event' && message.event.sequence === 1,
      ),
    ).toBe(true);
    expect(broken.sendAttempts).toBe(2);
    publisher.domain(domainEvent(2));
    expect(broken.sendAttempts).toBe(2);
  });
});
