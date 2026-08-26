import type { MeshApi } from '../api/client';
import {
  type ProjectEvent,
  type SessionEvent,
} from '@mesh-session-platform/contracts';

import { createMeshStore } from './store';

type MeshStore = ReturnType<typeof createMeshStore>;
type ResyncApi = Pick<MeshApi, 'snapshot'> &
  Partial<Pick<MeshApi, 'projectSnapshot'>>;

export const createResyncCoordinator = (api: ResyncApi, store: MeshStore) => {
  let inFlight: Promise<void> | undefined;
  const projectRefreshes = new Map<string, Promise<void>>();

  const refresh = () => {
    if (!inFlight) {
      inFlight = api
        .snapshot()
        .then((snapshot) => store.replaceSnapshot(snapshot))
        .finally(() => {
          inFlight = undefined;
        });
    }
    return inFlight;
  };

  const refreshProject = (projectId: string) => {
    if (!api.projectSnapshot)
      return Promise.reject(
        new Error('Mesh API does not support project snapshot refresh.'),
      );
    const active = projectRefreshes.get(projectId);
    if (active) return active;

    const request = api
      .projectSnapshot(projectId)
      .then((snapshot) => store.replaceProjectSnapshot(snapshot))
      .finally(() => {
        projectRefreshes.delete(projectId);
      });
    projectRefreshes.set(projectId, request);
    return request;
  };

  return {
    refresh,
    async applyEvent(event: SessionEvent) {
      const result = store.applyEvent(event);
      if (result.kind === 'gap') await refresh();
      return result;
    },
    refreshProject,
    async applyProjectEvent(event: ProjectEvent) {
      const result = store.applyProjectEvent(event);
      if (result.kind === 'gap') await refreshProject(event.projectId);
      return result;
    },
  };
};
