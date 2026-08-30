import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  harnessCapabilitiesSchema,
  harnessEventEnvelopeSchema,
  resolvedWorkerProfileSnapshotSchema,
  startExecutionCommandSchema,
  type DomainEvent,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEventEnvelope,
  type HarnessSkillDescriptor,
  type HarnessSession,
  type InterruptExecutionEnvelope,
  type Project,
  type ResolvedWorkerProfileSnapshot,
  type RuntimeEvent,
  type StartExecutionEnvelope,
  type V2CommandResult,
  type WorkerExecution,
  type WorkerExecutionId,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import {
  hashV2Command,
  type StoredCommandResult,
  type V2CommandRepository,
} from '../storage/command-repository.js';
import type { V2EventStore } from '../storage/event-store.js';
import { AuditBarrier } from './audit-barrier.js';
import { ExecutionRepository } from './execution-repository.js';
import {
  PLANNING_INTERRUPT_OPERATION_VERSION,
  resolveSkillSnapshots,
} from './harness-adapter.js';
import {
  OperationRepository,
  type ExecutionOperation,
} from './operation-repository.js';

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

type ActiveSession = {
  session: HarnessSession;
  task: Promise<void>;
  fenced: boolean;
};

export type ReservedExecutionStart = {
  execution: WorkerExecution;
  result: V2CommandResult;
  activationRequired: boolean;
};

export class ExecutionReservationError extends Error {
  constructor(readonly result: V2CommandResult) {
    super(result.ok ? 'Execution reservation failed' : result.error.message);
    this.name = 'ExecutionReservationError';
  }
}

export type PlanningInterruptCleanupCode =
  | 'planning_interrupt_not_running'
  | 'planning_interrupt_unproven'
  | 'planning_interrupt_audit_failure'
  | 'planning_interrupt_quiescence_failure';

export type PlanningInterruptCleanupDiagnostic = {
  phase:
    | 'adapter_interrupt'
    | 'adapter_probe'
    | 'session_close'
    | 'consumer_join'
    | 'consumer_removal'
    | 'audit';
  message: string;
};

const isPlanningInterruptCleanupDiagnostic = (
  value: unknown,
): value is PlanningInterruptCleanupDiagnostic =>
  typeof value === 'object' &&
  value !== null &&
  'phase' in value &&
  [
    'adapter_interrupt',
    'adapter_probe',
    'session_close',
    'consumer_join',
    'consumer_removal',
    'audit',
  ].includes(String(value.phase)) &&
  'message' in value &&
  typeof value.message === 'string';

export class PlanningInterruptCleanupError extends Error {
  constructor(
    readonly code: PlanningInterruptCleanupCode,
    message: string,
    readonly diagnostics: readonly PlanningInterruptCleanupDiagnostic[] = [],
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PlanningInterruptCleanupError';
  }
}

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

const databaseActivations = new WeakMap<
  V2Database,
  Map<string, Promise<void>>
>();

export class ExecutionRuntime {
  private readonly active = new Map<string, ActiveSession>();
  private readonly contained = new WeakSet<HarnessSession>();
  private readonly activations: Map<string, Promise<void>>;
  private readonly planningInterrupts = new Map<string, Promise<void>>();
  private readonly consumerContext = new AsyncLocalStorage<string>();

  constructor(private readonly dependencies: Dependencies) {
    let activations = databaseActivations.get(dependencies.database);
    if (!activations) {
      activations = new Map();
      databaseActivations.set(dependencies.database, activations);
    }
    this.activations = activations;
  }

  private reservedStartFromStored(
    stored: StoredCommandResult,
    envelope: StartExecutionEnvelope,
    requestHash: string,
    knownOperation?: ExecutionOperation,
  ): ReservedExecutionStart {
    const operation =
      knownOperation ??
      this.dependencies.operations.findStartReservation(
        envelope.idempotencyKey,
        requestHash,
      );
    if (!operation) throw new Error('Reserved start operation was not found');
    const exactOperation = this.exactStartOperation(
      operation.executionId,
      {
        idempotencyKey: envelope.idempotencyKey,
        requestHash,
        request: envelope.command,
      },
      operation,
      stored,
    );
    if (exactOperation.id !== operation.id) {
      throw new Error('Reserved start operation is not durably linked');
    }
    const execution = requireExecution(
      this.dependencies.executions,
      operation.executionId,
    );
    const activationRequired =
      execution.lifecycle === 'starting' && operation.state === 'pending';
    return { execution, result: stored.result, activationRequired };
  }

  private exactStartOperation(
    executionId: string,
    expected?: {
      idempotencyKey: string;
      requestHash: string;
      request: StartExecutionEnvelope['command'];
    },
    knownReverseLink?: ExecutionOperation,
    knownStored?: StoredCommandResult,
  ): ExecutionOperation {
    const operations = this.dependencies.operations
      .listForExecution(executionId)
      .filter((operation) => operation.kind === 'start');
    if (operations.length !== 1) {
      throw new Error('Exact reserved start operation was not found');
    }
    const operation = operations[0];
    if (!operation) throw new Error('Reserved start operation was not found');
    const request = operation.request;
    const requestKeys =
      typeof request === 'object' && request !== null && !Array.isArray(request)
        ? Object.keys(request).sort().join(',')
        : '';
    if (
      typeof request !== 'object' ||
      request === null ||
      Array.isArray(request) ||
      requestKeys !== 'idempotencyKey,request,requestHash,version' ||
      !('version' in request) ||
      request.version !== 'mesh.v2.execution-start/v1' ||
      !('idempotencyKey' in request) ||
      typeof request.idempotencyKey !== 'string' ||
      !('requestHash' in request) ||
      typeof request.requestHash !== 'string' ||
      !('request' in request) ||
      !startExecutionCommandSchema.safeParse(request.request).success ||
      (expected !== undefined &&
        (request.idempotencyKey !== expected.idempotencyKey ||
          request.requestHash !== expected.requestHash ||
          hashV2Command(expected.request) !== expected.requestHash))
    ) {
      throw new Error('Reserved start operation link is invalid');
    }
    const linked =
      knownReverseLink ??
      this.dependencies.operations.findStartReservation(
        request.idempotencyKey,
        request.requestHash,
      );
    const stored =
      knownStored ??
      this.dependencies.commands.find(
        request.idempotencyKey,
        request.requestHash,
      );
    if (
      !linked ||
      linked.id !== operation.id ||
      linked.executionId !== executionId ||
      !stored ||
      stored.commandType !== 'worker_execution.start' ||
      hashV2Command(request.request as StartExecutionEnvelope['command']) !==
        request.requestHash ||
      (stored.result.ok &&
        (!('execution' in stored.result) ||
          stored.result.execution.id !== executionId))
    ) {
      throw new Error('Reserved start operation is not durably linked');
    }
    const execution = requireExecution(
      this.dependencies.executions,
      executionId,
    );
    const coherent =
      operation.state === 'pending'
        ? execution.lifecycle === 'starting'
        : operation.state === 'failed'
          ? execution.lifecycle === 'failed'
          : operation.state === 'unknown'
            ? execution.lifecycle === 'attention_required'
            : [
                'running',
                'interrupting',
                'completed',
                'failed',
                'interrupted',
                'attention_required',
              ].includes(execution.lifecycle);
    if (
      !coherent ||
      (!stored.result.ok &&
        (operation.state !== 'failed' ||
          execution.lifecycle !== 'failed' ||
          execution.failure === null ||
          stored.result.error.code !== execution.failure.code ||
          stored.result.error.message !== execution.failure.message))
    ) {
      throw new Error('Reserved start operation state is inconsistent');
    }
    return operation;
  }

  findReservedStart(
    envelope: StartExecutionEnvelope,
  ): ReservedExecutionStart | undefined {
    this.dependencies.barrier.assertHealthy();
    const requestHash = hashV2Command(envelope.command);
    const stored = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (!stored) return undefined;
    try {
      return this.reservedStartFromStored(stored, envelope, requestHash);
    } catch (error) {
      this.dependencies.barrier.trip(error, this.dependencies.now());
      throw error;
    }
  }

  async reserveStart(
    envelope: StartExecutionEnvelope,
  ): Promise<ReservedExecutionStart> {
    return this.reserveStartAfterLookup(envelope, false);
  }

  private async reserveStartAfterLookup(
    envelope: StartExecutionEnvelope,
    commandLookupAlreadyMissed: boolean,
  ): Promise<ReservedExecutionStart> {
    if (!commandLookupAlreadyMissed) {
      const replay = this.findReservedStart(envelope);
      if (replay) return replay;
    }

    const project = this.dependencies.projects.get(envelope.command.projectId);
    if (
      !project ||
      project.id !== envelope.command.projectId ||
      project.id !== envelope.command.assignment.projectId
    ) {
      throw new ExecutionReservationError({
        ok: false,
        commandType: 'worker_execution.start',
        error: { code: 'project_not_found', message: 'Project was not found' },
      });
    }
    let profile: ResolvedWorkerProfileSnapshot;
    try {
      profile = resolvedWorkerProfileSnapshotSchema.parse(
        this.dependencies.profiles.resolveApproved(
          envelope.command.profileId,
          envelope.command.profileRevision,
        ),
      );
      if (
        profile.profileId !== envelope.command.profileId ||
        profile.profileRevision !== envelope.command.profileRevision ||
        (profile.projectId !== null && profile.projectId !== project.id) ||
        profile.document.spec.assignmentKinds[0] !==
          envelope.command.assignment.kind
      ) {
        throw new Error('Resolved profile does not match start authority');
      }
    } catch (error) {
      throw new ExecutionReservationError({
        ok: false,
        commandType: 'worker_execution.start',
        error: {
          code: 'profile_not_found',
          message:
            error instanceof Error ? error.message : 'Profile was not found',
        },
      });
    }

    let capabilities: HarnessCapabilities;
    let skillDescriptors: readonly HarnessSkillDescriptor[];
    try {
      capabilities = harnessCapabilitiesSchema.parse(
        await this.dependencies.adapter.capabilities(),
      );
      this.dependencies.barrier.assertHealthy();
      const preferred = profile.document.spec.skills.preferred;
      const required = profile.document.spec.skills.required;
      const missingCapabilities =
        profile.document.spec.requiredCapabilities.filter(
          (capability) => !capabilities.capabilities.includes(capability),
        );
      skillDescriptors =
        missingCapabilities.length === 0
          ? await this.dependencies.adapter.resolveSkills([
              ...preferred,
              ...required,
            ])
          : [];
      this.dependencies.barrier.assertHealthy();
    } catch (error) {
      if (this.dependencies.barrier.status === 'tripped') throw error;
      throw new ExecutionReservationError({
        ok: false,
        commandType: 'worker_execution.start',
        error: {
          code: 'adapter_unavailable',
          message:
            error instanceof Error ? error.message : 'Adapter is unavailable',
        },
      });
    }

    const missingCapabilities =
      profile.document.spec.requiredCapabilities.filter(
        (capability) => !capabilities.capabilities.includes(capability),
      );
    const preferred = profile.document.spec.skills.preferred;
    const required = profile.document.spec.skills.required;
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
    const failed = missingCapabilities.length > 0 || missingSkills.length > 0;
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
      lifecycle: failed ? 'failed' : 'starting',
      revision: failed ? 1 : 0,
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
      endedAt: failed ? occurredAt : null,
    };
    const requestHash = hashV2Command(envelope.command);
    let reservation: ReservedExecutionStart | undefined;
    let domainEvent: DomainEvent | undefined;
    let writesStarted = false;
    let replayObserved = false;
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        const stored = this.dependencies.commands.find(
          envelope.idempotencyKey,
          requestHash,
        );
        if (stored) {
          replayObserved = true;
          reservation = this.reservedStartFromStored(
            stored,
            envelope,
            requestHash,
          );
          return;
        }
        this.dependencies.barrier.assertHealthy();
        writesStarted = true;
        const execution =
          this.dependencies.executions.insertInTransaction(initial);
        domainEvent = this.dependencies.events.appendDomainInTransaction(
          execution.projectId,
          lifecycleDraft(execution, occurredAt),
        );
        const operation =
          this.dependencies.operations.createPendingInTransaction({
            executionId: execution.id,
            kind: 'start',
            request: {
              version: 'mesh.v2.execution-start/v1',
              idempotencyKey: envelope.idempotencyKey,
              requestHash,
              request: envelope.command,
            },
            createdAt: occurredAt,
          });
        let result: V2CommandResult;
        if (execution.lifecycle === 'failed') {
          if (!execution.failure) {
            throw new Error('Failed execution requires failure evidence');
          }
          result = {
            ok: false,
            commandType: 'worker_execution.start',
            error: {
              code: execution.failure.code,
              message: execution.failure.message,
            },
          };
          this.dependencies.operations.finishInTransaction(
            operation.id,
            'failed',
            { reason: execution.failure.message },
            occurredAt,
          );
        } else {
          result = {
            ok: true,
            commandType: 'worker_execution.start',
            execution,
          };
        }
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: envelope.idempotencyKey,
          commandType: envelope.command.type,
          requestHash,
          result,
          createdAt: occurredAt,
        });
        reservation = {
          execution,
          result,
          activationRequired: execution.lifecycle === 'starting',
        };
      });
    } catch (error) {
      if (writesStarted || replayObserved) {
        this.dependencies.barrier.trip(error, occurredAt);
      }
      throw error;
    }
    if (!reservation) throw new Error('Execution reservation was not stored');
    if (domainEvent) this.publishDomain(domainEvent);
    return reservation;
  }

  async activateReserved(executionId: WorkerExecutionId): Promise<void> {
    const active = this.activations.get(executionId);
    if (active) return active;
    const activation = Promise.resolve().then(() => this.activate(executionId));
    this.activations.set(executionId, activation);
    const remove = () => {
      if (this.activations.get(executionId) === activation) {
        this.activations.delete(executionId);
      }
    };
    void activation.then(remove, remove);
    return activation;
  }

  async cancelReserved(
    executionId: WorkerExecutionId,
  ): Promise<WorkerExecution> {
    const activation = this.activations.get(executionId);
    if (activation) await activation;
    this.dependencies.barrier.assertHealthy();
    const occurredAt = this.dependencies.now();
    let domainEvent: DomainEvent | undefined;
    let cancelled: WorkerExecution | undefined;
    let authorityReadStarted = false;
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        authorityReadStarted = true;
        const current = requireExecution(
          this.dependencies.executions,
          executionId,
        );
        const operation = this.exactStartOperation(executionId);
        const coherent =
          operation.state === 'pending'
            ? current.lifecycle === 'starting'
            : operation.state === 'failed'
              ? current.lifecycle === 'failed'
              : operation.state === 'unknown'
                ? current.lifecycle === 'attention_required'
                : [
                    'running',
                    'interrupting',
                    'completed',
                    'failed',
                    'interrupted',
                    'attention_required',
                  ].includes(current.lifecycle);
        if (!coherent) {
          throw new Error('Reserved start operation state is inconsistent');
        }
        if (current.lifecycle !== 'starting' || operation.state !== 'pending') {
          cancelled = current;
          return;
        }
        this.dependencies.barrier.assertHealthy();
        cancelled = this.dependencies.executions.transitionInTransaction(
          current.id,
          current.revision,
          'failed',
          occurredAt,
          {
            failure: {
              code: 'startup_interrupted_before_start',
              message: 'Execution start was cancelled before adapter startup',
            },
          },
        );
        this.dependencies.operations.finishInTransaction(
          operation.id,
          'failed',
          { reason: 'planning_cycle_abandoned' },
          occurredAt,
        );
        domainEvent = this.dependencies.events.appendDomainInTransaction(
          current.projectId,
          lifecycleDraft(cancelled, occurredAt),
        );
      });
    } catch (error) {
      if (
        authorityReadStarted &&
        this.dependencies.barrier.status === 'healthy'
      ) {
        this.dependencies.barrier.trip(error, occurredAt);
      }
      throw error;
    }
    if (!cancelled) throw new Error('Reserved cancellation did not settle');
    if (domainEvent) this.publishDomain(domainEvent);
    return cancelled;
  }

  async start(envelope: StartExecutionEnvelope): Promise<V2CommandResult> {
    this.dependencies.barrier.assertHealthy();
    const requestHash = hashV2Command(envelope.command);
    const stored = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (stored) {
      try {
        const operation = this.dependencies.operations.findStartReservation(
          envelope.idempotencyKey,
          requestHash,
        );
        if (!operation) return stored.result;
        return this.reservedStartFromStored(
          stored,
          envelope,
          requestHash,
          operation,
        ).result;
      } catch (error) {
        this.dependencies.barrier.trip(error, this.dependencies.now());
        throw error;
      }
    }
    try {
      const reservation = await this.reserveStartAfterLookup(envelope, true);
      if (reservation.activationRequired) {
        await this.activateReserved(reservation.execution.id);
      }
      return reservation.result;
    } catch (error) {
      if (error instanceof ExecutionReservationError) return error.result;
      throw error;
    }
  }

  private async activate(executionId: string): Promise<void> {
    this.dependencies.barrier.assertHealthy();
    let operation: ExecutionOperation;
    try {
      operation = this.exactStartOperation(executionId);
    } catch (error) {
      if (this.dependencies.barrier.status === 'healthy') {
        this.dependencies.barrier.trip(error, this.dependencies.now());
      }
      throw error;
    }
    const execution = requireExecution(
      this.dependencies.executions,
      executionId,
    );
    if (execution.lifecycle !== 'starting') return;
    const project = this.dependencies.projects.get(execution.projectId);
    if (!project) throw new Error('Reserved execution project was not found');

    let session: HarnessSession;
    try {
      session = await this.dependencies.adapter.start({
        executionId,
        project,
        assignment: execution.assignment,
        profile: execution.profileSnapshot,
        resolvedSkills: execution.resolvedSkills,
      });
    } catch (error) {
      if (await this.stopIfBarrierTripped()) return;
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
            operation.id,
            'failed',
            { reason: failed.failure?.message },
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
        return;
      }
      this.publishDomain(failedEvent);
      return;
    }
    if (await this.stopIfBarrierTripped(session)) return;

    const runningAt = this.dependencies.now();
    let runningEvent: DomainEvent;
    try {
      runningEvent = inImmediateTransaction(this.dependencies.database, () => {
        this.dependencies.barrier.assertHealthy();
        const current = requireExecution(
          this.dependencies.executions,
          executionId,
        );
        if (current.lifecycle !== 'starting') {
          throw new Error('Reserved execution no longer owns activation');
        }
        const running = this.dependencies.executions.transitionInTransaction(
          executionId,
          current.revision,
          'running',
          runningAt,
          { nativeHandle: session.nativeHandle },
        );
        this.dependencies.operations.finishInTransaction(
          operation.id,
          'succeeded',
          { nativeHandle: session.nativeHandle },
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
      return;
    }
    this.publishDomain(runningEvent);
    try {
      this.attach(executionId, session);
    } catch (error) {
      await this.persistAdapterFailure(executionId, undefined, error, session);
    }
  }

  async interruptForPlanning(executionId: WorkerExecutionId): Promise<void> {
    const active = this.planningInterrupts.get(executionId);
    if (active) return active;
    const interrupt = Promise.resolve().then(() =>
      this.performPlanningInterrupt(executionId),
    );
    this.planningInterrupts.set(executionId, interrupt);
    const remove = () => {
      if (this.planningInterrupts.get(executionId) === interrupt) {
        this.planningInterrupts.delete(executionId);
      }
    };
    void interrupt.then(remove, remove);
    return interrupt;
  }

  private async rejectPlanningInterruptAuditConflict(
    executionId: string,
    current: WorkerExecution,
    message: string,
  ): Promise<never> {
    const owned = this.active.get(executionId);
    const exactOwned =
      owned !== undefined &&
      current.nativeHandle !== null &&
      owned.session.nativeHandle === current.nativeHandle
        ? owned
        : undefined;
    if (exactOwned) exactOwned.fenced = true;
    const error = new Error(message);
    this.dependencies.barrier.trip(error, this.dependencies.now());
    const diagnostics: PlanningInterruptCleanupDiagnostic[] = [
      { phase: 'audit', message },
    ];
    if (exactOwned) {
      await this.containAfterBarrier(exactOwned.session, diagnostics);
      diagnostics.push(
        ...(await this.quiescePlanningSession(executionId, exactOwned, false)),
      );
    }
    throw new PlanningInterruptCleanupError(
      'planning_interrupt_audit_failure',
      message,
      diagnostics,
      error,
    );
  }

  private async performPlanningInterrupt(executionId: string): Promise<void> {
    if (this.consumerContext.getStore() === executionId) {
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_quiescence_failure',
        'Planning interruption cannot await its own consumer task',
        [
          {
            phase: 'consumer_join',
            message: 'Self-wait was rejected before fencing',
          },
        ],
      );
    }
    const activation = this.activations.get(executionId);
    if (activation) await activation;

    const tagged = this.dependencies.operations
      .listForExecution(executionId)
      .filter(
        (operation) =>
          operation.kind === 'interrupt' &&
          typeof operation.request === 'object' &&
          operation.request !== null &&
          'version' in operation.request &&
          operation.request.version === PLANNING_INTERRUPT_OPERATION_VERSION,
      );
    const current = this.dependencies.executions.get(executionId);
    if (!current) {
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_not_running',
        'Planning execution was not found',
      );
    }
    if (current.assignment.kind !== 'pm_discovery') {
      if (tagged.length > 0) {
        return this.rejectPlanningInterruptAuditConflict(
          executionId,
          current,
          'Planning interrupt operation is not owned by a PM runtime',
        );
      }
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_not_running',
        'Execution is not a planning runtime',
      );
    }
    if (tagged.length > 1) {
      return this.rejectPlanningInterruptAuditConflict(
        executionId,
        current,
        'Conflicting planning interrupt operations found',
      );
    }
    const prior = tagged[0];
    if (prior?.state === 'succeeded') {
      if (current.lifecycle === 'interrupted') return;
      return this.rejectPlanningInterruptAuditConflict(
        executionId,
        current,
        'Planning interrupt operation does not match execution lifecycle',
      );
    }
    if (
      (prior?.state === 'pending' && current.lifecycle !== 'interrupting') ||
      ((prior?.state === 'unknown' || prior?.state === 'failed') &&
        current.lifecycle !== 'attention_required') ||
      (prior === undefined && current.lifecycle === 'interrupting')
    ) {
      return this.rejectPlanningInterruptAuditConflict(
        executionId,
        current,
        'Planning interrupt operation does not match execution lifecycle',
      );
    }
    if (
      prior?.state === 'unknown' ||
      prior?.state === 'failed' ||
      current.lifecycle === 'attention_required'
    ) {
      const replayDiagnostics =
        prior?.result &&
        typeof prior.result === 'object' &&
        'diagnostics' in prior.result &&
        Array.isArray(prior.result.diagnostics)
          ? prior.result.diagnostics.filter(
              isPlanningInterruptCleanupDiagnostic,
            )
          : [];
      const cleanupFailed = replayDiagnostics.some((diagnostic) =>
        ['session_close', 'consumer_join', 'consumer_removal'].includes(
          diagnostic.phase,
        ),
      );
      throw new PlanningInterruptCleanupError(
        cleanupFailed
          ? 'planning_interrupt_quiescence_failure'
          : 'planning_interrupt_unproven',
        cleanupFailed
          ? 'Planning session cleanup was not fully proven'
          : 'Planning interruption was not proven',
        replayDiagnostics.length > 0
          ? replayDiagnostics
          : [
              {
                phase: 'adapter_interrupt',
                message: 'A prior planning interruption settled without proof',
              },
            ],
      );
    }
    if (prior === undefined && current.lifecycle !== 'running') {
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_not_running',
        'Execution is not an active planning runtime',
      );
    }

    const owned = this.active.get(executionId);
    if (
      !owned ||
      current.nativeHandle === null ||
      owned.session.nativeHandle !== current.nativeHandle
    ) {
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_quiescence_failure',
        'The exact active planning session is unavailable',
        [
          {
            phase: 'consumer_removal',
            message: 'The durable native handle has no exact active session',
          },
        ],
      );
    }
    owned.fenced = true;
    try {
      this.dependencies.barrier.assertHealthy();
    } catch (error) {
      const recorded = this.dependencies.barrier.diagnostics.at(-1);
      const message =
        recorded?.cause ??
        recorded?.message ??
        (error instanceof Error ? error.message : 'Planning audit failed');
      const diagnostics: PlanningInterruptCleanupDiagnostic[] = [
        { phase: 'audit', message },
      ];
      await this.containAfterBarrier(owned.session, diagnostics);
      diagnostics.push(
        ...(await this.quiescePlanningSession(executionId, owned, false)),
      );
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_audit_failure',
        message,
        diagnostics,
        error,
      );
    }

    let operationId = prior?.id;
    if (!prior) {
      const occurredAt = this.dependencies.now();
      let interruptingEvent: DomainEvent;
      let writesStarted = false;
      try {
        interruptingEvent = inImmediateTransaction(
          this.dependencies.database,
          () => {
            this.dependencies.barrier.assertHealthy();
            writesStarted = true;
            const exact = requireExecution(
              this.dependencies.executions,
              executionId,
            );
            if (
              exact.lifecycle !== 'running' ||
              exact.nativeHandle !== owned.session.nativeHandle
            ) {
              throw new Error('Planning session ownership changed');
            }
            const interrupting =
              this.dependencies.executions.transitionInTransaction(
                exact.id,
                exact.revision,
                'interrupting',
                occurredAt,
              );
            operationId =
              this.dependencies.operations.createPendingInTransaction({
                executionId,
                kind: 'interrupt',
                request: {
                  version: PLANNING_INTERRUPT_OPERATION_VERSION,
                },
                createdAt: occurredAt,
              }).id;
            return this.dependencies.events.appendDomainInTransaction(
              exact.projectId,
              lifecycleDraft(interrupting, occurredAt),
            );
          },
        );
      } catch (error) {
        if (writesStarted && this.dependencies.barrier.status === 'healthy') {
          this.dependencies.barrier.trip(error, occurredAt);
        }
        await this.containAfterBarrier(owned.session);
        await this.quiescePlanningSession(executionId, owned, false);
        const message =
          error instanceof Error ? error.message : 'Planning audit failed';
        throw new PlanningInterruptCleanupError(
          'planning_interrupt_audit_failure',
          message,
          [{ phase: 'audit', message }],
          error,
        );
      }
      this.publishDomain(interruptingEvent);
    }
    if (!operationId) {
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_audit_failure',
        'Planning interrupt operation was not reserved',
        [
          {
            phase: 'audit',
            message: 'Planning interrupt operation was not reserved',
          },
        ],
      );
    }

    const diagnostics: PlanningInterruptCleanupDiagnostic[] = [];
    let interruptProof: unknown;
    let proven = false;
    try {
      const interrupted = await this.dependencies.adapter.interrupt(
        owned.session.nativeHandle,
      );
      this.dependencies.barrier.assertHealthy();
      interruptProof = interrupted;
      if (interrupted.status === 'succeeded') {
        proven = true;
      } else if (interrupted.status === 'already_terminal') {
        try {
          const probe = await this.dependencies.adapter.probe(
            owned.session.nativeHandle,
          );
          this.dependencies.barrier.assertHealthy();
          interruptProof = { interrupted, probe };
          proven =
            probe.status === 'terminal' && probe.outcome === 'interrupted';
          if (!proven) {
            diagnostics.push({
              phase: 'adapter_probe',
              message:
                probe.status === 'terminal'
                  ? `Adapter reported terminal ${probe.outcome}`
                  : probe.status === 'resumable'
                    ? 'Adapter session remains resumable'
                    : probe.reason,
            });
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          diagnostics.push({ phase: 'adapter_probe', message });
          interruptProof = { interrupted, probeError: message };
        }
      } else {
        diagnostics.push({
          phase: 'adapter_interrupt',
          message: interrupted.reason ?? 'Adapter interruption is unknown',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({ phase: 'adapter_interrupt', message });
      interruptProof = { error: message };
    }

    const cleanupDiagnostics = await this.quiescePlanningSession(
      executionId,
      owned,
      true,
    );
    diagnostics.push(...cleanupDiagnostics);
    const settled = proven && cleanupDiagnostics.length === 0;
    const completedAt = this.dependencies.now();
    let finishedEvent: DomainEvent;
    try {
      finishedEvent = inImmediateTransaction(this.dependencies.database, () => {
        this.dependencies.barrier.assertHealthy();
        const exact = requireExecution(
          this.dependencies.executions,
          executionId,
        );
        if (exact.lifecycle !== 'interrupting') {
          throw new Error('Planning interruption lost lifecycle ownership');
        }
        const finished = this.dependencies.executions.transitionInTransaction(
          exact.id,
          exact.revision,
          settled ? 'interrupted' : 'attention_required',
          completedAt,
        );
        this.dependencies.operations.finishInTransaction(
          operationId,
          settled ? 'succeeded' : 'unknown',
          { proof: interruptProof, diagnostics },
          completedAt,
        );
        return this.dependencies.events.appendDomainInTransaction(
          exact.projectId,
          lifecycleDraft(finished, completedAt),
        );
      });
    } catch (error) {
      if (this.dependencies.barrier.status === 'healthy') {
        this.dependencies.barrier.trip(error, completedAt);
      }
      const message =
        error instanceof Error ? error.message : 'Planning audit failed';
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_audit_failure',
        message,
        [...diagnostics, { phase: 'audit', message }],
        error,
      );
    }
    this.publishDomain(finishedEvent);

    if (cleanupDiagnostics.length > 0) {
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_quiescence_failure',
        'Planning session cleanup was not fully proven',
        diagnostics,
      );
    }
    if (!proven) {
      throw new PlanningInterruptCleanupError(
        'planning_interrupt_unproven',
        'Planning interruption was not proven',
        diagnostics,
      );
    }
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
    const owned: ActiveSession = {
      session,
      fenced: false,
      task: Promise.resolve(),
    };
    this.active.set(executionId, owned);
    owned.task = this.consumerContext
      .run(executionId, () => this.consume(executionId, owned))
      .finally(() => {
        if (this.active.get(executionId) === owned) {
          this.active.delete(executionId);
        }
      });
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

  private async quiescePlanningSession(
    executionId: string,
    owned: ActiveSession,
    close: boolean,
  ): Promise<PlanningInterruptCleanupDiagnostic[]> {
    const diagnostics: PlanningInterruptCleanupDiagnostic[] = [];
    if (close) {
      try {
        await owned.session.close();
      } catch (error) {
        diagnostics.push({
          phase: 'session_close',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await owned.task;
    } catch (error) {
      diagnostics.push({
        phase: 'consumer_join',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.active.get(executionId) === owned) {
      this.active.delete(executionId);
      diagnostics.push({
        phase: 'consumer_removal',
        message:
          'Consumer task settled without removing exact session ownership',
      });
    }
    return diagnostics;
  }

  private async consume(
    executionId: string,
    owned: ActiveSession,
  ): Promise<void> {
    const { session } = owned;
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
          if (owned.fenced) return;
          if (await this.stopIfBarrierTripped(session)) return;
          await this.persistAdapterFailure(
            executionId,
            undefined,
            error,
            session,
          );
          return;
        }
        if (owned.fenced) return;
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
          if (owned.fenced) return;
          await this.persistAdapterFailure(
            executionId,
            candidate,
            error,
            session,
          );
          return;
        }
        if (owned.fenced) return;
        const current = requireExecution(
          this.dependencies.executions,
          executionId,
        );
        if (envelope.adapterCursor !== current.lastAdapterCursor + 1) {
          if (owned.fenced) return;
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
          if (owned.fenced) return;
          await this.contain(session, error);
          return;
        }
        if (owned.fenced) return;
        this.publishRuntime(runtimeEvent);
        if (owned.fenced) return;
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
      if (owned.fenced) return;
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

  private async containAfterBarrier(
    session: HarnessSession,
    diagnostics?: PlanningInterruptCleanupDiagnostic[],
  ): Promise<void> {
    if (this.contained.has(session)) return;
    this.contained.add(session);
    try {
      await this.dependencies.adapter.interrupt(session.nativeHandle);
    } catch (interruptError) {
      diagnostics?.push({
        phase: 'adapter_interrupt',
        message:
          interruptError instanceof Error
            ? interruptError.message
            : String(interruptError),
      });
      this.dependencies.barrier.record(
        'Adapter interrupt failed during containment',
        interruptError,
      );
    } finally {
      try {
        await session.close();
      } catch (closeError) {
        diagnostics?.push({
          phase: 'session_close',
          message:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        });
        this.dependencies.barrier.record(
          'Session close failed during containment',
          closeError,
        );
      }
    }
  }
}
