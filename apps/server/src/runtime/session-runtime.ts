import { createHash, randomUUID } from 'node:crypto';

import {
  rawDiagnosticSchema,
  type LifecycleState,
  type RawDiagnostic,
  type Session,
  type SessionEvent,
} from '@mesh-session-platform/contracts';

import type { DriverEvent, DriverSession } from '../claude/driver.js';
import { normalizeDriverEvent, type DriverEventDraft } from '../claude/normalize-event.js';
import { permissionPolicy } from '../claude/permission-policy.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { EventRepository, SessionEventDraft } from '../repositories/event-repository.js';
import { EventPublisher } from './event-publisher.js';
import { InvalidSessionStateError, transition, type LifecycleTrigger } from './lifecycle.js';

export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';

  constructor() {
    super('Durable audit persistence is unavailable');
  }
}

const stablePayload = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
      if (!Array.isArray(item)) {
        return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
      }
    }
    return item;
  });
  return serialized ?? JSON.stringify({ unrepresentable: String(value) });
};

const fingerprint = (sessionId: string, raw: unknown): string =>
  createHash('sha256').update(sessionId).update('\0').update(stablePayload(raw)).digest('hex');

const now = (): string => new Date().toISOString();

interface RuntimeDependencies {
  session: Session;
  driverSession: DriverSession;
  events: EventRepository;
  diagnostics: DiagnosticRepository;
  publisher: EventPublisher;
  onAuditFailure: (error: unknown) => void;
  onStopped: () => void;
}

export class SessionRuntime {
  private state: LifecycleState;
  private readonly appliedDriverEvents = new Set<string>();
  private consuming: Promise<void> | undefined;

  constructor(private readonly dependencies: RuntimeDependencies) {
    this.state = dependencies.session.lifecycleState;
  }

  get lifecycleState(): LifecycleState {
    return this.state;
  }

  startConsuming(): void {
    this.consuming ??= this.consume();
  }

  persistTransition(trigger: LifecycleTrigger, reason?: string, claudeResumeId?: string): SessionEvent {
    const next = transition(this.state, trigger);
    return this.persist({
      type: 'session.status',
      payload: { from: this.state, to: next, reason },
    }, { kind: 'runtime_transition', trigger: trigger.type, reason }, next, claudeResumeId);
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'running') {
      throw new InvalidSessionStateError(this.state, 'start');
    }
    this.persist({ type: 'message.user', payload: { text: prompt } }, { kind: 'user_prompt', prompt });
    await this.dependencies.driverSession.sendPrompt(prompt);
  }

  async resolvePermission(requestId: string, decision: 'approve' | 'deny'): Promise<void> {
    if (this.state !== 'waiting_for_approval') {
      throw new InvalidSessionStateError(this.state, 'permission_resolved');
    }
    const next = transition(this.state, { type: 'permission_resolved' });
    this.persist({
      type: 'permission.resolved',
      payload: {
        permissionId: requestId,
        decision: decision === 'approve' ? 'approved' : 'denied',
        resolvedAt: now(),
      },
    }, { kind: 'permission_resolution', requestId, decision }, next);
    await this.dependencies.driverSession.resolvePermission(requestId, decision);
  }

  async interrupt(): Promise<void> {
    if (this.state !== 'interrupting') this.persistTransition({ type: 'interrupt' });
    await this.dependencies.driverSession.interrupt();
    await this.forceClose();
  }

  emergencyInterrupt(): void {
    void this.dependencies.driverSession.interrupt().catch(() => undefined);
  }

  async forceClose(): Promise<void> {
    await this.dependencies.driverSession.close().catch(() => undefined);
    if (this.state === 'interrupting') this.persistTransition({ type: 'driver_stopped' });
    this.dependencies.onStopped();
  }

  private async consume(): Promise<void> {
    try {
      for await (const raw of this.dependencies.driverSession.events()) {
        await this.applyDriverEvent(raw);
      }
      if (this.state !== 'interrupting' && this.state !== 'completed' && this.state !== 'failed' && this.state !== 'interrupted') {
        await this.handleCrash(new Error('Driver event stream ended unexpectedly'));
      }
    } catch (error) {
      await this.handleCrash(error);
    } finally {
      this.dependencies.onStopped();
    }
  }

  private async applyDriverEvent(raw: DriverEvent): Promise<void> {
    const key = fingerprint(this.dependencies.session.id, raw);
    if (this.appliedDriverEvents.has(key)) return;
    const normalized = normalizeDriverEvent(raw);
    if (normalized.kind === 'unsupported') {
      this.insertDiagnostic(`diagnostic-${key}`, normalized.raw);
      this.appliedDriverEvents.add(key);
      return;
    }

    let draft: DriverEventDraft | SessionEventDraft = normalized.event;
    let next: LifecycleState | undefined;
    let automaticPermission: { requestId: string; decision: 'approve' } | undefined;
    if (normalized.event.type === 'permission.requested') {
      const request = normalized.event.payload;
      draft = { ...normalized.event, payload: { ...request, actions: ['approve', 'deny'] } };
      const decision = permissionPolicy(this.dependencies.session.permissionMode).decide({
        toolName: request.name,
        input: request.input,
      });
      if (decision.action === 'prompt') next = transition(this.state, { type: 'permission_requested' });
      if (decision.action === 'approve') {
        automaticPermission = { requestId: request.permissionId, decision: 'approve' };
      }
    } else if (normalized.event.type === 'session.status') {
      next = this.statusTransition(normalized.event.payload.to);
    }

    this.persist(draft, raw, next, undefined, key);
    this.appliedDriverEvents.add(key);
    if (automaticPermission) {
      this.persist({
        type: 'permission.resolved',
        payload: {
          permissionId: automaticPermission.requestId,
          decision: 'approved',
          resolvedAt: now(),
        },
      }, { kind: 'permission_resolution', ...automaticPermission });
      await this.dependencies.driverSession.resolvePermission(
        automaticPermission.requestId,
        automaticPermission.decision,
      );
    }
  }

  private statusTransition(to: LifecycleState): LifecycleState {
    if (to === 'completed') return transition(this.state, { type: 'driver_completed' });
    if (to === 'failed') return transition(this.state, { type: 'driver_failed' });
    if (to === 'interrupted') return transition(this.state, { type: 'driver_crashed' });
    if (to === this.state) return this.state;
    throw new InvalidSessionStateError(this.state, 'driver_started');
  }

  private async handleCrash(error: unknown): Promise<void> {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'interrupted') return;
    try {
      const message = error instanceof Error ? error.message : String(error);
      this.persist({
        type: 'session.error',
        payload: { code: 'driver_crashed', message },
      }, { kind: 'driver_crash', message });
      const next = transition(this.state, { type: 'driver_crashed' });
      this.persist({
        type: 'session.status',
        payload: { from: this.state, to: next, reason: 'driver_crashed' },
      }, { kind: 'runtime_transition', trigger: 'driver_crashed', message }, next);
    } catch {
      // Persistence failure already trips the global audit barrier.
    }
  }

  private persist(
    draft: Omit<SessionEventDraft, 'id' | 'occurredAt'>,
    raw: unknown,
    next?: LifecycleState,
    claudeResumeId?: string,
    stableId?: string,
  ): SessionEvent {
    const id = stableId ?? randomUUID();
    try {
      const event = this.dependencies.events.append(
        this.dependencies.session.id,
        { id: `event-${id}`, occurredAt: now(), ...draft },
        this.diagnostic(`diagnostic-${id}`, raw),
        { lifecycleState: next, claudeResumeId },
      );
      if (next) this.state = next;
      this.dependencies.publisher.publish(event);
      return event;
    } catch (error) {
      this.dependencies.onAuditFailure(error);
      throw error;
    }
  }

  private insertDiagnostic(id: string, raw: unknown): void {
    try {
      this.dependencies.diagnostics.insert(this.diagnostic(id, raw));
    } catch (error) {
      this.dependencies.onAuditFailure(error);
      throw error;
    }
  }

  private diagnostic(id: string, payload: unknown): RawDiagnostic {
    return rawDiagnosticSchema.parse({
      id,
      sessionId: this.dependencies.session.id,
      capturedAt: now(),
      payload: JSON.parse(stablePayload(payload)) as unknown,
    });
  }
}
