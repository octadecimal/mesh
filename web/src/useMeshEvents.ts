import { useEffect, useState } from 'react';
import type { StampedEvent } from '../../src/types.ts';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * EventSource reconnects on its own and replays Last-Event-ID, so the server
 * resends only what this client missed.
 */
export function useMeshEvents(): { events: StampedEvent[]; connection: ConnectionState } {
  const [events, setEvents] = useState<StampedEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const source = new EventSource('/api/events');

    source.onopen = () => setConnection('open');
    source.onerror = () => setConnection('closed');
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as StampedEvent;
      setEvents((previous) =>
        previous.some((existing) => existing.seq === event.seq) ? previous : [...previous, event],
      );
    };

    return () => source.close();
  }, []);

  return { events, connection };
}
