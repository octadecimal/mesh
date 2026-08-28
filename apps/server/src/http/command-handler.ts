import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';
import {
  commandSchema,
  projectSchema,
  sessionDiagnosticsSchema,
  sessionHistorySchema,
  sessionSchema,
  workspaceSchema,
  type Command,
  type MutatingCommand,
  type ProjectEvent,
  type Session,
} from '@mesh-session-platform/contracts';

import type { ClaudeSessionDriver } from '../claude/driver.js';
import type { Database } from '../db/database.js';
import type { GitAdapter } from '../platform/git.js';
import {
  resolveWorkspacePath,
  type AbsolutePath,
  type ResolveWorkspacePathOptions,
} from '../platform/paths.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { LayoutRepository } from '../repositories/layout-repository.js';
import type { PlanningRepository } from '../repositories/planning-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import { assertWorkspaceAvailable } from '../repositories/workspace-occupancy.js';
import type { SessionRegistry } from '../runtime/session-registry.js';
import type { TaskMutationResult, TaskService } from '../tasks/task-service.js';
import type {
  AttemptMutationResult,
  AttemptService,
} from '../tasks/attempt-service.js';
import type { DeveloperExecutionService } from '../tasks/developer-execution-service.js';
import type {
  QaExecutionService,
  QaLaunchResult,
  QaVerdictOutcome,
} from '../tasks/qa-execution-service.js';
import type { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import type {
  ReviewAutomationCommandOutcome,
  ReviewAutomationService,
} from '../tasks/review-automation-service.js';
import type { ProjectRunService } from '../tasks/project-run-service.js';
import type {
  PlanningExecutionService,
  PlanningMutationResult,
} from '../tasks/planning-execution-service.js';
import type {
  PlanApprovalResult,
  PlanApprovalService,
} from '../tasks/plan-approval-service.js';
import type {
  DependencyMutationResult,
  TaskDependencyService,
} from '../tasks/task-dependency-service.js';
import {
  RepositoryIdentityError,
  resolveRepositoryIdentity,
  type RepositoryIdentityResolver,
} from '../projects/repository-identity.js';
import { CommandError } from './errors.js';

const commandResponseSchema = z.object({
  protocolVersion: z.literal(1),
  commandType: z.string(),
  result: z.unknown(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .default([]),
});

export type CommandResponse = z.infer<typeof commandResponseSchema>;

type PlanningExecutionBoundary = Pick<
  PlanningExecutionService,
  'start' | 'requestRevision' | 'resume' | 'retry' | 'cancel'
>;
type PlanApprovalBoundary = Pick<PlanApprovalService, 'approve' | 'reject'>;
type TaskDependencyBoundary = Pick<TaskDependencyService, 'add' | 'remove'>;

export interface CommandDependencies {
  database: Database;
  projects: ProjectRepository;
  attempts: Pick<
    TaskAttemptRepository,
    'getCurrentBySession' | 'listBySession'
  >;
  projectEvents: ProjectEventRepository;
  workspaces: WorkspaceRepository;
  sessions: SessionRepository;
  events: EventRepository;
  diagnostics: DiagnosticRepository;
  layouts: LayoutRepository;
  commands: CommandRepository;
  plans: Pick<PlanningRepository, 'getDetails' | 'listSummaries'>;
  taskService: TaskService;
  tasks: Pick<TaskRepository, 'get'>;
  qaExecutions: Pick<
    QaExecutionRepository,
    'getActiveCycleBySession' | 'hasCycleForSession'
  >;
  attemptService?: AttemptService;
  developerExecutionService?: DeveloperExecutionService;
  qaExecutionService?: Pick<
    QaExecutionService,
    'launch' | 'submitVerdict' | 'repairInterrupted'
  >;
  reviewAutomationService?: Pick<
    ReviewAutomationService,
    'afterDeveloperSubmission' | 'afterQaVerdict' | 'enable' | 'pause'
  >;
  projectRunService?: Pick<
    ProjectRunService,
    'startRun' | 'pauseRun' | 'resumeRun' | 'stopRun' | 'observeTaskOutcome'
  >;
  planningExecutionService?: PlanningExecutionBoundary;
  planApprovalService?: PlanApprovalBoundary;
  taskDependencyService?: TaskDependencyBoundary;
  registry: SessionRegistry;
  driver: ClaudeSessionDriver;
  git?: Pick<GitAdapter, 'createWorktree' | 'removeOwnedWorktree'>;
  pathOptions?: ResolveWorkspacePathOptions;
  resolveIdentity?: RepositoryIdentityResolver;
  billingConflicts?: readonly { variable: string }[];
  now?: () => string;
  createId?: () => string;
}

const response = (
  commandType: string,
  result: unknown,
  warnings: Array<{ code: string; message: string }> = [],
): CommandResponse =>
  commandResponseSchema.parse({
    protocolVersion: 1,
    commandType,
    result: JSON.parse(JSON.stringify(result)),
    warnings,
  });

const taskResponse = (
  result: TaskMutationResult,
  dependencies: CommandDependencies,
) => {
  dependencies.registry.publisher.publishProject(result.event);
  return {
    ...result,
    projectEventCursor: result.event.sequence,
  };
};

const attemptResponse = (result: AttemptMutationResult) => ({
  ...result,
  projectEventCursor: result.event.sequence,
});

const requireAttemptService = (dependencies: CommandDependencies) => {
  if (!dependencies.attemptService) {
    throw new CommandError(
      'invalid_command',
      'Task attempt support is unavailable',
    );
  }
  return dependencies.attemptService;
};

const requireDeveloperExecutionService = (
  dependencies: CommandDependencies,
) => {
  if (!dependencies.developerExecutionService) {
    throw new CommandError(
      'invalid_command',
      'Developer execution support is unavailable',
    );
  }
  return dependencies.developerExecutionService;
};

const requireQaExecutionService = (dependencies: CommandDependencies) => {
  if (!dependencies.qaExecutionService) {
    throw new CommandError(
      'invalid_command',
      'QA execution support is unavailable',
    );
  }
  return dependencies.qaExecutionService;
};

const requireReviewAutomationService = (dependencies: CommandDependencies) => {
  if (!dependencies.reviewAutomationService) {
    throw new CommandError(
      'invalid_command',
      'Review automation support is unavailable',
    );
  }
  return dependencies.reviewAutomationService;
};

const requireProjectRunService = (dependencies: CommandDependencies) => {
  if (!dependencies.projectRunService) {
    throw new CommandError(
      'invalid_command',
      'Project run support is unavailable',
    );
  }
  return dependencies.projectRunService;
};

const followUpErrorCodes = new Set([
  'audit_unavailable',
  'developer_resume_unavailable',
  'review_automation_paused',
  'unsafe_qa_workspace',
]);

const safeErrorCode = (error: unknown, fallback: string): string => {
  const candidate =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  return candidate && followUpErrorCodes.has(candidate) ? candidate : fallback;
};

const qaLaunchResponse = (result: QaLaunchResult) => ({
  task: result.task,
  attempt: result.attempt,
  session: result.session,
  cycle: result.cycle,
  event: result.event,
  projectEventCursor: result.event.sequence,
});

const qaVerdictResponse = (
  result: QaVerdictOutcome,
  projectEventCursor = result.events.at(-1)?.sequence ?? result.event.sequence,
) => ({
  task: result.task,
  attempt: result.attempt,
  cycle: result.cycle,
  report: result.report,
  event: result.event,
  events: result.events,
  projectEventCursor,
});

const reviewAutomationResponse = (result: ReviewAutomationCommandOutcome) => ({
  task: result.task,
  event: result.event,
  projectEventCursor: result.event.sequence,
});

const planningResponse = (result: PlanningMutationResult) => ({
  plan: result.plan,
  base: result.base,
  proposal: result.proposal,
  session: result.session,
  events: result.events,
  projectEventCursor: result.events.at(-1)?.sequence,
});

const planApprovalResponse = (result: PlanApprovalResult) => ({
  ...planningResponse(result),
  createdTasks: result.createdTasks,
  dependencies: result.dependencies,
  taskMappings: result.taskMappings,
});

const dependencyResponse = (result: DependencyMutationResult) => ({
  task: result.task,
  dependencies: result.dependencies,
  event: result.event,
  projectEventCursor: result.event.sequence,
});

const requirePlanningExecutionService = (dependencies: CommandDependencies) => {
  if (!dependencies.planningExecutionService) {
    throw new CommandError(
      'invalid_command',
      'Project planning support is unavailable',
    );
  }
  return dependencies.planningExecutionService;
};

const requirePlanApprovalService = (dependencies: CommandDependencies) => {
  if (!dependencies.planApprovalService) {
    throw new CommandError(
      'invalid_command',
      'Project plan approval support is unavailable',
    );
  }
  return dependencies.planApprovalService;
};

const requireTaskDependencyService = (dependencies: CommandDependencies) => {
  if (!dependencies.taskDependencyService) {
    throw new CommandError(
      'invalid_command',
      'Task dependency support is unavailable',
    );
  }
  return dependencies.taskDependencyService;
};

type PlanningCommand = Extract<
  MutatingCommand,
  { type: `project.plan.${string}` }
>;

const executePlanningCommand = async (
  command: PlanningCommand,
  commandId: string,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  if (command.type === 'project.plan.start') {
    const result = await requirePlanningExecutionService(dependencies).start({
      projectId: command.payload.projectId,
      expectedProjectRevision: command.payload.expectedProjectRevision,
      goal: command.payload.goal,
      constraints: command.payload.constraints.join('\n'),
      nonGoals: command.payload.nonGoals.join('\n'),
      actor: command.payload.actor,
      commandId,
    });
    return response(command.type, planningResponse(result));
  }
  if (command.type === 'project.plan.request_revision') {
    const details = dependencies.plans.getDetails(command.payload.planId);
    if (!details || details.plan.projectId !== command.payload.projectId) {
      throw new CommandError(
        'project_plan_not_found',
        `Project plan '${command.payload.planId}' was not found`,
      );
    }
    const proposal = details.proposals.at(-1);
    if (!proposal) {
      throw new CommandError(
        'project_plan_proposal_invalid',
        `Project plan '${command.payload.planId}' has no proposal to revise`,
      );
    }
    const result = await requirePlanningExecutionService(
      dependencies,
    ).requestRevision({
      ...command.payload,
      proposalId: proposal.id,
      commandId,
    });
    return response(command.type, planningResponse(result));
  }
  if (command.type === 'project.plan.approve') {
    const result = await requirePlanApprovalService(dependencies).approve({
      ...command.payload,
      commandId,
    });
    return response(command.type, planApprovalResponse(result));
  }
  if (command.type === 'project.plan.reject') {
    const result = await requirePlanApprovalService(dependencies).reject({
      ...command.payload,
      commandId,
    });
    return response(command.type, planningResponse(result));
  }
  const execution = requirePlanningExecutionService(dependencies);
  const result = await (command.type === 'project.plan.cancel'
    ? execution.cancel({ ...command.payload, commandId })
    : command.type === 'project.plan.resume'
      ? execution.resume({ ...command.payload, commandId })
      : execution.retry({ ...command.payload, commandId }));
  return response(command.type, planningResponse(result));
};

type DependencyCommand = Extract<
  MutatingCommand,
  { type: `task.dependency.${string}` }
>;

const executeDependencyCommand = async (
  command: DependencyCommand,
  commandId: string,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  const task = dependencies.tasks.get(command.payload.taskId);
  if (!task) {
    throw new CommandError(
      'task_not_found',
      `Task '${command.payload.taskId}' was not found`,
    );
  }
  const service = requireTaskDependencyService(dependencies);
  const input = {
    projectId: task.projectId,
    taskId: command.payload.taskId,
    prerequisiteTaskId: command.payload.prerequisiteTaskId,
    expectedTaskRevision: command.payload.expectedRevision,
    actor: command.payload.actor,
    commandId,
  };
  const result = await (command.type === 'task.dependency.add'
    ? service.add(input)
    : service.remove(input));
  return response(command.type, dependencyResponse(result));
};

type DeveloperLaunchCommand = Extract<
  Extract<Command, { idempotencyKey: string }>['command'],
  { type: 'task.developer.launch' }
>;

const executeDeveloperLaunch = async (
  command: DeveloperLaunchCommand,
  idempotencyKey: string,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  if (command.payload.actor.type !== 'human') {
    throw new CommandError(
      'task_transition_unauthorized',
      'Only a human may launch a Developer',
    );
  }
  return response(
    command.type,
    attemptResponse(
      await requireAttemptService(dependencies).launchDeveloper({
        ...command.payload,
        commandId: idempotencyKey,
      }),
    ),
  );
};

type DeveloperHumanCommand = Extract<
  Extract<Command, { idempotencyKey: string }>['command'],
  {
    type:
      | 'task.developer.accept'
      | 'task.developer.reject_resume'
      | 'task.developer.reject_new'
      | 'task.developer.unblock_resume'
      | 'task.developer.unblock_new';
  }
>;

type DeveloperAgentCommand = Extract<
  Extract<Command, { idempotencyKey: string }>['command'],
  { type: 'task.developer.submit_review' | 'task.developer.block' }
>;

const executeDeveloperAgentCommand = async (
  command: DeveloperAgentCommand,
  idempotencyKey: string,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  const service = requireDeveloperExecutionService(dependencies);
  if (command.type === 'task.developer.block') {
    const result = service.markBlocked({
      ...command.payload,
      commandId: idempotencyKey,
    });
    await requireProjectRunService(dependencies).observeTaskOutcome(
      result.task.id,
    );
    return response(command.type, {
      ...result,
      projectEventCursor: result.event.sequence,
    });
  }

  const result = service.submitForReview({
    ...command.payload,
    commandId: idempotencyKey,
  });
  const warnings: Array<{ code: string; message: string }> = [];
  let task = result.task;
  let projectEventCursor = result.event.sequence;
  try {
    await requireReviewAutomationService(dependencies).afterDeveloperSubmission(
      {
        taskId: result.task.id,
        cycleId: result.cycle.id,
      },
    );
  } catch (error) {
    task = dependencies.tasks.get(result.task.id) ?? result.task;
    projectEventCursor = Math.max(
      projectEventCursor,
      dependencies.projectEvents.latestSequence(task.projectId),
    );
    warnings.push({
      code: safeErrorCode(error, 'review_automation_paused'),
      message: 'Developer submission was committed; review automation paused.',
    });
  }
  return response(
    command.type,
    { ...result, task, projectEventCursor },
    warnings,
  );
};

type QaCommand = Extract<
  Extract<Command, { idempotencyKey: string }>['command'],
  {
    type:
      | 'task.qa.launch'
      | 'task.qa.submit_verdict'
      | 'task.qa.repair_interrupted';
  }
>;

const executeQaCommand = async (
  command: QaCommand,
  idempotencyKey: string,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  const service = requireQaExecutionService(dependencies);
  if (command.type === 'task.qa.launch') {
    const result = await service.launch({
      ...command.payload,
      commandId: idempotencyKey,
      trigger: 'manual',
    });
    return response(command.type, qaLaunchResponse(result));
  }

  if (command.type === 'task.qa.repair_interrupted') {
    const result = service.repairInterrupted({
      ...command.payload,
      commandId: idempotencyKey,
    });
    return response(command.type, {
      ...result,
      projectEventCursor:
        result.events.at(-1)?.sequence ?? result.event.sequence,
    });
  }

  const committed = await service.submitVerdict({
    ...command.payload,
    commandId: idempotencyKey,
  });
  const warnings: Array<{ code: string; message: string }> = [];
  let outcome = committed;
  let projectEventCursor =
    committed.events.at(-1)?.sequence ?? committed.event.sequence;
  try {
    await requireReviewAutomationService(dependencies).afterQaVerdict({
      taskId: committed.task.id,
      cycleId: committed.cycle.id,
    });
  } catch (error) {
    outcome = {
      ...committed,
      task: dependencies.tasks.get(committed.task.id) ?? committed.task,
    };
    projectEventCursor = Math.max(
      projectEventCursor,
      dependencies.projectEvents.latestSequence(outcome.task.projectId),
    );
    warnings.push({
      code: safeErrorCode(error, 'review_automation_paused'),
      message:
        'QA verdict was committed; Developer resume failed and automation paused.',
    });
  }
  return response(
    command.type,
    qaVerdictResponse(outcome, projectEventCursor),
    warnings,
  );
};

type ReviewAutomationCommand = Extract<
  Extract<Command, { idempotencyKey: string }>['command'],
  {
    type: 'task.review_automation.enable' | 'task.review_automation.pause';
  }
>;

const executeReviewAutomationCommand = async (
  command: ReviewAutomationCommand,
  idempotencyKey: string,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  const service = requireReviewAutomationService(dependencies);
  const result =
    command.type === 'task.review_automation.enable'
      ? service.enable({ ...command.payload, commandId: idempotencyKey })
      : service.pause({ ...command.payload, commandId: idempotencyKey });
  if (command.type === 'task.review_automation.pause') {
    await requireProjectRunService(dependencies).observeTaskOutcome(
      result.task.id,
    );
  }
  return response(command.type, reviewAutomationResponse(result));
};

type ProjectRunCommand = Extract<
  MutatingCommand,
  { type: `project.run.${string}` }
>;

const executeProjectRunCommand = async (
  command: ProjectRunCommand,
  idempotencyKey: string,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  const service = requireProjectRunService(dependencies);
  const result = await (command.type === 'project.run.start'
    ? service.startRun({ ...command.payload, idempotencyKey })
    : command.type === 'project.run.pause'
      ? service.pauseRun({ ...command.payload, idempotencyKey })
      : command.type === 'project.run.resume'
        ? service.resumeRun({ ...command.payload, idempotencyKey })
        : service.stopRun({ ...command.payload, idempotencyKey }));
  return response(command.type, { run: result.run });
};

const executeDeveloperHumanCommand = async (
  command: DeveloperHumanCommand,
  idempotencyKey: string,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  if (command.payload.actor.type !== 'human') {
    throw new CommandError(
      'task_transition_unauthorized',
      'Only a human may review or recover Developer work',
    );
  }
  if (command.type === 'task.developer.accept') {
    const result = await requireDeveloperExecutionService(dependencies).accept({
      ...command.payload,
      commandId: idempotencyKey,
    });
    return response(command.type, {
      ...result,
      projectEventCursor: result.event.sequence,
    });
  }
  const kind = command.type.startsWith('task.developer.reject')
    ? ('rejection' as const)
    : ('unblock' as const);
  if (
    command.type === 'task.developer.reject_resume' ||
    command.type === 'task.developer.unblock_resume'
  ) {
    return response(
      command.type,
      attemptResponse(
        await requireAttemptService(dependencies).resumeDeveloper({
          ...command.payload,
          kind,
          commandId: idempotencyKey,
        }),
      ),
    );
  }
  return response(
    command.type,
    attemptResponse(
      await requireAttemptService(dependencies).reworkDeveloperNew({
        ...command.payload,
        kind,
        commandId: idempotencyKey,
      }),
    ),
  );
};

const requireTaskCommandId = (commandId: string | undefined): string => {
  if (!commandId) {
    throw new CommandError(
      'invalid_command',
      'Task commands require an idempotency key',
    );
  }
  return commandId;
};

const requireProject = (dependencies: CommandDependencies, id: string) => {
  const project = dependencies.projects.get(id);
  if (!project)
    throw new CommandError(
      'project_not_found',
      `Project '${id}' was not found`,
    );
  return project;
};

const requireWorkspace = (dependencies: CommandDependencies, id: string) => {
  const workspace = dependencies.workspaces.get(id);
  if (!workspace)
    throw new CommandError(
      'workspace_not_found',
      `Workspace '${id}' was not found`,
    );
  return workspace;
};

const requireSession = (dependencies: CommandDependencies, id: string) => {
  const session = dependencies.sessions.get(id);
  if (!session)
    throw new CommandError(
      'session_not_found',
      `Session '${id}' was not found`,
    );
  return session;
};

const assertBillingSafe = (dependencies: CommandDependencies) => {
  if ((dependencies.billingConflicts?.length ?? 0) > 0) {
    throw new CommandError(
      'billing_configuration_conflict',
      'API billing environment variables must be removed before starting Claude',
      dependencies.billingConflicts,
    );
  }
};

const isLive = (session: Session) =>
  ['starting', 'running', 'waiting_for_approval', 'interrupting'].includes(
    session.lifecycleState,
  );

const discoverSessions = async (
  dependencies: CommandDependencies,
  projectId?: string,
) => {
  const projects = projectId
    ? [requireProject(dependencies, projectId)]
    : dependencies.projects.list();
  const discovered: Session[] = [];
  for (const project of projects) {
    const known = dependencies.sessions.listByProject(project.id, {
      includeArchived: true,
    });
    for (const workspace of dependencies.workspaces.listByProject(project.id)) {
      const driverSessions = await dependencies.driver.discover({
        workspacePath: workspace.path,
      });
      for (const candidate of driverSessions) {
        const existing = known.find(
          (session) => session.claudeResumeId === candidate.claudeResumeId,
        );
        if (existing) {
          discovered.push(existing);
          continue;
        }
        const now = (dependencies.now ?? (() => new Date().toISOString()))();
        const session = sessionSchema.parse({
          id: (dependencies.createId ?? randomUUID)(),
          claudeResumeId: candidate.claudeResumeId,
          projectId: project.id,
          workspaceId: workspace.id,
          title: candidate.title ?? 'Discovered Claude session',
          permissionMode: 'inherit',
          lifecycleState: 'interrupted',
          createdAt: now,
          updatedAt: now,
        });
        dependencies.sessions.create(session);
        known.push(session);
        discovered.push(session);
      }
    }
  }
  return discovered;
};

const discoverProjects = async (dependencies: CommandDependencies) => {
  const known = dependencies.projects.list();
  if (!dependencies.pathOptions) return { projects: known, suggestions: [] };

  const baseDirectory = await resolveWorkspacePath(
    dependencies.pathOptions.baseDirectory,
    dependencies.pathOptions,
  );
  const entries = await readdir(baseDirectory, { withFileTypes: true });
  const candidates = [
    baseDirectory,
    ...entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(baseDirectory, entry.name)),
  ];
  const suggestions: Array<{ displayName: string; repositoryPath: string }> =
    [];
  for (const candidate of candidates) {
    try {
      const marker = await stat(join(candidate, '.git'));
      if (marker.isDirectory() || marker.isFile()) {
        const repositoryPath = await resolveWorkspacePath(
          candidate,
          dependencies.pathOptions,
        );
        suggestions.push({
          displayName: basename(repositoryPath) || 'Mesh workspace',
          repositoryPath,
        });
      }
    } catch {
      // Not a Git repository candidate.
    }
  }
  return { projects: known, suggestions };
};

const requireActiveProject = (
  dependencies: CommandDependencies,
  id: string,
) => {
  const project = requireProject(dependencies, id);
  if (project.archivedAt) {
    throw new CommandError('project_archived', `Project '${id}' is archived`, {
      project,
    });
  }
  return project;
};

const updateProject = (
  dependencies: CommandDependencies,
  project: ReturnType<typeof requireProject>,
  expectedRevision: number,
  patch: Partial<
    Pick<ReturnType<typeof requireProject>, 'displayName' | 'archivedAt'>
  >,
) => {
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  dependencies.database.exec('BEGIN IMMEDIATE');
  try {
    const updated = dependencies.projects.update(
      { ...project, ...patch, updatedAt: now },
      expectedRevision,
    );
    if (!updated)
      throw new CommandError(
        'project_revision_conflict',
        `Project '${project.id}' has changed`,
        { project: dependencies.projects.get(project.id) },
      );
    const event = dependencies.projectEvents.appendInTransaction(project.id, {
      protocolVersion: 1,
      id: (dependencies.createId ?? randomUUID)(),
      projectId: project.id,
      occurredAt: now,
      type: 'project.changed',
      payload: { project: updated },
    });
    dependencies.database.exec('COMMIT');
    dependencies.registry.publisher.publishProject(event);
    return updated;
  } catch (error) {
    if (dependencies.database.inTransaction)
      dependencies.database.exec('ROLLBACK');
    throw error;
  }
};

type DeveloperInstructionUpdateCommand = Extract<
  Extract<Command, { idempotencyKey: string }>['command'],
  { type: 'project.developer_instructions.update' }
>;

const executeDeveloperInstructionUpdate = (
  command: DeveloperInstructionUpdateCommand,
  idempotencyKey: string,
  dependencies: CommandDependencies,
): CommandResponse => {
  const existing =
    dependencies.commands.getExisting<CommandResponse>(idempotencyKey);
  if (existing.found) return existing.response;

  let event: ProjectEvent | undefined;
  const commandResponse =
    dependencies.commands.executeOnceInImmediateTransaction(
      idempotencyKey,
      () => {
        const project = requireActiveProject(
          dependencies,
          command.payload.projectId,
        );
        const now = (dependencies.now ?? (() => new Date().toISOString()))();
        const updated = dependencies.projects.updateDeveloperInstructions(
          project.id,
          command.payload.expectedRevision,
          {
            content: command.payload.content,
            updatedAt: now,
            updatedBy: command.payload.actor,
          },
        );
        if (!updated) {
          throw new CommandError(
            'project_revision_conflict',
            `Project '${project.id}' has changed`,
            { project: dependencies.projects.get(project.id) },
          );
        }
        event = dependencies.projectEvents.appendInTransaction(project.id, {
          protocolVersion: 1,
          id: (dependencies.createId ?? randomUUID)(),
          projectId: project.id,
          occurredAt: now,
          type: 'project.developer_instructions_changed',
          payload: { project: updated },
        });
        return response(command.type, updated);
      },
    );
  if (event) dependencies.registry.publisher.publishProject(event);
  return commandResponse;
};

type QaConfigurationUpdateCommand = Extract<
  Extract<Command, { idempotencyKey: string }>['command'],
  { type: 'project.qa_configuration.update' }
>;

const executeQaConfigurationUpdate = (
  command: QaConfigurationUpdateCommand,
  idempotencyKey: string,
  dependencies: CommandDependencies,
): CommandResponse => {
  const existing =
    dependencies.commands.getExisting<CommandResponse>(idempotencyKey);
  if (existing.found) return existing.response;

  let event: ProjectEvent | undefined;
  const commandResponse =
    dependencies.commands.executeOnceInImmediateTransaction(
      idempotencyKey,
      () => {
        const project = requireActiveProject(
          dependencies,
          command.payload.projectId,
        );
        const updated = dependencies.projects.updateQaConfiguration(
          project.id,
          command.payload.expectedRevision,
          {
            instructions: { content: command.payload.content },
            reviewPolicy: command.payload.reviewPolicy,
          },
          command.payload.actor,
        );
        if (!updated) {
          throw new CommandError(
            'project_revision_conflict',
            `Project '${project.id}' has changed`,
            { project: dependencies.projects.get(project.id) },
          );
        }
        event = dependencies.projectEvents.appendInTransaction(project.id, {
          protocolVersion: 1,
          id: (dependencies.createId ?? randomUUID)(),
          projectId: project.id,
          occurredAt: updated.qaConfiguration.updatedAt,
          type: 'project.qa_configuration_changed',
          payload: { project: updated },
        });
        return response(command.type, updated);
      },
    );
  if (event) dependencies.registry.publisher.publishProject(event);
  return commandResponse;
};

const assertMilestoneTwoHumanActor = (
  command: Extract<Command, { idempotencyKey: string }>['command'],
) => {
  if (
    (command.type.startsWith('project.') || command.type.startsWith('task.')) &&
    'actor' in command.payload &&
    command.payload.actor.type !== 'human'
  ) {
    throw new CommandError(
      'task_transition_unauthorized',
      'Milestone 2 mutations require a human actor',
    );
  }
};

const hasRunningTaskAttempt = (
  dependencies: CommandDependencies,
  projectId: string,
) =>
  dependencies.sessions
    .listByProject(projectId, { includeArchived: true })
    .some(
      (session) =>
        dependencies.qaExecutions.getActiveCycleBySession(session.id) !==
          undefined ||
        (isLive(session) &&
          dependencies.attempts.getCurrentBySession(session.id)),
    );

const reconcileLegacyProjectIdentities = async (
  dependencies: CommandDependencies,
) => {
  const pathOptions = dependencies.pathOptions;
  if (!pathOptions) return;
  const resolveIdentity =
    dependencies.resolveIdentity ?? resolveRepositoryIdentity;
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  for (const project of dependencies.projects.list()) {
    if (project.repositoryIdentity !== project.repositoryPath) continue;
    let identity;
    try {
      identity = await resolveIdentity(project.repositoryPath, pathOptions);
    } catch (error) {
      if (
        error instanceof RepositoryIdentityError &&
        error.code === 'repository_invalid'
      ) {
        continue;
      }
      throw error;
    }
    const reconciled = dependencies.projects.update(
      {
        ...project,
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        updatedAt: now,
      },
      project.revision,
    );
    if (!reconciled) {
      throw new CommandError(
        'project_revision_conflict',
        `Project '${project.id}' changed while reconciling its repository identity`,
        { project: dependencies.projects.get(project.id) },
      );
    }
  }
};

const executeMutation = async (
  command: Extract<Command, { idempotencyKey: string }>['command'],
  dependencies: CommandDependencies,
  commandId?: string,
): Promise<CommandResponse> => {
  assertMilestoneTwoHumanActor(command);
  switch (command.type) {
    case 'task.create':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.create({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.edit':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.edit({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.reorder':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.reorder({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.block':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.block({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.unblock':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.unblock({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.transition':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.transition({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.attempt.launch':
      return response(
        command.type,
        attemptResponse(
          await requireAttemptService(dependencies).launch({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
        ),
      );
    case 'task.attempt.link':
      return response(
        command.type,
        attemptResponse(
          await requireAttemptService(dependencies).link({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
        ),
      );
    case 'task.attempt.unlink':
      return response(
        command.type,
        attemptResponse(
          await requireAttemptService(dependencies).unlink({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
        ),
      );
    case 'project.import': {
      if (!dependencies.pathOptions) {
        throw new CommandError(
          'repository_invalid',
          'Workspace path configuration is unavailable',
        );
      }
      const resolveIdentity =
        dependencies.resolveIdentity ?? resolveRepositoryIdentity;
      const identity = await resolveIdentity(
        command.payload.repositoryPath,
        dependencies.pathOptions,
      );
      await reconcileLegacyProjectIdentities(dependencies);
      const existing = dependencies.projects.getByRepositoryIdentity(
        identity.repositoryIdentity,
      );
      if (existing) {
        throw new CommandError(
          'repository_already_imported',
          'This Git repository is already imported',
          { project: existing },
        );
      }
      const now = (dependencies.now ?? (() => new Date().toISOString()))();
      return response(
        command.type,
        dependencies.projects.create(
          projectSchema.parse({
            id: (dependencies.createId ?? randomUUID)(),
            displayName:
              command.payload.displayName ??
              basename(identity.canonicalPath) ??
              'Git repository',
            repositoryPath: identity.canonicalPath,
            repositoryIdentity: identity.repositoryIdentity,
            discoveredAt: now,
            discoveryMetadata: { source: 'explicit_import' },
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );
    }
    case 'project.rename': {
      const project = requireActiveProject(
        dependencies,
        command.payload.projectId,
      );
      return response(
        command.type,
        updateProject(dependencies, project, command.payload.expectedRevision, {
          displayName: command.payload.displayName,
        }),
      );
    }
    case 'project.archive': {
      const project = requireActiveProject(
        dependencies,
        command.payload.projectId,
      );
      if (hasRunningTaskAttempt(dependencies, project.id)) {
        throw new CommandError(
          'project_has_running_attempt',
          'A project with a running task attempt cannot be archived',
          { project },
        );
      }
      const now = (dependencies.now ?? (() => new Date().toISOString()))();
      return response(
        command.type,
        updateProject(dependencies, project, command.payload.expectedRevision, {
          archivedAt: now,
        }),
      );
    }
    case 'project.restore': {
      const project = requireProject(dependencies, command.payload.projectId);
      return response(
        command.type,
        updateProject(dependencies, project, command.payload.expectedRevision, {
          archivedAt: null,
        }),
      );
    }
    case 'session.create': {
      assertBillingSafe(dependencies);
      const project = requireProject(dependencies, command.payload.projectId);
      let workspace;
      let createWorkspace = false;
      if ('workspaceId' in command.payload) {
        workspace = requireWorkspace(dependencies, command.payload.workspaceId);
      } else {
        createWorkspace = true;
        const pathOptions = dependencies.pathOptions;
        if (!pathOptions) {
          throw new CommandError(
            'invalid_command',
            'Workspace path configuration is unavailable',
          );
        }
        const workspaceId = (dependencies.createId ?? randomUUID)();
        try {
          if (command.payload.workspace.type === 'shared') {
            const path = await resolveWorkspacePath(
              command.payload.workspace.path,
              pathOptions,
            );
            workspace = workspaceSchema.parse({
              id: workspaceId,
              projectId: project.id,
              type: 'shared',
              path,
              cleanupState: 'active',
            });
          } else {
            if (!dependencies.git) {
              throw new CommandError(
                'invalid_command',
                'Git worktree support is unavailable',
              );
            }
            const [repositoryPath, projectPath, worktreePath] =
              await Promise.all([
                resolveWorkspacePath(
                  command.payload.workspace.repositoryPath,
                  pathOptions,
                ),
                resolveWorkspacePath(project.repositoryPath, pathOptions),
                resolveWorkspacePath(command.payload.workspace.path, {
                  ...pathOptions,
                  allowMissingLeaf: true,
                }),
              ]);
            if (repositoryPath !== projectPath) {
              throw new CommandError(
                'invalid_command',
                'Worktree repository does not match the selected project',
              );
            }
            try {
              await dependencies.git.createWorktree({
                repositoryPath,
                worktreePath,
                branch: command.payload.workspace.branch,
                startPoint: command.payload.workspace.startPoint,
              });
            } catch (error) {
              throw new CommandError(
                'workspace_preserved',
                'Git worktree creation did not complete; filesystem state was preserved',
                error instanceof Error ? { message: error.message } : undefined,
              );
            }
            workspace = workspaceSchema.parse({
              id: workspaceId,
              projectId: project.id,
              type: 'worktree',
              path: worktreePath,
              gitBranch: command.payload.workspace.branch,
              gitWorktreePath: worktreePath,
              owner: 'mesh',
              cleanupState: 'active',
            });
          }
        } catch (error) {
          if (error instanceof CommandError) throw error;
          throw new CommandError(
            'invalid_command',
            'Workspace paths could not be resolved',
            error instanceof Error ? { message: error.message } : undefined,
          );
        }
      }
      if (workspace.projectId !== command.payload.projectId) {
        throw new CommandError(
          'invalid_command',
          'Workspace does not belong to the selected project',
        );
      }
      const now = (dependencies.now ?? (() => new Date().toISOString()))();
      const candidateSession = sessionSchema.parse({
        id: (dependencies.createId ?? randomUUID)(),
        projectId: command.payload.projectId,
        workspaceId: workspace.id,
        title: command.payload.title,
        permissionMode: command.payload.permissionMode,
        lifecycleState: 'idle',
        createdAt: now,
        updatedAt: now,
      });
      dependencies.database.exec('BEGIN IMMEDIATE');
      let session;
      let collision;
      try {
        assertWorkspaceAvailable(dependencies.database, {
          path: workspace.path,
          excludingSessionId: candidateSession.id,
          policy: 'manual',
        });
        if (createWorkspace) dependencies.workspaces.create(workspace);
        session = dependencies.sessions.create(candidateSession);
        collision = dependencies.sessions
          .listByProject(session.projectId)
          .some(
            (candidate) =>
              candidate.id !== session.id &&
              workspace.type === 'shared' &&
              isLive(candidate) &&
              dependencies.workspaces.get(candidate.workspaceId)?.path ===
                workspace.path,
          );
        dependencies.database.exec('COMMIT');
      } catch (error) {
        if (dependencies.database.inTransaction) {
          dependencies.database.exec('ROLLBACK');
        }
        throw error;
      }
      await dependencies.registry.create(session.id);
      return response(
        command.type,
        dependencies.sessions.get(session.id),
        collision
          ? [
              {
                code: 'shared_workspace_collision',
                message: 'Another live session uses this shared path',
              },
            ]
          : [],
      );
    }
    case 'session.resume': {
      assertBillingSafe(dependencies);
      const session = requireSession(dependencies, command.payload.sessionId);
      const workspace = requireWorkspace(
        dependencies,
        command.payload.workspaceId,
      );
      if (workspace.projectId !== session.projectId) {
        throw new CommandError(
          'invalid_command',
          'Workspace does not belong to the selected project',
        );
      }
      if (!session.claudeResumeId) {
        throw new CommandError(
          'invalid_session_state',
          'Session has no Claude resume ID',
        );
      }
      await dependencies.registry.resume(session.id, {
        workspaceId: workspace.id,
        permissionMode: command.payload.permissionMode,
      });
      return response(command.type, dependencies.sessions.get(session.id));
    }
    case 'session.prompt':
      await dependencies.registry.sendPrompt(
        command.payload.sessionId,
        command.payload.prompt,
      );
      return response(command.type, {
        accepted: true,
        sessionId: command.payload.sessionId,
      });
    case 'session.interrupt':
      await dependencies.registry.interrupt(command.payload.sessionId);
      return response(command.type, {
        accepted: true,
        sessionId: command.payload.sessionId,
      });
    case 'permission.decide': {
      const projects = dependencies.projects.list();
      const sessions = projects.flatMap((project) =>
        dependencies.sessions.listByProject(project.id),
      );
      const pendingById = new Map<
        string,
        ReturnType<EventRepository['after']>[number]
      >();
      for (const event of sessions.flatMap((session) =>
        dependencies.events.after(session.id, 0),
      )) {
        if (event.type === 'permission.requested')
          pendingById.set(event.payload.permissionId, event);
        if (event.type === 'permission.resolved')
          pendingById.delete(event.payload.permissionId);
      }
      const pending = pendingById.get(command.payload.permissionId);
      if (!pending)
        throw new CommandError(
          'invalid_session_state',
          'Permission request is not pending',
        );
      await dependencies.registry.resolvePermission(
        pending.sessionId,
        command.payload.permissionId,
        command.payload.decision,
      );
      return response(command.type, {
        accepted: true,
        permissionId: command.payload.permissionId,
      });
    }
    case 'session.archive': {
      const session = requireSession(dependencies, command.payload.sessionId);
      if (
        isLive(session) ||
        dependencies.qaExecutions.getActiveCycleBySession(session.id)
      ) {
        throw new CommandError(
          'invalid_session_state',
          'A live session or active QA cycle cannot be archived',
        );
      }
      return response(
        command.type,
        dependencies.sessions.archive(command.payload.sessionId),
        [
          {
            code: 'workspace_preserved',
            message: 'Archiving preserves the workspace',
          },
        ],
      );
    }
    case 'session.delete': {
      const session = requireSession(dependencies, command.payload.sessionId);
      if (isLive(session)) {
        throw new CommandError(
          'invalid_session_state',
          'A live session cannot be deleted',
        );
      }
      if (dependencies.attempts.listBySession(session.id).length > 0) {
        throw new CommandError(
          'invalid_session_state',
          'A session with task attempt history cannot be deleted',
        );
      }
      if (dependencies.qaExecutions.hasCycleForSession(session.id)) {
        throw new CommandError(
          'invalid_session_state',
          'A session with QA execution history cannot be deleted',
        );
      }
      const workspace = requireWorkspace(dependencies, session.workspaceId);
      const warnings: Array<{ code: string; message: string }> = [];
      if (workspace.type === 'worktree') {
        const project = requireProject(dependencies, session.projectId);
        if (!dependencies.git || !dependencies.pathOptions) {
          throw new CommandError(
            'workspace_preserved',
            'Worktree cleanup support is unavailable; the session was preserved',
          );
        }
        let repositoryPath: AbsolutePath;
        try {
          repositoryPath = await resolveWorkspacePath(
            project.repositoryPath,
            dependencies.pathOptions,
          );
        } catch (error) {
          throw new CommandError(
            'workspace_preserved',
            'The project repository path could not be verified; the session was preserved',
            error instanceof Error ? { message: error.message } : undefined,
          );
        }
        const removal = await dependencies.git.removeOwnedWorktree({
          confirmed: true,
          repositoryPath,
          workspace,
          sessions: dependencies.sessions.listByProject(session.projectId, {
            includeArchived: true,
          }),
        });
        if (removal.removed === false) {
          throw new CommandError(
            'workspace_preserved',
            `Worktree was preserved: ${removal.reason}`,
            { reason: removal.reason },
          );
        }
        dependencies.workspaces.markCleaned(workspace.id);
      } else {
        warnings.push({
          code: 'workspace_preserved',
          message: 'The shared workspace was preserved',
        });
      }
      dependencies.sessions.remove(session.id);
      return response(
        command.type,
        { deleted: true, sessionId: session.id },
        warnings,
      );
    }
    case 'layout.save':
      return response(command.type, dependencies.layouts.save(command.payload));
  }
};

export const executeCommand = async (
  input: unknown,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  const command = commandSchema.parse(input);
  if ('idempotencyKey' in command) {
    if (command.command.type.startsWith('project.plan.')) {
      return executePlanningCommand(
        command.command as PlanningCommand,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (command.command.type.startsWith('task.dependency.')) {
      return executeDependencyCommand(
        command.command as DependencyCommand,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (command.command.type === 'project.qa_configuration.update') {
      return executeQaConfigurationUpdate(
        command.command,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (command.command.type.startsWith('project.run.')) {
      return executeProjectRunCommand(
        command.command as ProjectRunCommand,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (command.command.type === 'project.developer_instructions.update') {
      return executeDeveloperInstructionUpdate(
        command.command,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (command.command.type === 'task.developer.launch') {
      return executeDeveloperLaunch(
        command.command,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (
      command.command.type === 'task.developer.submit_review' ||
      command.command.type === 'task.developer.block'
    ) {
      return executeDeveloperAgentCommand(
        command.command,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (
      command.command.type === 'task.qa.launch' ||
      command.command.type === 'task.qa.submit_verdict' ||
      command.command.type === 'task.qa.repair_interrupted'
    ) {
      return executeQaCommand(
        command.command,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (
      command.command.type === 'task.review_automation.enable' ||
      command.command.type === 'task.review_automation.pause'
    ) {
      return executeReviewAutomationCommand(
        command.command,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (
      [
        'task.developer.accept',
        'task.developer.reject_resume',
        'task.developer.reject_new',
        'task.developer.unblock_resume',
        'task.developer.unblock_new',
      ].includes(command.command.type)
    ) {
      return executeDeveloperHumanCommand(
        command.command as DeveloperHumanCommand,
        command.idempotencyKey,
        dependencies,
      );
    }
    if (
      [
        'task.create',
        'task.edit',
        'task.reorder',
        'task.block',
        'task.unblock',
        'task.transition',
        'task.attempt.launch',
        'task.attempt.link',
        'task.attempt.unlink',
      ].includes(command.command.type)
    ) {
      return executeMutation(
        command.command,
        dependencies,
        command.idempotencyKey,
      );
    }
    return dependencies.commands.executeOnce(command.idempotencyKey, () =>
      executeMutation(command.command, dependencies),
    );
  }

  switch (command.type) {
    case 'projects.discover':
      return response(command.type, await discoverProjects(dependencies));
    case 'sessions.discover':
      return response(command.type, {
        sessions: await discoverSessions(
          dependencies,
          command.payload.projectId,
        ),
      });
    case 'session.history':
      return response(
        command.type,
        sessionHistorySchema.parse({
          protocolVersion: 1,
          sessionId: command.payload.sessionId,
          events: dependencies.events.after(
            command.payload.sessionId,
            command.payload.afterSequence ?? 0,
          ),
        }),
      );
    case 'session.diagnostics':
      return response(
        command.type,
        sessionDiagnosticsSchema.parse({
          protocolVersion: 1,
          sessionId: command.payload.sessionId,
          diagnostics: dependencies.diagnostics.list(command.payload.sessionId),
        }),
      );
  }
};
