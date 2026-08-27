import {
  compareCodeUnits,
  taskActorSchema,
  type MutatingCommand,
  type Project,
  type ProjectRun,
  type ProjectRunItem,
  type Task,
  type TaskActor,
} from '@mesh-session-platform/contracts';
import { useEffect, useRef, useState } from 'react';

import type { MeshProjection } from '../state/reducer';
import {
  selectActiveProjectRun,
  selectEligibleRunPreview,
  selectProjectRepairConditions,
  selectProjectRuns,
} from '../state/selectors';

export type ProjectRunPanelProps = {
  project: Project;
  projection: MeshProjection;
  connected: boolean;
  maxConcurrency: number;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onSelectTask: (taskId: string) => void;
};

const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
}) as Extract<TaskActor, { type: 'human' }>;

const stateLabels: Record<ProjectRun['state'], string> = {
  running: 'Running',
  paused: 'Paused',
  draining: 'Draining',
  completed: 'Completed',
};

const itemStatusLabels: Record<ProjectRunItem['status'], string> = {
  queued: 'Queued',
  launch_pending: 'Launch pending',
  active: 'Active',
  completed: 'Completed',
  attention_required: 'Attention required',
  not_started: 'Not started',
};

const completionLabels: Record<string, string> = {
  queue_finished: 'Queue finished',
  stopped: 'Stopped',
};

const repairLabels: Record<string, string> = {
  task_in_progress_without_live_session: 'has no live session.',
  developer_cycle_without_live_session:
    'has a Developer cycle without a live session.',
  startup_outcome_unknown: 'startup outcome is unknown.',
  qa_cycle_without_trustworthy_outcome:
    'has a QA cycle without a trustworthy outcome.',
  qa_session_workspace_mismatch: 'has a QA workspace mismatch.',
  review_automation_action_incomplete:
    'has an incomplete review automation action.',
};

const orderedItems = (run: ProjectRun) =>
  [...run.items].sort(
    (left, right) =>
      left.queuePosition - right.queuePosition ||
      compareCodeUnits(left.taskId, right.taskId),
  );

const effectiveReviewMode = (project: Project, task: Task) =>
  (project.qaConfiguration?.reviewPolicy ?? 'manual') === 'autonomous_review' &&
  task.reviewAutomation.status === 'enabled'
    ? 'Autonomous review'
    : 'Manual review';

const failureMessage = (caught: unknown, fallback: string) => {
  if (
    typeof caught === 'object' &&
    caught !== null &&
    'message' in caught &&
    typeof caught.message === 'string'
  )
    return caught.message;
  return fallback;
};

const itemCounts = (run: ProjectRun) => ({
  completed: run.items.filter(({ status }) => status === 'completed').length,
  attention: run.items.filter(({ status }) => status === 'attention_required')
    .length,
  notStarted: run.items.filter(({ status }) => status === 'not_started').length,
});

const runProjectionFingerprint = (run: ProjectRun | undefined) =>
  run ? `${run.id}:${run.revision}:${run.state}` : 'no-active-run';

type PendingAction = {
  label: string;
  baseline: string;
  settled: boolean;
};

function ItemEvidence({
  item,
  projection,
}: {
  item: ProjectRunItem;
  projection: MeshProjection;
}) {
  if (!item.attemptId) return null;
  const qaCycle = [...(projection.qaCyclesByAttemptId[item.attemptId] ?? [])]
    .sort((left, right) => right.ordinal - left.ordinal)
    .find(({ endedAt }) => endedAt === null);
  if (qaCycle)
    return (
      <span className="project-run-item-evidence">
        QA cycle {qaCycle.ordinal}
      </span>
    );
  const developerCycle = [
    ...(projection.developerCyclesByAttemptId[item.attemptId] ?? []),
  ]
    .sort((left, right) => right.ordinal - left.ordinal)
    .find(({ endedAt }) => endedAt === null);
  if (developerCycle)
    return (
      <span className="project-run-item-evidence">
        Developer cycle {developerCycle.ordinal}
      </span>
    );
  const attempt = projection.attemptsById[item.attemptId];
  return attempt?.role === 'developer' ? (
    <span className="project-run-item-evidence">
      Developer attempt {attempt.ordinal}
    </span>
  ) : null;
}

function RunItems({
  run,
  projection,
  label,
  onSelectTask,
}: {
  run: ProjectRun;
  projection: MeshProjection;
  label: string;
  onSelectTask: (taskId: string) => void;
}) {
  return (
    <ol className="project-run-items" aria-label={label}>
      {orderedItems(run).map((item) => {
        const task = projection.tasksById[item.taskId];
        const title = task?.title ?? item.taskId;
        return (
          <li key={item.id} className="project-run-item">
            <span
              className="project-run-position"
              aria-label={`Queue position ${item.queuePosition + 1}`}
            >
              {item.queuePosition + 1}
            </span>
            <div className="project-run-item-main">
              {item.status === 'attention_required' ? (
                <button
                  className="project-run-evidence-link"
                  type="button"
                  onClick={() => onSelectTask(item.taskId)}
                  aria-label={`Open ${title} evidence`}
                >
                  {title}
                </button>
              ) : (
                <strong>{title}</strong>
              )}
              <ItemEvidence item={item} projection={projection} />
              {item.outcomeReason ? (
                <span className="project-run-outcome">
                  {item.outcomeReason.replace(/_/g, ' ')}
                </span>
              ) : null}
            </div>
            <span
              className={`status project-run-status project-run-status-${item.status}`}
            >
              {itemStatusLabels[item.status]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ProjectRunPanel({
  project,
  projection,
  connected,
  maxConcurrency,
  onCommand,
  onSelectTask,
}: ProjectRunPanelProps) {
  const projectRuns = selectProjectRuns(projection, project.id);
  const activeRun = selectActiveProjectRun(projection, project.id);
  const history = projectRuns.filter(({ state }) => state === 'completed');
  const eligibleTasks = selectEligibleRunPreview(projection, project.id);
  const policyRevision = project.qaConfiguration?.revision ?? 1;
  const previewFingerprint = JSON.stringify({
    policyRevision,
    tasks: eligibleTasks.map(({ id, revision, reviewAutomation }) => ({
      id,
      revision,
      automationStatus: reviewAutomation.status,
      automationGeneration: reviewAutomation.generation,
    })),
  });
  const repairs = selectProjectRepairConditions(projection, project.id);
  const boundedMaximum = Math.max(1, maxConcurrency);
  const [authorizing, setAuthorizing] = useState(false);
  const [concurrency, setConcurrency] = useState(1);
  const [subscriptionConfirmed, setSubscriptionConfirmed] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [error, setError] = useState<string>();
  const [confirmingStop, setConfirmingStop] = useState(false);
  const currentProjectId = useRef(project.id);
  currentProjectId.current = project.id;
  const projectionFingerprint = runProjectionFingerprint(projectRuns.at(-1));
  const controlsDisabled =
    !connected || Boolean(project.archivedAt) || Boolean(pendingAction);

  useEffect(() => {
    setAuthorizing(false);
    setConcurrency(1);
    setSubscriptionConfirmed(false);
    setPendingAction(undefined);
    setError(undefined);
    setConfirmingStop(false);
  }, [project.id]);

  useEffect(() => {
    setConcurrency((current) => Math.min(Math.max(1, current), boundedMaximum));
  }, [boundedMaximum]);

  useEffect(() => {
    setSubscriptionConfirmed(false);
  }, [previewFingerprint]);

  useEffect(() => {
    if (
      pendingAction?.settled &&
      pendingAction.baseline !== projectionFingerprint
    ) {
      setPendingAction(undefined);
    }
  }, [pendingAction, projectionFingerprint]);

  useEffect(() => {
    setError(undefined);
    setConfirmingStop(false);
  }, [activeRun?.id, activeRun?.revision]);

  const execute = async (
    label: string,
    command: MutatingCommand,
    fallback: string,
  ) => {
    if (controlsDisabled) return;
    const commandProjectId = project.id;
    setPendingAction({
      label,
      baseline: projectionFingerprint,
      settled: false,
    });
    setError(undefined);
    try {
      await Promise.resolve(onCommand(command));
      if (currentProjectId.current !== commandProjectId) return;
      setPendingAction((current) =>
        current?.label === label ? { ...current, settled: true } : current,
      );
    } catch (caught) {
      if (currentProjectId.current !== commandProjectId) return;
      setError(failureMessage(caught, fallback));
      setPendingAction(undefined);
    }
  };

  const authorize = () => {
    if (!subscriptionConfirmed || eligibleTasks.length === 0) return;
    void execute(
      'start',
      {
        type: 'project.run.start',
        payload: {
          projectId: project.id,
          concurrency,
          expectedPolicyRevision: policyRevision,
          expectedTasks: eligibleTasks.map(
            ({ id, revision, reviewAutomation }) => ({
              taskId: id,
              revision,
              automationStatus: reviewAutomation.status,
              automationGeneration: reviewAutomation.generation,
            }),
          ),
          actor: operator,
        },
      },
      'The project run could not be authorized.',
    );
  };

  const control = (kind: 'pause' | 'resume' | 'stop') => {
    if (!activeRun) return;
    const payload = {
      runId: activeRun.id,
      expectedRevision: activeRun.revision,
      actor: operator,
    };
    const command: MutatingCommand =
      kind === 'pause'
        ? { type: 'project.run.pause', payload }
        : kind === 'resume'
          ? { type: 'project.run.resume', payload }
          : { type: 'project.run.stop', payload };
    void execute(
      kind,
      command,
      `The run could not be ${kind === 'pause' ? 'paused' : kind === 'resume' ? 'resumed' : 'stopped'}.`,
    );
  };

  const occupied = activeRun
    ? activeRun.items.filter(({ status }) =>
        ['launch_pending', 'active'].includes(status),
      ).length
    : 0;

  return (
    <section className="project-run-panel" aria-label="Project run">
      <div className="task-section-heading project-run-heading">
        <div>
          <span className="eyebrow">Project orchestration</span>
          <h3>Project run</h3>
        </div>
        {activeRun ? (
          <span
            className={`status project-run-state project-run-state-${activeRun.state}`}
          >
            {stateLabels[activeRun.state]}
          </span>
        ) : null}
      </div>

      {!connected ? (
        <p className="notice notice-warning">
          Run controls are disconnected or stale. Reconnect to use
          server-authoritative actions.
        </p>
      ) : null}
      {project.archivedAt ? (
        <p className="notice notice-warning">
          Archived projects cannot start runs or change an active run.
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}

      {repairs.length > 0 ? (
        <div className="notice notice-error project-run-repairs" role="alert">
          <strong>Task/project repairs required</strong>
          <ul>
            {repairs.map((repair) => (
              <li key={`${repair.taskId}:${repair.attemptId}:${repair.reason}`}>
                Task repair —{' '}
                {projection.tasksById[repair.taskId]?.title ?? repair.taskId}{' '}
                {repairLabels[repair.reason] ??
                  repair.reason.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {activeRun ? (
        <div className="project-run-active">
          <div className="project-run-summary">
            <div>
              <span>Occupied capacity</span>
              <strong>
                {occupied} of {activeRun.concurrency} occupied
              </strong>
            </div>
            <div>
              <span>Frozen queue</span>
              <strong>{activeRun.items.length} tasks</strong>
            </div>
            <div>
              <span>Run revision</span>
              <strong>{activeRun.revision}</strong>
            </div>
          </div>

          {activeRun.state === 'paused' ? (
            <p className="notice notice-warning">
              New launches are paused:{' '}
              {(activeRun.pauseReason ?? 'reason unavailable').replace(
                /_/g,
                ' ',
              )}
              . Active work continues and may release capacity.
            </p>
          ) : null}
          {activeRun.state === 'draining' ? (
            <p className="notice notice-warning">
              Stop is committed. Active work is draining; no queued task will
              start.
            </p>
          ) : null}

          <RunItems
            run={activeRun}
            projection={projection}
            label="Frozen run order"
            onSelectTask={onSelectTask}
          />

          <div className="project-run-controls">
            {activeRun.state === 'running' ? (
              <button
                className="button button-secondary"
                type="button"
                disabled={controlsDisabled}
                onClick={() => control('pause')}
              >
                {pendingAction?.label === 'pause'
                  ? 'Pausing run…'
                  : 'Pause run'}
              </button>
            ) : null}
            {activeRun.state === 'paused' ? (
              <button
                className="button button-primary"
                type="button"
                disabled={controlsDisabled}
                onClick={() => control('resume')}
              >
                {pendingAction?.label === 'resume'
                  ? 'Resuming run…'
                  : 'Resume run'}
              </button>
            ) : null}
            {activeRun.state === 'running' || activeRun.state === 'paused' ? (
              <button
                className="button button-danger"
                type="button"
                disabled={controlsDisabled}
                onClick={() => setConfirmingStop(true)}
              >
                Stop run
              </button>
            ) : null}
          </div>

          {confirmingStop ? (
            <div
              className="project-run-stop-confirmation"
              role="group"
              aria-label="Confirm stop"
            >
              <p>
                <strong>Stop prevents future launches.</strong> Active work
                drains and is not interrupted. Use session controls separately
                if interruption is required.
              </p>
              <div className="dialog-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={Boolean(pendingAction)}
                  onClick={() => setConfirmingStop(false)}
                >
                  Keep run active
                </button>
                <button
                  className="button button-danger"
                  type="button"
                  disabled={controlsDisabled}
                  onClick={() => control('stop')}
                >
                  {pendingAction?.label === 'stop'
                    ? 'Stopping run…'
                    : 'Confirm stop run'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="project-run-start">
          <p>
            Authorize a finite frozen queue of currently eligible ready tasks.
            Tasks made ready later wait for another run.
          </p>
          {eligibleTasks.length === 0 ? (
            <p className="project-run-empty">
              No eligible ready tasks are available.
            </p>
          ) : (
            <p>
              {eligibleTasks.length} eligible{' '}
              {eligibleTasks.length === 1 ? 'task' : 'tasks'} in board order.
            </p>
          )}
          {!authorizing ? (
            <button
              className="button button-primary"
              type="button"
              disabled={controlsDisabled || eligibleTasks.length === 0}
              onClick={() => {
                setError(undefined);
                setAuthorizing(true);
              }}
            >
              Start run
            </button>
          ) : (
            <div className="project-run-authorization">
              <div className="project-run-authorization-heading">
                <h4>Review authorization</h4>
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={Boolean(pendingAction)}
                  onClick={() => {
                    setAuthorizing(false);
                    setSubscriptionConfirmed(false);
                    setError(undefined);
                  }}
                >
                  Cancel
                </button>
              </div>
              <ol
                className="project-run-preview"
                aria-label="Eligible run order"
              >
                {eligibleTasks.map((task, index) => (
                  <li key={task.id}>
                    <span className="project-run-position">{index + 1}</span>
                    <strong>{task.title}</strong>
                    <span>{effectiveReviewMode(project, task)}</span>
                  </li>
                ))}
              </ol>
              <p>QA policy revision {policyRevision}</p>
              <label className="project-run-concurrency">
                Concurrency
                <input
                  aria-label="Concurrency"
                  type="number"
                  min={1}
                  max={boundedMaximum}
                  value={concurrency}
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isInteger(next))
                      setConcurrency(
                        Math.min(Math.max(1, next), boundedMaximum),
                      );
                  }}
                />
                <span>Server maximum {boundedMaximum}</span>
              </label>
              <p className="notice notice-warning">
                Concurrent launches consume Claude subscription capacity. Mesh
                uses subscription-backed sessions and never enables API billing.
                Each task launches in a Mesh-owned isolated Git worktree.
              </p>
              <label className="project-run-subscription-confirmation">
                <input
                  type="checkbox"
                  checked={subscriptionConfirmed}
                  disabled={controlsDisabled}
                  onChange={(event) =>
                    setSubscriptionConfirmed(event.target.checked)
                  }
                />
                I confirm this run may consume Claude subscription capacity.
              </label>
              <button
                className="button button-primary"
                type="button"
                disabled={
                  controlsDisabled ||
                  !subscriptionConfirmed ||
                  eligibleTasks.length === 0
                }
                onClick={authorize}
              >
                {pendingAction?.label === 'start'
                  ? 'Authorizing run…'
                  : 'Authorize run'}
              </button>
            </div>
          )}
        </div>
      )}

      {history.length > 0 ? (
        <section className="project-run-history" aria-label="Run history">
          <div className="task-section-heading">
            <div>
              <span className="eyebrow">Durable history</span>
              <h4>Completed runs</h4>
            </div>
            <span>{history.length}</span>
          </div>
          {history.map((pastRun) => {
            const counts = itemCounts(pastRun);
            return (
              <article key={pastRun.id} className="project-run-history-entry">
                <div className="project-run-history-heading">
                  <div>
                    <strong>
                      {completionLabels[pastRun.completionReason ?? ''] ??
                        pastRun.completionReason}
                    </strong>
                    <span>
                      Started {new Date(pastRun.startedAt).toLocaleString()}
                    </span>
                  </div>
                  <span>
                    {counts.completed} completed, {counts.attention} attention,{' '}
                    {counts.notStarted} not started
                  </span>
                </div>
                <RunItems
                  run={pastRun}
                  projection={projection}
                  label={`Frozen order for run ${pastRun.id}`}
                  onSelectTask={onSelectTask}
                />
              </article>
            );
          })}
        </section>
      ) : null}
    </section>
  );
}
