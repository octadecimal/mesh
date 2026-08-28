import type { V2ProjectSnapshot } from '@mesh/v2-contracts';

import type { V2Api } from '../api/client';
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

const snapshot = (projectId: string, domain: number): V2ProjectSnapshot => ({
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
  cursors: { domain, runtime: 0 },
});

const apiWithProjectSnapshot = (
  projectSnapshot: V2Api['projectSnapshot'],
): V2Api => ({
  systemSnapshot: vi.fn(),
  projectSnapshot,
  command: vi.fn(),
});

describe('createResyncCoordinator', () => {
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
      type: 'snapshot.received',
      snapshot: snapshot(projectOne, 4),
    });
  });

  it('cancels the old request and ignores its stale completion', async () => {
    const firstRequest = deferred<V2ProjectSnapshot>();
    const secondRequest = deferred<V2ProjectSnapshot>();
    const signals: AbortSignal[] = [];
    const api = apiWithProjectSnapshot(
      vi
        .fn((_, signal) => {
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
          type: 'snapshot.received',
          snapshot: snapshot(projectTwo, 8),
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
