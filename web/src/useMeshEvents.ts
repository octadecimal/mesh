import { useEffect, useState } from 'react';
import { emptyPartials, reducePartials } from './lib/partials.ts';
import type { Partials } from './lib/partials.ts';
import type { MeshEvent, StampedEvent } from '../../src/types.ts';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * EventSource reconnects on its own and replays Last-Event-ID, so the server
 * resends only what this client missed.
 */
export function useMeshEvents(): {
  events: StampedEvent[];
  partials: Partials;
  connection: ConnectionState;
} {
  const [events, setEvents] = useState<StampedEvent[]>([]);
  const [partials, setPartials] = useState<Partials>(emptyPartials);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const source = new EventSource('/api/events');

    source.onopen = () => setConnection('open');
    source.onerror = () => setConnection('closed');
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as MeshEvent | StampedEvent;

      // Deltas are framed without an id and never enter history, so a pending
      // message is the one thing here that is state rather than a transcript
      // entry. Finished events run through the reducer too: they are what tell
      // it a buffer has been superseded.
      setPartials((previous) => reducePartials(previous, event));

      if (!('seq' in event)) return;
      setEvents((previous) =>
        previous.some((existing) => existing.seq === event.seq) ? previous : [...previous, event],
      );
    };

    return () => source.close();
  }, []);

  return { events, partials, connection };
}
