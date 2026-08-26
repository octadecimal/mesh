import { randomUUID } from 'node:crypto';

import {
  QaAlreadyActiveError,
  qaExecutionCycleSchema,
  rawDiagnosticSchema,
  sessionSchema,
  taskActorSchema,
  type DeveloperCompletionReport,
  type DeveloperExecutionCycle,
  type Project,
  type ProjectEvent,
  type QaExecutionCycle,
  type Session,
  type Task,
  type TaskActor,
  type TaskAttempt,
  type Workspace,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import { QA_POLICY_VERSION, composeQaPrompt } from '../domain/qa-policy.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import type { AttemptService } from './attempt-service.js';
import type { QaCapabilityRegistry } from './qa-capability-registry.js';
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  TaskNotFoundError,
  TaskRevisionConflictError,
} from './task-service.js';

export type QaLaunchTrigger = 'manual' | 'autonomous_policy';

export type QaLaunchInput = {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  actor: TaskActor;
  trigger: QaLaunchTrigger;
};

export type QaRuntimeConfiguration = {
  role: 'qa';
  initialPrompt: string;
  capability: string;
  meshControls: ['submit_qa_verdict'];
  toolPolicy: {
    sourceRead: true;
    verificationCommands: true;
    sourceWrite: false;
  };
};

export type QaLaunchResult = {
  task: Task;
  attempt: TaskAttempt;
  session: Session;
  cycle: QaExecutionCycle;
  event: ProjectEvent;
};

type QaRegistry = {
  create(
    sessionId: string,
    configuration: QaRuntimeConfiguration,
  ): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  publisher: Pick<EventPublisher, 'publishProject'>;
};

type QaExecutionServiceDependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: TaskAttemptRepository;
  sessions: SessionRepository;
  workspaces: WorkspaceRepository;
  diagnostics: DiagnosticRepository;
  developerExecutions: DeveloperExecutionRepository;
  qaExecutions: QaExecutionRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  attemptService: Pick<AttemptService, 'requireQaWorkspace'>;
  capabilities: QaCapabilityRegistry;
  registry: QaRegistry;
  billingConflicts?: readonly { variable: string }[];
  now?: () => string;
  createId?: () => string;
};

type LaunchContext = {
  project: Project;
  task: Task;
  attempt: TaskAttempt;
  developerCycle: DeveloperExecutionCycle;
  developerReport: DeveloperCompletionReport;
};

class QaLaunchInvalidError extends Error {
  constructor(
    readonly code:
      | 'task_blocked'
      | 'task_transition_invalid'
      | 'task_transition_unauthorized'
      | 'developer_cycle_invalid'
      | 'developer_report_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'QaLaunchInvalidError';
  }
}

export class QaStartFailedError extends Error {
  readonly code = 'review_automation_paused';

  constructor(
    readonly sessionId: string,
    readonly cause: unknown,
  ) {
    super(
      `QA session '${sessionId}' did not start; review automation must pause`,
    );
    this.name = 'QaStartFailedError';
  }
}

export class QaAuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';

  constructor(readonly cause: unknown) {
    super('The QA launch diagnostic could not be persisted');
    this.name = 'QaAuditUnavailableError';
  }
}

const errorDetails = (error: unknown) =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };

export class QaExecutionService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: QaExecutionServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async launch(input: QaLaunchInput): Promise<QaLaunchResult> {
    const existing = this.dependencies.commands.getExisting<QaLaunchResult>(
      input.commandId,
    );
    if (existing.found) return existing.response;
    let started: { sessionId: string; capability: string } | undefined;
    try {
      return await this.dependencies.commands.executeOnce(
        input.commandId,
        async () => {
          this.assertBillingSafe();
          const actor = this.requireActor(input);
          const initial = this.requireLaunchContext(input, actor);
          const verified =
            await this.dependencies.attemptService.requireQaWorkspace({
              taskId: initial.task.id,
              attemptId: initial.attempt.id,
              workspaceId: initial.developerCycle.workspaceId,
            });
          const prepared = this.persistLaunch(
            input,
            actor,
            initial,
            verified.session,
            verified.workspace,
          );
          this.dependencies.registry.publisher.publishProject(prepared.event);

          const capability = this.dependencies.capabilities.issue({
            sessionId: prepared.session.id,
            taskId: prepared.task.id,
            attemptId: prepared.attempt.id,
            cycleId: prepared.cycle.id,
          });
          const configuration = this.createRuntime(
            prepared,
            verified.workspace,
            initial.developerReport,
            capability,
          );
          try {
            await this.dependencies.registry.create(
              prepared.session.id,
              configuration,
            );
          } catch (error) {
            this.dependencies.capabilities.invalidate(capability);
            if (!this.recordStartupFailure(prepared.session.id, error)) {
              throw new QaAuditUnavailableError(error);
            }
            throw new QaStartFailedError(prepared.session.id, error);
          }
          started = { sessionId: prepared.session.id, capability };
          const persistedSession =
            this.dependencies.sessions.get(prepared.session.id) ??
            prepared.session;
          const session = { ...persistedSession };
          if (session.claudeResumeId === undefined) {
            delete session.claudeResumeId;
          }
          return {
            ...prepared,
            session,
          };
        },
      );
    } catch (error) {
      if (started) await this.cleanupCommandCompletionFailure(started, error);
      throw error;
    }
  }

  private requireActor(input: QaLaunchInput): TaskActor {
    const actor = taskActorSchema.parse(input.actor);
    const allowed =
      (input.trigger === 'manual' && actor.type === 'human') ||
      (input.trigger === 'autonomous_policy' && actor.type === 'system');
    if (!allowed) {
      throw new QaLaunchInvalidError(
        'task_transition_unauthorized',
        `${input.trigger} QA launch is not authorized for ${actor.type} actors`,
      );
    }
    return actor;
  }

  private requireLaunchContext(
    input: QaLaunchInput,
    actor: TaskActor,
  ): LaunchContext {
    const task = this.dependencies.tasks.get(input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);
    const project = this.dependencies.projects.get(task.projectId);
    if (!project) throw new ProjectNotFoundError(task.projectId);
    if (project.archivedAt) throw new ProjectArchivedError(project);
    if (task.revision !== input.expectedRevision) {
      throw new TaskRevisionConflictError(task);
    }
    if (task.blocked) {
      throw new QaLaunchInvalidError(
        'task_blocked',
        `Task '${task.id}' is blocked`,
      );
    }
    if (task.lifecycleState !== 'review') {
      throw new QaLaunchInvalidError(
        'task_transition_invalid',
        `Task '${task.id}' is not in review`,
      );
    }
    const launchPolicyMatches =
      (input.trigger === 'manual' &&
        project.qaConfiguration.reviewPolicy === 'manual') ||
      (input.trigger === 'autonomous_policy' &&
        actor.type === 'system' &&
        project.qaConfiguration.reviewPolicy === 'autonomous_review');
    if (!launchPolicyMatches) {
      throw new QaLaunchInvalidError(
        'task_transition_unauthorized',
        'QA launch trigger does not match the current project review policy',
      );
    }

    const attempts = this.dependencies.attempts.listByTask(task.id);
    const attempt = attempts
      .filter((candidate) => candidate.unlinkedAt === null)
      .at(-1);
    if (!attempt || attempt.role !== 'developer') {
      throw new QaLaunchInvalidError(
        'developer_cycle_invalid',
        'QA requires a current Developer attempt',
      );
    }
    const developerCycles = this.dependencies.developerExecutions.listByTask(
      task.id,
    );
    if (developerCycles.some((cycle) => cycle.endedAt === null)) {
      throw new QaAlreadyActiveError(
        'A Developer role cycle is still active for this task.',
      );
    }
    const qaCycles = this.dependencies.qaExecutions.listCyclesForAttempts(
      attempts.map(({ id }) => id),
    );
    if (qaCycles.some((cycle) => cycle.endedAt === null)) {
      throw new QaAlreadyActiveError();
    }
    const developerCycle = developerCycles
      .filter((cycle) => cycle.attemptId === attempt.id)
      .at(-1);
    if (
      !developerCycle ||
      developerCycle.terminalDisposition !== 'submitted_for_review' ||
      developerCycle.endedAt === null ||
      developerCycle.completionReportId === null
    ) {
      throw new QaLaunchInvalidError(
        'developer_cycle_invalid',
        'The current Developer attempt has no terminal review submission',
      );
    }
    const developerReport = this.dependencies.developerExecutions
      .listCompletionReportsByTask(task.id)
      .find(
        (report) =>
          report.id === developerCycle.completionReportId &&
          report.cycleId === developerCycle.id,
      );
    if (!developerReport) {
      throw new QaLaunchInvalidError(
        'developer_report_invalid',
        'The current Developer completion report is missing',
      );
    }
    return { project, task, attempt, developerCycle, developerReport };
  }

  private persistLaunch(
    input: QaLaunchInput,
    actor: TaskActor,
    initial: LaunchContext,
    developerSession: Session,
    workspace: Workspace,
  ): QaLaunchResult {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.requireLaunchContext(input, actor);
      if (
        current.attempt.id !== initial.attempt.id ||
        current.developerCycle.id !== initial.developerCycle.id ||
        current.developerReport.id !== initial.developerReport.id
      ) {
        throw new QaLaunchInvalidError(
          'developer_cycle_invalid',
          'Developer review truth changed during QA launch',
        );
      }
      const currentSession = this.dependencies.sessions.get(
        current.attempt.sessionId,
      );
      const currentWorkspace = this.dependencies.workspaces.get(workspace.id);
      if (
        !currentSession ||
        currentSession.id !== developerSession.id ||
        currentSession.workspaceId !== workspace.id ||
        !currentWorkspace ||
        currentWorkspace.path !== workspace.path ||
        currentWorkspace.cleanupState !== 'active'
      ) {
        throw new QaLaunchInvalidError(
          'developer_cycle_invalid',
          'Developer workspace truth changed during QA launch',
        );
      }

      const occurredAt = this.now();
      const session = this.dependencies.sessions.create(
        sessionSchema.parse({
          id: this.createId(),
          projectId: current.project.id,
          workspaceId: workspace.id,
          title: `QA: ${current.task.title}`,
          permissionMode: developerSession.permissionMode,
          lifecycleState: 'idle',
          createdAt: occurredAt,
          updatedAt: occurredAt,
        }),
      );
      const ordinal =
        this.dependencies.qaExecutions.listCyclesForAttempts([
          current.attempt.id,
        ]).length + 1;
      const cycle = this.dependencies.qaExecutions.createCycle(
        qaExecutionCycleSchema.parse({
          id: this.createId(),
          taskId: current.task.id,
          attemptId: current.attempt.id,
          sessionId: session.id,
          ordinal,
          authorizedBy: actor,
          authorizationCommandId: input.commandId,
          policyVersion: QA_POLICY_VERSION,
          qaInstructions: {
            content: current.project.qaConfiguration.instructions.content,
            revision: current.project.qaConfiguration.instructions.revision,
          },
          taskSnapshot: {
            revision: current.task.revision,
            title: current.task.title,
            description: current.task.description,
            acceptanceCriteria: current.task.acceptanceCriteria.map(
              (text, index) => ({ id: `criterion-${index + 1}`, text }),
            ),
          },
          developerCompletionReportId: current.developerReport.id,
          workspaceId: workspace.id,
          reviewPolicy: current.project.qaConfiguration.reviewPolicy,
          reviewPolicyRevision: current.project.qaConfiguration.revision,
          automationGeneration: current.task.reviewAutomation.generation,
          rejectionOrdinal: current.task.reviewAutomation.rejectionCount,
          startedAt: occurredAt,
          endedAt: null,
          terminalDisposition: null,
          reportId: null,
          terminalCommandId: null,
          terminalEventId: null,
        }),
      );
      const event = this.dependencies.projectEvents.appendInTransaction(
        current.project.id,
        {
          protocolVersion: 1,
          id: this.createId(),
          projectId: current.project.id,
          occurredAt,
          type: 'task.qa_execution_changed',
          payload: {
            task: current.task,
            attempt: current.attempt,
            cycle,
            report: null,
          },
        },
      );
      this.dependencies.database.exec('COMMIT');
      return {
        task: current.task,
        attempt: current.attempt,
        session,
        cycle,
        event,
      };
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private createRuntime(
    prepared: QaLaunchResult,
    workspace: Workspace,
    developerReport: DeveloperCompletionReport,
    capability: string,
  ): QaRuntimeConfiguration {
    return {
      role: 'qa',
      initialPrompt: composeQaPrompt({
        policyVersion: prepared.cycle.policyVersion,
        qaInstructions: prepared.cycle.qaInstructions,
        taskSnapshot: prepared.cycle.taskSnapshot,
        workspaceId: prepared.cycle.workspaceId,
        workspacePath: workspace.path,
        developerCompletionReport: developerReport,
      }),
      capability,
      meshControls: ['submit_qa_verdict'],
      toolPolicy: {
        sourceRead: true,
        verificationCommands: true,
        sourceWrite: false,
      },
    };
  }

  private recordStartupFailure(sessionId: string, error: unknown): boolean {
    try {
      this.dependencies.diagnostics.insert(
        rawDiagnosticSchema.parse({
          id: this.createId(),
          sessionId,
          capturedAt: this.now(),
          payload: {
            kind: 'qa_execution_launch',
            stage: 'startup',
            outcome: 'failed',
            automationPauseRequired: true,
            error: errorDetails(error),
          },
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupCommandCompletionFailure(
    started: { sessionId: string; capability: string },
    error: unknown,
  ): Promise<void> {
    this.dependencies.capabilities.invalidate(started.capability);
    let cleanup: 'interrupted' | 'unknown' = 'interrupted';
    try {
      await this.dependencies.registry.interrupt(started.sessionId);
    } catch {
      cleanup = 'unknown';
    }
    try {
      this.dependencies.diagnostics.insert(
        rawDiagnosticSchema.parse({
          id: this.createId(),
          sessionId: started.sessionId,
          capturedAt: this.now(),
          payload: {
            kind: 'qa_execution_launch',
            stage: 'command_completion',
            cleanup,
            reconciliationRequired: true,
            error: errorDetails(error),
          },
        }),
      );
    } catch {
      // The original command failure remains authoritative; reconciliation is required.
    }
  }

  private assertBillingSafe(): void {
    if ((this.dependencies.billingConflicts?.length ?? 0) === 0) return;
    throw {
      code: 'billing_configuration_conflict' as const,
      message:
        'API billing environment variables must be removed before starting Claude',
      details: this.dependencies.billingConflicts,
    };
  }
}
