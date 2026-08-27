import { createHash, randomUUID } from 'node:crypto';

import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  developerReviewFeedbackSchema,
  rawDiagnosticSchema,
  taskActorSchema,
  taskTransitionSchema,
  type DeveloperExecutionCycle,
  type DeveloperReviewFeedback,
  type ProjectEvent,
  type Session,
  type Task,
  type TaskActor,
  type TaskAttempt,
} from '@mesh-session-platform/contracts';

import type { DeveloperRuntimeConfiguration } from '../claude/driver.js';
import {
  composeDeveloperPrompt,
  DEVELOPER_POLICY_VERSION,
} from '../domain/developer-policy.js';
import { authorizeTaskTransition } from '../domain/task-lifecycle.js';
import type { Database } from '../db/database.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { TaskTransitionRepository } from '../repositories/task-transition-repository.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import type { DeveloperCapabilityRegistry } from './developer-capability-registry.js';
import type { DeveloperExecutionService } from './developer-execution-service.js';
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  TaskNotFoundError,
  TaskRevisionConflictError,
  type TaskService,
} from './task-service.js';

export type DeveloperRecoveryKind = 'rejection' | 'unblock';

export type DeveloperAttemptResumeInput = {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  kind: DeveloperRecoveryKind;
  feedback: string;
  actor: TaskActor;
  automation?: {
    sourceCycleId: string;
    generation: number;
  };
};

export type DeveloperRecoveryContext = {
  task: Task;
  attempt: TaskAttempt;
  previousCycle: DeveloperExecutionCycle;
};

export type PreparedDeveloperRecovery = {
  task: Task;
  attempt: TaskAttempt;
  cycle: DeveloperExecutionCycle;
  feedback: DeveloperReviewFeedback;
  event: ProjectEvent;
};

export type DeveloperRecoveryResult = PreparedDeveloperRecovery & {
  session?: Session;
};

type Registry = {
  resume(
    sessionId: string,
    configuration: {
      workspaceId: string;
      permissionMode: Session['permissionMode'];
    },
    developer?: DeveloperRuntimeConfiguration,
  ): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  emergencyClose?(sessionId: string): Promise<void>;
  publisher: Pick<EventPublisher, 'publishProject'>;
};

type Dependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: TaskAttemptRepository;
  sessions: SessionRepository;
  diagnostics: DiagnosticRepository;
  developerExecutions: DeveloperExecutionRepository;
  qaExecutions: QaExecutionRepository;
  transitions: TaskTransitionRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  taskService: TaskService;
  registry: Registry;
  capabilities: DeveloperCapabilityRegistry;
  developerExecutionService: DeveloperExecutionService;
  afterDeveloperSubmission?: (input: {
    taskId: string;
    cycleId: string;
  }) => Promise<void>;
  afterDeveloperBlocked?: (input: {
    taskId: string;
    cycleId: string;
  }) => Promise<void>;
  now?: () => string;
  createId?: () => string;
};

class DeveloperRecoveryInvalidError extends Error {
  readonly code = 'invalid_command';
}

class DeveloperRecoveryStartFailedError extends Error {
  readonly code = 'attempt_start_failed';

  constructor(
    readonly sessionId: string,
    readonly cause: unknown,
  ) {
    super(`Task attempt session '${sessionId}' did not start successfully`);
  }
}

class DeveloperRecoveryReconciliationRequiredError extends Error {
  readonly code = 'attempt_reconciliation_required';

  constructor(
    readonly sessionId: string,
    readonly cause: unknown,
  ) {
    super(`Task attempt session '${sessionId}' requires reconciliation`);
  }
}

const errorDetails = (error: unknown) =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };

export class DeveloperReworkService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async resume(
    input: DeveloperAttemptResumeInput,
  ): Promise<DeveloperRecoveryResult> {
    let completedResume:
      | {
          prepared: PreparedDeveloperRecovery;
          actor: TaskActor;
        }
      | undefined;
    const executeResume = async () => {
      const actor = taskActorSchema.parse(input.actor);
      const context = this.requireRecovery(input, actor);
      const session = this.requireSession(context.attempt.sessionId);
      if (!session.claudeResumeId) {
        throw new DeveloperRecoveryInvalidError(
          `Developer session '${session.id}' has no Claude resume ID`,
        );
      }
      if (session.workspaceId !== context.previousCycle.workspaceId) {
        throw new DeveloperRecoveryInvalidError(
          `Developer session '${session.id}' no longer uses its cycle workspace`,
        );
      }
      if (
        this.dependencies.developerExecutions.getActiveCycleBySession(
          session.id,
        )
      ) {
        throw new DeveloperRecoveryInvalidError(
          `Developer session '${session.id}' already has an active cycle`,
        );
      }

      const prepared = this.persistResumeAudit(input, actor, context, session);
      this.dependencies.registry.publisher.publishProject(prepared.event);
      try {
        const runtime = this.createRuntime(
          prepared.task,
          prepared.attempt,
          prepared.cycle,
          input.expectedRevision + 1,
          prepared.feedback,
        );
        await this.dependencies.registry.resume(
          session.id,
          {
            workspaceId: prepared.cycle.workspaceId,
            permissionMode: prepared.cycle.permissionMode,
          },
          runtime,
        );
      } catch (error) {
        this.dependencies.capabilities.invalidateCycle(prepared.cycle.id);
        this.closeFailed(prepared, 'resume', error);
        throw new DeveloperRecoveryStartFailedError(session.id, error);
      }

      try {
        const transition = await this.complete(input, actor);
        this.dependencies.registry.publisher.publishProject(transition.event);
        const result = {
          ...prepared,
          task: transition.task,
          event: transition.event,
          session: this.dependencies.sessions.get(session.id),
        };
        completedResume = { prepared, actor };
        return result;
      } catch (error) {
        this.dependencies.capabilities.invalidateCycle(prepared.cycle.id);
        let cleanup: 'interrupted' | 'unknown' = 'interrupted';
        try {
          await this.dependencies.registry.interrupt(session.id);
        } catch {
          cleanup = 'unknown';
        }
        this.closeFailed(prepared, 'task_transition', error, cleanup);
        if (cleanup === 'unknown') {
          throw new DeveloperRecoveryReconciliationRequiredError(
            session.id,
            error,
          );
        }
        throw new DeveloperRecoveryStartFailedError(session.id, error);
      }
    };

    try {
      return await this.dependencies.commands.executeOnce(
        input.commandId,
        executeResume,
      );
    } catch (error) {
      if (completedResume) {
        await this.reconcileCommandCompletionFailure(
          completedResume.prepared,
          input,
          completedResume.actor,
          error,
        );
      }
      throw error;
    }
  }

  requireRecovery(
    input: Pick<
      DeveloperAttemptResumeInput,
      'taskId' | 'expectedRevision' | 'kind' | 'feedback' | 'automation'
    >,
    actor: TaskActor,
  ): DeveloperRecoveryContext {
    const automated =
      actor.type === 'system' &&
      actor.id === 'review-loop' &&
      input.kind === 'rejection' &&
      input.automation !== undefined;
    if (actor.type !== 'human' && !automated) {
      throw new DeveloperRecoveryInvalidError(
        'Only a human or the bounded review policy may request Developer recovery',
      );
    }
    if (!input.feedback.trim()) {
      throw new DeveloperRecoveryInvalidError(
        'Developer recovery feedback is required',
      );
    }
    const task = this.requireTask(input.taskId, input.expectedRevision);
    if (actor.type === 'human') {
      authorizeTaskTransition({
        task,
        nextState: 'in_progress',
        actor,
        reason: input.feedback,
        ...(input.kind === 'unblock' ? { blocked: false } : {}),
      });
    }
    if (
      (input.kind === 'rejection' &&
        (task.lifecycleState !== 'review' || task.blocked !== null)) ||
      (input.kind === 'unblock' &&
        (task.lifecycleState !== 'in_progress' || task.blocked === null))
    ) {
      throw new DeveloperRecoveryInvalidError(
        `Task '${task.id}' is not eligible for ${input.kind} recovery`,
      );
    }
    const expectedDisposition =
      input.kind === 'rejection' ? 'submitted_for_review' : 'blocked';
    const cycles = this.dependencies.developerExecutions.listByTask(task.id);
    if (cycles.some((cycle) => cycle.endedAt === null)) {
      throw new DeveloperRecoveryInvalidError(
        `Task '${task.id}' already has an active Developer cycle`,
      );
    }
    const previousCycle = [...cycles]
      .reverse()
      .find((cycle) => cycle.terminalDisposition === expectedDisposition);
    if (!previousCycle) {
      throw new DeveloperRecoveryInvalidError(
        `Task '${task.id}' has no matching Developer outcome to recover`,
      );
    }
    const attempt = this.dependencies.attempts
      .listByTask(task.id)
      .find((candidate) => candidate.id === previousCycle.attemptId);
    if (
      !attempt ||
      attempt.role !== 'developer' ||
      attempt.unlinkedAt !== null
    ) {
      throw new DeveloperRecoveryInvalidError(
        `Developer attempt '${previousCycle.attemptId}' is not current`,
      );
    }
    if (input.kind === 'rejection') {
      const qaCycles = this.dependencies.qaExecutions.listCyclesForAttempts(
        this.dependencies.attempts.listByTask(task.id).map(({ id }) => id),
      );
      if (qaCycles.some(({ endedAt }) => endedAt === null)) {
        throw new DeveloperRecoveryInvalidError(
          `Task '${task.id}' has an active QA cycle`,
        );
      }
      const latestQaCycle = [...qaCycles]
        .reverse()
        .find(
          ({ developerCompletionReportId }) =>
            developerCompletionReportId === previousCycle.completionReportId,
        );
      if (
        (qaCycles.length > 0 || automated) &&
        (latestQaCycle?.terminalDisposition !== 'rejected' ||
          latestQaCycle.reportId === null)
      ) {
        throw new DeveloperRecoveryInvalidError(
          `Task '${task.id}' requires a matching rejected QA verdict`,
        );
      }
    }
    if (automated) {
      this.assertAutomationRecovery(task, attempt, input.automation!);
    }
    return { task, attempt, previousCycle };
  }

  createFeedback(
    input: Pick<
      DeveloperAttemptResumeInput,
      'commandId' | 'taskId' | 'kind' | 'feedback'
    >,
    actor: TaskActor,
    previousCycle: DeveloperExecutionCycle,
    occurredAt: string,
  ): DeveloperReviewFeedback {
    return developerReviewFeedbackSchema.parse({
      id: this.createId(),
      cycleId: previousCycle.id,
      taskId: input.taskId,
      kind: input.kind,
      feedback: input.feedback,
      actor,
      commandId: input.commandId,
      createdAt: occurredAt,
    });
  }

  createRuntime(
    task: Task,
    attempt: TaskAttempt,
    cycle: DeveloperExecutionCycle,
    expectedRevision: number,
    feedback?: DeveloperReviewFeedback,
  ): DeveloperRuntimeConfiguration {
    const agentActor = taskActorSchema.parse({
      type: 'agent',
      id: `developer-${attempt.id}`,
    });
    const capability = this.dependencies.capabilities.issue({
      sessionId: attempt.sessionId,
      attemptId: attempt.id,
      taskId: task.id,
      cycleId: cycle.id,
      agentActor,
    });
    return {
      initialPrompt: composeDeveloperPrompt({
        ...cycle,
        ...(feedback?.kind === 'rejection' ? { reviewFeedback: feedback } : {}),
        ...(feedback?.kind === 'unblock'
          ? { blockerFeedback: feedback.feedback }
          : {}),
      }),
      controls: {
        submitForReview: async (report) => {
          const { idempotencyKey, ...evidence } = report;
          const fingerprint = createHash('sha256')
            .update(JSON.stringify(evidence))
            .digest('hex');
          const commandId = `${cycle.id}-${idempotencyKey}-${fingerprint}`;
          const outcome =
            this.dependencies.developerExecutionService.submitForReview({
              commandId,
              capability,
              expectedRevision,
              report: developerCompletionReportSchema.parse({
                id: commandId,
                cycleId: cycle.id,
                ...evidence,
                createdAt: new Date().toISOString(),
              }),
              actor: agentActor,
            });
          await this.closeTerminalRuntime(attempt.sessionId, cycle.id);
          await this.dependencies.afterDeveloperSubmission?.({
            taskId: outcome.task.id,
            cycleId: outcome.cycle.id,
          });
        },
        markBlocked: async (report) => {
          const { idempotencyKey, ...evidence } = report;
          const fingerprint = createHash('sha256')
            .update(JSON.stringify(evidence))
            .digest('hex');
          const commandId = `${cycle.id}-${idempotencyKey}-${fingerprint}`;
          const outcome =
            this.dependencies.developerExecutionService.markBlocked({
              commandId,
              capability,
              expectedRevision,
              report: developerBlockerReportSchema.parse({
                id: commandId,
                cycleId: cycle.id,
                ...evidence,
                createdAt: new Date().toISOString(),
              }),
              actor: agentActor,
            });
          await this.closeTerminalRuntime(attempt.sessionId, cycle.id);
          await this.dependencies.afterDeveloperBlocked?.({
            taskId: outcome.task.id,
            cycleId: outcome.cycle.id,
          });
        },
      },
    };
  }

  complete(
    input: Pick<
      DeveloperAttemptResumeInput,
      | 'commandId'
      | 'taskId'
      | 'expectedRevision'
      | 'kind'
      | 'feedback'
      | 'automation'
    >,
    actor: TaskActor,
  ) {
    const commandId = `${input.commandId}:task-recovery`;
    return this.dependencies.commands.executeOnceInImmediateTransaction(
      commandId,
      () => {
        const task = this.requireTask(input.taskId, input.expectedRevision);
        const automated = actor.type === 'system';
        if (automated) {
          const attempt = this.dependencies.attempts
            .listByTask(task.id)
            .filter(({ unlinkedAt }) => unlinkedAt === null)
            .at(-1);
          if (!attempt || attempt.role !== 'developer' || !input.automation) {
            throw new DeveloperRecoveryInvalidError(
              'Autonomous Developer recovery attempt is unavailable',
            );
          }
          this.assertAutomationRecovery(task, attempt, input.automation);
        } else {
          authorizeTaskTransition({
            task,
            nextState: 'in_progress',
            actor,
            reason: input.feedback,
            ...(input.kind === 'unblock' ? { blocked: false } : {}),
          });
        }
        const occurredAt = this.now();
        const project = this.requireActiveProject(task.projectId);
        const reviewAutomation = automated
          ? task.reviewAutomation
          : {
              status:
                project.qaConfiguration.reviewPolicy === 'autonomous_review'
                  ? ('enabled' as const)
                  : ('disabled' as const),
              generation: task.reviewAutomation.generation + 1,
              rejectionCount: 0,
              pauseReason: null,
              updatedAt: occurredAt,
            };
        const updated = this.dependencies.tasks.update(
          {
            ...task,
            lifecycleState: 'in_progress',
            ...(input.kind === 'unblock' ? { blocked: null } : {}),
            reviewAutomation,
            updatedAt: occurredAt,
          },
          input.expectedRevision,
        );
        if (!updated) {
          throw new TaskRevisionConflictError(
            this.dependencies.tasks.get(task.id) ?? task,
          );
        }
        const transition = this.dependencies.transitions.append(
          taskTransitionSchema.parse({
            id: this.createId(),
            taskId: updated.id,
            commandId,
            previousState: task.lifecycleState,
            nextState: updated.lifecycleState,
            actor,
            reason: input.feedback,
            occurredAt,
          }),
        );
        const event = this.dependencies.projectEvents.appendInTransaction(
          updated.projectId,
          {
            protocolVersion: 1,
            id: this.createId(),
            projectId: updated.projectId,
            occurredAt,
            type: 'task.transitioned',
            payload: { task: updated, transition },
          },
        );
        return { task: updated, transition, event };
      },
    );
  }

  closeFailed(
    prepared: Omit<PreparedDeveloperRecovery, 'feedback'> & {
      feedback?: DeveloperReviewFeedback;
    },
    stage: 'startup' | 'resume' | 'task_transition' | 'command_completion',
    error: unknown,
    cleanup?: 'interrupted' | 'unknown',
  ): void {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    let event: ProjectEvent;
    try {
      const occurredAt = this.now();
      const cycle = this.dependencies.developerExecutions.closeCycle(
        prepared.cycle.id,
        {
          endedAt: occurredAt,
          terminalDisposition: null,
          completionReportId: null,
          blockerReportId: null,
          terminalCommandId: null,
          terminalEventId: null,
        },
      );
      if (!cycle) {
        throw new Error(
          `Developer recovery cycle '${prepared.cycle.id}' is already closed`,
        );
      }
      const task =
        this.dependencies.tasks.get(prepared.task.id) ?? prepared.task;
      event = this.dependencies.projectEvents.appendInTransaction(
        task.projectId,
        {
          protocolVersion: 1,
          id: this.createId(),
          projectId: task.projectId,
          occurredAt,
          type: 'task.developer_execution_changed',
          payload: {
            task,
            attempt: prepared.attempt,
            cycle,
            completionReport: null,
            blockerReport: null,
            reviewFeedback: prepared.feedback ?? null,
          },
        },
      );
      this.dependencies.database.exec('COMMIT');
    } catch (auditError) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw new DeveloperRecoveryReconciliationRequiredError(
        prepared.attempt.sessionId,
        auditError,
      );
    }
    this.dependencies.registry.publisher.publishProject(event);
    if (
      !this.recordDiagnostic(prepared.attempt.sessionId, {
        kind: 'developer_recovery',
        stage,
        outcome: 'failed',
        ...(cleanup ? { cleanup } : {}),
        ...(stage === 'command_completion'
          ? { reconciliationRequired: true }
          : {}),
        error: errorDetails(error),
      })
    ) {
      throw new DeveloperRecoveryReconciliationRequiredError(
        prepared.attempt.sessionId,
        error,
      );
    }
  }

  async reconcileCommandCompletionFailure(
    prepared: PreparedDeveloperRecovery,
    input: Pick<
      DeveloperAttemptResumeInput,
      'commandId' | 'taskId' | 'expectedRevision' | 'kind' | 'feedback'
    >,
    actor: TaskActor,
    error: unknown,
  ): Promise<never> {
    this.dependencies.capabilities.invalidateCycle(prepared.cycle.id);
    let cleanup: 'interrupted' | 'unknown' = 'interrupted';
    try {
      await this.dependencies.registry.interrupt(prepared.attempt.sessionId);
    } catch {
      cleanup = 'unknown';
    }

    let restorationError: unknown;
    try {
      const restored = await this.restorePriorTruth(prepared, input, actor);
      this.dependencies.registry.publisher.publishProject(restored.event);
    } catch (restoreError) {
      restorationError = restoreError;
    }

    this.closeFailed(
      prepared,
      'command_completion',
      restorationError ?? error,
      cleanup,
    );
    throw new DeveloperRecoveryReconciliationRequiredError(
      prepared.attempt.sessionId,
      restorationError ?? error,
    );
  }

  private persistResumeAudit(
    input: DeveloperAttemptResumeInput,
    actor: TaskActor,
    expected: DeveloperRecoveryContext,
    session: Session,
  ): PreparedDeveloperRecovery {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.requireRecovery(input, actor);
      if (
        current.attempt.id !== expected.attempt.id ||
        current.previousCycle.id !== expected.previousCycle.id
      ) {
        throw new DeveloperRecoveryInvalidError(
          'Developer recovery history changed during resume',
        );
      }
      const occurredAt = this.now();
      const feedback = this.dependencies.developerExecutions.appendFeedback(
        this.createFeedback(input, actor, current.previousCycle, occurredAt),
      );
      const cycle = this.dependencies.developerExecutions.createCycle(
        this.createCycle(
          current.task,
          current.attempt,
          actor,
          input.commandId,
          session,
          occurredAt,
        ),
      );
      const event = this.dependencies.projectEvents.appendInTransaction(
        current.task.projectId,
        {
          protocolVersion: 1,
          id: this.createId(),
          projectId: current.task.projectId,
          occurredAt,
          type: 'task.developer_execution_changed',
          payload: {
            task: current.task,
            attempt: current.attempt,
            cycle,
            completionReport: null,
            blockerReport: null,
            reviewFeedback: feedback,
          },
        },
      );
      this.dependencies.database.exec('COMMIT');
      return {
        task: current.task,
        attempt: current.attempt,
        cycle,
        feedback,
        event,
      };
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private createCycle(
    task: Task,
    attempt: TaskAttempt,
    actor: TaskActor,
    commandId: string,
    session: Session,
    occurredAt: string,
  ): DeveloperExecutionCycle {
    const project = this.requireActiveProject(task.projectId);
    const ordinal =
      this.dependencies.developerExecutions
        .listByTask(task.id)
        .filter((cycle) => cycle.attemptId === attempt.id)
        .reduce((maximum, cycle) => Math.max(maximum, cycle.ordinal), 0) + 1;
    return developerExecutionCycleSchema.parse({
      id: this.createId(),
      attemptId: attempt.id,
      ordinal,
      mode: 'resume',
      authorizedBy: actor,
      authorizationCommandId: commandId,
      policyVersion: DEVELOPER_POLICY_VERSION,
      projectInstructions: {
        content: project.developerInstructions.content,
        revision: project.developerInstructions.revision,
      },
      taskSnapshot: {
        revision: task.revision,
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria.map((text, index) => ({
          id: `criterion-${index + 1}`,
          text,
        })),
      },
      workspaceId: session.workspaceId,
      permissionMode: session.permissionMode,
      startedAt: occurredAt,
      endedAt: null,
      terminalDisposition: null,
      completionReportId: null,
      blockerReportId: null,
      terminalCommandId: null,
      terminalEventId: null,
    });
  }

  private assertAutomationRecovery(
    task: Task,
    attempt: TaskAttempt,
    automation: NonNullable<DeveloperAttemptResumeInput['automation']>,
  ): void {
    const project = this.requireActiveProject(task.projectId);
    const qaCycle = this.dependencies.qaExecutions.getCycle(
      automation.sourceCycleId,
    );
    const key = `${task.id}:${attempt.id}:${automation.sourceCycleId}:resume_developer:${automation.generation}`;
    const action =
      this.dependencies.qaExecutions.getAutomationActionByIdempotencyKey(key);
    if (
      project.qaConfiguration.reviewPolicy !== 'autonomous_review' ||
      task.reviewAutomation.status !== 'enabled' ||
      task.reviewAutomation.generation !== automation.generation ||
      task.reviewAutomation.rejectionCount < 1 ||
      task.reviewAutomation.rejectionCount > 2 ||
      !qaCycle ||
      qaCycle.taskId !== task.id ||
      qaCycle.attemptId !== attempt.id ||
      qaCycle.terminalDisposition !== 'rejected' ||
      qaCycle.endedAt === null ||
      qaCycle.automationGeneration !== automation.generation ||
      qaCycle.rejectionOrdinal + 1 !== task.reviewAutomation.rejectionCount ||
      !action ||
      action.status !== 'pending' ||
      action.actionKind !== 'resume_developer'
    ) {
      throw new DeveloperRecoveryInvalidError(
        'Autonomous Developer recovery is stale or unauthorized',
      );
    }
  }

  private requireTask(taskId: string, expectedRevision: number): Task {
    const task = this.dependencies.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.requireActiveProject(task.projectId);
    if (task.revision !== expectedRevision) {
      throw new TaskRevisionConflictError(task);
    }
    return task;
  }

  private requireActiveProject(projectId: string) {
    const project = this.dependencies.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (project.archivedAt) throw new ProjectArchivedError(project);
    return project;
  }

  private requireSession(sessionId: string): Session {
    const session = this.dependencies.sessions.get(sessionId);
    if (!session) {
      throw new DeveloperRecoveryInvalidError(
        `Developer session '${sessionId}' was not found`,
      );
    }
    return session;
  }

  private async restorePriorTruth(
    prepared: PreparedDeveloperRecovery,
    input: Pick<
      DeveloperAttemptResumeInput,
      'commandId' | 'taskId' | 'expectedRevision' | 'kind'
    >,
    actor: TaskActor,
  ) {
    const current = this.requireTask(input.taskId, input.expectedRevision + 1);
    if (current.lifecycleState !== 'in_progress' || current.blocked !== null) {
      throw new DeveloperRecoveryReconciliationRequiredError(
        prepared.attempt.sessionId,
        new Error('Developer recovery task truth changed before restoration'),
      );
    }
    const commandId = `${input.commandId}:command-completion-recovery`;
    if (input.kind === 'rejection') {
      if (actor.type === 'system') {
        return this.dependencies.commands.executeOnceInImmediateTransaction(
          commandId,
          () => {
            const occurredAt = this.now();
            const restored = this.dependencies.tasks.update(
              {
                ...current,
                lifecycleState: 'review',
                updatedAt: occurredAt,
              },
              current.revision,
            );
            if (!restored) {
              throw new TaskRevisionConflictError(
                this.dependencies.tasks.get(current.id) ?? current,
              );
            }
            const transition = this.dependencies.transitions.append(
              taskTransitionSchema.parse({
                id: this.createId(),
                taskId: restored.id,
                commandId,
                previousState: current.lifecycleState,
                nextState: restored.lifecycleState,
                actor,
                reason:
                  'Restore review after automated recovery command completion failed',
                occurredAt,
              }),
            );
            const event = this.dependencies.projectEvents.appendInTransaction(
              restored.projectId,
              {
                protocolVersion: 1,
                id: this.createId(),
                projectId: restored.projectId,
                occurredAt,
                type: 'task.transitioned',
                payload: { task: restored, transition },
              },
            );
            return { task: restored, transition, event };
          },
        );
      }
      return this.dependencies.taskService.transition({
        commandId,
        taskId: input.taskId,
        expectedRevision: current.revision,
        nextState: 'review',
        reason: 'Restore review after recovery command completion failed',
        actor,
      });
    }
    const blockerReason = prepared.task.blocked?.reason;
    if (!blockerReason) {
      throw new DeveloperRecoveryReconciliationRequiredError(
        prepared.attempt.sessionId,
        new Error('Developer recovery has no prior blocker to restore'),
      );
    }
    return this.dependencies.taskService.block({
      commandId,
      taskId: input.taskId,
      expectedRevision: current.revision,
      reason: blockerReason,
      actor,
    });
  }

  private recordDiagnostic(
    sessionId: string,
    payload: Record<string, unknown>,
  ): boolean {
    try {
      this.dependencies.diagnostics.insert(
        rawDiagnosticSchema.parse({
          id: this.createId(),
          sessionId,
          capturedAt: this.now(),
          payload,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async closeTerminalRuntime(
    sessionId: string,
    cycleId: string,
  ): Promise<void> {
    try {
      await this.dependencies.registry.interrupt(sessionId);
    } catch (error) {
      this.recordDiagnostic(sessionId, {
        kind: 'developer_terminal_cleanup',
        cycleId,
        outcome: 'interrupt_failed',
        error: errorDetails(error),
      });
      await this.dependencies.registry
        .emergencyClose?.(sessionId)
        .catch((cleanupError: unknown) => {
          this.recordDiagnostic(sessionId, {
            kind: 'developer_terminal_cleanup',
            cycleId,
            outcome: 'emergency_close_failed',
            error: errorDetails(cleanupError),
          });
        });
    }
  }
}
