import { randomUUID } from 'node:crypto';

import {
  harnessCapabilitiesSchema,
  harnessEventEnvelopeSchema,
  type DomainEvent,
  type HarnessAdapter,
  type HarnessEventEnvelope,
  type HarnessSession,
  type InterruptExecutionEnvelope,
  type Project,
  type ResolvedWorkerProfileSnapshot,
  type RuntimeEvent,
  type StartExecutionEnvelope,
  type V2CommandResult,
  type WorkerExecution,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import {
  hashV2Command,
  type V2CommandRepository,
} from '../storage/command-repository.js';
import type { V2EventStore } from '../storage/event-store.js';
import { AuditBarrier } from './audit-barrier.js';
import { ExecutionRepository } from './execution-repository.js';
import { resolveSkillSnapshots } from './harness-adapter.js';
import { OperationRepository } from './operation-repository.js';

export type ExecutionProjectReader = {
  get(projectId: string): Project | undefined;
};
export type ExecutionProfileReader = {
  resolveApproved(
    profileId: string,
    revision: number,
  ): ResolvedWorkerProfileSnapshot;
};
export type ExecutionPublisher = {
  domain(event: DomainEvent): void;
  runtime(event: RuntimeEvent): void;
};

type Dependencies = {
  database: V2Database;
  commands: V2CommandRepository;
  events: V2EventStore;
  projects: ExecutionProjectReader;
  profiles: ExecutionProfileReader;
  executions: ExecutionRepository;
  operations: OperationRepository;
  adapter: HarnessAdapter;
  publisher: ExecutionPublisher;
  barrier: AuditBarrier;
  now: () => string;
};

type ActiveSession = { session: HarnessSession; task: Promise<void> };

const lifecycleDraft = (execution: WorkerExecution, occurredAt: string) => ({
  projectId: execution.projectId,
  occurredAt,
  type: 'worker_execution.lifecycle_changed' as const,
  payload: { execution },
});

const requireExecution = (
  executions: ExecutionRepository,
  executionId: string,
): WorkerExecution => {
  const execution = executions.get(executionId);
  if (!execution) throw new Error(`Execution ${executionId} was not found`);
  return execution;
};

const trustedNextAdapterCursor = (
  candidate: unknown,
  expected: number,
): number | null => {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const adapterCursor = (candidate as { adapterCursor?: unknown })
    .adapterCursor;
  return Number.isSafeInteger(adapterCursor) && adapterCursor === expected
    ? (adapterCursor as number)
    : null;
};

export class ExecutionRuntime {
  private readonly active = new Map<string, ActiveSession>();
  private readonly contained = new WeakSet<HarnessSession>();

  constructor(private readonly dependencies: Dependencies) {}

  async start(envelope: StartExecutionEnvelope): Promise<V2CommandResult> {
    this.dependencies.barrier.assertHealthy();
    const requestHash = hashV2Command(envelope.command);
    const replay = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;

    const project = this.dependencies.projects.get(envelope.command.projectId);
    if (!project) {
      return {
        ok: false,
        commandType: 'worker_execution.start',
        error: { code: 'project_not_found', message: 'Project was not found' },
      };
    }
    let profile: ResolvedWorkerProfileSnapshot;
    try {
      profile = this.dependencies.profiles.resolveApproved(
        envelope.command.profileId,
        envelope.command.profileRevision,
      );
    } catch (error) {
      return {
        ok: false,
        commandType: 'worker_execution.start',
        error: {
          code: 'profile_not_found',
          message:
            error instanceof Error ? error.message : 'Profile was not found',
        },
      };
    }
    let capabilities;
    try {
      capabilities = harnessCapabilitiesSchema.parse(
        await this.dependencies.adapter.capabilities(),
      );
    } catch (error) {
      return {
        ok: false,
        commandType: 'worker_execution.start',
        error: {
          code: 'adapter_unavailable',
          message:
            error instanceof Error ? error.message : 'Adapter is unavailable',
        },
      };
    }
    const missingCapabilities =
      profile.document.spec.requiredCapabilities.filter(
        (capability) => !capabilities.capabilities.includes(capability),
      );
    const preferred = profile.document.spec.skills.preferred;
    const required = profile.document.spec.skills.required;
    const skillDescriptors =
      missingCapabilities.length === 0
        ? await this.dependencies.adapter.resolveSkills([
            ...preferred,
            ...required,
          ])
        : [];
    const resolvedSkills =
      missingCapabilities.length === 0
        ? resolveSkillSnapshots(
            { ...capabilities, skills: skillDescriptors },
            preferred,
            required,
          )
        : [];
    const missingSkills = resolvedSkills
      .filter(
        (skill) =>
          skill.mode === 'required' && skill.resolution.kind === 'unavailable',
      )
      .map((skill) => skill.requested.id);
    const occurredAt = this.dependencies.now();
    const executionId = randomUUID();
    const initial: WorkerExecution = {
      id: executionId,
      projectId: project.id,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      assignment: envelope.command.assignment,
      profileSnapshot: profile,
      skillRequests: { preferred, required },
      resolvedSkills,
      capabilitySnapshot: capabilities,
      adapterId: capabilities.adapterId,
      model: profile.document.spec.preferredRuntime.model,
      nativeHandle: null,
      lifecycle:
        missingCapabilities.length > 0 || missingSkills.length > 0
          ? 'failed'
          : 'starting',
      revision:
        missingCapabilities.length > 0 || missingSkills.length > 0 ? 1 : 0,
      lastAdapterCursor: 0,
      lastRuntimeSequence: 0,
      replacementForExecutionId: null,
      failure:
        missingCapabilities.length > 0
          ? {
              code: 'required_capability_unavailable',
              message: 'Required adapter capabilities are unavailable',
              missing: missingCapabilities,
            }
          : missingSkills.length > 0
            ? {
                code: 'required_skill_unavailable',
                message: 'Required skills are unavailable',
                missing: missingSkills,
              }
            : null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      endedAt:
        missingCapabilities.length > 0 || missingSkills.length > 0
          ? occurredAt
          : null,
    };

    let operationId: string | undefined;
    let domainEvent: DomainEvent | undefined;
    let reservationWritesStarted = false;
    let acceptance: V2CommandResult;
    try {
      acceptance = inImmediateTransaction(this.dependencies.database, () => {
        const stored = this.dependencies.commands.find(
          envelope.idempotencyKey,
          requestHash,
        );
        if (stored) return stored.result;
        this.dependencies.barrier.assertHealthy();
        reservationWritesStarted = true;
        const execution =
          this.dependencies.executions.insertInTransaction(initial);
        domainEvent = this.dependencies.events.appendDomainInTransaction(
          execution.projectId,
          lifecycleDraft(execution, occurredAt),
        );
        let result: V2CommandResult;
        if (execution.lifecycle === 'failed') {
          if (!execution.failure) {
            throw new Error(
              'Failed execution requires structured failure evidence',
            );
          }
          result = {
            ok: false,
            commandType: 'worker_execution.start',
            error: {
              code: execution.failure.code,
              message: execution.failure.message,
            },
          };
        } else {
          result = {
            ok: true,
            commandType: 'worker_execution.start',
            execution,
          };
        }
        if (execution.lifecycle === 'starting') {
          operationId = this.dependencies.operations.createPendingInTransaction(
            {
              executionId: execution.id,
              kind: 'start',
              request: {
                version: 'mesh.v2.execution-start/v1',
                idempotencyKey: envelope.idempotencyKey,
                requestHash,
                request: envelope.command,
              },
              createdAt: occurredAt,
            },
          ).id;
        }
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: envelope.idempotencyKey,
          commandType: envelope.command.type,
          requestHash,
          result,
          createdAt: occurredAt,
        });
        return result;
      });
    } catch (error) {
      if (reservationWritesStarted) {
        this.dependencies.barrier.trip(error, occurredAt);
      }
      throw error;
    }
    if (domainEvent) this.publishDomain(domainEvent);
    if (!acceptance.ok || operationId === undefined) return acceptance;
    const acceptedOperationId = operationId;

    let session: HarnessSession;
    try {
      session = await this.dependencies.adapter.start({
        executionId,
        project,
        assignment: envelope.command.assignment,
        profile,
        resolvedSkills,
      });
    } catch (error) {
      if (await this.stopIfBarrierTripped()) return acceptance;
      const failedAt = this.dependencies.now();
      let failedEvent: DomainEvent;
      try {
        failedEvent = inImmediateTransaction(this.dependencies.database, () => {
          this.dependencies.barrier.assertHealthy();
          const current = requireExecution(
            this.dependencies.executions,
            executionId,
          );
          const failed = this.dependencies.executions.transitionInTransaction(
            executionId,
            current.revision,
            'failed',
            failedAt,
            {
              failure: {
                code: 'adapter_unavailable',
                message:
                  error instanceof Error
                    ? error.message
                    : 'Adapter start failed',
              },
            },
          );
          this.dependencies.operations.finishInTransaction(
            acceptedOperationId,
            'failed',
            {
              reason: failed.failure?.message,
            },
            failedAt,
          );
          return this.dependencies.events.appendDomainInTransaction(
            failed.projectId,
            lifecycleDraft(failed, failedAt),
          );
        });
      } catch (auditError) {
        if (this.dependencies.barrier.status === 'healthy') {
          this.dependencies.barrier.trip(auditError, failedAt);
        }
        return acceptance;
      }
      this.publishDomain(failedEvent);
      return acceptance;
    }
    if (await this.stopIfBarrierTripped(session)) return acceptance;

    const runningAt = this.dependencies.now();
    let runningEvent: DomainEvent;
    try {
      runningEvent = inImmediateTransaction(this.dependencies.database, () => {
        this.dependencies.barrier.assertHealthy();
        const current = requireExecution(
          this.dependencies.executions,
          executionId,
        );
        const running = this.dependencies.executions.transitionInTransaction(
          executionId,
          current.revision,
          'running',
          runningAt,
          { nativeHandle: session.nativeHandle },
        );
        this.dependencies.operations.finishInTransaction(
          acceptedOperationId,
          'succeeded',
          {
            nativeHandle: session.nativeHandle,
          },
          runningAt,
        );
        return this.dependencies.events.appendDomainInTransaction(
          running.projectId,
          lifecycleDraft(running, runningAt),
        );
      });
    } catch (error) {
      if (this.dependencies.barrier.status === 'tripped') {
        await this.containAfterBarrier(session);
      } else {
        await this.contain(session, error);
      }
      return acceptance;
    }
    this.publishDomain(runningEvent);
    this.attach(executionId, session);
    return acceptance;
  }

  async interrupt(
    envelope: InterruptExecutionEnvelope,
  ): Promise<V2CommandResult> {
    this.dependencies.barrier.assertHealthy();
    const requestHash = hashV2Command(envelope.command);
    const replay = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;
    await Promise.resolve();
    const occurredAt = this.dependencies.now();
    let operationId: string | undefined;
    let nativeHandle: string | null = null;
    let domainEvent: DomainEvent | undefined;
    let reservationWritesStarted = false;
    let acceptance: V2CommandResult;
    try {
      acceptance = inImmediateTransaction(this.dependencies.database, () => {
        const stored = this.dependencies.commands.find(
          envelope.idempotencyKey,
          requestHash,
        );
        if (stored) return stored.result;
        const current = this.dependencies.executions.get(
          envelope.command.executionId,
        );
        if (!current) {
          return {
            ok: false,
            commandType: 'worker_execution.interrupt',
            error: {
              code: 'execution_not_found',
              message: 'Execution was not found',
            },
          } satisfies V2CommandResult;
        }
        if (
          current.projectId !== envelope.command.projectId ||
          current.revision !== envelope.command.expectedRevision ||
          current.lifecycle !== 'running'
        ) {
          return {
            ok: false,
            commandType: 'worker_execution.interrupt',
            error: {
              code: 'execution_lifecycle_conflict',
              message: 'Execution cannot be interrupted',
            },
          } satisfies V2CommandResult;
        }
        this.dependencies.barrier.assertHealthy();
        reservationWritesStarted = true;
        nativeHandle = current.nativeHandle;
        const interrupting =
          this.dependencies.executions.transitionInTransaction(
            current.id,
            current.revision,
            'interrupting',
            occurredAt,
          );
        operationId = this.dependencies.operations.createPendingInTransaction({
          executionId: current.id,
          kind: 'interrupt',
          request: {
            version: 'mesh.v2.execution-interrupt/v1',
            idempotencyKey: envelope.idempotencyKey,
            requestHash,
            request: envelope.command,
          },
          createdAt: occurredAt,
        }).id;
        domainEvent = this.dependencies.events.appendDomainInTransaction(
          current.projectId,
          lifecycleDraft(interrupting, occurredAt),
        );
        const result: V2CommandResult = {
          ok: true,
          commandType: 'worker_execution.interrupt',
          execution: interrupting,
        };
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: envelope.idempotencyKey,
          commandType: envelope.command.type,
          requestHash,
          result,
          createdAt: occurredAt,
        });
        return result;
      });
    } catch (error) {
      if (reservationWritesStarted) {
        this.dependencies.barrier.trip(error, occurredAt);
      }
      throw error;
    }
    if (!acceptance.ok || operationId === undefined || nativeHandle === null)
      return acceptance;
    const acceptedOperationId = operationId;
    if (domainEvent) this.publishDomain(domainEvent);

    let proof: unknown;
    let proven = false;
    try {
      const interrupted =
        await this.dependencies.adapter.interrupt(nativeHandle);
      if (await this.stopIfBarrierTripped()) return acceptance;
      proof = interrupted;
      if (interrupted.status === 'succeeded') proven = true;
      else if (interrupted.status === 'already_terminal') {
        const probe = await this.dependencies.adapter.probe(nativeHandle);
        if (await this.stopIfBarrierTripped()) return acceptance;
        proof = { interrupted, probe };
        proven = probe.status === 'terminal' && probe.outcome === 'interrupted';
      }
    } catch (error) {
      if (await this.stopIfBarrierTripped()) return acceptance;
      proof = { error: error instanceof Error ? error.message : String(error) };
    }
    const completedAt = this.dependencies.now();
    let proofEvent: DomainEvent;
    try {
      proofEvent = inImmediateTransaction(this.dependencies.database, () => {
        this.dependencies.barrier.assertHealthy();
        const current = requireExecution(
          this.dependencies.executions,
          envelope.command.executionId,
        );
        const finished = this.dependencies.executions.transitionInTransaction(
          current.id,
          current.revision,
          proven ? 'interrupted' : 'attention_required',
          completedAt,
        );
        this.dependencies.operations.finishInTransaction(
          acceptedOperationId,
          proven ? 'succeeded' : 'unknown',
          proof,
          completedAt,
        );
        return this.dependencies.events.appendDomainInTransaction(
          current.projectId,
          lifecycleDraft(finished, completedAt),
        );
      });
    } catch (error) {
      const owned = this.active.get(envelope.command.executionId);
      if (owned) {
        if (this.dependencies.barrier.status === 'tripped') {
          await this.containAfterBarrier(owned.session);
        } else {
          await this.contain(owned.session, error);
        }
      } else if (this.dependencies.barrier.status === 'healthy') {
        this.dependencies.barrier.trip(error, completedAt);
      }
      return acceptance;
    }
    this.publishDomain(proofEvent);
    return acceptance;
  }

  attach(executionId: string, session: HarnessSession): void {
    if (this.active.has(executionId))
      throw new Error('Execution already has an active session');
    const task = this.consume(executionId, session).finally(() => {
      this.active.delete(executionId);
    });
    this.active.set(executionId, { session, task });
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map(({ task }) => task));
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.active.entries()];
    await Promise.all(
      sessions.map(async ([executionId, { session }]) => {
        const execution = this.dependencies.executions.get(executionId);
        if (execution?.nativeHandle) {
          try {
            await this.dependencies.adapter.interrupt(execution.nativeHandle);
          } catch (error) {
            this.dependencies.barrier.record(
              'Adapter interrupt failed during close',
              error,
            );
          }
        }
        await session.close();
      }),
    );
    await this.drain();
  }

  private async consume(
    executionId: string,
    session: HarnessSession,
  ): Promise<void> {
    const starting = this.dependencies.executions.get(executionId);
    if (!starting) throw new Error('Execution was not found for attach');
    try {
      const input: AsyncIterable<unknown> = session.events(
        starting.lastAdapterCursor,
      );
      const iterator = input[Symbol.asyncIterator]();
      while (true) {
        let next: IteratorResult<unknown>;
        try {
          next = await iterator.next();
        } catch (error) {
          if (await this.stopIfBarrierTripped(session)) return;
          await this.persistAdapterFailure(
            executionId,
            undefined,
            error,
            session,
          );
          return;
        }
        if (await this.stopIfBarrierTripped(session)) return;
        if (next.done) {
          await this.closeAfterSuccess(
            session,
            'Session close failed after stream exhaustion',
          );
          return;
        }
        const candidate = next.value;
        let envelope: HarnessEventEnvelope;
        try {
          envelope = harnessEventEnvelopeSchema.parse(candidate);
        } catch (error) {
          await this.persistAdapterFailure(
            executionId,
            candidate,
            error,
            session,
          );
          return;
        }
        const current = requireExecution(
          this.dependencies.executions,
          executionId,
        );
        if (envelope.adapterCursor !== current.lastAdapterCursor + 1) {
          await this.persistAdapterFailure(
            executionId,
            candidate,
            new Error('Adapter cursor must be the next durable cursor'),
            session,
          );
          return;
        }
        let runtimeEvent: RuntimeEvent;
        let domainEvent: DomainEvent | undefined;
        try {
          ({ runtimeEvent, domainEvent } = inImmediateTransaction(
            this.dependencies.database,
            () => {
              this.dependencies.barrier.assertHealthy();
              const current = requireExecution(
                this.dependencies.executions,
                executionId,
              );
              const persisted =
                this.dependencies.events.appendRuntimeWithDiagnosticInTransaction(
                  current.projectId,
                  {
                    projectId: current.projectId,
                    executionId: current.id,
                    adapterId: current.adapterId,
                    adapterCursor: envelope.adapterCursor,
                    receivedAt: this.dependencies.now(),
                    payload: envelope.raw,
                  },
                  envelope.normalized,
                );
              const afterCursor = requireExecution(
                this.dependencies.executions,
                executionId,
              );
              this.dependencies.executions.updateInTransaction(
                { ...afterCursor, nativeHandle: session.nativeHandle },
                afterCursor.revision,
              );
              if (envelope.normalized.type !== 'worker_execution.completed') {
                return { runtimeEvent: persisted, domainEvent: undefined };
              }
              const completed =
                this.dependencies.executions.transitionInTransaction(
                  current.id,
                  current.revision,
                  'completed',
                  envelope.normalized.occurredAt,
                );
              return {
                runtimeEvent: persisted,
                domainEvent: this.dependencies.events.appendDomainInTransaction(
                  current.projectId,
                  lifecycleDraft(completed, envelope.normalized.occurredAt),
                ),
              };
            },
          ));
        } catch (error) {
          await this.contain(session, error);
          return;
        }
        this.publishRuntime(runtimeEvent);
        if (domainEvent) {
          this.publishDomain(domainEvent);
          await this.closeAfterSuccess(
            session,
            'Session close failed after successful completion',
          );
          return;
        }
      }
    } catch (error) {
      if (await this.stopIfBarrierTripped(session)) return;
      await this.persistAdapterFailure(executionId, undefined, error, session);
    }
  }

  private async persistAdapterFailure(
    executionId: string,
    candidate: unknown,
    error: unknown,
    session: HarnessSession,
  ): Promise<void> {
    const occurredAt = this.dependencies.now();
    const message = error instanceof Error ? error.message : String(error);
    let domainEvent: DomainEvent;
    try {
      domainEvent = inImmediateTransaction(this.dependencies.database, () => {
        this.dependencies.barrier.assertHealthy();
        const current = requireExecution(
          this.dependencies.executions,
          executionId,
        );
        this.dependencies.events.appendRawDiagnosticInTransaction({
          projectId: current.projectId,
          executionId: current.id,
          adapterId: current.adapterId,
          adapterCursor: trustedNextAdapterCursor(
            candidate,
            current.lastAdapterCursor + 1,
          ),
          receivedAt: occurredAt,
          payload: {
            kind: 'mesh.v2.invalid-harness-input/v1',
            input: candidate ?? null,
            error: message,
          },
        });
        for (const operation of this.dependencies.operations
          .listPending()
          .filter((pending) => pending.executionId === executionId)) {
          this.dependencies.operations.finishInTransaction(
            operation.id,
            'unknown',
            { reason: message },
            occurredAt,
          );
        }
        const failed = this.dependencies.executions.transitionInTransaction(
          executionId,
          current.revision,
          'failed',
          occurredAt,
          {
            failure: {
              code: 'internal_error',
              message,
            },
          },
        );
        return this.dependencies.events.appendDomainInTransaction(
          current.projectId,
          lifecycleDraft(failed, occurredAt),
        );
      });
    } catch (auditError) {
      await this.contain(session, auditError);
      return;
    }
    this.publishDomain(domainEvent);
    await this.closeAfterSuccess(
      session,
      'Session close failed after adapter failure',
    );
  }

  private publishDomain(event: DomainEvent): void {
    try {
      this.dependencies.publisher.domain(event);
    } catch (error) {
      this.dependencies.barrier.record('Domain publication failed', error);
    }
  }

  private publishRuntime(event: RuntimeEvent): void {
    try {
      this.dependencies.publisher.runtime(event);
    } catch (error) {
      this.dependencies.barrier.record('Runtime publication failed', error);
    }
  }

  private async closeAfterSuccess(
    session: HarnessSession,
    message: string,
  ): Promise<void> {
    try {
      await session.close();
    } catch (error) {
      this.dependencies.barrier.record(message, error);
    }
  }

  private async contain(
    session: HarnessSession,
    error: unknown,
  ): Promise<void> {
    if (this.dependencies.barrier.status === 'healthy') {
      this.dependencies.barrier.trip(error, this.dependencies.now());
    }
    await this.containAfterBarrier(session);
  }

  private async stopIfBarrierTripped(
    session?: HarnessSession,
  ): Promise<boolean> {
    try {
      this.dependencies.barrier.assertHealthy();
      return false;
    } catch {
      if (session) await this.containAfterBarrier(session);
      return true;
    }
  }

  private async containAfterBarrier(session: HarnessSession): Promise<void> {
    if (this.contained.has(session)) return;
    this.contained.add(session);
    try {
      await this.dependencies.adapter.interrupt(session.nativeHandle);
    } catch (interruptError) {
      this.dependencies.barrier.record(
        'Adapter interrupt failed during containment',
        interruptError,
      );
    } finally {
      try {
        await session.close();
      } catch (closeError) {
        this.dependencies.barrier.record(
          'Session close failed during containment',
          closeError,
        );
      }
    }
  }
}
