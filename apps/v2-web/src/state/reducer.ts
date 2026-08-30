import type {
  DomainEvent,
  ApprovedIntentLedger,
  PlanningCycleView,
  Project,
  RetainedRuntimeWindow,
  ResolvedWorkerProfileSnapshot,
  RuntimeEvent,
  V2AttentionItem,
  V2ProjectSnapshot,
  WorkerExecution,
} from '@mesh/v2-contracts';
import {
  approvedPlanningOutcomeSchema,
  planningCycleViewSchema,
  resolvedWorkerProfileSnapshotSchema,
  v2AttentionItemSchema,
  workerProfileSpecSchema,
} from '@mesh/v2-contracts';

export type ProjectionConnection =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'disconnected' }
  | { status: 'stale'; reason: string };

export type ProjectionLocalState = {
  route: string;
  repositoryDraft: string;
  selectedTab: 'board' | 'requirements';
};

export type ProjectProjection = {
  projectId: string;
  project?: Project;
  profiles: readonly ResolvedWorkerProfileSnapshot[];
  executions: readonly WorkerExecution[];
  attentionItems: readonly V2AttentionItem[];
  planningCycles: readonly PlanningCycleView[];
  planningHistoryTruncated: boolean;
  intentLedger: ApprovedIntentLedger | null;
  activity: readonly RuntimeEvent[];
  domainCursor: number;
  runtimeCursor: number;
  connection: ProjectionConnection;
  transport: 'connecting' | 'subscribed' | 'disconnected';
  snapshotReady: boolean;
  resyncRequested: boolean;
  resyncReason: string | undefined;
  local: ProjectionLocalState;
};

export type ProjectionAction =
  | { type: 'snapshot.received'; snapshot: V2ProjectSnapshot }
  | {
      type: 'snapshot.runtime_replay_received';
      snapshot: V2ProjectSnapshot;
      runtimeWindow: RetainedRuntimeWindow;
    }
  | { type: 'domain.event'; event: DomainEvent }
  | { type: 'runtime.event'; event: RuntimeEvent }
  | { type: 'transport.subscribed' }
  | { type: 'transport.disconnected' }
  | { type: 'resync.required'; reason: string }
  | { type: 'local.route_changed'; route: string }
  | { type: 'local.repository_draft_changed'; draft: string }
  | { type: 'local.tab_changed'; tab: ProjectionLocalState['selectedTab'] };

export type ProjectionDispatch = (action: ProjectionAction) => void;

export const createInitialProjectProjection = (
  projectId: string,
): ProjectProjection => ({
  projectId,
  profiles: [],
  executions: [],
  attentionItems: [],
  planningCycles: [],
  planningHistoryTruncated: false,
  intentLedger: null,
  activity: [],
  domainCursor: 0,
  runtimeCursor: 0,
  connection: { status: 'loading' },
  transport: 'connecting',
  snapshotReady: false,
  resyncRequested: false,
  resyncReason: undefined,
  local: { route: '', repositoryDraft: '', selectedTab: 'board' },
});

const stale = (
  state: ProjectProjection,
  reason: string,
): ProjectProjection => ({
  ...state,
  connection: { status: 'stale', reason },
  resyncRequested: true,
  resyncReason: reason,
});

const replaceExecution = (
  executions: readonly WorkerExecution[],
  next: WorkerExecution,
) => {
  const index = executions.findIndex(({ id }) => id === next.id);
  if (index < 0) return [...executions, next];
  return executions.map((execution, position) =>
    position === index ? next : execution,
  );
};

const replaceProfile = (
  profiles: readonly ResolvedWorkerProfileSnapshot[],
  next: ResolvedWorkerProfileSnapshot,
) => {
  const index = profiles.findIndex(
    ({ profileId }) => profileId === next.profileId,
  );
  if (index < 0) return [...profiles, next];
  return profiles.map((profile, position) =>
    position === index ? next : profile,
  );
};

const terminalPlanningLifecycles = new Set([
  'approved',
  'proposal_rejected',
  'abandoned',
]);

const descendingCodeUnits = (left: string, right: string) =>
  left === right ? 0 : left > right ? -1 : 1;

const comparePlanningCycles = (
  left: PlanningCycleView,
  right: PlanningCycleView,
) => {
  const leftTerminal = terminalPlanningLifecycles.has(left.cycle.lifecycle);
  const rightTerminal = terminalPlanningLifecycles.has(right.cycle.lifecycle);
  if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
  return (
    descendingCodeUnits(left.cycle.updatedAt, right.cycle.updatedAt) ||
    descendingCodeUnits(left.cycle.id, right.cycle.id)
  );
};

const replacePlanningCycle = (
  cycles: readonly PlanningCycleView[],
  next: PlanningCycleView,
  historyTruncated: boolean,
) => {
  const candidates = [
    next,
    ...cycles.filter(({ cycle }) => cycle.id !== next.cycle.id),
  ];
  const ordered = candidates.sort(comparePlanningCycles);
  return {
    planningCycles: ordered.slice(0, 20),
    planningHistoryTruncated: historyTruncated || ordered.length > 20,
  };
};

const projectApprovedProfile = (
  event: Extract<DomainEvent, { type: 'worker_profile.revision_approved' }>,
) => {
  const revision = event.payload.profileRevision;
  if (
    revision.scope !== 'project' ||
    revision.projectId === null ||
    revision.document.extends !== undefined ||
    revision.baseProfileId !== null ||
    revision.baseRevision !== null
  ) {
    return undefined;
  }
  const spec = workerProfileSpecSchema.safeParse(revision.document.spec);
  if (!spec.success) return undefined;
  const resolved = resolvedWorkerProfileSnapshotSchema.safeParse({
    profileId: revision.profileId,
    projectId: revision.projectId,
    profileRevision: revision.revision,
    baseProfileId: null,
    baseRevision: null,
    document: {
      apiVersion: revision.document.apiVersion,
      kind: revision.document.kind,
      metadata: revision.document.metadata,
      spec: spec.data,
    },
    digest: revision.digest,
  });
  return resolved.success ? resolved.data : undefined;
};

const replaceAttention = (
  attentionItems: readonly V2AttentionItem[],
  execution: WorkerExecution,
) => {
  const others = attentionItems.filter(
    ({ executionId }) => executionId !== execution.id,
  );
  if (execution.failure === null) return others;
  return [
    ...others,
    v2AttentionItemSchema.parse({
      executionId: execution.id,
      code: execution.failure.code,
      message: execution.failure.message,
    }),
  ];
};

const hasCompleteAttentionProjection = (execution: WorkerExecution) => {
  const needsAttention =
    execution.lifecycle === 'attention_required' ||
    execution.lifecycle === 'failed';
  return needsAttention === (execution.failure !== null);
};

const applyDomainEvent = (
  state: ProjectProjection,
  event: DomainEvent,
): ProjectProjection | undefined => {
  switch (event.type) {
    case 'project.registered':
      return { ...state, project: event.payload.project };
    case 'worker_execution.lifecycle_changed':
      return {
        ...state,
        executions: replaceExecution(state.executions, event.payload.execution),
        attentionItems: replaceAttention(
          state.attentionItems,
          event.payload.execution,
        ),
      };
    case 'worker_profile.revision_approved': {
      const profile = projectApprovedProfile(event);
      return profile
        ? { ...state, profiles: replaceProfile(state.profiles, profile) }
        : undefined;
    }
    case 'planning_cycle.changed': {
      const planningCycle = planningCycleViewSchema.safeParse(
        event.payload.planningCycle,
      );
      return planningCycle.success
        ? {
            ...state,
            ...replacePlanningCycle(
              state.planningCycles,
              planningCycle.data,
              state.planningHistoryTruncated,
            ),
          }
        : undefined;
    }
    case 'intent_ledger.approved': {
      const outcome = approvedPlanningOutcomeSchema.safeParse(event.payload);
      return outcome.success
        ? {
            ...state,
            ...replacePlanningCycle(
              state.planningCycles,
              outcome.data.planningCycle,
              state.planningHistoryTruncated,
            ),
            intentLedger: outcome.data.intentLedger,
          }
        : undefined;
    }
  }
};

const reduceEvent = (
  state: ProjectProjection,
  stream: 'domain' | 'runtime',
  event: DomainEvent | RuntimeEvent,
): ProjectProjection => {
  if (event.projectId !== state.projectId)
    return stale(state, 'project_mismatch');

  const cursor = stream === 'domain' ? state.domainCursor : state.runtimeCursor;
  if (event.sequence === cursor) return state;
  if (event.sequence < cursor) return stale(state, `${stream}_stale`);
  if (event.sequence !== cursor + 1) return stale(state, `${stream}_gap`);

  if (stream === 'domain') {
    const domainEvent = event as DomainEvent;
    if (
      domainEvent.type === 'worker_execution.lifecycle_changed' &&
      !hasCompleteAttentionProjection(domainEvent.payload.execution)
    ) {
      return stale(state, 'attention_projection_incomplete');
    }
    const projected = applyDomainEvent(state, domainEvent);
    if (!projected) {
      return stale(
        state,
        domainEvent.type === 'planning_cycle.changed' ||
          domainEvent.type === 'intent_ledger.approved'
          ? 'planning_projection_incomplete'
          : 'profile_projection_incomplete',
      );
    }
    return {
      ...projected,
      domainCursor: event.sequence,
    };
  }
  return {
    ...state,
    runtimeCursor: event.sequence,
    activity: [...state.activity, event as RuntimeEvent],
  };
};

const replaceSnapshot = (
  state: ProjectProjection,
  snapshot: V2ProjectSnapshot,
  runtimeCursor: number,
  activity: readonly RuntimeEvent[],
): ProjectProjection => ({
  ...state,
  project: snapshot.project,
  profiles: snapshot.profiles,
  executions: snapshot.executions,
  attentionItems: snapshot.attentionItems,
  planningCycles: snapshot.planningCycles,
  planningHistoryTruncated: snapshot.planningHistoryTruncated,
  intentLedger: snapshot.intentLedger,
  activity,
  domainCursor: snapshot.cursors.domain,
  runtimeCursor,
  connection:
    state.transport === 'subscribed'
      ? { status: 'ready' }
      : state.transport === 'disconnected'
        ? { status: 'disconnected' }
        : { status: 'loading' },
  snapshotReady: true,
  resyncRequested: false,
  resyncReason: undefined,
});

const runtimeWindowError = (
  projectId: string,
  snapshotCursor: number,
  window: RetainedRuntimeWindow,
) => {
  if (window.events.some((event) => event.projectId !== projectId)) {
    return 'project_mismatch';
  }
  const expectedLength = window.highWater - window.lowWater + 1;
  if (
    expectedLength < 0 ||
    window.events.length !== expectedLength ||
    window.events.some(
      (event, index) => event.sequence !== window.lowWater + index,
    )
  ) {
    return 'runtime_window_non_contiguous';
  }
  if (
    snapshotCursor < window.lowWater - 1 ||
    snapshotCursor > window.highWater
  ) {
    return 'runtime_window_cursor_incoherent';
  }
  return undefined;
};

export const reduceProjectProjection = (
  state: ProjectProjection,
  action: ProjectionAction,
): ProjectProjection => {
  switch (action.type) {
    case 'snapshot.received':
      if (action.snapshot.project.id !== state.projectId) {
        return stale(state, 'project_mismatch');
      }
      return replaceSnapshot(
        state,
        action.snapshot,
        action.snapshot.cursors.runtime,
        state.activity,
      );
    case 'snapshot.runtime_replay_received': {
      if (action.snapshot.project.id !== state.projectId) {
        return stale(state, 'project_mismatch');
      }
      const error = runtimeWindowError(
        state.projectId,
        action.snapshot.cursors.runtime,
        action.runtimeWindow,
      );
      if (error) return stale(state, error);
      return replaceSnapshot(
        state,
        action.snapshot,
        action.runtimeWindow.highWater,
        action.runtimeWindow.events,
      );
    }
    case 'domain.event':
      if (state.resyncRequested) return state;
      return reduceEvent(state, 'domain', action.event);
    case 'runtime.event':
      if (state.resyncRequested) return state;
      return reduceEvent(state, 'runtime', action.event);
    case 'transport.subscribed':
      return {
        ...state,
        transport: 'subscribed',
        connection: state.resyncRequested
          ? {
              status: 'stale',
              reason: state.resyncReason ?? 'resync_required',
            }
          : state.snapshotReady
            ? { status: 'ready' }
            : { status: 'loading' },
      };
    case 'transport.disconnected':
      return {
        ...state,
        transport: 'disconnected',
        connection: { status: 'disconnected' },
      };
    case 'resync.required':
      return stale(state, action.reason);
    case 'local.route_changed':
      return { ...state, local: { ...state.local, route: action.route } };
    case 'local.repository_draft_changed':
      return {
        ...state,
        local: { ...state.local, repositoryDraft: action.draft },
      };
    case 'local.tab_changed':
      return {
        ...state,
        local: { ...state.local, selectedTab: action.tab },
      };
  }
};
