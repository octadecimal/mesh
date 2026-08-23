import http from 'node:http';
import type { EventBus } from './bus.ts';
import type { StampedEvent } from './types.ts';

export interface ApiOptions {
  bus: EventBus;
  onMessage: (text: string) => void;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function frame(event: StampedEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function handleEvents(request: http.IncomingMessage, response: http.ServerResponse, bus: EventBus): void {
  const header = request.headers['last-event-id'];
  const since = Number.parseInt(Array.isArray(header) ? header[0] : (header ?? '0'), 10);

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  // A client that vanishes without a clean TCP FIN (dropped mobile network,
  // backgrounded tab, NAT timeout) never fires 'close' — the dead socket is
  // only discovered by the next write, which emits 'error'. Without a
  // listener that error is thrown and takes down the whole process.
  response.on('error', () => {});

  const write = (chunk: string) => {
    try {
      response.write(chunk);
    } catch {
      // The socket is already gone; 'close' will run cleanup.
    }
  };

  // Node holds the headers back until something is written, so an empty replay
  // buffer would leave the client with no response at all until the first
  // heartbeat — 15 seconds of a browser showing no connection. Open the stream
  // straight away.
  write(': open\n\n');

  for (const event of bus.history(Number.isNaN(since) ? 0 : since)) {
    write(frame(event));
  }

  const unsubscribe = bus.subscribe((event) => write(frame(event)));

  // Comment frames keep intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => write(': ping\n\n'), 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on('close', cleanup);
  response.on('close', cleanup);
}

export function createServer(options: ApiOptions): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      handleEvents(request, response, options.bus);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/message') {
      void readBody(request)
        .then((body) => {
          let text: unknown;
          try {
            text = (JSON.parse(body) as { text?: unknown }).text;
          } catch {
            sendJson(response, 400, { error: 'invalid json' });
            return;
          }
          if (typeof text !== 'string' || text.trim().length === 0) {
            sendJson(response, 400, { error: 'text is required' });
            return;
          }
          options.onMessage(text);
          sendJson(response, 202, { accepted: true });
        })
        .catch(() => {
          // The request aborted mid-body (e.g. client disconnected while
          // uploading). Respond if we still can; otherwise there is nothing
          // left to do — the socket is already gone.
          if (!response.headersSent) sendJson(response, 400, { error: 'request aborted' });
        });
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  });
}
