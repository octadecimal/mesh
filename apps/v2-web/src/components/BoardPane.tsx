import { useEffect, useId, useRef, useState } from 'react';

import type {
  BoardFilterSelection,
  BoardTaskCard,
  BoardView,
  ApprovedDeliveryPlan,
  DeveloperAttempt,
  DeveloperReportRecord,
  ExecutionRunView,
  ProjectEventCursors,
  ResolvedWorkerProfileSnapshot,
  SetBoardFilterCommand,
  TaskReadinessBlocker,
  WorkerExecution,
} from '@mesh/v2-contracts';

import {
  DeveloperSection,
  type DeveloperActivityProjection,
} from './DeveloperSection';
import {
  ExecutionRunSection,
  type ExecutionRunCommand,
} from './ExecutionRunSection';
import type { PlanningConnection } from './PlanningPane';
import './planning-board.css';

export type BoardDeveloperProjection = {
  attempts: readonly DeveloperAttempt[];
  reports: readonly DeveloperReportRecord[];
  executions: readonly WorkerExecution[];
  profiles: readonly ResolvedWorkerProfileSnapshot[];
  projectCursors: ProjectEventCursors;
  activityByExecutionId: Readonly<Record<string, DeveloperActivityProjection>>;
  error?: string;
  onStart: (
    card: BoardTaskCard,
    profile: ResolvedWorkerProfileSnapshot,
  ) => void;
  onInterrupt: (attempt: DeveloperAttempt) => void;
  onReplace: (attempt: DeveloperAttempt) => void;
};

export type BoardExecutionRunProjection = {
  deliveryPlan: ApprovedDeliveryPlan | null;
  runs: readonly ExecutionRunView[];
  profiles: readonly ResolvedWorkerProfileSnapshot[];
  error?: string;
  onCommand(command: ExecutionRunCommand): void;
};

const emptySelection: BoardFilterSelection = {
  milestoneIds: [],
  taskLifecycles: [],
  readiness: [],
  priorities: [],
  labels: [],
  requirementRecordIds: [],
};

function selectionFrom(board: BoardView | undefined): BoardFilterSelection {
  if (!board?.filter) return emptySelection;
  const {
    milestoneIds,
    taskLifecycles,
    readiness,
    priorities,
    labels,
    requirementRecordIds,
  } = board.filter;
  return {
    milestoneIds,
    taskLifecycles,
    readiness,
    priorities,
    labels,
    requirementRecordIds,
  };
}

function readinessReason(card: BoardTaskCard, blocker: TaskReadinessBlocker) {
  switch (blocker.kind) {
    case 'dependency_incomplete': {
      const dependency = card.dependencies.find(
        ({ dependencyId }) => dependencyId === blocker.dependencyId,
      );
      return `Blocked by ${dependency?.otherTaskTitle ?? blocker.prerequisiteTaskId}`;
    }
    case 'plan_not_approved':
      return 'Blocked because no delivery plan is approved.';
    case 'plan_stale':
      return `Blocked because the plan targets requirement ledger revision ${blocker.expectedLedgerRevision}, not ${blocker.actualLedgerRevision}.`;
    case 'milestone_retired':
      return 'Inactive because the milestone is retired.';
    case 'task_completed':
      return 'Inactive because the task is completed.';
    case 'task_retired':
      return 'Inactive because the task is retired.';
  }
}

function TaskDetails({
  card,
  developer,
  connection,
  submitting,
}: {
  card: BoardTaskCard;
  developer?: BoardDeveloperProjection;
  connection: PlanningConnection;
  submitting: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <section className="planning-board-details" aria-label="Task details">
      <h4 ref={headingRef} tabIndex={-1}>
        Task details
      </h4>
      <p>Acceptance: {card.detail.acceptanceCriteria.join(' · ')}</p>
      <p>Verification: {card.detail.verificationCriteria.join(' · ')}</p>
      <p>Owned surfaces: {card.detail.ownedSurfaces.join(' · ') || 'None'}</p>
      <p>
        Prohibited surfaces:{' '}
        {card.detail.prohibitedSurfaces.join(' · ') || 'None'}
      </p>
      <p>
        Expected artifacts:{' '}
        {card.detail.expectedArtifacts.join(' · ') || 'None'}
      </p>
      <p>Milestone outcome: {card.detail.milestoneOutcome}</p>
      <p>Milestone stop condition: {card.detail.milestoneStopCondition}</p>
      <p>
        Milestone exclusions:{' '}
        {card.detail.milestoneExclusions.join(' · ') || 'None'}
      </p>
      <h5>Requirement traceability</h5>
      {card.detail.requirementTraces.length === 0 ? (
        <p>No requirement traces.</p>
      ) : (
        <ul>
          {card.detail.requirementTraces.map((trace) => (
            <li key={`${trace.recordId}-${trace.recordRevision}`}>
              {trace.title} · revision {trace.recordRevision} · {trace.recordId}
            </li>
          ))}
        </ul>
      )}
      {developer ? (
        <DeveloperSection
          card={card}
          attempts={developer.attempts.filter(
            (attempt) => attempt.taskId === card.taskId,
          )}
          reports={developer.reports}
          executions={developer.executions}
          profiles={developer.profiles}
          projectCursors={developer.projectCursors}
          activityByExecutionId={developer.activityByExecutionId}
          connection={connection}
          submitting={submitting}
          error={developer.error}
          onStart={(profile) => developer.onStart(card, profile)}
          onInterrupt={developer.onInterrupt}
          onReplace={developer.onReplace}
        />
      ) : null}
    </section>
  );
}

function optionLabel(option: {
  label: string;
  matchingTaskCount: number;
  historical?: boolean;
}) {
  const count = option.matchingTaskCount;
  return `${option.label} · ${option.historical ? 'historical, ' : ''}${count} ${count === 1 ? 'task' : 'tasks'}`;
}

export function BoardPane({
  board,
  connection,
  submitting,
  error,
  onApplyFilter,
  developer,
  executionRun,
}: {
  board?: BoardView;
  connection: PlanningConnection;
  submitting: boolean;
  error?: string;
  onApplyFilter: (command: SetBoardFilterCommand) => void;
  developer?: BoardDeveloperProjection;
  executionRun?: BoardExecutionRunProjection;
}) {
  const [draft, setDraft] = useState(() => selectionFrom(board));
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const headingId = useId();
  const detailButtons = useRef(new Map<string, HTMLButtonElement>());
  const disabled =
    connection.status !== 'ready' || submitting || !board?.filter;

  useEffect(() => setDraft(selectionFrom(board)), [board?.filter]);

  function toggle<K extends keyof BoardFilterSelection>(
    key: K,
    value: BoardFilterSelection[K][number],
    orderedValues: BoardFilterSelection[K],
  ) {
    setDraft((current) => {
      const selected = new Set(current[key] as readonly string[]);
      if (selected.has(value as string)) selected.delete(value as string);
      else selected.add(value as string);
      return {
        ...current,
        [key]: (orderedValues as readonly string[]).filter((candidate) =>
          selected.has(candidate),
        ),
      };
    });
  }

  function closeDetails() {
    const closedTaskId = detailTaskId;
    setDetailTaskId(null);
    if (closedTaskId) detailButtons.current.get(closedTaskId)?.focus();
  }

  if (connection.status === 'loading' && !board) {
    return (
      <section className="planning-board-pane">
        <h2>Board</h2>
        <p role="status">Board is loading.</p>
      </section>
    );
  }

  const emptyMessage =
    board?.emptyReason === 'intent_required'
      ? 'Approve project intent and requirements to plan delivery.'
      : board?.emptyReason === 'planning_required'
        ? 'Approve a delivery plan to populate the Board.'
        : board?.emptyReason === 'plan_empty'
          ? 'The approved delivery plan has no active tasks.'
          : board?.emptyReason === 'filter_empty'
            ? 'No tasks match the applied Board filters.'
            : undefined;
  const filterRevision = board?.filter?.revision;
  const optionOrder = board
    ? {
        milestoneIds: board.facets.milestones.map(({ value }) => value),
        taskLifecycles: board.facets.taskLifecycles.map(({ value }) => value),
        readiness: board.facets.readiness.map(({ value }) => value),
        priorities: board.facets.priorities.map(({ value }) => value),
        labels: board.facets.labels.map(({ value }) => value),
        requirementRecordIds: board.facets.requirements.map(
          ({ value }) => value,
        ),
      }
    : emptySelection;

  const facetGroups = board
    ? ([
        ['Milestones', 'milestoneIds', board.facets.milestones],
        ['Task lifecycle', 'taskLifecycles', board.facets.taskLifecycles],
        ['Readiness', 'readiness', board.facets.readiness],
        ['Priority', 'priorities', board.facets.priorities],
        ['Labels', 'labels', board.facets.labels],
        ['Requirements', 'requirementRecordIds', board.facets.requirements],
      ] as const)
    : [];

  return (
    <section className="planning-board-pane" aria-labelledby={headingId}>
      <h2 id={headingId}>Board</h2>
      {error ? (
        <p role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
      {connection.status === 'disconnected' || connection.status === 'stale' ? (
        <p role="status">{connection.message}</p>
      ) : null}
      {submitting ? (
        <p role="status">A project command is in progress.</p>
      ) : null}
      {board?.stale ? <p role="status">Approved plan is stale.</p> : null}
      {board ? (
        <p role="status" aria-live="polite">
          Showing {board.matchedTaskCount} of {board.totalTaskCount} tasks ·
          plan {board.deliveryPlanRevision ?? 'not approved'}
        </p>
      ) : null}
      {board && executionRun ? (
        <ExecutionRunSection
          board={board}
          deliveryPlan={executionRun.deliveryPlan}
          profiles={executionRun.profiles}
          runs={executionRun.runs}
          connectionReady={connection.status === 'ready'}
          submitting={submitting}
          error={executionRun.error}
          onCommand={executionRun.onCommand}
        />
      ) : null}
      {board?.filter ? (
        <section
          aria-label="Applied Board filters"
          className="planning-board-chips"
        >
          <h3>Applied filters</h3>
          {facetGroups.flatMap(([, key, options]) =>
            options
              .filter(({ selected }) => selected)
              .map((option) => (
                <div key={`${option.value}`}>
                  <span>{optionLabel(option)}</span>
                  {'historical' in option && option.historical ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        toggle(key, option.value, optionOrder[key])
                      }
                    >
                      Clear {option.label} filter
                    </button>
                  ) : null}
                </div>
              )),
          )}
          {Object.values(selectionFrom(board)).every(
            (values) => values.length === 0,
          ) ? (
            <p>No filters applied.</p>
          ) : null}
        </section>
      ) : null}
      {board?.filter ? (
        <form
          className="planning-board-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && board && filterRevision)
              onApplyFilter({
                type: 'board_filter.set',
                projectId: board.projectId,
                expectedFilterRevision: filterRevision,
                filter: draft,
              });
          }}
        >
          {facetGroups.map(([legend, key, options]) => (
            <fieldset key={key} disabled={disabled}>
              <legend>{legend}</legend>
              {options.map((option) => {
                const label = optionLabel(option);
                return (
                  <div key={`${option.value}`}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={label}
                        checked={(draft[key] as readonly string[]).includes(
                          option.value,
                        )}
                        onChange={() =>
                          toggle(key, option.value, optionOrder[key])
                        }
                      />
                      {label}
                    </label>
                  </div>
                );
              })}
            </fieldset>
          ))}
          <button type="submit" disabled={disabled}>
            Apply filters
          </button>
        </form>
      ) : null}
      {emptyMessage ? <p>{emptyMessage}</p> : null}
      {board?.facets.milestones.map((milestone) => {
        const cards = board.cards.filter(
          ({ milestoneId }) => milestoneId === milestone.value,
        );
        if (cards.length === 0) return null;
        return (
          <section
            key={milestone.value}
            aria-labelledby={`board-milestone-${milestone.value}`}
          >
            <h3 id={`board-milestone-${milestone.value}`}>{milestone.label}</h3>
            {cards.map((card) => (
              <article key={card.taskId} className="planning-board-card">
                <h4>{card.title}</h4>
                <p>{card.outcome}</p>
                <p>
                  {card.lifecycle} · {card.priority} ·{' '}
                  {card.labels.join(' · ') || 'No labels'}
                </p>
                {card.executionRunItem ? (
                  <p>
                    Run item ·{' '}
                    {card.executionRunItem.lifecycle.replace('_', ' ')}
                  </p>
                ) : null}
                {card.readiness.state === 'actionable' ? (
                  <p>Actionable</p>
                ) : (
                  <ul aria-label={`Readiness for ${card.title}`}>
                    {card.readiness.blockers.map((blocker) => (
                      <li
                        key={
                          blocker.kind === 'dependency_incomplete'
                            ? blocker.dependencyId
                            : blocker.kind
                        }
                      >
                        {readinessReason(card, blocker)}
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  Requirements:{' '}
                  {card.detail.requirementTraces.length === 0
                    ? 'None'
                    : card.detail.requirementTraces
                        .map(
                          ({ title, recordRevision }) =>
                            `${title} · revision ${recordRevision}`,
                        )
                        .join(' · ')}
                </p>
                {card.dependencies.length ? (
                  <ul aria-label={`Dependencies for ${card.title}`}>
                    {card.dependencies.map((dependency) => (
                      <li key={dependency.dependencyId}>
                        {dependency.direction}: {dependency.otherTaskTitle} ·{' '}
                        {dependency.otherTaskLifecycle}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <button
                  type="button"
                  ref={(node) => {
                    if (node) detailButtons.current.set(card.taskId, node);
                    else detailButtons.current.delete(card.taskId);
                  }}
                  aria-label={`View ${card.title} details`}
                  onClick={() => setDetailTaskId(card.taskId)}
                >
                  View details
                </button>
                {detailTaskId === card.taskId ? (
                  <>
                    <TaskDetails
                      card={card}
                      developer={developer}
                      connection={connection}
                      submitting={submitting}
                    />
                    <button type="button" onClick={closeDetails}>
                      Close task details
                    </button>
                  </>
                ) : null}
              </article>
            ))}
          </section>
        );
      })}
    </section>
  );
}
