import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  DEVELOPER_REPORT_SCHEMA,
  developerAttemptSchema,
  startDeveloperAttemptEnvelopeSchema,
  type DeveloperAttempt,
  type DomainEvent,
  type ManagedWorkspace,
  type ResolvedWorkerProfileSnapshot,
  type V2Command,
  type V2CommandEnvelope,
  type V2CommandResult,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import type { ExecutionRuntime } from '../executions/execution-runtime.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import type { PlanningRepository, TaskExecutionAuthority } from '../planning/planning-repository.js';
import type { V2CommandRepository } from '../storage/command-repository.js';
import { hashV2Command } from '../storage/command-repository.js';
import type { V2EventStore } from '../storage/event-store.js';
import type { DeveloperRepository } from './developer-repository.js';

export type { TaskExecutionAuthority } from '../planning/planning-repository.js';

export type StartDeveloperAttemptEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'developer_attempt.start' }>;
};

type Dependencies = {
  database: V2Database;
  planning: Pick<PlanningRepository, 'taskExecutionAuthority'>;
  developers: Pick<
    DeveloperRepository,
    | 'attempt'
    | 'attemptsForProject'
    | 'nonterminalAttempts'
    | 'reserveAttemptInTransaction'
    | 'recordWorkspaceObservationInTransaction'
    | 'linkExecutionInTransaction'
    | 'transitionAttemptInTransaction'
  >;
  profiles: {
    resolveApproved(
      profileId: string,
      revision: number,
    ): ResolvedWorkerProfileSnapshot;
  };
  commands: Pick<V2CommandRepository, 'find' | 'storeInTransaction'>;
  events: Pick<V2EventStore, 'appendDomainInTransaction'>;
  execution: Pick<
    ExecutionRuntime,
    'reserveStart' | 'activateReserved'
  >;
  workspace: {
    inspectProject(): Promise<{
      repositoryIdentity: string;
      headCommit: string;
    }>;
    create(workspace: ManagedWorkspace): Promise<{
      headCommit: string;
      dirty: boolean;
    }>;
  };
  barrier: Pick<AuditBarrier, 'assertHealthy' | 'trip'>;
  billingConflicts: readonly { variable: string }[];
  now(): string;
  publishDomain(event: DomainEvent): void;
};

type StartTransaction = {
  result: V2CommandResult;
  attempt?: DeveloperAttempt;
  event?: DomainEvent;
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

export class DeveloperAttemptService {
  constructor(private readonly dependencies: Dependencies) {}

  async start(envelope: StartDeveloperAttemptEnvelope): Promise<V2CommandResult> {
    let command: StartDeveloperAttemptEnvelope;
    try {
      command = startDeveloperAttemptEnvelopeSchema.parse(envelope);
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'Invalid request');
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
      return failure(error instanceof Error ? error.message : 'Audit barrier tripped');
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
      authority.deliveryPlan.plan.id !== command.command.expectedDeliveryPlanId ||
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
      return failure(error instanceof Error ? error.message : 'Profile was not found');
    }
    if (!compatible(profile)) return failure('Profile is not a Developer profile');

    let observedProject: { repositoryIdentity: string; headCommit: string };
    try {
      observedProject = await this.dependencies.workspace.inspectProject();
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : 'Repository could not be observed',
      );
    }
    if (
      observedProject.repositoryIdentity !== authority.project.repositoryIdentity ||
      observedProject.headCommit !== authority.project.headCommit
    ) {
      return failure('Repository identity or HEAD changed');
    }

    const attempt = this.newAttempt(authority, command, profile);
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
        reservationWritesStarted = true;
        const reserved = this.dependencies.developers.reserveAttemptInTransaction(
          attempt,
        );
        const result: V2CommandResult = {
          ok: true,
          commandType: 'developer_attempt.start',
          schemaVersion: 1,
          attempt: reserved,
          board: authority.board,
        };
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: command.idempotencyKey,
          commandType: command.command.type,
          requestHash,
          result,
          createdAt: attempt.createdAt,
        });
        const event = this.dependencies.events.appendDomainInTransaction(
          authority.project.id,
          {
            projectId: authority.project.id,
            occurredAt: attempt.createdAt,
            type: 'developer_attempt.changed',
            payload: { schemaVersion: 1, attempt: reserved, board: authority.board },
          },
        );
        return { result, attempt: reserved, event };
      });
    } catch (error) {
      if (reservationWritesStarted) {
        this.dependencies.barrier.trip(error, this.dependencies.now());
      }
      return failure(error instanceof Error ? error.message : 'Attempt reservation failed');
    }
    if (!started.attempt) return started.result;
    if (started.event) this.dependencies.publishDomain(started.event);

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
          const workspace = this.dependencies.developers.recordWorkspaceObservationInTransaction(
            {
              ...current.workspace,
              lifecycle: 'ready',
              observedHead: observation.headCommit,
              observedDirty: observation.dirty,
              revision: current.workspace.revision + 1,
              updatedAt: this.dependencies.now(),
            },
            current.workspace.revision,
          );
          const next = this.dependencies.developers.transitionAttemptInTransaction(
            {
              ...this.requireAttempt(current.id),
              lifecycle: 'provisioning',
              revision: current.revision + 1,
              workspace,
              updatedAt: this.dependencies.now(),
            },
            current.revision,
          );
          const event = this.dependencies.events.appendDomainInTransaction(
            authority.project.id,
            {
              projectId: authority.project.id,
              occurredAt: next.updatedAt,
              type: 'developer_workspace.changed',
              payload: { schemaVersion: 1, attempt: next, board: authority.board },
            },
          );
          return { provisioned: next, workspaceEvent: event };
        },
      ));
      this.dependencies.publishDomain(workspaceEvent);

      const execution = await this.dependencies.execution.reserveStart({
        idempotencyKey: `developer-attempt:${provisioned.id}:execution:1`,
        actor: command.actor,
        command: {
          type: 'worker_execution.start',
          projectId: authority.project.id,
          profileId: profile.profileId,
          profileRevision: profile.profileRevision,
          assignment: provisioned.assignment,
        },
      });
      if (!execution.result.ok) {
        throw new Error('Developer execution reservation failed');
      }

      let active: DeveloperAttempt;
      let activeEvent: DomainEvent;
      ({ active, activeEvent } = inImmediateTransaction(this.dependencies.database, () => {
        const linked = this.dependencies.developers.linkExecutionInTransaction({
          attemptId: provisioned.id,
          executionId: execution.execution.id,
          expectedRevision: provisioned.revision,
          updatedAt: this.dependencies.now(),
        });
        const next = this.dependencies.developers.transitionAttemptInTransaction(
          {
            ...linked,
            lifecycle: 'active',
            revision: linked.revision + 1,
            updatedAt: this.dependencies.now(),
          },
          linked.revision,
        );
        const event = this.dependencies.events.appendDomainInTransaction(
          authority.project.id,
          {
            projectId: authority.project.id,
            occurredAt: next.updatedAt,
            type: 'developer_attempt.changed',
            payload: { schemaVersion: 1, attempt: next, board: authority.board },
          },
        );
        return { active: next, activeEvent: event };
      }));
      this.dependencies.publishDomain(activeEvent);
      if (execution.activationRequired) {
        await this.dependencies.execution.activateReserved(active.controllingExecutionId!);
      }
      return started.result;
    } catch (error) {
      this.markAttention(started.attempt.id, authority, error);
      return started.result;
    }
  }

  private newAttempt(
    authority: TaskExecutionAuthority,
    envelope: StartDeveloperAttemptEnvelope,
    profile: ResolvedWorkerProfileSnapshot,
  ): DeveloperAttempt {
    const id = randomUUID();
    const createdAt = this.dependencies.now();
    const workspacePath = join(
      authority.project.repositoryPath,
      '.mesh',
      'developer-attempts',
      id,
    );
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
      workspacePath,
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
      workspace: {
        attemptId: id,
        repositoryPath: authority.project.repositoryPath,
        repositoryIdentity: authority.project.repositoryIdentity,
        branch: `mesh/developer/${id}`,
        path: workspacePath,
        baseCommit: authority.project.headCommit,
        lifecycle: 'reserved',
        ownershipToken: randomUUID(),
        observedHead: null,
        observedDirty: null,
        failure: null,
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      },
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
                  attention: { code: 'developer_attempt_start_failed', message },
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
            payload: { schemaVersion: 1, attempt: next, board: authority.board },
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
