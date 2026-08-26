import type {
  AttemptRepair,
  Session,
  TaskAttempt,
} from '@mesh-session-platform/contracts';

type TimelineAttempt = { attempt: TaskAttempt; session?: Session };

const repairMessage: Record<AttemptRepair['reason'], string> = {
  startup_outcome_unknown:
    'Attempt repair needed: the launch outcome could not be confirmed.',
  task_in_progress_without_live_session:
    'Attempt repair needed: the task is in progress without a live session.',
  developer_cycle_without_live_session:
    'Attempt repair needed: the Developer cycle is in progress without a live session.',
  qa_cycle_without_trustworthy_outcome:
    'QA repair needed: the cycle has no trustworthy durable outcome.',
  qa_session_workspace_mismatch:
    'QA repair needed: the session is not bound to its assigned Developer workspace.',
  review_automation_action_incomplete:
    'Review repair needed: an automatic action has an unknown outcome.',
};

const statusLabel = (state: Session['lifecycleState']) => {
  const label = state.replace(/_/g, ' ');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
};

export function AttemptTimeline({
  attempts,
  repairs,
  readOnly = false,
  onOpenSession,
  onRequestUnlink,
}: {
  attempts: readonly TimelineAttempt[];
  repairs: readonly AttemptRepair[];
  readOnly?: boolean;
  onOpenSession?: (sessionId: string) => void;
  onRequestUnlink?: (attempt: TaskAttempt) => void;
}) {
  const ordered = [...attempts].sort(
    (left, right) => left.attempt.ordinal - right.attempt.ordinal,
  );

  return (
    <section className="attempt-timeline" aria-label="Attempt timeline">
      <div className="task-section-heading">
        <h3>Attempts</h3>
        <span>{ordered.length}</span>
      </div>
      {repairs
        .filter(
          (repair) => repair.reason !== 'developer_cycle_without_live_session',
        )
        .map((repair) => (
          <p
            className="notice notice-warning attempt-repair"
            role="alert"
            key={`${repair.attemptId}:${repair.reason}`}
          >
            {repairMessage[repair.reason]}
          </p>
        ))}
      {ordered.length === 0 ? (
        <p className="task-empty-state">No attempts yet.</p>
      ) : (
        <ol>
          {ordered.map(({ attempt, session }) => {
            const unlinked = Boolean(attempt.unlinkedAt);
            return (
              <li key={attempt.id}>
                <article
                  className="attempt-card"
                  aria-label={`Attempt ${attempt.ordinal}`}
                >
                  <div className="attempt-card-heading">
                    <strong>Attempt {attempt.ordinal}</strong>
                    <span>
                      {attempt.role === 'developer'
                        ? 'Developer · Launched'
                        : attempt.source === 'launched'
                          ? 'Launched'
                          : 'Linked'}
                    </span>
                  </div>
                  <p>
                    {session?.title ?? `Session ${attempt.sessionId}`}
                    {' · '}
                    <span
                      className={`status status-${session?.lifecycleState ?? 'missing'}`}
                    >
                      {session?.lifecycleState
                        ? statusLabel(session.lifecycleState)
                        : 'Session unavailable'}
                    </span>
                  </p>
                  {unlinked ? (
                    <p className="attempt-unlinked">
                      <strong>Unlinked</strong>
                      {attempt.unlinkReason ? ` — ${attempt.unlinkReason}` : ''}
                    </p>
                  ) : null}
                  <div className="attempt-actions">
                    {session && onOpenSession ? (
                      <button
                        className="button button-ghost"
                        type="button"
                        onClick={() => onOpenSession(session.id)}
                      >
                        Open {session.title}
                      </button>
                    ) : null}
                    {!unlinked &&
                    attempt.source === 'linked' &&
                    onRequestUnlink ? (
                      <button
                        className="button button-ghost"
                        type="button"
                        disabled={readOnly}
                        onClick={() => onRequestUnlink(attempt)}
                      >
                        Unlink attempt {attempt.ordinal}
                      </button>
                    ) : null}
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
