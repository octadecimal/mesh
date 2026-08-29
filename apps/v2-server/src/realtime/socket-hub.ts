import websocket from '@fastify/websocket';
import {
  V2_PROTOCOL_VERSION,
  clientRealtimeMessageSchema,
  projectIdSchema,
  serverRealtimeMessageSchema,
  type DomainEvent,
  type RetainedDomainWindow,
  type RetainedRuntimeWindow,
  type RuntimeEvent,
  type ServerRealtimeMessage,
} from '@mesh/v2-contracts';
import type { FastifyInstance } from 'fastify';

import type { V2EventPublisher } from './event-publisher.js';

export type V2SocketConnection = {
  once(name: 'message', listener: (data: unknown) => void): unknown;
  on(name: 'close' | 'error', listener: () => void): unknown;
  send(value: string): void;
  close(code?: number, reason?: string): void;
};

type EventReader = {
  domainAfter(
    projectId: string,
    after: number,
  ): RetainedDomainWindow | Promise<RetainedDomainWindow>;
  runtimeAfter(
    projectId: string,
    after: number,
  ): RetainedRuntimeWindow | Promise<RetainedRuntimeWindow>;
};

export type V2SocketHubOptions = {
  events: EventReader;
  publisher: V2EventPublisher;
  projectExists(projectId: string): boolean;
};

type StreamState<T extends DomainEvent | RuntimeEvent> = {
  cursor: number;
  buffering: boolean;
  buffer: T[];
};

type ActiveConnection = {
  socket: V2SocketConnection;
  cleanup(): void;
};

const textFrame = (data: unknown): string | undefined => {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return undefined;
};

export class V2SocketHub {
  private readonly connections = new Set<ActiveConnection>();

  constructor(private readonly options: V2SocketHubOptions) {}

  attach(socket: V2SocketConnection): void {
    const disposers: Array<() => void> = [];
    let cleaned = false;
    const connection: ActiveConnection = {
      socket,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        for (const dispose of disposers.splice(0)) dispose();
        this.connections.delete(connection);
      },
    };
    this.connections.add(connection);
    socket.on('close', connection.cleanup);
    socket.on('error', connection.cleanup);
    socket.once('message', (data) => {
      void this.subscribe(connection, disposers, data).catch(() => {
        connection.cleanup();
        socket.close(1011, 'Replay unavailable');
      });
    });
  }

  close(): void {
    for (const connection of [...this.connections]) {
      connection.cleanup();
      connection.socket.close(1001, 'Server shutting down');
    }
  }

  private async subscribe(
    connection: ActiveConnection,
    disposers: Array<() => void>,
    data: unknown,
  ): Promise<void> {
    const raw = textFrame(data);
    let candidate: unknown;
    try {
      candidate = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      candidate = undefined;
    }
    const parsed = clientRealtimeMessageSchema.safeParse(candidate);
    const project = projectIdSchema.safeParse(
      (candidate as { projectId?: unknown } | undefined)?.projectId,
    );
    if (!parsed.success) {
      if (project.success) {
        this.resync(connection, project.data, 'invalid_payload');
      } else {
        connection.cleanup();
        connection.socket.close(1008, 'Invalid subscription');
      }
      return;
    }
    const subscription = parsed.data;
    if (!this.options.projectExists(subscription.projectId)) {
      this.resync(connection, subscription.projectId, 'project_mismatch');
      return;
    }

    const domain: StreamState<DomainEvent> = {
      cursor: subscription.cursors.domain,
      buffering: true,
      buffer: [],
    };
    const runtime: StreamState<RuntimeEvent> = {
      cursor: subscription.cursors.runtime,
      buffering: true,
      buffer: [],
    };
    disposers.push(
      this.options.publisher.subscribeDomain(
        subscription.projectId,
        (event) => {
          this.deliverPublished(connection, () => {
            if (event.projectId !== subscription.projectId) {
              this.resync(
                connection,
                subscription.projectId,
                'project_mismatch',
              );
            } else if (domain.buffering) domain.buffer.push(event);
            else
              this.deliverLive(
                connection,
                subscription.projectId,
                domain,
                event,
              );
          });
        },
      ),
      this.options.publisher.subscribeRuntime(
        subscription.projectId,
        (event) => {
          this.deliverPublished(connection, () => {
            if (event.projectId !== subscription.projectId) {
              this.resync(
                connection,
                subscription.projectId,
                'project_mismatch',
              );
            } else if (runtime.buffering) runtime.buffer.push(event);
            else
              this.deliverLive(
                connection,
                subscription.projectId,
                runtime,
                event,
              );
          });
        },
      ),
    );

    const domainWindow = await this.options.events.domainAfter(
      subscription.projectId,
      domain.cursor,
    );
    if (
      !this.deliverReplay(
        connection,
        subscription.projectId,
        domain,
        domainWindow,
      )
    )
      return;
    const runtimeWindow = await this.options.events.runtimeAfter(
      subscription.projectId,
      runtime.cursor,
    );
    if (
      !this.deliverReplay(
        connection,
        subscription.projectId,
        runtime,
        runtimeWindow,
      )
    )
      return;
    if (!this.drain(connection, subscription.projectId, domain)) return;
    if (!this.drain(connection, subscription.projectId, runtime)) return;
    this.send(connection, {
      type: 'v2.subscribed',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId: subscription.projectId,
      cursors: { domain: domain.cursor, runtime: runtime.cursor },
    });
  }

  private deliverReplay<T extends DomainEvent | RuntimeEvent>(
    connection: ActiveConnection,
    projectId: string,
    state: StreamState<T>,
    window: { lowWater: number; highWater: number; events: readonly T[] },
  ): boolean {
    if (state.cursor < window.lowWater - 1 || state.cursor > window.highWater) {
      this.resync(connection, projectId, 'retained_gap');
      return false;
    }
    for (const event of window.events) {
      if (event.sequence <= state.cursor) continue;
      if (event.sequence !== state.cursor + 1) {
        this.resync(connection, projectId, 'retained_gap');
        return false;
      }
      this.sendEvent(connection, event);
      state.cursor = event.sequence;
    }
    if (state.cursor !== window.highWater) {
      this.resync(connection, projectId, 'retained_gap');
      return false;
    }
    return true;
  }

  private drain<T extends DomainEvent | RuntimeEvent>(
    connection: ActiveConnection,
    projectId: string,
    state: StreamState<T>,
  ): boolean {
    while (state.buffer.length > 0) {
      for (const event of state.buffer.splice(0)) {
        if (event.sequence <= state.cursor) continue;
        if (event.sequence !== state.cursor + 1) {
          this.resync(connection, projectId, 'non_contiguous_buffer');
          return false;
        }
        this.sendEvent(connection, event);
        state.cursor = event.sequence;
      }
    }
    state.buffering = false;
    return true;
  }

  private deliverLive<T extends DomainEvent | RuntimeEvent>(
    connection: ActiveConnection,
    projectId: string,
    state: StreamState<T>,
    event: T,
  ): void {
    if (event.sequence <= state.cursor) return;
    if (event.sequence !== state.cursor + 1) {
      this.resync(connection, projectId, 'non_contiguous_buffer');
      return;
    }
    this.sendEvent(connection, event);
    state.cursor = event.sequence;
  }

  private sendEvent(
    connection: ActiveConnection,
    event: DomainEvent | RuntimeEvent,
  ): void {
    this.send(
      connection,
      'diagnosticId' in event
        ? {
            type: 'v2.runtime_event',
            protocolVersion: V2_PROTOCOL_VERSION,
            projectId: event.projectId,
            event,
          }
        : {
            type: 'v2.domain_event',
            protocolVersion: V2_PROTOCOL_VERSION,
            projectId: event.projectId,
            event,
          },
    );
  }

  private deliverPublished(
    connection: ActiveConnection,
    deliver: () => void,
  ): void {
    try {
      deliver();
    } catch {
      connection.cleanup();
      try {
        connection.socket.close(1011, 'Socket delivery failed');
      } catch {
        // The listener is removed even when a broken transport cannot close.
      }
    }
  }

  private resync(
    connection: ActiveConnection,
    projectId: string,
    reason: Extract<
      ServerRealtimeMessage,
      { type: 'v2.resync_required' }
    >['reason'],
  ): void {
    this.send(connection, {
      type: 'v2.resync_required',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      reason,
    });
    connection.cleanup();
    connection.socket.close(1008, 'Resynchronization required');
  }

  private send(connection: ActiveConnection, message: ServerRealtimeMessage) {
    connection.socket.send(
      JSON.stringify(serverRealtimeMessageSchema.parse(message)),
    );
  }
}

const loopback = (address: string | undefined) =>
  address === '::1' ||
  address?.startsWith('127.') ||
  address?.startsWith('::ffff:127.');

export const registerV2SocketHub = (
  app: FastifyInstance,
  hub: V2SocketHub,
  options: { allowedOrigins: ReadonlySet<string>; isAccepting(): boolean },
): void => {
  void app.register(async (scope) => {
    await scope.register(websocket);
    scope.get(
      '/api/v2/realtime',
      {
        websocket: true,
        preValidation: (request, reply, done) => {
          if (!options.isAccepting()) {
            void reply.status(503).send();
            return;
          }
          if (
            !loopback(request.raw.socket.remoteAddress) ||
            !request.headers.origin ||
            !options.allowedOrigins.has(request.headers.origin)
          ) {
            void reply.status(403).send();
            return;
          }
          done();
        },
      },
      (socket) => hub.attach(socket as unknown as V2SocketConnection),
    );
  });
};
