import type { PermissionResolution, SessionEvent } from '@mesh-session-platform/contracts';

import { type CommandSender } from './PermissionCard';
import { TranscriptItem } from './TranscriptItem';

export function Transcript({ events, send }: { events: SessionEvent[]; send: CommandSender }) {
  const resolutions = new Map<string, PermissionResolution>();
  for (const event of events) if (event.type === 'permission.resolved') resolutions.set(event.payload.permissionId, event.payload);
  return <section aria-label="Session transcript">
    <h3>Transcript</h3>
    {events.map((event) => <TranscriptItem key={event.id} event={event} resolutions={resolutions} send={send} />)}
  </section>;
}
