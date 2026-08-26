import { randomUUID } from 'node:crypto';

import {
  developerExecutionCycleSchema,
  rawDiagnosticSchema,
  sessionSchema,
  stableTaskErrorCodeSchema,
  taskActorSchema,
  workspaceSchema,
  UnsafeQaWorkspaceError,
  type MutatingCommand,
  type DeveloperExecutionCycle,
  type DeveloperReviewFeedback,
  type Project,
  type ProjectEvent,
  type Session,
  type Task,
  type TaskActor,
  type TaskAttempt,
  type Workspace,
} from '@mesh-session-platform/contracts';

import type { DeveloperRuntimeConfiguration } from '../claude/driver.js';
import { DEVELOPER_POLICY_VERSION } from '../domain/developer-policy.js';
import { authorizeTaskTransition } from '../domain/task-lifecycle.js';
import type { GitAdapter } from '../platform/git.js';
import {
  resolveWorkspacePath,
  type ResolveWorkspacePathOptions,
} from '../platform/paths.js';
import {
  RepositoryIdentityError,
  resolveRepositoryIdentity,
  type RepositoryIdentity,
} from '../projects/repository-identity.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import type { Database } from '../db/database.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import type { DeveloperCapabilityRegistry } from './developer-capability-registry.js';
import type {
  DeveloperReworkService,
  PreparedDeveloperRecovery,
} from './developer-rework-service.js';
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  TaskNotFoundError,
  TaskRevisionConflictError,
  type TaskService,
} from './task-service.js';

type AttemptActorInput = Omit<TaskActor, 'id'> & { id: string };
type AttemptWorkspaceInput = Extract<
  MutatingCommand,
  { type: 'task.attempt.launch' }
>['payload']['workspace'];

export type AttemptLaunchInput = {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  title: string;
  permissionMode: Session['permissionMode'];
  workspace?: AttemptWorkspaceInput;
  actor: AttemptActorInput;
};

export type DeveloperAttemptLaunchInput = Omit<AttemptLaunchInput, 'actor'> & {
  actor: Omit<AttemptActorInput, 'type'> & { type: 'human' };
};

export type DeveloperRecoveryKind = 'rejection' | 'unblock';

export type DeveloperAttemptResumeInput = {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  kind: DeveloperRecoveryKind;
  feedback: string;
  actor: Omit<AttemptActorInput, 'type'> & { type: 'human' };
};

export type DeveloperAttemptReworkInput = DeveloperAttemptLaunchInput & {
  kind: DeveloperRecoveryKind;
  feedback: string;
};

export type AttemptLinkInput = {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  sessionId: string;
  actor: AttemptActorInput;
};

export type AttemptUnlinkInput = {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  attemptId: string;
  reason: string;
  actor: AttemptActorInput;
};

export type AttemptMutationResult = {
  task: Task;
  attempt: TaskAttempt;
  event: ProjectEvent;
  session?: Session;
  cycle?: DeveloperExecutionCycle;
  feedback?: DeveloperReviewFeedback;
};

export type QaWorkspaceInput = {
  taskId: string;
  attemptId: string;
  workspaceId: string;
};

export type VerifiedQaWorkspace = {
  attempt: TaskAttempt;
  session: Session;
  workspace: Workspace;
};

type AttemptRegistry = {
  create(
    sessionId: string,
    developer?: DeveloperRuntimeConfiguration,
  ): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  publisher: Pick<EventPublisher, 'publishProject'>;
};

type AttemptServiceDependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: TaskAttemptRepository;
  sessions: SessionRepository;
  workspaces: WorkspaceRepository;
  diagnostics: DiagnosticRepository;
  developerExecutions: DeveloperExecutionRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  taskService: TaskService;
  registry: AttemptRegistry;
  capabilities: DeveloperCapabilityRegistry;
  developerReworkService: DeveloperReworkService;
  git?: Pick<GitAdapter, 'createWorktree'>;
  pathOptions?: ResolveWorkspacePathOptions;
  billingConflicts?: readonly { variable: string }[];
  resolveIdentity?: (
    path: string,
    options: ResolveWorkspacePathOptions,
  ) => Promise<RepositoryIdentity>;
  now?: () => string;
  createId?: () => string;
};

export class AttemptStartFailedError extends Error {
  readonly code = 'attempt_start_failed';

  constructor(
    readonly sessionId: string,
    readonly cause: unknown,
  ) {
    super(`Task attempt session '${sessionId}' did not start successfully`);
  }
}

export class AttemptReconciliationRequiredError extends Error {
  readonly code = 'attempt_reconciliation_required';

  constructor(
    readonly sessionId: string,
    readonly cause: unknown,
  ) {
    super(`Task attempt session '${sessionId}' requires reconciliation`);
  }
}

export class AttemptAuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';

  constructor(readonly cause: unknown) {
    super('The task attempt audit write failed');
  }
}

export class SessionAlreadyLinkedError extends Error {
  readonly code = 'session_already_linked';

  constructor(readonly sessionId: string) {
    super(`Session '${sessionId}' already has a current task association`);
  }
}

export class SessionRepositoryMismatchError extends Error {
  readonly code = 'session_repository_mismatch';

  constructor(readonly sessionId: string) {
    super(`Session '${sessionId}' belongs to a different repository`);
  }
}

class AttemptInvalidCommandError extends Error {
  readonly code = 'invalid_command';
}

class WorkspacePreservedError extends Error {
  readonly code = 'workspace_preserved';

  constructor(readonly cause: unknown) {
    super('The worktree requires reconciliation and was preserved');
  }
}

class SessionNotFoundError extends Error {
  readonly code = 'session_not_found';

  constructor(readonly sessionId: string) {
    super(`Session '${sessionId}' was not found`);
  }
}

const errorDetails = (error: unknown) =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };

const stableLaunchConflictCodes = new Set([
  'project_not_found',
  'project_archived',
  'task_not_found',
  'task_revision_conflict',
  'task_not_ready',
  'task_blocked',
  'task_transition_invalid',
  'task_transition_unauthorized',
]);

const isStableLaunchConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const parsed = stableTaskErrorCodeSchema.safeParse(error.code);
  return parsed.success && stableLaunchConflictCodes.has(parsed.data);
};

export class AttemptService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: AttemptServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  launch(input: AttemptLaunchInput): Promise<AttemptMutationResult> {
    return this.launchAttempt(input, false);
  }

  launchDeveloper(
    input: DeveloperAttemptLaunchInput,
  ): Promise<AttemptMutationResult> {
    return this.launchAttempt(input, true);
  }

  reworkDeveloperNew(
    input: DeveloperAttemptReworkInput,
  ): Promise<AttemptMutationResult> {
    return this.launchAttempt(input, true, input);
  }

  async resumeDeveloper(
    input: DeveloperAttemptResumeInput,
  ): Promise<AttemptMutationResult> {
    this.assertBillingSafe();
    return this.dependencies.developerReworkService.resume(input);
  }

  async requireQaWorkspace(
    input: QaWorkspaceInput,
  ): Promise<VerifiedQaWorkspace> {
    const task = this.dependencies.tasks.get(input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);
    this.requireActiveProject(task.projectId);
    const currentAttempt = this.dependencies.attempts
      .listByTask(task.id)
      .filter((attempt) => attempt.unlinkedAt === null)
      .at(-1);
    if (
      !currentAttempt ||
      currentAttempt.id !== input.attemptId ||
      currentAttempt.role !== 'developer'
    ) {
      throw new UnsafeQaWorkspaceError(
        'QA requires the current Developer attempt.',
      );
    }
    const session = this.dependencies.sessions.get(currentAttempt.sessionId);
    if (!session || session.workspaceId !== input.workspaceId) {
      throw new UnsafeQaWorkspaceError(
        'The Developer session no longer uses its recorded workspace.',
      );
    }
    const workspace = this.dependencies.workspaces.get(input.workspaceId);
    if (
      !workspace ||
      workspace.projectId !== task.projectId ||
      workspace.cleanupState !== 'active' ||
      (workspace.type === 'worktree' &&
        (workspace.owner !== 'mesh' ||
          workspace.gitWorktreePath !== workspace.path))
    ) {
      throw new UnsafeQaWorkspaceError(
        'The Developer workspace is missing, inactive, or not owned by Mesh.',
      );
    }
    try {
      await this.assertSameRepository(task, session);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw error;
      throw new UnsafeQaWorkspaceError(
        'The Developer workspace repository identity is unsafe or ambiguous.',
      );
    }
    return { attempt: currentAttempt, session, workspace };
  }

  private async launchAttempt(
    input: AttemptLaunchInput,
    developer: boolean,
    recovery?: DeveloperAttemptReworkInput,
  ): Promise<AttemptMutationResult> {
    let completedLaunch:
      | {
          sessionId: string;
          developerCycleId?: string;
          recovery?: {
            prepared: PreparedDeveloperRecovery;
            input: DeveloperAttemptReworkInput;
            actor: TaskActor;
          };
        }
      | undefined;
    const executeLaunch = async () => {
      this.assertBillingSafe();
      const actor = taskActorSchema.parse(input.actor);
      const recoveryContext = recovery
        ? this.dependencies.developerReworkService.requireRecovery(
            recovery,
            actor,
          )
        : undefined;
      const task =
        recoveryContext?.task ??
        this.requireLaunchableTask(input.taskId, input.expectedRevision, actor);
      this.reserveLaunch(task.id, input.commandId);
      try {
        if (!input.workspace) {
          throw new AttemptInvalidCommandError('Attempt workspace is required');
        }
        const workspace = await this.resolveWorkspace(
          task.projectId,
          input.workspace,
        );
        const occurredAt = this.now();
        const session = sessionSchema.parse({
          id: this.createId(),
          projectId: task.projectId,
          workspaceId: workspace.id,
          title: input.title,
          permissionMode: input.permissionMode,
          lifecycleState: 'idle',
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });

        const hasWorktreeReservation = workspace.type === 'worktree';
        if (hasWorktreeReservation) {
          if (input.workspace.type !== 'worktree') {
            throw new AttemptInvalidCommandError('Worktree input was expected');
          }
          try {
            this.persistWorkspaceReservation(
              task,
              input.expectedRevision,
              actor,
              workspace,
              session,
              recovery,
            );
          } catch (error) {
            if (isStableLaunchConflict(error)) throw error;
            throw new AttemptAuditUnavailableError(error);
          }
          try {
            await this.createReservedWorktree(input.workspace, workspace);
          } catch (error) {
            if (
              !this.recordWorkspacePreservedDiagnostic(
                session.id,
                'workspace_creation',
                error,
              )
            ) {
              throw new AttemptReconciliationRequiredError(session.id, error);
            }
            throw new WorkspacePreservedError(error);
          }
        }

        let prepared: {
          session: Session;
          attempt: TaskAttempt;
          event: ProjectEvent;
          cycle?: DeveloperExecutionCycle;
          feedback?: DeveloperReviewFeedback;
        };
        try {
          prepared = this.persistLaunchAudit(
            task,
            input.commandId,
            input.expectedRevision,
            actor,
            workspace,
            session,
            occurredAt,
            hasWorktreeReservation,
            developer,
            recovery,
          );
        } catch (error) {
          if (hasWorktreeReservation) {
            this.recordWorkspacePreservedDiagnostic(
              session.id,
              'attempt_audit',
              error,
            );
          }
          if (isStableLaunchConflict(error)) throw error;
          if (hasWorktreeReservation) {
            throw new WorkspacePreservedError(error);
          }
          throw new AttemptAuditUnavailableError(error);
        }
        this.dependencies.registry.publisher.publishProject(prepared.event);

        let developerRuntime: DeveloperRuntimeConfiguration | undefined;
        let developerCycle: DeveloperExecutionCycle | undefined;
        try {
          if (prepared.cycle) {
            developerCycle = prepared.cycle;
            developerRuntime =
              this.dependencies.developerReworkService.createRuntime(
                task,
                prepared.attempt,
                developerCycle,
                input.expectedRevision + 1,
                prepared.feedback,
              );
          }
          await this.dependencies.registry.create(
            prepared.session.id,
            developerRuntime,
          );
        } catch (error) {
          if (developerCycle) {
            this.dependencies.capabilities.invalidateCycle(developerCycle.id);
          }
          if (prepared.cycle) {
            this.dependencies.developerReworkService.closeFailed(
              {
                task,
                attempt: prepared.attempt,
                cycle: prepared.cycle,
                event: prepared.event,
                ...(prepared.feedback ? { feedback: prepared.feedback } : {}),
              },
              'startup',
              error,
            );
          }
          if (
            !this.recordDiagnostic(prepared.session.id, {
              kind: 'task_attempt_launch',
              stage: 'startup',
              outcome: 'failed',
              error: errorDetails(error),
            })
          ) {
            throw new AttemptReconciliationRequiredError(
              prepared.session.id,
              error,
            );
          }
          throw new AttemptStartFailedError(prepared.session.id, error);
        }

        try {
          const transition = recovery
            ? await this.dependencies.developerReworkService.complete(
                recovery,
                actor,
              )
            : await this.dependencies.taskService.transition({
                commandId: `${input.commandId}:task-transition`,
                taskId: task.id,
                expectedRevision: input.expectedRevision,
                nextState: 'in_progress',
                actor,
              });
          this.dependencies.registry.publisher.publishProject(transition.event);
          const result = {
            task: transition.task,
            attempt: prepared.attempt,
            event: transition.event,
            session: this.dependencies.sessions.get(prepared.session.id),
            ...(prepared.cycle ? { cycle: prepared.cycle } : {}),
            ...(prepared.feedback ? { feedback: prepared.feedback } : {}),
          };
          completedLaunch = {
            sessionId: prepared.session.id,
            ...(prepared.cycle ? { developerCycleId: prepared.cycle.id } : {}),
            ...(recovery && prepared.cycle && prepared.feedback
              ? {
                  recovery: {
                    prepared: {
                      task,
                      attempt: prepared.attempt,
                      cycle: prepared.cycle,
                      feedback: prepared.feedback,
                      event: prepared.event,
                    },
                    input: recovery,
                    actor,
                  },
                }
              : {}),
          };
          return result;
        } catch (error) {
          if (prepared.cycle) {
            this.dependencies.capabilities.invalidateCycle(prepared.cycle.id);
          }
          let cleanup: 'interrupted' | 'unknown' = 'interrupted';
          try {
            await this.dependencies.registry.interrupt(prepared.session.id);
          } catch {
            cleanup = 'unknown';
          }
          const diagnosed = this.recordDiagnostic(prepared.session.id, {
            kind: 'task_attempt_launch',
            stage: 'task_transition',
            cleanup,
            error: errorDetails(error),
          });
          if (recovery && prepared.cycle && prepared.feedback) {
            this.dependencies.developerReworkService.closeFailed(
              {
                task,
                attempt: prepared.attempt,
                cycle: prepared.cycle,
                feedback: prepared.feedback,
                event: prepared.event,
              },
              'task_transition',
              error,
              cleanup,
            );
          }
          if (cleanup === 'unknown' || !diagnosed) {
            throw new AttemptReconciliationRequiredError(
              prepared.session.id,
              error,
            );
          }
          throw new AttemptStartFailedError(prepared.session.id, error);
        }
      } finally {
        this.releaseLaunch(task.id, input.commandId);
      }
    };
    try {
      return await this.dependencies.commands.executeOnce(
        input.commandId,
        executeLaunch,
      );
    } catch (error) {
      if (completedLaunch?.recovery) {
        await this.dependencies.developerReworkService.reconcileCommandCompletionFailure(
          completedLaunch.recovery.prepared,
          completedLaunch.recovery.input,
          completedLaunch.recovery.actor,
          error,
        );
      }
      if (completedLaunch) {
        await this.cleanupCommandCompletionFailure(completedLaunch, error);
      }
      throw error;
    }
  }

  private async cleanupCommandCompletionFailure(
    launch: { sessionId: string; developerCycleId?: string },
    error: unknown,
  ): Promise<void> {
    if (launch.developerCycleId) {
      this.dependencies.capabilities.invalidateCycle(launch.developerCycleId);
    }
    let cleanup: 'interrupted' | 'unknown' = 'interrupted';
    try {
      await this.dependencies.registry.interrupt(launch.sessionId);
    } catch {
      cleanup = 'unknown';
    }
    this.recordDiagnostic(launch.sessionId, {
      kind: 'task_attempt_launch',
      stage: 'command_completion',
      cleanup,
      reconciliationRequired: true,
      error: errorDetails(error),
    });
  }

  async link(input: AttemptLinkInput): Promise<AttemptMutationResult> {
    const existing =
      this.dependencies.commands.getExisting<AttemptMutationResult>(
        input.commandId,
      );
    if (existing.found) return existing.response;
    const actor = taskActorSchema.parse(input.actor);
    const task = this.requireTask(input.taskId, input.expectedRevision);
    const session = this.requireSession(input.sessionId);
    await this.assertSameRepository(task, session);
    const result = this.dependencies.commands.executeOnceInImmediateTransaction(
      input.commandId,
      () => {
        const currentTask = this.requireTask(
          input.taskId,
          input.expectedRevision,
        );
        const currentSession = this.requireSession(input.sessionId);
        if (this.dependencies.attempts.getCurrentBySession(currentSession.id)) {
          throw new SessionAlreadyLinkedError(currentSession.id);
        }
        const attempt = this.dependencies.attempts.createForTask(
          currentTask.id,
          currentSession.id,
          'linked',
          actor,
        );
        const event = this.appendAttemptEvent(currentTask.projectId, attempt);
        return { task: currentTask, attempt, event };
      },
    );
    this.dependencies.registry.publisher.publishProject(result.event);
    return result;
  }

  async unlink(input: AttemptUnlinkInput): Promise<AttemptMutationResult> {
    const actor = taskActorSchema.parse(input.actor);
    if (!input.reason.trim()) {
      throw new AttemptInvalidCommandError('An unlink reason is required');
    }
    const result = this.dependencies.commands.executeOnceInImmediateTransaction(
      input.commandId,
      () => {
        const task = this.requireTask(input.taskId, input.expectedRevision);
        const attempt = this.dependencies.attempts
          .listByTask(task.id)
          .find((candidate) => candidate.id === input.attemptId);
        if (!attempt || attempt.unlinkedAt || attempt.source !== 'linked') {
          throw new AttemptInvalidCommandError(
            `Current task attempt '${input.attemptId}' was not found`,
          );
        }
        const unlinked = this.dependencies.attempts.unlink(
          attempt.id,
          actor,
          input.reason,
          this.now(),
        );
        const event = this.appendAttemptEvent(task.projectId, unlinked);
        return {
          task,
          attempt: unlinked,
          event,
        };
      },
    );
    this.dependencies.registry.publisher.publishProject(result.event);
    return result;
  }

  private reserveLaunch(taskId: string, commandId: string): void {
    try {
      this.dependencies.database
        .prepare(
          'INSERT INTO task_attempt_launch_reservations (task_id, command_id, created_at) VALUES (?, ?, ?)',
        )
        .run(taskId, commandId, this.now());
    } catch {
      const task = this.dependencies.tasks.get(taskId);
      if (!task) throw new TaskNotFoundError(taskId);
      throw new TaskRevisionConflictError(task);
    }
  }

  private releaseLaunch(taskId: string, commandId: string): void {
    this.dependencies.database
      .prepare(
        'DELETE FROM task_attempt_launch_reservations WHERE task_id = ? AND command_id = ?',
      )
      .run(taskId, commandId);
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

  private requireLaunchableTask(
    taskId: string,
    expectedRevision: number,
    actor: TaskActor,
  ): Task {
    const task = this.requireTask(taskId, expectedRevision);
    authorizeTaskTransition({ task, nextState: 'in_progress', actor });
    return task;
  }

  private requireActiveProject(projectId: string): Project {
    const project = this.dependencies.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (project.archivedAt) throw new ProjectArchivedError(project);
    return project;
  }

  private requireSession(sessionId: string): Session {
    const session = this.dependencies.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  private async assertSameRepository(
    task: Task,
    session: Session,
  ): Promise<void> {
    const taskProject = this.requireActiveProject(task.projectId);
    const sessionProject = this.dependencies.projects.get(session.projectId);
    if (!sessionProject) throw new ProjectNotFoundError(session.projectId);
    const workspace = this.dependencies.workspaces.get(session.workspaceId);
    if (!workspace) throw new SessionRepositoryMismatchError(session.id);
    let taskIdentity = taskProject.repositoryIdentity;
    let sessionIdentity = sessionProject.repositoryIdentity;
    if (this.dependencies.pathOptions) {
      const resolve =
        this.dependencies.resolveIdentity ?? resolveRepositoryIdentity;
      [taskIdentity, sessionIdentity] = (
        await Promise.all([
          resolve(taskProject.repositoryPath, this.dependencies.pathOptions),
          resolve(workspace.path, this.dependencies.pathOptions),
        ])
      ).map((identity) => identity.repositoryIdentity) as [string, string];
    }
    if (taskIdentity !== sessionIdentity) {
      throw new SessionRepositoryMismatchError(session.id);
    }
  }

  private async resolveWorkspace(
    projectId: string,
    input: AttemptWorkspaceInput,
  ): Promise<Workspace> {
    const pathOptions = this.dependencies.pathOptions;
    if (!pathOptions) {
      throw new AttemptInvalidCommandError(
        'Workspace path configuration is unavailable',
      );
    }
    const workspaceId = this.createId();
    if (input.type === 'shared') {
      const project = this.requireActiveProject(projectId);
      const path = await resolveWorkspacePath(input.path, pathOptions);
      const resolve =
        this.dependencies.resolveIdentity ?? resolveRepositoryIdentity;
      const [projectIdentity, workspaceIdentity] = await Promise.all([
        resolve(project.repositoryPath, pathOptions),
        resolve(path, pathOptions),
      ]);
      if (
        projectIdentity.repositoryIdentity !==
        workspaceIdentity.repositoryIdentity
      ) {
        throw new SessionRepositoryMismatchError('new');
      }
      return workspaceSchema.parse({
        id: workspaceId,
        projectId,
        type: 'shared',
        path,
        cleanupState: 'active',
      });
    }
    if (!this.dependencies.git) {
      throw new AttemptInvalidCommandError(
        'Git worktree support is unavailable',
      );
    }
    const project = this.requireActiveProject(projectId);
    let repositoryPath: string;
    let projectPath: string;
    try {
      [repositoryPath, projectPath] = await Promise.all([
        resolveWorkspacePath(input.repositoryPath, pathOptions),
        resolveWorkspacePath(project.repositoryPath, pathOptions),
      ]);
    } catch {
      throw new RepositoryIdentityError(
        'repository_invalid',
        'The selected project repository is missing or unreadable; import the repository again',
      );
    }
    const worktreePath = await resolveWorkspacePath(input.path, {
      ...pathOptions,
      allowMissingLeaf: true,
    });
    if (repositoryPath !== projectPath) {
      throw new AttemptInvalidCommandError(
        'Worktree repository does not match the selected project',
      );
    }
    return workspaceSchema.parse({
      id: workspaceId,
      projectId,
      type: 'worktree',
      path: worktreePath,
      gitBranch: input.branch,
      gitWorktreePath: worktreePath,
      owner: 'mesh',
      cleanupState: 'pending',
    });
  }

  private async createReservedWorktree(
    input: Extract<AttemptWorkspaceInput, { type: 'worktree' }>,
    workspace: Workspace,
  ): Promise<void> {
    const git = this.dependencies.git;
    const pathOptions = this.dependencies.pathOptions;
    if (!git) {
      throw new AttemptInvalidCommandError(
        'Git worktree support is unavailable',
      );
    }
    if (!pathOptions) {
      throw new AttemptInvalidCommandError(
        'Workspace path configuration is unavailable',
      );
    }
    await git.createWorktree({
      repositoryPath: await resolveWorkspacePath(
        input.repositoryPath,
        pathOptions,
      ),
      worktreePath: await resolveWorkspacePath(workspace.path, {
        ...pathOptions,
        allowMissingLeaf: true,
      }),
      branch: input.branch,
      startPoint: input.startPoint,
    });
  }

  private persistWorkspaceReservation(
    task: Task,
    expectedRevision: number,
    actor: TaskActor,
    workspace: Workspace,
    session: Session,
    recovery?: DeveloperAttemptReworkInput,
  ): void {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      if (recovery) {
        this.dependencies.developerReworkService.requireRecovery(
          recovery,
          actor,
        );
      } else {
        this.requireLaunchableTask(task.id, expectedRevision, actor);
      }
      this.dependencies.workspaces.create(workspace);
      this.dependencies.sessions.create(session);
      this.dependencies.database.exec('COMMIT');
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private persistLaunchAudit(
    task: Task,
    commandId: string,
    expectedRevision: number,
    actor: TaskActor,
    workspace: Workspace,
    session: Session,
    occurredAt: string,
    hasWorktreeReservation: boolean,
    developer: boolean,
    recovery?: DeveloperAttemptReworkInput,
  ) {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const recoveryContext = recovery
        ? this.dependencies.developerReworkService.requireRecovery(
            recovery,
            actor,
          )
        : undefined;
      const current =
        recoveryContext?.task ??
        this.requireLaunchableTask(task.id, expectedRevision, actor);
      let persistedSession: Session;
      if (hasWorktreeReservation) {
        if (!this.dependencies.workspaces.markActive(workspace.id)) {
          throw new Error(
            `Workspace reservation '${workspace.id}' was not found`,
          );
        }
        persistedSession = this.requireSession(session.id);
      } else {
        this.dependencies.workspaces.create(workspace);
        persistedSession = this.dependencies.sessions.create(session);
      }
      const attempt = this.dependencies.attempts.createForTask(
        current.id,
        persistedSession.id,
        'launched',
        actor,
        developer ? 'developer' : null,
      );
      let cycle: DeveloperExecutionCycle | undefined;
      let feedback: DeveloperReviewFeedback | undefined;
      if (developer) {
        const project = this.requireActiveProject(current.projectId);
        if (recovery && recoveryContext) {
          feedback = this.dependencies.developerExecutions.appendFeedback(
            this.dependencies.developerReworkService.createFeedback(
              recovery,
              actor,
              recoveryContext.previousCycle,
              occurredAt,
            ),
          );
        }
        cycle = this.dependencies.developerExecutions.createCycle(
          developerExecutionCycleSchema.parse({
            id: this.createId(),
            attemptId: attempt.id,
            ordinal: 1,
            mode: 'new',
            authorizedBy: actor,
            authorizationCommandId: commandId,
            policyVersion: DEVELOPER_POLICY_VERSION,
            projectInstructions: {
              content: project.developerInstructions.content,
              revision: project.developerInstructions.revision,
            },
            taskSnapshot: {
              revision: current.revision,
              title: current.title,
              description: current.description,
              acceptanceCriteria: current.acceptanceCriteria.map(
                (text, index) => ({
                  id: `criterion-${index + 1}`,
                  text,
                }),
              ),
            },
            workspaceId: persistedSession.workspaceId,
            permissionMode: persistedSession.permissionMode,
            startedAt: occurredAt,
            endedAt: null,
            terminalDisposition: null,
            completionReportId: null,
            blockerReportId: null,
            terminalCommandId: null,
            terminalEventId: null,
          }),
        );
      }
      const linkedReservation = this.dependencies.database
        .prepare(
          'UPDATE task_attempt_launch_reservations SET session_id = ? WHERE task_id = ? AND command_id = ?',
        )
        .run(persistedSession.id, current.id, commandId);
      if (linkedReservation.changes !== 1) {
        throw new Error(`Launch reservation for task '${current.id}' was lost`);
      }
      const event = cycle
        ? this.dependencies.projectEvents.appendInTransaction(
            current.projectId,
            {
              protocolVersion: 1,
              id: this.createId(),
              projectId: current.projectId,
              occurredAt,
              type: 'task.developer_execution_changed',
              payload: {
                task: current,
                attempt,
                cycle,
                completionReport: null,
                blockerReport: null,
                reviewFeedback: feedback ?? null,
              },
            },
          )
        : this.dependencies.projectEvents.appendInTransaction(
            current.projectId,
            {
              protocolVersion: 1,
              id: this.createId(),
              projectId: current.projectId,
              occurredAt,
              type: 'task.attempt_changed',
              payload: { attempt },
            },
          );
      this.dependencies.database.exec('COMMIT');
      return {
        session: persistedSession,
        attempt,
        event,
        ...(cycle ? { cycle } : {}),
        ...(feedback ? { feedback } : {}),
      };
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private appendAttemptEvent(
    projectId: Task['projectId'],
    attempt: TaskAttempt,
  ) {
    return this.dependencies.projectEvents.appendInTransaction(projectId, {
      protocolVersion: 1,
      id: this.createId(),
      projectId,
      occurredAt: attempt.unlinkedAt ?? attempt.createdAt,
      type: 'task.attempt_changed',
      payload: { attempt },
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

  private recordWorkspacePreservedDiagnostic(
    sessionId: string,
    stage: 'workspace_creation' | 'attempt_audit',
    error: unknown,
  ): boolean {
    return this.recordDiagnostic(sessionId, {
      kind: 'task_attempt_launch',
      stage,
      outcome: 'workspace_preserved',
      reconciliationRequired: true,
      error: errorDetails(error),
    });
  }

  private assertBillingSafe(): void {
    if ((this.dependencies.billingConflicts?.length ?? 0) > 0) {
      throw {
        code: 'billing_configuration_conflict' as const,
        message:
          'API billing environment variables must be removed before starting Claude',
        details: this.dependencies.billingConflicts,
      };
    }
  }
}
