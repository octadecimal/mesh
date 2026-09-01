import { createHash, randomUUID } from 'node:crypto';

import {
  DEVELOPER_REPORT_SCHEMA,
  developerAttemptSchema,
  developerReportIdSchema,
  developerTaskAssignmentSchema,
  interruptDeveloperAttemptEnvelopeSchema,
  replaceDeveloperAttemptExecutionEnvelopeSchema,
  startDeveloperAttemptEnvelopeSchema,
  v2ErrorCodeSchema,
  type DeveloperAttempt,
  type DeveloperReport,
  type DomainEvent,
  type BoardView,
  type ManagedWorkspace,
  type ResolvedWorkerProfileSnapshot,
  type V2Command,
  type V2CommandEnvelope,
  type V2CommandResult,
  type V2ErrorCode,
  type WorkerExecution,
  type WorkerExecutionId,
  type WorkerExecutionStructuredOutputRuntimeEvent,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import {
  ExecutionReservationError,
  type ExecutionRuntime,
} from '../executions/execution-runtime.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import type {
  PlanningRepository,
  TaskExecutionAuthority,
} from '../planning/planning-repository.js';
import type { V2CommandRepository } from '../storage/command-repository.js';
import {
  hashV2Command,
  V2IdempotencyConflictError,
} from '../storage/command-repository.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { V2EventStore } from '../storage/event-store.js';
import {
  DeveloperAttemptConflictError,
  type DeveloperStartReservation,
  type DeveloperRepository,
} from './developer-repository.js';
import type { DeriveManagedWorkspaceInput } from './managed-workspace.js';

export type { TaskExecutionAuthority } from '../planning/planning-repository.js';

export type StartDeveloperAttemptEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'developer_attempt.start' }>;
};

export type InterruptDeveloperAttemptEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'developer_attempt.interrupt' }>;
};

export type ReplaceDeveloperAttemptExecutionEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'developer_attempt.replace_execution' }>;
};

type Dependencies = {
  database: V2Database;
  planning: Pick<
    PlanningRepository,
    | 'taskExecutionAuthority'
    | 'taskExecutionAuthorityInTransaction'
    | 'appendOperationalTaskLifecycleInTransaction'
  >;
  developers: Pick<
    DeveloperRepository,
    | 'attempt'
    | 'attemptsForProject'
    | 'nonterminalAttempts'
    | 'startReservation'
    | 'startReservationForAttempt'
    | 'reserveAttemptInTransaction'
    | 'recordWorkspaceObservationInTransaction'
    | 'linkExecutionInTransaction'
    | 'transitionAttemptInTransaction'
    | 'insertReportInTransaction'
    | 'outputReceipt'
    | 'recordOutputReceiptInTransaction'
  >;
  profiles: {
    resolveApproved(
      profileId: string,
      revision: number,
    ): ResolvedWorkerProfileSnapshot;
  };
  commands: Pick<V2CommandRepository, 'find' | 'storeInTransaction'>;
  events: Pick<V2EventStore, 'appendDomainInTransaction'>;
  executions: { get(id: WorkerExecutionId): WorkerExecution | undefined };
  execution: Pick<
    ExecutionRuntime,
    'reserveStart' | 'reserveReplacement' | 'activateReserved' | 'interrupt'
  >;
  workspace: {
    inspectProject(repositoryPath: string): Promise<{
      repositoryIdentity: string;
      headCommit: string;
    }>;
    derive(input: DeriveManagedWorkspaceInput): ManagedWorkspace;
    create(workspace: ManagedWorkspace): Promise<ManagedWorkspace>;
    observe(workspace: ManagedWorkspace): Promise<ManagedWorkspace>;
  };
  barrier: Pick<AuditBarrier, 'assertHealthy' | 'trip'>;
  billingConflicts: readonly { variable: string }[];
  managedWorkspaceRoot: string;
  now(): string;
  publishDomain(event: DomainEvent): void;
};

type StartTransaction = {
  result: V2CommandResult;
  attempt?: DeveloperAttempt;
  event?: DomainEvent;
  launch?: StartLaunchProjection;
};

type StartLaunchProjection = {
  projectId: string;
  board: BoardView;
};

type StartFlight = {
  projectId: string;
  commandType: 'developer_attempt.start';
  requestHash: string;
  promise: Promise<V2CommandResult>;
};

const failure = (
  message: string,
  code: V2ErrorCode = 'invalid_request',
): V2CommandResult => ({
  ok: false,
  commandType: 'developer_attempt.start',
  error: { code, message },
});

const mutationFailure = (
  commandType:
    | 'developer_attempt.interrupt'
    | 'developer_attempt.replace_execution',
  message: string,
  code: V2ErrorCode = 'developer_attempt_transition_conflict',
): V2CommandResult => ({
  ok: false,
  commandType,
  error: { code, message },
});

const failureFrom = (
  error: unknown,
  fallback: V2ErrorCode,
): V2CommandResult => {
  if (error instanceof ExecutionReservationError && !error.result.ok)
    return failure(error.result.error.message, error.result.error.code);
  const parsed = v2ErrorCodeSchema.safeParse(
    (error as { code?: unknown } | undefined)?.code,
  );
  return failure(
    error instanceof Error ? error.message : String(error),
    parsed.success ? parsed.data : fallback,
  );
};

const typedError = (code: V2ErrorCode, message: string): Error =>
  Object.assign(new Error(message), { code });

const compatible = (profile: ResolvedWorkerProfileSnapshot) =>
  profile.document.spec.assignmentKinds.length === 1 &&
  profile.document.spec.assignmentKinds[0] === 'developer_task' &&
  profile.document.spec.outputSchema === DEVELOPER_REPORT_SCHEMA;

const outputDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export class DeveloperAttemptService {
  private readonly attemptTails = new Map<string, Promise<void>>();
  private readonly startTails = new Map<string, Promise<void>>();
  private readonly startFlights = new Map<string, StartFlight>();

  constructor(private readonly dependencies: Dependencies) {}

  private replayStart(
    command: StartDeveloperAttemptEnvelope,
    requestHash: string,
  ): V2CommandResult | undefined {
    try {
      return this.dependencies.commands.find(
        command.idempotencyKey,
        requestHash,
      )?.result;
    } catch (error) {
      if (error instanceof V2IdempotencyConflictError)
        return failureFrom(error, 'idempotency_conflict');
      this.dependencies.barrier.trip(error, this.dependencies.now());
      return failureFrom(error, 'audit_barrier_tripped');
    }
  }

  private startReservationMismatch(
    reservation: DeveloperStartReservation,
    command: StartDeveloperAttemptEnvelope,
    requestHash: string,
  ): V2CommandResult | undefined {
    if (
      reservation.requestHash === requestHash &&
      reservation.commandType === command.command.type &&
      reservation.projectId === command.command.projectId
    )
      return undefined;
    return failure('Idempotency key was already used', 'idempotency_conflict');
  }

  private async singleFlightStart(
    command: StartDeveloperAttemptEnvelope,
    requestHash: string,
    operation: () => Promise<V2CommandResult>,
  ): Promise<V2CommandResult> {
    const existing = this.startFlights.get(command.idempotencyKey);
    if (existing) {
      if (
        existing.projectId === command.command.projectId &&
        existing.commandType === command.command.type &&
        existing.requestHash === requestHash
      )
        return existing.promise;
      return failure(
        'Idempotency key was already used',
        'idempotency_conflict',
      );
    }
    const promise = operation();
    const current: StartFlight = {
      projectId: command.command.projectId,
      commandType: command.command.type,
      requestHash,
      promise,
    };
    this.startFlights.set(command.idempotencyKey, current);
    try {
      return await promise;
    } finally {
      if (this.startFlights.get(command.idempotencyKey) === current)
        this.startFlights.delete(command.idempotencyKey);
    }
  }

  async acceptReport(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
    report: DeveloperReport | null,
  ): Promise<void> {
    const assignment = developerTaskAssignmentSchema.safeParse(
      execution.assignment,
    );
    if (!assignment.success) return;
    const digest = outputDigest(event.payload.value);
    if (this.receiptMatches(event.id, digest)) return;
    this.dependencies.barrier.assertHealthy();
    await this.inAttemptOrder(assignment.data.attemptId, () =>
      this.acceptReportLocked(execution, event, report),
    );
  }

  private async acceptReportLocked(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
    report: DeveloperReport | null,
  ): Promise<void> {
    const assignment = developerTaskAssignmentSchema.safeParse(
      execution.assignment,
    );
    if (!assignment.success) return;
    const digest = outputDigest(event.payload.value);
    if (this.receiptMatches(event.id, digest)) return;
    this.dependencies.barrier.assertHealthy();
    const candidate = this.dependencies.developers.attempt(
      assignment.data.attemptId,
    );
    let observation: ManagedWorkspace | undefined;
    if (candidate) {
      try {
        observation = await this.dependencies.workspace.observe(
          candidate.workspace,
        );
        this.dependencies.barrier.assertHealthy();
      } catch (error) {
        this.dependencies.barrier.trip(error, this.dependencies.now());
        throw error;
      }
    }
    const committed: DomainEvent[] = [];
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        const prior = this.dependencies.developers.outputReceipt(event.id);
        if (prior) {
          if (prior.outputDigest !== digest) {
            throw new Error(
              'Developer output receipt conflicts with prior receipt',
            );
          }
          return;
        }
        const persistedAttempt = this.dependencies.developers.attempt(
          assignment.data.attemptId,
        );
        if (!persistedAttempt)
          throw new Error('Developer attempt was not found');
        let attempt: DeveloperAttempt = persistedAttempt;
        const frozenAssignment = developerTaskAssignmentSchema.safeParse(
          attempt.assignment,
        );
        const reject = (reason: string) =>
          this.dependencies.developers.recordOutputReceiptInTransaction({
            runtimeEventId: event.id,
            projectId: attempt.projectId,
            attemptId: attempt.id,
            executionId: execution.id,
            outputDigest: digest,
            status: 'rejected',
            rejectionReason: reason,
            createdAt: event.occurredAt,
          });
        if (
          report === null ||
          event.type !== 'worker_execution.structured_output' ||
          event.executionId !== execution.id ||
          event.projectId !== execution.projectId ||
          event.payload.schema !== DEVELOPER_REPORT_SCHEMA ||
          attempt.lifecycle !== 'active' ||
          attempt.controllingExecutionId !== execution.id ||
          execution.projectId !== attempt.projectId ||
          !frozenAssignment.success ||
          canonicalJson(assignment.data) !==
            canonicalJson(frozenAssignment.data) ||
          assignment.data.attemptId !== attempt.id ||
          assignment.data.taskId !== attempt.taskId ||
          assignment.data.taskContractRevision !==
            attempt.taskContractRevision ||
          assignment.data.workspacePath !== attempt.workspace.path ||
          report?.attemptId !== attempt.id ||
          report?.executionId !== execution.id ||
          report?.taskId !== attempt.taskId ||
          report?.taskContractRevision !== attempt.taskContractRevision ||
          attempt.reportIds.length > 0
        ) {
          reject('report_binding_mismatch');
          return;
        }
        if (
          !observation ||
          !candidate ||
          candidate.workspace.revision !== attempt.workspace.revision
        ) {
          reject('workspace_observation_mismatch');
          return;
        }
        const workspace =
          this.dependencies.developers.recordWorkspaceObservationInTransaction(
            {
              ...observation,
              revision: attempt.workspace.revision + 1,
              updatedAt: this.dependencies.now(),
            },
            attempt.workspace.revision,
          );
        attempt = this.requireAttempt(attempt.id);
        if (
          workspace.lifecycle !== 'ready' ||
          report.workspace.headCommit !== workspace.observedHead ||
          report.workspace.dirty !== workspace.observedDirty
        ) {
          reject('workspace_observation_mismatch');
          return;
        }
        const authority =
          this.dependencies.planning.taskExecutionAuthorityInTransaction(
            attempt.projectId,
            attempt.taskId,
          );
        if (
          !authority ||
          authority.task.revision !== attempt.taskCurrentRevision ||
          authority.task.contractRevision !== attempt.taskContractRevision ||
          authority.deliveryPlan.plan.id !== attempt.deliveryPlanId ||
          authority.deliveryPlan.plan.revision !== attempt.deliveryPlanRevision
        ) {
          reject('authoritative_binding_mismatch');
          return;
        }
        if (
          report.disposition === 'completed' &&
          !this.hasExactCompletionCoverage(attempt, report)
        ) {
          reject('report_coverage_invalid');
          return;
        }

        this.dependencies.developers.recordOutputReceiptInTransaction({
          runtimeEventId: event.id,
          projectId: attempt.projectId,
          attemptId: attempt.id,
          executionId: execution.id,
          outputDigest: digest,
          status: 'accepted',
          rejectionReason: null,
          createdAt: event.occurredAt,
        });
        const recorded = this.dependencies.developers.insertReportInTransaction(
          {
            id: developerReportIdSchema.parse(randomUUID()),
            report,
            recordedAt: event.occurredAt,
          },
        );
        const task =
          report.disposition === 'completed'
            ? this.dependencies.planning.appendOperationalTaskLifecycleInTransaction(
                {
                  projectId: attempt.projectId,
                  expectedDeliveryPlanRevision: attempt.deliveryPlanRevision,
                  taskId: attempt.taskId,
                  expectedContractRevision: attempt.taskContractRevision,
                  expectedCurrentRevision: attempt.taskCurrentRevision,
                  lifecycle: 'completed',
                  createdAt: event.occurredAt,
                },
              )
            : null;
        const board =
          this.dependencies.planning.taskExecutionAuthorityInTransaction(
            attempt.projectId,
            attempt.taskId,
          )?.board;
        if (!board) throw new Error('Task execution authority was not found');
        const settled =
          this.dependencies.developers.transitionAttemptInTransaction(
            {
              ...attempt,
              lifecycle:
                report.disposition === 'completed' ? 'completed' : 'blocked',
              revision: attempt.revision + 1,
              reportIds: [...attempt.reportIds, recorded.id],
              updatedAt: event.occurredAt,
              endedAt: event.occurredAt,
            },
            attempt.revision,
          );
        committed.push(
          this.dependencies.events.appendDomainInTransaction(
            attempt.projectId,
            {
              projectId: attempt.projectId,
              occurredAt: event.occurredAt,
              type: 'developer_report.recorded',
              payload: {
                schemaVersion: 1,
                attempt: settled,
                report: recorded,
                board,
              },
            },
          ),
          this.dependencies.events.appendDomainInTransaction(
            attempt.projectId,
            {
              projectId: attempt.projectId,
              occurredAt: event.occurredAt,
              type: 'developer_attempt.changed',
              payload: { schemaVersion: 1, attempt: settled, board },
            },
          ),
        );
        if (task) {
          committed.push(
            this.dependencies.events.appendDomainInTransaction(
              attempt.projectId,
              {
                projectId: attempt.projectId,
                occurredAt: event.occurredAt,
                type: 'task.lifecycle_changed',
                payload: { schemaVersion: 1, task, board },
              },
            ),
          );
        }
      });
    } catch (error) {
      this.dependencies.barrier.trip(error, this.dependencies.now());
      throw error;
    }
    for (const domainEvent of committed)
      this.dependencies.publishDomain(domainEvent);
  }

  terminal(execution: WorkerExecution): void {
    this.dependencies.barrier.assertHealthy();
    const assignment = developerTaskAssignmentSchema.safeParse(
      execution.assignment,
    );
    if (!assignment.success) return;
    if (
      !['completed', 'failed', 'interrupted', 'attention_required'].includes(
        execution.lifecycle,
      )
    )
      return;

    let event: DomainEvent | undefined;
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        const attempt = this.dependencies.developers.attempt(
          assignment.data.attemptId,
        );
        if (
          !attempt ||
          attempt.lifecycle !== 'active' ||
          attempt.controllingExecutionId !== execution.id ||
          attempt.projectId !== execution.projectId ||
          attempt.reportIds.length > 0
        )
          return;
        const authority =
          this.dependencies.planning.taskExecutionAuthorityInTransaction(
            attempt.projectId,
            attempt.taskId,
          );
        if (!authority)
          throw new Error('Task execution authority was not found');
        const requiresAttention = execution.lifecycle === 'attention_required';
        const next =
          this.dependencies.developers.transitionAttemptInTransaction(
            {
              ...attempt,
              lifecycle: requiresAttention
                ? 'attention_required'
                : 'interrupted',
              revision: attempt.revision + 1,
              attention: requiresAttention
                ? {
                    code: 'developer_attempt_transition_conflict',
                    message: 'Controlling execution requires attention',
                  }
                : null,
              updatedAt: execution.updatedAt,
              endedAt: requiresAttention ? execution.updatedAt : null,
            },
            attempt.revision,
          );
        event = this.dependencies.events.appendDomainInTransaction(
          attempt.projectId,
          {
            projectId: attempt.projectId,
            occurredAt: next.updatedAt,
            type: 'developer_attempt.changed',
            payload: {
              schemaVersion: 1,
              attempt: next,
              board: authority.board,
            },
          },
        );
      });
    } catch (error) {
      this.dependencies.barrier.trip(error, this.dependencies.now());
      throw error;
    }
    if (event) this.dependencies.publishDomain(event);
  }

  async start(
    envelope: StartDeveloperAttemptEnvelope,
  ): Promise<V2CommandResult> {
    let command: StartDeveloperAttemptEnvelope;
    try {
      command = startDeveloperAttemptEnvelopeSchema.parse(envelope);
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : 'Invalid request',
      );
    }

    const requestHash = hashV2Command(command.command);
    const replay = this.replayStart(command, requestHash);
    if (replay) return replay;
    return this.singleFlightStart(command, requestHash, () =>
      this.inStartOrder(command.idempotencyKey, () =>
        this.startLocked(command, requestHash),
      ),
    );
  }

  private async startLocked(
    command: StartDeveloperAttemptEnvelope,
    requestHash: string,
  ): Promise<V2CommandResult> {
    const repeated = this.replayStart(command, requestHash);
    if (repeated) return repeated;
    const reservation = this.dependencies.developers.startReservation(
      command.idempotencyKey,
    );
    if (reservation) {
      const mismatch = this.startReservationMismatch(
        reservation,
        command,
        requestHash,
      );
      if (mismatch) return mismatch;
      try {
        this.dependencies.barrier.assertHealthy();
      } catch (error) {
        return failure(
          error instanceof Error ? error.message : 'Audit barrier tripped',
          'audit_barrier_tripped',
        );
      }
      const recovering = this.dependencies.developers.attempt(
        reservation.attemptId,
      );
      if (!recovering) {
        const error = new Error('Developer start claim has no attempt');
        this.dependencies.barrier.trip(error, this.dependencies.now());
        return failure(error.message, 'audit_barrier_tripped');
      }
      return this.resumeStart(command, requestHash, recovering, reservation);
    }
    try {
      this.dependencies.barrier.assertHealthy();
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : 'Audit barrier tripped',
        'audit_barrier_tripped',
      );
    }
    if (this.dependencies.billingConflicts.length > 0) {
      return failure('Billing override is configured');
    }

    const authority = this.dependencies.planning.taskExecutionAuthority(
      command.command.projectId,
      command.command.taskId,
    );
    if (!authority)
      return failure(
        'Task execution authority was not found',
        'developer_task_stale',
      );
    if (
      authority.deliveryPlan.plan.id !==
        command.command.expectedDeliveryPlanId ||
      authority.deliveryPlan.plan.revision !==
        command.command.expectedDeliveryPlanRevision ||
      authority.task.revision !== command.command.expectedTaskRevision
    ) {
      return failure(
        'Task execution authority is stale',
        'developer_task_stale',
      );
    }
    if (authority.card.readiness.state !== 'actionable')
      return failure('Task is not actionable', 'developer_task_not_actionable');
    if (
      this.dependencies.developers
        .nonterminalAttempts()
        .some((attempt) => attempt.taskId === authority.task.id)
    ) {
      return failure(
        'Task already has a controlling Developer attempt',
        'developer_attempt_conflict',
      );
    }

    let profile: ResolvedWorkerProfileSnapshot;
    try {
      profile = this.dependencies.profiles.resolveApproved(
        command.command.profileId,
        command.command.profileRevision,
      );
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : 'Profile was not found',
        'developer_profile_stale',
      );
    }
    if (!compatible(profile))
      return failure(
        'Profile is not a Developer profile',
        'developer_profile_incompatible',
      );
    if (
      profile.projectId !== null &&
      profile.projectId !== authority.project.id
    ) {
      return failure(
        'Profile is not available for this project',
        'developer_profile_incompatible',
      );
    }

    let observedProject: { repositoryIdentity: string; headCommit: string };
    try {
      observedProject = await this.dependencies.workspace.inspectProject(
        authority.project.repositoryPath,
      );
    } catch (error) {
      return failureFrom(error, 'adapter_unavailable');
    }
    if (
      observedProject.repositoryIdentity !==
        authority.project.repositoryIdentity ||
      observedProject.headCommit !== authority.project.headCommit
    ) {
      return failure(
        'Repository identity or HEAD changed',
        'developer_workspace_identity_mismatch',
      );
    }

    let started: StartTransaction;
    let reservationWritesStarted = false;
    try {
      started = inImmediateTransaction(this.dependencies.database, () => {
        const stored = this.dependencies.commands.find(
          command.idempotencyKey,
          requestHash,
        );
        if (stored) return { result: stored.result };
        const reservation = this.dependencies.developers.startReservation(
          command.idempotencyKey,
        );
        if (reservation) {
          if (
            reservation.requestHash !== requestHash ||
            reservation.commandType !== command.command.type ||
            reservation.projectId !== command.command.projectId
          ) {
            throw typedError(
              'idempotency_conflict',
              'Idempotency key was already used',
            );
          }
          const resumed = this.dependencies.developers.attempt(
            reservation.attemptId,
          );
          if (!resumed) throw new Error('Developer start claim has no attempt');
          if (!['reserved', 'provisioning'].includes(resumed.lifecycle)) {
            const result: V2CommandResult =
              resumed.lifecycle === 'active'
                ? {
                    ok: true,
                    commandType: 'developer_attempt.start',
                    schemaVersion: 1,
                    attempt: resumed,
                    board: reservation.board,
                  }
                : failure(
                    resumed.attention?.message ??
                      'Developer start did not finish',
                    'adapter_unavailable',
                  );
            this.dependencies.commands.storeInTransaction({
              idempotencyKey: command.idempotencyKey,
              commandType: command.command.type,
              requestHash,
              result,
              createdAt: resumed.updatedAt,
            });
            return { result };
          }
          return {
            result: {
              ok: true,
              commandType: 'developer_attempt.start',
              schemaVersion: 1,
              attempt: resumed,
              board: reservation.board,
            },
            attempt: resumed,
            launch: {
              projectId: reservation.projectId,
              board: reservation.board,
            },
          };
        }
        this.dependencies.barrier.assertHealthy();
        if (this.dependencies.billingConflicts.length > 0) {
          throw new Error('Billing override is configured');
        }
        const reservedAuthority =
          this.dependencies.planning.taskExecutionAuthorityInTransaction(
            command.command.projectId,
            command.command.taskId,
          );
        if (!reservedAuthority) {
          throw typedError(
            'developer_task_stale',
            'Task execution authority was not found',
          );
        }
        if (
          reservedAuthority.deliveryPlan.plan.id !==
            command.command.expectedDeliveryPlanId ||
          reservedAuthority.deliveryPlan.plan.revision !==
            command.command.expectedDeliveryPlanRevision ||
          reservedAuthority.task.revision !==
            command.command.expectedTaskRevision
        ) {
          throw typedError(
            'developer_task_stale',
            'Task execution authority is stale',
          );
        }
        if (reservedAuthority.card.readiness.state !== 'actionable') {
          throw typedError(
            'developer_task_not_actionable',
            'Task is not actionable',
          );
        }
        if (
          this.dependencies.developers
            .nonterminalAttempts()
            .some((attempt) => attempt.taskId === reservedAuthority.task.id)
        ) {
          throw typedError(
            'developer_attempt_conflict',
            'Task already has a controlling Developer attempt',
          );
        }
        if (
          !compatible(profile) ||
          (profile.projectId !== null &&
            profile.projectId !== reservedAuthority.project.id)
        ) {
          throw typedError(
            'developer_profile_incompatible',
            'Profile is not available for this project',
          );
        }
        if (
          observedProject.repositoryIdentity !==
            reservedAuthority.project.repositoryIdentity ||
          observedProject.headCommit !== reservedAuthority.project.headCommit
        ) {
          throw typedError(
            'developer_workspace_identity_mismatch',
            'Repository identity or HEAD changed',
          );
        }
        const attempt = this.newAttempt(reservedAuthority, command, profile);
        reservationWritesStarted = true;
        const reserved =
          this.dependencies.developers.reserveAttemptInTransaction(attempt, {
            attemptId: attempt.id,
            projectId: attempt.projectId,
            idempotencyKey: command.idempotencyKey,
            commandType: command.command.type,
            requestHash,
            board: reservedAuthority.board,
            createdAt: attempt.createdAt,
          });
        const result: V2CommandResult = {
          ok: true,
          commandType: 'developer_attempt.start',
          schemaVersion: 1,
          attempt: reserved,
          board: reservedAuthority.board,
        };
        const event = this.dependencies.events.appendDomainInTransaction(
          reservedAuthority.project.id,
          {
            projectId: reservedAuthority.project.id,
            occurredAt: attempt.createdAt,
            type: 'developer_attempt.changed',
            payload: {
              schemaVersion: 1,
              attempt: reserved,
              board: reservedAuthority.board,
            },
          },
        );
        return {
          result,
          attempt: reserved,
          event,
          launch: {
            projectId: reservedAuthority.project.id,
            board: reservedAuthority.board,
          },
        };
      });
    } catch (error) {
      if (reservationWritesStarted) {
        this.dependencies.barrier.trip(error, this.dependencies.now());
        return failureFrom(error, 'audit_barrier_tripped');
      }
      if (error instanceof DeveloperAttemptConflictError)
        return failure(error.message, error.code);
      return failureFrom(error, 'invalid_request');
    }
    if (!started.attempt) return started.result;
    if (started.event) this.dependencies.publishDomain(started.event);
    return this.inAttemptOrder(started.attempt.id, () =>
      this.launchStart(command, requestHash, profile, started),
    );
  }

  private async resumeStart(
    command: StartDeveloperAttemptEnvelope,
    requestHash: string,
    attempt: DeveloperAttempt,
    reservation: DeveloperStartReservation,
  ): Promise<V2CommandResult> {
    const result: V2CommandResult = {
      ok: true,
      commandType: 'developer_attempt.start',
      schemaVersion: 1,
      attempt,
      board: reservation.board,
    };
    if (!['reserved', 'provisioning'].includes(attempt.lifecycle)) {
      const settled =
        attempt.lifecycle === 'active'
          ? result
          : failure(
              attempt.attention?.message ?? 'Developer start did not finish',
              'adapter_unavailable',
            );
      try {
        inImmediateTransaction(this.dependencies.database, () => {
          this.dependencies.commands.storeInTransaction({
            idempotencyKey: command.idempotencyKey,
            commandType: command.command.type,
            requestHash,
            result: settled,
            createdAt: attempt.updatedAt,
          });
        });
      } catch (error) {
        this.dependencies.barrier.trip(error, this.dependencies.now());
        return failureFrom(error, 'audit_barrier_tripped');
      }
      return settled;
    }
    return this.inAttemptOrder(attempt.id, () =>
      this.launchStart(
        command,
        requestHash,
        {
          profileId: attempt.profileId,
          profileRevision: attempt.profileRevision,
        },
        {
          result,
          attempt,
          launch: {
            projectId: reservation.projectId,
            board: reservation.board,
          },
        },
      ),
    );
  }

  private async launchStart(
    command: StartDeveloperAttemptEnvelope,
    requestHash: string,
    profile: Pick<
      ResolvedWorkerProfileSnapshot,
      'profileId' | 'profileRevision'
    >,
    started: StartTransaction,
  ): Promise<V2CommandResult> {
    const launch = started.launch!;
    const current = this.requireAttempt(started.attempt!.id);
    if (!['reserved', 'provisioning'].includes(current.lifecycle)) {
      return (
        this.dependencies.commands.find(command.idempotencyKey, requestHash)
          ?.result ?? started.result
      );
    }

    try {
      let provisioned = current;
      let workspaceFailure: V2CommandResult | undefined;
      if (current.lifecycle === 'reserved') {
        const observation = await this.dependencies.workspace.create(
          current.workspace,
        );
        let workspaceEvent: DomainEvent;
        ({ provisioned, workspaceEvent, workspaceFailure } =
          inImmediateTransaction(this.dependencies.database, () => {
            const persisted = this.requireAttempt(current.id);
            const workspace =
              this.dependencies.developers.recordWorkspaceObservationInTransaction(
                {
                  ...observation,
                  revision: persisted.workspace.revision + 1,
                  updatedAt: this.dependencies.now(),
                },
                persisted.workspace.revision,
              );
            const attention =
              workspace.lifecycle === 'attention_required'
                ? (workspace.failure ?? {
                    code: 'workspace_attention_required',
                    message: 'Managed workspace requires attention',
                  })
                : null;
            const next =
              this.dependencies.developers.transitionAttemptInTransaction(
                {
                  ...persisted,
                  lifecycle:
                    workspace.lifecycle === 'ready'
                      ? 'provisioning'
                      : 'attention_required',
                  revision: persisted.revision + 1,
                  workspace,
                  attention,
                  updatedAt: this.dependencies.now(),
                  endedAt:
                    workspace.lifecycle === 'ready'
                      ? null
                      : this.dependencies.now(),
                },
                persisted.revision,
              );
            const event = this.dependencies.events.appendDomainInTransaction(
              launch.projectId,
              {
                projectId: launch.projectId,
                occurredAt: next.updatedAt,
                type: 'developer_workspace.changed',
                payload: {
                  schemaVersion: 1,
                  attempt: next,
                  board: launch.board,
                },
              },
            );
            const failureResult =
              workspace.lifecycle === 'ready'
                ? undefined
                : failure(
                    workspace.failure?.message ??
                      'Managed workspace requires attention',
                    'developer_workspace_conflict',
                  );
            if (failureResult) {
              this.dependencies.commands.storeInTransaction({
                idempotencyKey: command.idempotencyKey,
                commandType: command.command.type,
                requestHash,
                result: failureResult,
                createdAt: next.updatedAt,
              });
            }
            return {
              provisioned: next,
              workspaceEvent: event,
              workspaceFailure: failureResult,
            };
          }));
        this.dependencies.publishDomain(workspaceEvent);
      }
      if (workspaceFailure) return workspaceFailure;
      if (provisioned.workspace.lifecycle !== 'ready') {
        return this.markAttention(
          provisioned.id,
          launch,
          new Error(
            provisioned.workspace.failure?.message ??
              'Managed workspace requires attention',
          ),
          failure(
            provisioned.workspace.failure?.message ??
              'Managed workspace requires attention',
            'developer_workspace_conflict',
          ),
          command,
          requestHash,
        );
      }

      const execution = await this.dependencies.execution.reserveStart({
        idempotencyKey: `developer-attempt:${provisioned.id}:execution:1`,
        actor: command.actor,
        command: {
          type: 'worker_execution.start',
          projectId: launch.projectId,
          profileId: profile.profileId,
          profileRevision: profile.profileRevision,
          assignment: provisioned.assignment,
        },
      });
      if (!execution.result.ok) {
        const executionFailure = execution.result as Extract<
          V2CommandResult,
          { ok: false }
        >;
        let failedEvent: DomainEvent;
        let failedResult: V2CommandResult;
        ({ failedEvent, failedResult } = inImmediateTransaction(
          this.dependencies.database,
          () => {
            const linked =
              this.dependencies.developers.linkExecutionInTransaction({
                attemptId: provisioned.id,
                executionId: execution.execution.id,
                expectedRevision: provisioned.revision,
                updatedAt: this.dependencies.now(),
              });
            const message = executionFailure.error.message;
            const workspace =
              this.dependencies.developers.recordWorkspaceObservationInTransaction(
                {
                  ...linked.workspace,
                  lifecycle: 'attention_required',
                  failure: {
                    code: 'developer_attempt_start_failed',
                    message,
                  },
                  revision: linked.workspace.revision + 1,
                  updatedAt: this.dependencies.now(),
                },
                linked.workspace.revision,
              );
            const next =
              this.dependencies.developers.transitionAttemptInTransaction(
                {
                  ...linked,
                  lifecycle: 'attention_required',
                  revision: linked.revision + 1,
                  workspace,
                  attention: {
                    code: 'developer_attempt_start_failed',
                    message,
                  },
                  updatedAt: this.dependencies.now(),
                  endedAt: this.dependencies.now(),
                },
                linked.revision,
              );
            const result = failure(message, executionFailure.error.code);
            this.dependencies.commands.storeInTransaction({
              idempotencyKey: command.idempotencyKey,
              commandType: command.command.type,
              requestHash,
              result,
              createdAt: next.updatedAt,
            });
            const event = this.dependencies.events.appendDomainInTransaction(
              launch.projectId,
              {
                projectId: launch.projectId,
                occurredAt: next.updatedAt,
                type: 'developer_attempt.changed',
                payload: {
                  schemaVersion: 1,
                  attempt: next,
                  board: launch.board,
                },
              },
            );
            return { failedEvent: event, failedResult: result };
          },
        ));
        this.dependencies.publishDomain(failedEvent);
        return failedResult;
      }

      let result: V2CommandResult;
      let activeEvent: DomainEvent;
      let active: DeveloperAttempt;
      ({ active, activeEvent, result } = inImmediateTransaction(
        this.dependencies.database,
        () => {
          const linked =
            this.dependencies.developers.linkExecutionInTransaction({
              attemptId: provisioned.id,
              executionId: execution.execution.id,
              expectedRevision: provisioned.revision,
              updatedAt: this.dependencies.now(),
            });
          const next =
            this.dependencies.developers.transitionAttemptInTransaction(
              {
                ...linked,
                lifecycle: 'active',
                revision: linked.revision + 1,
                updatedAt: this.dependencies.now(),
              },
              linked.revision,
            );
          const nextResult: V2CommandResult = {
            ok: true,
            commandType: 'developer_attempt.start',
            schemaVersion: 1,
            attempt: next,
            board: launch.board,
          };
          this.dependencies.commands.storeInTransaction({
            idempotencyKey: command.idempotencyKey,
            commandType: command.command.type,
            requestHash,
            result: nextResult,
            createdAt: next.updatedAt,
          });
          const event = this.dependencies.events.appendDomainInTransaction(
            launch.projectId,
            {
              projectId: launch.projectId,
              occurredAt: next.updatedAt,
              type: 'developer_attempt.changed',
              payload: {
                schemaVersion: 1,
                attempt: next,
                board: launch.board,
              },
            },
          );
          return { active: next, activeEvent: event, result: nextResult };
        },
      ));
      this.dependencies.publishDomain(activeEvent);
      if (execution.activationRequired) {
        await this.dependencies.execution.activateReserved(
          active.controllingExecutionId!,
        );
      }
      return result;
    } catch (error) {
      const failureResult = failureFrom(error, 'adapter_unavailable');
      const stored = this.dependencies.commands.find(
        command.idempotencyKey,
        requestHash,
      );
      if (stored) {
        try {
          this.markAttention(
            current.id,
            launch,
            error,
            failureResult,
            command,
            requestHash,
          );
        } catch (attentionError) {
          this.dependencies.barrier.trip(
            attentionError,
            this.dependencies.now(),
          );
        }
        return stored.result;
      }
      return this.markAttention(
        current.id,
        launch,
        error,
        failureResult,
        command,
        requestHash,
      );
    }
  }

  async interrupt(
    envelope: InterruptDeveloperAttemptEnvelope,
  ): Promise<V2CommandResult> {
    const parsed = interruptDeveloperAttemptEnvelopeSchema.safeParse(envelope);
    if (!parsed.success)
      return mutationFailure(
        'developer_attempt.interrupt',
        parsed.error.message,
      );
    const command = parsed.data;
    const requestHash = hashV2Command(command.command);
    return this.inAttemptOrder(command.command.attemptId, async () => {
      const reserved = this.reserveInterrupt(command, requestHash);
      if (reserved.event) this.dependencies.publishDomain(reserved.event);
      return this.settleInterrupt(command, reserved.result);
    });
  }

  private reserveInterrupt(
    command: InterruptDeveloperAttemptEnvelope,
    requestHash: string,
  ): { result: V2CommandResult; event?: DomainEvent } {
    let replay;
    try {
      replay = this.dependencies.commands.find(
        command.idempotencyKey,
        requestHash,
      );
    } catch (error) {
      throw error;
    }
    if (replay) return { result: replay.result };
    this.dependencies.barrier.assertHealthy();

    let accepted: V2CommandResult = mutationFailure(
      'developer_attempt.interrupt',
      'Developer interruption was not reserved',
    );
    let acceptedEvent: DomainEvent | undefined;
    inImmediateTransaction(this.dependencies.database, () => {
      const stored = this.dependencies.commands.find(
        command.idempotencyKey,
        requestHash,
      );
      if (stored) {
        accepted = stored.result;
        return;
      }
      const current = this.dependencies.developers.attempt(
        command.command.attemptId,
      );
      if (
        !current ||
        current.projectId !== command.command.projectId ||
        current.revision !== command.command.expectedAttemptRevision ||
        current.lifecycle !== 'active' ||
        !current.controllingExecutionId
      ) {
        accepted = mutationFailure(
          'developer_attempt.interrupt',
          'Developer attempt cannot be interrupted',
        );
        return;
      }
      const execution = this.dependencies.executions.get(
        current.controllingExecutionId,
      );
      if (
        !execution ||
        execution.projectId !== current.projectId ||
        execution.lifecycle !== 'running'
      ) {
        accepted = mutationFailure(
          'developer_attempt.interrupt',
          'Controlling execution cannot be interrupted',
        );
        return;
      }
      const authority =
        this.dependencies.planning.taskExecutionAuthorityInTransaction(
          current.projectId,
          current.taskId,
        );
      if (!authority) throw new Error('Task execution authority was not found');
      const updatedAt = this.dependencies.now();
      const interrupted =
        this.dependencies.developers.transitionAttemptInTransaction(
          {
            ...current,
            lifecycle: 'interrupted',
            revision: current.revision + 1,
            attention: null,
            updatedAt,
            endedAt: null,
          },
          current.revision,
        );
      accepted = {
        ok: true,
        commandType: 'developer_attempt.interrupt',
        schemaVersion: 1,
        attempt: interrupted,
        board: authority.board,
      };
      this.dependencies.commands.storeInTransaction({
        idempotencyKey: command.idempotencyKey,
        commandType: command.command.type,
        requestHash,
        result: accepted,
        createdAt: updatedAt,
      });
      acceptedEvent = this.dependencies.events.appendDomainInTransaction(
        current.projectId,
        {
          projectId: current.projectId,
          occurredAt: updatedAt,
          type: 'developer_attempt.changed',
          payload: {
            schemaVersion: 1,
            attempt: interrupted,
            board: authority.board,
          },
        },
      );
    });
    return { result: accepted, event: acceptedEvent };
  }

  private async settleInterrupt(
    command: InterruptDeveloperAttemptEnvelope,
    accepted: V2CommandResult,
  ): Promise<V2CommandResult> {
    if (!accepted.ok || accepted.commandType !== 'developer_attempt.interrupt')
      return accepted;

    const attempt = accepted.attempt;
    const current = this.dependencies.developers.attempt(attempt.id);
    if (
      !current ||
      current.revision !== attempt.revision ||
      current.lifecycle !== 'interrupted' ||
      current.controllingExecutionId !== attempt.controllingExecutionId ||
      current.workspace.revision !== attempt.workspace.revision
    ) {
      return accepted;
    }
    const execution = this.dependencies.executions.get(
      attempt.controllingExecutionId!,
    );
    if (!execution) {
      this.markAttemptAttention(
        attempt,
        'developer_interrupt_unproven',
        'Controlling execution disappeared during interruption',
      );
      return accepted;
    }
    if (execution.lifecycle === 'interrupted') return accepted;
    if (execution.lifecycle !== 'running') {
      this.markAttemptAttention(
        attempt,
        'developer_interrupt_unproven',
        'Controlling execution interruption was not proven',
      );
      return accepted;
    }
    try {
      await this.dependencies.execution.interrupt({
        idempotencyKey: `developer-attempt:${attempt.id}:interrupt:${attempt.revision}`,
        actor: command.actor,
        command: {
          type: 'worker_execution.interrupt',
          projectId: attempt.projectId,
          executionId: execution.id,
          expectedRevision: execution.revision,
        },
      });
    } catch (error) {
      this.markAttemptAttention(
        attempt,
        'developer_interrupt_unproven',
        error instanceof Error ? error.message : String(error),
      );
      return accepted;
    }
    const settled = this.dependencies.executions.get(execution.id);
    if (!settled || settled.lifecycle !== 'interrupted') {
      this.markAttemptAttention(
        attempt,
        'developer_interrupt_unproven',
        'Controlling execution interruption was not proven',
      );
    }
    return accepted;
  }

  async replaceExecution(
    envelope: ReplaceDeveloperAttemptExecutionEnvelope,
  ): Promise<V2CommandResult> {
    const parsed =
      replaceDeveloperAttemptExecutionEnvelopeSchema.safeParse(envelope);
    if (!parsed.success)
      return mutationFailure(
        'developer_attempt.replace_execution',
        parsed.error.message,
      );
    const command = parsed.data;
    const requestHash = hashV2Command(command.command);
    let replay;
    try {
      replay = this.dependencies.commands.find(
        command.idempotencyKey,
        requestHash,
      );
    } catch (error) {
      throw error;
    }
    if (replay) return replay.result;
    this.dependencies.barrier.assertHealthy();

    const attempt = this.dependencies.developers.attempt(
      command.command.attemptId,
    );
    if (
      !attempt ||
      attempt.projectId !== command.command.projectId ||
      attempt.revision !== command.command.expectedAttemptRevision ||
      attempt.lifecycle !== 'interrupted' ||
      !attempt.controllingExecutionId
    ) {
      return mutationFailure(
        'developer_attempt.replace_execution',
        'Developer attempt cannot replace its execution',
        'developer_replacement_unavailable',
      );
    }
    const prior = this.dependencies.executions.get(
      attempt.controllingExecutionId,
    );
    if (
      !prior ||
      prior.projectId !== attempt.projectId ||
      prior.lifecycle !== 'interrupted'
    ) {
      return mutationFailure(
        'developer_attempt.replace_execution',
        'Prior execution is not interrupted',
        'developer_replacement_unavailable',
      );
    }

    const observation = await this.dependencies.workspace.observe(
      attempt.workspace,
    );
    if (observation.lifecycle !== 'ready') {
      this.markAttemptAttention(
        attempt,
        observation.failure?.code ?? 'developer_workspace_conflict',
        observation.failure?.message ??
          'Workspace ownership could not be proven',
        observation,
      );
      return mutationFailure(
        'developer_attempt.replace_execution',
        'Workspace ownership could not be proven',
        'developer_replacement_unavailable',
      );
    }

    let reservation;
    try {
      reservation = await this.dependencies.execution.reserveReplacement(
        {
          idempotencyKey: `developer-attempt:${attempt.id}:execution:${attempt.executionIds.length + 1}`,
          actor: command.actor,
          command: {
            type: 'worker_execution.start',
            projectId: attempt.projectId,
            profileId: attempt.profileId,
            profileRevision: attempt.profileRevision,
            assignment: attempt.assignment,
          },
        },
        prior.id,
      );
    } catch (error) {
      this.markAttemptAttention(
        attempt,
        'developer_replacement_unavailable',
        error instanceof Error ? error.message : String(error),
      );
      return mutationFailure(
        'developer_attempt.replace_execution',
        'Replacement execution could not be reserved',
        'developer_replacement_unavailable',
      );
    }
    if (
      reservation.execution.projectId !== attempt.projectId ||
      reservation.execution.profileId !== attempt.profileId ||
      reservation.execution.profileRevision !== attempt.profileRevision ||
      reservation.execution.replacementForExecutionId !== prior.id ||
      canonicalJson(reservation.execution.assignment) !==
        canonicalJson(attempt.assignment)
    ) {
      this.markAttemptAttention(
        attempt,
        'developer_replacement_unavailable',
        'Replacement execution did not preserve frozen authority',
      );
      return mutationFailure(
        'developer_attempt.replace_execution',
        'Replacement execution did not preserve frozen authority',
        'developer_replacement_unavailable',
      );
    }

    let result: V2CommandResult = mutationFailure(
      'developer_attempt.replace_execution',
      'Developer replacement was not linked',
    );
    let event: DomainEvent | undefined;
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        const current = this.requireAttempt(attempt.id);
        if (
          current.projectId !== command.command.projectId ||
          current.revision !== command.command.expectedAttemptRevision ||
          current.lifecycle !== 'interrupted' ||
          current.controllingExecutionId !== prior.id ||
          current.workspace.revision !== attempt.workspace.revision
        ) {
          result = mutationFailure(
            'developer_attempt.replace_execution',
            'Developer attempt changed before replacement could be linked',
          );
          return;
        }
        const workspace =
          this.dependencies.developers.recordWorkspaceObservationInTransaction(
            {
              ...observation,
              revision: current.workspace.revision + 1,
              updatedAt: this.dependencies.now(),
            },
            current.workspace.revision,
          );
        const linked = this.dependencies.developers.linkExecutionInTransaction({
          attemptId: current.id,
          executionId: reservation.execution.id,
          expectedRevision: current.revision,
          updatedAt: this.dependencies.now(),
        });
        const authority =
          this.dependencies.planning.taskExecutionAuthorityInTransaction(
            current.projectId,
            current.taskId,
          );
        if (!authority)
          throw new Error('Task execution authority was not found');
        const active =
          this.dependencies.developers.transitionAttemptInTransaction(
            {
              ...linked,
              lifecycle: reservation.result.ok
                ? 'active'
                : 'attention_required',
              revision: linked.revision + 1,
              workspace,
              attention: reservation.result.ok
                ? null
                : {
                    code: 'developer_replacement_unavailable',
                    message: 'Replacement execution reservation failed',
                  },
              updatedAt: this.dependencies.now(),
              endedAt: reservation.result.ok ? null : this.dependencies.now(),
            },
            linked.revision,
          );
        result = reservation.result.ok
          ? {
              ok: true,
              commandType: 'developer_attempt.replace_execution',
              schemaVersion: 1,
              attempt: active,
              board: authority.board,
            }
          : mutationFailure(
              'developer_attempt.replace_execution',
              reservation.result.error.message,
              reservation.result.error.code,
            );
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: command.idempotencyKey,
          commandType: command.command.type,
          requestHash,
          result,
          createdAt: active.updatedAt,
        });
        event = this.dependencies.events.appendDomainInTransaction(
          current.projectId,
          {
            projectId: current.projectId,
            occurredAt: active.updatedAt,
            type: 'developer_attempt.changed',
            payload: {
              schemaVersion: 1,
              attempt: active,
              board: authority.board,
            },
          },
        );
      });
    } catch (error) {
      this.dependencies.barrier.trip(error, this.dependencies.now());
      throw error;
    }
    if (event) this.dependencies.publishDomain(event);
    if (
      result.ok &&
      result.commandType === 'developer_attempt.replace_execution' &&
      result.attempt.lifecycle === 'active' &&
      reservation.activationRequired
    ) {
      await this.dependencies.execution.activateReserved(
        reservation.execution.id,
      );
    }
    return result;
  }

  private hasExactCompletionCoverage(
    attempt: DeveloperAttempt,
    report: Extract<DeveloperReport, { disposition: 'completed' }>,
  ): boolean {
    const expectedCriteria = new Set(
      attempt.assignment.acceptanceCriteria.map((text, index) =>
        canonicalJson([index, text]),
      ),
    );
    const actualCriteria = report.criterionCoverage.map(({ index, text }) =>
      canonicalJson([index, text]),
    );
    const expectedRequirements = new Set(
      attempt.requirementRevisions.map(({ recordId, recordRevision }) =>
        canonicalJson([recordId, recordRevision]),
      ),
    );
    const actualRequirements = report.requirementCoverage.map(
      ({ recordId, recordRevision }) =>
        canonicalJson([recordId, recordRevision]),
    );
    return (
      actualCriteria.length === expectedCriteria.size &&
      actualRequirements.length === expectedRequirements.size &&
      actualCriteria.every(
        (value, index) =>
          report.criterionCoverage[index].passed && expectedCriteria.has(value),
      ) &&
      actualRequirements.every(
        (value, index) =>
          report.requirementCoverage[index].passed &&
          expectedRequirements.has(value),
      ) &&
      new Set(actualCriteria).size === actualCriteria.length &&
      new Set(actualRequirements).size === actualRequirements.length &&
      report.verification.some(({ passed }) => passed)
    );
  }

  async drainPendingActivations(): Promise<void> {
    for (const attempt of this.dependencies.developers.nonterminalAttempts()) {
      if (attempt.lifecycle !== 'active' || !attempt.controllingExecutionId)
        continue;
      await this.dependencies.execution.activateReserved(
        attempt.controllingExecutionId,
      );
    }
  }

  async drainPendingStarts(attemptIds: readonly string[]): Promise<void> {
    for (const attemptId of attemptIds) {
      const reservation =
        this.dependencies.developers.startReservationForAttempt(attemptId);
      const attempt = this.dependencies.developers.attempt(attemptId);
      if (!reservation || !attempt) continue;
      const command: StartDeveloperAttemptEnvelope = {
        idempotencyKey: reservation.idempotencyKey,
        actor: { kind: 'human' },
        command: {
          type: 'developer_attempt.start',
          projectId: attempt.projectId,
          taskId: attempt.taskId,
          expectedTaskRevision: attempt.taskCurrentRevision,
          expectedDeliveryPlanId: attempt.deliveryPlanId,
          expectedDeliveryPlanRevision: attempt.deliveryPlanRevision,
          profileId: attempt.profileId,
          profileRevision: attempt.profileRevision,
        },
      };
      const requestHash = hashV2Command(command.command);
      const mismatch = this.startReservationMismatch(
        reservation,
        command,
        requestHash,
      );
      if (mismatch)
        throw new Error(
          mismatch.ok ? 'Unexpected start result' : mismatch.error.message,
        );
      await this.inStartOrder(reservation.idempotencyKey, () =>
        this.resumeStart(command, requestHash, attempt, reservation),
      );
    }
  }

  async drainPendingInterrupts(attemptIds: readonly string[]): Promise<void> {
    for (const attemptId of attemptIds) {
      const attempt = this.dependencies.developers.attempt(attemptId);
      if (
        !attempt ||
        attempt.lifecycle !== 'interrupted' ||
        !attempt.controllingExecutionId
      )
        continue;
      const authority = this.dependencies.planning.taskExecutionAuthority(
        attempt.projectId,
        attempt.taskId,
      );
      if (!authority) continue;
      await this.settleInterrupt(
        {
          idempotencyKey: `developer-attempt:${attempt.id}:interrupt:${attempt.revision}`,
          actor: { kind: 'human' },
          command: {
            type: 'developer_attempt.interrupt',
            projectId: attempt.projectId,
            attemptId: attempt.id,
            expectedAttemptRevision: attempt.revision,
          },
        },
        {
          ok: true,
          commandType: 'developer_attempt.interrupt',
          schemaVersion: 1,
          attempt,
          board: authority.board,
        },
      );
    }
  }

  private newAttempt(
    authority: TaskExecutionAuthority,
    envelope: StartDeveloperAttemptEnvelope,
    profile: ResolvedWorkerProfileSnapshot,
  ): DeveloperAttempt {
    const id = developerAttemptSchema.shape.id.parse(randomUUID());
    const createdAt = this.dependencies.now();
    const workspace = this.dependencies.workspace.derive({
      managedRoot: this.dependencies.managedWorkspaceRoot,
      projectId: authority.project.id,
      taskId: authority.task.id,
      attemptId: id,
      repositoryPath: authority.project.repositoryPath,
      repositoryIdentity: authority.project.repositoryIdentity,
      baseCommit: authority.project.headCommit,
      createdAt,
    });
    const ordinal =
      this.dependencies.developers
        .attemptsForProject(authority.project.id)
        .filter((attempt) => attempt.taskId === authority.task.id).length + 1;
    const assignment = {
      kind: 'developer_task' as const,
      projectId: authority.project.id,
      attemptId: id,
      taskId: authority.task.id,
      taskContractRevision: authority.task.contractRevision,
      taskCurrentRevision: authority.task.revision,
      deliveryPlanId: authority.deliveryPlan.plan.id,
      deliveryPlanRevision: authority.deliveryPlan.plan.revision,
      requirementRevisions: authority.requirementRevisions,
      baseCommit: authority.project.headCommit,
      workspacePath: workspace.path,
      title: authority.task.title,
      outcome: authority.task.outcome,
      acceptanceCriteria: authority.task.acceptanceCriteria,
      verification: authority.task.verificationCriteria,
      expectedArtifacts: authority.task.expectedArtifacts,
      outputSchema: DEVELOPER_REPORT_SCHEMA,
    };
    return developerAttemptSchema.parse({
      id,
      projectId: authority.project.id,
      taskId: authority.task.id,
      ordinal,
      lifecycle: 'reserved',
      revision: 0,
      deliveryPlanId: authority.deliveryPlan.plan.id,
      deliveryPlanRevision: authority.deliveryPlan.plan.revision,
      intentRevision: authority.intentRevision,
      ledgerRevision: authority.ledgerRevision,
      taskContractRevision: authority.task.contractRevision,
      taskCurrentRevision: authority.task.revision,
      requirementRevisions: authority.requirementRevisions,
      baseCommit: authority.project.headCommit,
      profileId: envelope.command.profileId,
      profileRevision: envelope.command.profileRevision,
      assignment,
      workspace,
      controllingExecutionId: null,
      executionIds: [],
      reportIds: [],
      attention: null,
      createdAt,
      updatedAt: createdAt,
      endedAt: null,
    });
  }

  private requireAttempt(id: string): DeveloperAttempt {
    const attempt = this.dependencies.developers.attempt(id);
    if (!attempt) throw new Error('Developer attempt was not found');
    return attempt;
  }

  private receiptMatches(runtimeEventId: string, digest: string): boolean {
    const prior = this.dependencies.developers.outputReceipt(runtimeEventId);
    if (prior && prior.outputDigest !== digest) {
      const error = new Error(
        'Developer output receipt conflicts with prior receipt',
      );
      this.dependencies.barrier.trip(error, this.dependencies.now());
      throw error;
    }
    return prior !== undefined;
  }

  private async inAttemptOrder<T>(
    attemptId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return this.inOrder(this.attemptTails, attemptId, operation);
  }

  private async inStartOrder<T>(
    idempotencyKey: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return this.inOrder(this.startTails, idempotencyKey, operation);
  }

  private async inOrder<T>(
    tails: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const prior = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = prior.catch(() => undefined).then(() => gate);
    tails.set(key, current);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
    }
  }

  private markAttemptAttention(
    expected: DeveloperAttempt,
    code: string,
    message: string,
    observedWorkspace?: ManagedWorkspace,
  ): void {
    let event: DomainEvent | undefined;
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        const current = this.requireAttempt(expected.id);
        if (
          current.revision !== expected.revision ||
          current.lifecycle !== expected.lifecycle ||
          current.controllingExecutionId !== expected.controllingExecutionId ||
          current.workspace.revision !== expected.workspace.revision
        ) {
          return;
        }
        const authority =
          this.dependencies.planning.taskExecutionAuthorityInTransaction(
            current.projectId,
            current.taskId,
          );
        if (!authority)
          throw new Error('Task execution authority was not found');
        const workspace = observedWorkspace
          ? this.dependencies.developers.recordWorkspaceObservationInTransaction(
              {
                ...observedWorkspace,
                revision: current.workspace.revision + 1,
                updatedAt: this.dependencies.now(),
              },
              current.workspace.revision,
            )
          : current.workspace;
        const next =
          this.dependencies.developers.transitionAttemptInTransaction(
            {
              ...current,
              lifecycle: 'attention_required',
              revision: current.revision + 1,
              workspace,
              attention: { code, message },
              updatedAt: this.dependencies.now(),
              endedAt: this.dependencies.now(),
            },
            current.revision,
          );
        event = this.dependencies.events.appendDomainInTransaction(
          current.projectId,
          {
            projectId: current.projectId,
            occurredAt: next.updatedAt,
            type: 'developer_attempt.changed',
            payload: {
              schemaVersion: 1,
              attempt: next,
              board: authority.board,
            },
          },
        );
      });
    } catch (error) {
      this.dependencies.barrier.trip(error, this.dependencies.now());
      return;
    }
    if (event) this.dependencies.publishDomain(event);
  }

  private markAttention(
    attemptId: string,
    launch: StartLaunchProjection,
    error: unknown,
    result: V2CommandResult,
    command: StartDeveloperAttemptEnvelope,
    requestHash: string,
  ): V2CommandResult {
    const message = error instanceof Error ? error.message : 'Launch failed';
    let event: DomainEvent | undefined;
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        const current = this.requireAttempt(attemptId);
        const workspace =
          current.workspace.lifecycle === 'attention_required'
            ? current.workspace
            : this.dependencies.developers.recordWorkspaceObservationInTransaction(
                {
                  ...current.workspace,
                  lifecycle: 'attention_required',
                  failure: { code: 'developer_attempt_start_failed', message },
                  revision: current.workspace.revision + 1,
                  updatedAt: this.dependencies.now(),
                },
                current.workspace.revision,
              );
        const next =
          current.lifecycle === 'attention_required'
            ? current
            : this.dependencies.developers.transitionAttemptInTransaction(
                {
                  ...this.requireAttempt(attemptId),
                  lifecycle: 'attention_required',
                  revision: current.revision + 1,
                  workspace,
                  attention: {
                    code: 'developer_attempt_start_failed',
                    message,
                  },
                  updatedAt: this.dependencies.now(),
                  endedAt: this.dependencies.now(),
                },
                current.revision,
              );
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: command.idempotencyKey,
          commandType: command.command.type,
          requestHash,
          result,
          createdAt: next.updatedAt,
        });
        if (next !== current) {
          event = this.dependencies.events.appendDomainInTransaction(
            launch.projectId,
            {
              projectId: launch.projectId,
              occurredAt: next.updatedAt,
              type: 'developer_attempt.changed',
              payload: {
                schemaVersion: 1,
                attempt: next,
                board: launch.board,
              },
            },
          );
        }
      });
    } catch (error) {
      this.dependencies.barrier.trip(error, this.dependencies.now());
      return failureFrom(error, 'audit_barrier_tripped');
    }
    if (event) this.dependencies.publishDomain(event);
    return result;
  }
}
