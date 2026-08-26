import { randomUUID } from 'node:crypto';

import {
  ReviewAutomationPausedError,
  reviewAutomationActionSchema,
  taskActorSchema,
  taskTransitionSchema,
  type ProjectEvent,
  type QaExecutionCycle,
  type QaReport,
  type ReviewAutomationAction,
  type Task,
  type TaskAttempt,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { TaskTransitionRepository } from '../repositories/task-transition-repository.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import type { DeveloperAttemptResumeInput } from './developer-rework-service.js';
import type { QaLaunchInput } from './qa-execution-service.js';

const policyActor = taskActorSchema.parse({
  type: 'system',
  id: 'review-loop',
});

type QaVerdictPlanInput = {
  task: Task;
  attempt: TaskAttempt;
  cycle: QaExecutionCycle;
  report: QaReport;
  commandId: string;
  occurredAt: string;
};

type QaVerdictPlanDependencies = {
  projects: ProjectRepository;
  tasks: TaskRepository;
  qaExecutions: QaExecutionRepository;
  transitions: TaskTransitionRepository;
  projectEvents: ProjectEventRepository;
  createId: () => string;
};

export type QaVerdictPlan = {
  task: Task;
  events: ProjectEvent[];
  action?: ReviewAutomationAction;
};

const actionKey = (
  taskId: string,
  attemptId: string,
  sourceCycleId: string,
  actionKind: ReviewAutomationAction['actionKind'],
  generation: number,
) => `${taskId}:${attemptId}:${sourceCycleId}:${actionKind}:${generation}`;

export const planQaVerdict = (
  input: QaVerdictPlanInput,
  dependencies: QaVerdictPlanDependencies,
): QaVerdictPlan => {
  const currentTask = dependencies.tasks.get(input.task.id);
  const project = dependencies.projects.get(input.task.projectId);
  if (!currentTask || !project) {
    throw new ReviewAutomationPausedError(
      'QA verdict automation context is unavailable.',
    );
  }
  if (
    project.qaConfiguration.reviewPolicy !== 'autonomous_review' ||
    currentTask.reviewAutomation.status !== 'enabled'
  ) {
    return { task: currentTask, events: [] };
  }
  if (
    currentTask.lifecycleState !== 'review' ||
    currentTask.blocked ||
    currentTask.reviewAutomation.generation !== input.cycle.automationGeneration
  ) {
    throw new ReviewAutomationPausedError(
      'QA verdict automation source is stale or unsafe.',
    );
  }

  const sourceChanged =
    input.report.workspaceBefore !== input.report.workspaceAfter;
  const actionKind =
    input.report.disposition === 'verified'
      ? 'complete_task'
      : sourceChanged || input.cycle.rejectionOrdinal + 1 >= 3
        ? 'pause_automation'
        : 'resume_developer';
  const pending = reviewAutomationActionSchema.parse({
    id: dependencies.createId(),
    idempotencyKey: actionKey(
      currentTask.id,
      input.attempt.id,
      input.cycle.id,
      actionKind,
      currentTask.reviewAutomation.generation,
    ),
    projectId: currentTask.projectId,
    taskId: currentTask.id,
    attemptId: input.attempt.id,
    sourceCycleId: input.cycle.id,
    actionKind,
    generation: currentTask.reviewAutomation.generation,
    status: 'pending',
    errorCode: null,
    createdAt: input.occurredAt,
    completedAt: null,
  });
  const inserted = dependencies.qaExecutions.insertAutomationAction(pending);
  if (inserted.id !== pending.id || inserted.status !== 'pending') {
    return { task: currentTask, events: [], action: inserted };
  }

  if (input.report.disposition === 'verified') {
    const updated = dependencies.tasks.update(
      {
        ...currentTask,
        lifecycleState: 'done',
        updatedAt: input.occurredAt,
      },
      currentTask.revision,
    );
    if (!updated) {
      throw new ReviewAutomationPausedError(
        'Task changed during verified QA completion.',
      );
    }
    const transition = dependencies.transitions.append(
      taskTransitionSchema.parse({
        id: dependencies.createId(),
        taskId: updated.id,
        commandId: `${input.commandId}:complete-task`,
        previousState: currentTask.lifecycleState,
        nextState: updated.lifecycleState,
        actor: policyActor,
        reason: 'QA verified the Developer submission.',
        occurredAt: input.occurredAt,
      }),
    );
    const completed = dependencies.qaExecutions.completeAutomationAction(
      inserted.id,
      {
        status: 'completed',
        errorCode: null,
        completedAt: input.occurredAt,
      },
    );
    if (!completed) throw new Error('Verified automation action was lost.');
    const transitioned = dependencies.projectEvents.appendInTransaction(
      updated.projectId,
      {
        protocolVersion: 1,
        id: dependencies.createId(),
        projectId: updated.projectId,
        occurredAt: input.occurredAt,
        type: 'task.transitioned',
        payload: { task: updated, transition },
      },
    );
    const automation = dependencies.projectEvents.appendInTransaction(
      updated.projectId,
      {
        protocolVersion: 1,
        id: dependencies.createId(),
        projectId: updated.projectId,
        occurredAt: input.occurredAt,
        type: 'task.review_automation_changed',
        payload: {
          task: updated,
          automation: updated.reviewAutomation,
          action: completed,
        },
      },
    );
    return {
      task: updated,
      events: [transitioned, automation],
      action: completed,
    };
  }

  const rejectionCount = input.cycle.rejectionOrdinal + 1;
  const paused = sourceChanged || rejectionCount >= 3;
  const updated = dependencies.tasks.update(
    {
      ...currentTask,
      reviewAutomation: {
        ...currentTask.reviewAutomation,
        status: paused ? 'paused' : 'enabled',
        rejectionCount,
        pauseReason: sourceChanged
          ? 'QA observed changed source state; automation requires a human decision.'
          : paused
            ? 'Three autonomous QA rejections require a human decision.'
            : null,
        updatedAt: input.occurredAt,
      },
      updatedAt: input.occurredAt,
    },
    currentTask.revision,
  );
  if (!updated) {
    throw new ReviewAutomationPausedError(
      'Task changed during rejected QA planning.',
    );
  }
  const action = paused
    ? dependencies.qaExecutions.completeAutomationAction(inserted.id, {
        status: 'completed',
        errorCode: null,
        completedAt: input.occurredAt,
      })
    : inserted;
  if (!action) throw new Error('Rejected automation action was lost.');
  const automation = dependencies.projectEvents.appendInTransaction(
    updated.projectId,
    {
      protocolVersion: 1,
      id: dependencies.createId(),
      projectId: updated.projectId,
      occurredAt: input.occurredAt,
      type: 'task.review_automation_changed',
      payload: {
        task: updated,
        automation: updated.reviewAutomation,
        action,
      },
    },
  );
  return { task: updated, events: [automation], action };
};

type SourceInput = { taskId: string; cycleId: string };

type Dependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: TaskAttemptRepository;
  developerExecutions: DeveloperExecutionRepository;
  qaExecutions: QaExecutionRepository;
  projectEvents: ProjectEventRepository;
  qaExecutionService: { launch(input: QaLaunchInput): Promise<unknown> };
  developerReworkService: {
    resume(input: DeveloperAttemptResumeInput): Promise<unknown>;
  };
  publisher: Pick<EventPublisher, 'publishProject'>;
  now?: () => string;
  createId?: () => string;
};

type AutomationContext = {
  task: Task;
  attempt: TaskAttempt;
};

export class ReviewAutomationService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async afterDeveloperSubmission(
    input: SourceInput,
  ): Promise<ReviewAutomationAction | undefined> {
    const knownCycle = this.dependencies.developerExecutions
      .listByTask(input.taskId)
      .find(({ id }) => id === input.cycleId);
    if (knownCycle) {
      const existing =
        this.dependencies.qaExecutions.getAutomationActionBySource(
          knownCycle.id,
          'launch_qa',
        );
      if (
        existing?.taskId === input.taskId &&
        existing.attemptId === knownCycle.attemptId &&
        existing.status !== 'pending'
      ) {
        return existing;
      }
    }
    const context = this.requireDeveloperSource(input);
    if (!context) return undefined;
    const action = this.pendingAction(
      context,
      input.cycleId,
      'launch_qa',
      context.task.reviewAutomation.generation,
    );
    const persisted = this.persistPending(action);
    if (persisted.status !== 'pending') return persisted;

    try {
      const current = this.requireDeveloperSource(input);
      if (!current) {
        throw new ReviewAutomationPausedError(
          'Review policy changed before autonomous QA launch.',
        );
      }
      await this.dependencies.qaExecutionService.launch({
        commandId: persisted.idempotencyKey,
        taskId: current.task.id,
        expectedRevision: current.task.revision,
        actor: policyActor,
        trigger: 'autonomous_policy',
      });
      return this.finishAction(persisted, 'completed');
    } catch (error) {
      this.failAndPause(persisted, error);
      throw error;
    }
  }

  afterQaVerdict(input: SourceInput): Promise<ReviewAutomationAction> {
    return this.continueRejectedVerdict(input);
  }

  async continueRejectedVerdict(
    input: SourceInput,
  ): Promise<ReviewAutomationAction> {
    const knownCycle = this.dependencies.qaExecutions.getCycle(input.cycleId);
    if (!knownCycle || knownCycle.taskId !== input.taskId) {
      throw new ReviewAutomationPausedError(
        'The rejected QA source cycle is unavailable.',
      );
    }
    const key = this.actionKey(
      knownCycle.taskId,
      knownCycle.attemptId,
      knownCycle.id,
      'resume_developer',
      knownCycle.automationGeneration,
    );
    const action =
      this.dependencies.qaExecutions.getAutomationActionByIdempotencyKey(key);
    if (!action) {
      throw new ReviewAutomationPausedError(
        'The rejected QA verdict has no durable follow-up action.',
      );
    }
    if (action.status !== 'pending') return action;

    try {
      if (
        action.taskId !== knownCycle.taskId ||
        action.attemptId !== knownCycle.attemptId ||
        action.sourceCycleId !== knownCycle.id ||
        action.generation !== knownCycle.automationGeneration ||
        knownCycle.terminalDisposition !== 'rejected' ||
        knownCycle.endedAt === null ||
        knownCycle.rejectionOrdinal >= 2
      ) {
        throw new ReviewAutomationPausedError(
          'The rejected QA source cycle is stale or incomplete.',
        );
      }
      const report = this.dependencies.qaExecutions.getReport(
        knownCycle.reportId ?? '',
      );
      if (!report || report.disposition !== 'rejected') {
        throw new ReviewAutomationPausedError(
          'The rejected QA report is unavailable.',
        );
      }
      const currentTask = this.requireTask(action.taskId);
      const failedEvidence = report.criterionResults
        .filter(({ status }) => status !== 'passed')
        .map(({ criterionId, evidence }) => `${criterionId}: ${evidence}`)
        .join('\n');
      await this.dependencies.developerReworkService.resume({
        commandId: action.idempotencyKey,
        taskId: action.taskId,
        expectedRevision: currentTask.revision,
        kind: 'rejection',
        feedback:
          failedEvidence ||
          report.residualRisks.join('\n') ||
          'QA rejected the submission.',
        actor: policyActor,
        automation: {
          sourceCycleId: knownCycle.id,
          generation: knownCycle.automationGeneration,
        },
      });
      return this.finishAction(action, 'completed');
    } catch (error) {
      this.failAndPause(action, error);
      throw error;
    }
  }

  private requireDeveloperSource(
    input: SourceInput,
  ): AutomationContext | undefined {
    const task = this.requireTask(input.taskId);
    const project = this.dependencies.projects.get(task.projectId);
    if (!project) {
      throw new ReviewAutomationPausedError('The project is unavailable.');
    }
    if (project.qaConfiguration.reviewPolicy === 'manual') return undefined;
    if (task.reviewAutomation.status !== 'enabled') return undefined;
    if (task.lifecycleState !== 'review' || task.blocked) {
      throw new ReviewAutomationPausedError(
        'The task is no longer eligible for autonomous QA.',
      );
    }
    const attempt = this.currentAttempt(task.id);
    const cycles = this.dependencies.developerExecutions.listByTask(task.id);
    const source = cycles.at(-1);
    if (
      !source ||
      source.id !== input.cycleId ||
      source.attemptId !== attempt.id ||
      source.terminalDisposition !== 'submitted_for_review' ||
      source.endedAt === null
    ) {
      throw new ReviewAutomationPausedError(
        'The Developer source cycle is stale or incomplete.',
      );
    }
    return { task, attempt };
  }

  private requireTask(taskId: string): Task {
    const task = this.dependencies.tasks.get(taskId);
    if (!task) throw new ReviewAutomationPausedError('The task was not found.');
    return task;
  }

  private currentAttempt(taskId: string): TaskAttempt {
    const attempt = this.dependencies.attempts
      .listByTask(taskId)
      .filter(({ unlinkedAt }) => unlinkedAt === null)
      .at(-1);
    if (!attempt || attempt.role !== 'developer') {
      throw new ReviewAutomationPausedError(
        'The current Developer attempt is unavailable.',
      );
    }
    return attempt;
  }

  private pendingAction(
    context: AutomationContext,
    sourceCycleId: string,
    actionKind: ReviewAutomationAction['actionKind'],
    generation: number,
  ): ReviewAutomationAction {
    return reviewAutomationActionSchema.parse({
      id: this.createId(),
      idempotencyKey: this.actionKey(
        context.task.id,
        context.attempt.id,
        sourceCycleId,
        actionKind,
        generation,
      ),
      projectId: context.task.projectId,
      taskId: context.task.id,
      attemptId: context.attempt.id,
      sourceCycleId,
      actionKind,
      generation,
      status: 'pending',
      errorCode: null,
      createdAt: this.now(),
      completedAt: null,
    });
  }

  private actionKey(
    taskId: string,
    attemptId: string,
    sourceCycleId: string,
    actionKind: ReviewAutomationAction['actionKind'],
    generation: number,
  ): string {
    return actionKey(taskId, attemptId, sourceCycleId, actionKind, generation);
  }

  private persistPending(
    action: ReviewAutomationAction,
  ): ReviewAutomationAction {
    const existing =
      this.dependencies.qaExecutions.getAutomationActionByIdempotencyKey(
        action.idempotencyKey,
      );
    if (existing) return existing;
    const { action: persisted, event } = this.transaction(() => {
      const inserted =
        this.dependencies.qaExecutions.insertAutomationAction(action);
      const task = this.requireTask(action.taskId);
      const event = this.appendAutomationEvent(task, inserted);
      return { action: inserted, event };
    });
    this.dependencies.publisher.publishProject(event);
    return persisted;
  }

  private finishAction(
    action: ReviewAutomationAction,
    status: 'completed',
  ): ReviewAutomationAction {
    const result = this.transaction(() => {
      const completed = this.dependencies.qaExecutions.completeAutomationAction(
        action.id,
        { status, errorCode: null, completedAt: this.now() },
      );
      const current =
        completed ??
        this.dependencies.qaExecutions.getAutomationAction(action.id);
      if (!current) throw new Error('Automation action disappeared.');
      return {
        action: current,
        event: completed
          ? this.appendAutomationEvent(this.requireTask(action.taskId), current)
          : undefined,
      };
    });
    if (result.event) this.dependencies.publisher.publishProject(result.event);
    return result.action;
  }

  private failAndPause(action: ReviewAutomationAction, error: unknown): void {
    const result = this.transaction(() => {
      const task = this.requireTask(action.taskId);
      const occurredAt = this.now();
      const paused = this.dependencies.tasks.update(
        {
          ...task,
          reviewAutomation: {
            ...task.reviewAutomation,
            status: 'paused',
            pauseReason: `Automatic ${action.actionKind} failed: ${this.errorMessage(error)}`,
            updatedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
        task.revision,
      );
      if (!paused) throw new Error('Task changed while pausing automation.');
      const failed = this.dependencies.qaExecutions.completeAutomationAction(
        action.id,
        {
          status: 'failed',
          errorCode: this.errorCode(error),
          completedAt: occurredAt,
        },
      );
      if (!failed) throw new Error('Automation action changed before failure.');
      return { event: this.appendAutomationEvent(paused, failed) };
    });
    this.dependencies.publisher.publishProject(result.event);
  }

  private appendAutomationEvent(
    task: Task,
    action: ReviewAutomationAction,
  ): ProjectEvent {
    return this.dependencies.projectEvents.appendInTransaction(task.projectId, {
      protocolVersion: 1,
      id: this.createId(),
      projectId: task.projectId,
      occurredAt: this.now(),
      type: 'task.review_automation_changed',
      payload: {
        task,
        automation: task.reviewAutomation,
        action,
      },
    });
  }

  private transaction<T>(execute: () => T): T {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const result = execute();
      this.dependencies.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private errorCode(error: unknown): string {
    return (
      (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined) ?? 'review_automation_failed'
    );
  }
}
