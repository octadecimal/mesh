import type { MeshApi } from '../api/client';
import type { Session, SessionEvent, Workspace } from '@mesh-session-platform/contracts';

import { type CommandSender } from './PermissionCard';
import { PromptComposer } from './PromptComposer';
import { RawDiagnostics } from './RawDiagnostics';
import { SessionActions } from './SessionActions';
import { SessionHeader } from './SessionHeader';
import { Transcript } from './Transcript';

export type SessionPanelApi = Pick<MeshApi, 'command' | 'diagnostics'>;

export function SessionPanel({ session, workspace, events, api, auditAvailable = true, promptDraft = '', onPromptDraftChange = () => undefined }: {
  session: Session;
  workspace?: Workspace;
  events: SessionEvent[];
  api?: SessionPanelApi;
  auditAvailable?: boolean;
  promptDraft?: string;
  onPromptDraftChange?: (value: string) => void;
}) {
  const unavailable = async () => { throw new Error('Session API is unavailable'); };
  const send: CommandSender = (command, idempotencyKey) => api ? api.command(command, idempotencyKey) : unavailable();
  return <section className="session-panel" aria-label={`${session.title} panel`}>
    <SessionHeader session={session} workspace={workspace} />
    <Transcript events={events} permissionMode={session.permissionMode} send={send} />
    <RawDiagnostics sessionId={session.id} load={(sessionId, options) => api ? api.diagnostics(sessionId, options) : unavailable()} />
    <PromptComposer session={session} auditAvailable={auditAvailable} send={send} draft={promptDraft} onDraftChange={onPromptDraftChange} />
    <SessionActions sessionId={session.id} send={send} />
  </section>;
}
