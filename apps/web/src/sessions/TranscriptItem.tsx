import type {
  PermissionMode,
  PermissionResolution,
  SessionEvent,
  SessionUsage,
} from '@mesh-session-platform/contracts';

import { PermissionCard, type CommandSender } from './PermissionCard';

const exhaustive = (value: never): never => {
  throw new Error(`Unexpected session event: ${JSON.stringify(value)}`);
};

export function TranscriptItem({
  event,
  resolutions,
  toolRequest,
  toolCompletion,
  usage,
  live,
  terminal,
  now,
  progress,
  permissionMode,
  send,
  verbose,
}: {
  event: SessionEvent;
  resolutions: ReadonlyMap<string, PermissionResolution>;
  toolRequest?: Extract<SessionEvent, { type: 'tool.requested' }>;
  toolCompletion?: Extract<SessionEvent, { type: 'tool.completed' }>;
  usage?: SessionUsage;
  live: boolean;
  terminal: boolean;
  now: number;
  progress?: Extract<SessionEvent, { type: 'session.activity' }>;
  permissionMode: PermissionMode;
  send: CommandSender;
  verbose: boolean;
}) {
  switch (event.type) {
    case 'message.user':
      return (
        <article
          className="transcript-item transcript-user"
          aria-label="User message"
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>User</strong>
          <p>{event.payload.text}</p>
          <EventDetails event={event} />
        </article>
      );
    case 'message.assistant':
      return (
        <article
          className="transcript-item transcript-assistant"
          aria-label="Assistant message"
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>Claude</strong>
          <p>{event.payload.text}</p>
          <EventDetails event={event} />
        </article>
      );
    case 'tool.requested': {
      const completion = toolCompletion;
      return (
        <article
          className="transcript-item transcript-tool"
          aria-label={
            completion
              ? `Tool call ${event.payload.name}`
              : `Tool request ${event.payload.name}`
          }
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>
            Tool: {event.payload.name} ·{' '}
            {completion
              ? completion.payload.isError
                ? 'Error'
                : 'Completed'
              : terminal
                ? 'Stopped'
                : !live
                  ? 'Last known running'
                  : 'Running'}
          </strong>
          {completion ? (
            <small>{duration(event.occurredAt, completion.occurredAt)}</small>
          ) : live && !terminal ? (
            <small>
              {progress?.payload.elapsedSeconds ??
                elapsed(event.occurredAt, now)}
              s
            </small>
          ) : null}
          <EventDetails event={event} pairedEvent={completion} />
          {progress && !completion && live && !terminal ? (
            <p>{progress.payload.summary}</p>
          ) : null}
          <details>
            <summary>Tool input</summary>
            <pre>{JSON.stringify(event.payload.input, null, 2)}</pre>
          </details>
          {completion ? (
            <>
              <div
                className={`tool-output ${completion.payload.isError ? 'tool-output-error' : ''}`}
              >
                <small>
                  {completion.payload.isError ? 'Tool error' : 'Tool output'}
                </small>
                <pre>{outputPreview(completion.payload.output)}</pre>
              </div>
              <details>
                <summary>Show full output</summary>
                <pre>{JSON.stringify(completion.payload.output, null, 2)}</pre>
              </details>
            </>
          ) : null}
        </article>
      );
    }
    case 'tool.completed':
      return (
        <article
          className="transcript-item transcript-tool"
          aria-label={`Tool call ${toolRequest?.payload.name ?? event.payload.toolCallId}`}
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>
            Tool: {toolRequest?.payload.name ?? event.payload.toolCallId} ·{' '}
            {event.payload.isError ? 'Error' : 'Completed'}
          </strong>
          {toolRequest ? (
            <small>{duration(toolRequest.occurredAt, event.occurredAt)}</small>
          ) : null}
          {toolRequest ? (
            <details>
              <summary>Tool input</summary>
              <pre>{JSON.stringify(toolRequest.payload.input, null, 2)}</pre>
            </details>
          ) : null}
          <div
            className={`tool-output ${event.payload.isError ? 'tool-output-error' : ''}`}
          >
            <small>
              {event.payload.isError ? 'Tool error' : 'Tool output'}
            </small>
            <pre>{outputPreview(event.payload.output)}</pre>
          </div>
          <details>
            <summary>Show full output</summary>
            <pre>{JSON.stringify(event.payload.output, null, 2)}</pre>
          </details>
          <EventDetails event={event} pairedEvent={toolRequest} />
        </article>
      );
    case 'permission.requested':
      return (
        <>
          <PermissionCard
            request={event.payload}
            occurredAt={event.occurredAt}
            permissionMode={permissionMode}
            resolution={resolutions.get(event.payload.permissionId)}
            send={send}
          />
          <EventDetails event={event} />
        </>
      );
    case 'permission.resolved':
      return (
        <article
          className="transcript-item transcript-audit"
          aria-label="Permission audit"
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>Permission audit</strong>
          <p>
            {event.payload.permissionId}: {event.payload.decision}
          </p>
          <EventDetails event={event} />
        </article>
      );
    case 'session.activity':
      return verbose ? (
        <article
          className="transcript-item transcript-activity"
          aria-label="Session activity"
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>{event.payload.kind.replace('_', ' ')}</strong>
          <p>{event.payload.summary}</p>
          {event.payload.elapsedSeconds !== undefined ? (
            <small>{event.payload.elapsedSeconds}s</small>
          ) : null}
          <EventDetails event={event} />
        </article>
      ) : null;
    case 'session.usage':
      return verbose ? (
        <article
          className="transcript-item transcript-usage"
          aria-label="Reported usage"
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>
            {usage?.scope === 'turn'
              ? 'Model & usage · last reported turn'
              : 'Model & usage · Reported Claude run'}
          </strong>
          <p>{usageSummary(usage ?? event.payload)}</p>
          {usage?.scope === 'query' ? (
            <small>Since start, resume, or clear</small>
          ) : null}
          <EventDetails event={event} />
        </article>
      ) : null;
    case 'session.status':
      return (
        <article
          className="transcript-item transcript-status"
          aria-label="Session status"
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>Status</strong>
          <p>
            {event.payload.from} → {event.payload.to}
            {event.payload.reason ? `: ${event.payload.reason}` : ''}
          </p>
          <EventDetails event={event} />
        </article>
      );
    case 'session.error':
      return (
        <article
          className="transcript-item transcript-error"
          role="alert"
          aria-label="Session error"
        >
          <time>{formatTime(event.occurredAt)}</time>
          <strong>{event.payload.code}</strong>
          <p>{event.payload.message}</p>
          <EventDetails event={event} />
        </article>
      );
    case 'diagnostic.recorded':
      return (
        <article
          className="transcript-item transcript-diagnostic"
          aria-label="Diagnostic indicator"
        >
          {verbose ? <time>{formatTime(event.occurredAt)}</time> : null}
          Diagnostic recorded
          <EventDetails event={event} />
        </article>
      );
    default:
      return exhaustive(event);
  }
}

const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

const usageSummary = (
  usage: Extract<SessionEvent, { type: 'session.usage' }>['payload'],
) =>
  [
    usage.model,
    usage.inputTokens === undefined
      ? undefined
      : `input ${usage.inputTokens.toLocaleString()}`,
    usage.outputTokens === undefined
      ? undefined
      : `output ${usage.outputTokens.toLocaleString()}`,
    usage.cacheReadTokens === undefined
      ? undefined
      : `cache read ${usage.cacheReadTokens.toLocaleString()}`,
    usage.cacheCreationTokens === undefined
      ? undefined
      : `cache write ${usage.cacheCreationTokens.toLocaleString()}`,
    usage.contextTokens === undefined
      ? undefined
      : `context ${usage.contextTokens.toLocaleString()}`,
    usage.contextWindow === undefined
      ? undefined
      : `window ${usage.contextWindow.toLocaleString()}`,
    usage.durationMs === undefined
      ? undefined
      : `${(usage.durationMs / 1000).toFixed(1)}s`,
  ]
    .filter(Boolean)
    .join(' · ') || 'Reported usage';

const duration = (startedAt: string, completedAt: string) =>
  `${Math.max(0, (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000).toFixed(1)}s`;

const outputPreview = (output: unknown) => {
  const text =
    typeof output === 'string'
      ? output
      : (JSON.stringify(output, null, 2) ?? 'No output reported');
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
};

const elapsed = (startedAt: string, now: number) =>
  Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));

function EventDetails({
  event,
  pairedEvent,
}: {
  event: SessionEvent;
  pairedEvent?: SessionEvent;
}) {
  return (
    <details className="timeline-event-details">
      <summary>Event details</summary>
      <pre>
        {JSON.stringify(pairedEvent ? [event, pairedEvent] : event, null, 2)}
      </pre>
    </details>
  );
}
