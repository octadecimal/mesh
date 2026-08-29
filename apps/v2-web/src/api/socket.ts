import {
  V2_PROTOCOL_VERSION,
  clientRealtimeMessageSchema,
  serverRealtimeMessageSchema,
  type ProjectEventCursors,
} from '@mesh/v2-contracts';

import type { ProjectionAction, ProjectionDispatch } from '../state/reducer';

export interface WebSocketLike extends EventTarget {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

export type SocketOptions = {
  url: string;
  projectId: string;
  cursors: ProjectEventCursors;
  cursorSource?: ProjectCursorSource;
  dispatch: ProjectionDispatch;
  socketFactory?: (url: string) => WebSocketLike;
};

export type ProjectCursorSource = {
  getCursors(): ProjectEventCursors;
};

export type V2Socket = { close(): void; reconnect(): void };

const invalidPayload: ProjectionAction = {
  type: 'resync.required',
  reason: 'invalid_payload',
};

export const createV2Socket = (options: SocketOptions): V2Socket => {
  const socketFactory =
    options.socketFactory ?? ((url: string) => new WebSocket(url));
  let active: WebSocketLike | undefined;
  let closed = false;

  const connect = () => {
    const socket = socketFactory(options.url);
    active = socket;

    socket.addEventListener('open', () => {
      if (closed || socket !== active || socket.readyState !== socket.OPEN)
        return;
      const subscription = clientRealtimeMessageSchema.parse({
        type: 'v2.subscribe',
        protocolVersion: V2_PROTOCOL_VERSION,
        projectId: options.projectId,
        cursors: options.cursorSource?.getCursors() ?? options.cursors,
      });
      socket.send(JSON.stringify(subscription));
    });

    socket.addEventListener('message', (rawEvent) => {
      if (closed || socket !== active) return;
      const event = rawEvent as MessageEvent<unknown>;
      let raw: unknown;
      try {
        raw =
          typeof event.data === 'string' ? JSON.parse(event.data) : undefined;
      } catch {
        options.dispatch(invalidPayload);
        return;
      }
      const parsed = serverRealtimeMessageSchema.safeParse(raw);
      if (!parsed.success) {
        options.dispatch(invalidPayload);
        return;
      }
      const message = parsed.data;
      if (message.projectId !== options.projectId) {
        options.dispatch({
          type: 'resync.required',
          reason: 'project_mismatch',
        });
        return;
      }
      switch (message.type) {
        case 'v2.subscribed':
          options.dispatch({ type: 'transport.subscribed' });
          break;
        case 'v2.domain_event':
          options.dispatch({ type: 'domain.event', event: message.event });
          break;
        case 'v2.runtime_event':
          options.dispatch({ type: 'runtime.event', event: message.event });
          break;
        case 'v2.resync_required':
          options.dispatch({ type: 'resync.required', reason: message.reason });
          break;
      }
    });

    socket.addEventListener('close', () => {
      if (!closed && socket === active) {
        options.dispatch({ type: 'transport.disconnected' });
      }
    });
  };

  connect();
  return {
    close() {
      closed = true;
      active?.close();
      active = undefined;
    },
    reconnect() {
      closed = false;
      active?.close();
      connect();
    },
  };
};
