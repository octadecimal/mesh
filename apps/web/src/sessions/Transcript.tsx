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
  streamingAssistantText,
}: {
  events: SessionEvent[];
  permissionMode: PermissionMode;
  send: CommandSender;
  streamingAssistantText?: string;
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
    <section className="transcript" aria-label="Session transcript">
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
      {streamingAssistantText ? (
        <article
          className="transcript-item transcript-assistant transcript-streaming"
          aria-label="Streaming assistant message"
          aria-live="polite"
        >
          <strong>Assistant</strong>
          <p>{streamingAssistantText}</p>
        </article>
      ) : null}
    </section>
  );
}
