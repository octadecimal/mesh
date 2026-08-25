import { randomUUID } from 'node:crypto';

import {
  idSchema,
  taskLifecycleStateSchema,
  taskSchema,
  taskTransitionSchema,
  type MutatingCommand,
  type Project,
  type ProjectEvent,
  type Task,
  type TaskTransition,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { TaskTransitionRepository } from '../repositories/task-transition-repository.js';
import { authorizeTaskTransition } from '../domain/task-lifecycle.js';

type TaskMutationCommandType =
  | 'task.create'
  | 'task.edit'
  | 'task.reorder'
  | 'task.block'
  | 'task.unblock'
  | 'task.transition';

type TaskMutationPayload<Type extends TaskMutationCommandType> = Extract<
  MutatingCommand,
  { type: Type }
>['payload'];

type TaskMutationInput<Type extends TaskMutationCommandType> = Omit<
  TaskMutationPayload<Type>,
  'projectId' | 'taskId'
> & { commandId: string } & ('projectId' extends keyof TaskMutationPayload<Type>
    ? { projectId: string }
    : object) &
  ('taskId' extends keyof TaskMutationPayload<Type>
    ? { taskId: string }
    : object);

export type TaskMutationResult = {
  task: Task;
  event: ProjectEvent;
  transition?: TaskTransition;
};

type TaskServiceDependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  transitions: TaskTransitionRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  now?: () => string;
  createId?: () => string;
};

export class ProjectNotFoundError extends Error {
  readonly code = 'project_not_found';

  constructor(readonly projectId: string) {
    super(`Project '${projectId}' was not found`);
  }
}

export class ProjectArchivedError extends Error {
  readonly code = 'project_archived';

  constructor(readonly project: Project) {
    super(`Project '${project.id}' is archived`);
  }
}

export class TaskNotFoundError extends Error {
  readonly code = 'task_not_found';

  constructor(readonly taskId: string) {
    super(`Task '${taskId}' was not found`);
  }
}

export class TaskRevisionConflictError extends Error {
  readonly code = 'task_revision_conflict';

  constructor(readonly task: Task) {
    super(`Task '${task.id}' has changed`);
  }
}

export class TaskService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: TaskServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async create(
    input: TaskMutationInput<'task.create'>,
  ): Promise<TaskMutationResult> {
    return this.execute(input.commandId, () => {
      this.requireActiveProject(input.projectId);
      const occurredAt = this.now();
      const task = this.dependencies.tasks.create(
        taskSchema.parse({
          id: this.createId(),
          projectId: input.projectId,
          title: input.title,
          description: input.description ?? '',
          acceptanceCriteria: input.acceptanceCriteria ?? [],
          priority: input.priority ?? 'normal',
          rank: this.nextRank(input.projectId, 'backlog'),
          lifecycleState: 'backlog',
          labels: input.labels ?? [],
          notes: input.notes ?? '',
          blocked: null,
          revision: 1,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        }),
      );
      const event = this.dependencies.projectEvents.appendInTransaction(
        task.projectId,
        {
          protocolVersion: 1,
          id: this.createId(),
          projectId: task.projectId,
          occurredAt,
          type: 'task.changed',
          payload: { task },
        },
      );
      return { task, event };
    });
  }

  async edit(
    input: TaskMutationInput<'task.edit'>,
  ): Promise<TaskMutationResult> {
    return this.execute(input.commandId, () => {
      const task = this.requireMutableTask(
        input.taskId,
        input.expectedRevision,
      );
      const updated = this.update(task, input.expectedRevision, {
        ...input.patch,
        updatedAt: this.now(),
      });
      return {
        task: updated,
        event: this.appendTaskEvent(updated, 'task.changed'),
      };
    });
  }

  async reorder(
    input: TaskMutationInput<'task.reorder'>,
  ): Promise<TaskMutationResult> {
    return this.execute(input.commandId, () => {
      const task = this.requireMutableTask(
        input.taskId,
        input.expectedRevision,
      );
      const updated = this.update(task, input.expectedRevision, {
        rank: this.availableRank(task, input.rank),
        updatedAt: this.now(),
      });
      return {
        task: updated,
        event: this.appendTaskEvent(updated, 'task.rank_changed'),
      };
    });
  }

  async block(
    input: TaskMutationInput<'task.block'>,
  ): Promise<TaskMutationResult> {
    return this.changeBlock(input, true);
  }

  async unblock(
    input: TaskMutationInput<'task.unblock'>,
  ): Promise<TaskMutationResult> {
    return this.changeBlock(input, false);
  }

  async transition(
    input: TaskMutationInput<'task.transition'>,
  ): Promise<TaskMutationResult> {
    return this.execute(input.commandId, () => {
      const task = this.requireMutableTask(
        input.taskId,
        input.expectedRevision,
      );
      const nextState = taskLifecycleStateSchema.parse(input.nextState);
      authorizeTaskTransition({
        task,
        nextState,
        actor: input.actor,
        reason: input.reason,
      });
      const occurredAt = this.now();
      const updated = this.update(task, input.expectedRevision, {
        lifecycleState: nextState,
        updatedAt: occurredAt,
      });
      const transition = this.appendTransition(
        input.commandId,
        task,
        updated,
        input.actor,
        input.reason,
        occurredAt,
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
      return { task: updated, event, transition };
    });
  }

  private async changeBlock(
    input: TaskMutationInput<'task.block'> | TaskMutationInput<'task.unblock'>,
    blocked: boolean,
  ): Promise<TaskMutationResult> {
    return this.execute(input.commandId, () => {
      const task = this.requireMutableTask(
        input.taskId,
        input.expectedRevision,
      );
      authorizeTaskTransition({
        task,
        nextState: task.lifecycleState,
        actor: input.actor,
        reason: input.reason,
        blocked,
      });
      const occurredAt = this.now();
      const condition = blocked
        ? { reason: input.reason, actor: input.actor, blockedAt: occurredAt }
        : null;
      const updated = this.update(task, input.expectedRevision, {
        blocked: condition,
        updatedAt: occurredAt,
      });
      const transition = this.appendTransition(
        input.commandId,
        task,
        updated,
        input.actor,
        input.reason,
        occurredAt,
      );
      const event = this.dependencies.projectEvents.appendInTransaction(
        updated.projectId,
        {
          protocolVersion: 1,
          id: this.createId(),
          projectId: updated.projectId,
          occurredAt,
          type: 'task.block_changed',
          payload: { task: updated, blocked: condition },
        },
      );
      return { task: updated, event, transition };
    });
  }

  private async execute(
    commandId: string,
    mutation: () => TaskMutationResult,
  ): Promise<TaskMutationResult> {
    const parsedCommandId = idSchema.parse(commandId);
    return this.dependencies.commands.executeOnceInImmediateTransaction(
      parsedCommandId,
      mutation,
    );
  }

  private requireActiveProject(projectId: string): Project {
    const project = this.dependencies.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (project.archivedAt) throw new ProjectArchivedError(project);
    return project;
  }

  private requireMutableTask(taskId: string, expectedRevision: number): Task {
    const task = this.dependencies.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.requireActiveProject(task.projectId);
    if (task.revision !== expectedRevision) {
      throw new TaskRevisionConflictError(task);
    }
    return task;
  }

  private update(
    task: Task,
    expectedRevision: number,
    patch: Partial<Task>,
  ): Task {
    const updated = this.dependencies.tasks.update(
      { ...task, ...patch },
      expectedRevision,
    );
    if (!updated) {
      throw new TaskRevisionConflictError(
        this.dependencies.tasks.get(task.id) ?? task,
      );
    }
    return updated;
  }

  private appendTaskEvent(
    task: Task,
    type: 'task.changed' | 'task.rank_changed',
  ): ProjectEvent {
    return this.dependencies.projectEvents.appendInTransaction(task.projectId, {
      protocolVersion: 1,
      id: this.createId(),
      projectId: task.projectId,
      occurredAt: task.updatedAt,
      type,
      payload: { task },
    });
  }

  private appendTransition(
    commandId: string,
    previous: Task,
    next: Task,
    actor: TaskMutationInput<'task.transition'>['actor'],
    reason: string | undefined,
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
        reason: reason ?? null,
        occurredAt,
      }),
    );
  }

  private nextRank(
    projectId: string,
    lifecycleState: Task['lifecycleState'],
  ): string {
    const last = this.dependencies.tasks
      .listByProject(projectId)
      .filter((task) => task.lifecycleState === lifecycleState)
      .map((task) => task.rank)
      .sort()
      .at(-1);
    return last ? `${last}m` : 'm';
  }

  private availableRank(task: Task, requested: string): string {
    const occupied = new Set(
      this.dependencies.tasks
        .listByProject(task.projectId)
        .filter(
          (candidate) =>
            candidate.id !== task.id &&
            candidate.lifecycleState === task.lifecycleState,
        )
        .map((candidate) => candidate.rank),
    );
    let rank = requested;
    while (occupied.has(rank)) rank += 'm';
    return rank;
  }
}
