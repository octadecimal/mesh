import { useRef, useState, type KeyboardEvent } from 'react';

import type {
  PlanningCycleView,
  PlanningProposal,
  RuntimeEvent,
  WorkerExecution,
} from '@mesh/v2-contracts';

import { ExecutionActivity, type ChildActivity } from './ExecutionActivity';
import { PlanningPane } from './PlanningPane';
import { RequirementsPane } from './RequirementsPane';
import type { ProjectShellViewModel } from './shell-state';

const futurePanes = [
  { label: 'Board', slug: 'board' },
  { label: 'Requirements', slug: 'requirements' },
] as const;

type FuturePane = (typeof futurePanes)[number];
type FuturePaneSlug = FuturePane['slug'];

export type ExecutionActivityProjection = {
  childActivities: readonly ChildActivity[];
  diagnosticId?: string;
  runtimeActivity?: readonly RuntimeEvent[];
};

export type PlanningCommandProjection = {
  submitting: boolean;
  error?: string;
  enabled: boolean;
  disabledReason?: string;
  onSubmitTurn(
    message: string,
    profile?: { profileId: string; profileRevision: number },
  ): void;
  onApprove(proposalId: PlanningProposal['id']): void;
  onReject(proposalId: PlanningProposal['id'], feedback: string): void;
  onAbandon(cycleId: PlanningCycleView['cycle']['id']): void;
};

const inertPlanning: PlanningCommandProjection = {
  submitting: false,
  enabled: true,
  onSubmitTurn: () => undefined,
  onApprove: () => undefined,
  onReject: () => undefined,
  onAbandon: () => undefined,
};

const terminalPlanningLifecycles = new Set([
  'approved',
  'proposal_rejected',
  'abandoned',
]);

function disabledInterruptReason(status: ProjectShellViewModel['status']) {
  if (status === 'stale')
    return 'Wait for a fresh project snapshot before interrupting.';
  if (status === 'disconnected')
    return 'Reconnect before interrupting an execution.';
  return undefined;
}

export function FocusedProjectShell({
  model,
  onDeselect,
  onInterrupt,
  activityByExecutionId = {},
  planning = inertPlanning,
}: {
  model: ProjectShellViewModel;
  onDeselect: () => void;
  onInterrupt: (execution: WorkerExecution) => void;
  activityByExecutionId?: Readonly<Record<string, ExecutionActivityProjection>>;
  planning?: PlanningCommandProjection;
}) {
  const [activePane, setActivePane] = useState<FuturePaneSlug>('board');
  const tabRefs = useRef<Record<FuturePaneSlug, HTMLButtonElement | null>>({
    board: null,
    requirements: null,
  });
  if (model.status === 'loading') {
    return (
      <main className="v2-shell">
        <p role="status">Loading project {model.projectId}…</p>
      </main>
    );
  }

  const snapshot = model.snapshot;
  if (snapshot === undefined) {
    return (
      <main className="v2-shell">
        <p role="status">
          {model.status === 'disconnected'
            ? model.message
            : 'Project unavailable.'}
        </p>
        <button type="button" onClick={onDeselect}>
          Deselect project
        </button>
      </main>
    );
  }
  const interruptReason =
    model.status === 'ready'
      ? model.interrupt.enabled
        ? undefined
        : model.interrupt.disabledReason
      : disabledInterruptReason(model.status);
  const planningConnection =
    model.status === 'ready' && planning.enabled
      ? ({ status: 'ready' } as const)
      : model.status === 'ready'
        ? ({
            status: 'stale' as const,
            message: planning.disabledReason ?? 'Planning is unavailable.',
          } as const)
        : model.status === 'stale'
          ? ({ status: 'stale' as const, message: model.message } as const)
          : model.status === 'disconnected'
            ? ({
                status: 'disconnected' as const,
                message: model.message,
              } as const)
            : ({ status: 'loading' } as const);
  const planningProfiles = snapshot.profiles
    .filter((profile) =>
      profile.document.spec.assignmentKinds.some(
        (kind) => kind === 'pm_discovery',
      ),
    )
    .map((profile) => ({
      profileId: profile.profileId,
      projectId: profile.projectId,
      scope: profile.document.metadata.scope,
      name: profile.document.metadata.name,
      displayName: profile.document.metadata.displayName,
      approvedRevision: profile.profileRevision,
    }));
  const activePlanningCycle = snapshot.planningCycles.find(
    ({ cycle }) => !terminalPlanningLifecycles.has(cycle.lifecycle),
  );
  const terminalPlanningHistory = activePlanningCycle
    ? undefined
    : snapshot.planningCycles.find(({ cycle }) =>
        terminalPlanningLifecycles.has(cycle.lifecycle),
      );
  const latestPlanningExecutionId =
    activePlanningCycle?.turns.at(-1)?.executionId;
  const latestPlanningExecution = snapshot.executions.find(
    ({ id }) => id === latestPlanningExecutionId,
  );
  const planningAttention = snapshot.attentionItems.find(
    ({ executionId }) => executionId === latestPlanningExecutionId,
  );
  const planningRecovery =
    activePlanningCycle?.cycle.lifecycle === 'attention_required'
      ? latestPlanningExecution?.lifecycle === 'attention_required'
        ? ({
            kind: 'ambiguous_start' as const,
            operation: planningAttention?.message ?? 'unknown',
          } as const)
        : ({
            kind: 'retryable' as const,
            message:
              planningAttention?.message ??
              latestPlanningExecution?.failure?.message ??
              'The project manager did not produce a usable planning response. Send another message to retry.',
          } as const)
      : undefined;
  const planningHistoryLimitReached =
    activePlanningCycle !== undefined &&
    (activePlanningCycle.turns.filter(({ actor }) => actor === 'human')
      .length >= 32 ||
      activePlanningCycle.proposals.length >= 16);
  function activatePane(pane: FuturePane) {
    setActivePane(pane.slug);
    tabRefs.current[pane.slug]?.focus();
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const targetIndex =
      key === 'Home'
        ? 0
        : key === 'End'
          ? futurePanes.length - 1
          : (index + (key === 'ArrowRight' ? 1 : -1) + futurePanes.length) %
            futurePanes.length;
    activatePane(futurePanes[targetIndex]);
  }

  return (
    <main className="v2-shell" aria-labelledby="focused-project-heading">
      <header className="v2-shell-header">
        <div>
          <p className="v2-eyebrow">Focused project</p>
          <h1 id="focused-project-heading">{snapshot.project.displayName}</h1>
          <p>{snapshot.project.repositoryPath}</p>
        </div>
        <button type="button" onClick={onDeselect}>
          Deselect project
        </button>
      </header>
      {model.status === 'stale' || model.status === 'disconnected' ? (
        <p role="status" className="v2-connection-status">
          {model.message}
        </p>
      ) : null}
      <p className="v2-cursors">
        Domain cursor {snapshot.cursors.domain}; runtime cursor{' '}
        {snapshot.cursors.runtime}
      </p>
      <div className="v2-project-layout">
        <aside className="v2-pm-pane" aria-label="PM Chat">
          {terminalPlanningHistory ? (
            <PlanningPane
              cycle={terminalPlanningHistory}
              connection={{ status: 'ready' }}
              profiles={[]}
              submitting={false}
              historyTruncated={snapshot.planningHistoryTruncated}
              executions={snapshot.executions}
              approvedIntentLedger={snapshot.intentLedger}
              onSubmitTurn={planning.onSubmitTurn}
              onApprove={planning.onApprove}
              onReject={planning.onReject}
              onAbandon={planning.onAbandon}
            />
          ) : null}
          <PlanningPane
            cycle={activePlanningCycle}
            connection={planningConnection}
            profiles={planningProfiles}
            submitting={planning.submitting}
            error={planning.error}
            historyTruncated={
              terminalPlanningHistory
                ? false
                : snapshot.planningHistoryTruncated
            }
            historyLimitReached={planningHistoryLimitReached}
            recovery={planningRecovery}
            executions={snapshot.executions}
            approvedIntentLedger={snapshot.intentLedger}
            onSubmitTurn={planning.onSubmitTurn}
            onApprove={planning.onApprove}
            onReject={planning.onReject}
            onAbandon={planning.onAbandon}
          />
        </aside>
        <div className="v2-project-content">
          <section aria-label="Future workflow panes">
            <div role="tablist" aria-label="Project panes">
              {futurePanes.map((pane, index) => (
                <button
                  key={pane.slug}
                  ref={(element) => {
                    tabRefs.current[pane.slug] = element;
                  }}
                  id={`project-pane-tab-${pane.slug}`}
                  role="tab"
                  type="button"
                  aria-selected={activePane === pane.slug}
                  aria-controls={`project-pane-panel-${pane.slug}`}
                  tabIndex={activePane === pane.slug ? 0 : -1}
                  onClick={() => activatePane(pane)}
                  onKeyDown={(event) => moveTab(event, index)}
                >
                  {pane.label}
                </button>
              ))}
            </div>
            <section
              id="project-pane-panel-board"
              role="tabpanel"
              aria-labelledby="project-pane-tab-board"
              hidden={activePane !== 'board'}
            >
              <h2>Board</h2>
              <p>Available in a later milestone</p>
            </section>
            <section
              id="project-pane-panel-requirements"
              role="tabpanel"
              aria-labelledby="project-pane-tab-requirements"
              hidden={activePane !== 'requirements'}
            >
              <RequirementsPane intentLedger={snapshot.intentLedger} />
            </section>
          </section>
          <section aria-labelledby="profiles-heading">
            <h2 id="profiles-heading">Approved profiles</h2>
            <ul>
              {snapshot.profiles.map((profile) => (
                <li key={profile.profileId}>
                  {profile.document.metadata.displayName} · revision{' '}
                  {profile.profileRevision}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="activity-heading">
            <h2 id="activity-heading">Worker activity</h2>
            {snapshot.executions.length === 0 ? (
              <p>No worker executions yet.</p>
            ) : (
              <ul className="v2-execution-list">
                {snapshot.executions.map((execution) => {
                  const activity = activityByExecutionId[execution.id];
                  const rowInterruptReason =
                    execution.lifecycle === 'running'
                      ? interruptReason
                      : 'Only running executions can be interrupted.';
                  return (
                    <li key={execution.id}>
                      <ExecutionActivity
                        execution={execution}
                        childActivities={activity?.childActivities}
                        diagnosticId={activity?.diagnosticId}
                        runtimeActivity={activity?.runtimeActivity}
                        projectCursors={snapshot.cursors}
                      />
                      <button
                        type="button"
                        disabled={rowInterruptReason !== undefined}
                        aria-describedby={
                          rowInterruptReason
                            ? `interrupt-reason-${execution.id}`
                            : undefined
                        }
                        onClick={() => {
                          if (rowInterruptReason === undefined)
                            onInterrupt(execution);
                        }}
                      >
                        Interrupt execution
                      </button>
                      {rowInterruptReason ? (
                        <p id={`interrupt-reason-${execution.id}`}>
                          {rowInterruptReason}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {snapshot.attentionItems.length > 0 ? (
            <section aria-label="Attention items">
              <h2>Attention items</h2>
              <ul>
                {snapshot.attentionItems.map((item) => (
                  <li key={`${item.executionId}-${item.code}`}>
                    {item.message}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
