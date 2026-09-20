import type {
  LifecycleState,
  PermissionMode,
  PermissionResolution,
  SessionEvent,
} from '@mesh-session-platform/contracts';
import { useEffect, useRef, useState } from 'react';

import { type CommandSender } from './PermissionCard';
import { TranscriptItem } from './TranscriptItem';

export function Transcript({
  events,
  permissionMode,
  send,
  streamingAssistantText,
  verbose,
  connectionHealth,
  lastLiveActivityAt,
  lifecycleState,
}: {
  events: SessionEvent[];
  permissionMode: PermissionMode;
  send: CommandSender;
  streamingAssistantText?: string;
  verbose: boolean;
  connectionHealth: 'connected' | 'degraded' | 'disconnected';
  lastLiveActivityAt?: string;
  lifecycleState: LifecycleState;
}) {
  const resolutions = new Map<string, PermissionResolution>();
  const requests = new Map<
    string,
    Extract<SessionEvent, { type: 'tool.requested' }>
  >();
  const completed = new Set<string>();
  const completions = new Map<
    string,
    Extract<SessionEvent, { type: 'tool.completed' }>
  >();
  const progressByToolId = new Map<
    string,
    Extract<SessionEvent, { type: 'session.activity' }>
  >();
  const usageEvents = events.filter(
    (event): event is Extract<SessionEvent, { type: 'session.usage' }> =>
      event.type === 'session.usage',
  );
  const seenUsage = new Set<string>();
  const latestUsage = [...usageEvents].reverse().filter((event) => {
    const key = `${event.payload.scope ?? 'metadata'}:${event.payload.model ?? ''}`;
    if (seenUsage.has(key)) return false;
    seenUsage.add(key);
    return true;
  });
  const latestTurn = [...usageEvents]
    .reverse()
    .find((event) => event.payload.scope === 'turn');
  for (const event of events)
    if (event.type === 'permission.resolved')
      resolutions.set(event.payload.permissionId, event.payload);
  for (const event of events)
    if (event.type === 'tool.requested')
      requests.set(event.payload.toolCallId, event);
  for (const event of events)
    if (event.type === 'tool.completed') {
      completed.add(event.payload.toolCallId);
      completions.set(event.payload.toolCallId, event);
    }
  const terminalSequence = Math.max(
    0,
    ...events
      .filter(
        (event) =>
          event.type === 'session.status' &&
          ['completed', 'failed', 'interrupted', 'archived'].includes(
            event.payload.to,
          ),
      )
      .map((event) => event.sequence),
  );
  for (const event of events)
    if (event.type === 'session.activity' && event.payload.toolCallId)
      progressByToolId.set(event.payload.toolCallId, event);
  const transcriptRef = useRef<HTMLElement>(null);
  const [following, setFollowing] = useState(true);
  const [now, setNow] = useState(Date.now());
  const hasPendingTool = [...requests.values()].some(
    (request) =>
      request.sequence > terminalSequence &&
      !completed.has(request.payload.toolCallId),
  );
  const live =
    connectionHealth === 'connected' &&
    !['completed', 'failed', 'interrupted', 'archived'].includes(
      lifecycleState,
    );
  const terminal = ['completed', 'failed', 'interrupted', 'archived'].includes(
    lifecycleState,
  );
  const pendingApproval = events.some(
    (event) =>
      event.type === 'permission.requested' &&
      event.sequence > terminalSequence &&
      !resolutions.has(event.payload.permissionId),
  );
  const latestPrompt = [...events]
    .reverse()
    .find(
      (event): event is Extract<SessionEvent, { type: 'message.user' }> =>
        event.type === 'message.user',
    );
  const waitingForResponse =
    latestPrompt !== undefined &&
    latestPrompt.sequence > terminalSequence &&
    (latestTurn === undefined || latestPrompt.sequence > latestTurn.sequence);
  const activeStartedAt = waitingForResponse
    ? latestPrompt?.occurredAt
    : hasPendingTool
      ? [...requests.values()].filter(
          (request) =>
            request.sequence > terminalSequence &&
            !completed.has(request.payload.toolCallId),
        )[0]?.occurredAt
      : undefined;
  const showActivityClock = Boolean(lastLiveActivityAt);
  useEffect(() => {
    if (!showActivityClock) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [showActivityClock]);
  const latestKey = `${events.length}:${streamingAssistantText ?? ''}`;
  useEffect(() => {
    if (following && transcriptRef.current)
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [following, latestKey]);
  useEffect(() => {
    const element = transcriptRef.current;
    if (!following || !element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [following]);
  const scrollToLatest = () => {
    if (transcriptRef.current)
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    setFollowing(true);
  };
  return (
    <div className="timeline-container">
      <div className="timeline-progress" role="status">
        <span>
          {!live
            ? connectionHealth !== 'connected'
              ? 'Connection unavailable'
              : `Session ${lifecycleState}`
            : pendingApproval || lifecycleState === 'waiting_for_approval'
              ? 'Waiting for approval'
              : lifecycleState === 'interrupting'
                ? 'Interrupting session'
                : streamingAssistantText && waitingForResponse
                  ? 'Receiving Claude response'
                  : hasPendingTool
                    ? 'Waiting for tool result'
                    : waitingForResponse
                      ? 'Waiting for response'
                      : latestTurn?.payload.durationMs !== undefined
                        ? 'Last response received'
                        : 'Ready for prompt'}
        </span>
        {lastLiveActivityAt ? (
          <small>
            {live && activeStartedAt
              ? `${elapsedSince(activeStartedAt, now)}s elapsed · `
              : ''}
            Last activity {relativeTime(lastLiveActivityAt, now)}
          </small>
        ) : null}
      </div>
      <section
        ref={transcriptRef}
        className={`transcript ${verbose ? 'transcript-verbose' : 'transcript-compact'}`}
        aria-label="Session timeline"
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollowing(
            element.scrollHeight - element.scrollTop - element.clientHeight <
              12,
          );
        }}
      >
        {events.map((event) =>
          (event.type === 'tool.completed' &&
            requests.has(event.payload.toolCallId)) ||
          (event.type === 'session.usage' &&
            !latestUsage.some((usage) => usage.id === event.id)) ? null : (
            <TranscriptItem
              key={event.id}
              event={event}
              resolutions={resolutions}
              toolRequest={event.type === 'tool.requested' ? event : undefined}
              toolCompletion={
                event.type === 'tool.requested'
                  ? completions.get(event.payload.toolCallId)
                  : undefined
              }
              usage={event.type === 'session.usage' ? event.payload : undefined}
              live={live}
              terminal={
                terminal ||
                (event.type === 'tool.requested' &&
                  event.sequence <= terminalSequence)
              }
              now={now}
              progress={
                event.type === 'tool.requested'
                  ? progressByToolId.get(event.payload.toolCallId)
                  : undefined
              }
              permissionMode={permissionMode}
              send={send}
              verbose={verbose}
            />
          ),
        )}
        {streamingAssistantText && live ? (
          <article
            className="transcript-item transcript-assistant transcript-streaming"
            aria-label="Streaming assistant message"
            aria-live="polite"
          >
            <time>{formatTime(lastLiveActivityAt)}</time>
            <strong>Claude · Streaming</strong>
            <p>{streamingAssistantText}</p>
          </article>
        ) : null}
      </section>
      {!following ? (
        <button
          className="timeline-jump"
          type="button"
          onClick={scrollToLatest}
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

const formatTime = (value?: string) =>
  value
    ? new Date(value).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : 'Live';

const relativeTime = (value: string, now: number) => {
  const seconds = Math.max(
    0,
    Math.round((now - new Date(value).getTime()) / 1000),
  );
  return seconds === 0 ? 'just now' : `${seconds}s ago`;
};

const elapsedSince = (value: string, now: number) =>
  Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
