import {
  serverMessageSchema,
  type ServerMessage,
} from '@mesh-session-platform/contracts';

import { subscribeFrameSchema } from '@mesh-session-platform/contracts';

type WebSocketFactory = (url: string) => WebSocket;

export type MeshSocketOptions = {
  url: string;
  cursors: () => Record<string, number>;
  onMessage: (message: ServerMessage) => void;
  onDiagnostic: (message: string) => void;
  onReconnect?: (delayMs: number) => void;
  onResyncRequired?: (
    message: Extract<ServerMessage, { type: 'resync.required' }>,
  ) => void;
  resync?: () => Promise<void>;
  webSocket?: WebSocketFactory;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
};

export class MeshSocket {
  private readonly makeSocket: WebSocketFactory;
  private readonly schedule: typeof globalThis.setTimeout;
  private readonly cancel: typeof globalThis.clearTimeout;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private backoffMs: number;
  private closed = false;

  constructor(private readonly options: MeshSocketOptions) {
    this.makeSocket = options.webSocket ?? ((url) => new WebSocket(url));
    this.schedule = options.setTimeout ?? globalThis.setTimeout;
    this.cancel = options.clearTimeout ?? globalThis.clearTimeout;
    this.initialBackoffMs = options.initialBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.backoffMs = this.initialBackoffMs;
  }

  connect() {
    this.closed = false;
    this.open();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) this.cancel(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  private open() {
    const socket = this.makeSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.backoffMs = this.initialBackoffMs;
      socket.send(
        JSON.stringify(
          subscribeFrameSchema.parse({
            protocolVersion: 1,
            type: 'subscribe',
            cursors: this.options.cursors(),
          }),
        ),
      );
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => this.reconnect();
  }

  private receive(data: unknown) {
    let parsed: unknown;
    try {
      parsed = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      this.options.onDiagnostic('Mesh socket received invalid JSON.');
      return;
    }
    const message = serverMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.options.onDiagnostic(
        'Mesh socket received an invalid server payload.',
      );
      return;
    }
    this.options.onMessage(message.data);
    if (message.data.type === 'resync.required') {
      this.options.onResyncRequired?.(message.data);
      void this.options.resync?.().catch(() => {
        this.options.onDiagnostic(
          'Mesh socket could not refresh the snapshot after resync.',
        );
      });
    }
  }

  private reconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delayMs = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.options.onReconnect?.(delayMs);
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delayMs);
  }
}
