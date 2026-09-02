import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  V2_PROTOCOL_VERSION,
  type AbandonPlanningCycleCommand,
  type ApprovePlanProposalCommand,
  type BoardTaskCard,
  type DeveloperAttempt,
  type PlanningCycleView,
  type RejectPlanProposalCommand,
  type ResolvedWorkerProfileSnapshot,
  type SetBoardFilterCommand,
  type SubmitPlanTurnCommand,
  type V2CommandEnvelope,
  type V2ProjectSnapshot,
  type V2SystemSnapshot,
  type WorkerExecution,
} from '@mesh/v2-contracts';

import { V2HttpError, type V2Api } from '../api/client';
import { FocusedProjectShell } from '../components/FocusedProjectShell';
import type { ExecutionActivityProjection } from '../components/FocusedProjectShell';
import { ProjectSelector } from '../components/ProjectSelector';
import type {
  MutationAvailability,
  ProjectShellViewModel,
  SelectorViewModel,
} from '../components/shell-state';
import {
  useProjectConnection,
  type ProjectSocketFactory,
} from './use-project-connection';

export type AppLocation = {
  readonly pathname: string;
  readonly protocol: string;
  readonly host: string;
  addEventListener(type: 'popstate', listener: EventListener): void;
  removeEventListener(type: 'popstate', listener: EventListener): void;
};

export type AppHistory = {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
};

type SystemState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: V2SystemSnapshot }
  | { status: 'disconnected'; message: string }
  | { status: 'error'; message: string };

type PendingCommand = {
  intent: string;
  envelope: V2CommandEnvelope;
};

type ActiveCommand = {
  controller: AbortController;
  token: symbol;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed.';

const terminalPlanningLifecycles = new Set([
  'approved',
  'proposal_rejected',
  'abandoned',
]);

const activePlanningCycle = (cycles?: readonly PlanningCycleView[]) =>
  cycles?.find(
    ({ cycle, purpose }) =>
      purpose.kind === 'intent' &&
      !terminalPlanningLifecycles.has(cycle.lifecycle),
  );

const freshnessConflictCodes = new Set([
  'planning_canonical_base_conflict',
  'planning_intent_required',
  'planning_requirements_required',
  'planning_cycle_active_conflict',
  'planning_cycle_history_limit',
  'planning_cycle_not_found',
  'planning_cycle_revision_conflict',
  'planning_profile_incompatible',
  'planning_proposal_not_found',
  'planning_proposal_revision_conflict',
  'plan_proposal_not_found',
  'plan_proposal_revision_conflict',
  'plan_canonical_base_conflict',
  'board_filter_not_found',
  'board_filter_revision_conflict',
  'developer_task_stale',
  'developer_plan_stale',
  'developer_profile_stale',
  'developer_profile_incompatible',
  'developer_task_not_actionable',
  'developer_attempt_conflict',
  'developer_attempt_transition_conflict',
  'developer_workspace_conflict',
  'developer_workspace_identity_mismatch',
  'developer_replacement_unavailable',
]);

const developerCommandTypes = new Set<V2CommandEnvelope['command']['type']>([
  'developer_attempt.start',
  'developer_attempt.interrupt',
  'developer_attempt.replace_execution',
]);

const planningCommandTypes = new Set<V2CommandEnvelope['command']['type']>([
  'planning_cycle.submit_turn',
  'planning_proposal.approve',
  'planning_proposal.reject',
  'planning_cycle.abandon',
  'planning_cycle.submit_plan_turn',
  'plan_proposal.approve',
  'plan_proposal.reject',
  'board_filter.set',
]);

const routeProjectId = (pathname: string) => {
  const match = /^\/projects\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
};

const availability = (
  enabled: boolean,
  disabledReason: string,
): MutationAvailability =>
  enabled ? { enabled: true } : { enabled: false, disabledReason };

const activityProjection = (
  snapshot: V2ProjectSnapshot,
  activity: ReturnType<typeof useProjectConnection>['projection']['activity'],
) => {
  const projections: Record<string, ExecutionActivityProjection> = {};
  for (const event of activity) {
    const current = projections[event.executionId] ?? { childActivities: [] };
    let childActivities = [...current.childActivities];
    if (event.type === 'worker_execution.child_started') {
      childActivities = [
        ...childActivities.filter(({ id }) => id !== event.payload.childId),
        {
          id: event.payload.childId,
          title: event.payload.title,
          lifecycle: 'running',
        },
      ];
    } else if (event.type === 'worker_execution.child_finished') {
      const prior = childActivities.find(
        ({ id }) => id === event.payload.childId,
      );
      childActivities = [
        ...childActivities.filter(({ id }) => id !== event.payload.childId),
        {
          id: event.payload.childId,
          title: prior?.title ?? event.payload.childId,
          lifecycle: event.payload.outcome,
        },
      ];
    }
    projections[event.executionId] = {
      childActivities,
      diagnosticId: event.diagnosticId,
      runtimeActivity: [...(current.runtimeActivity ?? []), event],
    };
  }
  for (const execution of snapshot.executions) {
    projections[execution.id] ??= { childActivities: [] };
  }
  return projections;
};

function ProjectConnection({
  api,
  projectId,
  socketFactory,
  location,
  auditHealthy,
  onAuditBarrier,
  onDeselect,
}: {
  api: V2Api;
  projectId: string;
  socketFactory: ProjectSocketFactory;
  location: AppLocation;
  auditHealthy: boolean;
  onAuditBarrier: (message: string) => void;
  onDeselect: () => void;
}) {
  const { projection, error, resyncing, dispatch } = useProjectConnection({
    api,
    projectId,
    socketFactory,
    location,
  });
  const pending = useRef<PendingCommand | undefined>(undefined);
  const activeCommand = useRef<ActiveCommand | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [developerError, setDeveloperError] = useState<string>();
  const snapshot = useMemo<V2ProjectSnapshot | undefined>(
    () =>
      projection.project && projection.board
        ? {
            protocolVersion: V2_PROTOCOL_VERSION,
            project: projection.project,
            profiles: projection.profiles,
            executions: projection.executions,
            developerAttempts: Object.values(projection.developerAttempts),
            developerReports: Object.values(projection.developerReports),
            attentionItems: projection.attentionItems,
            planningCycles: projection.planningCycles,
            planningHistoryTruncated: projection.planningHistoryTruncated,
            intentLedger: projection.intentLedger,
            deliveryPlan: projection.deliveryPlan,
            board: projection.board,
            cursors: {
              domain: projection.domainCursor,
              runtime: projection.runtimeCursor,
            },
          }
        : undefined,
    [projection],
  );
  const interrupt = availability(
    auditHealthy && !submitting,
    !auditHealthy
      ? 'Audit barrier is active.'
      : 'A project command is in progress.',
  );
  const model: ProjectShellViewModel = !snapshot
    ? error
      ? { status: 'disconnected', message: error }
      : { status: 'loading', projectId }
    : resyncing || projection.connection.status === 'stale'
      ? { status: 'stale', snapshot, message: error ?? 'Resyncing project.' }
      : projection.connection.status === 'loading'
        ? {
            status: 'stale',
            snapshot,
            message: 'Connecting to project events.',
          }
        : projection.connection.status === 'disconnected'
          ? { status: 'disconnected', snapshot, message: 'Connection lost.' }
          : projection.connection.status === 'ready'
            ? { status: 'ready', snapshot, interrupt }
            : { status: 'stale', snapshot, message: 'Project state is stale.' };
  const activityByExecutionId = useMemo(
    () => (snapshot ? activityProjection(snapshot, projection.activity) : {}),
    [projection.activity, snapshot],
  );

  useEffect(
    () => () => {
      activeCommand.current?.controller.abort();
      activeCommand.current = undefined;
      pending.current = undefined;
    },
    [],
  );

  const runCommand = useCallback(
    async (
      intent: string,
      envelope: V2CommandEnvelope,
      expectedType: V2CommandEnvelope['command']['type'],
    ) => {
      activeCommand.current?.controller.abort();
      if (pending.current && pending.current.intent !== intent) {
        pending.current = undefined;
      }
      const request =
        pending.current?.intent === intent
          ? pending.current.envelope
          : envelope;
      pending.current = { intent, envelope: request };
      const controller = new AbortController();
      const token = Symbol(expectedType);
      const developerCommand = developerCommandTypes.has(expectedType);
      activeCommand.current = { controller, token };
      setSubmitting(true);
      if (developerCommand) setDeveloperError(undefined);
      else setCommandError(undefined);
      try {
        const requestDomainCursor = projection.domainCursor;
        const result = await api.command(request, controller.signal);
        if (activeCommand.current?.token !== token) return;
        pending.current = undefined;
        if (!result.ok || result.commandType !== expectedType) {
          if (!result.ok && result.error.code === 'audit_barrier_tripped') {
            onAuditBarrier(result.error.message);
          }
          const message = result.ok
            ? 'Unexpected command result.'
            : result.error.message;
          if (developerCommand) setDeveloperError(message);
          else setCommandError(message);
          if (!result.ok && freshnessConflictCodes.has(result.error.code)) {
            dispatch({
              type: 'resync.required',
              reason: result.error.code,
            });
          }
        } else if (planningCommandTypes.has(expectedType)) {
          dispatch({
            type: 'planning.command_result',
            result,
            requestDomainCursor,
          });
        }
      } catch (cause) {
        if (activeCommand.current?.token !== token) return;
        if (cause instanceof V2HttpError) {
          pending.current = undefined;
          if (cause.code === 'audit_barrier_tripped') {
            onAuditBarrier(cause.message);
          }
          if (freshnessConflictCodes.has(cause.code)) {
            dispatch({ type: 'resync.required', reason: cause.code });
          }
        }
        if (developerCommand) setDeveloperError(errorMessage(cause));
        else setCommandError(errorMessage(cause));
      } finally {
        if (activeCommand.current?.token === token) {
          activeCommand.current = undefined;
          setSubmitting(false);
        }
      }
    },
    [api, dispatch, onAuditBarrier, projection.domainCursor],
  );

  const interruptExecution = useCallback(
    (execution: WorkerExecution) => {
      void runCommand(
        `worker_execution.interrupt:${execution.id}:${execution.revision}`,
        {
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'worker_execution.interrupt',
            projectId,
            executionId: execution.id,
            expectedRevision: execution.revision,
          },
        },
        'worker_execution.interrupt',
      );
    },
    [projectId, runCommand],
  );

  const submitPlanningTurn = useCallback(
    (
      message: string,
      profile?: { profileId: string; profileRevision: number },
    ) => {
      const cycle = activePlanningCycle(snapshot?.planningCycles);
      const command = profile
        ? {
            type: 'planning_cycle.submit_turn' as const,
            projectId,
            expectedCycleRevision: null,
            profileId: profile.profileId,
            profileRevision: profile.profileRevision,
            message,
          }
        : cycle
          ? {
              type: 'planning_cycle.submit_turn' as const,
              projectId,
              planningCycleId: cycle.cycle.id,
              expectedCycleRevision: cycle.cycle.revision,
              message,
            }
          : undefined;
      if (!command) {
        setCommandError('Select a project manager profile.');
        return;
      }
      void runCommand(
        `planning_cycle.submit_turn:${cycle?.cycle.id ?? 'new'}:${message}`,
        {
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command,
        },
        'planning_cycle.submit_turn',
      );
    },
    [projectId, runCommand, snapshot],
  );

  const approvePlanningProposal = useCallback(
    (proposalId: string) => {
      const cycle = activePlanningCycle(snapshot?.planningCycles);
      const proposal = cycle?.proposals.find(({ id }) => id === proposalId);
      if (!cycle || !proposal) return;
      void runCommand(
        `planning_proposal.approve:${proposal.id}:${proposal.revision}`,
        {
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'planning_proposal.approve',
            projectId,
            planningCycleId: cycle.cycle.id,
            proposalId: proposal.id,
            expectedCycleRevision: cycle.cycle.revision,
            expectedProposalRevision: proposal.revision,
            expectedProjectIntentRevision: proposal.baseProjectIntentRevision,
            expectedLedgerRevision: proposal.baseLedgerRevision,
          },
        },
        'planning_proposal.approve',
      );
    },
    [projectId, runCommand, snapshot],
  );

  const rejectPlanningProposal = useCallback(
    (proposalId: string, feedback: string) => {
      const cycle = activePlanningCycle(snapshot?.planningCycles);
      const proposal = cycle?.proposals.find(({ id }) => id === proposalId);
      if (!cycle || !proposal) return;
      void runCommand(
        `planning_proposal.reject:${proposal.id}:${proposal.revision}:${feedback}`,
        {
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'planning_proposal.reject',
            projectId,
            planningCycleId: cycle.cycle.id,
            proposalId: proposal.id,
            expectedCycleRevision: cycle.cycle.revision,
            expectedProposalRevision: proposal.revision,
            feedback,
          },
        },
        'planning_proposal.reject',
      );
    },
    [projectId, runCommand, snapshot],
  );

  const abandonPlanningCycle = useCallback(
    (planningCycleId: string) => {
      const cycle = activePlanningCycle(snapshot?.planningCycles);
      if (!cycle || cycle.cycle.id !== planningCycleId) return;
      void runCommand(
        `planning_cycle.abandon:${cycle.cycle.id}:${cycle.cycle.revision}`,
        {
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'planning_cycle.abandon',
            projectId,
            planningCycleId: cycle.cycle.id,
            expectedCycleRevision: cycle.cycle.revision,
          },
        },
        'planning_cycle.abandon',
      );
    },
    [projectId, runCommand, snapshot],
  );

  const runPlanningCommand = useCallback(
    (
      command:
        | SubmitPlanTurnCommand
        | ApprovePlanProposalCommand
        | RejectPlanProposalCommand
        | AbandonPlanningCycleCommand
        | SetBoardFilterCommand,
    ) => {
      if (command.projectId !== projectId) return;
      const envelope = {
        idempotencyKey: crypto.randomUUID(),
        actor: { kind: 'human' as const },
        command,
      } as V2CommandEnvelope;
      void runCommand(JSON.stringify(command), envelope, command.type);
    },
    [projectId, runCommand],
  );

  const startDeveloperAttempt = useCallback(
    (card: BoardTaskCard, profile: ResolvedWorkerProfileSnapshot) => {
      const plan = snapshot?.deliveryPlan?.plan;
      if (!plan) {
        setDeveloperError('A current approved delivery plan is required.');
        return;
      }
      const command = {
        type: 'developer_attempt.start' as const,
        projectId,
        taskId: card.taskId,
        expectedTaskRevision: card.taskCurrentRevision,
        expectedDeliveryPlanId: plan.id,
        expectedDeliveryPlanRevision: plan.revision,
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
      };
      void runCommand(
        JSON.stringify(command),
        {
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command,
        },
        command.type,
      );
    },
    [projectId, runCommand, snapshot],
  );

  const interruptDeveloperAttempt = useCallback(
    (attempt: DeveloperAttempt) => {
      const command = {
        type: 'developer_attempt.interrupt' as const,
        projectId,
        attemptId: attempt.id,
        expectedAttemptRevision: attempt.revision,
      };
      void runCommand(
        JSON.stringify(command),
        {
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command,
        },
        command.type,
      );
    },
    [projectId, runCommand],
  );

  const replaceDeveloperExecution = useCallback(
    (attempt: DeveloperAttempt) => {
      const command = {
        type: 'developer_attempt.replace_execution' as const,
        projectId,
        attemptId: attempt.id,
        expectedAttemptRevision: attempt.revision,
      };
      void runCommand(
        JSON.stringify(command),
        {
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command,
        },
        command.type,
      );
    },
    [projectId, runCommand],
  );

  return (
    <>
      {error || commandError ? (
        <p role="alert">{commandError ?? error}</p>
      ) : null}
      <FocusedProjectShell
        model={model}
        onDeselect={onDeselect}
        onInterrupt={interruptExecution}
        activityByExecutionId={activityByExecutionId}
        planning={{
          submitting,
          error: commandError,
          enabled: auditHealthy,
          disabledReason: 'Audit barrier is active.',
          onSubmitTurn: submitPlanningTurn,
          onApprove: approvePlanningProposal,
          onReject: rejectPlanningProposal,
          onAbandon: abandonPlanningCycle,
          onSubmitPlan: runPlanningCommand,
          onApprovePlan: runPlanningCommand,
          onRejectPlan: runPlanningCommand,
          onAbandonPlan: runPlanningCommand,
          onApplyFilter: runPlanningCommand,
        }}
        developer={{
          error: developerError,
          onStart: startDeveloperAttempt,
          onInterrupt: interruptDeveloperAttempt,
          onReplace: replaceDeveloperExecution,
        }}
      />
    </>
  );
}

export function App({
  api,
  socketFactory,
  location,
  history,
}: {
  api: V2Api;
  socketFactory: ProjectSocketFactory;
  location: AppLocation;
  history: AppHistory;
}) {
  const [pathname, setPathname] = useState(location.pathname);
  const [system, setSystem] = useState<SystemState>({ status: 'loading' });
  const [registrationError, setRegistrationError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<PendingCommand | undefined>(undefined);
  const activeCommand = useRef<ActiveCommand | undefined>(undefined);
  const routeGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .systemSnapshot(controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setSystem({ status: 'ready', snapshot });
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setSystem({
            status: cause instanceof TypeError ? 'disconnected' : 'error',
            message: errorMessage(cause),
          });
        }
      });
    return () => controller.abort();
  }, [api]);

  const takeRouteOwnership = useCallback((next: string) => {
    routeGeneration.current += 1;
    activeCommand.current?.controller.abort();
    activeCommand.current = undefined;
    pending.current = undefined;
    setSubmitting(false);
    setRegistrationError(undefined);
    setPathname(next);
  }, []);

  useEffect(() => {
    const popstate = () => takeRouteOwnership(location.pathname);
    location.addEventListener('popstate', popstate);
    return () => {
      location.removeEventListener('popstate', popstate);
      activeCommand.current?.controller.abort();
      activeCommand.current = undefined;
      pending.current = undefined;
    };
  }, [location, takeRouteOwnership]);

  const navigate = useCallback(
    (next: string) => {
      history.pushState(null, '', next);
      takeRouteOwnership(next);
    },
    [history, takeRouteOwnership],
  );
  const selectProject = useCallback(
    (projectId: string) =>
      navigate(`/projects/${encodeURIComponent(projectId)}`),
    [navigate],
  );
  const tripAuditBarrier = useCallback((message: string) => {
    setSystem((current) =>
      current.status === 'ready'
        ? {
            status: 'ready',
            snapshot: {
              ...current.snapshot,
              health: {
                status: 'audit_barrier_tripped',
                error: { code: 'audit_barrier_tripped', message },
              },
            },
          }
        : current,
    );
  }, []);

  const register = useCallback(
    async (repositoryPath: string) => {
      const intent = repositoryPath;
      activeCommand.current?.controller.abort();
      if (pending.current && pending.current.intent !== intent) {
        pending.current = undefined;
      }
      const envelope =
        pending.current?.intent === intent
          ? pending.current.envelope
          : {
              idempotencyKey: crypto.randomUUID(),
              actor: { kind: 'human' as const },
              command: { type: 'project.register' as const, repositoryPath },
            };
      pending.current = { intent, envelope };
      const owner = routeGeneration.current;
      const controller = new AbortController();
      const token = Symbol('project.register');
      activeCommand.current = { controller, token };
      setSubmitting(true);
      setRegistrationError(undefined);
      try {
        const result = await api.command(envelope, controller.signal);
        if (
          activeCommand.current?.token !== token ||
          routeGeneration.current !== owner
        ) {
          return;
        }
        pending.current = undefined;
        if (!result.ok || result.commandType !== 'project.register') {
          if (!result.ok && result.error.code === 'audit_barrier_tripped') {
            tripAuditBarrier(result.error.message);
          }
          setRegistrationError(
            result.ok ? 'Unexpected command result.' : result.error.message,
          );
          return;
        }
        setSystem((current) =>
          current.status === 'ready'
            ? {
                status: 'ready',
                snapshot: {
                  ...current.snapshot,
                  projects: [
                    ...current.snapshot.projects.filter(
                      ({ id }) => id !== result.project.id,
                    ),
                    result.project,
                  ],
                },
              }
            : current,
        );
        selectProject(result.project.id);
      } catch (cause) {
        if (
          activeCommand.current?.token !== token ||
          routeGeneration.current !== owner
        ) {
          return;
        }
        if (cause instanceof V2HttpError) {
          pending.current = undefined;
          if (cause.code === 'audit_barrier_tripped') {
            tripAuditBarrier(cause.message);
          }
        }
        setRegistrationError(errorMessage(cause));
      } finally {
        if (
          activeCommand.current?.token === token &&
          routeGeneration.current === owner
        ) {
          activeCommand.current = undefined;
          setSubmitting(false);
        }
      }
    },
    [api, selectProject, tripAuditBarrier],
  );

  const selector = (model: SelectorViewModel) => (
    <ProjectSelector
      model={model}
      onAddAndSelectProject={register}
      onSelectProject={selectProject}
      v1GuidanceHref="/guidance/v1-session-platform.md"
    />
  );

  if (system.status === 'loading') return selector({ status: 'loading' });
  if (system.status === 'disconnected') {
    return selector({ status: 'disconnected', message: system.message });
  }
  if (system.status === 'error') {
    return selector({
      status: 'error',
      message: system.message,
      registration: {
        enabled: false,
        disabledReason: 'Reload after the system snapshot is available.',
      },
    });
  }

  const registration = availability(
    !submitting && system.snapshot.health.status === 'ok',
    submitting
      ? 'Adding the project is in progress.'
      : 'Audit barrier is active.',
  );
  const selectorModel: SelectorViewModel = registrationError
    ? {
        status: 'error',
        snapshot: system.snapshot,
        message: registrationError,
        registration,
      }
    : {
        status: 'ready',
        snapshot: system.snapshot,
        submitting,
        registration,
      };
  if (pathname === '/') return selector(selectorModel);

  const projectId = routeProjectId(pathname);
  if (
    !projectId ||
    !system.snapshot.projects.some(({ id }) => id === projectId)
  ) {
    return selector({
      status: 'error',
      snapshot: system.snapshot,
      message: 'Unknown project URL.',
      registration,
    });
  }
  return (
    <ProjectConnection
      key={projectId}
      api={api}
      projectId={projectId}
      socketFactory={socketFactory}
      location={location}
      auditHealthy={system.snapshot.health.status === 'ok'}
      onAuditBarrier={tripAuditBarrier}
      onDeselect={() => navigate('/')}
    />
  );
}
