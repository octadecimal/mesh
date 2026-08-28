import {
  taskActorSchema,
  type MutatingCommand,
  type Project,
  type ProjectPlan,
  type ProjectPlanAttention,
  type ProjectPlanDetails,
  type ProjectPlanHistoryPage,
  type ProjectPlanProposal,
  type ProjectPlanProposalTask,
  type ProjectPlanSummary,
  type TaskActor,
} from '@mesh-session-platform/contracts';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { MeshProjection } from '../state/reducer';

export type ProjectPlanningPanelProps = {
  project: Project;
  projection: MeshProjection;
  connected: boolean;
  loadDetails: (
    projectId: string,
    planId: string,
  ) => Promise<ProjectPlanDetails>;
  loadHistory?: (
    projectId: string,
    before?: string,
  ) => Promise<ProjectPlanHistoryPage>;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onOpenSession?: (sessionId: string) => void;
};

const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
}) as Extract<TaskActor, { type: 'human' }>;

const statusLabels: Record<ProjectPlan['status'], string> = {
  planning: 'Planning in progress',
  awaiting_review: 'Proposal ready for review',
  revising: 'Revision in progress',
  attention_required: 'Planning needs attention',
  approved: 'Plan approved',
  rejected: 'Plan rejected',
  cancelled: 'Planning cancelled',
};

const splitLines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

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

const planFingerprint = (plan: ProjectPlan | undefined) =>
  plan
    ? `${plan.id}:${plan.revision}:${plan.status}:${plan.latestProposalOrdinal}`
    : 'no-active-plan';

const planDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const displayPriority = (priority: ProjectPlanProposalTask['priority']) =>
  priority.charAt(0).toUpperCase() + priority.slice(1);

const appendUniquePlans = (
  current: ProjectPlanSummary[],
  incoming: readonly ProjectPlanSummary[],
) => {
  const ids = new Set(current.map(({ id }) => id));
  const additions = incoming.filter(({ id }) => !ids.has(id));
  return additions.length > 0 ? [...current, ...additions] : current;
};

type PendingAction = {
  label: string;
  baseline: string;
  settled: boolean;
};

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; details: ProjectPlanDetails };

function EvidenceList({
  label,
  values,
}: {
  label: string;
  values: readonly string[];
}) {
  return (
    <ul aria-label={label}>
      {values.length > 0 ? (
        values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)
      ) : (
        <li>None</li>
      )}
    </ul>
  );
}

function StaleEvidence({ attention }: { attention: ProjectPlanAttention }) {
  if (attention.type !== 'stale_board')
    return <p className="notice notice-error">{attention.message}</p>;

  const groups = [
    {
      label: 'Added',
      ids: attention.addedTaskIds,
      total: attention.addedTaskTotal,
      truncated: attention.addedTaskIdsTruncated,
    },
    {
      label: 'Removed',
      ids: attention.removedTaskIds,
      total: attention.removedTaskTotal,
      truncated: attention.removedTaskIdsTruncated,
    },
    {
      label: 'Changed',
      ids: attention.changedTaskIds,
      total: attention.changedTaskTotal,
      truncated: attention.changedTaskIdsTruncated,
    },
  ];
  return (
    <div className="notice notice-error planning-stale-evidence" role="alert">
      <strong>The task board changed after this plan was prepared.</strong>
      {groups.map(({ label, ids, total, truncated }) => (
        <div key={label}>
          <p>
            {label} tasks: {total} total
            {truncated ? `; showing ${ids.length}` : ''}.
          </p>
          {ids.length > 0 ? (
            <EvidenceList label={`${label} task IDs`} values={ids} />
          ) : null}
        </div>
      ))}
      {attention.dependenciesChanged ? <p>Dependencies changed.</p> : null}
      {attention.policyChanged ? <p>Project policy changed.</p> : null}
    </div>
  );
}

const proposalTaskTitle = (taskKey: string, proposal: ProjectPlanProposal) =>
  proposal.tasks.find(({ key }) => key === taskKey)?.title ?? taskKey;

function ProposalTask({
  task,
  proposal,
  projection,
}: {
  task: ProjectPlanProposalTask;
  proposal: ProjectPlanProposal;
  projection: MeshProjection;
}) {
  const [expanded, setExpanded] = useState(false);
  const prerequisites = proposal.dependencies
    .filter(({ dependentTaskKey }) => dependentTaskKey === task.key)
    .map(({ prerequisite }) =>
      prerequisite.type === 'proposal_task'
        ? proposalTaskTitle(prerequisite.taskKey, proposal)
        : (projection.tasksById[prerequisite.taskId]?.title ??
          prerequisite.taskId),
    );
  const dependents = proposal.dependencies
    .filter(
      ({ prerequisite }) =>
        prerequisite.type === 'proposal_task' &&
        prerequisite.taskKey === task.key,
    )
    .map(({ dependentTaskKey }) =>
      proposalTaskTitle(dependentTaskKey, proposal),
    );

  return (
    <li className="planning-proposal-task">
      <button
        type="button"
        className="planning-proposal-task-heading"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} proposed task ${task.title}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>
          <strong>{task.title}</strong>
          <small>{task.key}</small>
        </span>
        <span className={`task-priority task-priority-${task.priority}`}>
          {displayPriority(task.priority)}
        </span>
      </button>
      <div className="planning-dependency-columns">
        <div>
          <span className="planning-list-label">Prerequisites</span>
          <EvidenceList
            label={`${task.title} prerequisites`}
            values={prerequisites}
          />
        </div>
        <div>
          <span className="planning-list-label">Dependents</span>
          <EvidenceList
            label={`${task.title} dependents`}
            values={dependents}
          />
        </div>
      </div>
      {expanded ? (
        <div className="planning-proposal-task-details">
          <p>{task.description}</p>
          <div>
            <strong>Acceptance criteria</strong>
            <ol>
              {task.acceptanceCriteria.map((criterion, index) => (
                <li key={`${index}:${criterion}`}>{criterion}</li>
              ))}
            </ol>
          </div>
          <p>
            <strong>Rationale:</strong> {task.rationale}
          </p>
          <p>
            <strong>Goal mapping:</strong> {task.goalMapping}
          </p>
          {task.labels.length > 0 ? (
            <p>
              <strong>Labels:</strong> {task.labels.join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

const revisionDifference = (
  proposal: ProjectPlanProposal,
  previous: ProjectPlanProposal | undefined,
) => {
  if (!previous) return 'Initial proposal.';
  const previousKeys = new Set(previous.tasks.map(({ key }) => key));
  const currentKeys = new Set(proposal.tasks.map(({ key }) => key));
  const added = proposal.tasks.filter(
    ({ key }) => !previousKeys.has(key),
  ).length;
  const removed = previous.tasks.filter(
    ({ key }) => !currentKeys.has(key),
  ).length;
  const retained = proposal.tasks.length - added;
  return `${added} added, ${removed} removed, ${retained} retained.`;
};

function PlanDetailsView({
  details,
  projection,
  onOpenSession,
}: {
  details: ProjectPlanDetails;
  projection: MeshProjection;
  onOpenSession?: (sessionId: string) => void;
}) {
  const proposals = [...details.proposals].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const proposal = proposals.at(-1);
  if (!proposal)
    return (
      <p className="planning-empty">No proposal revisions were recorded.</p>
    );
  const proposalSession = projection.sessions.find(
    ({ id }) => id === proposal.sessionId,
  );

  return (
    <div className="planning-details">
      <div className="planning-detail-heading">
        <div>
          <span className="eyebrow">Latest structured proposal</span>
          <h4>Revision {proposal.ordinal}</h4>
        </div>
        <div className="planning-detail-actions">
          <span>{proposal.tasks.length} proposed tasks</span>
          {onOpenSession ? (
            <button
              type="button"
              className="button button-ghost"
              title={proposalSession?.title ?? proposal.sessionId}
              onClick={() => onOpenSession(proposal.sessionId)}
            >
              Open proposal session
            </button>
          ) : (
            <span>
              Proposal session: {proposalSession?.title ?? proposal.sessionId}
            </span>
          )}
        </div>
      </div>
      <ol className="planning-proposal-tasks" aria-label="Proposed tasks">
        {proposal.tasks.map((task) => (
          <ProposalTask
            key={task.key}
            task={task}
            proposal={proposal}
            projection={projection}
          />
        ))}
      </ol>
      <div className="planning-evidence-grid">
        <div>
          <h5>Assumptions</h5>
          <EvidenceList
            label="Plan assumptions"
            values={proposal.assumptions}
          />
        </div>
        <div>
          <h5>Risks</h5>
          <EvidenceList label="Plan risks" values={proposal.risks} />
        </div>
        <div>
          <h5>Exclusions</h5>
          <EvidenceList label="Plan exclusions" values={proposal.exclusions} />
        </div>
      </div>
      <div className="planning-history-grid">
        <div>
          <h5>Proposal revisions</h5>
          <ol aria-label="Proposal revisions">
            {proposals.map((candidate, index) => (
              <li key={candidate.id}>
                <strong>Revision {candidate.ordinal}</strong>{' '}
                <span>
                  {candidate.tasks.length} tasks ·{' '}
                  {revisionDifference(candidate, proposals[index - 1])}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h5>Operator feedback</h5>
          <EvidenceList
            label="Operator feedback"
            values={details.feedback.map(({ content }) => content)}
          />
        </div>
      </div>
    </div>
  );
}

function ActivePlanSummary({
  plan,
  projection,
  onOpenSession,
}: {
  plan: ProjectPlan;
  projection: MeshProjection;
  onOpenSession?: (sessionId: string) => void;
}) {
  const session = plan.currentSessionId
    ? projection.sessions.find(({ id }) => id === plan.currentSessionId)
    : undefined;
  return (
    <div className="planning-active-summary">
      <div>
        <span
          className={`status planning-status planning-status-${plan.status}`}
        >
          {statusLabels[plan.status]}
        </span>
        <h4>{plan.goal}</h4>
        <p>
          Board changes made during planning can make approval stale. Request a
          refreshed revision before approval when the canonical board changes.
        </p>
      </div>
      {plan.currentSessionId ? (
        session && onOpenSession ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => onOpenSession(plan.currentSessionId as string)}
          >
            Open PM planning session
          </button>
        ) : (
          <p>Associated session: {session?.title ?? plan.currentSessionId}</p>
        )
      ) : null}
      <div className="planning-brief-grid">
        <div>
          <strong>Constraints</strong>
          <EvidenceList
            label="Planning constraints"
            values={plan.constraints}
          />
        </div>
        <div>
          <strong>Non-goals</strong>
          <EvidenceList label="Planning non-goals" values={plan.nonGoals} />
        </div>
      </div>
    </div>
  );
}

export function ProjectPlanningPanel({
  project,
  projection,
  connected,
  loadDetails,
  loadHistory,
  onCommand,
  onOpenSession,
}: ProjectPlanningPanelProps) {
  const activePlan = projection.activePlanByProjectId[project.id];
  const recentPlans = projection.planSummariesByProjectId[project.id] ?? [];
  const fingerprint = planFingerprint(activePlan);
  const [goal, setGoal] = useState('');
  const [constraints, setConstraints] = useState('');
  const [nonGoals, setNonGoals] = useState('');
  const [subscriptionConfirmed, setSubscriptionConfirmed] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [error, setError] = useState<string>();
  const [revisionFeedback, setRevisionFeedback] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [detailStates, setDetailStates] = useState<Record<string, DetailState>>(
    {},
  );
  const [accumulatedPlans, setAccumulatedPlans] = useState<
    ProjectPlanSummary[]
  >([]);
  const [nextBefore, setNextBefore] = useState<string | null>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const currentProjectId = useRef(project.id);
  currentProjectId.current = project.id;
  const controlsDisabled =
    !connected || Boolean(project.archivedAt) || Boolean(pendingAction);

  useEffect(() => {
    setGoal('');
    setConstraints('');
    setNonGoals('');
    setSubscriptionConfirmed(false);
    setPendingAction(undefined);
    setError(undefined);
    setRevisionFeedback('');
    setRejectionReason('');
    setCancellationReason('');
    setExpandedPlanIds(new Set());
    setDetailStates({});
    setAccumulatedPlans([]);
    setNextBefore(undefined);
    setHistoryLoading(false);
    setHistoryError(undefined);
  }, [project.id]);

  useEffect(() => {
    if (pendingAction?.settled && pendingAction.baseline !== fingerprint)
      setPendingAction(undefined);
  }, [fingerprint, pendingAction]);

  useEffect(() => {
    setAccumulatedPlans((current) => appendUniquePlans(current, recentPlans));
  }, [recentPlans]);

  useEffect(() => {
    if (nextBefore !== undefined) return;
    setNextBefore(recentPlans.length >= 20 ? recentPlans.at(-1)?.id : null);
  }, [nextBefore, recentPlans]);

  const execute = async (
    label: string,
    command: MutatingCommand,
    fallback: string,
  ) => {
    if (controlsDisabled) return;
    const commandProjectId = project.id;
    setPendingAction({ label, baseline: fingerprint, settled: false });
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

  const loadPlan = async (planId: string, force = false) => {
    if (!force && detailStates[planId]?.status === 'loaded') return;
    const requestProjectId = project.id;
    setDetailStates((current) => ({
      ...current,
      [planId]: { status: 'loading' },
    }));
    try {
      const details = await loadDetails(project.id, planId);
      if (currentProjectId.current !== requestProjectId) return;
      setDetailStates((current) => ({
        ...current,
        [planId]: { status: 'loaded', details },
      }));
    } catch (caught) {
      if (currentProjectId.current !== requestProjectId) return;
      setDetailStates((current) => ({
        ...current,
        [planId]: {
          status: 'error',
          message: failureMessage(
            caught,
            'Proposal details could not be loaded.',
          ),
        },
      }));
    }
  };

  const togglePlan = (planId: string) => {
    const expanded = expandedPlanIds.has(planId);
    setExpandedPlanIds((current) => {
      const next = new Set(current);
      if (expanded) next.delete(planId);
      else next.add(planId);
      return next;
    });
    if (!expanded) void loadPlan(planId);
  };

  const loadOlderPlans = async () => {
    if (!loadHistory || historyLoading || !nextBefore) return;
    const requestProjectId = project.id;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const page = await loadHistory(project.id, nextBefore);
      if (currentProjectId.current !== requestProjectId) return;
      setAccumulatedPlans((current) =>
        appendUniquePlans(current, [...recentPlans, ...page.plans]),
      );
      setNextBefore(page.nextAfter ?? null);
    } catch (caught) {
      if (currentProjectId.current !== requestProjectId) return;
      setHistoryError(
        failureMessage(caught, 'Older plans could not be loaded.'),
      );
    } finally {
      if (currentProjectId.current === requestProjectId)
        setHistoryLoading(false);
    }
  };

  const startPlanning = (event: FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || !subscriptionConfirmed) return;
    void execute(
      'start',
      {
        type: 'project.plan.start',
        payload: {
          projectId: project.id,
          expectedProjectRevision: project.revision,
          goal: goal.trim(),
          constraints: splitLines(constraints),
          nonGoals: splitLines(nonGoals),
          actor: operator,
        },
      },
      'Planning could not be started.',
    );
  };

  const control = (kind: 'resume' | 'retry') => {
    if (!activePlan) return;
    void execute(
      kind,
      {
        type: `project.plan.${kind}`,
        payload: {
          projectId: project.id,
          planId: activePlan.id,
          expectedPlanRevision: activePlan.revision,
          actor: operator,
        },
      } as MutatingCommand,
      `Planning could not be ${kind === 'resume' ? 'resumed' : 'retried'}.`,
    );
  };

  const activeDetailState = activePlan
    ? detailStates[activePlan.id]
    : undefined;
  const activeDetails =
    activeDetailState?.status === 'loaded'
      ? activeDetailState.details
      : undefined;
  const latestProposal = activeDetails?.proposals
    .filter(({ ordinal }) => ordinal === activePlan?.latestProposalOrdinal)
    .at(-1);
  const history = useMemo(() => {
    const seen = new Set<string>();
    return [...recentPlans, ...accumulatedPlans].filter(({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [accumulatedPlans, recentPlans]);

  const renderDetailState = (planId: string) => {
    const state = detailStates[planId];
    if (!state || state.status === 'loading')
      return <p className="planning-loading">Loading proposal…</p>;
    if (state.status === 'error')
      return (
        <div>
          <p className="notice notice-error" role="alert">
            {state.message}
          </p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void loadPlan(planId, true)}
          >
            Retry loading plan
          </button>
        </div>
      );
    return (
      <>
        <div className="planning-detail-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={() => void loadPlan(planId, true)}
          >
            Refresh proposal
          </button>
        </div>
        <PlanDetailsView
          details={state.details}
          projection={projection}
          onOpenSession={onOpenSession}
        />
      </>
    );
  };

  return (
    <section className="project-planning-panel" aria-label="Project planning">
      <div className="task-section-heading planning-heading">
        <div>
          <span className="eyebrow">Project management</span>
          <h3>Planning</h3>
        </div>
        {activePlan ? (
          <span className="planning-revision">
            Plan revision {activePlan.revision}
          </span>
        ) : null}
      </div>

      <p className="planning-disclosure">
        The PM can read this repository but cannot edit files, change tasks,
        approve plans, or launch work.
      </p>
      {!connected ? (
        <p className="notice notice-warning">
          Planning controls are disconnected or stale. Reconnect to use
          server-authoritative actions.
        </p>
      ) : null}
      {project.archivedAt ? (
        <p className="notice notice-warning">
          Archived projects cannot start or control planning.
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}

      {!activePlan ? (
        <form className="planning-start-form" onSubmit={startPlanning}>
          <label>
            <span>Project goal</span>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              disabled={controlsDisabled}
              rows={3}
              required
            />
          </label>
          <div className="planning-form-columns">
            <label>
              <span>Planning constraints</span>
              <textarea
                value={constraints}
                onChange={(event) => setConstraints(event.target.value)}
                disabled={controlsDisabled}
                rows={4}
                placeholder="One constraint per line"
              />
            </label>
            <label>
              <span>Planning non-goals</span>
              <textarea
                value={nonGoals}
                onChange={(event) => setNonGoals(event.target.value)}
                disabled={controlsDisabled}
                rows={4}
                placeholder="One non-goal per line"
              />
            </label>
          </div>
          <label className="planning-subscription-confirmation">
            <input
              type="checkbox"
              checked={subscriptionConfirmed}
              onChange={(event) =>
                setSubscriptionConfirmed(event.target.checked)
              }
              disabled={controlsDisabled}
            />
            <span>
              I understand planning consumes Claude subscription capacity.
            </span>
          </label>
          <button
            type="submit"
            className="button button-primary"
            disabled={
              controlsDisabled || !goal.trim() || !subscriptionConfirmed
            }
          >
            {pendingAction?.label === 'start'
              ? 'Starting planning…'
              : 'Start planning'}
          </button>
        </form>
      ) : (
        <div className="planning-active">
          <ActivePlanSummary
            plan={activePlan}
            projection={projection}
            onOpenSession={onOpenSession}
          />
          {activePlan.attention ? (
            <StaleEvidence attention={activePlan.attention} />
          ) : null}

          {activePlan.status === 'awaiting_review' ? (
            <div className="planning-review">
              <button
                type="button"
                className="button button-secondary"
                aria-expanded={expandedPlanIds.has(activePlan.id)}
                onClick={() => togglePlan(activePlan.id)}
              >
                {expandedPlanIds.has(activePlan.id)
                  ? 'Hide proposal'
                  : 'Review proposal'}
              </button>
              {expandedPlanIds.has(activePlan.id)
                ? renderDetailState(activePlan.id)
                : null}
              <div className="planning-review-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={controlsDisabled || !latestProposal}
                  onClick={() => {
                    if (!latestProposal) return;
                    void execute(
                      'approve',
                      {
                        type: 'project.plan.approve',
                        payload: {
                          projectId: project.id,
                          planId: activePlan.id,
                          proposalId: latestProposal.id,
                          expectedPlanRevision: activePlan.revision,
                          actor: operator,
                        },
                      },
                      'The plan could not be approved.',
                    );
                  }}
                >
                  {pendingAction?.label === 'approve'
                    ? 'Approving…'
                    : 'Approve plan'}
                </button>
                <label>
                  <span>Revision feedback</span>
                  <textarea
                    value={revisionFeedback}
                    onChange={(event) =>
                      setRevisionFeedback(event.target.value)
                    }
                    disabled={controlsDisabled}
                    rows={3}
                  />
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={controlsDisabled || !revisionFeedback.trim()}
                  onClick={() =>
                    void execute(
                      'revise',
                      {
                        type: 'project.plan.request_revision',
                        payload: {
                          projectId: project.id,
                          planId: activePlan.id,
                          expectedPlanRevision: activePlan.revision,
                          feedback: revisionFeedback.trim(),
                          actor: operator,
                        },
                      },
                      'Changes could not be requested.',
                    )
                  }
                >
                  {pendingAction?.label === 'revise'
                    ? 'Requesting changes…'
                    : 'Request changes'}
                </button>
              </div>
            </div>
          ) : null}

          {activePlan.status === 'attention_required' ? (
            <div className="planning-recovery-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={controlsDisabled}
                onClick={() => control('resume')}
              >
                {pendingAction?.label === 'resume'
                  ? 'Resuming…'
                  : 'Resume planning'}
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={controlsDisabled}
                onClick={() => control('retry')}
              >
                {pendingAction?.label === 'retry'
                  ? 'Retrying…'
                  : 'Retry planning'}
              </button>
            </div>
          ) : null}

          {['awaiting_review', 'attention_required'].includes(
            activePlan.status,
          ) ? (
            <div className="planning-terminal-control">
              <label>
                <span>Rejection reason</span>
                <textarea
                  value={rejectionReason}
                  onChange={(event) => setRejectionReason(event.target.value)}
                  disabled={controlsDisabled}
                  rows={2}
                />
              </label>
              <button
                type="button"
                className="button button-danger"
                disabled={controlsDisabled || !rejectionReason.trim()}
                onClick={() =>
                  void execute(
                    'reject',
                    {
                      type: 'project.plan.reject',
                      payload: {
                        projectId: project.id,
                        planId: activePlan.id,
                        expectedPlanRevision: activePlan.revision,
                        reason: rejectionReason.trim(),
                        actor: operator,
                      },
                    },
                    'The plan could not be rejected.',
                  )
                }
              >
                {pendingAction?.label === 'reject'
                  ? 'Rejecting…'
                  : 'Reject plan'}
              </button>
            </div>
          ) : null}

          <div className="planning-terminal-control">
            <label>
              <span>Cancellation reason</span>
              <textarea
                value={cancellationReason}
                onChange={(event) => setCancellationReason(event.target.value)}
                disabled={controlsDisabled}
                rows={2}
              />
            </label>
            <button
              type="button"
              className="button button-danger"
              disabled={controlsDisabled || !cancellationReason.trim()}
              onClick={() =>
                void execute(
                  'cancel',
                  {
                    type: 'project.plan.cancel',
                    payload: {
                      projectId: project.id,
                      planId: activePlan.id,
                      expectedPlanRevision: activePlan.revision,
                      reason: cancellationReason.trim(),
                      actor: operator,
                    },
                  },
                  'Planning could not be cancelled.',
                )
              }
            >
              {pendingAction?.label === 'cancel'
                ? 'Cancelling…'
                : 'Cancel planning'}
            </button>
          </div>
        </div>
      )}

      <div className="planning-history">
        <div className="planning-history-heading">
          <h4>Recent planning history</h4>
          <span>{history.length} loaded</span>
        </div>
        {history.length === 0 ? (
          <p className="planning-empty">No completed plans yet.</p>
        ) : (
          <ol aria-label="Planning history">
            {history.map((summary) => (
              <li key={summary.id}>
                <button
                  type="button"
                  className="planning-history-row"
                  aria-label={`View ${summary.goal}`}
                  aria-expanded={expandedPlanIds.has(summary.id)}
                  onClick={() => togglePlan(summary.id)}
                >
                  <span>
                    <strong>{summary.goal}</strong>
                    <small>{planDate(summary.terminalAt)}</small>
                  </span>
                  <span className={`status planning-status-${summary.status}`}>
                    {summary.status}
                  </span>
                </button>
                {expandedPlanIds.has(summary.id)
                  ? renderDetailState(summary.id)
                  : null}
              </li>
            ))}
          </ol>
        )}
        {historyError ? (
          <p className="notice notice-error" role="alert">
            {historyError}
          </p>
        ) : null}
        {loadHistory && nextBefore ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={historyLoading}
            onClick={() => void loadOlderPlans()}
          >
            {historyLoading ? 'Loading older plans…' : 'Load older plans'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
