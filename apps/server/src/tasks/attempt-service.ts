import { randomUUID } from 'node:crypto';

import {
  rawDiagnosticSchema,
  sessionSchema,
  taskActorSchema,
  workspaceSchema,
  type MutatingCommand,
  type Project,
  type ProjectEvent,
  type Session,
  type Task,
  type TaskActor,
  type TaskAttempt,
  type Workspace,
} from '@mesh-session-platform/contracts';

import { authorizeTaskTransition } from '../domain/task-lifecycle.js';
import type { GitAdapter } from '../platform/git.js';
import {
  resolveWorkspacePath,
  type ResolveWorkspacePathOptions,
} from '../platform/paths.js';
import {
  resolveRepositoryIdentity,
  type RepositoryIdentity,
} from '../projects/repository-identity.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import type { Database } from '../db/database.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
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
};

type AttemptRegistry = {
  create(sessionId: string): Promise<void>;
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
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  taskService: TaskService;
  registry: AttemptRegistry;
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
    super(
      'Git worktree creation did not complete; filesystem state was preserved',
    );
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

export class AttemptService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: AttemptServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  launch(input: AttemptLaunchInput): Promise<AttemptMutationResult> {
    return this.dependencies.commands.executeOnce(input.commandId, async () => {
      this.assertBillingSafe();
      const actor = taskActorSchema.parse(input.actor);
      const task = this.requireLaunchableTask(
        input.taskId,
        input.expectedRevision,
        actor,
      );
      if (!input.workspace) {
        throw new AttemptInvalidCommandError('Attempt workspace is required');
      }
      const workspace = await this.prepareWorkspace(
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

      let prepared: {
        session: Session;
        attempt: TaskAttempt;
        event: ProjectEvent;
      };
      try {
        prepared = this.persistLaunchAudit(
          task,
          input.expectedRevision,
          actor,
          workspace,
          session,
          occurredAt,
        );
      } catch (error) {
        throw new AttemptAuditUnavailableError(error);
      }
      this.dependencies.registry.publisher.publishProject(prepared.event);

      try {
        await this.dependencies.registry.create(prepared.session.id);
      } catch (error) {
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
        const transition = await this.dependencies.taskService.transition({
          commandId: `${input.commandId}:task-transition`,
          taskId: task.id,
          expectedRevision: input.expectedRevision,
          nextState: 'in_progress',
          actor,
        });
        this.dependencies.registry.publisher.publishProject(transition.event);
        return {
          task: transition.task,
          attempt: prepared.attempt,
          event: transition.event,
          session: this.dependencies.sessions.get(prepared.session.id),
        };
      } catch (error) {
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
        if (cleanup === 'unknown' || !diagnosed) {
          throw new AttemptReconciliationRequiredError(
            prepared.session.id,
            error,
          );
        }
        throw new AttemptStartFailedError(prepared.session.id, error);
      }
    });
  }

  async link(input: AttemptLinkInput): Promise<AttemptMutationResult> {
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
        if (!attempt || attempt.unlinkedAt) {
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
    let taskIdentity = taskProject.repositoryIdentity;
    let sessionIdentity = sessionProject.repositoryIdentity;
    if (this.dependencies.pathOptions) {
      const resolve =
        this.dependencies.resolveIdentity ?? resolveRepositoryIdentity;
      [taskIdentity, sessionIdentity] = (
        await Promise.all([
          resolve(taskProject.repositoryPath, this.dependencies.pathOptions),
          resolve(sessionProject.repositoryPath, this.dependencies.pathOptions),
        ])
      ).map((identity) => identity.repositoryIdentity) as [string, string];
    }
    if (taskIdentity !== sessionIdentity) {
      throw new SessionRepositoryMismatchError(session.id);
    }
  }

  private async prepareWorkspace(
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
      return workspaceSchema.parse({
        id: workspaceId,
        projectId,
        type: 'shared',
        path: await resolveWorkspacePath(input.path, pathOptions),
        cleanupState: 'active',
      });
    }
    if (!this.dependencies.git) {
      throw new AttemptInvalidCommandError(
        'Git worktree support is unavailable',
      );
    }
    const project = this.requireActiveProject(projectId);
    const [repositoryPath, projectPath, worktreePath] = await Promise.all([
      resolveWorkspacePath(input.repositoryPath, pathOptions),
      resolveWorkspacePath(project.repositoryPath, pathOptions),
      resolveWorkspacePath(input.path, {
        ...pathOptions,
        allowMissingLeaf: true,
      }),
    ]);
    if (repositoryPath !== projectPath) {
      throw new AttemptInvalidCommandError(
        'Worktree repository does not match the selected project',
      );
    }
    try {
      await this.dependencies.git.createWorktree({
        repositoryPath,
        worktreePath,
        branch: input.branch,
        startPoint: input.startPoint,
      });
    } catch (error) {
      throw new WorkspacePreservedError(error);
    }
    return workspaceSchema.parse({
      id: workspaceId,
      projectId,
      type: 'worktree',
      path: worktreePath,
      gitBranch: input.branch,
      gitWorktreePath: worktreePath,
      owner: 'mesh',
      cleanupState: 'active',
    });
  }

  private persistLaunchAudit(
    task: Task,
    expectedRevision: number,
    actor: TaskActor,
    workspace: Workspace,
    session: Session,
    occurredAt: string,
  ) {
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.requireLaunchableTask(
        task.id,
        expectedRevision,
        actor,
      );
      this.dependencies.workspaces.create(workspace);
      const persistedSession = this.dependencies.sessions.create(session);
      const attempt = this.dependencies.attempts.createForTask(
        current.id,
        persistedSession.id,
        'launched',
        actor,
      );
      const event = this.dependencies.projectEvents.appendInTransaction(
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
      return { session: persistedSession, attempt, event };
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
