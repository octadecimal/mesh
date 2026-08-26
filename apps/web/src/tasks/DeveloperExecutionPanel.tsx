import {
  taskActorSchema,
  type AttemptRepair,
  type DeveloperBlockerReport,
  type DeveloperCompletionReport,
  type DeveloperExecutionCycle,
  type DeveloperReviewFeedback,
  type MutatingCommand,
  type PermissionMode,
  type Project,
  type Session,
  type Task,
  type TaskActor,
  type TaskAttempt,
} from '@mesh-session-platform/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  WorkspaceFields,
  type WorkspaceDraft,
} from '../sessions/WorkspaceFields';

type TimelineAttempt = { attempt: TaskAttempt; session?: Session };
type RecoveryPath = 'resume' | 'new' | '';
type ActionKind = 'launch' | 'accept' | 'reject' | 'unblock';

type PendingAction = {
  id: number;
  kind: ActionKind;
  sourceRevision: number;
  sourceCycleCount: number;
  sourceFeedbackCount: number;
};

const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
}) as TaskActor & { type: 'human' };

const workspaceFor = (project: Project): WorkspaceDraft => ({
  type: 'shared',
  sharedPath: project.repositoryPath,
  repositoryPath: project.repositoryPath,
  worktreePath: '',
  branch: '',
  startPoint: 'HEAD',
});

const isAbsolutePath = (path: string) =>
  /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());

const workspaceValid = (workspace: WorkspaceDraft) =>
  workspace.type === 'shared'
    ? isAbsolutePath(workspace.sharedPath)
    : Boolean(
        isAbsolutePath(workspace.repositoryPath) &&
          isAbsolutePath(workspace.worktreePath) &&
          workspace.branch.trim() &&
          workspace.startPoint.trim(),
      );

const workspacePayload = (workspace: WorkspaceDraft) =>
  workspace.type === 'shared'
    ? ({ type: 'shared', path: workspace.sharedPath.trim() } as const)
    : ({
        type: 'worktree',
        repositoryPath: workspace.repositoryPath.trim(),
        path: workspace.worktreePath.trim(),
        branch: workspace.branch.trim(),
        startPoint: workspace.startPoint.trim(),
      } as const);

const statusLabel = (value: string) => {
  const label = value.replace(/_/g, ' ');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
};

const failureMessage = (caught: unknown) => {
  if (caught && typeof caught === 'object') {
    const message = (caught as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'The Developer command failed.';
};

const readinessComplete = (task: Task) =>
  Boolean(
    task.title.trim() &&
      task.description.trim() &&
      task.acceptanceCriteria.length > 0 &&
      task.priority,
  );

const cycleOrder = (
  attempts: readonly TimelineAttempt[],
  cycles: readonly DeveloperExecutionCycle[],
) => {
  const attemptOrdinal = new Map(
    attempts.map(({ attempt }) => [attempt.id, attempt.ordinal]),
  );
  return [...cycles].sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      (attemptOrdinal.get(left.attemptId) ?? Number.MAX_SAFE_INTEGER) -
        (attemptOrdinal.get(right.attemptId) ?? Number.MAX_SAFE_INTEGER) ||
      left.ordinal - right.ordinal,
  );
};

export function DeveloperExecutionPanel({
  project,
  task,
  attempts,
  cycles,
  completionReports,
  blockerReports,
  feedback,
  repairs,
  connected,
  readOnly,
  onCommand,
  onOpenSession,
}: {
  project: Project;
  task: Task;
  attempts: readonly TimelineAttempt[];
  cycles: readonly DeveloperExecutionCycle[];
  completionReports: readonly DeveloperCompletionReport[];
  blockerReports: readonly DeveloperBlockerReport[];
  feedback: readonly DeveloperReviewFeedback[];
  repairs: readonly AttemptRepair[];
  connected: boolean;
  readOnly: boolean;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceDraft>(() =>
    workspaceFor(project),
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [rejectionFeedback, setRejectionFeedback] = useState('');
  const [rejectionPath, setRejectionPath] = useState<RecoveryPath>('');
  const [unblockFeedback, setUnblockFeedback] = useState('');
  const [unblockPath, setUnblockPath] = useState<RecoveryPath>('');
  const [pending, setPending] = useState<PendingAction>();
  const [error, setError] = useState<string>();
  const requestSequence = useRef(0);
  const activeRequest = useRef<PendingAction | undefined>(undefined);
  const orderedCycles = useMemo(
    () => cycleOrder(attempts, cycles),
    [attempts, cycles],
  );
  const attemptById = useMemo(
    () => new Map(attempts.map((item) => [item.attempt.id, item])),
    [attempts],
  );
  const completionByCycleId = useMemo(
    () => new Map(completionReports.map((report) => [report.cycleId, report])),
    [completionReports],
  );
  const blockerByCycleId = useMemo(
    () => new Map(blockerReports.map((report) => [report.cycleId, report])),
    [blockerReports],
  );
  const developerRepairs = repairs.filter(
    (repair) => repair.reason === 'developer_cycle_without_live_session',
  );
  const controlsDisabled = readOnly || !connected || Boolean(pending);
  const latestCycle = orderedCycles[orderedCycles.length - 1];
  const hasDeveloperReview = Boolean(
    latestCycle?.terminalDisposition === 'submitted_for_review' &&
      completionByCycleId.has(latestCycle.id),
  );
  const hasDeveloperBlocker = Boolean(
    latestCycle?.terminalDisposition === 'blocked' &&
      blockerByCycleId.has(latestCycle.id),
  );

  useEffect(() => {
    setWorkspace(workspaceFor(project));
  }, [project.id, project.repositoryPath]);

  useEffect(() => {
    activeRequest.current = undefined;
    setPending(undefined);
    setError(undefined);
    setRejectionFeedback('');
    setRejectionPath('');
    setUnblockFeedback('');
    setUnblockPath('');
  }, [task.id]);

  useEffect(() => {
    const request = activeRequest.current;
    if (!request || task.revision <= request.sourceRevision) return;
    const cycleAdded = cycles.length > request.sourceCycleCount;
    const feedbackAdded = feedback.length > request.sourceFeedbackCount;
    const durableOutcome =
      (request.kind === 'launch' &&
        task.lifecycleState !== 'ready' &&
        cycleAdded) ||
      (request.kind === 'accept' && task.lifecycleState === 'done') ||
      ((request.kind === 'reject' || request.kind === 'unblock') &&
        !task.blocked &&
        cycleAdded &&
        feedbackAdded);
    if (!durableOutcome) return;
    activeRequest.current = undefined;
    if (request.kind === 'reject') {
      setRejectionFeedback('');
      setRejectionPath('');
    }
    if (request.kind === 'unblock') {
      setUnblockFeedback('');
      setUnblockPath('');
    }
    setPending((current) => (current?.id === request.id ? undefined : current));
    setError(undefined);
  }, [cycles.length, feedback.length, task]);

  const execute = (kind: ActionKind, command: MutatingCommand) => {
    if (controlsDisabled) return;
    const id = ++requestSequence.current;
    const request = {
      id,
      kind,
      sourceRevision: task.revision,
      sourceCycleCount: cycles.length,
      sourceFeedbackCount: feedback.length,
    };
    activeRequest.current = request;
    setPending(request);
    setError(undefined);
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(onCommand(command));
    } catch (caught) {
      result = Promise.reject(caught);
    }
    void result.catch((caught: unknown) => {
      if (activeRequest.current?.id !== id) return;
      setPending((current) => (current?.id === id ? undefined : current));
      setError(failureMessage(caught));
    });
  };

  const launch = () => {
    if (
      task.lifecycleState !== 'ready' ||
      task.blocked ||
      !readinessComplete(task) ||
      !permissionMode ||
      !workspaceValid(workspace)
    )
      return;
    execute('launch', {
      type: 'task.developer.launch',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        title: task.title,
        permissionMode,
        workspace: workspacePayload(workspace),
        actor: operator,
      },
    });
  };

  const reject = () => {
    if (!rejectionFeedback.trim() || !rejectionPath) return;
    if (rejectionPath === 'resume') {
      execute('reject', {
        type: 'task.developer.reject_resume',
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          feedback: rejectionFeedback.trim(),
          actor: operator,
        },
      });
      return;
    }
    if (!permissionMode || !workspaceValid(workspace)) return;
    execute('reject', {
      type: 'task.developer.reject_new',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        feedback: rejectionFeedback.trim(),
        title: task.title,
        permissionMode,
        workspace: workspacePayload(workspace),
        actor: operator,
      },
    });
  };

  const unblock = () => {
    if (!unblockFeedback.trim() || !unblockPath) return;
    if (unblockPath === 'resume') {
      execute('unblock', {
        type: 'task.developer.unblock_resume',
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          feedback: unblockFeedback.trim(),
          actor: operator,
        },
      });
      return;
    }
    if (!permissionMode || !workspaceValid(workspace)) return;
    execute('unblock', {
      type: 'task.developer.unblock_new',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        feedback: unblockFeedback.trim(),
        title: task.title,
        permissionMode,
        workspace: workspacePayload(workspace),
        actor: operator,
      },
    });
  };

  const freshReady = Boolean(permissionMode) && workspaceValid(workspace);
  const launchReady =
    task.lifecycleState === 'ready' &&
    !task.blocked &&
    readinessComplete(task) &&
    freshReady;

  return (
    <section className="developer-execution" aria-label="Developer workflow">
      <div className="task-section-heading">
        <h3>Developer</h3>
        <span>{orderedCycles.length} cycles</span>
      </div>
      {readOnly || !connected ? (
        <p className="notice notice-warning" role="status">
          Developer actions are {readOnly ? 'read-only' : 'disconnected'}.
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p className="task-pending" role="status">
          {statusLabel(pending.kind)} pending — waiting for project update.
        </p>
      ) : null}
      {developerRepairs.map((repair) => (
        <p
          className="notice notice-warning attempt-repair"
          role="alert"
          key={`${repair.attemptId}:${repair.reason}`}
        >
          Developer repair needed: the cycle is in progress without a live
          session.
        </p>
      ))}

      {task.lifecycleState === 'ready' ? (
        <div className="developer-action developer-launch">
          <h4>Start Developer</h4>
          <WorkspaceFields
            value={workspace}
            onChange={setWorkspace}
            disabled={controlsDisabled}
          />
          <PermissionField
            value={permissionMode}
            onChange={setPermissionMode}
            disabled={controlsDisabled}
          />
          <button
            className="button button-primary"
            type="button"
            disabled={controlsDisabled || !launchReady}
            onClick={launch}
          >
            Start Developer
          </button>
        </div>
      ) : null}

      {task.lifecycleState === 'review' && hasDeveloperReview ? (
        <div className="developer-action developer-review">
          <h4>Human review</h4>
          <button
            className="button button-primary"
            type="button"
            disabled={controlsDisabled}
            onClick={() =>
              execute('accept', {
                type: 'task.developer.accept',
                payload: {
                  taskId: task.id,
                  expectedRevision: task.revision,
                  actor: operator,
                },
              })
            }
          >
            Accept as done
          </button>
          <label>
            Rejection feedback
            <textarea
              aria-label="Rejection feedback"
              disabled={controlsDisabled}
              value={rejectionFeedback}
              onChange={(event) => setRejectionFeedback(event.target.value)}
            />
          </label>
          <fieldset disabled={controlsDisabled}>
            <legend>Rework path</legend>
            <label>
              <input
                type="radio"
                name="rejection-path"
                checked={rejectionPath === 'resume'}
                onChange={() => setRejectionPath('resume')}
              />
              Resume the same Developer attempt
            </label>
            <label>
              <input
                type="radio"
                name="rejection-path"
                checked={rejectionPath === 'new'}
                onChange={() => setRejectionPath('new')}
              />
              Start a new Developer attempt
            </label>
          </fieldset>
          {rejectionPath === 'new' ? (
            <FreshExecutionFields
              workspace={workspace}
              onWorkspaceChange={setWorkspace}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              disabled={controlsDisabled}
            />
          ) : null}
          <button
            className="button button-secondary"
            type="button"
            disabled={
              controlsDisabled ||
              !rejectionFeedback.trim() ||
              !rejectionPath ||
              (rejectionPath === 'new' && !freshReady)
            }
            onClick={reject}
          >
            Reject submission
          </button>
        </div>
      ) : null}

      {task.blocked && hasDeveloperBlocker ? (
        <div className="developer-action developer-unblock">
          <h4>Resolve Developer blocker</h4>
          <label>
            Unblock reason
            <textarea
              aria-label="Unblock reason"
              disabled={controlsDisabled}
              value={unblockFeedback}
              onChange={(event) => setUnblockFeedback(event.target.value)}
            />
          </label>
          <fieldset disabled={controlsDisabled}>
            <legend>Recovery path</legend>
            <label>
              <input
                type="radio"
                name="unblock-path"
                checked={unblockPath === 'resume'}
                onChange={() => setUnblockPath('resume')}
              />
              Resume the blocked attempt
            </label>
            <label>
              <input
                type="radio"
                name="unblock-path"
                checked={unblockPath === 'new'}
                onChange={() => setUnblockPath('new')}
              />
              Start a new attempt after unblock
            </label>
          </fieldset>
          {unblockPath === 'new' ? (
            <FreshExecutionFields
              workspace={workspace}
              onWorkspaceChange={setWorkspace}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              disabled={controlsDisabled}
            />
          ) : null}
          <button
            className="button button-secondary"
            type="button"
            disabled={
              controlsDisabled ||
              !unblockFeedback.trim() ||
              !unblockPath ||
              (unblockPath === 'new' && !freshReady)
            }
            onClick={unblock}
          >
            Unblock Developer
          </button>
        </div>
      ) : null}

      <section
        className="developer-history"
        aria-label="Developer execution history"
      >
        <div className="task-section-heading">
          <h4>Execution history</h4>
          <span>{orderedCycles.length}</span>
        </div>
        {orderedCycles.length === 0 ? (
          <p className="task-empty-state">No Developer cycles yet.</p>
        ) : (
          <ol>
            {orderedCycles.map((cycle) => {
              const attempt = attemptById.get(cycle.attemptId);
              const cycleSession = attempt?.session;
              const completion = completionByCycleId.get(cycle.id);
              const blocker = blockerByCycleId.get(cycle.id);
              const cycleFeedback = feedback.filter(
                (entry) => entry.cycleId === cycle.id,
              );
              return (
                <li key={cycle.id}>
                  <article
                    className="developer-cycle"
                    aria-label={`Developer attempt ${attempt?.attempt.ordinal ?? '?'} cycle ${cycle.ordinal}`}
                  >
                    <header>
                      <div>
                        <strong>
                          Attempt {attempt?.attempt.ordinal ?? '?'} · Cycle{' '}
                          {cycle.ordinal}
                        </strong>
                        <span>{statusLabel(cycle.mode)}</span>
                      </div>
                      <span className="task-state">
                        {cycle.terminalDisposition
                          ? statusLabel(cycle.terminalDisposition)
                          : 'Active'}
                      </span>
                    </header>
                    <dl className="developer-cycle-metadata">
                      <div>
                        <dt>Session</dt>
                        <dd>
                          {attempt?.session?.title ??
                            `Session ${attempt?.attempt.sessionId ?? 'unavailable'}`}
                          {attempt?.session
                            ? ` · ${statusLabel(attempt.session.lifecycleState)}`
                            : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>Workspace</dt>
                        <dd>Workspace {cycle.workspaceId}</dd>
                      </div>
                      <div>
                        <dt>Permission</dt>
                        <dd>{statusLabel(cycle.permissionMode)}</dd>
                      </div>
                      <div>
                        <dt>Snapshot</dt>
                        <dd>
                          Task r{cycle.taskSnapshot.revision} · instructions r
                          {cycle.projectInstructions.revision} ·{' '}
                          {cycle.policyVersion}
                        </dd>
                      </div>
                    </dl>
                    {cycleSession && onOpenSession ? (
                      <button
                        className="button button-ghost"
                        type="button"
                        onClick={() => onOpenSession(cycleSession.id)}
                      >
                        Open {cycleSession.title}
                      </button>
                    ) : null}
                    {completion ? (
                      <CompletionReportView cycle={cycle} report={completion} />
                    ) : null}
                    {blocker ? <BlockerReportView report={blocker} /> : null}
                    {cycleFeedback.map((entry) => (
                      <div className="developer-feedback" key={entry.id}>
                        <h5>
                          {entry.kind === 'rejection'
                            ? 'Review feedback'
                            : 'Unblock feedback'}
                        </h5>
                        <p>{entry.feedback}</p>
                      </div>
                    ))}
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </section>
  );
}

function PermissionField({
  value,
  onChange,
  disabled,
}: {
  value: PermissionMode | '';
  onChange: (value: PermissionMode | '') => void;
  disabled: boolean;
}) {
  return (
    <label>
      Developer permission mode
      <select
        aria-label="Developer permission mode"
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value as PermissionMode | '')
        }
      >
        <option value="">Select permission mode</option>
        <option value="interactive">Interactive approvals</option>
        <option value="safe_auto">Safe automatic actions</option>
        <option value="inherit">Inherit Claude settings</option>
      </select>
    </label>
  );
}

function FreshExecutionFields({
  workspace,
  onWorkspaceChange,
  permissionMode,
  onPermissionModeChange,
  disabled,
}: {
  workspace: WorkspaceDraft;
  onWorkspaceChange: (value: WorkspaceDraft) => void;
  permissionMode: PermissionMode | '';
  onPermissionModeChange: (value: PermissionMode | '') => void;
  disabled: boolean;
}) {
  return (
    <div className="developer-fresh-fields">
      <WorkspaceFields
        value={workspace}
        onChange={onWorkspaceChange}
        disabled={disabled}
      />
      <PermissionField
        value={permissionMode}
        onChange={onPermissionModeChange}
        disabled={disabled}
      />
    </div>
  );
}

function CompletionReportView({
  cycle,
  report,
}: {
  cycle: DeveloperExecutionCycle;
  report: DeveloperCompletionReport;
}) {
  const resultByCriterion = new Map(
    report.criterionResults.map((result) => [result.criterionId, result]),
  );
  return (
    <section className="developer-report" aria-label="Completion report">
      <h5>Completion report</h5>
      <p>{report.summary}</p>
      <h6>Acceptance criteria</h6>
      <ul className="developer-criteria">
        {cycle.taskSnapshot.acceptanceCriteria.map((criterion) => {
          const result = resultByCriterion.get(criterion.id);
          return (
            <li key={criterion.id}>
              <strong>{criterion.text}</strong>
              <span
                className={`developer-result developer-result-${result?.status ?? 'missing'}`}
              >
                {result ? statusLabel(result.status) : 'Missing'}
              </span>
              <p>{result?.evidence ?? 'No evidence reported.'}</p>
            </li>
          );
        })}
      </ul>
      <h6>Verification</h6>
      {report.verification.length === 0 ? (
        <p>None reported.</p>
      ) : (
        <ul className="developer-verification">
          {report.verification.map((result, index) => (
            <li key={`${result.command}:${index}`}>
              <code>{result.command}</code>
              <strong>{statusLabel(result.outcome)}</strong>
              {result.output ? <pre>{result.output}</pre> : null}
            </li>
          ))}
        </ul>
      )}
      <dl className="developer-report-details">
        <div>
          <dt>Limitations and risks</dt>
          <dd>{report.limitations || 'None reported.'}</dd>
        </div>
        <div>
          <dt>Workspace state</dt>
          <dd>{report.workspaceState.summary}</dd>
        </div>
        <div>
          <dt>Uncommitted changes</dt>
          <dd>{report.workspaceState.hasUncommittedChanges ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Commits created</dt>
          <dd>{report.workspaceState.commitsCreated ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Reviewer notes</dt>
          <dd>{report.reviewerNotes || 'None reported.'}</dd>
        </div>
      </dl>
    </section>
  );
}

function BlockerReportView({ report }: { report: DeveloperBlockerReport }) {
  return (
    <section
      className="developer-report developer-blocker"
      aria-label="Blocker report"
    >
      <h5>Blocker report</h5>
      <dl className="developer-report-details">
        <div>
          <dt>Reason</dt>
          <dd>{report.reason}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{report.evidence}</dd>
        </div>
        <div>
          <dt>Work attempted</dt>
          <dd>{report.attemptedWork}</dd>
        </div>
        <div>
          <dt>Suggested human action</dt>
          <dd>{report.suggestedHumanAction}</dd>
        </div>
        <div>
          <dt>Preserve workspace</dt>
          <dd>{report.preserveWorkspace ? 'Yes' : 'No'}</dd>
        </div>
      </dl>
    </section>
  );
}
