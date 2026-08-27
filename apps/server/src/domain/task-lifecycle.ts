import {
  idSchema,
  type Task,
  type TaskActor,
  type TaskLifecycleState,
  type TaskReadinessProblem,
} from '@mesh-session-platform/contracts';

export type AuthorizeTaskTransitionInput = {
  task: Task;
  nextState: TaskLifecycleState;
  actor: TaskActor;
  reason?: string;
  blocked?: boolean;
  operation?:
    | 'developer_submit_review'
    | 'developer_mark_blocked'
    | 'project_run_launch';
  incompletePrerequisiteIds?: readonly string[];
};

export type AuthorizeQaVerdictInput = {
  task: Task;
  actor: TaskActor;
};

export class TaskReadinessError extends Error {
  readonly code = 'task_not_ready';

  constructor(readonly problems: readonly TaskReadinessProblem[]) {
    super(`Task is not ready: ${problems.join(', ')}`);
  }
}

export class TaskBlockedError extends Error {
  readonly code = 'task_blocked';

  constructor(readonly taskId: string) {
    super(`Task ${taskId} is blocked`);
  }
}

export class TaskTransitionInvalidError extends Error {
  readonly code = 'task_transition_invalid';

  constructor(
    readonly from: TaskLifecycleState,
    readonly nextState: TaskLifecycleState,
  ) {
    super(`Cannot transition task from ${from} to ${nextState}`);
  }
}

export class TaskTransitionUnauthorizedError extends Error {
  readonly code = 'task_transition_unauthorized';

  constructor(
    readonly nextState: TaskLifecycleState,
    readonly actor: TaskActor,
  ) {
    super(`Only a human may transition a task to ${nextState}`);
  }
}

export class TaskTransitionReasonRequiredError extends Error {
  readonly code = 'task_transition_invalid';

  constructor(
    readonly from: TaskLifecycleState,
    readonly nextState: TaskLifecycleState,
  ) {
    super(
      `A reason is required to transition task from ${from} to ${nextState}`,
    );
  }
}

const transitionTable: Record<
  TaskLifecycleState,
  readonly TaskLifecycleState[]
> = {
  backlog: ['ready', 'cancelled'],
  ready: ['backlog', 'in_progress', 'cancelled'],
  in_progress: ['ready', 'review', 'cancelled'],
  review: ['in_progress', 'done', 'cancelled'],
  done: ['review'],
  cancelled: ['backlog'],
};

const backwardTransitions = new Set<string>([
  'ready:backlog',
  'in_progress:ready',
  'review:in_progress',
  'done:review',
]);

const hasReason = (reason: string | undefined) => reason?.trim().length;

export const readinessProblems = (task: Task): TaskReadinessProblem[] => {
  const problems: TaskReadinessProblem[] = [];
  if (!task.title.trim()) problems.push('title');
  if (!task.description.trim()) problems.push('description');
  if (task.acceptanceCriteria.length === 0) {
    problems.push('acceptanceCriteria');
  }
  if (!task.priority) problems.push('priority');
  return problems;
};

export const allowedTaskTransitions = (
  task: Task,
): readonly TaskLifecycleState[] => transitionTable[task.lifecycleState];

export const authorizeQaVerdict = ({
  task,
  actor,
}: AuthorizeQaVerdictInput): void => {
  if (task.lifecycleState !== 'review') {
    throw new TaskTransitionInvalidError(task.lifecycleState, 'review');
  }
  if (task.blocked) throw new TaskBlockedError(task.id);
  if (actor.type !== 'agent') {
    throw new TaskTransitionUnauthorizedError('review', actor);
  }
};

const requiresReason = ({
  task,
  nextState,
  blocked,
}: AuthorizeTaskTransitionInput): boolean =>
  nextState === 'cancelled' ||
  (task.lifecycleState === 'cancelled' && nextState === 'backlog') ||
  backwardTransitions.has(`${task.lifecycleState}:${nextState}`) ||
  (blocked !== undefined && blocked !== Boolean(task.blocked));

export const authorizeTaskTransition = (
  input: AuthorizeTaskTransitionInput,
): void => {
  const { task, nextState, actor, reason, blocked, operation } = input;
  const changesBlockedState =
    blocked !== undefined && blocked !== Boolean(task.blocked);
  const permittedStateChange = allowedTaskTransitions(task).includes(nextState);

  if (
    !permittedStateChange &&
    !(changesBlockedState && nextState === task.lifecycleState)
  ) {
    throw new TaskTransitionInvalidError(task.lifecycleState, nextState);
  }

  const developerSubmission =
    actor.type === 'agent' &&
    operation === 'developer_submit_review' &&
    task.lifecycleState === 'in_progress' &&
    nextState === 'review' &&
    !task.blocked &&
    blocked === undefined;
  const developerBlock =
    actor.type === 'agent' &&
    operation === 'developer_mark_blocked' &&
    task.lifecycleState === 'in_progress' &&
    nextState === 'in_progress' &&
    blocked === true;
  const projectRunLaunch =
    actor.type === 'system' &&
    operation === 'project_run_launch' &&
    task.lifecycleState === 'ready' &&
    nextState === 'in_progress' &&
    !task.blocked &&
    blocked === undefined;
  const developerOperation = operation !== undefined;

  if (
    (developerOperation &&
      !developerSubmission &&
      !developerBlock &&
      !projectRunLaunch) ||
    (actor.type !== 'human' &&
      !developerSubmission &&
      !developerBlock &&
      !projectRunLaunch)
  ) {
    throw new TaskTransitionUnauthorizedError(nextState, actor);
  }

  if (requiresReason(input) && !hasReason(reason)) {
    throw new TaskTransitionReasonRequiredError(task.lifecycleState, nextState);
  }

  if (nextState === 'ready' || nextState === 'in_progress') {
    const dependencyReadinessApplies =
      (task.lifecycleState === 'backlog' && nextState === 'ready') ||
      nextState === 'in_progress';
    const problems: TaskReadinessProblem[] = [
      ...readinessProblems(task),
      ...(dependencyReadinessApplies
        ? (input.incompletePrerequisiteIds ?? []).map((taskId) => ({
            type: 'dependency_incomplete' as const,
            taskId: idSchema.parse(taskId),
          }))
        : []),
    ];
    if (problems.length > 0) throw new TaskReadinessError(problems);
  }

  if (nextState === 'in_progress' && task.blocked && blocked !== false) {
    throw new TaskBlockedError(task.id);
  }
};
