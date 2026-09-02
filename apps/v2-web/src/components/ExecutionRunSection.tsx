import { useEffect, useMemo, useState } from 'react';
import type {
  ApprovedDeliveryPlan,
  BoardView,
  ExecutionRunView,
  PauseExecutionRunCommand,
  ResolvedWorkerProfileSnapshot,
  ResumeExecutionRunCommand,
  StartExecutionRunCommand,
  StopExecutionRunCommand,
} from '@mesh/v2-contracts';

export type ExecutionRunCommand =
  | StartExecutionRunCommand
  | PauseExecutionRunCommand
  | ResumeExecutionRunCommand
  | StopExecutionRunCommand;

export function ExecutionRunSection({
  board,
  deliveryPlan,
  profiles,
  runs,
  connectionReady,
  submitting,
  error,
  onCommand,
}: {
  board: BoardView;
  deliveryPlan: ApprovedDeliveryPlan | null;
  profiles: readonly ResolvedWorkerProfileSnapshot[];
  runs: readonly ExecutionRunView[];
  connectionReady: boolean;
  submitting: boolean;
  error?: string;
  onCommand(command: ExecutionRunCommand): void;
}) {
  const activeRun = runs.find(({ run }) => run.lifecycle !== 'completed');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [profileByTask, setProfileByTask] = useState<
    Readonly<Record<string, string>>
  >({});
  const [concurrency, setConcurrency] = useState(2);
  const [capacityConfirmed, setCapacityConfirmed] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const developerProfiles = profiles.filter(({ document }) =>
    document.spec.assignmentKinds.some((kind) => kind === 'developer_task'),
  );
  const selectedCards = board.cards.filter(({ taskId }) =>
    selected.has(taskId),
  );
  const missingPrerequisites = useMemo(
    () =>
      selectedCards.flatMap((card) =>
        card.dependencies
          .filter(
            (dependency) =>
              dependency.direction === 'prerequisite' &&
              dependency.otherTaskLifecycle !== 'completed' &&
              !selected.has(dependency.otherTaskId),
          )
          .map((dependency) => dependency.otherTaskTitle),
      ),
    [selected, selectedCards],
  );
  const profilesComplete = selectedCards.every((card) =>
    developerProfiles.some(
      ({ profileId }) => profileId === profileByTask[card.taskId],
    ),
  );
  const disabled = !connectionReady || submitting;
  const canStart =
    !disabled &&
    !activeRun &&
    deliveryPlan !== null &&
    board.filter !== null &&
    !board.stale &&
    selectedCards.length > 0 &&
    missingPrerequisites.length === 0 &&
    profilesComplete &&
    capacityConfirmed &&
    concurrency >= 1 &&
    concurrency <= 4;

  useEffect(
    () => setConfirmingStop(false),
    [activeRun?.run.id, activeRun?.run.revision],
  );

  const control = (
    type: 'execution_run.pause' | 'execution_run.resume' | 'execution_run.stop',
  ) => {
    if (!activeRun || disabled) return;
    onCommand({
      type,
      projectId: board.projectId,
      runId: activeRun.run.id,
      expectedRunRevision: activeRun.run.revision,
    });
  };

  return (
    <section
      className="execution-run-section"
      aria-labelledby="execution-run-heading"
    >
      <h3 id="execution-run-heading">Finite execution run</h3>
      {error ? <p role="alert">{error}</p> : null}
      {submitting ? <p role="status">Run command is in progress.</p> : null}
      {activeRun ? (
        <>
          <p role="status">
            {activeRun.run.lifecycle} · {activeRun.run.counts.active} active ·{' '}
            {activeRun.run.counts.waiting} waiting ·{' '}
            {activeRun.run.counts.attentionRequired} attention required ·{' '}
            {activeRun.run.counts.completed} completed
          </p>
          {activeRun.run.attention ? (
            <p role="alert">{activeRun.run.attention.message}</p>
          ) : null}
          <div className="execution-run-controls">
            {activeRun.run.lifecycle === 'running' ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => control('execution_run.pause')}
              >
                Pause run
              </button>
            ) : null}
            {activeRun.run.lifecycle === 'paused' ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => control('execution_run.resume')}
              >
                Resume run
              </button>
            ) : null}
            {activeRun.run.lifecycle === 'running' ||
            activeRun.run.lifecycle === 'paused' ? (
              confirmingStop ? (
                <>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => control('execution_run.stop')}
                  >
                    Confirm stop
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingStop(false)}
                  >
                    Cancel stop
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setConfirmingStop(true)}
                >
                  Stop run
                </button>
              )
            ) : null}
          </div>
        </>
      ) : deliveryPlan && board.filter ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canStart || !deliveryPlan || !board.filter) return;
            onCommand({
              type: 'execution_run.start',
              projectId: board.projectId,
              expectedDeliveryPlanId: deliveryPlan.plan.id,
              expectedDeliveryPlanRevision: deliveryPlan.plan.revision,
              expectedBoardFilterRevision: board.filter.revision,
              selections: selectedCards.map((card) => {
                const profile = developerProfiles.find(
                  ({ profileId }) => profileId === profileByTask[card.taskId],
                )!;
                return {
                  taskId: card.taskId,
                  expectedTaskRevision: card.taskCurrentRevision,
                  profileId: profile.profileId,
                  profileRevision: profile.profileRevision,
                };
              }),
              concurrencyLimit: concurrency,
              subscriptionCapacityConfirmed: true,
            });
          }}
        >
          <fieldset disabled={disabled || deliveryPlan === null || board.stale}>
            <legend>Tasks</legend>
            {board.cards
              .filter(({ lifecycle }) => lifecycle === 'pending')
              .map((card) => (
                <div key={card.taskId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(card.taskId)}
                      onChange={() =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(card.taskId)) next.delete(card.taskId);
                          else next.add(card.taskId);
                          return next;
                        })
                      }
                    />
                    Run {card.title}
                  </label>
                  {selected.has(card.taskId) ? (
                    <label>
                      Profile for {card.title}
                      <select
                        value={profileByTask[card.taskId] ?? ''}
                        onChange={(event) =>
                          setProfileByTask((current) => ({
                            ...current,
                            [card.taskId]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Select profile</option>
                        {developerProfiles.map((profile) => (
                          <option
                            key={profile.profileId}
                            value={profile.profileId}
                          >
                            {profile.document.metadata.displayName} · revision{' '}
                            {profile.profileRevision}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              ))}
          </fieldset>
          {[...new Set(missingPrerequisites)].map((title) => (
            <p key={title}>Select prerequisite {title}.</p>
          ))}
          <label>
            Parallel workers
            <input
              type="number"
              min="1"
              max="4"
              value={concurrency}
              disabled={disabled}
              onChange={(event) =>
                setConcurrency(event.currentTarget.valueAsNumber)
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={capacityConfirmed}
              disabled={disabled}
              onChange={(event) =>
                setCapacityConfirmed(event.currentTarget.checked)
              }
            />
            I confirmed subscription capacity for this run
          </label>
          <button type="submit" disabled={!canStart}>
            Start run
          </button>
        </form>
      ) : (
        <p>A current approved delivery plan is required.</p>
      )}
    </section>
  );
}
