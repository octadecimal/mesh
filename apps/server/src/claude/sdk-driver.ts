import type { PermissionMode } from '@mesh-session-platform/contracts';

import type {
  ClaudeSessionDriver,
  DeveloperRuntimeConfiguration,
  DiscoverClaudeSessionsRequest,
  DiscoveredClaudeSession,
  DriverEvent,
  DriverSession,
  ResumeClaudeSessionRequest,
  StartClaudeSessionRequest,
} from './driver.js';
import { permissionPolicy } from './permission-policy.js';

export type SdkStreamEvent =
  | { kind: 'started'; sessionId: string; apiKeySource?: string }
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_requested'; toolCallId: string; name: string; input: unknown }
  | {
      kind: 'tool_completed';
      toolCallId: string;
      output: unknown;
      isError: boolean;
    }
  | { kind: 'limit'; capability: string; message: string; resetAt?: string }
  | { kind: 'error'; code: string; message: string; details?: unknown }
  | { kind: 'malformed'; raw: unknown }
  | { kind: 'completed' };

export interface SdkPermissionRequest {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  input: unknown;
}

export type SdkPermissionDecision = 'approve' | 'deny';

export interface SdkQueryOptions {
  cwd?: string;
  title?: string;
  resume?: string;
  developer?: DeveloperRuntimeConfiguration;
  onPermission?(request: SdkPermissionRequest): Promise<SdkPermissionDecision>;
}

export interface SdkQuery {
  readonly sessionId?: string;
  events(): AsyncIterable<SdkStreamEvent>;
  sendPrompt(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}

export interface SdkFacade {
  listSessions(options: {
    cwd?: string;
  }): Promise<Array<{ sessionId: string; title?: string }>>;
  startQuery(options: SdkQueryOptions): SdkQuery;
}

export class UnsupportedSdkCapabilityError extends Error {
  readonly code = 'unsupported_claude_capability';

  constructor(readonly capability: string) {
    super(
      `Installed Claude Agent SDK does not support required capability: ${capability}`,
    );
    this.name = 'UnsupportedSdkCapabilityError';
  }
}

type PendingPermission = {
  resolve: (decision: SdkPermissionDecision) => void;
};

class SdkDriverSession implements DriverSession {
  claudeResumeId: string | undefined;
  private readonly iterator: AsyncIterator<SdkStreamEvent>;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly sideEvents: DriverEvent[] = [];
  private sideWake: (() => void) | undefined;
  private bufferedSdkEvents: SdkStreamEvent[] = [];
  private closed = false;

  constructor(
    private readonly query: SdkQuery,
    private readonly mode: PermissionMode,
  ) {
    this.iterator = query.events()[Symbol.asyncIterator]();
  }

  async initialize(): Promise<void> {
    if (this.query.sessionId) {
      this.claudeResumeId = this.query.sessionId;
      return;
    }
    while (true) {
      const next = await this.iterator.next();
      if (next.done || next.value.kind === 'completed') {
        throw new UnsupportedSdkCapabilityError('session_identity');
      }
      if (next.value.kind === 'started') {
        this.claudeResumeId = next.value.sessionId;
        return;
      }
      this.bufferedSdkEvents.push(next.value);
    }
  }

  async *events(): AsyncIterable<DriverEvent> {
    let pendingNext: Promise<IteratorResult<SdkStreamEvent>> | undefined;
    try {
      while (!this.closed) {
        const sideEvent = this.sideEvents.shift();
        if (sideEvent) {
          yield sideEvent;
          continue;
        }

        const buffered = this.bufferedSdkEvents.shift();
        if (buffered) {
          const mapped = this.mapEvent(buffered);
          if (mapped === null) return;
          if (mapped) yield mapped;
          continue;
        }

        pendingNext ??= this.iterator.next();
        const winner = await Promise.race([
          pendingNext.then((value) => ({ kind: 'sdk' as const, value })),
          new Promise<{ kind: 'side' }>((resolve) => {
            this.sideWake = () => resolve({ kind: 'side' });
          }),
        ]);
        this.sideWake = undefined;
        if (winner.kind === 'side') continue;
        pendingNext = undefined;
        if (winner.value.done) return;
        const mapped = this.mapEvent(winner.value.value);
        if (mapped === null) return;
        if (mapped) yield mapped;
      }
    } catch (error) {
      yield {
        kind: 'terminal_error',
        code: 'claude_sdk_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async handlePermission(
    request: SdkPermissionRequest,
  ): Promise<SdkPermissionDecision> {
    const decision = permissionPolicy(this.mode).decide({
      toolName: request.toolName,
      input: request.input,
    });
    if (decision.action === 'approve') return 'approve';
    if (decision.action === 'delegate') {
      throw new Error(
        'Inherited permissions must not install an SDK permission callback',
      );
    }
    if (this.pendingPermissions.has(request.requestId)) {
      throw new Error(
        `Permission request '${request.requestId}' is already pending`,
      );
    }
    const result = new Promise<SdkPermissionDecision>((resolve) => {
      this.pendingPermissions.set(request.requestId, { resolve });
    });
    this.sideEvents.push({
      kind: 'permission_requested',
      permissionId: request.requestId,
      toolCallId: request.toolUseId,
      name: request.toolName,
      input: request.input,
    });
    this.signalSideEvent();
    return result;
  }

  async sendPrompt(prompt: string): Promise<void> {
    await this.query.sendPrompt(prompt);
  }

  async resolvePermission(
    requestId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending)
      throw new Error(`Permission request '${requestId}' is not pending`);
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pendingPermissions.values())
      pending.resolve('deny');
    this.pendingPermissions.clear();
    this.query.close();
    this.signalSideEvent();
  }

  private mapEvent(event: SdkStreamEvent): DriverEvent | undefined | null {
    switch (event.kind) {
      case 'started':
        this.claudeResumeId = event.sessionId;
        return undefined;
      case 'assistant_delta':
        return { kind: 'text_delta', text: event.text };
      case 'assistant_text':
        return { kind: 'text_completed', text: event.text };
      case 'tool_requested':
        return event;
      case 'tool_completed':
        return event;
      case 'limit':
        return event;
      case 'error':
        return {
          kind: 'terminal_error',
          code: event.code,
          message: event.message,
          details: event.details,
        };
      case 'malformed':
        return { kind: 'malformed', raw: event.raw };
      case 'completed':
        return undefined;
    }
  }

  private signalSideEvent(): void {
    const wake = this.sideWake;
    this.sideWake = undefined;
    wake?.();
  }
}

export class SdkClaudeSessionDriver implements ClaudeSessionDriver {
  constructor(private readonly sdk: SdkFacade) {}

  async discover(
    request: DiscoverClaudeSessionsRequest,
  ): Promise<DiscoveredClaudeSession[]> {
    const sessions = await this.sdk.listSessions({
      cwd: request.workspacePath,
    });
    return sessions.map((session) => ({
      claudeResumeId: session.sessionId,
      title: session.title,
    }));
  }

  async create(request: StartClaudeSessionRequest): Promise<DriverSession> {
    return this.start(request);
  }

  async resume(request: ResumeClaudeSessionRequest): Promise<DriverSession> {
    return this.start(request, request.claudeResumeId);
  }

  private async start(
    request: StartClaudeSessionRequest | ResumeClaudeSessionRequest,
    resume?: string,
  ): Promise<SdkDriverSession> {
    const mode = request.permissionMode ?? 'interactive';
    const sessionRef: { current?: SdkDriverSession } = {};
    const options: SdkQueryOptions = {
      cwd: request.workspacePath,
      title: 'title' in request ? request.title : undefined,
      resume,
      developer: request.developer,
    };
    if (mode !== 'inherit') {
      options.onPermission = (permission) => {
        if (!sessionRef.current)
          throw new Error(
            'Claude SDK requested permission before session initialization',
          );
        return sessionRef.current.handlePermission(permission);
      };
    }
    const query = this.sdk.startQuery(options);
    const session = new SdkDriverSession(query, mode);
    sessionRef.current = session;
    await session.initialize();
    if (request.developer) {
      await session.sendPrompt(request.developer.initialPrompt);
    }
    return session;
  }
}
