import type { MeshApi } from '../api/client';
import { type SessionEvent } from '@mesh-session-platform/contracts';

import { createMeshStore } from './store';

type MeshStore = ReturnType<typeof createMeshStore>;

export const createResyncCoordinator = (
  api: Pick<MeshApi, 'snapshot'>,
  store: MeshStore,
) => {
  let inFlight: Promise<void> | undefined;

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

  return {
    refresh,
    async applyEvent(event: SessionEvent) {
      const result = store.applyEvent(event);
      if (result.kind === 'gap') await refresh();
      return result;
    },
  };
};
