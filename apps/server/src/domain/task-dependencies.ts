import type { Task, TaskDependency } from '@mesh-session-platform/contracts';

export type ValidateDependencyGraphInput = {
  tasks: readonly Task[];
  dependencies: readonly TaskDependency[];
};

type TaskDependencyErrorCode =
  | 'task_dependency_cycle'
  | 'task_dependency_conflict'
  | 'task_dependency_invalid';

export class TaskDependencyGraphError extends Error {
  constructor(
    readonly code: TaskDependencyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const compareIds = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export const validateDependencyGraph = ({
  tasks,
  dependencies,
}: ValidateDependencyGraphInput): void => {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const prerequisitesByTaskId = new Map<string, string[]>();
  const edgeKeys = new Set<string>();

  for (const dependency of dependencies) {
    const task = tasksById.get(dependency.taskId);
    const prerequisite = tasksById.get(dependency.prerequisiteTaskId);
    const edgeKey = `${dependency.taskId}\u0000${dependency.prerequisiteTaskId}`;

    if (edgeKeys.has(edgeKey)) {
      throw new TaskDependencyGraphError(
        'task_dependency_conflict',
        'A task dependency may only be proposed once.',
      );
    }
    edgeKeys.add(edgeKey);

    if (
      dependency.taskId === dependency.prerequisiteTaskId ||
      !task ||
      !prerequisite ||
      dependency.projectId !== task.projectId ||
      task.projectId !== prerequisite.projectId
    ) {
      throw new TaskDependencyGraphError(
        'task_dependency_invalid',
        'Task dependencies must reference tasks in the same project.',
      );
    }

    const prerequisites = prerequisitesByTaskId.get(task.id) ?? [];
    prerequisites.push(prerequisite.id);
    prerequisitesByTaskId.set(task.id, prerequisites);
  }

  for (const prerequisites of prerequisitesByTaskId.values()) {
    prerequisites.sort(compareIds);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      throw new TaskDependencyGraphError(
        'task_dependency_cycle',
        'Task dependencies must not contain a cycle.',
      );
    }
    if (visited.has(taskId)) return;

    visiting.add(taskId);
    for (const prerequisiteId of prerequisitesByTaskId.get(taskId) ?? []) {
      visit(prerequisiteId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const taskId of [...tasksById.keys()].sort(compareIds)) {
    visit(taskId);
  }
};

export const incompletePrerequisiteIds = (
  taskId: string,
  tasks: readonly Task[],
  dependencies: readonly TaskDependency[],
): string[] => {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const prerequisiteIds = new Set<string>();

  for (const dependency of dependencies) {
    if (dependency.taskId !== taskId) continue;
    const prerequisite = tasksById.get(dependency.prerequisiteTaskId);
    if (prerequisite && prerequisite.lifecycleState !== 'done') {
      prerequisiteIds.add(prerequisite.id);
    }
  }

  return [...prerequisiteIds].sort(compareIds);
};
