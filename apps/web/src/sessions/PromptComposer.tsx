import { useState } from 'react';
import type {
  MutatingCommand,
  Session,
} from '@mesh-session-platform/contracts';

import { type CommandSender } from './PermissionCard';

const canPrompt = (state: Session['lifecycleState']) =>
  state === 'idle' || state === 'running';

export function PromptComposer({
  session,
  auditAvailable,
  send,
  draft,
  onDraftChange,
}: {
  session: Session;
  auditAvailable: boolean;
  send: CommandSender;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const [sending, setSending] = useState(false);
  const disabled =
    !auditAvailable ||
    !canPrompt(session.lifecycleState) ||
    sending ||
    !draft.trim();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    setSending(true);
    try {
      await send({
        type: 'session.prompt',
        payload: { sessionId: session.id, prompt: draft.trim() },
      } as MutatingCommand);
      onDraftChange('');
    } finally {
      setSending(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Prompt composer">
      <label>
        Prompt
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
        />
      </label>
      {!auditAvailable ? (
        <p role="status">
          Prompting is unavailable until the permission audit is available.
        </p>
      ) : null}
      <button type="submit" disabled={disabled}>
        Send prompt
      </button>
    </form>
  );
}
