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

export class ExecutionRuntime {
  private readonly active = new Map<string, ActiveSession>();

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
    const acceptance = inImmediateTransaction(
      this.dependencies.database,
      () => {
        const stored = this.dependencies.commands.find(
          envelope.idempotencyKey,
          requestHash,
        );
        if (stored) return stored.result;
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
      },
    );
    if (domainEvent) this.dependencies.publisher.domain(domainEvent);
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
      const failedAt = this.dependencies.now();
      try {
        const failedEvent = inImmediateTransaction(
          this.dependencies.database,
          () => {
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
          },
        );
        this.dependencies.publisher.domain(failedEvent);
      } catch (auditError) {
        this.dependencies.barrier.trip(auditError, failedAt);
      }
      return acceptance;
    }

    const runningAt = this.dependencies.now();
    try {
      const runningEvent = inImmediateTransaction(
        this.dependencies.database,
        () => {
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
        },
      );
      this.dependencies.publisher.domain(runningEvent);
    } catch (error) {
      await this.contain(executionId, session, error);
      return acceptance;
    }
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
    const acceptance = inImmediateTransaction(
      this.dependencies.database,
      () => {
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
      },
    );
    if (!acceptance.ok || operationId === undefined || nativeHandle === null)
      return acceptance;
    const acceptedOperationId = operationId;
    if (domainEvent) this.dependencies.publisher.domain(domainEvent);

    let proof: unknown;
    let proven = false;
    try {
      const interrupted =
        await this.dependencies.adapter.interrupt(nativeHandle);
      proof = interrupted;
      if (interrupted.status === 'succeeded') proven = true;
      else if (interrupted.status === 'already_terminal') {
        const probe = await this.dependencies.adapter.probe(nativeHandle);
        proof = { interrupted, probe };
        proven = probe.status === 'terminal' && probe.outcome === 'interrupted';
      }
    } catch (error) {
      proof = { error: error instanceof Error ? error.message : String(error) };
    }
    const completedAt = this.dependencies.now();
    let proofEvent: DomainEvent;
    try {
      proofEvent = inImmediateTransaction(this.dependencies.database, () => {
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
        await this.contain(envelope.command.executionId, owned.session, error);
      } else {
        this.dependencies.barrier.trip(error, completedAt);
      }
      return acceptance;
    }
    this.dependencies.publisher.domain(proofEvent);
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
      for await (const candidate of session.events(
        starting.lastAdapterCursor,
      )) {
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
        let runtimeEvent: RuntimeEvent;
        let domainEvent: DomainEvent | undefined;
        try {
          ({ runtimeEvent, domainEvent } = inImmediateTransaction(
            this.dependencies.database,
            () => {
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
          await this.contain(executionId, session, error);
          return;
        }
        this.dependencies.publisher.runtime(runtimeEvent);
        if (domainEvent) {
          this.dependencies.publisher.domain(domainEvent);
          await session.close();
          return;
        }
      }
      await session.close();
    } catch (error) {
      await this.persistAdapterFailure(executionId, undefined, error, session);
    }
  }

  private async persistAdapterFailure(
    executionId: string,
    candidate: HarnessEventEnvelope | undefined,
    error: unknown,
    session: HarnessSession,
  ): Promise<void> {
    try {
      const occurredAt = this.dependencies.now();
      let runtimeEvent: RuntimeEvent | undefined;
      const domainEvent = inImmediateTransaction(
        this.dependencies.database,
        () => {
          const current = requireExecution(
            this.dependencies.executions,
            executionId,
          );
          if (
            candidate &&
            candidate.adapterCursor === current.lastAdapterCursor + 1
          ) {
            runtimeEvent =
              this.dependencies.events.appendRuntimeWithDiagnosticInTransaction(
                current.projectId,
                {
                  projectId: current.projectId,
                  executionId: current.id,
                  adapterId: current.adapterId,
                  adapterCursor: candidate.adapterCursor,
                  receivedAt: occurredAt,
                  payload: candidate.raw,
                },
                {
                  projectId: current.projectId,
                  executionId: current.id,
                  adapterCursor: candidate.adapterCursor,
                  occurredAt,
                  type: 'worker_execution.adapter_failed',
                  payload: {
                    code: 'invalid_adapter_event',
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                },
              );
          }
          const afterCursor = requireExecution(
            this.dependencies.executions,
            executionId,
          );
          const failed = this.dependencies.executions.transitionInTransaction(
            executionId,
            afterCursor.revision,
            'failed',
            occurredAt,
            {
              failure: {
                code: 'internal_error',
                message: error instanceof Error ? error.message : String(error),
              },
            },
          );
          return this.dependencies.events.appendDomainInTransaction(
            current.projectId,
            lifecycleDraft(failed, occurredAt),
          );
        },
      );
      if (runtimeEvent) this.dependencies.publisher.runtime(runtimeEvent);
      this.dependencies.publisher.domain(domainEvent);
      await session.close();
    } catch (auditError) {
      await this.contain(executionId, session, auditError);
    }
  }

  private async contain(
    executionId: string,
    session: HarnessSession,
    error: unknown,
  ): Promise<void> {
    this.dependencies.barrier.trip(error, this.dependencies.now());
    const execution = this.dependencies.executions.get(executionId);
    try {
      if (execution?.nativeHandle) {
        await this.dependencies.adapter.interrupt(session.nativeHandle);
      }
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
