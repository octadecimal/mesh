import type { V2Api } from '../api/client';
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
      const promise = api
        .projectSnapshot(projectId, controller.signal)
        .then((snapshot) => {
          if (requestGeneration === generation) {
            dispatch({ type: 'snapshot.received', snapshot });
          }
        })
        .catch((error: unknown) => {
          if (requestGeneration === generation) throw error;
        })
        .finally(() => {
          if (active?.generation === requestGeneration) active = undefined;
        });
      active = { projectId, generation: requestGeneration, controller, promise };
      return promise;
    },
    cancel,
  };
};
