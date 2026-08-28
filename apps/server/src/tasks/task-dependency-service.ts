import { randomUUID } from 'node:crypto';

import {
  idSchema,
  taskActorSchema,
  taskDependencySchema,
  type ProjectEvent,
  type StableTaskErrorCode,
  type Task,
  type TaskActor,
  type TaskDependency,
} from '@mesh-session-platform/contracts';

import {
  incompletePrerequisiteIds as findIncompletePrerequisiteIds,
  validateDependencyGraph,
} from '../domain/task-dependencies.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskDependencyRepository } from '../repositories/task-dependency-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  TaskNotFoundError,
  TaskRevisionConflictError,
} from './task-service.js';

export type DependencyMutationInput = {
  projectId: string;
  taskId: string;
  prerequisiteTaskId: string;
  expectedTaskRevision: number;
  actor: TaskActor;
  commandId: string;
};

export type DependencyMutationResult = {
  task: Task;
  dependencies: TaskDependency[];
  event: ProjectEvent;
};

type Dependencies = {
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: TaskAttemptRepository;
  dependencies: TaskDependencyRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  publisher: Pick<EventPublisher, 'publishProject'>;
  onAuditFailure?: (error: unknown) => void;
  now?: () => string;
  createId?: () => string;
};

export class TaskDependencyServiceError extends Error {
  constructor(
    readonly code: Extract<
      StableTaskErrorCode,
      'task_dependency_conflict' | 'task_dependency_invalid'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'TaskDependencyServiceError';
  }
}

export class TaskDependencyService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly repositories: Dependencies) {
    this.now = repositories.now ?? (() => new Date().toISOString());
    this.createId = repositories.createId ?? randomUUID;
  }

  async add(input: DependencyMutationInput): Promise<DependencyMutationResult> {
    return this.mutate('add', input);
  }

  async remove(
    input: DependencyMutationInput,
  ): Promise<DependencyMutationResult> {
    return this.mutate('remove', input);
  }

  incompletePrerequisiteIds(taskId: string): string[] {
    const task = this.repositories.tasks.get(idSchema.parse(taskId));
    if (!task) throw new TaskNotFoundError(taskId);
    return findIncompletePrerequisiteIds(
      task.id,
      this.repositories.tasks.listByProject(task.projectId),
      this.repositories.dependencies.listByProject(task.projectId),
    );
  }

  dependencyBlockedTaskIds(projectId: string): Set<string> {
    const parsedProjectId = idSchema.parse(projectId);
    const tasks = this.repositories.tasks.listByProject(parsedProjectId);
    const dependencies =
      this.repositories.dependencies.listByProject(parsedProjectId);
    return new Set(
      tasks
        .filter(
          (task) =>
            findIncompletePrerequisiteIds(task.id, tasks, dependencies).length >
            0,
        )
        .map(({ id }) => id),
    );
  }

  private async mutate(
    operation: 'add' | 'remove',
    input: DependencyMutationInput,
  ): Promise<DependencyMutationResult> {
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.repositories.commands.getExisting<DependencyMutationResult>(
        commandId,
      );
    if (existing.found) return existing.response;

    let committedMutation = false;
    const result = this.repositories.commands.executeOnceInImmediateTransaction(
      commandId,
      () => {
        const mutation = this.mutateInTransaction(operation, input);
        committedMutation = true;
        return mutation;
      },
    );
    if (committedMutation) {
      this.repositories.publisher.publishProject(result.event);
    }
    return result;
  }

  private mutateInTransaction(
    operation: 'add' | 'remove',
    input: DependencyMutationInput,
  ): DependencyMutationResult {
    const actor = taskActorSchema.parse(input.actor);
    if (actor.type !== 'human') {
      throw new TaskDependencyServiceError(
        'task_dependency_invalid',
        'Only a human may change task dependencies.',
      );
    }

    const projectId = idSchema.parse(input.projectId);
    const project = this.repositories.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (project.archivedAt) throw new ProjectArchivedError(project);

    const taskId = idSchema.parse(input.taskId);
    const task = this.repositories.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.projectId !== project.id) {
      throw new TaskDependencyServiceError(
        'task_dependency_invalid',
        'The dependent task must belong to the requested project.',
      );
    }
    if (task.revision !== input.expectedTaskRevision) {
      throw new TaskRevisionConflictError(task);
    }
    if (task.lifecycleState !== 'backlog' && task.lifecycleState !== 'ready') {
      throw new TaskDependencyServiceError(
        'task_dependency_invalid',
        'Dependencies may only change while a task is in backlog or ready.',
      );
    }
    if (
      this.repositories.attempts
        .listByTask(task.id)
        .some(({ unlinkedAt }) => unlinkedAt === null)
    ) {
      throw new TaskDependencyServiceError(
        'task_dependency_invalid',
        'Dependencies may not change while a task has an active attempt.',
      );
    }

    const prerequisiteTaskId = idSchema.parse(input.prerequisiteTaskId);
    const prerequisite = this.repositories.tasks.get(prerequisiteTaskId);
    if (!prerequisite) throw new TaskNotFoundError(prerequisiteTaskId);
    if (
      prerequisite.projectId !== project.id ||
      prerequisite.lifecycleState === 'cancelled'
    ) {
      throw new TaskDependencyServiceError(
        'task_dependency_invalid',
        'The prerequisite must be a non-cancelled task in the same project.',
      );
    }

    const currentDependencies = this.repositories.dependencies.listByProject(
      project.id,
    );
    const dependency = taskDependencySchema.parse({
      projectId: project.id,
      taskId: task.id,
      prerequisiteTaskId: prerequisite.id,
      createdBy: actor,
      createdAt: this.now(),
    });
    const edgeIndex = currentDependencies.findIndex(
      (candidate) =>
        candidate.taskId === task.id &&
        candidate.prerequisiteTaskId === prerequisite.id,
    );
    const nextDependencies =
      operation === 'add'
        ? [...currentDependencies, dependency]
        : currentDependencies.filter((_, index) => index !== edgeIndex);

    if (operation === 'remove' && edgeIndex < 0) {
      throw new TaskDependencyServiceError(
        'task_dependency_conflict',
        'The requested task dependency does not exist.',
      );
    }
    validateDependencyGraph({
      tasks: this.repositories.tasks.listByProject(project.id),
      dependencies: nextDependencies,
    });

    if (operation === 'add') {
      this.repositories.dependencies.create(dependency);
    } else if (
      !this.repositories.dependencies.remove(task.id, prerequisite.id)
    ) {
      throw new TaskDependencyServiceError(
        'task_dependency_conflict',
        'The requested task dependency changed before it could be removed.',
      );
    }

    const occurredAt = this.now();
    const updated = this.repositories.tasks.update(
      { ...task, updatedAt: occurredAt },
      input.expectedTaskRevision,
    );
    if (!updated) {
      throw new TaskRevisionConflictError(
        this.repositories.tasks.get(task.id) ?? task,
      );
    }
    const dependencies = this.repositories.dependencies.listPrerequisites(
      task.id,
    );
    let event: ProjectEvent;
    try {
      event = this.repositories.projectEvents.appendInTransaction(project.id, {
        protocolVersion: 1,
        id: this.createId(),
        projectId: project.id,
        occurredAt,
        type: 'task.dependencies_changed',
        payload: { taskId: task.id, dependencies },
      });
    } catch (error) {
      try {
        this.repositories.onAuditFailure?.(error);
      } catch {
        // Preserve the durable audit error as the operation failure.
      }
      throw error;
    }
    return { task: updated, dependencies, event };
  }
}
