import { hookstate } from '@hookstate/core';
import type { SessionEvent, SessionSnapshot } from '@mesh-session-platform/contracts';

import {
  applyEvent,
  createProjection,
  diagnosticNotification,
  replaceSnapshot,
  type ConnectionHealth,
  type MeshProjection,
} from './reducer';

const currentProjection = (state: ReturnType<typeof hookstate<MeshProjection>>) =>
  state.get({ noproxy: true }) as unknown as MeshProjection;

export const createMeshStore = (snapshot: SessionSnapshot) => {
  const state = hookstate(createProjection(snapshot));

  return {
    state,
    applyEvent(event: SessionEvent) {
      const result = applyEvent(currentProjection(state), event);
      if (result.kind === 'applied') state.set(result.state);
      return result;
    },
    replaceSnapshot(next: SessionSnapshot) {
      state.set(replaceSnapshot(currentProjection(state), next));
    },
    setConnectionHealth(connectionHealth: ConnectionHealth) {
      state.connectionHealth.set(connectionHealth);
    },
    notifyInvalidPayload(message: string) {
      const current = currentProjection(state);
      state.notifications.set([...current.notifications, diagnosticNotification(message)]);
    },
    selectSession(sessionId: string | undefined) {
      const current = currentProjection(state);
      state.set({
        ...current,
        selectedSessionId: sessionId,
        unreadSessionIds: sessionId
          ? { ...current.unreadSessionIds, [sessionId]: false }
          : current.unreadSessionIds,
      });
    },
    setFilter(scope: string, value: string) {
      const current = currentProjection(state);
      state.set({ ...current, filters: { ...current.filters, [scope]: value } });
    },
  };
};
