import { z } from 'zod';
import {
  projectHistorySchema,
  projectSnapshotSchema,
  type AttemptRepair,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { ProjectRunRepository } from '../repositories/project-run-repository.js';
import type { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { TaskTransitionRepository } from '../repositories/task-transition-repository.js';
import { CommandError } from './errors.js';

export interface ProjectSnapshotDependencies {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: Pick<TaskAttemptRepository, 'listByTask'>;
  transitions: TaskTransitionRepository;
  projectEvents: ProjectEventRepository;
  projectRuns: Pick<ProjectRunRepository, 'listByProject'>;
  projectRunMaxConcurrency?: number;
  developerExecutions: Pick<
    DeveloperExecutionRepository,
    | 'listByTask'
    | 'listCompletionReportsByTask'
    | 'listBlockerReportsByTask'
    | 'listFeedbackByTask'
  >;
  qaExecutions: Pick<
    QaExecutionRepository,
    | 'listCyclesForAttempts'
    | 'listReportsForAttempts'
    | 'listAutomationActionsForTasks'
  >;
  repairs?: readonly AttemptRepair[];
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
) =>
  dependencies.database.transaction(() => {
    const project = requireProject(dependencies, projectId);
    const tasks = dependencies.tasks.listByProject(project.id);
    const attempts = tasks.flatMap((task) =>
      dependencies.attempts.listByTask(task.id),
    );
    const attemptIds = attempts.map(({ id }) => id);
    const taskIds = tasks.map(({ id }) => id);

    return projectSnapshotSchema.parse({
      protocolVersion: 1,
      project,
      tasks,
      attempts,
      transitions: tasks.flatMap((task) =>
        dependencies.transitions.listByTask(task.id),
      ),
      repairs: (dependencies.repairs ?? []).filter((repair) =>
        tasks.some((task) => task.id === repair.taskId),
      ),
      developerCycles: tasks.flatMap((task) =>
        dependencies.developerExecutions.listByTask(task.id),
      ),
      developerCompletionReports: tasks.flatMap((task) =>
        dependencies.developerExecutions.listCompletionReportsByTask(task.id),
      ),
      developerBlockerReports: tasks.flatMap((task) =>
        dependencies.developerExecutions.listBlockerReportsByTask(task.id),
      ),
      developerReviewFeedback: tasks.flatMap((task) =>
        dependencies.developerExecutions.listFeedbackByTask(task.id),
      ),
      qaCycles: dependencies.qaExecutions.listCyclesForAttempts(attemptIds),
      qaReports: dependencies.qaExecutions.listReportsForAttempts(attemptIds),
      reviewAutomationActions:
        dependencies.qaExecutions.listAutomationActionsForTasks(taskIds),
      runs: dependencies.projectRuns.listByProject(project.id),
      projectRunLimits: {
        maxConcurrency: dependencies.projectRunMaxConcurrency ?? 1,
      },
      cursor: dependencies.projectEvents.latestSequence(project.id),
    });
  })();

export const readProjectHistory = (
  dependencies: ProjectSnapshotDependencies,
  projectId: string,
  query: unknown,
) =>
  dependencies.database.transaction(() => {
    const project = requireProject(dependencies, projectId);
    const { after } = projectHistoryQuerySchema.parse(query);
    const retained = dependencies.projectEvents.retainedAfter(
      project.id,
      after,
    );

    return projectHistorySchema.parse({
      protocolVersion: 1,
      projectId: project.id,
      events: retained.events,
      cursor: retained.highWater,
    });
  })();
