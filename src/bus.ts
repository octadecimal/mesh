import type { MeshEvent, StampedEvent } from './types.ts';

const DEFAULT_BUFFER = 2000;

export class EventBus {
  #buffer: StampedEvent[] = [];
  #listeners = new Set<(event: StampedEvent) => void>();
  #ephemeralListeners = new Set<(event: MeshEvent) => void>();
  #seq = 0;
  #limit: number;

  constructor(limit: number = DEFAULT_BUFFER) {
    this.#limit = limit;
  }

  publish(event: MeshEvent): StampedEvent {
    this.#seq += 1;
    const stamped = { ...event, seq: this.#seq, ts: Date.now() } as StampedEvent;

    this.#buffer.push(stamped);
    if (this.#buffer.length > this.#limit) this.#buffer.shift();

    for (const listener of this.#listeners) {
      // One bad subscriber, typically a half-closed SSE response, must not
      // take down delivery to the others.
      try {
        listener(stamped);
      } catch {
        // Ignored deliberately.
      }
    }
    return stamped;
  }

  subscribe(listener: (event: StampedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Deliver to whoever is watching right now, and keep no record. Token
   * deltas arrive by the hundred per turn: buffering them would evict the
   * real history within a single turn and make every reconnect replay a
   * transcript that has already been superseded by the finished message.
   * Because they take no sequence number, a client's Last-Event-ID keeps
   * pointing at the last durable event and replay stays exact.
   */
  publishEphemeral(event: MeshEvent): void {
    for (const listener of this.#ephemeralListeners) {
      try {
        listener(event);
      } catch {
        // Ignored deliberately, as with durable delivery.
      }
    }
  }

  subscribeEphemeral(listener: (event: MeshEvent) => void): () => void {
    this.#ephemeralListeners.add(listener);
    return () => this.#ephemeralListeners.delete(listener);
  }

  history(sinceSeq = 0): StampedEvent[] {
    return this.#buffer.filter((event) => event.seq > sinceSeq);
  }
}
