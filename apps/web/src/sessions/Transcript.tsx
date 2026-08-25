import type {
  PermissionMode,
  PermissionResolution,
  SessionEvent,
} from '@mesh-session-platform/contracts';

import { type CommandSender } from './PermissionCard';
import { TranscriptItem } from './TranscriptItem';

export function Transcript({
  events,
  permissionMode,
  send,
}: {
  events: SessionEvent[];
  permissionMode: PermissionMode;
  send: CommandSender;
}) {
  const resolutions = new Map<string, PermissionResolution>();
  const requests = new Map<
    string,
    Extract<SessionEvent, { type: 'tool.requested' }>
  >();
  const completed = new Set<string>();
  for (const event of events)
    if (event.type === 'permission.resolved')
      resolutions.set(event.payload.permissionId, event.payload);
  for (const event of events)
    if (event.type === 'tool.requested')
      requests.set(event.payload.toolCallId, event);
  for (const event of events)
    if (event.type === 'tool.completed')
      completed.add(event.payload.toolCallId);
  return (
    <section aria-label="Session transcript">
      <h3>Transcript</h3>
      {events.map((event) =>
        event.type === 'tool.requested' &&
        completed.has(event.payload.toolCallId) ? null : (
          <TranscriptItem
            key={event.id}
            event={event}
            resolutions={resolutions}
            toolRequest={
              event.type === 'tool.completed'
                ? requests.get(event.payload.toolCallId)
                : undefined
            }
            permissionMode={permissionMode}
            send={send}
          />
        ),
      )}
    </section>
  );
}
