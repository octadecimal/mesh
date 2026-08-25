import { useState } from 'react';
import type { MutatingCommand } from '@mesh-session-platform/contracts';

import { type CommandSender } from './PermissionCard';

export function SessionActions({
  sessionId,
  send,
}: {
  sessionId: string;
  send: CommandSender;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const dispatch = async (command: MutatingCommand) => {
    setBusy(true);
    try {
      await send(command);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Session actions">
      <button
        disabled={busy}
        onClick={() =>
          void dispatch({
            type: 'session.interrupt',
            payload: { sessionId },
          } as MutatingCommand)
        }
      >
        Interrupt session
      </button>
      <button
        disabled={busy}
        onClick={() =>
          void dispatch({
            type: 'session.archive',
            payload: { sessionId },
          } as MutatingCommand)
        }
      >
        Archive session
      </button>
      <button disabled={busy} onClick={() => setConfirmingDelete(true)}>
        Delete session
      </button>
      {confirmingDelete ? (
        <div role="alertdialog" aria-label="Confirm session deletion">
          <p>Delete this session permanently?</p>
          <button
            autoFocus
            disabled={busy}
            onClick={() =>
              void dispatch({
                type: 'session.delete',
                payload: { sessionId, confirmed: true },
              } as MutatingCommand).then(() => setConfirmingDelete(false))
            }
          >
            Delete permanently
          </button>
          <button disabled={busy} onClick={() => setConfirmingDelete(false)}>
            Cancel deletion
          </button>
        </div>
      ) : null}
    </section>
  );
}
