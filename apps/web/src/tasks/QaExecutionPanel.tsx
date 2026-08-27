import { useEffect, useMemo, useRef, useState } from 'react';

import {
  taskActorSchema,
  type AttemptRepair,
  type DeveloperCompletionReport,
  type MutatingCommand,
  type Project,
  type QaExecutionCycle,
  type QaReport,
  type ReviewAutomationAction,
  type ReviewAutomationState,
  type Session,
  type Task,
  type TaskActor,
  type TaskAttempt,
} from '@mesh-session-platform/contracts';

type TimelineAttempt = { attempt: TaskAttempt; session?: Session };
type AutomationProjection = ReviewAutomationState & {
  actions: ReviewAutomationAction[];
};

const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
}) as Extract<TaskActor, { type: 'human' }>;
const rejectionLimit = 3;

const label = (value: string) => {
  const spaced = value.replace(/_/g, ' ');
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
};

const failureMessage = (caught: unknown) => {
  const message =
    caught && typeof caught === 'object'
      ? (caught as { message?: unknown }).message
      : undefined;
  return typeof message === 'string' && message.trim()
    ? message
    : 'The QA command failed.';
};

export function QaExecutionPanel({
  project,
  task,
  attempts,
  sessions,
  cycles,
  reports,
  developerCompletionReports,
  automation,
  repairs,
  connected,
  readOnly,
  onCommand,
  onOpenSession,
}: {
  project: Project;
  task: Task;
  attempts: readonly TimelineAttempt[];
  sessions: readonly Session[];
  cycles: readonly QaExecutionCycle[];
  reports: readonly QaReport[];
  developerCompletionReports: readonly DeveloperCompletionReport[];
  automation?: AutomationProjection;
  repairs: readonly AttemptRepair[];
  connected: boolean;
  readOnly: boolean;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const requestId = useRef(0);
  const observedCycleCount = useRef(cycles.length);
  const observedTaskRevision = useRef(task.revision);
  const attemptIds = new Set<string>(attempts.map(({ attempt }) => attempt.id));
  const orderedCycles = useMemo(
    () =>
      cycles
        .filter((cycle) => attemptIds.has(cycle.attemptId))
        .sort(
          (left, right) =>
            left.startedAt.localeCompare(right.startedAt) ||
            left.ordinal - right.ordinal,
        ),
    [cycles, attempts],
  );
  const reportByCycle = new Map<string, QaReport>(
    reports.map((report) => [report.cycleId, report]),
  );
  const developerReportById = new Map<string, DeveloperCompletionReport>(
    developerCompletionReports.map((report) => [report.id, report]),
  );
  const latestCycle = orderedCycles[orderedCycles.length - 1];
  const latestReport = latestCycle
    ? reportByCycle.get(latestCycle.id)
    : undefined;
  const latestDeveloperReport = [...developerCompletionReports].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt),
  )[developerCompletionReports.length - 1];
  const latestQaMatchesDeveloper = Boolean(
    latestCycle &&
      latestDeveloperReport &&
      latestCycle.developerCompletionReportId === latestDeveloperReport.id,
  );
  const activeCycle = orderedCycles.find((cycle) => cycle.endedAt === null);
  const controlsDisabled = readOnly || !connected || Boolean(pending);
  const policy = project.qaConfiguration?.reviewPolicy ?? 'manual';
  const taskRepairs = repairs.filter(
    (repair) =>
      repair.taskId === task.id &&
      [
        'qa_cycle_without_trustworthy_outcome',
        'qa_session_workspace_mismatch',
        'review_automation_action_incomplete',
      ].includes(repair.reason),
  );
  const actions = automation?.actions ?? [];
  const pendingAction = [...actions]
    .reverse()
    .find((action) => action.status === 'pending');
  const failedActions = actions.filter((action) => action.status === 'failed');
  const remaining = Math.max(
    0,
    rejectionLimit - (automation?.rejectionCount ?? 0),
  );

  useEffect(() => {
    if (
      observedCycleCount.current !== cycles.length ||
      observedTaskRevision.current !== task.revision
    ) {
      setPending(undefined);
      setError(undefined);
    }
    observedCycleCount.current = cycles.length;
    observedTaskRevision.current = task.revision;
  }, [cycles.length, task.revision]);

  const execute = (name: string, command: MutatingCommand) => {
    if (controlsDisabled) return;
    const id = ++requestId.current;
    setPending(name);
    setError(undefined);
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(onCommand(command));
    } catch (caught) {
      result = Promise.reject(caught);
    }
    void result.catch((caught: unknown) => {
      if (requestId.current !== id) return;
      setPending(undefined);
      setError(failureMessage(caught));
    });
  };

  const startQa = () =>
    execute('Start QA', {
      type: 'task.qa.launch',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        actor: operator,
      },
    });
  const accept = () =>
    execute('Accept verified work', {
      type: 'task.developer.accept',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        actor: operator,
      },
    });
  const resumeRework = () =>
    execute('Resume Developer rework', {
      type: 'task.developer.reject_resume',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        feedback:
          latestReport?.criterionResults
            .filter((result) => result.status !== 'passed')
            .map((result) => result.evidence)
            .join('\n') || 'Address the latest QA rejection.',
        actor: operator,
      },
    });
  const changeAutomation = (enabled: boolean) =>
    execute(enabled ? 'Enable automation' : 'Pause automation', {
      type: enabled
        ? 'task.review_automation.enable'
        : 'task.review_automation.pause',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        actor: operator,
      },
    });

  const manualStartEligible =
    policy === 'manual' &&
    task.lifecycleState === 'review' &&
    !task.blocked &&
    !activeCycle &&
    Boolean(latestDeveloperReport) &&
    !latestQaMatchesDeveloper;
  const verifiedAwaitingHuman =
    policy === 'manual' &&
    task.lifecycleState === 'review' &&
    latestQaMatchesDeveloper &&
    latestReport?.disposition === 'verified';
  const rejectedAwaitingHuman =
    policy === 'manual' &&
    task.lifecycleState === 'review' &&
    latestQaMatchesDeveloper &&
    latestReport?.disposition === 'rejected';

  return (
    <section className="qa-execution" aria-label="QA workflow">
      <div className="task-section-heading">
        <h3>QA</h3>
        <span>{orderedCycles.length} cycles</span>
      </div>
      <dl className="qa-status-grid">
        <div>
          <dt>Current role</dt>
          <dd>
            {activeCycle
              ? 'QA'
              : task.lifecycleState === 'in_progress'
                ? 'Developer'
                : 'Human review'}
          </dd>
        </div>
        <div>
          <dt>Review policy</dt>
          <dd>{policy === 'manual' ? 'Manual review' : 'Autonomous review'}</dd>
        </div>
        <div>
          <dt>Active cycle</dt>
          <dd>{activeCycle ? `QA cycle ${activeCycle.ordinal}` : 'None'}</dd>
        </div>
      </dl>

      {readOnly || !connected ? (
        <p className="notice notice-warning" role="status">
          QA actions are {readOnly ? 'read-only' : 'disconnected'}.
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p className="task-pending" role="status">
          {pending} pending — waiting for durable task state.
        </p>
      ) : null}

      {policy === 'autonomous_review' ? (
        <section className="qa-automation" aria-label="Review automation">
          <h4>Review automation</h4>
          <p>{remaining} autonomous rejections remaining</p>
          {automation?.pauseReason ? (
            <p className="notice notice-warning">
              Automation paused: {automation.pauseReason}
            </p>
          ) : null}
          {pendingAction ? (
            <p>Upcoming automatic action: {label(pendingAction.actionKind)}</p>
          ) : (
            <p>No automatic action is pending.</p>
          )}
          {automation?.status === 'enabled' ? (
            <button
              className="button button-secondary"
              type="button"
              disabled={controlsDisabled}
              onClick={() => changeAutomation(false)}
            >
              Pause automation
            </button>
          ) : (
            <button
              className="button button-primary"
              type="button"
              disabled={controlsDisabled}
              onClick={() => changeAutomation(true)}
            >
              Enable automation
            </button>
          )}
          {failedActions.map((action) => (
            <p className="notice notice-error" key={action.id}>
              {label(action.actionKind)} failed:{' '}
              {action.errorCode ?? 'unknown error'}
            </p>
          ))}
        </section>
      ) : null}

      <div className="qa-actions">
        {manualStartEligible ? (
          <button
            className="button button-primary"
            type="button"
            disabled={controlsDisabled}
            onClick={startQa}
          >
            Start QA
          </button>
        ) : null}
        {verifiedAwaitingHuman ? (
          <button
            className="button button-primary"
            type="button"
            disabled={controlsDisabled}
            onClick={accept}
          >
            Accept verified work
          </button>
        ) : null}
        {rejectedAwaitingHuman ? (
          <button
            className="button button-secondary"
            type="button"
            disabled={controlsDisabled}
            onClick={resumeRework}
          >
            Resume Developer rework
          </button>
        ) : null}
      </div>

      {taskRepairs.map((repair) => {
        const repairSession = sessions.find(
          ({ id }) => id === repair.sessionId,
        );
        return (
          <div
            className="notice notice-warning attempt-repair"
            role="alert"
            key={`${repair.attemptId}:${repair.sessionId}:${repair.reason}`}
          >
            <span>
              {repair.reason === 'review_automation_action_incomplete'
                ? 'Automation repair needed: the last automatic action did not reach a trustworthy outcome.'
                : repair.reason === 'qa_session_workspace_mismatch'
                  ? 'QA repair needed: the QA session no longer matches the Developer workspace.'
                  : 'QA repair needed: the QA cycle has no trustworthy outcome.'}
            </span>
            {repairSession && onOpenSession ? (
              <button
                className="button button-ghost"
                type="button"
                onClick={() => onOpenSession(repairSession.id)}
              >
                Open affected QA session
              </button>
            ) : null}
          </div>
        );
      })}

      {orderedCycles.length === 0 ? (
        <p className="task-empty-state">No QA cycles yet.</p>
      ) : (
        <div className="qa-cycle-list">
          {orderedCycles.map((cycle) => {
            const report = reportByCycle.get(cycle.id);
            const developerReport = developerReportById.get(
              cycle.developerCompletionReportId,
            );
            const developerByCriterion = new Map<
              string,
              DeveloperCompletionReport['criterionResults'][number]
            >(
              developerReport?.criterionResults.map((result) => [
                result.criterionId,
                result,
              ]) ?? [],
            );
            const qaByCriterion = new Map<
              string,
              QaReport['criterionResults'][number]
            >(
              report?.criterionResults.map((result) => [
                result.criterionId,
                result,
              ]) ?? [],
            );
            const session = sessions.find(({ id }) => id === cycle.sessionId);
            return (
              <article className="qa-cycle" key={cycle.id}>
                <header>
                  <div>
                    <strong>QA cycle {cycle.ordinal}</strong>
                    <span>
                      Task r{cycle.taskSnapshot.revision} · instructions r
                      {cycle.qaInstructions.revision}
                    </span>
                  </div>
                  <span className="task-state">
                    {report
                      ? report.disposition === 'verified'
                        ? 'QA verified'
                        : 'QA rejected'
                      : cycle.endedAt
                        ? 'Ended without report'
                        : 'Active'}
                  </span>
                </header>
                <p>Workspace {cycle.workspaceId}</p>
                {session && onOpenSession ? (
                  <button
                    className="button button-ghost"
                    type="button"
                    onClick={() => onOpenSession(session.id)}
                  >
                    Open {session.title}
                  </button>
                ) : null}
                {report ? (
                  <>
                    {report.workspaceBefore !== report.workspaceAfter ? (
                      <p className="notice notice-error">
                        Unexpected source changes detected during QA:{' '}
                        {report.workspaceBefore} → {report.workspaceAfter}
                      </p>
                    ) : null}
                    <ul className="qa-criteria">
                      {cycle.taskSnapshot.acceptanceCriteria.map(
                        (criterion) => {
                          const developerResult = developerByCriterion.get(
                            criterion.id,
                          );
                          const qaResult = qaByCriterion.get(criterion.id);
                          return (
                            <li key={criterion.id} aria-label={criterion.text}>
                              <strong>{criterion.text}</strong>
                              <div>
                                <h6>Developer evidence</h6>
                                <p>
                                  {developerResult?.evidence ??
                                    'No Developer evidence.'}
                                </p>
                              </div>
                              <div>
                                <h6>
                                  QA evidence ·{' '}
                                  {qaResult
                                    ? label(qaResult.status)
                                    : 'Missing'}
                                </h6>
                                <p>{qaResult?.evidence ?? 'No QA evidence.'}</p>
                              </div>
                            </li>
                          );
                        },
                      )}
                    </ul>
                    <h5>Verification commands</h5>
                    {report.verificationCommands.length ? (
                      <ul>
                        {report.verificationCommands.map((result, index) => (
                          <li key={`${result.command}:${index}`}>
                            <code>{result.command}</code> — {result.outcome}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>None reported.</p>
                    )}
                    <dl className="qa-report-details">
                      <div>
                        <dt>Limitations</dt>
                        <dd>
                          {report.limitations.join(' · ') || 'None reported.'}
                        </dd>
                      </div>
                      <div>
                        <dt>Residual risks</dt>
                        <dd>
                          {report.residualRisks.join(' · ') || 'None reported.'}
                        </dd>
                      </div>
                    </dl>
                  </>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
