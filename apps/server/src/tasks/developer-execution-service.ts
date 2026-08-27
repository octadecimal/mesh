import { randomUUID } from 'node:crypto';

import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  idSchema,
  taskActorSchema,
  taskTransitionSchema,
  type DeveloperBlockerReport,
  type DeveloperCompletionReport,
  type DeveloperExecutionCycle,
  type ProjectEvent,
  type Task,
  type TaskActor,
  type TaskAttempt,
  type TaskTransition,
} from '@mesh-session-platform/contracts';

import { authorizeTaskTransition } from '../domain/task-lifecycle.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { TaskTransitionRepository } from '../repositories/task-transition-repository.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  TaskNotFoundError,
  TaskRevisionConflictError,
  type TaskMutationResult,
  type TaskService,
} from './task-service.js';
import { DeveloperCapabilityRegistry } from './developer-capability-registry.js';

export type DeveloperSubmitForReviewInput = {
  commandId: string;
  capability: string;
  expectedRevision: number;
  report: DeveloperCompletionReport;
  actor: TaskActor;
};

export type DeveloperMarkBlockedInput = {
  commandId: string;
  capability: string;
  expectedRevision: number;
  report: DeveloperBlockerReport;
  actor: TaskActor;
};

export type DeveloperAcceptInput = {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  actor: TaskActor;
};

export type DeveloperExecutionOutcome<Report> = {
  task: Task;
  cycle: DeveloperExecutionCycle;
  report: Report;
  transition: TaskTransition;
  event: ProjectEvent;
};

type Dependencies = {
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: TaskAttemptRepository;
  developerExecutions: DeveloperExecutionRepository;
  qaExecutions: QaExecutionRepository;
  transitions: TaskTransitionRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  taskService: Pick<TaskService, 'transition'>;
  capabilities: DeveloperCapabilityRegistry;
  publisher?: Pick<EventPublisher, 'publishProject'>;
  now?: () => string;
  createId?: () => string;
};

export class DeveloperExecutionOutcomeInvalidError extends Error {
  readonly code = 'developer_execution_outcome_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'DeveloperExecutionOutcomeInvalidError';
  }
}

export class DeveloperExecutionService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async accept(input: DeveloperAcceptInput): Promise<TaskMutationResult> {
    this.requireQaDisposition(input.taskId, 'verified');
    const result = await this.dependencies.taskService.transition({
      commandId: idSchema.parse(input.commandId),
      taskId: idSchema.parse(input.taskId),
      expectedRevision: input.expectedRevision,
      nextState: 'done',
      actor: taskActorSchema.parse(input.actor),
    });
    this.dependencies.publisher?.publishProject(result.event);
    return result;
  }

  private requireQaDisposition(
    taskId: string,
    requiredDisposition: 'verified' | 'rejected',
  ): void {
    const attempts = this.dependencies.attempts.listByTask(taskId);
    const qaCycles = this.dependencies.qaExecutions.listCyclesForAttempts(
      attempts.map(({ id }) => id),
    );
    if (qaCycles.length === 0) return;
    if (qaCycles.some(({ endedAt }) => endedAt === null)) {
      throw new DeveloperExecutionOutcomeInvalidError(
        `Task '${taskId}' has an active QA cycle`,
      );
    }
    const latestSubmission = [
      ...this.dependencies.developerExecutions.listByTask(taskId),
    ]
      .reverse()
      .find(
        (cycle) =>
          cycle.terminalDisposition === 'submitted_for_review' &&
          cycle.completionReportId !== null,
      );
    const latestQaCycle = [...qaCycles]
      .reverse()
      .find(
        ({ developerCompletionReportId }) =>
          developerCompletionReportId === latestSubmission?.completionReportId,
      );
    if (
      !latestSubmission ||
      !latestQaCycle ||
      latestQaCycle.terminalDisposition !== requiredDisposition ||
      latestQaCycle.reportId === null
    ) {
      throw new DeveloperExecutionOutcomeInvalidError(
        `Task '${taskId}' requires a matching ${requiredDisposition} QA verdict`,
      );
    }
  }

  submitForReview(
    input: DeveloperSubmitForReviewInput,
  ): DeveloperExecutionOutcome<DeveloperCompletionReport> {
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<
        DeveloperExecutionOutcome<DeveloperCompletionReport>
      >(commandId);
    if (existing.found) return existing.response;

    const result = this.dependencies.commands.executeOnceInImmediateTransaction(
      commandId,
      () => {
        const report = developerCompletionReportSchema.parse(input.report);
        const outcome = this.requireCurrentOutcome(input, report.cycleId);
        this.requireCompleteCoverage(outcome.cycle, report);
        authorizeTaskTransition({
          task: outcome.task,
          nextState: 'review',
          actor: input.actor,
          operation: 'developer_submit_review',
        });
        const occurredAt = this.now();
        const eventId = idSchema.parse(this.createId());
        this.dependencies.developerExecutions.appendCompletionReport(report);
        const cycle = this.closeCycle(outcome.cycle, {
          endedAt: occurredAt,
          terminalDisposition: 'submitted_for_review',
          completionReportId: report.id,
          blockerReportId: null,
          terminalCommandId: commandId,
          terminalEventId: eventId,
        });
        const task = this.updateTask(outcome.task, input.expectedRevision, {
          lifecycleState: 'review',
          updatedAt: occurredAt,
        });
        const transition = this.appendTransition(
          commandId,
          outcome.task,
          task,
          input.actor,
          null,
          occurredAt,
        );
        const event = this.dependencies.projectEvents.appendInTransaction(
          task.projectId,
          {
            protocolVersion: 1,
            id: eventId,
            projectId: task.projectId,
            occurredAt,
            type: 'task.developer_execution_changed',
            payload: {
              task,
              attempt: outcome.attempt,
              cycle,
              completionReport: report,
              blockerReport: null,
              reviewFeedback: null,
            },
          },
        );
        return { task, cycle, report, transition, event };
      },
    );
    this.dependencies.publisher?.publishProject(result.event);
    this.dependencies.capabilities.invalidateCycle(result.cycle.id);
    return result;
  }

  markBlocked(
    input: DeveloperMarkBlockedInput,
  ): DeveloperExecutionOutcome<DeveloperBlockerReport> {
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<
        DeveloperExecutionOutcome<DeveloperBlockerReport>
      >(commandId);
    if (existing.found) return existing.response;

    const result = this.dependencies.commands.executeOnceInImmediateTransaction(
      commandId,
      () => {
        const report = developerBlockerReportSchema.parse(input.report);
        const outcome = this.requireCurrentOutcome(input, report.cycleId);
        authorizeTaskTransition({
          task: outcome.task,
          nextState: 'in_progress',
          actor: input.actor,
          blocked: true,
          reason: report.reason,
          operation: 'developer_mark_blocked',
        });
        const occurredAt = this.now();
        const eventId = idSchema.parse(this.createId());
        this.dependencies.developerExecutions.appendBlockerReport(report);
        const cycle = this.closeCycle(outcome.cycle, {
          endedAt: occurredAt,
          terminalDisposition: 'blocked',
          completionReportId: null,
          blockerReportId: report.id,
          terminalCommandId: commandId,
          terminalEventId: eventId,
        });
        const task = this.updateTask(outcome.task, input.expectedRevision, {
          blocked: {
            reason: report.reason,
            actor: input.actor,
            blockedAt: occurredAt,
          },
          updatedAt: occurredAt,
        });
        const transition = this.appendTransition(
          commandId,
          outcome.task,
          task,
          input.actor,
          report.reason,
          occurredAt,
        );
        const event = this.dependencies.projectEvents.appendInTransaction(
          task.projectId,
          {
            protocolVersion: 1,
            id: eventId,
            projectId: task.projectId,
            occurredAt,
            type: 'task.developer_execution_changed',
            payload: {
              task,
              attempt: outcome.attempt,
              cycle,
              completionReport: null,
              blockerReport: report,
              reviewFeedback: null,
            },
          },
        );
        return { task, cycle, report, transition, event };
      },
    );
    this.dependencies.publisher?.publishProject(result.event);
    this.dependencies.capabilities.invalidateCycle(result.cycle.id);
    return result;
  }

  private requireCurrentOutcome(
    input: Pick<
      DeveloperSubmitForReviewInput,
      'capability' | 'expectedRevision' | 'actor'
    >,
    reportCycleId: string,
  ): { task: Task; attempt: TaskAttempt; cycle: DeveloperExecutionCycle } {
    const binding = this.dependencies.capabilities.resolve(input.capability);
    if (!sameActor(binding.agentActor, input.actor)) {
      throw new DeveloperExecutionOutcomeInvalidError(
        'Developer actor does not match capability',
      );
    }
    if (binding.cycleId !== reportCycleId) {
      throw new DeveloperExecutionOutcomeInvalidError(
        'Developer report does not match capability cycle',
      );
    }
    const task = this.dependencies.tasks.get(binding.taskId);
    if (!task) throw new TaskNotFoundError(binding.taskId);
    this.requireActiveProject(task.projectId);
    if (task.revision !== input.expectedRevision) {
      throw new TaskRevisionConflictError(task);
    }
    const attempt = this.dependencies.attempts.getCurrentBySession(
      binding.sessionId,
    );
    if (
      !attempt ||
      attempt.id !== binding.attemptId ||
      attempt.taskId !== task.id
    ) {
      throw new DeveloperExecutionOutcomeInvalidError(
        'Developer capability is not bound to the current task attempt',
      );
    }
    const cycle = this.dependencies.developerExecutions.getCycle(
      binding.cycleId,
    );
    if (!cycle || cycle.attemptId !== attempt.id || cycle.endedAt !== null) {
      throw new DeveloperExecutionOutcomeInvalidError(
        'Developer cycle is not current',
      );
    }
    return { task, attempt, cycle };
  }

  private requireCompleteCoverage(
    cycle: DeveloperExecutionCycle,
    report: DeveloperCompletionReport,
  ): void {
    const expected = new Set(
      cycle.taskSnapshot.acceptanceCriteria.map(({ id }) => id),
    );
    const reported = new Set<string>();
    for (const result of report.criterionResults) {
      if (
        !expected.has(result.criterionId) ||
        reported.has(result.criterionId)
      ) {
        throw new DeveloperExecutionOutcomeInvalidError(
          'Completion report criterion coverage is invalid',
        );
      }
      reported.add(result.criterionId);
    }
    if (reported.size !== expected.size) {
      throw new DeveloperExecutionOutcomeInvalidError(
        'Completion report does not cover every criterion',
      );
    }
  }

  private updateTask(
    task: Task,
    expectedRevision: number,
    patch: Partial<Task>,
  ): Task {
    const updated = this.dependencies.tasks.update(
      { ...task, ...patch },
      expectedRevision,
    );
    if (!updated)
      throw new TaskRevisionConflictError(
        this.dependencies.tasks.get(task.id) ?? task,
      );
    return updated;
  }

  private closeCycle(
    cycle: DeveloperExecutionCycle,
    update: Pick<
      DeveloperExecutionCycle,
      | 'endedAt'
      | 'terminalDisposition'
      | 'completionReportId'
      | 'blockerReportId'
      | 'terminalCommandId'
      | 'terminalEventId'
    >,
  ): DeveloperExecutionCycle {
    const closed = this.dependencies.developerExecutions.closeCycle(
      cycle.id,
      update,
    );
    if (!closed)
      throw new DeveloperExecutionOutcomeInvalidError(
        'Developer cycle is already closed',
      );
    return closed;
  }

  private appendTransition(
    commandId: string,
    previous: Task,
    next: Task,
    actor: TaskActor,
    reason: string | null,
    occurredAt: string,
  ): TaskTransition {
    return this.dependencies.transitions.append(
      taskTransitionSchema.parse({
        id: this.createId(),
        taskId: next.id,
        commandId,
        previousState: previous.lifecycleState,
        nextState: next.lifecycleState,
        actor,
        reason,
        occurredAt,
      }),
    );
  }

  private requireActiveProject(projectId: string): void {
    const project = this.dependencies.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (project.archivedAt) throw new ProjectArchivedError(project);
  }
}

const sameActor = (left: TaskActor, right: TaskActor): boolean =>
  left.type === right.type && left.id === right.id;
