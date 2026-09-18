import type { MeshApi } from '../api/client';
import type {
  Session,
  SessionEvent,
  Workspace,
} from '@mesh-session-platform/contracts';

import { useId, useState } from 'react';

import { type CommandSender } from './PermissionCard';
import { PromptComposer } from './PromptComposer';
import { RawDiagnostics } from './RawDiagnostics';
import { InterruptSessionButton, SessionActions } from './SessionActions';
import { SessionHeader } from './SessionHeader';
import { Transcript } from './Transcript';

export type SessionPanelApi = Pick<MeshApi, 'command' | 'diagnostics'>;

export function SessionPanel({
  session,
  workspace,
  events,
  api,
  auditAvailable = true,
  promptDraft = '',
  streamingAssistantText,
  onPromptDraftChange = () => undefined,
}: {
  session: Session;
  workspace?: Workspace;
  events: SessionEvent[];
  api?: SessionPanelApi;
  auditAvailable?: boolean;
  promptDraft?: string;
  streamingAssistantText?: string;
  onPromptDraftChange?: (value: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = `session-details-${useId()}`;
  const unavailable = async () => {
    throw new Error('Session API is unavailable');
  };
  const send: CommandSender = (command, idempotencyKey) =>
    api ? api.command(command, idempotencyKey) : unavailable();
  return (
    <section
      className="session-panel-content"
      aria-label={`${session.title} panel`}
    >
      <SessionHeader
        session={session}
        detailsOpen={detailsOpen}
        detailsId={detailsId}
        onDetailsOpenChange={setDetailsOpen}
        actions={<SessionActions sessionId={session.id} send={send} />}
      />
      <div
        className="session-layout"
        data-details-open={detailsOpen || undefined}
      >
        <div className="session-conversation">
          <Transcript
            events={events}
            permissionMode={session.permissionMode}
            send={send}
            streamingAssistantText={streamingAssistantText}
          />
          <PromptComposer
            session={session}
            auditAvailable={auditAvailable}
            send={send}
            draft={promptDraft}
            onDraftChange={onPromptDraftChange}
            interruptAction={
              <InterruptSessionButton session={session} send={send} />
            }
          />
        </div>
        {detailsOpen ? (
          <aside
            id={detailsId}
            className="session-details"
            aria-label="Session details"
          >
            <h3>Session details</h3>
            <dl>
              <div>
                <dt>Repository</dt>
                <dd>{workspace?.path ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd>{workspace?.type ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{workspace?.gitBranch ?? 'Unavailable'}</dd>
              </div>
            </dl>
            <RawDiagnostics
              sessionId={session.id}
              load={(sessionId, options) =>
                api ? api.diagnostics(sessionId, options) : unavailable()
              }
            />
          </aside>
        ) : null}
      </div>
    </section>
  );
}
