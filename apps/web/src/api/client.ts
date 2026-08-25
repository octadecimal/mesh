import {
  commandEnvelopeSchema,
  sessionDiagnosticsSchema,
  sessionHistorySchema,
  sessionSnapshotSchema,
  type MutatingCommand,
  type SessionDiagnostics,
  type SessionHistory,
  type SessionSnapshot,
} from '@mesh-session-platform/contracts';
import { z } from 'zod';

const commandResponseSchema = z.object({
  protocolVersion: z.literal(1),
  commandType: z.string(),
  result: z.unknown(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .default([]),
});

export type MeshApiOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export type CommandResponse = z.infer<typeof commandResponseSchema>;
export type DiagnosticsOptions = {
  after?: SessionDiagnostics['nextAfter'];
  limit?: number;
};

export class MeshApi {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(options: MeshApiOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? '';
  }

  async snapshot(): Promise<SessionSnapshot> {
    return sessionSnapshotSchema.parse(await this.request('/api/snapshot'));
  }

  async history(
    sessionId: string,
    afterSequence?: number,
  ): Promise<SessionHistory> {
    const query =
      afterSequence === undefined ? '' : `?afterSequence=${afterSequence}`;
    return sessionHistorySchema.parse(
      await this.request(
        `/api/sessions/${encodeURIComponent(sessionId)}/events${query}`,
      ),
    );
  }

  async diagnostics(
    sessionId: string,
    options: DiagnosticsOptions = {},
  ): Promise<SessionDiagnostics> {
    const parameters = new URLSearchParams();
    if (options.after) parameters.set('after', options.after);
    if (options.limit) parameters.set('limit', String(options.limit));
    const query = parameters.size ? `?${parameters}` : '';
    return sessionDiagnosticsSchema.parse(
      await this.request(
        `/api/sessions/${encodeURIComponent(sessionId)}/diagnostics${query}`,
      ),
    );
  }

  async command(
    command: MutatingCommand,
    idempotencyKey: string = globalThis.crypto.randomUUID(),
  ): Promise<CommandResponse> {
    const envelope = commandEnvelopeSchema.parse({
      protocolVersion: 1,
      idempotencyKey,
      command,
    });
    return commandResponseSchema.parse(
      await this.request('/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      }),
    );
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, init);
    const payload: unknown = await response.json();
    if (!response.ok)
      throw new Error(`Mesh API request failed (${response.status})`);
    return payload;
  }
}
