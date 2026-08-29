import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { V2Api } from '../api/client';
import {
  createV2Socket,
  type SocketOptions,
  type V2Socket,
} from '../api/socket';
import type { ProjectionAction } from '../state/reducer';
import { createResyncCoordinator } from '../state/resync';
import { createV2Store } from '../state/store';

export type ProjectSocketFactory = NonNullable<SocketOptions['socketFactory']>;

export type RealtimeLocation = {
  protocol: string;
  host: string;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Project connection failed.';

export function useProjectConnection({
  api,
  projectId,
  socketFactory,
  location,
}: {
  api: V2Api;
  projectId: string;
  socketFactory: ProjectSocketFactory;
  location: RealtimeLocation;
}) {
  const store = useMemo(() => createV2Store(projectId), [projectId]);
  const projection = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const [error, setError] = useState<string>();
  const [resyncing, setResyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let socket: V2Socket | undefined;
    const controller = new AbortController();
    const coordinator = createResyncCoordinator(api, store.dispatch);
    const dispatch = (action: ProjectionAction) => {
      const requested = store.getState().resyncRequested;
      store.dispatch(action);
      if (requested || !store.getState().resyncRequested) return;
      setResyncing(true);
      void coordinator
        .request(projectId)
        .then(() => {
          if (cancelled) return;
          setError(undefined);
          socket?.reconnect();
          setResyncing(false);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(message(cause));
          setResyncing(false);
        });
    };

    setError(undefined);
    setResyncing(false);
    void api
      .projectSnapshot(projectId, controller.signal)
      .then((snapshot) => {
        if (cancelled) return;
        store.dispatch({ type: 'snapshot.received', snapshot });
        socket = createV2Socket({
          url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v2/realtime`,
          projectId,
          cursors: snapshot.cursors,
          cursorSource: store,
          dispatch,
          socketFactory,
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(message(cause));
      });

    return () => {
      cancelled = true;
      controller.abort();
      coordinator.cancel();
      socket?.close();
    };
  }, [api, location.host, location.protocol, projectId, socketFactory, store]);

  return { projection, error, resyncing };
}
