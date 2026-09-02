import { randomUUID } from 'node:crypto';

import {
  DEVELOPER_REPORT_SCHEMA,
  executionRunIdSchema,
  executionRunItemIdSchema,
  executionRunViewSchema,
  pauseExecutionRunEnvelopeSchema,
  resumeExecutionRunEnvelopeSchema,
  startExecutionRunEnvelopeSchema,
  stopExecutionRunEnvelopeSchema,
  v2CommandResultSchema,
  type DeveloperAttempt,
  type DomainEvent,
  type ExecutionRunCounts,
  type ExecutionRunItem,
  type ExecutionRunView,
  type PauseExecutionRunEnvelope,
  type Project,
  type ResolvedWorkerProfileSnapshot,
  type ResumeExecutionRunEnvelope,
  type StartExecutionRunEnvelope,
  type StopExecutionRunEnvelope,
  type V2CommandResult,
  type V2ErrorCode,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import type { TaskExecutionAuthority } from '../planning/planning-repository.js';
import type { V2CommandRepository } from '../storage/command-repository.js';
import {
  hashV2Command,
  V2IdempotencyConflictError,
} from '../storage/command-repository.js';
import type { V2EventStore } from '../storage/event-store.js';
import type {
  DeveloperAttemptService,
  InternalDeveloperStart,
} from '../developer/developer-attempt-service.js';
import type { ExecutionRunRepository } from './execution-run-repository.js';

type RunEnvelope =
  | StartExecutionRunEnvelope
  | PauseExecutionRunEnvelope
  | ResumeExecutionRunEnvelope
  | StopExecutionRunEnvelope;

type Dependencies = {
  database: V2Database;
  runs: Pick<
    ExecutionRunRepository,
    | 'view'
    | 'listForProject'
    | 'nonterminal'
    | 'createInTransaction'
    | 'replaceInTransaction'
  >;
  commands: Pick<V2CommandRepository, 'find' | 'storeInTransaction'>;
  events: Pick<V2EventStore, 'appendDomainInTransaction'>;
  projects: { get(projectId: string): Project | undefined };
  planning: {
    taskExecutionAuthority(
      projectId: string,
      taskId: string,
    ): TaskExecutionAuthority | undefined;
    taskExecutionAuthorityUnfiltered(
      projectId: string,
      taskId: string,
    ): TaskExecutionAuthority | undefined;
  };
  profiles: {
    resolveApproved(
      profileId: string,
      revision: number,
    ): ResolvedWorkerProfileSnapshot;
  };
  developer: Pick<DeveloperAttemptService, 'startFromRun'> & {
    attempt(attemptId: string): DeveloperAttempt | undefined;
  };
  inspectProject(repositoryPath: string): Promise<{
    repositoryIdentity: string;
    headCommit: string;
  }>;
  barrier: Pick<AuditBarrier, 'assertHealthy' | 'trip'>;
  billingConflicts: readonly { variable: string }[];
  now(): string;
  publishDomain(event: DomainEvent): void;
};

const compatible = (profile: ResolvedWorkerProfileSnapshot) =>
  profile.document.spec.assignmentKinds.length === 1 &&
  profile.document.spec.assignmentKinds[0] === 'developer_task' &&
  profile.document.spec.outputSchema === DEVELOPER_REPORT_SCHEMA;

const countsFor = (items: readonly ExecutionRunItem[]): ExecutionRunCounts => ({
  waiting: items.filter(({ lifecycle }) => lifecycle === 'waiting').length,
  launchPending: items.filter(({ lifecycle }) => lifecycle === 'launch_pending')
    .length,
  active: items.filter(({ lifecycle }) => lifecycle === 'active').length,
  completed: items.filter(({ lifecycle }) => lifecycle === 'completed').length,
  attentionRequired: items.filter(
    ({ lifecycle }) => lifecycle === 'attention_required',
  ).length,
  notStarted: items.filter(({ lifecycle }) => lifecycle === 'not_started')
    .length,
});

const commandFailure = (
  commandType: RunEnvelope['command']['type'],
  message: string,
  code: V2ErrorCode,
): V2CommandResult => ({ ok: false, commandType, error: { code, message } });

const commandSuccess = (
  commandType: RunEnvelope['command']['type'],
  view: ExecutionRunView,
): V2CommandResult =>
  v2CommandResultSchema.parse({
    ok: true,
    commandType,
    schemaVersion: 1,
    run: view.run,
    items: view.items,
  });

const terminalAttempt = (attempt: DeveloperAttempt) => {
  if (attempt.lifecycle === 'completed') return 'completed' as const;
  if (
    ['blocked', 'interrupted', 'attention_required'].includes(attempt.lifecycle)
  )
    return 'attention_required' as const;
  return undefined;
};

export class ExecutionRunService {
  private readonly projectTails = new Map<string, Promise<void>>();
  private launchesEnabled = true;

  constructor(private readonly dependencies: Dependencies) {}

  async start(envelope: StartExecutionRunEnvelope): Promise<V2CommandResult> {
    let input: StartExecutionRunEnvelope;
    try {
      input = startExecutionRunEnvelopeSchema.parse(envelope);
    } catch (error) {
      return commandFailure(
        'execution_run.start',
        error instanceof Error ? error.message : 'Invalid execution run',
        'invalid_request',
      );
    }
    return this.inProjectOrder(input.command.projectId, async () => {
      const requestHash = hashV2Command(input.command);
      const replay = this.replay(input, requestHash);
      if (replay) return replay;
      const auditFailure = this.auditFailure(input.command.type);
      if (auditFailure) return auditFailure;
      const validated = await this.validateStart(input);
      const postValidationAuditFailure = this.auditFailure(input.command.type);
      if (postValidationAuditFailure) return postValidationAuditFailure;
      if ('failure' in validated) {
        return this.storeFailure(input, requestHash, validated.failure);
      }
      const createdAt = this.dependencies.now();
      const runId = executionRunIdSchema.parse(randomUUID());
      const items: ExecutionRunItem[] = validated.authorities.map(
        ({ authority, profile }, ordinal) => {
          const id = executionRunItemIdSchema.parse(randomUUID());
          return {
            id,
            runId,
            projectId: input.command.projectId,
            taskId: authority.task.id,
            ordinal,
            revision: 1,
            lifecycle: 'waiting',
            taskContractRevision: authority.task.contractRevision,
            taskCurrentRevision: authority.task.revision,
            requirementRevisions: authority.requirementRevisions,
            prerequisiteTaskIds: authority.card.dependencies
              .filter(
                (dependency) =>
                  dependency.direction === 'prerequisite' &&
                  dependency.otherTaskLifecycle === 'pending',
              )
              .map(({ otherTaskId }) => otherTaskId),
            profileSnapshot: profile,
            launchIdempotencyKey: `execution-run:${runId}:item:${id}`,
            developerAttemptId: null,
            attention: null,
            createdAt,
            updatedAt: createdAt,
            endedAt: null,
          };
        },
      );
      const view = executionRunViewSchema.parse({
        run: {
          id: runId,
          projectId: input.command.projectId,
          revision: 1,
          lifecycle: 'running',
          completionReason: null,
          deliveryPlanId: input.command.expectedDeliveryPlanId,
          deliveryPlanRevision: input.command.expectedDeliveryPlanRevision,
          intentRevision: validated.authorities[0].authority.intentRevision,
          ledgerRevision: validated.authorities[0].authority.ledgerRevision,
          repositoryIdentity: validated.project.repositoryIdentity,
          baseCommit: validated.project.headCommit,
          concurrencyLimit: input.command.concurrencyLimit,
          subscriptionCapacityConfirmed: true,
          attention: null,
          itemIds: items.map(({ id }) => id),
          counts: countsFor(items),
          createdAt,
          updatedAt: createdAt,
          endedAt: null,
        },
        items,
      });
      const result = commandSuccess(input.command.type, view);
      let event: DomainEvent;
      try {
        this.dependencies.barrier.assertHealthy();
        event = inImmediateTransaction(this.dependencies.database, () => {
          this.dependencies.runs.createInTransaction(view);
          this.dependencies.commands.storeInTransaction({
            idempotencyKey: input.idempotencyKey,
            commandType: input.command.type,
            requestHash,
            result,
            createdAt,
          });
          return this.appendEvent(view);
        });
      } catch (error) {
        this.dependencies.barrier.trip(error, this.dependencies.now());
        return commandFailure(
          input.command.type,
          error instanceof Error ? error.message : 'Run persistence failed',
          'audit_barrier_tripped',
        );
      }
      this.dependencies.publishDomain(event);
      await this.drainLocked(view.run.id);
      return result;
    });
  }

  async pause(envelope: PauseExecutionRunEnvelope): Promise<V2CommandResult> {
    const parsed = pauseExecutionRunEnvelopeSchema.safeParse(envelope);
    if (!parsed.success)
      return commandFailure(
        'execution_run.pause',
        parsed.error.message,
        'invalid_request',
      );
    return this.control(parsed.data, 'paused');
  }

  async resume(envelope: ResumeExecutionRunEnvelope): Promise<V2CommandResult> {
    const parsed = resumeExecutionRunEnvelopeSchema.safeParse(envelope);
    if (!parsed.success)
      return commandFailure(
        'execution_run.resume',
        parsed.error.message,
        'invalid_request',
      );
    return this.control(parsed.data, 'running');
  }

  async stop(envelope: StopExecutionRunEnvelope): Promise<V2CommandResult> {
    const parsed = stopExecutionRunEnvelopeSchema.safeParse(envelope);
    if (!parsed.success)
      return commandFailure(
        'execution_run.stop',
        parsed.error.message,
        'invalid_request',
      );
    return this.control(parsed.data, 'stopping');
  }

  async developerAttemptChanged(attemptId: string): Promise<void> {
    const match = this.dependencies.runs
      .nonterminal()
      .find(({ items }) =>
        items.some((item) => item.developerAttemptId === attemptId),
      );
    if (!match) return;
    await this.inProjectOrder(match.run.projectId, async () => {
      await this.settleAttemptLocked(match.run.id, attemptId);
      const current = this.dependencies.runs.view(match.run.id);
      if (this.launchesEnabled && current?.run.lifecycle === 'running') {
        await this.drainLocked(match.run.id);
      }
    });
  }

  async reconcile(): Promise<void> {
    for (const snapshot of this.dependencies.runs.nonterminal()) {
      await this.inProjectOrder(snapshot.run.projectId, async () => {
        let current = this.dependencies.runs.view(snapshot.run.id);
        if (!current) return;
        for (const item of current.items) {
          if (item.lifecycle === 'active' && item.developerAttemptId) {
            await this.settleAttemptLocked(
              current.run.id,
              item.developerAttemptId,
            );
          } else if (item.lifecycle === 'launch_pending') {
            try {
              await this.launchReserved(item.id);
            } catch (error) {
              await this.pauseForAmbiguity(
                current.run.id,
                error instanceof Error ? error.message : 'Launch is ambiguous',
              );
            }
          }
          current = this.dependencies.runs.view(snapshot.run.id);
          if (!current || current.run.lifecycle === 'completed') return;
        }
        await this.finalizeIfDone(current.run.id);
        current = this.dependencies.runs.view(snapshot.run.id);
        if (current?.run.lifecycle === 'running') {
          await this.drainLocked(current.run.id);
        }
      });
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.projectTails.values());
  }

  async quiesce(): Promise<void> {
    this.launchesEnabled = false;
    await this.drain();
  }

  private async validateStart(input: StartExecutionRunEnvelope): Promise<
    | {
        project: Project;
        authorities: Array<{
          authority: TaskExecutionAuthority;
          profile: ResolvedWorkerProfileSnapshot;
        }>;
      }
    | { failure: V2CommandResult }
  > {
    if (this.dependencies.billingConflicts.length > 0) {
      return {
        failure: commandFailure(
          input.command.type,
          'Billing override is configured',
          'execution_run_conflict',
        ),
      };
    }
    if (
      this.dependencies.runs
        .listForProject(input.command.projectId)
        .some(({ run }) => run.lifecycle !== 'completed')
    ) {
      return {
        failure: commandFailure(
          input.command.type,
          'Project already has a nonterminal execution run',
          'execution_run_conflict',
        ),
      };
    }
    const project = this.dependencies.projects.get(input.command.projectId);
    if (!project) {
      return {
        failure: commandFailure(
          input.command.type,
          'Project was not found',
          'project_not_found',
        ),
      };
    }
    let observed: { repositoryIdentity: string; headCommit: string };
    try {
      observed = await this.dependencies.inspectProject(project.repositoryPath);
    } catch (error) {
      return {
        failure: commandFailure(
          input.command.type,
          error instanceof Error ? error.message : 'Repository check failed',
          'execution_run_conflict',
        ),
      };
    }
    if (
      observed.repositoryIdentity !== project.repositoryIdentity ||
      observed.headCommit !== project.headCommit
    ) {
      return {
        failure: commandFailure(
          input.command.type,
          'Repository identity or base commit changed',
          'execution_run_conflict',
        ),
      };
    }
    const selected = new Set(
      input.command.selections.map(({ taskId }) => taskId),
    );
    const authorities: Array<{
      authority: TaskExecutionAuthority;
      profile: ResolvedWorkerProfileSnapshot;
    }> = [];
    for (const selection of input.command.selections) {
      const authority = this.dependencies.planning.taskExecutionAuthority(
        input.command.projectId,
        selection.taskId,
      );
      if (
        !authority ||
        authority.deliveryPlan.plan.id !==
          input.command.expectedDeliveryPlanId ||
        authority.deliveryPlan.plan.revision !==
          input.command.expectedDeliveryPlanRevision ||
        authority.task.revision !== selection.expectedTaskRevision ||
        authority.task.lifecycle !== 'pending' ||
        authority.board.filter?.revision !==
          input.command.expectedBoardFilterRevision
      ) {
        return {
          failure: commandFailure(
            input.command.type,
            'Execution run selection is stale',
            'execution_run_selection_stale',
          ),
        };
      }
      const missing = authority.card.dependencies.find(
        (dependency) =>
          dependency.direction === 'prerequisite' &&
          dependency.otherTaskLifecycle === 'pending' &&
          !selected.has(dependency.otherTaskId),
      );
      if (missing) {
        return {
          failure: commandFailure(
            input.command.type,
            `Selection is missing prerequisite ${missing.otherTaskId}`,
            'execution_run_dependency_not_closed',
          ),
        };
      }
      let profile: ResolvedWorkerProfileSnapshot;
      try {
        profile = this.dependencies.profiles.resolveApproved(
          selection.profileId,
          selection.profileRevision,
        );
      } catch (error) {
        return {
          failure: commandFailure(
            input.command.type,
            error instanceof Error ? error.message : 'Profile was not found',
            'execution_run_profile_incompatible',
          ),
        };
      }
      if (
        !compatible(profile) ||
        (profile.projectId !== null && profile.projectId !== project.id)
      ) {
        return {
          failure: commandFailure(
            input.command.type,
            'Profile is not a compatible Developer profile',
            'execution_run_profile_incompatible',
          ),
        };
      }
      authorities.push({ authority, profile });
    }
    const order = new Map(
      authorities[0].authority.deliveryPlan.taskContracts.map((task, index) => [
        task.id,
        index,
      ]),
    );
    authorities.sort(
      (left, right) =>
        (order.get(left.authority.task.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.authority.task.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.authority.task.id.localeCompare(right.authority.task.id),
    );
    return { project, authorities };
  }

  private async control(
    input:
      | PauseExecutionRunEnvelope
      | ResumeExecutionRunEnvelope
      | StopExecutionRunEnvelope,
    target: 'paused' | 'running' | 'stopping',
  ): Promise<V2CommandResult> {
    return this.inProjectOrder(input.command.projectId, async () => {
      const requestHash = hashV2Command(input.command);
      const replay = this.replay(input, requestHash);
      if (replay) return replay;
      const auditFailure = this.auditFailure(input.command.type);
      if (auditFailure) return auditFailure;
      let current = this.dependencies.runs.view(input.command.runId);
      if (!current || current.run.projectId !== input.command.projectId) {
        return this.storeFailure(
          input,
          requestHash,
          commandFailure(
            input.command.type,
            'Execution run was not found',
            'execution_run_not_found',
          ),
        );
      }
      if (current.run.revision !== input.command.expectedRunRevision) {
        return this.storeFailure(
          input,
          requestHash,
          commandFailure(
            input.command.type,
            'Execution run revision changed',
            'execution_run_revision_conflict',
          ),
        );
      }
      if (
        (target === 'paused' && current.run.lifecycle !== 'running') ||
        (target === 'running' && current.run.lifecycle !== 'paused') ||
        (target === 'stopping' &&
          !['running', 'paused'].includes(current.run.lifecycle))
      ) {
        return this.storeFailure(
          input,
          requestHash,
          commandFailure(
            input.command.type,
            'Execution run transition is not allowed',
            'execution_run_conflict',
          ),
        );
      }
      if (target === 'running') {
        const failure = await this.validateResume(current);
        const postValidationAuditFailure = this.auditFailure(
          input.command.type,
        );
        if (postValidationAuditFailure) return postValidationAuditFailure;
        if (failure) return this.storeFailure(input, requestHash, failure);
      }
      const timestamp = this.dependencies.now();
      const items =
        target === 'stopping'
          ? current.items.map((item) =>
              item.lifecycle === 'waiting'
                ? {
                    ...item,
                    lifecycle: 'not_started' as const,
                    revision: item.revision + 1,
                    updatedAt: timestamp,
                    endedAt: timestamp,
                  }
                : item,
            )
          : current.items;
      const counts = countsFor(items);
      const immediatelyStopped =
        target === 'stopping' &&
        counts.launchPending === 0 &&
        counts.active === 0;
      const next = executionRunViewSchema.parse({
        run: {
          ...current.run,
          revision: current.run.revision + 1,
          lifecycle: immediatelyStopped ? 'completed' : target,
          completionReason: immediatelyStopped ? 'stopped' : null,
          attention: null,
          counts,
          updatedAt: timestamp,
          endedAt: immediatelyStopped ? timestamp : null,
        },
        items,
      });
      const result = commandSuccess(input.command.type, next);
      const persistenceAuditFailure = this.auditFailure(input.command.type);
      if (persistenceAuditFailure) return persistenceAuditFailure;
      const event = this.storeTransition(
        current,
        next,
        input,
        requestHash,
        result,
      );
      this.dependencies.publishDomain(event);
      current = next;
      if (target === 'running') await this.drainLocked(current.run.id);
      return result;
    });
  }

  private async validateResume(
    view: ExecutionRunView,
  ): Promise<V2CommandResult | undefined> {
    if (this.dependencies.billingConflicts.length > 0) {
      return commandFailure(
        'execution_run.resume',
        'Billing override is configured',
        'execution_run_conflict',
      );
    }
    const project = this.dependencies.projects.get(view.run.projectId);
    if (!project) {
      return commandFailure(
        'execution_run.resume',
        'Project was not found',
        'project_not_found',
      );
    }
    const observed = await this.dependencies.inspectProject(
      project.repositoryPath,
    );
    if (
      observed.repositoryIdentity !== view.run.repositoryIdentity ||
      observed.headCommit !== view.run.baseCommit
    ) {
      return commandFailure(
        'execution_run.resume',
        'Frozen repository base changed',
        'execution_run_conflict',
      );
    }
    for (const item of view.items.filter(
      ({ lifecycle }) => lifecycle === 'waiting',
    )) {
      try {
        const profile = this.dependencies.profiles.resolveApproved(
          item.profileSnapshot.profileId,
          item.profileSnapshot.profileRevision,
        );
        if (profile.digest !== item.profileSnapshot.digest) throw new Error();
      } catch {
        return commandFailure(
          'execution_run.resume',
          'Frozen Developer profile is no longer approved',
          'execution_run_profile_incompatible',
        );
      }
    }
    return undefined;
  }

  private auditFailure(
    commandType: RunEnvelope['command']['type'],
  ): V2CommandResult | undefined {
    try {
      this.dependencies.barrier.assertHealthy();
      return undefined;
    } catch (error) {
      return commandFailure(
        commandType,
        error instanceof Error ? error.message : 'Audit barrier tripped',
        'audit_barrier_tripped',
      );
    }
  }

  private async drainLocked(runId: string): Promise<void> {
    while (true) {
      if (!this.launchesEnabled) return;
      const current = this.dependencies.runs.view(runId);
      if (!current || current.run.lifecycle !== 'running') return;
      const impossible = current.items.find(
        (item) =>
          item.lifecycle === 'waiting' &&
          item.prerequisiteTaskIds.some((taskId) =>
            current.items.some(
              (other) =>
                other.taskId === taskId &&
                ['attention_required', 'not_started'].includes(other.lifecycle),
            ),
          ),
      );
      if (impossible) {
        await this.markItemAttention(
          current,
          impossible.id,
          'execution_run_item_conflict',
          'A frozen prerequisite did not complete',
        );
        continue;
      }
      const occupied =
        current.run.counts.launchPending + current.run.counts.active;
      if (occupied >= current.run.concurrencyLimit) return;
      const candidate = current.items.find(
        (item) =>
          item.lifecycle === 'waiting' &&
          item.prerequisiteTaskIds.every((taskId) =>
            current.items.some(
              (other) =>
                other.taskId === taskId && other.lifecycle === 'completed',
            ),
          ),
      );
      if (!candidate) {
        await this.finalizeIfDone(runId);
        return;
      }
      const authority =
        this.dependencies.planning.taskExecutionAuthorityUnfiltered(
          candidate.projectId,
          candidate.taskId,
        );
      if (
        !authority ||
        authority.task.revision !== candidate.taskCurrentRevision ||
        authority.deliveryPlan.plan.id !== current.run.deliveryPlanId ||
        authority.deliveryPlan.plan.revision !==
          current.run.deliveryPlanRevision
      ) {
        await this.markItemAttention(
          current,
          candidate.id,
          'execution_run_selection_stale',
          'Frozen task authority changed before launch',
        );
        continue;
      }
      if (authority.card.readiness.state !== 'actionable') {
        await this.markItemAttention(
          current,
          candidate.id,
          'developer_task_not_actionable',
          'M3 readiness no longer permits this task',
        );
        continue;
      }
      const timestamp = this.dependencies.now();
      const reserved = this.updateItem(current, candidate.id, {
        lifecycle: 'launch_pending',
        updatedAt: timestamp,
      });
      this.dependencies.publishDomain(this.storeTransition(current, reserved));
      await this.launchReserved(candidate.id);
    }
  }

  private async launchReserved(itemId: string): Promise<void> {
    const current = this.dependencies.runs
      .nonterminal()
      .find(({ items }) => items.some(({ id }) => id === itemId));
    const item = current?.items.find(({ id }) => id === itemId);
    if (!current || !item || item.lifecycle !== 'launch_pending') return;
    let result: V2CommandResult;
    try {
      result = await this.dependencies.developer.startFromRun({
        idempotencyKey: item.launchIdempotencyKey,
        command: {
          type: 'developer_attempt.start',
          projectId: item.projectId,
          taskId: item.taskId,
          expectedTaskRevision: item.taskCurrentRevision,
          expectedDeliveryPlanId: current.run.deliveryPlanId,
          expectedDeliveryPlanRevision: current.run.deliveryPlanRevision,
          profileId: item.profileSnapshot.profileId,
          profileRevision: item.profileSnapshot.profileRevision,
        },
      } satisfies InternalDeveloperStart);
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { code: 'execution_run_recovery_ambiguous' },
      );
    }
    const latest = this.dependencies.runs.view(current.run.id);
    if (!latest) return;
    if (!result.ok || result.commandType !== 'developer_attempt.start') {
      await this.markItemAttention(
        latest,
        item.id,
        result.ok ? 'execution_run_item_conflict' : result.error.code,
        result.ok
          ? 'Developer start returned the wrong result'
          : result.error.message,
      );
      return;
    }
    const attemptState = terminalAttempt(result.attempt);
    if (attemptState === 'attention_required') {
      await this.markItemAttention(
        latest,
        item.id,
        result.attempt.attention?.code ?? 'execution_run_item_conflict',
        result.attempt.attention?.message ??
          'Developer attempt requires attention',
        result.attempt.id,
      );
      return;
    }
    const timestamp = this.dependencies.now();
    const next = this.updateItem(latest, item.id, {
      lifecycle: attemptState ?? 'active',
      developerAttemptId: result.attempt.id,
      attention: null,
      updatedAt: timestamp,
      endedAt: attemptState === 'completed' ? timestamp : null,
    });
    this.dependencies.publishDomain(this.storeTransition(latest, next));
  }

  private async settleAttemptLocked(
    runId: string,
    attemptId: string,
  ): Promise<void> {
    const current = this.dependencies.runs.view(runId);
    const item = current?.items.find(
      (candidate) => candidate.developerAttemptId === attemptId,
    );
    if (!current || !item || item.lifecycle !== 'active') return;
    const attempt = this.dependencies.developer.attempt(attemptId);
    if (!attempt) {
      await this.pauseForAmbiguity(
        runId,
        'Linked Developer attempt is missing',
      );
      return;
    }
    const state = terminalAttempt(attempt);
    if (!state) return;
    if (state === 'attention_required') {
      await this.markItemAttention(
        current,
        item.id,
        attempt.attention?.code ?? 'execution_run_item_conflict',
        attempt.attention?.message ?? 'Developer attempt requires attention',
        attempt.id,
      );
    } else {
      const timestamp = this.dependencies.now();
      const next = this.updateItem(current, item.id, {
        lifecycle: 'completed',
        updatedAt: timestamp,
        endedAt: timestamp,
      });
      this.dependencies.publishDomain(this.storeTransition(current, next));
    }
    await this.finalizeIfDone(runId);
  }

  private async finalizeIfDone(runId: string): Promise<void> {
    const current = this.dependencies.runs.view(runId);
    if (!current || current.run.lifecycle === 'completed') return;
    const occupied =
      current.run.counts.launchPending + current.run.counts.active;
    const finished =
      current.run.lifecycle === 'running' &&
      occupied === 0 &&
      current.run.counts.waiting === 0;
    const stopped = current.run.lifecycle === 'stopping' && occupied === 0;
    if (!finished && !stopped) return;
    const timestamp = this.dependencies.now();
    const next = executionRunViewSchema.parse({
      run: {
        ...current.run,
        revision: current.run.revision + 1,
        lifecycle: 'completed',
        completionReason: stopped ? 'stopped' : 'finished',
        updatedAt: timestamp,
        endedAt: timestamp,
      },
      items: current.items,
    });
    this.dependencies.publishDomain(this.storeTransition(current, next));
  }

  private async markItemAttention(
    current: ExecutionRunView,
    itemId: string,
    code: string,
    message: string,
    developerAttemptId?: DeveloperAttempt['id'],
  ): Promise<void> {
    const timestamp = this.dependencies.now();
    const next = this.updateItem(current, itemId, {
      lifecycle: 'attention_required',
      ...(developerAttemptId === undefined ? {} : { developerAttemptId }),
      attention: { code, message },
      updatedAt: timestamp,
      endedAt: timestamp,
    });
    this.dependencies.publishDomain(this.storeTransition(current, next));
    await this.finalizeIfDone(current.run.id);
  }

  private async pauseForAmbiguity(
    runId: string,
    message: string,
  ): Promise<void> {
    const current = this.dependencies.runs.view(runId);
    if (!current || current.run.lifecycle === 'completed') return;
    const timestamp = this.dependencies.now();
    const next = executionRunViewSchema.parse({
      run: {
        ...current.run,
        revision: current.run.revision + 1,
        lifecycle: 'paused',
        attention: { code: 'execution_run_recovery_ambiguous', message },
        updatedAt: timestamp,
      },
      items: current.items,
    });
    this.dependencies.publishDomain(this.storeTransition(current, next));
  }

  private updateItem(
    current: ExecutionRunView,
    itemId: string,
    patch: Partial<ExecutionRunItem>,
  ): ExecutionRunView {
    const items = current.items.map((item) =>
      item.id === itemId
        ? { ...item, ...patch, revision: item.revision + 1 }
        : item,
    );
    return executionRunViewSchema.parse({
      run: {
        ...current.run,
        revision: current.run.revision + 1,
        counts: countsFor(items),
        updatedAt: this.dependencies.now(),
      },
      items,
    });
  }

  private appendEvent(view: ExecutionRunView): DomainEvent {
    return this.dependencies.events.appendDomainInTransaction(
      view.run.projectId,
      {
        projectId: view.run.projectId,
        occurredAt: view.run.updatedAt,
        type: 'execution_run.changed',
        payload: { schemaVersion: 1, run: view.run, items: view.items },
      },
    );
  }

  private storeTransition(
    current: ExecutionRunView,
    next: ExecutionRunView,
    command?: RunEnvelope,
    requestHash?: string,
    result?: V2CommandResult,
  ): DomainEvent {
    try {
      this.dependencies.barrier.assertHealthy();
      return inImmediateTransaction(this.dependencies.database, () => {
        this.dependencies.runs.replaceInTransaction(next, current.run.revision);
        if (command && requestHash && result) {
          this.dependencies.commands.storeInTransaction({
            idempotencyKey: command.idempotencyKey,
            commandType: command.command.type,
            requestHash,
            result,
            createdAt: next.run.updatedAt,
          });
        }
        return this.appendEvent(next);
      });
    } catch (error) {
      this.dependencies.barrier.trip(error, this.dependencies.now());
      throw error;
    }
  }

  private storeFailure(
    input: RunEnvelope,
    requestHash: string,
    result: V2CommandResult,
  ): V2CommandResult {
    const auditFailure = this.auditFailure(input.command.type);
    if (auditFailure) return auditFailure;
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: input.idempotencyKey,
          commandType: input.command.type,
          requestHash,
          result,
          createdAt: this.dependencies.now(),
        });
      });
      return result;
    } catch (error) {
      this.dependencies.barrier.trip(error, this.dependencies.now());
      return commandFailure(
        input.command.type,
        error instanceof Error ? error.message : 'Command persistence failed',
        'audit_barrier_tripped',
      );
    }
  }

  private replay(
    input: RunEnvelope,
    requestHash: string,
  ): V2CommandResult | undefined {
    try {
      const stored = this.dependencies.commands.find(
        input.idempotencyKey,
        requestHash,
      );
      if (!stored) return undefined;
      if (stored.commandType !== input.command.type) {
        throw new V2IdempotencyConflictError(input.idempotencyKey);
      }
      return stored.result;
    } catch (error) {
      return commandFailure(
        input.command.type,
        error instanceof Error ? error.message : 'Idempotency conflict',
        error instanceof V2IdempotencyConflictError
          ? 'idempotency_conflict'
          : 'audit_barrier_tripped',
      );
    }
  }

  private inProjectOrder<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.projectTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => tail);
    this.projectTails.set(projectId, chained);
    return previous.then(operation).finally(() => {
      release();
      if (this.projectTails.get(projectId) === chained) {
        this.projectTails.delete(projectId);
      }
    });
  }
}
