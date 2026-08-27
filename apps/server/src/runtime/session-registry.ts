import type { PermissionMode } from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type {
  AgentRuntimeConfiguration,
  ClaudeSessionDriver,
  DeveloperRuntimeConfiguration,
  DriverSession,
  RoleRuntimeConfiguration,
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
  onRuntimeStopped?: (sessionId: string) => void;
  shutdownTimeoutMs?: number;
  closeDatabase?: () => void;
}

type PendingAttachCancellation = 'audit' | 'interrupt' | 'shutdown';

type PendingAttach = {
  cancellation?: PendingAttachCancellation;
  settled: Promise<void>;
  resolveSettled(): void;
};

export class SessionRegistry {
  readonly publisher: EventPublisher;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly pendingAttaches = new Map<string, PendingAttach>();
  private readonly repairReservations = new Set<string>();
  private unavailable = false;
  private shuttingDown = false;

  constructor(private readonly dependencies: SessionRegistryDependencies) {
    this.publisher = dependencies.publisher ?? new EventPublisher();
  }

  get auditStatus(): 'available' | 'audit_unavailable' {
    return this.unavailable ? 'audit_unavailable' : 'available';
  }

  reportAuditFailure(error: unknown): void {
    this.tripAuditBarrier(error);
  }

  async create(
    sessionId: string,
    configuration?: AgentRuntimeConfiguration,
  ): Promise<void> {
    await this.attach(sessionId, 'create', configuration);
  }

  async resume(
    sessionId: string,
    configuration: { workspaceId: string; permissionMode: PermissionMode },
    runtimeConfiguration?: AgentRuntimeConfiguration,
  ): Promise<void> {
    const configured = this.dependencies.sessions.configureResume(
      sessionId,
      configuration.workspaceId,
      configuration.permissionMode,
    );
    if (!configured) throw { code: 'session_not_found', sessionId };
    await this.attach(sessionId, 'resume', runtimeConfiguration);
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    this.assertWritable();
    const runtime = this.requireRuntime(sessionId);
    await runtime.sendPrompt(prompt);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.assertWritable();
    const pending = this.pendingAttaches.get(sessionId);
    if (pending) {
      this.cancelPendingAttach(sessionId, pending, 'interrupt');
      return;
    }
    this.invalidateDeveloperCapability(sessionId);
    await this.requireRuntime(sessionId).interrupt();
  }

  async emergencyClose(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.emergencyInterrupt();
    await runtime.forceClose();
  }

  reserveRepair(sessionId: string): (() => void) | undefined {
    this.assertWritable();
    if (
      this.runtimes.has(sessionId) ||
      this.pendingAttaches.has(sessionId) ||
      this.repairReservations.has(sessionId)
    ) {
      return undefined;
    }
    this.repairReservations.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.repairReservations.delete(sessionId);
    };
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
    const pendingEntries = [...this.pendingAttaches.entries()];
    for (const [sessionId, pending] of pendingEntries) {
      this.cancelPendingAttach(sessionId, pending, 'shutdown');
    }
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
    await waitWithinDeadline(
      Promise.allSettled([
        ...interruptions,
        ...pendingEntries.map(([, pending]) => pending.settled),
      ]),
    );
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
    configuration?: AgentRuntimeConfiguration,
  ): Promise<void> {
    this.assertWritable();
    if (
      this.runtimes.has(sessionId) ||
      this.pendingAttaches.has(sessionId) ||
      this.repairReservations.has(sessionId)
    ) {
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

    let resolveSettled!: () => void;
    const pending: PendingAttach = {
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      resolveSettled: () => resolveSettled(),
    };
    this.pendingAttaches.set(sessionId, pending);
    const runtimeRef: { current?: SessionRuntime } = {};
    let stopped = false;
    const onStopped = () => {
      if (stopped) return;
      stopped = true;
      const runtime = runtimeRef.current;
      if (runtime && this.runtimes.get(sessionId) === runtime) {
        this.runtimes.delete(sessionId);
        this.invalidateDeveloperCapability(sessionId);
        try {
          this.dependencies.onRuntimeStopped?.(sessionId);
        } catch (error) {
          this.tripAuditBarrier(error);
        }
      }
    };
    let placeholder: DriverSession | undefined;
    const role = isRoleRuntimeConfiguration(configuration)
      ? configuration
      : undefined;
    const developer = isDeveloperRuntimeConfiguration(configuration)
      ? configuration
      : undefined;
    try {
      placeholder = await (mode === 'create'
        ? this.dependencies.driver.create({
            title: session.title,
            workspacePath: workspace.path,
            permissionMode: session.permissionMode,
            developer,
            role,
          })
        : this.dependencies.driver.resume({
            claudeResumeId: session.claudeResumeId!,
            workspacePath: workspace.path,
            permissionMode: session.permissionMode,
            developer,
            role,
          }));
      this.assertPendingAttachCurrent(sessionId, pending);
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
      this.pendingAttaches.delete(sessionId);
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
      const runtime = runtimeRef.current;
      if (runtime && this.runtimes.get(sessionId) === runtime) {
        this.runtimes.delete(sessionId);
        this.invalidateDeveloperCapability(sessionId);
      } else if (
        this.pendingAttaches.get(sessionId) === pending &&
        !pending.cancellation
      ) {
        this.invalidateDeveloperCapability(sessionId);
      }
      await placeholder?.interrupt().catch(() => undefined);
      await placeholder?.close().catch(() => undefined);
      throw error;
    } finally {
      if (this.pendingAttaches.get(sessionId) === pending) {
        this.pendingAttaches.delete(sessionId);
      }
      pending.resolveSettled();
    }
  }

  private assertPendingAttachCurrent(
    sessionId: string,
    pending: PendingAttach,
  ): void {
    this.assertWritable();
    if (
      this.pendingAttaches.get(sessionId) === pending &&
      !pending.cancellation
    ) {
      return;
    }
    throw {
      code: 'invalid_session_state',
      from: 'interrupting',
      trigger: pending.cancellation ?? 'driver_required',
    };
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
    for (const [sessionId, pending] of this.pendingAttaches) {
      this.cancelPendingAttach(sessionId, pending, 'audit');
    }
    for (const [sessionId, runtime] of this.runtimes) {
      this.invalidateDeveloperCapability(sessionId);
      runtime.emergencyInterrupt();
    }
  }

  private cancelPendingAttach(
    sessionId: string,
    pending: PendingAttach,
    cancellation: PendingAttachCancellation,
  ): void {
    if (
      this.pendingAttaches.get(sessionId) !== pending ||
      pending.cancellation
    ) {
      return;
    }
    pending.cancellation = cancellation;
    this.invalidateDeveloperCapability(sessionId);
  }

  private invalidateDeveloperCapability(sessionId: string): void {
    this.dependencies.invalidateDeveloperCapability?.(sessionId);
  }
}

const isRoleRuntimeConfiguration = (
  configuration: AgentRuntimeConfiguration | undefined,
): configuration is RoleRuntimeConfiguration =>
  configuration !== undefined &&
  'role' in configuration &&
  configuration.role === 'qa';

const isDeveloperRuntimeConfiguration = (
  configuration: AgentRuntimeConfiguration | undefined,
): configuration is DeveloperRuntimeConfiguration =>
  configuration !== undefined && 'controls' in configuration;
