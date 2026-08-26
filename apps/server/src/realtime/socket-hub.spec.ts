import { describe, expect, it, vi } from 'vitest';
import {
  idSchema,
  projectEventSchema,
  type ProjectEvent,
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

const projectTask = (projectId: string) => ({
  id: idSchema.parse(`task-${projectId}`),
  projectId: idSchema.parse(projectId),
  title: 'Task',
  description: '',
  acceptanceCriteria: [],
  priority: 'normal' as const,
  rank: 'a',
  lifecycleState: 'backlog' as const,
  labels: [],
  notes: '',
  blocked: null,
  revision: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
});

const projectEvent = (projectId: string, sequence: number): ProjectEvent => ({
  protocolVersion: 1,
  id: idSchema.parse(`project-event-${projectId}-${sequence}`),
  projectId: idSchema.parse(projectId),
  sequence,
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'task.changed',
  payload: { task: projectTask(projectId) },
});

const developerEvent = projectEventSchema.parse({
  protocolVersion: 1,
  id: 'developer-event-p1-2',
  projectId: 'p1',
  sequence: 2,
  occurredAt: '2026-08-24T00:02:00.000Z',
  type: 'task.developer_execution_changed',
  payload: {
    task: projectTask('p1'),
    attempt: {
      id: 'attempt-1',
      taskId: 'task-p1',
      sessionId: 'session-1',
      ordinal: 1,
      source: 'launched',
      actor: { type: 'human', id: 'operator' },
      createdAt: '2026-08-24T00:00:00.000Z',
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
      role: 'developer',
    },
    cycle: {
      id: 'cycle-1',
      attemptId: 'attempt-1',
      ordinal: 1,
      mode: 'new',
      authorizedBy: { type: 'human', id: 'operator' },
      authorizationCommandId: 'launch-1',
      policyVersion: 'developer-policy-v1',
      projectInstructions: { content: '', revision: 1 },
      taskSnapshot: {
        revision: 1,
        title: 'Task',
        description: '',
        acceptanceCriteria: [],
      },
      workspaceId: 'workspace-1',
      permissionMode: 'interactive',
      startedAt: '2026-08-24T00:00:00.000Z',
      endedAt: null,
      terminalDisposition: null,
      completionReportId: null,
      blockerReportId: null,
      terminalCommandId: null,
      terminalEventId: null,
    },
    completionReport: null,
    blockerReport: null,
    reviewFeedback: null,
  },
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

  subscribe(
    cursors: Record<string, number>,
    projectCursors?: Record<string, number>,
  ): void {
    this.emit(
      'message',
      JSON.stringify({
        protocolVersion: 1,
        type: 'subscribe',
        cursors,
        ...(projectCursors === undefined ? {} : { projectCursors }),
      }),
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

  it('forwards transient assistant deltas without assigning replay sequence', () => {
    const publisher = new EventPublisher();
    const hub = new SocketHub({
      publisher,
      events: { after: () => [] },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({ s1: 0 });
    publisher.publishTransient({
      sessionId: idSchema.parse('s1'),
      text: 'Hello',
    });

    expect(socket.messages).toContainEqual({
      protocolVersion: 1,
      type: 'assistant.delta',
      payload: { sessionId: 's1', text: 'Hello' },
    });
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

  it('replays and streams only subscribed project events with independent cursors', () => {
    const publisher = new EventPublisher();
    let publishedDuringReplay = false;
    const hub = new SocketHub({
      publisher,
      events: { after: () => [] },
      projectEvents: {
        retainedAfter: () => {
          if (!publishedDuringReplay) {
            publishedDuringReplay = true;
            publisher.publishProject(projectEvent('p1', 3));
          }
          return {
            events: [projectEvent('p1', 2)],
            lowWater: 1,
            highWater: 2,
          };
        },
      },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({}, { p1: 1 });
    publisher.publishProject(projectEvent('p2', 1));
    publisher.publishProject(projectEvent('p1', 3));
    publisher.publishProject(projectEvent('p1', 4));

    expect(
      socket.messages
        .filter((message) => message.type === 'project.event')
        .map((message) => [
          message.payload.event.projectId,
          message.payload.event.sequence,
        ]),
    ).toEqual([
      ['p1', 2],
      ['p1', 3],
      ['p1', 4],
    ]);
  });

  it('streams a Developer event unchanged and without capability material', () => {
    const publisher = new EventPublisher();
    const hub = new SocketHub({
      publisher,
      events: { after: () => [] },
      projectEvents: {
        retainedAfter: () => ({
          events: [projectEvent('p1', 1)],
          lowWater: 1,
          highWater: 1,
        }),
      },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({}, { p1: 0 });
    publisher.publishProject(developerEvent);

    const message = socket.messages.find(
      (candidate) =>
        candidate.type === 'project.event' &&
        candidate.payload.event.type === 'task.developer_execution_changed',
    );
    expect(message).toEqual({
      protocolVersion: 1,
      type: 'project.event',
      payload: { event: developerEvent },
    });
    expect(JSON.stringify(message)).not.toContain('capability');
  });

  it('emits project resync without replaying an unavailable suffix', () => {
    const hub = new SocketHub({
      publisher: new EventPublisher(),
      events: { after: () => [] },
      projectEvents: {
        retainedAfter: () => ({
          events: [projectEvent('p1', 4), projectEvent('p1', 5)],
          lowWater: 4,
          highWater: 5,
        }),
      },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({}, { p1: 1 });

    expect(socket.messages).toContainEqual({
      protocolVersion: 1,
      type: 'project.resync_required',
      payload: { projectId: 'p1', reason: 'requested_history_unavailable' },
    });
    expect(
      socket.messages.some((message) => message.type === 'project.event'),
    ).toBe(false);
  });

  it('stops project delivery on browser disconnect without affecting publication', () => {
    const publisher = new EventPublisher();
    const hub = new SocketHub({
      publisher,
      events: { after: () => [] },
      projectEvents: {
        retainedAfter: () => ({ events: [], lowWater: 1, highWater: 0 }),
      },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({}, { p1: 0 });
    socket.close();
    publisher.publishProject(projectEvent('p1', 1));

    expect(
      socket.messages.some((message) => message.type === 'project.event'),
    ).toBe(false);
  });

  it('requires project resync instead of streaming across a live sequence gap', () => {
    const publisher = new EventPublisher();
    const hub = new SocketHub({
      publisher,
      events: { after: () => [] },
      projectEvents: {
        retainedAfter: () => ({
          events: [projectEvent('p1', 1)],
          lowWater: 1,
          highWater: 1,
        }),
      },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({}, { p1: 0 });
    publisher.publishProject(projectEvent('p1', 3));

    expect(socket.messages).toContainEqual({
      protocolVersion: 1,
      type: 'project.resync_required',
      payload: { projectId: 'p1', reason: 'event_sequence_gap' },
    });
    expect(
      socket.messages
        .filter((message) => message.type === 'project.event')
        .map((message) => message.payload.event.sequence),
    ).toEqual([1]);
  });

  it('requires project resync when subscribed history was fully purged', () => {
    const hub = new SocketHub({
      publisher: new EventPublisher(),
      events: { after: () => [] },
      projectEvents: {
        retainedAfter: () => ({ events: [], lowWater: 6, highWater: 5 }),
      },
      now: () => '2026-08-24T00:00:00.000Z',
      heartbeatIntervalMs: 0,
    });
    const socket = new TestSocket();

    hub.attach(socket);
    socket.subscribe({}, { p1: 0 });

    expect(socket.messages).toContainEqual({
      protocolVersion: 1,
      type: 'project.resync_required',
      payload: { projectId: 'p1', reason: 'requested_history_unavailable' },
    });
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
