import type {
  DomainEvent,
  Project,
  ResolvedWorkerProfileSnapshot,
  RuntimeEvent,
  V2AttentionItem,
  V2ProjectSnapshot,
  WorkerExecution,
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
  activity: readonly RuntimeEvent[];
  domainCursor: number;
  runtimeCursor: number;
  connection: ProjectionConnection;
  resyncRequested: boolean;
  local: ProjectionLocalState;
};

export type ProjectionAction =
  | { type: 'snapshot.received'; snapshot: V2ProjectSnapshot }
  | { type: 'domain.event'; event: DomainEvent }
  | { type: 'runtime.event'; event: RuntimeEvent }
  | { type: 'connection.ready' }
  | { type: 'connection.disconnected' }
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
  activity: [],
  domainCursor: 0,
  runtimeCursor: 0,
  connection: { status: 'loading' },
  resyncRequested: false,
  local: { route: '', repositoryDraft: '', selectedTab: 'board' },
});

const stale = (state: ProjectProjection, reason: string): ProjectProjection => ({
  ...state,
  connection: { status: 'stale', reason },
  resyncRequested: true,
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

const applyDomainEvent = (
  state: ProjectProjection,
  event: DomainEvent,
): ProjectProjection => {
  switch (event.type) {
    case 'project.registered':
      return { ...state, project: event.payload.project };
    case 'worker_execution.lifecycle_changed':
      return {
        ...state,
        executions: replaceExecution(
          state.executions,
          event.payload.execution,
        ),
      };
    case 'worker_profile.revision_approved':
      return state;
  }
};

const reduceEvent = (
  state: ProjectProjection,
  stream: 'domain' | 'runtime',
  event: DomainEvent | RuntimeEvent,
): ProjectProjection => {
  if (event.projectId !== state.projectId) return stale(state, 'project_mismatch');

  const cursor = stream === 'domain' ? state.domainCursor : state.runtimeCursor;
  if (event.sequence === cursor) return state;
  if (event.sequence < cursor) return stale(state, `${stream}_stale`);
  if (event.sequence !== cursor + 1) return stale(state, `${stream}_gap`);

  if (stream === 'domain') {
    const projected = applyDomainEvent(state, event as DomainEvent);
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

export const reduceProjectProjection = (
  state: ProjectProjection,
  action: ProjectionAction,
): ProjectProjection => {
  switch (action.type) {
    case 'snapshot.received':
      if (action.snapshot.project.id !== state.projectId) {
        return stale(state, 'project_mismatch');
      }
      return {
        ...state,
        project: action.snapshot.project,
        profiles: action.snapshot.profiles,
        executions: action.snapshot.executions,
        attentionItems: action.snapshot.attentionItems,
        domainCursor: action.snapshot.cursors.domain,
        runtimeCursor: action.snapshot.cursors.runtime,
        connection: { status: 'ready' },
        resyncRequested: false,
      };
    case 'domain.event':
      if (state.resyncRequested) return state;
      return reduceEvent(state, 'domain', action.event);
    case 'runtime.event':
      if (state.resyncRequested) return state;
      return reduceEvent(state, 'runtime', action.event);
    case 'connection.ready':
      if (state.resyncRequested) return state;
      return { ...state, connection: { status: 'ready' } };
    case 'connection.disconnected':
      return { ...state, connection: { status: 'disconnected' } };
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
