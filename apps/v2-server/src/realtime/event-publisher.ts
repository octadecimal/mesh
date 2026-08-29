import type {
  DomainEvent,
  RuntimeEvent,
  ServerRealtimeMessage,
} from '@mesh/v2-contracts';

type DomainListener = (event: DomainEvent) => void;
type RuntimeListener = (event: RuntimeEvent) => void;

export class V2EventPublisher {
  private readonly domainListeners = new Map<string, Set<DomainListener>>();
  private readonly runtimeListeners = new Map<string, Set<RuntimeListener>>();

  constructor(
    private readonly onPublished?: (message: ServerRealtimeMessage) => void,
  ) {}

  subscribeDomain(projectId: string, listener: DomainListener): () => void {
    return this.subscribe(this.domainListeners, projectId, listener);
  }

  subscribeRuntime(projectId: string, listener: RuntimeListener): () => void {
    return this.subscribe(this.runtimeListeners, projectId, listener);
  }

  domain(event: DomainEvent): void {
    this.publish(this.domainListeners.get(event.projectId), event);
    this.onPublished?.({
      type: 'v2.domain_event',
      protocolVersion: 'mesh.v2/1',
      projectId: event.projectId,
      event,
    });
  }

  runtime(event: RuntimeEvent): void {
    this.publish(this.runtimeListeners.get(event.projectId), event);
    this.onPublished?.({
      type: 'v2.runtime_event',
      protocolVersion: 'mesh.v2/1',
      projectId: event.projectId,
      event,
    });
  }

  private subscribe<T>(
    map: Map<string, Set<(event: T) => void>>,
    projectId: string,
    listener: (event: T) => void,
  ): () => void {
    const listeners = map.get(projectId) ?? new Set<(event: T) => void>();
    listeners.add(listener);
    map.set(projectId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) map.delete(projectId);
    };
  }

  private publish<T>(listeners: Set<(event: T) => void> | undefined, event: T) {
    for (const listener of listeners ?? []) {
      try {
        listener(event);
      } catch {
        // A stale listener cannot invalidate an already committed audit event.
      }
    }
  }
}
