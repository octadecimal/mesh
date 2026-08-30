import type {
  RetainedRuntimeWindow,
  RuntimeEvent,
  V2ProjectSnapshot,
} from '@mesh/v2-contracts';

import { V2ResyncRequiredError, type V2Api } from '../api/client';
import { createResyncCoordinator } from './resync';
import { createV2Store } from './store';

const projectOne = '00000000-0000-4000-8000-000000000001';
const projectTwo = '00000000-0000-4000-8000-000000000002';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const snapshot = (
  projectId: string,
  domain: number,
  runtime = 0,
): V2ProjectSnapshot => ({
  protocolVersion: 'mesh.v2/1',
  project: {
    id: projectId,
    displayName: projectId,
    repositoryIdentity: `repo-${projectId}`,
    repositoryPath: `C:\\${projectId}`,
    gitCommonDirectory: `C:\\${projectId}\\.git`,
    headCommit: 'a'.repeat(40),
    revision: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  },
  profiles: [],
  executions: [],
  attentionItems: [],
  planningCycles: [],
  planningHistoryTruncated: false,
  intentLedger: null,
  cursors: { domain, runtime },
});

const runtimeEvent = (projectId: string, sequence: number): RuntimeEvent => ({
  id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
  projectId,
  executionId: '00000000-0000-4000-8000-000000000010',
  diagnosticId: '00000000-0000-4000-8000-000000000011',
  sequence,
  adapterCursor: sequence,
  occurredAt: '2026-08-28T00:00:00.000Z',
  type: 'worker_execution.completed',
  payload: { outcome: 'completed' },
});

const retained = (
  projectId: string,
  lowWater: number,
  highWater: number,
  firstSequence: number,
): RetainedRuntimeWindow => ({
  lowWater,
  highWater,
  events: Array.from({ length: highWater - firstSequence + 1 }, (_, index) =>
    runtimeEvent(projectId, firstSequence + index),
  ),
});

const validProbe = retained(projectOne, 3, 6, 6);
const validFull = retained(projectOne, 3, 6, 3);
const recoveredProbe = retained(projectOne, 4, 6, 7);
const recoveredFull = retained(projectOne, 4, 6, 4);

const invalidReplayCases = [
  {
    stage: 'probe',
    defect: 'project mismatch',
    invalid: {
      ...validProbe,
      events: [{ ...runtimeEvent(projectOne, 6), projectId: projectTwo }],
    },
  },
  {
    stage: 'full',
    defect: 'project mismatch',
    invalid: {
      ...validFull,
      events: validFull.events.map((event) => ({
        ...event,
        projectId: projectTwo,
      })),
    },
  },
  {
    stage: 'probe',
    defect: 'noncontiguous sequences',
    invalid: { ...validProbe, events: [] },
  },
  {
    stage: 'full',
    defect: 'noncontiguous sequences',
    invalid: { ...validFull, events: validFull.events.slice(1) },
  },
] satisfies ReadonlyArray<{
  stage: 'probe' | 'full';
  defect: string;
  invalid: RetainedRuntimeWindow;
}>;

const apiWithProjectSnapshot = (
  projectSnapshot: V2Api['projectSnapshot'],
  runtimeReplay: V2Api['runtimeReplay'] = vi.fn(async () => ({
    lowWater: 1,
    highWater: 0,
    events: [],
  })),
): V2Api => ({
  systemSnapshot: vi.fn(),
  projectSnapshot,
  runtimeReplay,
  command: vi.fn(),
});

describe('createResyncCoordinator', () => {
  it('hydrates with a snapshot probe and complete retained runtime window', async () => {
    const project = snapshot(projectOne, 4, 5);
    const probe = retained(projectOne, 3, 6, 6);
    const full = retained(projectOne, 3, 6, 3);
    const runtimeReplay = vi
      .fn<V2Api['runtimeReplay']>()
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce(full);
    const api = apiWithProjectSnapshot(
      vi.fn(async () => project),
      runtimeReplay,
    );
    const dispatch = vi.fn();

    await createResyncCoordinator(api, dispatch).request(projectOne);

    expect(runtimeReplay.mock.calls.map(([id, after]) => [id, after])).toEqual([
      [projectOne, 5],
      [projectOne, 2],
    ]);
    expect(runtimeReplay.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(runtimeReplay.mock.calls[1]?.[2]).toBe(
      runtimeReplay.mock.calls[0]?.[2],
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'snapshot.runtime_replay_received',
      snapshot: project,
      runtimeWindow: full,
    });
  });

  it.each(['probe', 'full'] as const)(
    'restarts from a fresh snapshot when the %s replay has a retained gap',
    async (stage) => {
      const firstSnapshot = snapshot(projectOne, 2, 5);
      const freshSnapshot = snapshot(projectOne, 3, 6);
      const firstProbe = retained(projectOne, 3, 6, 6);
      const freshProbe = retained(projectOne, 3, 6, 7);
      const full = retained(projectOne, 3, 6, 3);
      const gap = new V2ResyncRequiredError(projectOne, 'retained_gap');
      const runtimeReplay = vi.fn<V2Api['runtimeReplay']>();
      if (stage === 'probe') {
        runtimeReplay
          .mockRejectedValueOnce(gap)
          .mockResolvedValueOnce(freshProbe)
          .mockResolvedValueOnce(full);
      } else {
        runtimeReplay
          .mockResolvedValueOnce(firstProbe)
          .mockRejectedValueOnce(gap)
          .mockResolvedValueOnce(freshProbe)
          .mockResolvedValueOnce(full);
      }
      const api = apiWithProjectSnapshot(
        vi
          .fn<V2Api['projectSnapshot']>()
          .mockResolvedValueOnce(firstSnapshot)
          .mockResolvedValueOnce(freshSnapshot),
        runtimeReplay,
      );
      const dispatch = vi.fn();

      await createResyncCoordinator(api, dispatch).request(projectOne);

      expect(api.projectSnapshot).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith({
        type: 'snapshot.runtime_replay_received',
        snapshot: freshSnapshot,
        runtimeWindow: full,
      });
    },
  );

  it.each([
    ['low-water', retained(projectOne, 4, 6, 4)],
    ['high-water', retained(projectOne, 3, 7, 3)],
  ] as const)(
    'restarts when the retained %s moves between probe and full replay',
    async (_water, movedWindow) => {
      const firstSnapshot = snapshot(projectOne, 2, 5);
      const freshSnapshot = snapshot(projectOne, 3, 6);
      const runtimeReplay = vi
        .fn<V2Api['runtimeReplay']>()
        .mockResolvedValueOnce(retained(projectOne, 3, 6, 6))
        .mockResolvedValueOnce(movedWindow)
        .mockResolvedValueOnce(retained(projectOne, 4, 6, 7))
        .mockResolvedValueOnce(retained(projectOne, 4, 6, 4));
      const api = apiWithProjectSnapshot(
        vi
          .fn<V2Api['projectSnapshot']>()
          .mockResolvedValueOnce(firstSnapshot)
          .mockResolvedValueOnce(freshSnapshot),
        runtimeReplay,
      );
      const dispatch = vi.fn();

      await createResyncCoordinator(api, dispatch).request(projectOne);

      expect(api.projectSnapshot).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );

  it.each(invalidReplayCases)(
    'restarts after a $stage window $defect and dispatches only recovered state',
    async ({ stage, invalid }) => {
      let snapshotRequests = 0;
      const firstSnapshot = snapshot(projectOne, 2, 5);
      const freshSnapshot = snapshot(projectOne, 3, 6);
      const api = apiWithProjectSnapshot(
        vi.fn(async () =>
          snapshotRequests++ === 0 ? firstSnapshot : freshSnapshot,
        ),
        vi.fn(async (_projectId, after) => {
          if (snapshotRequests === 1) {
            if (stage === 'probe' || after === 2) return invalid;
            return validProbe;
          }
          return after === 6 ? recoveredProbe : recoveredFull;
        }),
      );
      const dispatch = vi.fn();

      await createResyncCoordinator(api, dispatch).request(projectOne);

      expect(api.projectSnapshot).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith({
        type: 'snapshot.runtime_replay_received',
        snapshot: freshSnapshot,
        runtimeWindow: recoveredFull,
      });
    },
  );

  it.each(invalidReplayCases)(
    'rejects after three $stage window $defect cycles without making the store stale',
    async ({ stage, invalid }) => {
      const store = createV2Store(projectOne);
      const dispatch = vi.fn(store.dispatch);
      const api = apiWithProjectSnapshot(
        vi.fn(async () => snapshot(projectOne, 2, 5)),
        vi.fn(async (_projectId, after) => {
          if (stage === 'probe' || after === 2) return invalid;
          return validProbe;
        }),
      );

      await expect(
        createResyncCoordinator(api, dispatch).request(projectOne),
      ).rejects.toThrow('Runtime replay did not stabilize after 3 attempts.');

      expect(api.projectSnapshot).toHaveBeenCalledTimes(3);
      expect(dispatch).not.toHaveBeenCalled();
      expect(store.getState().connection).toEqual({ status: 'loading' });
      expect(store.getCursors()).toEqual({ domain: 0, runtime: 0 });
    },
  );

  it('retries a snapshot project mismatch before requesting replay', async () => {
    let snapshotRequests = 0;
    const freshSnapshot = snapshot(projectOne, 3, 6);
    const runtimeReplay = vi.fn(async (_projectId, after) =>
      after === 6 ? recoveredProbe : recoveredFull,
    );
    const api = apiWithProjectSnapshot(
      vi.fn(async () =>
        snapshotRequests++ === 0 ? snapshot(projectTwo, 2, 5) : freshSnapshot,
      ),
      runtimeReplay,
    );
    const dispatch = vi.fn();

    await createResyncCoordinator(api, dispatch).request(projectOne);

    expect(api.projectSnapshot).toHaveBeenCalledTimes(2);
    expect(runtimeReplay).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'snapshot.runtime_replay_received',
      snapshot: freshSnapshot,
      runtimeWindow: recoveredFull,
    });
  });

  it('rejects repeated snapshot project mismatches without dispatch', async () => {
    const store = createV2Store(projectOne);
    const dispatch = vi.fn(store.dispatch);
    const api = apiWithProjectSnapshot(
      vi.fn(async () => snapshot(projectTwo, 2, 5)),
    );

    await expect(
      createResyncCoordinator(api, dispatch).request(projectOne),
    ).rejects.toThrow('Runtime replay did not stabilize after 3 attempts.');

    expect(api.projectSnapshot).toHaveBeenCalledTimes(3);
    expect(api.runtimeReplay).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getState().connection).toEqual({ status: 'loading' });
  });

  it('retries a probe whose requested cursor is above its high-water', async () => {
    let snapshotRequests = 0;
    const freshSnapshot = snapshot(projectOne, 3, 6);
    const cursorIncoherentProbe: RetainedRuntimeWindow = {
      lowWater: 3,
      highWater: 4,
      events: [],
    };
    const matchingFull = retained(projectOne, 3, 4, 3);
    const api = apiWithProjectSnapshot(
      vi.fn(async () =>
        snapshotRequests++ === 0 ? snapshot(projectOne, 2, 5) : freshSnapshot,
      ),
      vi.fn(async (_projectId, after) => {
        if (snapshotRequests === 1) {
          return after === 5 ? cursorIncoherentProbe : matchingFull;
        }
        return after === 6 ? recoveredProbe : recoveredFull;
      }),
    );
    const dispatch = vi.fn();

    await createResyncCoordinator(api, dispatch).request(projectOne);

    expect(api.projectSnapshot).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'snapshot.runtime_replay_received',
      snapshot: freshSnapshot,
      runtimeWindow: recoveredFull,
    });
  });

  it('rejects visibly after three unstable hydration attempts', async () => {
    const api = apiWithProjectSnapshot(
      vi.fn(async () => snapshot(projectOne, 2, 5)),
      vi.fn(async () => {
        throw new V2ResyncRequiredError(projectOne, 'retained_gap');
      }),
    );
    const dispatch = vi.fn();

    await expect(
      createResyncCoordinator(api, dispatch).request(projectOne),
    ).rejects.toThrow('Runtime replay did not stabilize after 3 attempts.');
    expect(api.projectSnapshot).toHaveBeenCalledTimes(3);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('shares one in-flight refresh for the same project', async () => {
    const request = deferred<V2ProjectSnapshot>();
    const api = apiWithProjectSnapshot(vi.fn(() => request.promise));
    const dispatch = vi.fn();
    const coordinator = createResyncCoordinator(api, dispatch);

    const first = coordinator.request(projectOne);
    const second = coordinator.request(projectOne);
    expect(second).toBe(first);
    expect(api.projectSnapshot).toHaveBeenCalledOnce();

    request.resolve(snapshot(projectOne, 4));
    await first;
    expect(dispatch).toHaveBeenCalledWith({
      type: 'snapshot.runtime_replay_received',
      snapshot: snapshot(projectOne, 4),
      runtimeWindow: { lowWater: 1, highWater: 0, events: [] },
    });
  });

  it('cancels the old request and ignores its stale completion', async () => {
    const firstRequest = deferred<V2ProjectSnapshot>();
    const secondRequest = deferred<V2ProjectSnapshot>();
    const signals: AbortSignal[] = [];
    const api = apiWithProjectSnapshot(
      vi.fn((_, signal) => {
        if (signal) signals.push(signal);
        return signals.length === 1
          ? firstRequest.promise
          : secondRequest.promise;
      }),
    );
    const dispatch = vi.fn();
    const coordinator = createResyncCoordinator(api, dispatch);

    const first = coordinator.request(projectOne);
    const second = coordinator.request(projectTwo);
    expect(signals[0]?.aborted).toBe(true);

    firstRequest.resolve(snapshot(projectOne, 2));
    secondRequest.resolve(snapshot(projectTwo, 8));
    await Promise.all([first, second]);

    expect(dispatch.mock.calls).toEqual([
      [
        {
          type: 'snapshot.runtime_replay_received',
          snapshot: snapshot(projectTwo, 8),
          runtimeWindow: { lowWater: 1, highWater: 0, events: [] },
        },
      ],
    ]);
  });

  it('cancel prevents a late snapshot from replacing state', async () => {
    const request = deferred<V2ProjectSnapshot>();
    const api = apiWithProjectSnapshot(vi.fn(() => request.promise));
    const dispatch = vi.fn();
    const coordinator = createResyncCoordinator(api, dispatch);

    const pending = coordinator.request(projectOne);
    coordinator.cancel();
    request.resolve(snapshot(projectOne, 3));
    await pending;

    expect(dispatch).not.toHaveBeenCalled();
  });
});
