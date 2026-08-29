import type {
  RetainedRuntimeWindow,
  RuntimeEvent,
  V2ProjectSnapshot,
} from '@mesh/v2-contracts';

import { V2ResyncRequiredError, type V2Api } from '../api/client';
import { createResyncCoordinator } from './resync';

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
