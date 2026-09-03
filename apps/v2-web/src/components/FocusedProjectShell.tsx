import { useRef, type KeyboardEvent } from 'react';

import type {
  AbandonPlanningCycleCommand,
  ApprovePlanProposalCommand,
  BoardTaskCard,
  DeveloperAttempt,
  RejectPlanProposalCommand,
  SetBoardFilterCommand,
  SubmitPlanTurnCommand,
  DeliveryPlanPlanningCycleView,
  PlanningCycleView,
  PlanningProposal,
  RuntimeEvent,
  ResolvedWorkerProfileSnapshot,
  WorkerExecution,
} from '@mesh/v2-contracts';

import { ExecutionActivity, type ChildActivity } from './ExecutionActivity';
import { BoardPane } from './BoardPane';
import { DeliveryPlanningPane, PlanningPane } from './PlanningPane';
import { RequirementsPane } from './RequirementsPane';
import type { ProjectShellViewModel } from './shell-state';
import type { ExecutionRunCommand } from './ExecutionRunSection';
import type { ProjectArtifact } from '../app/routes';
import { appHref } from '../app/routes';
import {
  attentionFromSnapshots,
  runsFromSnapshots,
} from '../app/global-projection';
import { ProjectOverview } from './ProjectOverview';
import { RunsView } from './RunsView';

const projectArtifacts = [
  { label: 'Overview', slug: 'overview' },
  { label: 'Requirements', slug: 'requirements' },
  { label: 'Plans', slug: 'plans' },
  { label: 'Board', slug: 'board' },
  { label: 'Runs', slug: 'runs' },
] as const;

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
  onSubmitPlan(command: SubmitPlanTurnCommand): void;
  onApprovePlan(command: ApprovePlanProposalCommand): void;
  onRejectPlan(command: RejectPlanProposalCommand): void;
  onAbandonPlan(command: AbandonPlanningCycleCommand): void;
  onApplyFilter(command: SetBoardFilterCommand): void;
};

export type DeveloperCommandProjection = {
  error?: string;
  onStart(card: BoardTaskCard, profile: ResolvedWorkerProfileSnapshot): void;
  onInterrupt(attempt: DeveloperAttempt): void;
  onReplace(attempt: DeveloperAttempt): void;
};

export type ExecutionRunCommandProjection = {
  error?: string;
  onCommand(command: ExecutionRunCommand): void;
};

const inertPlanning: PlanningCommandProjection = {
  submitting: false,
  enabled: true,
  onSubmitTurn: () => undefined,
  onApprove: () => undefined,
  onReject: () => undefined,
  onAbandon: () => undefined,
  onSubmitPlan: () => undefined,
  onApprovePlan: () => undefined,
  onRejectPlan: () => undefined,
  onAbandonPlan: () => undefined,
  onApplyFilter: () => undefined,
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
  artifact,
  selectedId,
  onDeselect,
  onInterrupt,
  onNavigateArtifact = () => undefined,
  onNavigate = () => undefined,
  activityByExecutionId = {},
  planning = inertPlanning,
  developer,
  executionRun,
}: {
  model: ProjectShellViewModel;
  artifact: ProjectArtifact;
  selectedId?: string;
  onDeselect: () => void;
  onInterrupt: (execution: WorkerExecution) => void;
  onNavigateArtifact(artifact: ProjectArtifact): void;
  onNavigate(href: string): void;
  activityByExecutionId?: Readonly<Record<string, ExecutionActivityProjection>>;
  planning?: PlanningCommandProjection;
  developer?: DeveloperCommandProjection;
  executionRun?: ExecutionRunCommandProjection;
}) {
  // ponytail: remove this fallback when App supplies artifact routes.
  const legacyArtifact = artifact === undefined;
  const activeArtifact = artifact ?? 'board';
  const tabRefs = useRef<Record<ProjectArtifact, HTMLAnchorElement | null>>({
    overview: null,
    plans: null,
    board: null,
    requirements: null,
    runs: null,
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
    .filter(
      (profile) =>
        profile.document.spec.assignmentKinds.length === 1 &&
        profile.document.spec.assignmentKinds[0] === 'pm_discovery' &&
        profile.document.spec.outputSchema ===
          'mesh.dev/pm-discovery-report/v1',
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
    ({ cycle, purpose }) =>
      purpose.kind === 'intent' &&
      !terminalPlanningLifecycles.has(cycle.lifecycle),
  );
  const terminalPlanningHistory = activePlanningCycle
    ? undefined
    : snapshot.planningCycles.find(
        ({ cycle, purpose }) =>
          purpose.kind === 'intent' &&
          terminalPlanningLifecycles.has(cycle.lifecycle),
      );
  const deliveryCycles = snapshot.planningCycles.filter(
    (cycle): cycle is DeliveryPlanPlanningCycleView =>
      cycle.purpose.kind === 'delivery_plan',
  );
  const deliveryCycle =
    deliveryCycles.find(
      ({ cycle }) => !terminalPlanningLifecycles.has(cycle.lifecycle),
    ) ?? deliveryCycles[0];
  const deliveryProfiles = snapshot.profiles
    .filter(
      (profile) =>
        profile.document.spec.assignmentKinds.length === 1 &&
        profile.document.spec.assignmentKinds[0] === 'pm_plan' &&
        profile.document.spec.outputSchema === 'mesh.dev/pm-plan-report/v1',
    )
    .map((profile) => ({
      profileId: profile.profileId,
      projectId: profile.projectId,
      scope: profile.document.metadata.scope,
      name: profile.document.metadata.name,
      displayName: profile.document.metadata.displayName,
      approvedRevision: profile.profileRevision,
    }));
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
  function activateArtifact(nextArtifact: ProjectArtifact) {
    onNavigateArtifact(nextArtifact);
    tabRefs.current[nextArtifact]?.focus();
  }
  function moveTab(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const targetIndex =
      key === 'Home'
        ? 0
        : key === 'End'
          ? projectArtifacts.length - 1
          : (index +
              (key === 'ArrowRight' ? 1 : -1) +
              projectArtifacts.length) %
            projectArtifacts.length;
    activateArtifact(projectArtifacts[targetIndex].slug);
  }

  return (
    <main className="v2-shell" aria-labelledby="focused-project-heading">
      <header className="v2-shell-header">
        <div>
          <p className="v2-eyebrow">Focused project</p>
          <h1 id="focused-project-heading">{snapshot.project.displayName}</h1>
          <div className="v2-project-metadata">
            <p className="v2-project-path">{snapshot.project.repositoryPath}</p>
            <p
              role="status"
              className={
                model.status === 'ready' ? undefined : 'v2-connection-status'
              }
            >
              {model.status === 'ready' ? 'Connected' : model.message}
            </p>
            <p className="v2-cursors">
              Domain cursor {snapshot.cursors.domain}; runtime cursor{' '}
              {snapshot.cursors.runtime}
            </p>
          </div>
        </div>
        <button type="button" onClick={onDeselect}>
          Deselect project
        </button>
      </header>
      <div className="v2-project-layout">
        <aside className="v2-pm-pane" aria-label="PM Chat">
          {terminalPlanningHistory ? (
            <PlanningPane
              cycle={terminalPlanningHistory}
              connection={{ status: 'ready' }}
              profiles={[]}
              submitting={false}
              headingLabel="PM Chat history"
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
          <DeliveryPlanningPane
            projectId={snapshot.project.id}
            cycle={deliveryCycle}
            approvedIntentLedger={snapshot.intentLedger}
            deliveryPlan={snapshot.deliveryPlan}
            planStale={snapshot.board.stale}
            connection={planningConnection}
            profiles={deliveryProfiles}
            submitting={planning.submitting}
            error={planning.error}
            historyLimitReached={
              deliveryCycle !== undefined &&
              (deliveryCycle.turns.filter(({ actor }) => actor === 'human')
                .length >= 32 ||
                deliveryCycle.deliveryPlanProposals.length >= 16)
            }
            onSubmit={planning.onSubmitPlan}
            onApprove={planning.onApprovePlan}
            onReject={planning.onRejectPlan}
            onAbandon={planning.onAbandonPlan}
          />
        </aside>
        <div className="v2-project-content">
          <section aria-label="Project workspace">
            <div
              role="tablist"
              aria-label="Project artifacts"
              className="v2-project-tabs"
            >
              {projectArtifacts.map((item, index) => {
                const href = appHref({
                  page: 'project',
                  projectId: snapshot.project.id,
                  artifact: item.slug,
                });
                return (
                  <a
                    key={item.slug}
                    ref={(element) => {
                      tabRefs.current[item.slug] = element;
                    }}
                    id={`project-pane-tab-${item.slug}`}
                    role="tab"
                    href={href}
                    aria-selected={activeArtifact === item.slug}
                    aria-current={
                      activeArtifact === item.slug ? 'page' : undefined
                    }
                    aria-controls="project-artifact-panel"
                    tabIndex={activeArtifact === item.slug ? 0 : -1}
                    onClick={(event) => {
                      event.preventDefault();
                      activateArtifact(item.slug);
                    }}
                    onKeyDown={(event) => moveTab(event, index)}
                  >
                    {item.label}
                  </a>
                );
              })}
            </div>
            <section
              id="project-artifact-panel"
              role="tabpanel"
              aria-labelledby={`project-pane-tab-${activeArtifact}`}
            >
              {activeArtifact === 'overview' ? (
                <ProjectOverview
                  snapshot={snapshot}
                  attention={attentionFromSnapshots([snapshot])}
                  onNavigate={onNavigate}
                />
              ) : activeArtifact === 'requirements' ? (
                <RequirementsPane intentLedger={snapshot.intentLedger} />
              ) : activeArtifact === 'plans' ? (
                <section aria-labelledby="plans-heading">
                  <h2 id="plans-heading">Plans</h2>
                  <p>
                    Review intent and delivery planning with the project
                    manager.
                  </p>
                </section>
              ) : activeArtifact === 'board' ? (
                <BoardPane
                  board={snapshot.board}
                  connection={planningConnection}
                  submitting={planning.submitting}
                  error={planning.error}
                  onApplyFilter={planning.onApplyFilter}
                  developer={
                    developer
                      ? {
                          attempts: snapshot.developerAttempts ?? [],
                          reports: snapshot.developerReports ?? [],
                          executions: snapshot.executions,
                          profiles: snapshot.profiles,
                          projectCursors: snapshot.cursors,
                          activityByExecutionId,
                          error: developer.error,
                          onStart: developer.onStart,
                          onInterrupt: developer.onInterrupt,
                          onReplace: developer.onReplace,
                        }
                      : undefined
                  }
                  executionRun={
                    executionRun
                      ? {
                          deliveryPlan: snapshot.deliveryPlan,
                          runs: snapshot.executionRuns ?? [],
                          profiles: snapshot.profiles,
                          error: executionRun.error,
                          onCommand: executionRun.onCommand,
                        }
                      : undefined
                  }
                />
              ) : (
                <RunsView
                  runs={runsFromSnapshots([snapshot])}
                  projectId={snapshot.project.id}
                  selectedId={selectedId}
                  onNavigate={onNavigate}
                />
              )}
            </section>
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
          {legacyArtifact && snapshot.attentionItems.length > 0 ? (
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
