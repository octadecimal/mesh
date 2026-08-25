import type {
  PermissionMode,
  PermissionResolution,
  SessionEvent,
} from '@mesh-session-platform/contracts';

import { PermissionCard, type CommandSender } from './PermissionCard';

const exhaustive = (value: never): never => {
  throw new Error(`Unexpected session event: ${JSON.stringify(value)}`);
};

export function TranscriptItem({
  event,
  resolutions,
  toolRequest,
  permissionMode,
  send,
}: {
  event: SessionEvent;
  resolutions: ReadonlyMap<string, PermissionResolution>;
  toolRequest?: Extract<SessionEvent, { type: 'tool.requested' }>;
  permissionMode: PermissionMode;
  send: CommandSender;
}) {
  switch (event.type) {
    case 'message.user':
      return (
        <article
          className="transcript-item transcript-user"
          aria-label="User message"
        >
          <strong>User</strong>
          <p>{event.payload.text}</p>
        </article>
      );
    case 'message.assistant':
      return (
        <article
          className="transcript-item transcript-assistant"
          aria-label="Assistant message"
        >
          <strong>Assistant</strong>
          <p>{event.payload.text}</p>
        </article>
      );
    case 'tool.requested':
      return (
        <article
          className="transcript-item transcript-tool"
          aria-label={`Tool request ${event.payload.name}`}
        >
          <strong>Tool request: {event.payload.name}</strong>
          <details>
            <summary>Tool input</summary>
            <pre>{JSON.stringify(event.payload.input, null, 2)}</pre>
          </details>
        </article>
      );
    case 'tool.completed':
      return (
        <article
          className="transcript-item transcript-tool"
          aria-label={`Tool call ${toolRequest?.payload.name ?? event.payload.toolCallId}`}
        >
          <strong>
            Tool: {toolRequest?.payload.name ?? event.payload.toolCallId}
          </strong>
          {toolRequest ? (
            <details>
              <summary>Tool input</summary>
              <pre>{JSON.stringify(toolRequest.payload.input, null, 2)}</pre>
            </details>
          ) : null}
          <details>
            <summary>
              {event.payload.isError ? 'Tool error' : 'Tool output'}
            </summary>
            <pre>{JSON.stringify(event.payload.output, null, 2)}</pre>
          </details>
        </article>
      );
    case 'permission.requested':
      return (
        <PermissionCard
          request={event.payload}
          occurredAt={event.occurredAt}
          permissionMode={permissionMode}
          resolution={resolutions.get(event.payload.permissionId)}
          send={send}
        />
      );
    case 'permission.resolved':
      return (
        <article
          className="transcript-item transcript-audit"
          aria-label="Permission audit"
        >
          <strong>Permission audit</strong>
          <p>
            {event.payload.permissionId}: {event.payload.decision}
          </p>
        </article>
      );
    case 'session.status':
      return (
        <article
          className="transcript-item transcript-status"
          aria-label="Session status"
        >
          <strong>Status</strong>
          <p>
            {event.payload.from} → {event.payload.to}
            {event.payload.reason ? `: ${event.payload.reason}` : ''}
          </p>
        </article>
      );
    case 'session.error':
      return (
        <article
          className="transcript-item transcript-error"
          role="alert"
          aria-label="Session error"
        >
          <strong>{event.payload.code}</strong>
          <p>{event.payload.message}</p>
        </article>
      );
    case 'diagnostic.recorded':
      return (
        <article
          className="transcript-item transcript-diagnostic"
          aria-label="Diagnostic indicator"
        >
          Diagnostic recorded
        </article>
      );
    default:
      return exhaustive(event);
  }
}
