import type {
  Session,
  Task,
  TaskAttempt,
  TaskLifecycleState,
} from '@mesh-session-platform/contracts';
import type { DragEvent } from 'react';

type AttemptSummary = { attempt: TaskAttempt; session?: Session };

type TaskCardProps = {
  task: Task;
  attempts: AttemptSummary[];
  readOnly: boolean;
  pending: boolean;
  error?: string;
  unmetPrerequisiteCount: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelectTask?: (taskId: string) => void;
  onMoveTo: (state: TaskLifecycleState) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

const statusLabels: Record<TaskLifecycleState, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

const priorityLabels: Record<Task['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export function TaskCard({
  task,
  attempts,
  readOnly,
  pending,
  error,
  unmetPrerequisiteCount,
  canMoveUp,
  canMoveDown,
  onSelectTask,
  onMoveTo,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: TaskCardProps) {
  const movementDisabled = readOnly || pending;

  return (
    <article
      className={`task-card${task.blocked ? ' task-card-blocked' : ''}`}
      aria-label={`${task.title} task card`}
      aria-busy={pending || undefined}
      data-pending={pending ? 'true' : undefined}
      draggable={!movementDisabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="task-card-heading">
        <button
          type="button"
          className="task-card-title"
          aria-label={`Open ${task.title}`}
          onClick={() => onSelectTask?.(task.id)}
        >
          {task.title}
        </button>
        <span
          className={`task-priority task-priority-${task.priority}`}
          aria-label={`Priority: ${priorityLabels[task.priority]}`}
        >
          {priorityLabels[task.priority]}
        </span>
      </div>
      {task.labels.length > 0 ? (
        <div className="task-labels" aria-label="Labels">
          {task.labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      ) : null}
      <div className="task-card-summary">
        <span>
          {attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'}
        </span>
        <span aria-label={`Manual rank ${task.rank}`}>Rank {task.rank}</span>
      </div>
      {unmetPrerequisiteCount > 0 ? (
        <p className="task-dependency-count">
          {unmetPrerequisiteCount} unmet{' '}
          {unmetPrerequisiteCount === 1 ? 'prerequisite' : 'prerequisites'}
        </p>
      ) : null}
      {task.blocked ? (
        <div className="task-blocked" role="note">
          <strong>Blocked</strong>
          <span>{task.blocked.reason}</span>
        </div>
      ) : null}
      {pending ? (
        <p className="task-pending" role="status">
          Move pending… waiting for project update.
        </p>
      ) : null}
      {error ? (
        <p className="task-move-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="task-move-controls">
        <label>
          <span className="sr-only">Move {task.title} to</span>
          <select
            aria-label={`Move ${task.title} to`}
            value={task.lifecycleState}
            disabled={movementDisabled}
            onChange={(event) =>
              onMoveTo(event.target.value as TaskLifecycleState)
            }
          >
            {(Object.keys(statusLabels) as TaskLifecycleState[]).map(
              (state) => (
                <option key={state} value={state}>
                  {statusLabels[state]}
                </option>
              ),
            )}
          </select>
        </label>
        <button
          type="button"
          aria-label={`Move ${task.title} up`}
          title="Move up"
          disabled={movementDisabled || !canMoveUp}
          onClick={onMoveUp}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`Move ${task.title} down`}
          title="Move down"
          disabled={movementDisabled || !canMoveDown}
          onClick={onMoveDown}
        >
          ↓
        </button>
      </div>
    </article>
  );
}
