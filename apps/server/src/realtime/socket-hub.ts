import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import {
  idSchema,
  type ProjectEvent,
  type ServerMessage,
  type SessionEvent,
} from '@mesh-session-platform/contracts';
import { subscribeFrameSchema } from '@mesh-session-platform/contracts';

import type { EventRepository } from '../repositories/event-repository.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import type { OriginPolicy } from '../app.js';
import { ProjectReplayService } from './project-replay.js';
import { ReplayService } from './replay.js';

const DEFAULT_MAX_SUBSCRIPTIONS = 100;
const DEFAULT_MAX_FIRST_FRAME_BYTES = 64 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

type SocketConnection = {
  once(name: 'message', listener: (data: unknown) => void): unknown;
  on(name: 'close' | 'error', listener: () => void): unknown;
  send(value: string): void;
  close(code?: number, reason?: string): void;
};

type EventHistory = Pick<EventRepository, 'after'>;
type ProjectEventHistory = {
  after(projectId: string, sequence: number): ProjectEvent[];
};

export type SocketHubOptions = {
  events: EventHistory;
  projectEvents?: ProjectEventHistory;
  publisher: EventPublisher;
  now?: () => string;
  heartbeatIntervalMs?: number;
  maxSubscriptions?: number;
  maxFirstFrameBytes?: number;
};

type SubscribeFrame = {
  type: 'subscribe';
  cursors: Record<string, number>;
  projectCursors: Record<string, number>;
};

const frameText = (data: unknown): string | undefined => {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return undefined;
};

const parseSubscribeFrame = (
  data: unknown,
  maxSubscriptions: number,
  maxFirstFrameBytes: number,
): SubscribeFrame | undefined => {
  const text = frameText(data);
  if (text === undefined || Buffer.byteLength(text) > maxFirstFrameBytes)
    return undefined;

  try {
    const parsed = subscribeFrameSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) return undefined;
    const candidate = parsed.data;
    const entries = Object.entries(candidate.cursors);
    const projectEntries = Object.entries(candidate.projectCursors ?? {});
    if (entries.length + projectEntries.length > maxSubscriptions)
      return undefined;
    if (
      [...entries, ...projectEntries].some(
        ([sessionId, cursor]) =>
          !idSchema.safeParse(sessionId).success ||
          typeof cursor !== 'number' ||
          !Number.isSafeInteger(cursor) ||
          cursor < 0,
      )
    ) {
      return undefined;
    }
    return {
      type: 'subscribe',
      cursors: Object.fromEntries(entries),
      projectCursors: Object.fromEntries(projectEntries),
    };
  } catch {
    return undefined;
  }
};

const isLoopback = (remoteAddress: string | undefined): boolean => {
  if (!remoteAddress) return false;
  if (remoteAddress === '::1') return true;
  const address = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
  return /^127(?:\.\d{1,3}){3}$/.test(address);
};

export const isAllowedSocketUpgrade = (
  remoteAddress: string | undefined,
  origin: string | undefined,
  policy: string | Pick<OriginPolicy, 'accepting' | 'allows'>,
): boolean =>
  isLoopback(remoteAddress) &&
  (typeof policy === 'string'
    ? origin === policy
    : policy.accepting && policy.allows(origin));

export class SocketHub {
  private readonly replay: ReplayService;
  private readonly projectReplay?: ProjectReplayService;
  private readonly now: () => string;
  private readonly heartbeatIntervalMs: number;
  private readonly maxSubscriptions: number;
  private readonly maxFirstFrameBytes: number;

  constructor(private readonly options: SocketHubOptions) {
    this.replay = new ReplayService(options.events);
    this.projectReplay = options.projectEvents
      ? new ProjectReplayService(options.projectEvents)
      : undefined;
    this.now = options.now ?? (() => new Date().toISOString());
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxSubscriptions =
      options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
    this.maxFirstFrameBytes =
      options.maxFirstFrameBytes ?? DEFAULT_MAX_FIRST_FRAME_BYTES;
  }

  attach(socket: SocketConnection): void {
    const cleanups: Array<() => void> = [];
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const dispose of cleanups.splice(0)) dispose();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    socket.once('message', (data) => {
      const subscription = parseSubscribeFrame(
        data,
        this.maxSubscriptions,
        this.maxFirstFrameBytes,
      );
      if (!subscription) {
        this.sendHealth(socket, 'degraded');
        socket.close(1008, 'Invalid subscription');
        return;
      }

      this.startSubscription(
        socket,
        subscription.cursors,
        subscription.projectCursors,
        cleanups,
      );
    });
  }

  private startSubscription(
    socket: SocketConnection,
    cursors: Record<string, number>,
    projectCursors: Record<string, number>,
    cleanups: Array<() => void>,
  ): void {
    const buffered: SessionEvent[] = [];
    const bufferedProjectEvents: ProjectEvent[] = [];
    const delivered = new Set<string>();
    const deliveredProjectEvents = new Set<string>();
    const resyncRequired = new Set<string>();
    const projectResyncRequired = new Set<string>();
    let replaying = true;

    const deliver = (events: SessionEvent[]) => {
      const unique = events.filter((event) => {
        if (resyncRequired.has(event.sessionId)) return false;
        if (event.sequence <= (cursors[event.sessionId] ?? 0)) return false;
        const key = `${event.sessionId}\u0000${event.sequence}`;
        if (delivered.has(key)) return false;
        delivered.add(key);
        return true;
      });
      if (unique.length > 0) {
        this.send(socket, {
          protocolVersion: 1,
          type: 'events',
          payload: { events: unique },
        });
      }
    };

    const deliverProjectEvents = (events: ProjectEvent[]) => {
      for (const event of events) {
        if (projectResyncRequired.has(event.projectId)) continue;
        if (event.sequence <= (projectCursors[event.projectId] ?? 0)) continue;
        const key = `${event.projectId}\u0000${event.sequence}`;
        if (deliveredProjectEvents.has(key)) continue;
        deliveredProjectEvents.add(key);
        this.send(socket, {
          protocolVersion: 1,
          type: 'project.event',
          payload: { event },
        });
      }
    };

    for (const sessionId of Object.keys(cursors)) {
      cleanups.push(
        this.options.publisher.subscribe(sessionId, (event) => {
          if (replaying) buffered.push(event);
          else deliver([event]);
        }),
      );
      cleanups.push(
        this.options.publisher.subscribeTransient(sessionId, (delta) => {
          this.send(socket, {
            protocolVersion: 1,
            type: 'assistant.delta',
            payload: delta,
          });
        }),
      );
    }
    for (const projectId of Object.keys(projectCursors)) {
      cleanups.push(
        this.options.publisher.subscribeProject(projectId, (event) => {
          if (replaying) bufferedProjectEvents.push(event);
          else deliverProjectEvents([event]);
        }),
      );
    }

    try {
      const result = this.replay.after(cursors);
      for (const sessionId of result.resyncSessionIds) {
        resyncRequired.add(sessionId);
        this.send(socket, {
          protocolVersion: 1,
          type: 'resync.required',
          payload: {
            sessionId: idSchema.parse(sessionId),
            reason: 'requested_history_unavailable',
          },
        });
      }
      for (const batch of result.batches) deliver(batch.events);

      if (this.projectReplay) {
        const projectResult = this.projectReplay.after(projectCursors);
        for (const projectId of projectResult.resyncProjectIds) {
          projectResyncRequired.add(projectId);
          this.send(socket, {
            protocolVersion: 1,
            type: 'project.resync_required',
            payload: {
              projectId: idSchema.parse(projectId),
              reason: 'requested_history_unavailable',
            },
          });
        }
        deliverProjectEvents(projectResult.events);
      } else {
        for (const projectId of Object.keys(projectCursors)) {
          projectResyncRequired.add(projectId);
          this.send(socket, {
            protocolVersion: 1,
            type: 'project.resync_required',
            payload: {
              projectId: idSchema.parse(projectId),
              reason: 'requested_history_unavailable',
            },
          });
        }
      }

      while (buffered.length > 0) {
        const pending = buffered.splice(0);
        deliver(
          pending.filter(
            (event) =>
              event.sequence >
              (result.highWaterBySession[event.sessionId] ?? 0),
          ),
        );
      }
      while (bufferedProjectEvents.length > 0) {
        deliverProjectEvents(bufferedProjectEvents.splice(0));
      }
      replaying = false;
      this.sendHealth(socket, 'connected');
      if (this.heartbeatIntervalMs > 0) {
        const heartbeat = setInterval(
          () => this.sendHealth(socket, 'connected'),
          this.heartbeatIntervalMs,
        );
        cleanups.push(() => clearInterval(heartbeat));
      }
    } catch {
      this.sendHealth(socket, 'degraded');
      socket.close(1011, 'Replay unavailable');
    }
  }

  private sendHealth(
    socket: SocketConnection,
    status: 'connected' | 'degraded',
  ): void {
    this.send(socket, {
      protocolVersion: 1,
      type: 'connection.health',
      payload: { status, observedAt: this.now() },
    });
  }

  private send(socket: SocketConnection, message: ServerMessage): void {
    socket.send(JSON.stringify(message));
  }
}

export const registerSocketHub = (
  app: FastifyInstance,
  options: SocketHubOptions &
    (
      | { servedOrigin: string; originPolicy?: never }
      | {
          servedOrigin?: never;
          originPolicy: Pick<OriginPolicy, 'accepting' | 'allows'>;
        }
    ),
): void => {
  const hub = new SocketHub(options);
  void app.register(async (scope) => {
    await scope.register(websocket);
    scope.get(
      '/api/socket',
      {
        websocket: true,
        preValidation: (request, reply, done) => {
          if (
            !isAllowedSocketUpgrade(
              request.raw.socket.remoteAddress,
              request.headers.origin,
              options.originPolicy ?? options.servedOrigin,
            )
          ) {
            void reply
              .code(
                options.originPolicy && !options.originPolicy.accepting
                  ? 503
                  : 403,
              )
              .send();
            return;
          }
          done();
        },
      },
      (socket) => hub.attach(socket as unknown as SocketConnection),
    );
  });
};
