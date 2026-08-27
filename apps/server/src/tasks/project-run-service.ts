import { randomUUID } from 'node:crypto';

import {
  idSchema,
  taskActorSchema,
  type Project,
  type ProjectEvent,
  type ProjectRun,
  type ProjectRunItem,
  type StableTaskErrorCode,
  type Task,
  type TaskActor,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { ProjectRunRepository } from '../repositories/project-run-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import {
  AttemptAuditUnavailableError,
  AttemptReconciliationRequiredError,
  AttemptStartFailedError,
  type AttemptMutationResult,
  type ProjectRunAttemptLaunchInput,
} from './attempt-service.js';
import {
  planProjectRun,
  selectEligibleRunTasks,
} from './project-run-policy.js';
import {
  ProjectRunPreflightError,
  type ProjectRunPreflight,
} from './project-run-preflight.js';
import type { ProjectRunWorkspacePlanner } from './project-run-workspace.js';

const DEFAULT_MAX_CONCURRENCY = 4;

export type ProjectRunCommandOutcome = {
  run: ProjectRun;
  events: ProjectEvent[];
};

export type StartProjectRunInput = {
  projectId: string;
  concurrency: number;
  expectedPolicyRevision: number;
  expectedTasks: ReadonlyArray<{
    taskId: string;
    revision: number;
    automationStatus: Task['reviewAutomation']['status'];
    automationGeneration: number;
  }>;
  actor: TaskActor;
  idempotencyKey: string;
};

export type ChangeProjectRunInput = {
  runId: string;
  expectedRevision: number;
  actor: TaskActor;
  idempotencyKey: string;
};

type ProjectRunServiceDependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: TaskAttemptRepository;
  developerExecutions: Pick<DeveloperExecutionRepository, 'listByTask'>;
  projectRuns: ProjectRunRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  attemptService: {
    launchAttempt(
      input: ProjectRunAttemptLaunchInput,
    ): Promise<
      AttemptMutationResult | Pick<AttemptMutationResult, 'attempt' | 'session'>
    >;
  };
  preflight: ProjectRunPreflight;
  planWorkspace: ProjectRunWorkspacePlanner;
  publisher: { publishProject(event: ProjectEvent): void };
  canLaunch?: () => boolean;
  maxConcurrency?: number;
  onAuditFailure?: (error: unknown) => void;
  scheduleDrain?: (runId: string) => void;
  now?: () => string;
  createId?: () => string;
};

export class ProjectRunServiceError extends Error {
  constructor(
    readonly code: StableTaskErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProjectRunServiceError';
  }
}

export class ProjectRunService {
  private readonly maxConcurrency: number;
  private readonly launchingItemIds = new Set<string>();

  constructor(private readonly dependencies: ProjectRunServiceDependencies) {
    this.maxConcurrency =
      dependencies.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new TypeError('Project run maximum concurrency must be positive');
    }
  }

  async startRun(
    input: StartProjectRunInput,
  ): Promise<ProjectRunCommandOutcome> {
    const replay = this.getExistingOutcome(input.idempotencyKey);
    if (replay) return replay;
    this.requireHuman(input.actor);
    const preflightProject = this.requireActiveProject(input.projectId);
    this.requireConcurrency(input.concurrency);
    if (this.dependencies.projectRuns.getActiveByProject(preflightProject.id)) {
      throw new ProjectRunServiceError(
        'project_run_conflict',
        `Project '${preflightProject.id}' already has an active run`,
      );
    }
    await this.dependencies.preflight(preflightProject);
    return this.executeScheduled(input.idempotencyKey, () => {
      this.requireHuman(input.actor);
      const project = this.requireActiveProject(input.projectId);
      this.requireConcurrency(input.concurrency);
      const active = this.dependencies.projectRuns.getActiveByProject(
        project.id,
      );
      if (active) {
        throw new ProjectRunServiceError(
          'project_run_conflict',
          `Project '${project.id}' already has an active run`,
          { run: active },
        );
      }

      const tasks = this.dependencies.tasks.listByProject(project.id);
      const currentAttemptTaskIds = new Set(
        tasks
          .filter((task) =>
            this.dependencies.attempts
              .listByTask(task.id)
              .some(({ unlinkedAt }) => unlinkedAt === null),
          )
          .map(({ id }) => id),
      );
      const eligible = selectEligibleRunTasks({
        project,
        tasks,
        currentAttemptTaskIds,
      });
      const currentPolicyRevision = project.qaConfiguration.revision;
      const currentTasks = eligible.map(({ task }) => ({
        taskId: task.id,
        revision: task.revision,
        automationStatus: task.reviewAutomation.status,
        automationGeneration: task.reviewAutomation.generation,
      }));
      if (
        input.expectedPolicyRevision !== currentPolicyRevision ||
        input.expectedTasks.length !== currentTasks.length ||
        input.expectedTasks.some(
          (expected, index) =>
            expected.taskId !== currentTasks[index]?.taskId ||
            expected.revision !== currentTasks[index]?.revision ||
            expected.automationStatus !==
              currentTasks[index]?.automationStatus ||
            expected.automationGeneration !==
              currentTasks[index]?.automationGeneration,
        )
      ) {
        throw new ProjectRunServiceError(
          'project_run_stale',
          `Project '${project.id}' eligible tasks have changed`,
          {
            expectedPolicyRevision: input.expectedPolicyRevision,
            currentPolicyRevision,
            expectedTasks: input.expectedTasks,
            currentTasks,
          },
        );
      }
      if (eligible.length === 0) {
        throw new ProjectRunServiceError(
          'project_run_empty',
          `Project '${project.id}' has no eligible tasks`,
        );
      }

      const occurredAt = this.now();
      const runId = this.createId();
      const run = this.dependencies.projectRuns.create({
        id: runId,
        projectId: project.id,
        concurrency: input.concurrency,
        startedAt: occurredAt,
        items: eligible.map(
          (
            {
              task,
              policyRevision,
              taskAutomationStatus,
              taskAutomationGeneration,
            },
            queuePosition,
          ) => ({
            id: this.createId(),
            taskId: task.id,
            taskRevision: task.revision,
            policyRevision,
            taskAutomationStatus,
            taskAutomationGeneration,
            queuePosition,
            launchIdempotencyKey: `${runId}:${task.id}:launch`,
          }),
        ),
      });
      return this.outcome(run, occurredAt);
    });
  }

  pauseRun(input: ChangeProjectRunInput): ProjectRunCommandOutcome {
    return this.execute(input.idempotencyKey, () => {
      this.requireHuman(input.actor);
      const run = this.requireCurrentRun(input);
      this.requireState(run, ['running']);
      const changed = this.dependencies.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: run.revision,
        state: 'paused',
        pauseReason: 'operator_paused',
        occurredAt: this.now(),
      });
      if (!changed) this.throwStale(run.id);
      return this.outcome(changed, changed.updatedAt);
    });
  }

  async resumeRun(
    input: ChangeProjectRunInput,
  ): Promise<ProjectRunCommandOutcome> {
    const replay = this.getExistingOutcome(input.idempotencyKey);
    if (replay) return replay;
    this.requireHuman(input.actor);
    const preflightRun = this.requireCurrentRun(input);
    this.requireState(preflightRun, ['paused']);
    const project = this.requireActiveProject(preflightRun.projectId);
    try {
      await this.dependencies.preflight(project);
    } catch (error) {
      if (
        error instanceof ProjectRunPreflightError &&
        preflightRun.pauseReason !== error.reason
      ) {
        this.recordPreflightPause(preflightRun.id, error.reason);
      }
      throw error;
    }
    return this.executeScheduled(input.idempotencyKey, () => {
      this.requireHuman(input.actor);
      const run = this.requireCurrentRun(input);
      this.requireState(run, ['paused']);
      this.requireActiveProject(run.projectId);
      const changed = this.dependencies.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: run.revision,
        state: 'running',
        occurredAt: this.now(),
      });
      if (!changed) this.throwStale(run.id);
      return this.outcome(changed, changed.updatedAt);
    });
  }

  stopRun(input: ChangeProjectRunInput): ProjectRunCommandOutcome {
    return this.execute(input.idempotencyKey, () => {
      this.requireHuman(input.actor);
      let run = this.requireCurrentRun(input);
      this.requireState(run, ['running', 'paused']);
      const occurredAt = this.now();
      for (const item of run.items) {
        if (item.status !== 'queued') continue;
        run = this.dependencies.projectRuns.finishItem({
          runId: run.id,
          itemId: item.id,
          expectedRunRevision: run.revision,
          status: 'not_started',
          outcomeReason: 'stopped',
          occurredAt,
        });
      }
      const counts = this.dependencies.projectRuns.reconcileCounts(run.id);
      const occupied = counts.launchPending + counts.active;
      const changed = this.dependencies.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: run.revision,
        state: occupied === 0 ? 'completed' : 'draining',
        ...(occupied === 0 ? { completionReason: 'stopped' } : {}),
        occurredAt,
      });
      if (!changed) this.throwStale(run.id);
      return this.outcome(changed, occurredAt);
    });
  }

  async drainAvailableSlots(runId: string): Promise<ProjectRun> {
    const parsedRunId = idSchema.parse(runId);
    let preflighted = false;
    for (;;) {
      const run = this.dependencies.projectRuns.get(parsedRunId);
      if (!run) {
        throw new ProjectRunServiceError(
          'project_run_not_found',
          `Project run '${parsedRunId}' was not found`,
        );
      }
      if (!this.canLaunch()) return run;
      const plan = planProjectRun({ run });
      if (plan.type === 'wait') return run;
      if (plan.type === 'complete') return this.completeQueue(run);
      if (!preflighted) {
        const project = this.dependencies.projects.get(run.projectId);
        if (!project || project.archivedAt) {
          return this.recordPreflightPause(run.id, 'repository_unsafe');
        }
        try {
          await this.dependencies.preflight(project);
        } catch (error) {
          if (error instanceof ProjectRunPreflightError) {
            return this.recordPreflightPause(run.id, error.reason);
          }
          throw error;
        }
        preflighted = true;
        continue;
      }
      const claim = this.claimNext(run);
      if (!claim) continue;
      if (claim.item.id !== plan.itemId) continue;
      await this.launch(claim.run, claim.item);
    }
  }

  async observeTaskOutcome(taskId: string): Promise<void> {
    const task = this.dependencies.tasks.get(idSchema.parse(taskId));
    if (!task) return;
    const run = this.dependencies.projectRuns.getActiveByProject(
      task.projectId,
    );
    const item = run?.items.find((candidate) => candidate.taskId === task.id);
    if (!run || !item) return;

    if (
      item.status === 'completed' ||
      item.status === 'attention_required' ||
      item.status === 'not_started'
    ) {
      await this.continueAfterOutcome(run.id);
      return;
    }

    const project = this.dependencies.projects.get(task.projectId);
    if (!project || project.qaConfiguration.revision !== item.policyRevision) {
      this.pauseForAmbiguousLaunch(run.id);
      return;
    }

    const outcome = this.classifyTaskOutcome(project, task, item);
    if (!outcome) return;
    this.finishOutcome(run, item, outcome.status, outcome.reason);
    await this.continueAfterOutcome(run.id);
  }

  private async launch(run: ProjectRun, item: ProjectRunItem): Promise<void> {
    if (this.launchingItemIds.has(item.id)) return;
    this.launchingItemIds.add(item.id);
    try {
      await this.launchClaim(run, item);
    } finally {
      this.launchingItemIds.delete(item.id);
    }
  }

  private claimNext(
    run: ProjectRun,
  ): { run: ProjectRun; item: ProjectRunItem } | undefined {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const claim = this.dependencies.projectRuns.claimNext({
        runId: run.id,
        expectedRunRevision: run.revision,
        occurredAt: this.now(),
      });
      if (!claim) {
        this.dependencies.database.exec('COMMIT');
        return undefined;
      }
      const event = this.appendRunEvent(claim.run, claim.run.updatedAt);
      this.dependencies.database.exec('COMMIT');
      this.dependencies.publisher.publishProject(event);
      return claim;
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private async launchClaim(
    claimedRun: ProjectRun,
    claimedItem: ProjectRunItem,
  ): Promise<void> {
    const current = this.dependencies.projectRuns.get(claimedRun.id);
    const item = current?.items.find(({ id }) => id === claimedItem.id);
    if (!current || !item || item.status !== 'launch_pending') return;
    const task = this.dependencies.tasks.get(item.taskId);
    const project = task
      ? this.dependencies.projects.get(task.projectId)
      : undefined;
    if (!task || !project) {
      this.pauseForAmbiguousLaunch(current.id);
      return;
    }
    if (project.archivedAt) {
      this.finishClaim(current, item, 'project_archived');
      return;
    }
    if (
      project.qaConfiguration.revision !== item.policyRevision ||
      task.reviewAutomation.status !== item.taskAutomationStatus ||
      task.reviewAutomation.generation !== item.taskAutomationGeneration
    ) {
      this.finishClaim(current, item, 'authorization_stale');
      return;
    }

    try {
      const result = await this.dependencies.attemptService.launchAttempt({
        launchIdempotencyKey: item.launchIdempotencyKey,
        source: {
          type: 'project_run',
          runId: current.id,
          runItemId: item.id,
        },
        taskId: item.taskId,
        expectedRevision: item.taskRevision,
        title: task.title,
        permissionMode: 'safe_auto',
        workspace: this.dependencies.planWorkspace(project, current, item),
      });
      if (!result.session) {
        this.pauseForAmbiguousLaunch(current.id);
        return;
      }
      this.linkClaim(current.id, item.id, result.attempt.id, result.session.id);
    } catch (error) {
      if (
        error instanceof AttemptAuditUnavailableError ||
        error instanceof AttemptReconciliationRequiredError ||
        this.errorCode(error) === 'audit_unavailable' ||
        this.errorCode(error) === 'attempt_reconciliation_required'
      ) {
        try {
          this.dependencies.onAuditFailure?.(error);
        } catch {
          // Preserve the originating audit error for the tracked drain.
        }
        throw error;
      }
      const code = this.errorCode(error);
      if (this.isKnownItemFailure(error, code)) {
        const latest = this.dependencies.projectRuns.get(current.id);
        const latestItem = latest?.items.find(({ id }) => id === item.id);
        if (latest && latestItem?.status === 'launch_pending') {
          this.finishClaim(latest, latestItem, code ?? 'attempt_start_failed');
        }
        return;
      }
      this.pauseForAmbiguousLaunch(current.id);
    }
  }

  private linkClaim(
    runId: string,
    itemId: string,
    attemptId: string,
    sessionId: string,
  ): ProjectRun {
    return this.mutateRun(runId, (run) =>
      this.dependencies.projectRuns.linkLaunch({
        runId,
        itemId,
        expectedRunRevision: run.revision,
        attemptId,
        sessionId,
        occurredAt: this.now(),
      }),
    );
  }

  private finishClaim(
    run: ProjectRun,
    item: ProjectRunItem,
    reason: string,
  ): ProjectRun {
    return this.finishOutcome(run, item, 'attention_required', reason);
  }

  private finishOutcome(
    run: ProjectRun,
    item: ProjectRunItem,
    status: 'completed' | 'attention_required',
    reason: string,
  ): ProjectRun {
    return this.mutateRun(run.id, (current) =>
      this.dependencies.projectRuns.finishItem({
        runId: current.id,
        itemId: item.id,
        expectedRunRevision: current.revision,
        status,
        outcomeReason: reason,
        occurredAt: this.now(),
      }),
    );
  }

  private classifyTaskOutcome(
    project: Project,
    task: Task,
    item: ProjectRunItem,
  ):
    | { status: 'completed' | 'attention_required'; reason: string }
    | undefined {
    if (task.lifecycleState === 'done') {
      return { status: 'completed', reason: 'task_done' };
    }

    const repair = this.dependencies.projectEvents
      .after(task.projectId, 0)
      .filter(
        (event) =>
          event.type === 'task.attempt_repair_detected' &&
          event.payload.repair.taskId === task.id &&
          event.payload.repair.attemptId === item.attemptId &&
          event.payload.repair.reason !== 'startup_outcome_unknown',
      )
      .at(-1);
    if (repair?.type === 'task.attempt_repair_detected') {
      return {
        status: 'attention_required',
        reason: repair.payload.repair.reason,
      };
    }

    const blockedCycle = this.dependencies.developerExecutions
      .listByTask(task.id)
      .find(
        (cycle) =>
          cycle.attemptId === item.attemptId &&
          cycle.endedAt !== null &&
          cycle.terminalDisposition === 'blocked' &&
          cycle.blockerReportId !== null,
      );
    if (task.blocked && blockedCycle) {
      return { status: 'attention_required', reason: 'developer_blocked' };
    }

    if (task.lifecycleState !== 'review') return undefined;
    if (
      task.reviewAutomation.status === 'paused' &&
      task.reviewAutomation.rejectionCount >= 3
    ) {
      return {
        status: 'attention_required',
        reason: 'qa_rejection_ceiling',
      };
    }

    if (
      project.qaConfiguration.reviewPolicy === 'manual' ||
      task.reviewAutomation.status === 'disabled'
    ) {
      return { status: 'attention_required', reason: 'manual_review' };
    }
    if (task.reviewAutomation.status === 'paused') {
      return {
        status: 'attention_required',
        reason: 'review_automation_paused',
      };
    }
    return undefined;
  }

  private async continueAfterOutcome(runId: string): Promise<void> {
    const current = this.dependencies.projectRuns.get(runId);
    if (!current) return;
    if (current.state === 'running') {
      if (this.dependencies.scheduleDrain) {
        this.scheduleDrain(current.id);
        return;
      }
      await this.drainAvailableSlots(current.id);
      return;
    }
    if (current.state !== 'draining') return;
    const counts = this.dependencies.projectRuns.reconcileCounts(current.id);
    if (counts.launchPending + counts.active > 0) return;
    this.mutateRun(current.id, (run) => {
      const completed = this.dependencies.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: run.revision,
        state: 'completed',
        completionReason: 'stopped',
        occurredAt: this.now(),
      });
      if (!completed) this.throwStale(run.id);
      return completed;
    });
  }

  private pauseForAmbiguousLaunch(runId: string): ProjectRun {
    const current = this.dependencies.projectRuns.get(runId);
    if (!current || current.state !== 'running') {
      if (!current) {
        throw new ProjectRunServiceError(
          'project_run_not_found',
          `Project run '${runId}' was not found`,
        );
      }
      return current;
    }
    return this.mutateRun(runId, (run) => {
      const changed = this.dependencies.projectRuns.changeState({
        runId,
        expectedRunRevision: run.revision,
        state: 'paused',
        pauseReason: 'launch_outcome_unknown',
        occurredAt: this.now(),
      });
      if (!changed) this.throwStale(runId);
      return changed;
    });
  }

  private completeQueue(run: ProjectRun): ProjectRun {
    return this.mutateRun(run.id, (current) => {
      const changed = this.dependencies.projectRuns.changeState({
        runId: current.id,
        expectedRunRevision: current.revision,
        state: 'completed',
        completionReason: 'queue_finished',
        occurredAt: this.now(),
      });
      if (!changed) this.throwStale(current.id);
      return changed;
    });
  }

  private mutateRun(
    runId: string,
    mutate: (run: ProjectRun) => ProjectRun,
  ): ProjectRun {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.dependencies.projectRuns.get(runId);
      if (!current) {
        throw new ProjectRunServiceError(
          'project_run_not_found',
          `Project run '${runId}' was not found`,
        );
      }
      const run = mutate(current);
      const event = this.appendRunEvent(run, run.updatedAt);
      this.dependencies.database.exec('COMMIT');
      this.dependencies.publisher.publishProject(event);
      return run;
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private isKnownItemFailure(
    error: unknown,
    code: string | undefined,
  ): boolean {
    return (
      error instanceof AttemptStartFailedError ||
      code === 'attempt_start_failed' ||
      code === 'workspace_preserved' ||
      code === 'project_archived' ||
      code === 'task_revision_conflict' ||
      code === 'task_not_ready' ||
      code === 'task_blocked' ||
      code === 'task_transition_invalid' ||
      code === 'project_run_conflict'
    );
  }

  private errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined;
  }

  private execute(
    idempotencyKey: string,
    mutate: () => ProjectRunCommandOutcome,
  ): ProjectRunCommandOutcome {
    const commandId = idSchema.parse(idempotencyKey);
    const existing =
      this.dependencies.commands.getExisting<ProjectRunCommandOutcome>(
        commandId,
      );
    if (existing.found) return existing.response;
    const outcome =
      this.dependencies.commands.executeOnceInImmediateTransaction(
        commandId,
        mutate,
      );
    for (const event of outcome.events) {
      this.dependencies.publisher.publishProject(event);
    }
    return outcome;
  }

  private getExistingOutcome(
    idempotencyKey: string,
  ): ProjectRunCommandOutcome | undefined {
    const existing =
      this.dependencies.commands.getExisting<ProjectRunCommandOutcome>(
        idSchema.parse(idempotencyKey),
      );
    return existing.found ? existing.response : undefined;
  }

  private executeScheduled(
    idempotencyKey: string,
    mutate: () => ProjectRunCommandOutcome,
  ): ProjectRunCommandOutcome {
    let committed = false;
    const outcome = this.execute(idempotencyKey, () => {
      const result = mutate();
      committed = true;
      return result;
    });
    if (committed) this.scheduleDrain(outcome.run.id);
    return outcome;
  }

  private scheduleDrain(runId: string): void {
    try {
      this.dependencies.scheduleDrain?.(runId);
    } catch (error) {
      try {
        this.dependencies.onAuditFailure?.(error);
      } catch {
        // A post-commit callback cannot replace the committed command result.
      }
    }
  }

  private recordPreflightPause(
    runId: string,
    reason: 'billing_conflict' | 'repository_unsafe',
  ): ProjectRun {
    return this.mutateRun(runId, (run) => {
      if (run.state !== 'running' && run.state !== 'paused') return run;
      if (run.pauseReason === reason) return run;
      const changed = this.dependencies.projectRuns.changeState({
        runId,
        expectedRunRevision: run.revision,
        state: 'paused',
        pauseReason: reason,
        occurredAt: this.now(),
      });
      if (!changed) this.throwStale(runId);
      return changed;
    });
  }

  private requireHuman(actor: TaskActor): void {
    const parsed = taskActorSchema.parse(actor);
    if (parsed.type !== 'human') {
      throw new ProjectRunServiceError(
        'project_run_invalid',
        'Project runs require a human operator',
      );
    }
  }

  private requireConcurrency(concurrency: number): void {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new ProjectRunServiceError(
        'project_run_invalid',
        'Project run concurrency must be a positive integer',
      );
    }
    if (concurrency > this.maxConcurrency) {
      throw new ProjectRunServiceError(
        'project_run_concurrency_exceeded',
        `Project run concurrency cannot exceed ${this.maxConcurrency}`,
        { maxConcurrency: this.maxConcurrency },
      );
    }
  }

  private requireActiveProject(projectId: string): Project {
    const parsedId = idSchema.parse(projectId);
    const project = this.dependencies.projects.get(parsedId);
    if (!project) {
      throw new ProjectRunServiceError(
        'project_not_found',
        `Project '${parsedId}' was not found`,
      );
    }
    if (project.archivedAt) {
      throw new ProjectRunServiceError(
        'project_archived',
        `Project '${parsedId}' is archived`,
        { project },
      );
    }
    return project;
  }

  private requireCurrentRun(input: ChangeProjectRunInput): ProjectRun {
    const runId = idSchema.parse(input.runId);
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      throw new ProjectRunServiceError(
        'project_run_invalid',
        'Expected project run revision must be a positive integer',
      );
    }
    const run = this.dependencies.projectRuns.get(runId);
    if (!run) {
      throw new ProjectRunServiceError(
        'project_run_not_found',
        `Project run '${runId}' was not found`,
      );
    }
    if (run.revision !== input.expectedRevision) this.throwStale(runId, run);
    return run;
  }

  private requireState(
    run: ProjectRun,
    allowed: readonly ProjectRun['state'][],
  ): void {
    if (!allowed.includes(run.state)) {
      throw new ProjectRunServiceError(
        'project_run_not_controllable',
        `Project run '${run.id}' cannot be controlled from '${run.state}'`,
        { run },
      );
    }
  }

  private throwStale(runId: string, run?: ProjectRun): never {
    throw new ProjectRunServiceError(
      'project_run_stale',
      `Project run '${runId}' has changed`,
      { run: run ?? this.dependencies.projectRuns.get(runId) },
    );
  }

  private outcome(
    run: ProjectRun,
    occurredAt: string,
  ): ProjectRunCommandOutcome {
    const event = this.appendRunEvent(run, occurredAt);
    return { run, events: [event] };
  }

  private appendRunEvent(run: ProjectRun, occurredAt: string): ProjectEvent {
    try {
      return this.dependencies.projectEvents.appendInTransaction(
        run.projectId,
        {
          protocolVersion: 1,
          id: this.createId(),
          projectId: run.projectId,
          occurredAt,
          type: 'project.run_changed',
          payload: { run },
        },
      );
    } catch (error) {
      try {
        this.dependencies.onAuditFailure?.(error);
      } catch {
        // Preserve the durable audit error as the operation failure.
      }
      throw error;
    }
  }

  private canLaunch(): boolean {
    return this.dependencies.canLaunch?.() ?? true;
  }

  private now(): string {
    return (this.dependencies.now ?? (() => new Date().toISOString()))();
  }

  private createId(): string {
    return idSchema.parse((this.dependencies.createId ?? randomUUID)());
  }
}
