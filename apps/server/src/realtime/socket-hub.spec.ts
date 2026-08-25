import { describe, expect, it, vi } from 'vitest';
import {
  idSchema,
  type ServerMessage,
  type SessionEvent,
} from '@mesh-session-platform/contracts';
import Fastify from 'fastify';

import { EventPublisher } from '../runtime/event-publisher.js';
import {
  registerSocketHub,
  SocketHub,
  isAllowedSocketUpgrade,
} from './socket-hub.js';

const event = (sequence: number): SessionEvent => ({
  protocolVersion: 1,
  id: idSchema.parse(`event-${sequence}`),
  sessionId: idSchema.parse('s1'),
  sequence,
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'message.user',
  payload: { text: String(sequence) },
});

class TestSocket {
  readonly messages: ServerMessage[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  once(name: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(name, [listener]);
  }

  on(name: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  send(value: string): void {
    this.messages.push(JSON.parse(value) as ServerMessage);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.emit('close');
  }

  subscribe(cursors: Record<string, number>): void {
    this.emit(
      'message',
      JSON.stringify({ protocolVersion: 1, type: 'subscribe', cursors }),
    );
  }

  private emit(name: string, ...args: unknown[]): void {
    const listeners = this.listeners.get(name) ?? [];
    this.listeners.delete(name);
    for (const listener of listeners) listener(...args);
  }
}

describe('SocketHub', () => {
  it('replays before buffered live events without gaps or duplicates', () => {
    const publisher = new EventPublisher();
    let published = false;
    const hub = new SocketHub({
      publisher,
      events: {
        after: () => {
          if (!published) {
            published = true;
            publisher.publish(event(3));
          }
          return [event(1), event(2)];
        },
      },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({ s1: 1 });
    publisher.publish(event(3));
    publisher.publish(event(4));

    expect(
      socket.messages
        .filter((message) => message.type === 'events')
        .flatMap((message) =>
          message.payload.events.map(({ sequence }) => sequence),
        ),
    ).toEqual([2, 3, 4]);
  });

  it('emits connected heartbeats with fresh observation timestamps', () => {
    vi.useFakeTimers();
    let observedAt = '2026-08-24T00:00:00.000Z';
    const hub = new SocketHub({
      publisher: new EventPublisher(),
      events: { after: () => [] },
      now: () => observedAt,
      heartbeatIntervalMs: 1_000,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({});
    observedAt = '2026-08-24T00:00:01.000Z';
    vi.advanceTimersByTime(1_000);

    expect(
      socket.messages.filter((message) => message.type === 'connection.health'),
    ).toEqual([
      {
        protocolVersion: 1,
        type: 'connection.health',
        payload: {
          status: 'connected',
          observedAt: '2026-08-24T00:00:00.000Z',
        },
      },
      {
        protocolVersion: 1,
        type: 'connection.health',
        payload: {
          status: 'connected',
          observedAt: '2026-08-24T00:00:01.000Z',
        },
      },
    ]);
    socket.close();
    vi.useRealTimers();
  });

  it('uses the v1 resync message when retained history has a gap', () => {
    const hub = new SocketHub({
      publisher: new EventPublisher(),
      events: { after: () => [event(4)] },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({ s1: 1 });

    expect(socket.messages).toContainEqual({
      protocolVersion: 1,
      type: 'resync.required',
      payload: { sessionId: 's1', reason: 'requested_history_unavailable' },
    });
    expect(socket.messages.some((message) => message.type === 'events')).toBe(
      false,
    );
  });

  it('rejects malformed and oversized first-frame cursor maps as degraded', () => {
    const hub = new SocketHub({
      publisher: new EventPublisher(),
      events: { after: () => [] },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
      maxSubscriptions: 1,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({ s1: 0, s2: 0 });

    expect(socket.messages).toContainEqual({
      protocolVersion: 1,
      type: 'connection.health',
      payload: { status: 'degraded', observedAt: '2026-08-24T00:00:00.000Z' },
    });
    expect(socket.closes).toEqual([
      { code: 1008, reason: 'Invalid subscription' },
    ]);
  });
});

describe('isAllowedSocketUpgrade', () => {
  it('requires both loopback transport and an exact served origin', () => {
    expect(
      isAllowedSocketUpgrade(
        '127.0.0.1',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3000',
      ),
    ).toBe(true);
    expect(
      isAllowedSocketUpgrade(
        '::ffff:127.0.0.1',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3000',
      ),
    ).toBe(true);
    expect(
      isAllowedSocketUpgrade(
        '192.168.1.5',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3000',
      ),
    ).toBe(false);
    expect(
      isAllowedSocketUpgrade(
        '127.0.0.1',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      ),
    ).toBe(false);
  });

  it('guards the registered /api/socket route before upgrading', async () => {
    const app = Fastify({ logger: false });
    registerSocketHub(app, {
      publisher: new EventPublisher(),
      events: { after: () => [] },
      servedOrigin: 'http://127.0.0.1:3000',
      heartbeatIntervalMs: 0,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/socket',
      headers: {
        connection: 'upgrade',
        upgrade: 'websocket',
        origin: 'http://attacker.example',
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
