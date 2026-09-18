import { useState } from 'react';
import type {
  MutatingCommand,
  Session,
} from '@mesh-session-platform/contracts';

import { type CommandSender } from './PermissionCard';

export function SessionActions({
  sessionId,
  send,
}: {
  sessionId: string;
  send: CommandSender;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dispatch = async (command: MutatingCommand) => {
    setBusy(true);
    setError(undefined);
    try {
      await send(command);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Session action failed',
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="session-actions"
      aria-label="Session actions"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Session actions</summary>
      <div className="session-actions-menu" hidden={!open}>
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
        {error && !confirmingDelete ? <p role="alert">{error}</p> : null}
      </div>
      {confirmingDelete && open ? (
        <div role="alertdialog" aria-label="Confirm session deletion">
          <p>Delete this session permanently?</p>
          {error ? <p role="alert">{error}</p> : null}
          <button
            autoFocus
            disabled={busy}
            onClick={() =>
              void dispatch({
                type: 'session.delete',
                payload: { sessionId, confirmed: true },
              } as MutatingCommand).then((deleted) => {
                if (deleted) setConfirmingDelete(false);
              })
            }
          >
            Delete permanently
          </button>
          <button disabled={busy} onClick={() => setConfirmingDelete(false)}>
            Cancel deletion
          </button>
        </div>
      ) : null}
    </details>
  );
}

export function InterruptSessionButton({
  session,
  send,
}: {
  session: Session;
  send: CommandSender;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (
    session.lifecycleState !== 'idle' &&
    session.lifecycleState !== 'starting' &&
    session.lifecycleState !== 'running' &&
    session.lifecycleState !== 'waiting_for_approval'
  )
    return null;
  const interrupt = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await send({
        type: 'session.interrupt',
        payload: { sessionId: session.id },
      } as MutatingCommand);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to interrupt session',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="interrupt-session-action">
      <button
        className="button button-secondary"
        type="button"
        disabled={busy}
        onClick={() => void interrupt()}
      >
        Interrupt session
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </span>
  );
}
