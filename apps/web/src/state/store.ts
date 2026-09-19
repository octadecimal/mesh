import { hookstate } from '@hookstate/core';
import type {
  ProjectEvent,
  ProjectSnapshot,
  SessionEvent,
  SessionSnapshot,
} from '@mesh-session-platform/contracts';

import {
  applyEvent,
  applyProjectEvent,
  createProjection,
  diagnosticNotification,
  replaceSnapshot,
  replaceProjectSnapshot,
  type ConnectionHealth,
  type MeshProjection,
} from './reducer';

const currentProjection = (
  state: ReturnType<typeof hookstate<MeshProjection>>,
) => state.get({ noproxy: true }) as unknown as MeshProjection;

export const createMeshStore = (snapshot: SessionSnapshot) => {
  const state = hookstate(createProjection(snapshot));

  return {
    state,
    applyEvent(event: SessionEvent) {
      const result = applyEvent(currentProjection(state), event);
      if (result.kind === 'applied') state.set(result.state);
      return result;
    },
    applyProjectEvent(event: ProjectEvent) {
      const result = applyProjectEvent(currentProjection(state), event);
      if (result.kind === 'applied') state.set(result.state);
      return result;
    },
    replaceSnapshot(next: SessionSnapshot) {
      state.set(replaceSnapshot(currentProjection(state), next));
    },
    replaceProjectSnapshot(next: ProjectSnapshot) {
      state.set(replaceProjectSnapshot(currentProjection(state), next));
    },
    setConnectionHealth(connectionHealth: ConnectionHealth) {
      state.connectionHealth.set(connectionHealth);
      if (connectionHealth === 'disconnected')
        state.streamingAssistantTextBySession.set({});
    },
    notifyInvalidPayload(message: string) {
      const current = currentProjection(state);
      state.notifications.set([
        ...current.notifications,
        diagnosticNotification(message),
      ]);
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
      state.set({
        ...current,
        filters: { ...current.filters, [scope]: value },
      });
    },
    setPromptDraft(sessionId: string, value: string) {
      const current = currentProjection(state);
      state.set({
        ...current,
        promptDrafts: { ...current.promptDrafts, [sessionId]: value },
      });
    },
    appendAssistantDelta(sessionId: string, text: string) {
      const current = currentProjection(state);
      state.streamingAssistantTextBySession.set({
        ...current.streamingAssistantTextBySession,
        [sessionId]:
          (current.streamingAssistantTextBySession[sessionId] ?? '') + text,
      });
      state.lastLiveActivityAtBySession.set({
        ...current.lastLiveActivityAtBySession,
        [sessionId]: new Date().toISOString(),
      });
    },
  };
};
