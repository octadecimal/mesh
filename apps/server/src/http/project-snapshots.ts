import { z } from 'zod';
import {
  projectHistorySchema,
  projectSnapshotSchema,
} from '@mesh-session-platform/contracts';

import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { TaskTransitionRepository } from '../repositories/task-transition-repository.js';
import { CommandError } from './errors.js';

export interface ProjectSnapshotDependencies {
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: Pick<TaskAttemptRepository, 'listByTask'>;
  transitions: TaskTransitionRepository;
  projectEvents: ProjectEventRepository;
}

const projectHistoryQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
});

const requireProject = (
  dependencies: ProjectSnapshotDependencies,
  projectId: string,
) => {
  const project = dependencies.projects.get(projectId);
  if (!project) {
    throw new CommandError(
      'project_not_found',
      `Project '${projectId}' was not found`,
    );
  }
  return project;
};

export const buildProjectSnapshot = (
  dependencies: ProjectSnapshotDependencies,
  projectId: string,
) => {
  const project = requireProject(dependencies, projectId);
  const tasks = dependencies.tasks.listByProject(project.id);

  return projectSnapshotSchema.parse({
    protocolVersion: 1,
    project,
    tasks,
    attempts: tasks.flatMap((task) =>
      dependencies.attempts.listByTask(task.id),
    ),
    transitions: tasks.flatMap((task) =>
      dependencies.transitions.listByTask(task.id),
    ),
    repairs: [],
    cursor: dependencies.projectEvents.latestSequence(project.id),
  });
};

export const readProjectHistory = (
  dependencies: ProjectSnapshotDependencies,
  projectId: string,
  query: unknown,
) => {
  const project = requireProject(dependencies, projectId);
  const { after } = projectHistoryQuerySchema.parse(query);

  return projectHistorySchema.parse({
    protocolVersion: 1,
    projectId: project.id,
    events: dependencies.projectEvents.after(project.id, after),
    cursor: dependencies.projectEvents.latestSequence(project.id),
  });
};
