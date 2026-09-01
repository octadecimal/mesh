import { createHash, randomUUID } from 'node:crypto';

import {
  DEVELOPER_REPORT_SCHEMA,
  developerAttemptSchema,
  developerReportIdSchema,
  developerTaskAssignmentSchema,
  startDeveloperAttemptEnvelopeSchema,
  type DeveloperAttempt,
  type DeveloperReport,
  type DomainEvent,
  type ManagedWorkspace,
  type ResolvedWorkerProfileSnapshot,
  type V2Command,
  type V2CommandEnvelope,
  type V2CommandResult,
  type WorkerExecution,
  type WorkerExecutionStructuredOutputRuntimeEvent,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import type { ExecutionRuntime } from '../executions/execution-runtime.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import type {
  PlanningRepository,
  TaskExecutionAuthority,
} from '../planning/planning-repository.js';
import type { V2CommandRepository } from '../storage/command-repository.js';
import { hashV2Command } from '../storage/command-repository.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { V2EventStore } from '../storage/event-store.js';
import type { DeveloperRepository } from './developer-repository.js';
import type { DeriveManagedWorkspaceInput } from './managed-workspace.js';

export type { TaskExecutionAuthority } from '../planning/planning-repository.js';

export type StartDeveloperAttemptEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'developer_attempt.start' }>;
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
  execution: Pick<ExecutionRuntime, 'reserveStart' | 'activateReserved'>;
  workspace: {
    inspectProject(): Promise<{
      repositoryIdentity: string;
      headCommit: string;
    }>;
    derive(input: DeriveManagedWorkspaceInput): ManagedWorkspace;
    create(workspace: ManagedWorkspace): Promise<ManagedWorkspace>;
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
  authority?: TaskExecutionAuthority;
};

const failure = (message: string): V2CommandResult => ({
  ok: false,
  commandType: 'developer_attempt.start',
  error: { code: 'invalid_request', message },
});

const compatible = (profile: ResolvedWorkerProfileSnapshot) =>
  profile.document.spec.assignmentKinds.length === 1 &&
  profile.document.spec.assignmentKinds[0] === 'developer_task' &&
  profile.document.spec.outputSchema === DEVELOPER_REPORT_SCHEMA;

const outputDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export class DeveloperAttemptService {
  constructor(private readonly dependencies: Dependencies) {}

  acceptReport(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
    report: DeveloperReport | null,
  ): void {
    this.dependencies.barrier.assertHealthy();
    const assignment = developerTaskAssignmentSchema.safeParse(
      execution.assignment,
    );
    if (!assignment.success) return;
    const digest = outputDigest(event.payload.value);
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
        const attempt = this.dependencies.developers.attempt(
          assignment.data.attemptId,
        );
        if (!attempt) throw new Error('Developer attempt was not found');
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
          report.workspace.headCommit !== attempt.workspace.observedHead ||
          report.workspace.dirty !== attempt.workspace.observedDirty
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
    const replay = this.dependencies.commands.find(
      command.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;

    try {
      this.dependencies.barrier.assertHealthy();
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : 'Audit barrier tripped',
      );
    }
    if (this.dependencies.billingConflicts.length > 0) {
      return failure('Billing override is configured');
    }

    const authority = this.dependencies.planning.taskExecutionAuthority(
      command.command.projectId,
      command.command.taskId,
    );
    if (!authority) return failure('Task execution authority was not found');
    if (
      authority.deliveryPlan.plan.id !==
        command.command.expectedDeliveryPlanId ||
      authority.deliveryPlan.plan.revision !==
        command.command.expectedDeliveryPlanRevision ||
      authority.task.revision !== command.command.expectedTaskRevision
    ) {
      return failure('Task execution authority is stale');
    }
    if (authority.card.readiness.state !== 'actionable') {
      return failure('Task is not actionable');
    }
    if (
      this.dependencies.developers
        .nonterminalAttempts()
        .some((attempt) => attempt.taskId === authority.task.id)
    ) {
      return failure('Task already has a controlling Developer attempt');
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
      );
    }
    if (!compatible(profile))
      return failure('Profile is not a Developer profile');
    if (
      profile.projectId !== null &&
      profile.projectId !== authority.project.id
    ) {
      return failure('Profile is not available for this project');
    }

    let observedProject: { repositoryIdentity: string; headCommit: string };
    try {
      observedProject = await this.dependencies.workspace.inspectProject();
    } catch (error) {
      return failure(
        error instanceof Error
          ? error.message
          : 'Repository could not be observed',
      );
    }
    if (
      observedProject.repositoryIdentity !==
        authority.project.repositoryIdentity ||
      observedProject.headCommit !== authority.project.headCommit
    ) {
      return failure('Repository identity or HEAD changed');
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
        this.dependencies.barrier.assertHealthy();
        if (this.dependencies.billingConflicts.length > 0) {
          throw new Error('Billing override is configured');
        }
        const reservedAuthority =
          this.dependencies.planning.taskExecutionAuthority(
            command.command.projectId,
            command.command.taskId,
          );
        if (!reservedAuthority) {
          throw new Error('Task execution authority was not found');
        }
        if (
          reservedAuthority.deliveryPlan.plan.id !==
            command.command.expectedDeliveryPlanId ||
          reservedAuthority.deliveryPlan.plan.revision !==
            command.command.expectedDeliveryPlanRevision ||
          reservedAuthority.task.revision !==
            command.command.expectedTaskRevision
        ) {
          throw new Error('Task execution authority is stale');
        }
        if (reservedAuthority.card.readiness.state !== 'actionable') {
          throw new Error('Task is not actionable');
        }
        if (
          this.dependencies.developers
            .nonterminalAttempts()
            .some((attempt) => attempt.taskId === reservedAuthority.task.id)
        ) {
          throw new Error('Task already has a controlling Developer attempt');
        }
        if (
          !compatible(profile) ||
          (profile.projectId !== null &&
            profile.projectId !== reservedAuthority.project.id)
        ) {
          throw new Error('Profile is not available for this project');
        }
        if (
          observedProject.repositoryIdentity !==
            reservedAuthority.project.repositoryIdentity ||
          observedProject.headCommit !== reservedAuthority.project.headCommit
        ) {
          throw new Error('Repository identity or HEAD changed');
        }
        const attempt = this.newAttempt(reservedAuthority, command, profile);
        reservationWritesStarted = true;
        const reserved =
          this.dependencies.developers.reserveAttemptInTransaction(attempt);
        const result: V2CommandResult = {
          ok: true,
          commandType: 'developer_attempt.start',
          schemaVersion: 1,
          attempt: reserved,
          board: reservedAuthority.board,
        };
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: command.idempotencyKey,
          commandType: command.command.type,
          requestHash,
          result,
          createdAt: attempt.createdAt,
        });
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
          authority: reservedAuthority,
        };
      });
    } catch (error) {
      if (reservationWritesStarted) {
        this.dependencies.barrier.trip(error, this.dependencies.now());
      }
      return failure(
        error instanceof Error ? error.message : 'Attempt reservation failed',
      );
    }
    if (!started.attempt) return started.result;
    if (started.event) this.dependencies.publishDomain(started.event);
    const startedAuthority = started.authority!;

    try {
      const observation = await this.dependencies.workspace.create(
        started.attempt.workspace,
      );
      let provisioned: DeveloperAttempt;
      let workspaceEvent: DomainEvent;
      ({ provisioned, workspaceEvent } = inImmediateTransaction(
        this.dependencies.database,
        () => {
          const current = this.requireAttempt(started.attempt!.id);
          const workspace =
            this.dependencies.developers.recordWorkspaceObservationInTransaction(
              {
                ...observation,
                revision: current.workspace.revision + 1,
                updatedAt: this.dependencies.now(),
              },
              current.workspace.revision,
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
                ...this.requireAttempt(current.id),
                lifecycle:
                  workspace.lifecycle === 'ready'
                    ? 'provisioning'
                    : 'attention_required',
                revision: current.revision + 1,
                workspace,
                attention,
                updatedAt: this.dependencies.now(),
                endedAt:
                  workspace.lifecycle === 'ready'
                    ? null
                    : this.dependencies.now(),
              },
              current.revision,
            );
          const event = this.dependencies.events.appendDomainInTransaction(
            startedAuthority.project.id,
            {
              projectId: startedAuthority.project.id,
              occurredAt: next.updatedAt,
              type: 'developer_workspace.changed',
              payload: {
                schemaVersion: 1,
                attempt: next,
                board: startedAuthority.board,
              },
            },
          );
          return { provisioned: next, workspaceEvent: event };
        },
      ));
      this.dependencies.publishDomain(workspaceEvent);
      if (provisioned.workspace.lifecycle !== 'ready') return started.result;

      const execution = await this.dependencies.execution.reserveStart({
        idempotencyKey: `developer-attempt:${provisioned.id}:execution:1`,
        actor: command.actor,
        command: {
          type: 'worker_execution.start',
          projectId: startedAuthority.project.id,
          profileId: profile.profileId,
          profileRevision: profile.profileRevision,
          assignment: provisioned.assignment,
        },
      });
      if (!execution.result.ok) {
        inImmediateTransaction(this.dependencies.database, () => {
          this.dependencies.developers.linkExecutionInTransaction({
            attemptId: provisioned.id,
            executionId: execution.execution.id,
            expectedRevision: provisioned.revision,
            updatedAt: this.dependencies.now(),
          });
        });
        throw new Error('Developer execution reservation failed');
      }

      let active: DeveloperAttempt;
      let activeEvent: DomainEvent;
      ({ active, activeEvent } = inImmediateTransaction(
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
          const event = this.dependencies.events.appendDomainInTransaction(
            startedAuthority.project.id,
            {
              projectId: startedAuthority.project.id,
              occurredAt: next.updatedAt,
              type: 'developer_attempt.changed',
              payload: {
                schemaVersion: 1,
                attempt: next,
                board: startedAuthority.board,
              },
            },
          );
          return { active: next, activeEvent: event };
        },
      ));
      this.dependencies.publishDomain(activeEvent);
      if (execution.activationRequired) {
        await this.dependencies.execution.activateReserved(
          active.controllingExecutionId!,
        );
      }
      return started.result;
    } catch (error) {
      this.markAttention(started.attempt.id, startedAuthority, error);
      return started.result;
    }
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

  private markAttention(
    attemptId: string,
    authority: TaskExecutionAuthority,
    error: unknown,
  ): void {
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
        event = this.dependencies.events.appendDomainInTransaction(
          authority.project.id,
          {
            projectId: authority.project.id,
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
}
