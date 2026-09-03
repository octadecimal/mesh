import { act, renderHook, waitFor } from '@testing-library/react';
import type { Project, V2ProjectSnapshot } from '@mesh/v2-contracts';
import { afterEach, expect, it, vi } from 'vitest';

import type { V2Api } from '../api/client';
import { projectFixture, projectSnapshotFixture } from '../test/project-snapshot-fixture';
import { useGlobalProjectSnapshots } from './use-global-project-snapshots';

const alpha = projectFixture as Project;
const beta = { ...alpha, id: '22222222-2222-4222-8222-222222222222' } as Project;
const alphaSnapshot = projectSnapshotFixture as V2ProjectSnapshot;
const betaSnapshot = {
  ...alphaSnapshot,
  project: beta,
} as V2ProjectSnapshot;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

afterEach(() => vi.useRealTimers());

it('loads partial snapshots, polls, and cancels when disabled', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const api = {
    projectSnapshot: vi.fn((projectId: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return projectId === alpha.id
        ? Promise.resolve(alphaSnapshot)
        : Promise.reject(new Error('Project unavailable.'));
    }),
  } satisfies Pick<V2Api, 'projectSnapshot'>;
  const { result, rerender, unmount } = renderHook(
    ({ enabled, pollIntervalMs }) =>
      useGlobalProjectSnapshots({
        api,
        projects: [alpha, beta],
        enabled,
        pollIntervalMs,
      }),
    { initialProps: { enabled: true, pollIntervalMs: 5_000 as const } },
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(result.current.status).toBe('ready');
  expect(result.current.snapshots).toEqual([alphaSnapshot]);
  expect(result.current.failures).toEqual([
    { projectId: beta.id, message: 'Project unavailable.' },
  ]);

  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(api.projectSnapshot).toHaveBeenCalledTimes(4);

  rerender({ enabled: false, pollIntervalMs: 5_000 });
  expect(signals.at(-1)?.aborted).toBe(true);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps successful snapshots visible while a manual refresh settles', async () => {
  const next = deferred<V2ProjectSnapshot>();
  let calls = 0;
  const api = {
    projectSnapshot: vi.fn(() =>
      calls++ === 0 ? Promise.resolve(alphaSnapshot) : next.promise,
    ),
  } satisfies Pick<V2Api, 'projectSnapshot'>;
  const { result } = renderHook(() =>
    useGlobalProjectSnapshots({
      api,
      projects: [alpha],
      enabled: true,
      pollIntervalMs: 0,
    }),
  );

  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(api.projectSnapshot).toHaveBeenCalledOnce();
  act(() => result.current.refresh());
  expect(result.current).toMatchObject({
    snapshots: [alphaSnapshot],
    refreshing: true,
  });

  act(() => next.resolve(betaSnapshot));
  await waitFor(() => expect(result.current.refreshing).toBe(false));
  expect(result.current.snapshots).toEqual([betaSnapshot]);
});

it('refreshes on focus instead of polling when the interval is zero', async () => {
  const api = {
    projectSnapshot: vi.fn(async () => alphaSnapshot),
  } satisfies Pick<V2Api, 'projectSnapshot'>;
  const { result } = renderHook(() =>
    useGlobalProjectSnapshots({
      api,
      projects: [alpha],
      enabled: true,
      pollIntervalMs: 0,
    }),
  );

  await waitFor(() => expect(result.current.status).toBe('ready'));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
  });
  expect(api.projectSnapshot).toHaveBeenCalledTimes(2);
  vi.useFakeTimers();
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(api.projectSnapshot).toHaveBeenCalledTimes(2);
});

it('aborts a previous generation before starting the next one', async () => {
  let inFlight = 0;
  let maximumInFlight = 0;
  const api = {
    projectSnapshot: vi.fn((_: string, signal?: AbortSignal) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      signal?.addEventListener(
        'abort',
        () => {
          inFlight -= 1;
        },
        { once: true },
      );
      return new Promise<V2ProjectSnapshot>(() => undefined);
    }),
  } satisfies Pick<V2Api, 'projectSnapshot'>;
  const { result } = renderHook(() =>
    useGlobalProjectSnapshots({
      api,
      projects: [alpha],
      enabled: true,
      pollIntervalMs: 0,
    }),
  );

  act(() => result.current.refresh());
  expect(maximumInFlight).toBe(1);
});

it('cancels outstanding requests on unmount', () => {
  const signals: AbortSignal[] = [];
  const api = {
    projectSnapshot: vi.fn((_: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<V2ProjectSnapshot>(() => undefined);
    }),
  } satisfies Pick<V2Api, 'projectSnapshot'>;
  const { unmount } = renderHook(() =>
    useGlobalProjectSnapshots({
      api,
      projects: [alpha],
      enabled: true,
      pollIntervalMs: 0,
    }),
  );

  unmount();
  expect(signals[0]?.aborted).toBe(true);
});
