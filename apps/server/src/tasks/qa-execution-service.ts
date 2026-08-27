import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  QaAlreadyActiveError,
  QaCapabilityInvalidError,
  QaReportIncompleteError,
  ReviewAutomationPausedError,
  idSchema,
  qaExecutionCycleSchema,
  qaReportInputSchema,
  qaReportSchema,
  rawDiagnosticSchema,
  sessionSchema,
  taskActorSchema,
  type DeveloperCompletionReport,
  type DeveloperExecutionCycle,
  type Project,
  type ProjectEvent,
  type QaExecutionCycle,
  type QaReport,
  type QaReportInput,
  type Session,
  type Task,
  type TaskActor,
  type TaskAttempt,
  type Workspace,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type { RoleRuntimeConfiguration } from '../claude/driver.js';
import { QA_POLICY_VERSION, composeQaPrompt } from '../domain/qa-policy.js';
import { authorizeQaVerdict } from '../domain/task-lifecycle.js';
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
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import type {
  QaVerificationCommand,
  QaVerificationResult,
} from '../platform/qa-verification-runner.js';
import { QaWorkspaceReader } from '../platform/qa-workspace-reader.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import type { AttemptService } from './attempt-service.js';
import type { QaCapabilityRegistry } from './qa-capability-registry.js';
import { planQaVerdict } from './review-automation-service.js';
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

export type QaRuntimeConfiguration = RoleRuntimeConfiguration & {
  capability: string;
};

export type QaLaunchResult = {
  task: Task;
  attempt: TaskAttempt;
  session: Session;
  cycle: QaExecutionCycle;
  event: ProjectEvent;
};

export type QaSubmitVerdictInput = {
  commandId: string;
  capability: string;
  expectedRevision: number;
  report: QaReportInput;
  actor: TaskActor;
};

export type QaVerdictOutcome = {
  task: Task;
  attempt: TaskAttempt;
  cycle: QaExecutionCycle;
  report: QaReport;
  event: ProjectEvent;
  events: ProjectEvent[];
};

export type QaRepairInterruptedInput = {
  commandId: string;
  taskId: string;
  cycleId: string;
  expectedRevision: number;
  actor: TaskActor;
};

export type QaRepairInterruptedOutcome = {
  task: Task;
  attempt: TaskAttempt;
  cycle: QaExecutionCycle;
  event: ProjectEvent;
  events: ProjectEvent[];
};

type QaRegistry = {
  create(
    sessionId: string,
    configuration: QaRuntimeConfiguration,
  ): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  reserveRepair(sessionId: string): (() => void) | undefined;
  publisher: Pick<EventPublisher, 'publishProject'>;
};

type QaExecutionServiceDependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  transitions: TaskTransitionRepository;
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
  verificationRunner: {
    captureTrackedSource(path: string, signal?: AbortSignal): Promise<string>;
    run(
      path: string,
      input: QaVerificationCommand,
      options?: { signal?: AbortSignal },
    ): Promise<QaVerificationResult>;
  };
  workspaceReader?: Pick<QaWorkspaceReader, 'read' | 'list' | 'search'>;
  afterRejectedVerdict?: (input: {
    taskId: string;
    cycleId: string;
  }) => Promise<void>;
  afterInterruptedRepair?: () => void;
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

type VerificationState = {
  sessionId: string;
  workspacePath: string;
  baseline: string;
  latest: string;
  commands: Array<{ command: string; outcome: string }>;
  mutationDetected: boolean;
  operation: 'idle' | 'verifying' | 'submitting';
  abortController: AbortController;
  failureRecorded: boolean;
};

type SourceMutationContext = {
  taskId: string;
  cycleId: string;
  sessionId: string;
  workspaceBaseline: string;
};

type VerificationFailureCode =
  | 'qa_workspace_search_cancelled'
  | 'qa_verification_cancelled'
  | 'qa_verification_executable_unavailable'
  | 'qa_verification_output_limit_exceeded'
  | 'qa_verification_termination_failed'
  | 'qa_verification_timed_out';

const verificationCommandSchema = z.object({
  executable: z.string().trim().min(1),
  args: z.array(z.string()).min(1).max(64),
});

const workspaceReadSchema = z.object({
  path: z.string().trim().min(1).max(1_024),
});

const workspaceListSchema = z.object({
  path: z.string().trim().min(1).max(1_024).default('.'),
});

const workspaceSearchSchema = z.object({
  path: z.string().trim().min(1).max(1_024).default('.'),
  query: z.string().min(1).max(512),
});

const taskFingerprint = (task: Task): string =>
  `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        priority: task.priority,
        rank: task.rank,
        labels: task.labels,
        notes: task.notes,
        lifecycleState: task.lifecycleState,
        blocked: task.blocked,
      }),
    )
    .digest('hex')}`;

class QaLaunchInvalidError extends Error {
  constructor(
    readonly code:
      | 'task_blocked'
      | 'task_transition_invalid'
      | 'task_transition_unauthorized'
      | 'developer_cycle_invalid'
      | 'developer_report_invalid'
      | 'qa_cycle_invalid'
      | 'qa_cycle_active',
    message: string,
  ) {
    super(message);
    this.name = 'QaLaunchInvalidError';
  }
}

class QaControlBusyError extends Error {
  readonly code = 'qa_control_busy';

  constructor() {
    super('Another QA control is already running for this cycle.');
    this.name = 'QaControlBusyError';
  }
}

class QaSourceMutationDetectedError extends Error {
  readonly code = 'qa_source_mutation_detected';

  constructor() {
    super('Tracked source changed during QA verification.');
    this.name = 'QaSourceMutationDetectedError';
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

const safeQaControlErrorCodes = new Set([
  'invalid_input',
  'qa_control_failed',
  'qa_capability_invalid',
  'qa_report_incomplete',
  'project_not_found',
  'project_archived',
  'task_not_found',
  'task_revision_conflict',
  'task_transition_invalid',
  'task_transition_unauthorized',
  'review_automation_paused',
  'qa_verification_command_rejected',
  'qa_source_mutation_detected',
  'qa_control_busy',
  'qa_workspace_path_rejected',
  'qa_workspace_search_cancelled',
  'qa_verification_cancelled',
  'qa_verification_executable_unavailable',
  'qa_verification_output_limit_exceeded',
  'qa_verification_termination_failed',
  'qa_verification_timed_out',
]);

const qaControlFailure = (error: unknown) => {
  const candidate =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : typeof error === 'string'
        ? error
        : undefined;
  const code =
    candidate && safeQaControlErrorCodes.has(candidate)
      ? candidate
      : 'qa_control_failed';
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', code }),
      },
    ],
    isError: true,
  };
};

export class QaExecutionService {
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly verificationStates = new Map<string, VerificationState>();
  private readonly workspaceReader: Pick<
    QaWorkspaceReader,
    'read' | 'list' | 'search'
  >;

  constructor(private readonly dependencies: QaExecutionServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
    this.workspaceReader =
      dependencies.workspaceReader ?? new QaWorkspaceReader();
  }

  cancelRuntime(sessionId: string): void {
    for (const verification of this.verificationStates.values()) {
      if (verification.sessionId === sessionId) {
        verification.abortController.abort();
      }
    }
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
          const workspaceBaseline =
            await this.dependencies.verificationRunner.captureTrackedSource(
              verified.workspace.path,
            );
          const prepared = this.persistLaunch(
            input,
            actor,
            initial,
            verified.session,
            verified.workspace,
            workspaceBaseline,
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

  async submitVerdict(input: QaSubmitVerdictInput): Promise<QaVerdictOutcome> {
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<QaVerdictOutcome>(commandId);
    if (existing.found) return existing.response;

    const reportInput = this.parseReport(input.report);
    const actor = taskActorSchema.parse(input.actor);
    const initialContext = this.requireVerdictContext(input);
    authorizeQaVerdict({ task: initialContext.task, actor });
    this.requireValidReport(initialContext.cycle, reportInput);
    const verification = initialContext.verification;
    if (verification.operation !== 'idle') throw new QaControlBusyError();
    verification.operation = 'submitting';

    try {
      await this.requireStableSourceState(
        {
          taskId: initialContext.task.id,
          cycleId: initialContext.cycle.id,
          sessionId: initialContext.cycle.sessionId,
          workspaceBaseline: initialContext.cycle.workspaceBaseline,
        },
        input.capability,
        verification,
      );

      const result =
        this.dependencies.commands.executeOnceInImmediateTransaction(
          commandId,
          () => {
            const context = this.requireVerdictContext(input);
            authorizeQaVerdict({ task: context.task, actor });

            const occurredAt = this.now();
            const eventId = idSchema.parse(this.createId());
            const report = this.dependencies.qaExecutions.insertReport(
              qaReportSchema.parse({
                ...reportInput,
                verificationCommands: context.verification.commands,
                workspaceBefore: context.verification.baseline,
                workspaceAfter: context.verification.latest,
                id: idSchema.parse(this.createId()),
                cycleId: context.cycle.id,
                createdAt: occurredAt,
              }),
            );
            const cycle = this.dependencies.qaExecutions.completeCycle(
              context.cycle.id,
              {
                endedAt: occurredAt,
                terminalDisposition: report.disposition,
                reportId: report.id,
                terminalCommandId: commandId,
                terminalEventId: eventId,
              },
            );
            if (!cycle) {
              throw new QaCapabilityInvalidError(
                'The QA capability is bound to a terminal cycle.',
              );
            }
            const event = this.dependencies.projectEvents.appendInTransaction(
              context.task.projectId,
              {
                protocolVersion: 1,
                id: eventId,
                projectId: context.task.projectId,
                occurredAt,
                type: 'task.qa_execution_changed',
                payload: {
                  task: context.task,
                  attempt: context.attempt,
                  cycle,
                  report,
                },
              },
            );
            const plan = planQaVerdict(
              {
                task: context.task,
                attempt: context.attempt,
                cycle,
                report,
                commandId,
                occurredAt,
              },
              {
                projects: this.dependencies.projects,
                tasks: this.dependencies.tasks,
                qaExecutions: this.dependencies.qaExecutions,
                transitions: this.dependencies.transitions,
                projectEvents: this.dependencies.projectEvents,
                createId: this.createId,
              },
            );
            return {
              task: plan.task,
              attempt: context.attempt,
              cycle,
              report,
              event,
              events: [event, ...plan.events],
            };
          },
        );
      this.dependencies.capabilities.invalidate(input.capability);
      result.events.forEach((event) =>
        this.dependencies.registry.publisher.publishProject(event),
      );
      return result;
    } finally {
      if (verification.operation === 'submitting') {
        verification.operation = 'idle';
      }
    }
  }

  repairInterrupted(
    input: QaRepairInterruptedInput,
  ): QaRepairInterruptedOutcome {
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<QaRepairInterruptedOutcome>(
        commandId,
      );
    if (existing.found) {
      this.dependencies.afterInterruptedRepair?.();
      return existing.response;
    }

    const candidate = this.dependencies.qaExecutions.getCycle(
      idSchema.parse(input.cycleId),
    );
    const releaseRepair = candidate
      ? this.dependencies.registry.reserveRepair(candidate.sessionId)
      : () => undefined;
    if (!releaseRepair) {
      throw new QaLaunchInvalidError(
        'qa_cycle_active',
        'A live or attaching QA runtime cannot be repaired as interrupted',
      );
    }

    try {
      const result =
        this.dependencies.commands.executeOnceInImmediateTransaction(
          commandId,
          () => {
            const actor = taskActorSchema.parse(input.actor);
            if (actor.type !== 'human') {
              throw new QaLaunchInvalidError(
                'task_transition_unauthorized',
                'Only a human may repair an interrupted QA cycle',
              );
            }
            const task = this.dependencies.tasks.get(
              idSchema.parse(input.taskId),
            );
            if (!task) throw new TaskNotFoundError(input.taskId);
            const project = this.dependencies.projects.get(task.projectId);
            if (!project) throw new ProjectNotFoundError(task.projectId);
            if (project.archivedAt) throw new ProjectArchivedError(project);
            if (task.revision !== input.expectedRevision) {
              throw new TaskRevisionConflictError(task);
            }
            const current = this.dependencies.qaExecutions.getCycle(
              idSchema.parse(input.cycleId),
            );
            if (
              !current ||
              current.taskId !== task.id ||
              current.endedAt !== null
            ) {
              throw new QaLaunchInvalidError(
                'qa_cycle_invalid',
                'The QA cycle is not an active cycle for this task',
              );
            }
            const session = this.dependencies.sessions.get(current.sessionId);
            if (
              session &&
              [
                'starting',
                'running',
                'waiting_for_input',
                'interrupting',
              ].includes(session.lifecycleState)
            ) {
              throw new QaLaunchInvalidError(
                'qa_cycle_active',
                'A live QA runtime cannot be repaired as interrupted',
              );
            }
            const attempt = this.dependencies.attempts
              .listByTask(task.id)
              .find(({ id }) => id === current.attemptId);
            if (!attempt) {
              throw new QaLaunchInvalidError(
                'qa_cycle_invalid',
                'The QA cycle no longer has its owning attempt',
              );
            }
            const occurredAt = this.now();
            const eventId = idSchema.parse(this.createId());
            const cycle = this.dependencies.qaExecutions.interruptCycle(
              current.id,
              {
                endedAt: occurredAt,
                terminalCommandId: commandId,
                terminalEventId: eventId,
              },
            );
            if (!cycle) {
              throw new QaLaunchInvalidError(
                'qa_cycle_invalid',
                'The QA cycle became terminal before repair completed',
              );
            }
            const event = this.dependencies.projectEvents.appendInTransaction(
              task.projectId,
              {
                protocolVersion: 1,
                id: eventId,
                projectId: task.projectId,
                occurredAt,
                type: 'task.qa_execution_changed',
                payload: { task, attempt, cycle, report: null },
              },
            );
            const events = [event];
            for (const action of this.dependencies.qaExecutions
              .listPendingAutomationActions()
              .filter(
                (candidate) =>
                  candidate.taskId === task.id &&
                  candidate.attemptId === attempt.id &&
                  (candidate.sourceCycleId === current.id ||
                    candidate.actionKind === 'launch_qa'),
              )) {
              const completed =
                this.dependencies.qaExecutions.completeAutomationAction(
                  action.id,
                  {
                    status: 'failed',
                    errorCode: 'qa_cycle_interrupted',
                    completedAt: occurredAt,
                  },
                );
              if (!completed) continue;
              events.push(
                this.dependencies.projectEvents.appendInTransaction(
                  task.projectId,
                  {
                    protocolVersion: 1,
                    id: idSchema.parse(this.createId()),
                    projectId: task.projectId,
                    occurredAt,
                    type: 'task.review_automation_changed',
                    payload: {
                      task,
                      automation: task.reviewAutomation,
                      action: completed,
                    },
                  },
                ),
              );
            }
            return { task, attempt, cycle, event, events };
          },
        );
      this.dependencies.capabilities.invalidateSession(result.cycle.sessionId);
      result.events.forEach((event) =>
        this.dependencies.registry.publisher.publishProject(event),
      );
      this.dependencies.afterInterruptedRepair?.();
      return result;
    } finally {
      releaseRepair();
    }
  }

  private parseReport(report: QaReportInput): QaReportInput {
    const parsed = qaReportInputSchema.safeParse(report);
    if (!parsed.success) {
      throw new QaReportIncompleteError(
        parsed.error.issues[0]?.message ?? 'The QA report is invalid.',
      );
    }
    return parsed.data;
  }

  private requireVerdictContext(input: QaSubmitVerdictInput): {
    task: Task;
    attempt: TaskAttempt;
    cycle: QaExecutionCycle;
    verification: VerificationState;
  } {
    const binding = this.dependencies.capabilities.resolve(input.capability);
    const task = this.dependencies.tasks.get(binding.taskId);
    if (!task) throw new TaskNotFoundError(binding.taskId);
    const project = this.dependencies.projects.get(task.projectId);
    if (!project) throw new ProjectNotFoundError(task.projectId);
    if (project.archivedAt) throw new ProjectArchivedError(project);
    const currentAttempt = this.dependencies.attempts
      .listByTask(task.id)
      .filter((attempt) => attempt.unlinkedAt === null)
      .at(-1);
    const cycle = this.dependencies.qaExecutions.getCycle(binding.cycleId);
    const verification = this.verificationStates.get(binding.cycleId);
    const session = this.dependencies.sessions.get(binding.sessionId);
    const developerCycleActive = this.dependencies.developerExecutions
      .listByTask(task.id)
      .some((candidate) => candidate.endedAt === null);
    if (
      !currentAttempt ||
      currentAttempt.id !== binding.attemptId ||
      currentAttempt.taskId !== binding.taskId ||
      currentAttempt.role !== 'developer' ||
      !cycle ||
      cycle.endedAt !== null ||
      cycle.taskId !== binding.taskId ||
      cycle.attemptId !== binding.attemptId ||
      cycle.sessionId !== binding.sessionId ||
      !session ||
      session.projectId !== task.projectId ||
      session.workspaceId !== cycle.workspaceId ||
      developerCycleActive ||
      !verification ||
      verification.mutationDetected
    ) {
      throw new QaCapabilityInvalidError(
        'The QA capability does not match the active current task attempt.',
      );
    }
    if (
      task.revision !== input.expectedRevision &&
      (cycle.taskFingerprint === 'legacy-unavailable' ||
        cycle.taskFingerprint !== taskFingerprint(task))
    ) {
      throw new TaskRevisionConflictError(task);
    }
    return { task, attempt: currentAttempt, cycle, verification };
  }

  private requireValidReport(
    cycle: QaExecutionCycle,
    report: QaReportInput,
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
        throw new QaReportIncompleteError(
          'QA report criterion coverage is invalid.',
        );
      }
      reported.add(result.criterionId);
    }
    if (reported.size !== expected.size) {
      throw new QaReportIncompleteError(
        'QA report must cover every snapshotted criterion.',
      );
    }
    if (
      report.disposition === 'rejected' &&
      report.criterionResults.every(({ status }) => status === 'passed')
    ) {
      throw new QaReportIncompleteError(
        'Rejected QA reports require a failed or skipped criterion.',
      );
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
        (project.qaConfiguration.reviewPolicy === 'manual' ||
          task.reviewAutomation.status !== 'enabled')) ||
      (input.trigger === 'autonomous_policy' &&
        actor.type === 'system' &&
        project.qaConfiguration.reviewPolicy === 'autonomous_review');
    if (!launchPolicyMatches) {
      throw new QaLaunchInvalidError(
        'task_transition_unauthorized',
        'QA launch trigger does not match the current project review policy',
      );
    }
    if (
      input.trigger === 'autonomous_policy' &&
      task.reviewAutomation.status !== 'enabled'
    ) {
      throw new ReviewAutomationPausedError(
        `Review automation is ${task.reviewAutomation.status} for task '${task.id}'.`,
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
    workspaceBaseline: string,
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
          workspaceBaseline,
          taskFingerprint: taskFingerprint(current.task),
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
    const commandId = `${prepared.cycle.id}:submit-qa-verdict`;
    const actor = taskActorSchema.parse({
      type: 'agent',
      id: `qa-${prepared.session.id}`,
    });
    const verification: VerificationState = {
      sessionId: prepared.session.id,
      workspacePath: workspace.path,
      baseline: prepared.cycle.workspaceBaseline,
      latest: prepared.cycle.workspaceBaseline,
      commands: [],
      mutationDetected: false,
      operation: 'idle',
      abortController: new AbortController(),
      failureRecorded: false,
    };
    this.verificationStates.set(prepared.cycle.id, verification);
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
      availableTools: [],
      allowedTools: [
        'mcp__mesh_qa__read_workspace_file',
        'mcp__mesh_qa__list_workspace_files',
        'mcp__mesh_qa__search_workspace_text',
        'mcp__mesh_qa__run_verification',
        'mcp__mesh_qa__submit_qa_verdict',
      ],
      disallowedTools: [
        'Bash',
        'Read',
        'Glob',
        'Grep',
        'Write',
        'Edit',
        'NotebookEdit',
      ],
      controlServer: {
        name: 'mesh_qa',
        version: '1',
        tools: [
          {
            name: 'read_workspace_file',
            description:
              'Read one bounded text file inside the assigned QA workspace.',
            inputSchema: workspaceReadSchema.shape,
            execute: async (input) => {
              const parsed = workspaceReadSchema.safeParse(input);
              if (!parsed.success) return qaControlFailure('invalid_input');
              try {
                const result = await this.workspaceReader.read(
                  verification.workspacePath,
                  parsed.data.path,
                );
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify(result) },
                  ],
                };
              } catch (error) {
                return qaControlFailure(error);
              }
            },
          },
          {
            name: 'list_workspace_files',
            description:
              'List one directory inside the assigned QA workspace without shell access.',
            inputSchema: workspaceListSchema.shape,
            execute: async (input) => {
              const parsed = workspaceListSchema.safeParse(input);
              if (!parsed.success) return qaControlFailure('invalid_input');
              try {
                const result = await this.workspaceReader.list(
                  verification.workspacePath,
                  parsed.data.path,
                );
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify(result) },
                  ],
                };
              } catch (error) {
                return qaControlFailure(error);
              }
            },
          },
          {
            name: 'search_workspace_text',
            description:
              'Search bounded text content inside the assigned QA workspace without shell access.',
            inputSchema: workspaceSearchSchema.shape,
            execute: async (input) => {
              const parsed = workspaceSearchSchema.safeParse(input);
              if (!parsed.success) return qaControlFailure('invalid_input');
              try {
                const result = await this.workspaceReader.search(
                  verification.workspacePath,
                  parsed.data.path,
                  parsed.data.query,
                  { signal: verification.abortController.signal },
                );
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify(result) },
                  ],
                };
              } catch (error) {
                const code = this.verificationInterruptionCode(error);
                if (code) {
                  await this.pauseForVerificationFailure(
                    {
                      taskId: prepared.task.id,
                      cycleId: prepared.cycle.id,
                      sessionId: prepared.session.id,
                      workspaceBaseline: prepared.cycle.workspaceBaseline,
                    },
                    capability,
                    code,
                    verification,
                  );
                }
                return qaControlFailure(error);
              }
            },
          },
          {
            name: 'run_verification',
            description:
              'Run one constrained verification command in the assigned workspace. Shells and source-authoring commands are unavailable.',
            inputSchema: verificationCommandSchema.shape,
            execute: async (input) => {
              const parsed = verificationCommandSchema.safeParse(input);
              if (!parsed.success) return qaControlFailure('invalid_input');
              if (verification.mutationDetected) {
                return qaControlFailure('qa_source_mutation_detected');
              }
              if (verification.operation !== 'idle') {
                return qaControlFailure('qa_control_busy');
              }
              verification.operation = 'verifying';
              try {
                const result = await this.dependencies.verificationRunner.run(
                  verification.workspacePath,
                  parsed.data,
                  { signal: verification.abortController.signal },
                );
                verification.commands.push({
                  command: result.command,
                  outcome:
                    result.exitCode === 0
                      ? 'passed'
                      : `failed with exit code ${result.exitCode}`,
                });
                await this.requireStableSourceState(
                  {
                    taskId: prepared.task.id,
                    cycleId: prepared.cycle.id,
                    sessionId: prepared.session.id,
                    workspaceBaseline: prepared.cycle.workspaceBaseline,
                  },
                  capability,
                  verification,
                );
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({
                        status: 'verification_completed',
                        command: result.command,
                        exitCode: result.exitCode,
                        stdout: result.stdout,
                        stderr: result.stderr,
                      }),
                    },
                  ],
                };
              } catch (error) {
                const code = this.verificationInterruptionCode(error);
                if (code) {
                  await this.pauseForVerificationFailure(
                    {
                      taskId: prepared.task.id,
                      cycleId: prepared.cycle.id,
                      sessionId: prepared.session.id,
                      workspaceBaseline: prepared.cycle.workspaceBaseline,
                    },
                    capability,
                    code,
                    verification,
                  );
                }
                return qaControlFailure(error);
              } finally {
                if (verification.operation === 'verifying') {
                  verification.operation = 'idle';
                }
              }
            },
          },
          {
            name: 'submit_qa_verdict',
            description:
              'Submit the one structured verification verdict for this QA cycle.',
            inputSchema: qaReportInputSchema.shape,
            execute: async (input) => {
              const parsed = qaReportInputSchema.safeParse(input);
              if (!parsed.success) return qaControlFailure('invalid_input');
              try {
                const outcome = await this.submitVerdict({
                  commandId,
                  capability,
                  expectedRevision: prepared.task.revision,
                  report: parsed.data,
                  actor,
                });
                if (
                  outcome.report.disposition === 'rejected' &&
                  outcome.cycle.reviewPolicy === 'autonomous_review' &&
                  outcome.task.reviewAutomation.status === 'enabled'
                ) {
                  try {
                    await this.dependencies.afterRejectedVerdict?.({
                      taskId: outcome.task.id,
                      cycleId: outcome.cycle.id,
                    });
                  } finally {
                    await this.dependencies.registry.interrupt(
                      prepared.session.id,
                    );
                  }
                } else {
                  await this.dependencies.registry.interrupt(
                    prepared.session.id,
                  );
                }
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({
                        status: 'submitted_qa_verdict',
                      }),
                    },
                  ],
                };
              } catch (error) {
                return qaControlFailure(error);
              }
            },
          },
        ],
      },
    };
  }

  private async requireStableSourceState(
    context: SourceMutationContext,
    capability: string,
    verification: VerificationState,
  ): Promise<void> {
    try {
      verification.latest =
        await this.dependencies.verificationRunner.captureTrackedSource(
          verification.workspacePath,
          verification.abortController.signal,
        );
    } catch (error) {
      const interruptionCode = this.verificationInterruptionCode(error);
      if (interruptionCode) {
        await this.pauseForVerificationFailure(
          context,
          capability,
          interruptionCode,
          verification,
        );
        throw error;
      }
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'qa_source_snapshot_unstable'
      ) {
        throw error;
      }
      verification.mutationDetected = true;
      await this.pauseForSourceMutation(context, capability);
      throw new QaSourceMutationDetectedError();
    }
    if (verification.latest === verification.baseline) return;

    verification.mutationDetected = true;
    await this.pauseForSourceMutation(context, capability);
    throw new QaSourceMutationDetectedError();
  }

  private verificationInterruptionCode(
    error: unknown,
  ): VerificationFailureCode | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return undefined;
    }
    return error.code === 'qa_workspace_search_cancelled' ||
      error.code === 'qa_verification_cancelled' ||
      error.code === 'qa_verification_executable_unavailable' ||
      error.code === 'qa_verification_output_limit_exceeded' ||
      error.code === 'qa_verification_termination_failed' ||
      error.code === 'qa_verification_timed_out'
      ? error.code
      : undefined;
  }

  private async pauseForVerificationFailure(
    context: SourceMutationContext,
    capability: string,
    code: VerificationFailureCode,
    verification: VerificationState,
  ): Promise<void> {
    if (verification.failureRecorded) return;
    let event: ProjectEvent | undefined;
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const task = this.dependencies.tasks.get(context.taskId);
      if (!task) throw new TaskNotFoundError(context.taskId);
      const occurredAt = this.now();
      const paused = this.dependencies.tasks.update(
        {
          ...task,
          reviewAutomation: {
            ...task.reviewAutomation,
            status: 'paused',
            pauseReason:
              code === 'qa_workspace_search_cancelled'
                ? 'QA workspace search was interrupted; human inspection is required.'
                : code === 'qa_verification_executable_unavailable'
                  ? 'A trusted QA verification executable is unavailable; human inspection is required.'
                  : code === 'qa_verification_timed_out'
                    ? 'QA verification timed out; human inspection is required.'
                    : code === 'qa_verification_output_limit_exceeded'
                      ? 'QA verification exceeded its output limit; human inspection is required.'
                      : code === 'qa_verification_termination_failed'
                        ? 'QA verification process ownership failed; human inspection is required.'
                        : 'QA verification was interrupted; human inspection is required.',
            updatedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
        task.revision,
      );
      if (!paused) throw new TaskRevisionConflictError(task);
      this.dependencies.diagnostics.insert(
        rawDiagnosticSchema.parse({
          id: this.createId(),
          sessionId: context.sessionId,
          capturedAt: occurredAt,
          payload: {
            kind: 'qa_verification_failure',
            cycleId: context.cycleId,
            code,
            automationPauseRequired: true,
          },
        }),
      );
      event = this.dependencies.projectEvents.appendInTransaction(
        paused.projectId,
        {
          protocolVersion: 1,
          id: this.createId(),
          projectId: paused.projectId,
          occurredAt,
          type: 'task.review_automation_changed',
          payload: {
            task: paused,
            automation: paused.reviewAutomation,
            action: null,
          },
        },
      );
      this.dependencies.database.exec('COMMIT');
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
    verification.failureRecorded = true;
    if (event) this.dependencies.registry.publisher.publishProject(event);
    this.dependencies.capabilities.invalidate(capability);
    if (
      code !== 'qa_verification_cancelled' &&
      code !== 'qa_workspace_search_cancelled'
    ) {
      await this.dependencies.registry.interrupt(context.sessionId);
    }
  }

  private async pauseForSourceMutation(
    context: SourceMutationContext,
    capability: string,
  ): Promise<void> {
    let event: ProjectEvent | undefined;
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const task = this.dependencies.tasks.get(context.taskId);
      if (!task) throw new TaskNotFoundError(context.taskId);
      const occurredAt = this.now();
      const paused = this.dependencies.tasks.update(
        {
          ...task,
          reviewAutomation: {
            ...task.reviewAutomation,
            status: 'paused',
            pauseReason:
              'QA verification changed tracked source; human repair is required.',
            updatedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
        task.revision,
      );
      if (!paused) throw new TaskRevisionConflictError(task);
      this.dependencies.diagnostics.insert(
        rawDiagnosticSchema.parse({
          id: this.createId(),
          sessionId: context.sessionId,
          capturedAt: occurredAt,
          payload: {
            kind: 'qa_source_mutation',
            cycleId: context.cycleId,
            workspaceBefore: context.workspaceBaseline,
            workspaceAfter: this.verificationStates.get(context.cycleId)
              ?.latest,
          },
        }),
      );
      event = this.dependencies.projectEvents.appendInTransaction(
        paused.projectId,
        {
          protocolVersion: 1,
          id: this.createId(),
          projectId: paused.projectId,
          occurredAt,
          type: 'task.review_automation_changed',
          payload: {
            task: paused,
            automation: paused.reviewAutomation,
            action: null,
          },
        },
      );
      this.dependencies.database.exec('COMMIT');
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
    if (event) this.dependencies.registry.publisher.publishProject(event);
    this.dependencies.capabilities.invalidate(capability);
    await this.dependencies.registry.interrupt(context.sessionId);
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
