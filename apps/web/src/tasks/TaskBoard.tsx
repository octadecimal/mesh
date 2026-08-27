import {
  taskActorSchema,
  taskSchema,
  type MutatingCommand,
  type Project,
  type Task,
  type TaskLifecycleState,
} from '@mesh-session-platform/contracts';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import type { MeshProjection } from '../state/reducer';
import {
  selectBoardTasks,
  selectProjectRepairConditions,
  selectTaskAttempts,
  selectTaskTransitions,
  type BoardColumn,
} from '../state/selectors';
import { TaskCard } from './TaskCard';
import { TaskDrawer } from './TaskDrawer';

type TaskBoardProps = {
  project: Project;
  projection: MeshProjection;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onSelectTask?: (taskId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  connected?: boolean;
};

type BoardView = 'active' | 'done' | 'cancelled';
type PendingMove =
  | {
      id: number;
      kind: 'transition';
      sourceRevision: number;
      nextState: TaskLifecycleState;
    }
  | {
      id: number;
      kind: 'reorder';
      sourceRevision: number;
      sourceRank: string;
      nextState: TaskLifecycleState;
      nextRank: string;
      authoritativeRevision?: number;
      authoritativeRank?: string;
    };
type PendingMoveInput =
  | Omit<Extract<PendingMove, { kind: 'transition' }>, 'id'>
  | Omit<Extract<PendingMove, { kind: 'reorder' }>, 'id'>;

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

const authoritativeTaskFrom = (response: unknown): Task | undefined => {
  if (
    typeof response !== 'object' ||
    response === null ||
    !('result' in response)
  )
    return undefined;
  const result = response.result;
  if (typeof result !== 'object' || result === null || !('task' in result))
    return undefined;
  const task = taskSchema.safeParse(result.task);
  return task.success ? task.data : undefined;
};

export function TaskBoard({
  project,
  projection,
  onCommand,
  onSelectTask,
  onOpenSession,
  connected = true,
}: TaskBoardProps) {
  const [view, setView] = useState<BoardView>('active');
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const [pendingMoves, setPendingMoves] = useState<Record<string, PendingMove>>(
    {},
  );
  const [moveErrors, setMoveErrors] = useState<Record<string, string>>({});
  const [drawerTaskId, setDrawerTaskId] = useState<string>();
  const [creatingTask, setCreatingTask] = useState(false);
  const [drawerProjectId, setDrawerProjectId] = useState<string>();
  const moveSequence = useRef(0);
  const activeMoveIds = useRef<Record<string, number>>({});
  const columns = selectBoardTasks(projection, project.id);
  const readOnly = Boolean(project.archivedAt);
  const selectedDrawerTask = drawerTaskId
    ? projection.tasksById[drawerTaskId]
    : undefined;
  const drawerTask =
    drawerProjectId === project.id &&
    selectedDrawerTask?.projectId === project.id
      ? selectedDrawerTask
      : undefined;
  const creatingTaskForProject = creatingTask && drawerProjectId === project.id;
  const drawerAttempts = drawerTask
    ? selectTaskAttempts(projection, drawerTask.id)
    : [];
  const drawerCycles = drawerAttempts.flatMap(
    ({ attempt }) => projection.developerCyclesByAttemptId[attempt.id] ?? [],
  );
  const drawerCycleIds = new Set(drawerCycles.map((cycle) => cycle.id));
  const drawerCompletionReports = Object.values(
    projection.developerCompletionReportsByCycleId,
  ).filter((report) => drawerCycleIds.has(report.cycleId));
  const drawerBlockerReports = Object.values(
    projection.developerBlockerReportsByCycleId,
  ).filter((report) => drawerCycleIds.has(report.cycleId));
  const drawerReviewFeedback = Object.values(
    projection.developerReviewFeedbackByCycleId,
  ).filter((entry) => drawerCycleIds.has(entry.cycleId));
  const drawerQaCycles = drawerAttempts.flatMap(
    ({ attempt }) => projection.qaCyclesByAttemptId[attempt.id] ?? [],
  );
  const drawerQaCycleIds = new Set(drawerQaCycles.map((cycle) => cycle.id));
  const drawerQaReports = Object.values(projection.qaReportsByCycleId).filter(
    (report) => drawerQaCycleIds.has(report.cycleId),
  );
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
    const settled = Object.entries(pendingMoves).filter(([taskId, move]) => {
      const task = projection.tasksById[taskId];
      if (!task) return false;
      if (move.kind === 'transition') {
        return task.revision > move.sourceRevision;
      }
      if (move.authoritativeRevision === undefined) return false;
      return (
        task.revision > move.authoritativeRevision ||
        (task.revision === move.authoritativeRevision &&
          task.rank === move.authoritativeRank)
      );
    });
    if (settled.length === 0) return;
    const conflicts: string[] = [];
    for (const [taskId, move] of settled) {
      if (activeMoveIds.current[taskId] !== move.id) continue;
      delete activeMoveIds.current[taskId];
      const task = projection.tasksById[taskId];
      const matches =
        task?.lifecycleState === move.nextState &&
        (move.kind === 'transition' || task.revision > move.sourceRevision);
      if (!matches) conflicts.push(taskId);
    }
    setPendingMoves((current) => {
      const next = { ...current };
      for (const [taskId, move] of settled) {
        if (next[taskId]?.id === move.id) delete next[taskId];
      }
      return next;
    });
    if (conflicts.length > 0) {
      setMoveErrors((current) => {
        const next = { ...current };
        for (const taskId of conflicts) {
          next[taskId] = 'Task changed before the requested move was applied.';
        }
        return next;
      });
    }
  }, [pendingMoves, projection.tasksById]);

  useEffect(() => {
    setCreatingTask(false);
    setDrawerTaskId(undefined);
    setDrawerProjectId(undefined);
  }, [project.id]);

  const submitMove = (
    task: Task,
    command: MutatingCommand,
    move: PendingMoveInput,
  ) => {
    if (readOnly || pendingMoves[task.id]) return;
    const pendingMove = { ...move, id: ++moveSequence.current } as PendingMove;
    activeMoveIds.current[task.id] = pendingMove.id;
    setMoveErrors((current) => {
      const next = { ...current };
      delete next[task.id];
      return next;
    });
    setPendingMoves((current) => ({ ...current, [task.id]: pendingMove }));
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(onCommand(command));
    } catch (caught) {
      result = Promise.reject(caught);
    }
    void result
      .then((response) => {
        if (pendingMove.kind !== 'reorder') return;
        const authoritativeTask = authoritativeTaskFrom(response);
        if (!authoritativeTask || authoritativeTask.id !== task.id) return;
        setPendingMoves((current) => {
          if (current[task.id]?.id !== pendingMove.id) return current;
          return {
            ...current,
            [task.id]: {
              ...pendingMove,
              authoritativeRevision: authoritativeTask.revision,
              authoritativeRank: authoritativeTask.rank,
            },
          };
        });
      })
      .catch((caught: unknown) => {
        if (activeMoveIds.current[task.id] !== pendingMove.id) return;
        delete activeMoveIds.current[task.id];
        setPendingMoves((current) => {
          if (current[task.id]?.id !== pendingMove.id) return current;
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
          nextState: task.lifecycleState,
          nextRank: targetRank,
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
    const selectTask = (taskId: string) => {
      setCreatingTask(false);
      setDrawerTaskId(taskId);
      setDrawerProjectId(project.id);
      onSelectTask?.(taskId);
    };
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
        onSelectTask={selectTask}
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
    <>
      <div
        className="task-board"
        data-read-only={readOnly ? 'true' : undefined}
      >
        <div className="task-board-toolbar">
          <div
            className="task-board-tabs"
            role="group"
            aria-label="Task filters"
          >
            <button
              type="button"
              aria-label="Show active tasks"
              aria-pressed={view === 'active'}
              onClick={() => setView('active')}
            >
              Active
            </button>
            <button
              type="button"
              aria-label="Show completed tasks"
              aria-pressed={view === 'done'}
              onClick={() => setView('done')}
            >
              Completed {terminalTasks.done.length}
            </button>
            <button
              type="button"
              aria-label="Show cancelled tasks"
              aria-pressed={view === 'cancelled'}
              onClick={() => setView('cancelled')}
            >
              Cancelled {terminalTasks.cancelled.length}
            </button>
          </div>
          <div className="task-board-toolbar-actions">
            {readOnly ? (
              <p className="task-board-read-only-note">Read-only task board</p>
            ) : (
              <>
                <p className="task-board-drag-help">
                  Drag cards or use each card’s move controls.
                </p>
                <button
                  className="button button-primary task-board-add"
                  type="button"
                  onClick={() => {
                    setDrawerTaskId(undefined);
                    setCreatingTask(true);
                    setDrawerProjectId(project.id);
                  }}
                >
                  Add task
                </button>
              </>
            )}
          </div>
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
      {creatingTaskForProject || drawerTask ? (
        <TaskDrawer
          key={creatingTaskForProject ? 'create' : drawerTask?.id}
          open
          project={project}
          task={drawerTask}
          attempts={drawerAttempts}
          transitions={
            drawerTask ? selectTaskTransitions(projection, drawerTask.id) : []
          }
          repairs={selectProjectRepairConditions(projection, project.id)}
          sessions={projection.sessions}
          developerCycles={drawerCycles}
          developerCompletionReports={drawerCompletionReports}
          developerBlockerReports={drawerBlockerReports}
          developerReviewFeedback={drawerReviewFeedback}
          qaCycles={drawerQaCycles}
          qaReports={drawerQaReports}
          reviewAutomation={
            drawerTask
              ? projection.reviewAutomationByTaskId[drawerTask.id]
              : undefined
          }
          connected={connected}
          onCommand={onCommand}
          onOpenSession={onOpenSession}
          onOpenChange={(open) => {
            if (open) return;
            setCreatingTask(false);
            setDrawerTaskId(undefined);
            setDrawerProjectId(undefined);
          }}
        />
      ) : null}
    </>
  );
}
