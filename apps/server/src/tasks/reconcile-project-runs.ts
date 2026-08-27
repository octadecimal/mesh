import {
  type AttemptRepair,
  type Project,
  type ProjectEvent,
  type ProjectRun,
  type ProjectRunItem,
  type Task,
  type TaskAttempt,
} from '@mesh-session-platform/contracts';

import type { ProjectRunRepository } from '../repositories/project-run-repository.js';
import {
  reconcileTaskAttempts,
  type ReconciliationDependencies,
} from './reconcile-attempts.js';

export type ProjectRunRepairReason =
  | 'launch_outcome_unknown'
  | 'capacity_ambiguous'
  | 'repository_unsafe'
  | 'audit_failed'
  | 'billing_conflict';

export type ProjectRunReconciliationResult = {
  repairedItemIds: string[];
  pausedRunIds: string[];
  launchableRunIds: string[];
};

export type ProjectRunReconciliationDependencies =
  ReconciliationDependencies & {
    projectRuns: Pick<
      ProjectRunRepository,
      | 'get'
      | 'listByProject'
      | 'linkLaunch'
      | 'finishItem'
      | 'changeState'
      | 'reconcileCounts'
    >;
    billingConflicts?: readonly { variable: string }[];
  };

export type ReconcileProjectRuns = (
  dependencies: ProjectRunReconciliationDependencies,
) => ProjectRunReconciliationResult;

export class ProjectRunReconciliationError extends Error {
  constructor(
    readonly code: ProjectRunRepairReason,
    readonly cause?: unknown,
  ) {
    super(`Project run reconciliation failed: ${code}`);
    this.name = 'ProjectRunReconciliationError';
  }
}

const liveSessionStates = new Set([
  'starting',
  'running',
  'waiting_for_approval',
  'interrupting',
]);

const projectRunAttempt = (
  attempt: TaskAttempt,
  runId: string,
  itemId: string,
): boolean =>
  attempt.unlinkedAt === null &&
  typeof attempt.source === 'object' &&
  attempt.source.type === 'project_run' &&
  attempt.source.runId === runId &&
  attempt.source.runItemId === itemId;

const taskOutcome = (
  project: Project,
  task: Task,
  item: ProjectRunItem,
):
  | { status: 'completed' | 'attention_required'; reason: string }
  | undefined => {
  if (task.lifecycleState === 'done') {
    return { status: 'completed', reason: 'task_done' };
  }
  if (task.blocked) {
    return { status: 'attention_required', reason: 'developer_blocked' };
  }
  if (task.lifecycleState !== 'review') return undefined;
  if (
    task.reviewAutomation.status === 'paused' &&
    task.reviewAutomation.rejectionCount >= 3
  ) {
    return {
      status: 'attention_required',
      reason: 'qa_rejection_ceiling',
    };
  }
  if (
    project.qaConfiguration.revision === item.policyRevision &&
    project.qaConfiguration.reviewPolicy === 'manual'
  ) {
    return { status: 'attention_required', reason: 'manual_review' };
  }
  if (task.reviewAutomation.status === 'paused') {
    return {
      status: 'attention_required',
      reason: 'review_automation_paused',
    };
  }
  return undefined;
};

const appendRunEvent = (
  dependencies: ProjectRunReconciliationDependencies,
  run: ProjectRun,
  reason: string,
  occurredAt: string,
): ProjectEvent =>
  dependencies.projectEvents.appendInTransaction(run.projectId, {
    protocolVersion: 1,
    id: `project-run-reconcile-${run.id}-${run.revision}-${reason}`,
    projectId: run.projectId,
    occurredAt,
    type: 'project.run_changed',
    payload: { run },
  });

const mutateRun = (
  dependencies: ProjectRunReconciliationDependencies,
  runId: string,
  reason: string,
  occurredAt: string,
  mutate: (run: ProjectRun) => ProjectRun,
): ProjectRun => {
  dependencies.database.exec('BEGIN IMMEDIATE');
  try {
    const current = dependencies.projectRuns.get(runId);
    if (!current) {
      throw new ProjectRunReconciliationError('repository_unsafe');
    }
    const run = mutate(current);
    appendRunEvent(dependencies, run, reason, occurredAt);
    dependencies.database.exec('COMMIT');
    return run;
  } catch (error) {
    if (dependencies.database.inTransaction) {
      dependencies.database.exec('ROLLBACK');
    }
    if (error instanceof ProjectRunReconciliationError) throw error;
    throw new ProjectRunReconciliationError('audit_failed', error);
  }
};

const pauseRun = (
  dependencies: ProjectRunReconciliationDependencies,
  run: ProjectRun,
  reason: ProjectRunRepairReason,
  occurredAt: string,
): ProjectRun =>
  mutateRun(dependencies, run.id, reason, occurredAt, (current) => {
    const paused = dependencies.projectRuns.changeState({
      runId: current.id,
      expectedRunRevision: current.revision,
      state: 'paused',
      occurredAt,
    });
    if (!paused) {
      throw new ProjectRunReconciliationError('capacity_ambiguous');
    }
    return paused;
  });

const finishItem = (
  dependencies: ProjectRunReconciliationDependencies,
  run: ProjectRun,
  item: ProjectRunItem,
  status: 'completed' | 'attention_required',
  reason: string,
  occurredAt: string,
): ProjectRun =>
  mutateRun(
    dependencies,
    run.id,
    `item-${item.id}-${reason}`,
    occurredAt,
    (current) =>
      dependencies.projectRuns.finishItem({
        runId: current.id,
        itemId: item.id,
        expectedRunRevision: current.revision,
        status,
        outcomeReason: reason,
        occurredAt,
      }),
  );

const completeRun = (
  dependencies: ProjectRunReconciliationDependencies,
  run: ProjectRun,
  completionReason: 'queue_finished' | 'stopped',
  occurredAt: string,
): ProjectRun =>
  mutateRun(
    dependencies,
    run.id,
    `complete-${completionReason}`,
    occurredAt,
    (current) => {
      const completed = dependencies.projectRuns.changeState({
        runId: current.id,
        expectedRunRevision: current.revision,
        state: 'completed',
        completionReason,
        occurredAt,
      });
      if (!completed) {
        throw new ProjectRunReconciliationError('capacity_ambiguous');
      }
      return completed;
    },
  );

const linkLaunch = (
  dependencies: ProjectRunReconciliationDependencies,
  run: ProjectRun,
  item: ProjectRunItem,
  attempt: TaskAttempt,
  occurredAt: string,
): ProjectRun =>
  mutateRun(dependencies, run.id, `link-${item.id}`, occurredAt, (current) =>
    dependencies.projectRuns.linkLaunch({
      runId: current.id,
      itemId: item.id,
      expectedRunRevision: current.revision,
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      occurredAt,
    }),
  );

const repairForItem = (
  repairs: readonly AttemptRepair[],
  item: ProjectRunItem,
  matchingAttempts: readonly TaskAttempt[],
): AttemptRepair | undefined =>
  repairs.find(
    (repair) =>
      repair.taskId === item.taskId &&
      (item.attemptId !== null
        ? repair.attemptId === item.attemptId
        : matchingAttempts.some(({ id }) => id === repair.attemptId)),
  );

export const reconcileProjectRuns: ReconcileProjectRuns = (dependencies) => {
  let attemptRepairs: AttemptRepair[];
  try {
    attemptRepairs = reconcileTaskAttempts(dependencies).repairs;
  } catch (error) {
    throw new ProjectRunReconciliationError('audit_failed', error);
  }

  const repairedItemIds: string[] = [];
  const pausedRunIds: string[] = [];
  const launchableRunIds = new Set<string>();
  const occurredAt = (dependencies.now ?? (() => new Date().toISOString()))();

  for (const project of dependencies.projects.list()) {
    for (const initialRun of dependencies.projectRuns.listByProject(
      project.id,
    )) {
      if (initialRun.state === 'completed' || initialRun.state === 'paused') {
        continue;
      }
      let run: ProjectRun = initialRun;

      if (run.state === 'running') {
        const unsafeRepository =
          project.archivedAt !== null ||
          !project.repositoryPath.trim() ||
          !project.repositoryIdentity;
        const pauseReason: ProjectRunRepairReason | undefined = unsafeRepository
          ? 'repository_unsafe'
          : (dependencies.billingConflicts?.length ?? 0) > 0
            ? 'billing_conflict'
            : undefined;
        if (pauseReason) {
          pauseRun(dependencies, run, pauseReason, occurredAt);
          pausedRunIds.push(run.id);
          continue;
        }
      }

      const initialCounts = dependencies.projectRuns.reconcileCounts(run.id);
      if (
        initialCounts.launchPending + initialCounts.active >
        run.concurrency
      ) {
        if (run.state === 'draining') {
          throw new ProjectRunReconciliationError('capacity_ambiguous');
        }
        pauseRun(dependencies, run, 'capacity_ambiguous', occurredAt);
        pausedRunIds.push(run.id);
        continue;
      }

      let paused = false;
      let retryablePending = false;
      for (const originalItem of run.items) {
        if (
          originalItem.status !== 'launch_pending' &&
          originalItem.status !== 'active'
        ) {
          continue;
        }
        run = dependencies.projectRuns.get(run.id) ?? run;
        const item = run.items.find(({ id }) => id === originalItem.id);
        if (
          !item ||
          (item.status !== 'launch_pending' && item.status !== 'active')
        ) {
          continue;
        }
        const task = dependencies.tasks.get(item.taskId);
        if (!task || task.projectId !== run.projectId) {
          pauseRun(dependencies, run, 'repository_unsafe', occurredAt);
          pausedRunIds.push(run.id);
          paused = true;
          break;
        }

        const outcome = taskOutcome(project, task, item);
        if (outcome) {
          run = finishItem(
            dependencies,
            run,
            item,
            outcome.status,
            outcome.reason,
            occurredAt,
          );
          repairedItemIds.push(item.id);
          continue;
        }

        const currentAttempts = dependencies.attempts
          .listByTask(item.taskId)
          .filter(({ unlinkedAt }) => unlinkedAt === null);
        const matching = currentAttempts.filter((attempt) =>
          projectRunAttempt(attempt, run.id, item.id),
        );
        if (matching.length > 1) {
          pauseRun(dependencies, run, 'capacity_ambiguous', occurredAt);
          pausedRunIds.push(run.id);
          paused = true;
          break;
        }

        const repair = repairForItem(attemptRepairs, item, matching);
        if (repair?.reason === 'startup_outcome_unknown') {
          pauseRun(dependencies, run, 'launch_outcome_unknown', occurredAt);
          pausedRunIds.push(run.id);
          paused = true;
          break;
        }
        if (repair) {
          run = finishItem(
            dependencies,
            run,
            item,
            'attention_required',
            repair.reason,
            occurredAt,
          );
          repairedItemIds.push(item.id);
          continue;
        }

        if (item.status === 'launch_pending' && matching.length === 0) {
          if (currentAttempts.length > 0) {
            run = finishItem(
              dependencies,
              run,
              item,
              'attention_required',
              'conflicting_manual_launch',
              occurredAt,
            );
            repairedItemIds.push(item.id);
            continue;
          }
          if (
            task.lifecycleState === 'ready' &&
            !task.blocked &&
            task.revision === item.taskRevision
          ) {
            retryablePending = true;
            continue;
          }
          pauseRun(dependencies, run, 'launch_outcome_unknown', occurredAt);
          pausedRunIds.push(run.id);
          paused = true;
          break;
        }

        const attempt = matching[0];
        const session = attempt
          ? dependencies.sessions.get(attempt.sessionId)
          : undefined;
        if (
          !attempt ||
          !session ||
          session.projectId !== run.projectId ||
          !liveSessionStates.has(session.lifecycleState)
        ) {
          pauseRun(dependencies, run, 'launch_outcome_unknown', occurredAt);
          pausedRunIds.push(run.id);
          paused = true;
          break;
        }
        if (item.status === 'launch_pending') {
          run = linkLaunch(dependencies, run, item, attempt, occurredAt);
          repairedItemIds.push(item.id);
          continue;
        }
        if (
          item.attemptId !== attempt.id ||
          item.sessionId !== attempt.sessionId
        ) {
          pauseRun(dependencies, run, 'capacity_ambiguous', occurredAt);
          pausedRunIds.push(run.id);
          paused = true;
          break;
        }
      }

      if (paused) continue;
      run = dependencies.projectRuns.get(run.id) ?? run;
      const counts = dependencies.projectRuns.reconcileCounts(run.id);
      const occupied = counts.launchPending + counts.active;
      if (run.state === 'draining') {
        if (occupied === 0) {
          completeRun(dependencies, run, 'stopped', occurredAt);
        }
        continue;
      }
      if (occupied === 0 && counts.queued === 0) {
        completeRun(dependencies, run, 'queue_finished', occurredAt);
        continue;
      }
      if (
        retryablePending ||
        (counts.queued > 0 && occupied < run.concurrency)
      ) {
        launchableRunIds.add(run.id);
      }
    }
  }

  return {
    repairedItemIds,
    pausedRunIds,
    launchableRunIds: [...launchableRunIds],
  };
};
