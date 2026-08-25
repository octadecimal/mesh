import {
  taskActorSchema,
  type MutatingCommand,
  type Project,
  type Task,
  type TaskLifecycleState,
} from '@mesh-session-platform/contracts';
import { useEffect, useMemo, useState, type DragEvent } from 'react';

import type { MeshProjection } from '../state/reducer';
import {
  selectBoardTasks,
  selectTaskAttempts,
  type BoardColumn,
} from '../state/selectors';
import { TaskCard } from './TaskCard';

type TaskBoardProps = {
  project: Project;
  projection: MeshProjection;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onSelectTask?: (taskId: string) => void;
};

type BoardView = 'active' | 'done' | 'cancelled';
type PendingMove =
  | {
      kind: 'transition';
      sourceRevision: number;
      nextState: TaskLifecycleState;
    }
  | { kind: 'reorder'; sourceRevision: number; sourceRank: string };

const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
});

const activeColumns: Array<{ id: BoardColumn; label: string }> = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
];

const rankAlphabet = '0123456789abcdefghijklmnopqrstuvwxyz';

const rankBefore = (successor: string): string | undefined => {
  const firstIndex = rankAlphabet.indexOf(successor.charAt(0));
  if (firstIndex > 0)
    return rankAlphabet.charAt(Math.floor((firstIndex - 1) / 2));
  if (firstIndex === 0 && successor.length > 1) return successor.slice(0, -1);
  return undefined;
};

const formattedMoveError = (caught: unknown): string => {
  const failure = caught as {
    code?: string;
    message?: string;
    details?: { problems?: unknown };
  };
  if (
    failure.code === 'task_not_ready' &&
    Array.isArray(failure.details?.problems)
  ) {
    const labels: Record<string, string> = {
      title: 'Title',
      description: 'Description',
      acceptanceCriteria: 'Acceptance criteria',
      priority: 'Priority',
    };
    const problems = failure.details.problems.map(
      (problem) => labels[String(problem)] ?? String(problem),
    );
    return `Missing readiness fields: ${problems.join(', ')}.`;
  }
  return failure.message ?? 'The task could not be moved.';
};

export function TaskBoard({
  project,
  projection,
  onCommand,
  onSelectTask,
}: TaskBoardProps) {
  const [view, setView] = useState<BoardView>('active');
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const [pendingMoves, setPendingMoves] = useState<Record<string, PendingMove>>(
    {},
  );
  const [moveErrors, setMoveErrors] = useState<Record<string, string>>({});
  const columns = selectBoardTasks(projection, project.id);
  const readOnly = Boolean(project.archivedAt);
  const terminalTasks = useMemo(() => {
    const tasks = Object.values(projection.tasksById).filter(
      (task) => task.projectId === project.id,
    );
    return {
      done: tasks
        .filter((task) => task.lifecycleState === 'done')
        .sort((left, right) => left.rank.localeCompare(right.rank)),
      cancelled: tasks
        .filter((task) => task.lifecycleState === 'cancelled')
        .sort((left, right) => left.rank.localeCompare(right.rank)),
    };
  }, [project.id, projection.tasksById]);

  useEffect(() => {
    const completed = Object.entries(pendingMoves).filter(([taskId, move]) => {
      const task = projection.tasksById[taskId];
      if (!task || task.revision <= move.sourceRevision) return false;
      return move.kind === 'transition'
        ? task.lifecycleState === move.nextState
        : task.rank !== move.sourceRank;
    });
    if (completed.length === 0) return;
    setPendingMoves((current) => {
      const next = { ...current };
      for (const [taskId] of completed) delete next[taskId];
      return next;
    });
  }, [pendingMoves, projection.tasksById]);

  const submitMove = (
    task: Task,
    command: MutatingCommand,
    move: PendingMove,
  ) => {
    if (readOnly || pendingMoves[task.id]) return;
    setMoveErrors((current) => {
      const next = { ...current };
      delete next[task.id];
      return next;
    });
    setPendingMoves((current) => ({ ...current, [task.id]: move }));
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(onCommand(command));
    } catch (caught) {
      result = Promise.reject(caught);
    }
    void result.catch((caught: unknown) => {
      setPendingMoves((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      setMoveErrors((current) => ({
        ...current,
        [task.id]: formattedMoveError(caught),
      }));
    });
  };

  const moveTask = (
    task: Task,
    nextState: TaskLifecycleState,
    targetRank?: string,
  ) => {
    if (nextState === task.lifecycleState) {
      if (!targetRank || targetRank === task.rank) return;
      submitMove(
        task,
        {
          type: 'task.reorder',
          payload: {
            taskId: task.id,
            expectedRevision: task.revision,
            rank: targetRank,
            actor: operator,
          },
        },
        {
          kind: 'reorder',
          sourceRevision: task.revision,
          sourceRank: task.rank,
        },
      );
      return;
    }
    submitMove(
      task,
      {
        type: 'task.transition',
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          nextState,
          actor: operator,
        },
      },
      {
        kind: 'transition',
        sourceRevision: task.revision,
        nextState,
      },
    );
  };

  const draggedTask = (event: DragEvent<HTMLElement>) => {
    const taskId =
      draggedTaskId || event.dataTransfer.getData('application/x-mesh-task');
    return projection.tasksById[taskId];
  };

  const renderCard = (task: Task, orderedTasks: Task[]) => {
    const index = orderedTasks.findIndex(({ id }) => id === task.id);
    const previousRank =
      index > 1
        ? orderedTasks[index - 2]?.rank
        : index === 1
          ? rankBefore(orderedTasks[0].rank)
          : undefined;
    const nextRank = orderedTasks[index + 1]?.rank;
    return (
      <TaskCard
        key={task.id}
        task={task}
        attempts={selectTaskAttempts(projection, task.id)}
        readOnly={readOnly}
        pending={Boolean(pendingMoves[task.id])}
        error={moveErrors[task.id]}
        canMoveUp={index > 0 && previousRank !== undefined}
        canMoveDown={Boolean(nextRank)}
        onSelectTask={onSelectTask}
        onMoveTo={(state) => moveTask(task, state)}
        onMoveUp={() =>
          previousRank !== undefined &&
          moveTask(task, task.lifecycleState, previousRank)
        }
        onMoveDown={() =>
          nextRank !== undefined &&
          moveTask(task, task.lifecycleState, nextRank)
        }
        onDragStart={(event) => {
          setDraggedTaskId(task.id);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('application/x-mesh-task', task.id);
        }}
        onDragEnd={() => setDraggedTaskId(undefined)}
        onDragOver={(event) => {
          if (!readOnly) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const source = draggedTask(event);
          setDraggedTaskId(undefined);
          if (!source || source.id === task.id || readOnly) return;
          moveTask(source, task.lifecycleState, task.rank);
        }}
      />
    );
  };

  return (
    <div className="task-board" data-read-only={readOnly ? 'true' : undefined}>
      <div className="task-board-toolbar">
        <div
          className="task-board-tabs"
          role="tablist"
          aria-label="Task filters"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'active'}
            onClick={() => setView('active')}
          >
            Active
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'done'}
            onClick={() => setView('done')}
          >
            Completed {terminalTasks.done.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'cancelled'}
            onClick={() => setView('cancelled')}
          >
            Cancelled {terminalTasks.cancelled.length}
          </button>
        </div>
        {readOnly ? (
          <p className="task-board-read-only-note">Read-only task board</p>
        ) : (
          <p className="task-board-drag-help">
            Drag cards or use each card’s move controls.
          </p>
        )}
      </div>
      {view === 'active' ? (
        <div className="task-board-columns">
          {activeColumns.map(({ id, label }) => {
            const tasks = columns[id];
            return (
              <section
                key={id}
                className="task-column"
                aria-label={`${label} tasks`}
                onDragOver={(event) => {
                  if (!readOnly) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const source = draggedTask(event);
                  setDraggedTaskId(undefined);
                  if (!source || readOnly) return;
                  moveTask(source, id);
                }}
              >
                <header>
                  <h3>{label}</h3>
                  <span aria-label={`${tasks.length} tasks`}>
                    {tasks.length}
                  </span>
                </header>
                <div className="task-column-cards">
                  {tasks.length > 0 ? (
                    tasks.map((task) => renderCard(task, tasks))
                  ) : (
                    <p className="task-column-empty">No tasks</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <section
          className="task-column task-column-terminal"
          aria-label={view === 'done' ? 'Completed tasks' : 'Cancelled tasks'}
        >
          <header>
            <h3>{view === 'done' ? 'Completed' : 'Cancelled'}</h3>
            <span>{terminalTasks[view].length}</span>
          </header>
          <div className="task-column-cards">
            {terminalTasks[view].length > 0 ? (
              terminalTasks[view].map((task) =>
                renderCard(task, terminalTasks[view]),
              )
            ) : (
              <p className="task-column-empty">No tasks</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
