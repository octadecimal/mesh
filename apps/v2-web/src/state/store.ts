import {
  createInitialProjectProjection,
  reduceProjectProjection,
  type ProjectProjection,
  type ProjectionAction,
  type ProjectionDispatch,
} from './reducer';
import type { ProjectEventCursors } from '@mesh/v2-contracts';

export type V2Store = {
  getState(): ProjectProjection;
  getCursors(): ProjectEventCursors;
  dispatch: ProjectionDispatch;
  subscribe(listener: (state: ProjectProjection) => void): () => void;
};

export const createV2Store = (projectId: string): V2Store => {
  let state = createInitialProjectProjection(projectId);
  const listeners = new Set<(state: ProjectProjection) => void>();

  const dispatch = (action: ProjectionAction) => {
    const next = reduceProjectProjection(state, action);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(state);
  };

  return {
    getState: () => state,
    getCursors: () => ({
      domain: state.domainCursor,
      runtime: state.runtimeCursor,
    }),
    dispatch,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
