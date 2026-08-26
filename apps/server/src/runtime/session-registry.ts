import type { PermissionMode } from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type {
  ClaudeSessionDriver,
  DeveloperRuntimeConfiguration,
  DriverSession,
} from '../claude/driver.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import { EventPublisher } from './event-publisher.js';
import { AuditUnavailableError, SessionRuntime } from './session-runtime.js';

interface SessionRegistryDependencies {
  database: Database;
  sessions: SessionRepository;
  workspaces: WorkspaceRepository;
  events: EventRepository;
  diagnostics: DiagnosticRepository;
  driver: ClaudeSessionDriver;
  publisher?: EventPublisher;
  invalidateDeveloperCapability?: (sessionId: string) => void;
  shutdownTimeoutMs?: number;
  closeDatabase?: () => void;
}

export class SessionRegistry {
  readonly publisher: EventPublisher;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private unavailable = false;
  private shuttingDown = false;

  constructor(private readonly dependencies: SessionRegistryDependencies) {
    this.publisher = dependencies.publisher ?? new EventPublisher();
  }

  get auditStatus(): 'available' | 'audit_unavailable' {
    return this.unavailable ? 'audit_unavailable' : 'available';
  }

  async create(
    sessionId: string,
    developer?: DeveloperRuntimeConfiguration,
  ): Promise<void> {
    await this.attach(sessionId, 'create', developer);
  }

  async resume(
    sessionId: string,
    configuration: { workspaceId: string; permissionMode: PermissionMode },
    developer?: DeveloperRuntimeConfiguration,
  ): Promise<void> {
    const configured = this.dependencies.sessions.configureResume(
      sessionId,
      configuration.workspaceId,
      configuration.permissionMode,
    );
    if (!configured) throw { code: 'session_not_found', sessionId };
    await this.attach(sessionId, 'resume', developer);
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    this.assertWritable();
    const runtime = this.requireRuntime(sessionId);
    await runtime.sendPrompt(prompt);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.assertWritable();
    this.invalidateDeveloperCapability(sessionId);
    await this.requireRuntime(sessionId).interrupt();
  }

  async resolvePermission(
    sessionId: string,
    requestId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    this.assertWritable();
    await this.requireRuntime(sessionId).resolvePermission(requestId, decision);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const runtimeEntries = [...this.runtimes.entries()];
    for (const [sessionId] of runtimeEntries) {
      this.invalidateDeveloperCapability(sessionId);
    }
    const runtimes = runtimeEntries.map(([, runtime]) => runtime);
    const timeoutMs = this.dependencies.shutdownTimeoutMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    const waitWithinDeadline = async (
      pending: Promise<unknown>,
    ): Promise<void> => {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, remaining);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    };
    const interruptions = runtimes.map((runtime) =>
      runtime.interrupt().catch(() => undefined),
    );
    await waitWithinDeadline(Promise.allSettled(interruptions));
    const closures = runtimes.map((runtime) =>
      runtime.forceClose().catch(() => undefined),
    );
    await waitWithinDeadline(Promise.allSettled(closures));
    (
      this.dependencies.closeDatabase ??
      (() => this.dependencies.database.close())
    )();
  }

  private async attach(
    sessionId: string,
    mode: 'create' | 'resume',
    developer?: DeveloperRuntimeConfiguration,
  ): Promise<void> {
    this.assertWritable();
    if (this.runtimes.has(sessionId)) {
      const state =
        this.dependencies.sessions.get(sessionId)?.lifecycleState ?? 'running';
      throw { code: 'invalid_session_state', from: state, trigger: mode };
    }
    const session = this.dependencies.sessions.get(sessionId);
    if (!session) throw { code: 'session_not_found', sessionId };
    const workspace = this.dependencies.workspaces.get(session.workspaceId);
    if (!workspace)
      throw { code: 'workspace_not_found', workspaceId: session.workspaceId };
    if (mode === 'create' && session.lifecycleState !== 'idle') {
      throw {
        code: 'invalid_session_state',
        from: session.lifecycleState,
        trigger: 'start',
      };
    }
    if (mode === 'resume' && !session.claudeResumeId) {
      throw {
        code: 'invalid_session_state',
        from: session.lifecycleState,
        trigger: 'resume',
      };
    }

    const runtimeRef: { current?: SessionRuntime } = {};
    const onStopped = () => {
      this.invalidateDeveloperCapability(sessionId);
      if (
        runtimeRef.current &&
        this.runtimes.get(sessionId) === runtimeRef.current
      )
        this.runtimes.delete(sessionId);
    };
    let placeholder: DriverSession | undefined;
    try {
      placeholder = await (mode === 'create'
        ? this.dependencies.driver.create({
            title: session.title,
            workspacePath: workspace.path,
            permissionMode: session.permissionMode,
            developer,
          })
        : this.dependencies.driver.resume({
            claudeResumeId: session.claudeResumeId!,
            workspacePath: workspace.path,
            permissionMode: session.permissionMode,
            developer,
          }));
      const runtime = new SessionRuntime({
        session,
        driverSession: placeholder,
        events: this.dependencies.events,
        diagnostics: this.dependencies.diagnostics,
        publisher: this.publisher,
        onAuditFailure: (error) => this.tripAuditBarrier(error),
        onStopped,
      });
      runtimeRef.current = runtime;
      this.runtimes.set(sessionId, runtime);
      runtime.persistTransition({
        type: mode === 'create' ? 'start' : 'resume',
      });
      runtime.persistTransition(
        { type: 'driver_started' },
        undefined,
        placeholder.claudeResumeId,
      );
      runtime.startConsuming();
    } catch (error) {
      this.runtimes.delete(sessionId);
      this.invalidateDeveloperCapability(sessionId);
      await placeholder?.interrupt().catch(() => undefined);
      await placeholder?.close().catch(() => undefined);
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.unavailable) throw new AuditUnavailableError();
    if (this.shuttingDown)
      throw {
        code: 'invalid_session_state',
        from: 'interrupting',
        trigger: 'shutdown',
      };
  }

  private requireRuntime(sessionId: string): SessionRuntime {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) return runtime;
    const state =
      this.dependencies.sessions.get(sessionId)?.lifecycleState ??
      'interrupted';
    throw {
      code: 'invalid_session_state',
      from: state,
      trigger: 'driver_required',
    };
  }

  private tripAuditBarrier(_error: unknown): void {
    if (this.unavailable) return;
    this.unavailable = true;
    for (const [sessionId, runtime] of this.runtimes) {
      this.invalidateDeveloperCapability(sessionId);
      runtime.emergencyInterrupt();
    }
  }

  private invalidateDeveloperCapability(sessionId: string): void {
    this.dependencies.invalidateDeveloperCapability?.(sessionId);
  }
}
