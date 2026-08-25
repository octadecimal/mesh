import type {
  ProjectEvent,
  ServerMessage,
  SessionEvent,
} from '@mesh-session-platform/contracts';

export type EventListener = (event: SessionEvent) => void;
export type ProjectEventListener = (event: ProjectEvent) => void;
export type AssistantDelta = Extract<
  ServerMessage,
  { type: 'assistant.delta' }
>['payload'];
export type AssistantDeltaListener = (delta: AssistantDelta) => void;

export class EventPublisher {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly projectListeners = new Map<
    string,
    Set<ProjectEventListener>
  >();
  private readonly transientListeners = new Map<
    string,
    Set<AssistantDeltaListener>
  >();

  subscribe(sessionId: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  publish(event: SessionEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A stale consumer cannot invalidate a committed audit event or block peers.
      }
    }
  }

  subscribeProject(
    projectId: string,
    listener: ProjectEventListener,
  ): () => void {
    const listeners =
      this.projectListeners.get(projectId) ?? new Set<ProjectEventListener>();
    listeners.add(listener);
    this.projectListeners.set(projectId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.projectListeners.delete(projectId);
    };
  }

  publishProject(event: ProjectEvent): void {
    for (const listener of this.projectListeners.get(event.projectId) ?? []) {
      try {
        listener(event);
      } catch {
        // A stale consumer cannot invalidate a committed project event or block peers.
      }
    }
  }

  subscribeTransient(
    sessionId: string,
    listener: AssistantDeltaListener,
  ): () => void {
    const listeners =
      this.transientListeners.get(sessionId) ??
      new Set<AssistantDeltaListener>();
    listeners.add(listener);
    this.transientListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.transientListeners.delete(sessionId);
    };
  }

  publishTransient(delta: AssistantDelta): void {
    for (const listener of this.transientListeners.get(delta.sessionId) ?? []) {
      try {
        listener(delta);
      } catch {
        // A stale consumer cannot block live output for peers.
      }
    }
  }
}
