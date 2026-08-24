import type { PermissionResolution, SessionEvent } from '@mesh-session-platform/contracts';

import { PermissionCard, type CommandSender } from './PermissionCard';

const exhaustive = (value: never): never => {
  throw new Error(`Unexpected session event: ${JSON.stringify(value)}`);
};

export function TranscriptItem({ event, resolutions, send }: {
  event: SessionEvent;
  resolutions: ReadonlyMap<string, PermissionResolution>;
  send: CommandSender;
}) {
  switch (event.type) {
    case 'message.user': return <article aria-label="User message"><strong>User</strong><p>{event.payload.text}</p></article>;
    case 'message.assistant': return <article aria-label="Assistant message"><strong>Assistant</strong><p>{event.payload.text}</p></article>;
    case 'tool.requested': return <article aria-label={`Tool request ${event.payload.name}`}><strong>Tool request: {event.payload.name}</strong><details><summary>Tool input</summary><pre>{JSON.stringify(event.payload.input, null, 2)}</pre></details></article>;
    case 'tool.completed': return <article aria-label="Tool result"><strong>{event.payload.isError ? 'Tool error' : 'Tool result'}</strong><details><summary>Tool output</summary><pre>{JSON.stringify(event.payload.output, null, 2)}</pre></details></article>;
    case 'permission.requested': return <PermissionCard request={event.payload} occurredAt={event.occurredAt} resolution={resolutions.get(event.payload.permissionId)} send={send} />;
    case 'permission.resolved': return <article aria-label="Permission audit"><strong>Permission audit</strong><p>{event.payload.permissionId}: {event.payload.decision}</p></article>;
    case 'session.status': return <article aria-label="Session status"><strong>Status</strong><p>{event.payload.from} → {event.payload.to}{event.payload.reason ? `: ${event.payload.reason}` : ''}</p></article>;
    case 'session.error': return <article role="alert" aria-label="Session error"><strong>{event.payload.code}</strong><p>{event.payload.message}</p></article>;
    case 'diagnostic.recorded': return <article aria-label="Diagnostic indicator">Diagnostic recorded</article>;
    default: return exhaustive(event);
  }
}
