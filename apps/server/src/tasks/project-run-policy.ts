import type {
  Project,
  ProjectRun,
  ProjectRunItem,
  Task,
} from '@mesh-session-platform/contracts';

export interface EligibleRunTask {
  task: Task;
  policyRevision: number;
  taskAutomationGeneration: number;
}

export interface SelectEligibleRunTasksInput {
  project: Project;
  tasks: readonly Task[];
  currentAttemptTaskIds: ReadonlySet<string>;
}

const compareBinaryStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const selectEligibleRunTasks = ({
  project,
  tasks,
  currentAttemptTaskIds,
}: SelectEligibleRunTasksInput): EligibleRunTask[] =>
  tasks
    .filter(
      (task) =>
        task.projectId === project.id &&
        task.lifecycleState === 'ready' &&
        task.blocked === null &&
        !currentAttemptTaskIds.has(task.id),
    )
    .sort(
      (left, right) =>
        compareBinaryStrings(left.rank, right.rank) ||
        compareBinaryStrings(left.id, right.id),
    )
    .map((task) => ({
      task,
      policyRevision: project.qaConfiguration.revision,
      taskAutomationGeneration: task.reviewAutomation.generation,
    }));

export type ProjectRunPlan =
  | { type: 'claim'; itemId: string }
  | { type: 'complete'; reason: 'queue_finished' | 'stopped' }
  | { type: 'wait'; reason: 'at_capacity' | 'run_paused' | 'draining' };

export interface PlanProjectRunInput {
  run: ProjectRun;
}

export const occupiedSlots = (run: ProjectRun): number =>
  run.items.filter(
    ({ status }) => status === 'launch_pending' || status === 'active',
  ).length;

const compareQueuedItems = (left: ProjectRunItem, right: ProjectRunItem) =>
  left.queuePosition - right.queuePosition ||
  compareBinaryStrings(left.id, right.id);

export const planProjectRun = ({
  run,
}: PlanProjectRunInput): ProjectRunPlan => {
  const occupied = occupiedSlots(run);

  if (run.state === 'paused') {
    return { type: 'wait', reason: 'run_paused' };
  }

  if (run.state === 'draining') {
    return occupied > 0
      ? { type: 'wait', reason: 'draining' }
      : { type: 'complete', reason: 'stopped' };
  }

  if (run.state === 'completed') {
    return { type: 'wait', reason: 'draining' };
  }

  if (occupied >= run.concurrency) {
    return { type: 'wait', reason: 'at_capacity' };
  }

  const next = run.items
    .filter(({ status }) => status === 'queued')
    .sort(compareQueuedItems)[0];
  if (next) {
    return { type: 'claim', itemId: next.id };
  }

  return occupied > 0
    ? { type: 'wait', reason: 'at_capacity' }
    : { type: 'complete', reason: 'queue_finished' };
};
