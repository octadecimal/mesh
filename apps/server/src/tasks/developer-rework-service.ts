import { randomUUID } from 'node:crypto';

import {
  developerExecutionCycleSchema,
  developerReviewFeedbackSchema,
  rawDiagnosticSchema,
  taskActorSchema,
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
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
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

type HumanActor = Omit<TaskActor, 'id' | 'type'> & {
  id: string;
  type: 'human';
};

export type DeveloperRecoveryKind = 'rejection' | 'unblock';

export type DeveloperAttemptResumeInput = {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  kind: DeveloperRecoveryKind;
  feedback: string;
  actor: HumanActor;
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
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  taskService: TaskService;
  registry: Registry;
  capabilities: DeveloperCapabilityRegistry;
  developerExecutionService: DeveloperExecutionService;
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
      | { sessionId: string; developerCycleId: string }
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
        completedResume = {
          sessionId: session.id,
          developerCycleId: prepared.cycle.id,
        };
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
        await this.cleanupCommandCompletionFailure(completedResume, error);
      }
      throw error;
    }
  }

  requireRecovery(
    input: Pick<
      DeveloperAttemptResumeInput,
      'taskId' | 'expectedRevision' | 'kind' | 'feedback'
    >,
    actor: TaskActor,
  ): DeveloperRecoveryContext {
    if (actor.type !== 'human') {
      throw new DeveloperRecoveryInvalidError(
        'Only a human may request Developer recovery',
      );
    }
    if (!input.feedback.trim()) {
      throw new DeveloperRecoveryInvalidError(
        'Developer recovery feedback is required',
      );
    }
    const task = this.requireTask(input.taskId, input.expectedRevision);
    authorizeTaskTransition({
      task,
      nextState: 'in_progress',
      actor,
      reason: input.feedback,
      ...(input.kind === 'unblock' ? { blocked: false } : {}),
    });
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
          this.dependencies.developerExecutionService.submitForReview({
            commandId: report.id,
            capability,
            expectedRevision,
            report,
            actor: agentActor,
          });
        },
        markBlocked: async (report) => {
          this.dependencies.developerExecutionService.markBlocked({
            commandId: report.id,
            capability,
            expectedRevision,
            report,
            actor: agentActor,
          });
        },
      },
    };
  }

  complete(
    input: Pick<
      DeveloperAttemptResumeInput,
      'commandId' | 'taskId' | 'expectedRevision' | 'kind' | 'feedback'
    >,
    actor: TaskActor,
  ) {
    const commandId = `${input.commandId}:task-recovery`;
    return input.kind === 'rejection'
      ? this.dependencies.taskService.transition({
          commandId,
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          nextState: 'in_progress',
          reason: input.feedback,
          actor,
        })
      : this.dependencies.taskService.unblock({
          commandId,
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          reason: input.feedback,
          actor,
        });
  }

  closeFailed(
    prepared: PreparedDeveloperRecovery,
    stage: 'startup' | 'resume' | 'task_transition',
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
            reviewFeedback: prepared.feedback,
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
        error: errorDetails(error),
      })
    ) {
      throw new DeveloperRecoveryReconciliationRequiredError(
        prepared.attempt.sessionId,
        error,
      );
    }
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

  private async cleanupCommandCompletionFailure(
    recovery: { sessionId: string; developerCycleId: string },
    error: unknown,
  ): Promise<void> {
    this.dependencies.capabilities.invalidateCycle(recovery.developerCycleId);
    let cleanup: 'interrupted' | 'unknown' = 'interrupted';
    try {
      await this.dependencies.registry.interrupt(recovery.sessionId);
    } catch {
      cleanup = 'unknown';
    }
    this.recordDiagnostic(recovery.sessionId, {
      kind: 'developer_recovery',
      stage: 'command_completion',
      cleanup,
      reconciliationRequired: true,
      error: errorDetails(error),
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
}
