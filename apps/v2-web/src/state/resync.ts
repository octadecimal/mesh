import { V2ResyncRequiredError, type V2Api } from '../api/client';
import type { ProjectionDispatch } from './reducer';

export type ResyncCoordinator = {
  request(projectId: string): Promise<void>;
  cancel(): void;
};

type ActiveRequest = {
  projectId: string;
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
};

const MAX_HYDRATION_ATTEMPTS = 3;

const hydrate = async (api: V2Api, projectId: string, signal: AbortSignal) => {
  for (let attempt = 0; attempt < MAX_HYDRATION_ATTEMPTS; attempt += 1) {
    if (signal.aborted) throw signal.reason;
    const snapshot = await api.projectSnapshot(projectId, signal);
    if (signal.aborted) throw signal.reason;
    try {
      const probe = await api.runtimeReplay(
        projectId,
        snapshot.cursors.runtime,
        signal,
      );
      const runtimeWindow = await api.runtimeReplay(
        projectId,
        probe.lowWater - 1,
        signal,
      );
      if (
        runtimeWindow.lowWater !== probe.lowWater ||
        runtimeWindow.highWater !== probe.highWater
      ) {
        continue;
      }
      return { snapshot, runtimeWindow };
    } catch (error) {
      if (!(error instanceof V2ResyncRequiredError)) throw error;
    }
  }
  throw new Error(
    `Runtime replay did not stabilize after ${MAX_HYDRATION_ATTEMPTS} attempts.`,
  );
};

export const createResyncCoordinator = (
  api: V2Api,
  dispatch: ProjectionDispatch,
): ResyncCoordinator => {
  let generation = 0;
  let active: ActiveRequest | undefined;

  const cancel = () => {
    generation += 1;
    active?.controller.abort();
    active = undefined;
  };

  return {
    request(projectId) {
      if (active?.projectId === projectId) return active.promise;
      cancel();
      const requestGeneration = generation;
      const controller = new AbortController();
      const promise = hydrate(api, projectId, controller.signal)
        .then(({ snapshot, runtimeWindow }) => {
          if (requestGeneration === generation) {
            dispatch({
              type: 'snapshot.runtime_replay_received',
              snapshot,
              runtimeWindow,
            });
          }
        })
        .catch((error: unknown) => {
          if (requestGeneration === generation) throw error;
        })
        .finally(() => {
          if (active?.generation === requestGeneration) active = undefined;
        });
      active = {
        projectId,
        generation: requestGeneration,
        controller,
        promise,
      };
      return promise;
    },
    cancel,
  };
};
