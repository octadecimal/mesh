import type { SessionEvent } from '@mesh-session-platform/contracts';

export type EventListener = (event: SessionEvent) => void;

export class EventPublisher {
  private readonly listeners = new Map<string, Set<EventListener>>();

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
}
