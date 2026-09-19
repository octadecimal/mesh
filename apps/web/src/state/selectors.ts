import type {
  AttemptRepair,
  Project,
  ProjectRun,
  SavedLayout,
  Session,
  Task,
  TaskAttempt,
  TaskTransition,
} from '@mesh-session-platform/contracts';
import { compareCodeUnits } from '@mesh-session-platform/contracts';

import type { MeshProjection, PendingApproval } from './reducer';

export const selectProjects = (state: MeshProjection) => state.projects;
export const selectWorkspaces = (state: MeshProjection) => state.workspaces;
export const selectSessions = (state: MeshProjection) => state.sessions;
export const selectSelectedSessionId = (state: MeshProjection) =>
  state.selectedSessionId;

export type BoardColumn = 'backlog' | 'ready' | 'in_progress' | 'review';

export const selectProject = (
  state: MeshProjection,
  projectId: string,
): Project | undefined => state.projectsById[projectId];

export const selectBoardTasks = (
  state: MeshProjection,
  projectId: string,
): Record<BoardColumn, Task[]> => {
  const columns: Record<BoardColumn, Task[]> = {
    backlog: [],
    ready: [],
    in_progress: [],
    review: [],
  };
  for (const task of Object.values(state.tasksById)) {
    if (task.projectId !== projectId) continue;
    if (task.lifecycleState in columns)
      columns[task.lifecycleState as BoardColumn].push(task);
  }
  for (const tasks of Object.values(columns)) {
    tasks.sort((left, right) => left.rank.localeCompare(right.rank));
  }
  return columns;
};

export const selectTaskAttempts = (
  state: MeshProjection,
  taskId: string,
): Array<{ attempt: TaskAttempt; session?: Session }> => {
  const sessionsById = new Map(
    state.sessions.map((session) => [session.id, session]),
  );
  return Object.values(state.attemptsById)
    .filter((attempt) => attempt.taskId === taskId)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((attempt) => ({
      attempt,
      session: sessionsById.get(attempt.sessionId),
    }));
};

export const selectTaskTransitions = (
  state: MeshProjection,
  taskId: string,
): TaskTransition[] =>
  [...(state.transitionsByTaskId[taskId] ?? [])].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );

export const selectProjectRepairConditions = (
  state: MeshProjection,
  projectId: string,
): AttemptRepair[] => [...(state.repairsByProjectId[projectId] ?? [])];

export const selectProjectRuns = (
  state: MeshProjection,
  projectId: string,
): ProjectRun[] =>
  (state.projectRunIdsByProjectId[projectId] ?? []).flatMap((runId) => {
    const run = state.projectRunsById[runId];
    return run ? [run] : [];
  });

export const selectActiveProjectRun = (
  state: MeshProjection,
  projectId: string,
): ProjectRun | undefined =>
  selectProjectRuns(state, projectId).find((run) => run.state !== 'completed');

export const selectUnmetPrerequisiteIds = (
  state: MeshProjection,
  taskId: string,
): string[] =>
  (state.dependenciesByTaskId[taskId] ?? [])
    .filter(
      ({ prerequisiteTaskId }) =>
        state.tasksById[prerequisiteTaskId]?.lifecycleState !== 'done',
    )
    .map(({ prerequisiteTaskId }) => prerequisiteTaskId);

export const selectUnmetPrerequisiteCount = (
  state: MeshProjection,
  taskId: string,
): number => selectUnmetPrerequisiteIds(state, taskId).length;

export const selectDependentTaskIds = (
  state: MeshProjection,
  taskId: string,
): string[] =>
  (state.dependentsByTaskId[taskId] ?? []).map(
    ({ taskId: dependentTaskId }) => dependentTaskId,
  );

export const selectEligibleRunPreview = (
  state: MeshProjection,
  projectId: string,
): Task[] => {
  const taskIdsWithCurrentAttempt = new Set(
    Object.values(state.attemptsById)
      .filter((attempt) => attempt.unlinkedAt === null)
      .map((attempt) => attempt.taskId),
  );
  return Object.values(state.tasksById)
    .filter(
      (task) =>
        task.projectId === projectId &&
        task.lifecycleState === 'ready' &&
        task.blocked === null &&
        selectUnmetPrerequisiteCount(state, task.id) === 0 &&
        !taskIdsWithCurrentAttempt.has(task.id),
    )
    .sort(
      (left, right) =>
        compareCodeUnits(left.rank, right.rank) ||
        compareCodeUnits(left.id, right.id),
    );
};

export const selectBoardAttention = (
  state: MeshProjection,
  projectId: string,
) => {
  const repairs = selectProjectRepairConditions(state, projectId);
  return Object.values(state.tasksById).flatMap((task) => {
    if (
      task.projectId !== projectId ||
      ['done', 'cancelled'].includes(task.lifecycleState)
    )
      return [];
    const repair = repairs.find((candidate) => candidate.taskId === task.id);
    if (repair)
      return [
        { task, reason: `Repair needed: ${repair.reason.replace(/_/g, ' ')}.` },
      ];
    if (task.blocked)
      return [{ task, reason: `Blocked: ${task.blocked.reason}` }];
    if (task.lifecycleState !== 'review') return [];
    const project = selectProject(state, projectId);
    const automation =
      state.reviewAutomationByTaskId[task.id]?.status ??
      task.reviewAutomation.status;
    if (
      project?.qaConfiguration?.reviewPolicy === 'autonomous_review' &&
      automation === 'enabled'
    )
      return [];
    const attempts = selectTaskAttempts(state, task.id);
    const qaCycles = attempts.flatMap(
      ({ attempt }) => state.qaCyclesByAttemptId[attempt.id] ?? [],
    );
    if (qaCycles.some((cycle) => cycle.endedAt === null)) return [];
    const latestDeveloperReport = attempts
      .flatMap(({ attempt }) =>
        (state.developerCyclesByAttemptId[attempt.id] ?? []).flatMap(
          (cycle) => state.developerCompletionReportsByCycleId[cycle.id] ?? [],
        ),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    const latestQaCycle = qaCycles
      .filter(
        (cycle) =>
          cycle.developerCompletionReportId === latestDeveloperReport?.id,
      )
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .at(-1);
    const qaReport = latestQaCycle
      ? state.qaReportsByCycleId[latestQaCycle.id]
      : undefined;
    const reason =
      qaReport?.disposition === 'verified'
        ? 'QA verified the work. Accept the result.'
        : qaReport?.disposition === 'rejected'
          ? 'QA rejected the work. Review feedback and resume rework.'
          : latestDeveloperReport
            ? 'Developer submitted work. Start QA review.'
            : 'Review this task and choose its next action.';
    return [{ task, reason }];
  });
};

const layoutSpecificity = ({
  projectId,
  workspaceId,
  sessionId,
}: SavedLayout) =>
  (projectId ? 1 : 0) + (workspaceId ? 2 : 0) + (sessionId ? 4 : 0);

export const savedLayoutMatchesSession = (
  layout: SavedLayout,
  session: Session,
) =>
  (!layout.projectId || layout.projectId === session.projectId) &&
  (!layout.workspaceId || layout.workspaceId === session.workspaceId) &&
  (!layout.sessionId || layout.sessionId === session.id);

export const selectSavedLayout = (
  state: MeshProjection,
): SavedLayout | undefined => {
  const selected = state.sessions.find(
    ({ id }) => id === state.selectedSessionId,
  );
  if (!selected) return state.layouts[0];

  return state.layouts
    .filter((layout) => savedLayoutMatchesSession(layout, selected))
    .reduce<
      SavedLayout | undefined
    >((best, layout) => (!best || layoutSpecificity(layout) > layoutSpecificity(best) ? layout : best), undefined);
};

export const selectSessionFilter = (
  state: MeshProjection,
  savedLayout?: SavedLayout,
) => {
  const savedSidebar = savedLayout?.sidebar;
  const savedFilter =
    typeof savedSidebar === 'object' &&
    savedSidebar !== null &&
    typeof (savedSidebar as { filter?: unknown }).filter === 'string'
      ? (savedSidebar as { filter: string }).filter
      : '';
  return state.filters.sessions ?? savedFilter;
};

export const selectSessionEvents = (state: MeshProjection, sessionId: string) =>
  state.events.filter((event) => event.sessionId === sessionId);

export const selectPendingApprovals = (
  state: MeshProjection,
): PendingApproval[] =>
  state.pendingApprovals.filter(
    (event): event is PendingApproval => event.type === 'permission.requested',
  );

export const selectUnreadSessionIds = (state: MeshProjection) =>
  Object.keys(state.unreadSessionIds).filter(
    (id) => state.unreadSessionIds[id],
  );
