import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, V2ProjectSnapshot } from '@mesh/v2-contracts';

import type { V2Api } from '../api/client';

export type GlobalProjectSnapshotFailure = Readonly<{
  projectId: string;
  message: string;
}>;

export type GlobalProjectSnapshotState = Readonly<{
  status: 'idle' | 'loading' | 'ready';
  snapshots: readonly V2ProjectSnapshot[];
  failures: readonly GlobalProjectSnapshotFailure[];
  refreshing: boolean;
  refresh(): void;
}>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed.';

export function useGlobalProjectSnapshots({
  api,
  projects,
  enabled,
  pollIntervalMs,
}: {
  api: Pick<V2Api, 'projectSnapshot'>;
  projects: readonly Project[];
  enabled: boolean;
  pollIntervalMs: 0 | 5000;
}): GlobalProjectSnapshotState {
  const controller = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const projectIds = projects.map(({ id }) => id).join('\u0000');
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [state, setState] = useState<
    Omit<GlobalProjectSnapshotState, 'refresh'>
  >({
    status: 'idle',
    snapshots: [],
    failures: [],
    refreshing: false,
  });
  const refresh = useCallback(() => {
    if (!enabled) return;
    controller.current?.abort();
    const next = new AbortController();
    const token = ++generation.current;
    const targets = projectsRef.current;
    controller.current = next;
    setState((previous) => ({
      ...previous,
      status: previous.snapshots.length === 0 ? 'loading' : 'ready',
      failures: [],
      refreshing: true,
    }));
    void Promise.allSettled(
      targets.map(({ id }) => api.projectSnapshot(id, next.signal)),
    ).then((results) => {
      if (next.signal.aborted || generation.current !== token) return;
      const snapshots: V2ProjectSnapshot[] = [];
      const failures: GlobalProjectSnapshotFailure[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') snapshots.push(result.value);
        else
          failures.push({
            projectId: targets[index]!.id,
            message: errorMessage(result.reason),
          });
      }
      setState({
        status: 'ready',
        snapshots,
        failures,
        refreshing: false,
      });
    });
  }, [api, enabled, projectIds]);

  useEffect(() => {
    if (!enabled) {
      controller.current?.abort();
      controller.current = undefined;
      setState((previous) => ({
        ...previous,
        status: 'idle',
        refreshing: false,
      }));
      return;
    }
    if (pollIntervalMs === 0) {
      refresh();
      window.addEventListener('focus', refresh);
      return () => {
        window.removeEventListener('focus', refresh);
        controller.current?.abort();
        controller.current = undefined;
      };
    }

    let interval: number | undefined;
    const stopPolling = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
      controller.current?.abort();
      controller.current = undefined;
    };
    const pausePolling = () => {
      stopPolling();
      setState((previous) =>
        previous.refreshing ? { ...previous, refreshing: false } : previous,
      );
    };
    const syncPolling = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) {
        pausePolling();
        return;
      }
      if (interval !== undefined) return;
      refresh();
      interval = window.setInterval(refresh, pollIntervalMs);
    };
    document.addEventListener('visibilitychange', syncPolling);
    window.addEventListener('focus', syncPolling);
    window.addEventListener('blur', syncPolling);
    syncPolling();
    return () => {
      document.removeEventListener('visibilitychange', syncPolling);
      window.removeEventListener('focus', syncPolling);
      window.removeEventListener('blur', syncPolling);
      stopPolling();
    };
  }, [enabled, pollIntervalMs, refresh]);

  return { ...state, refresh };
}
