import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

import type { SessionFlowError } from './NewSessionDialog';

export type DiscoveredSession = {
  id: string;
  title: string;
  claudeResumeId?: string;
  lastPath?: string;
  applicationMatch?: string;
  permissionMode?: string;
  workspaceType?: string;
};
const errorMessage = (error: SessionFlowError) =>
  error.message ??
  {
    billing_conflict:
      'Billing is blocking this resume. Resolve the billing conflict and try again.',
    subscription_reset:
      'Your subscription reset was detected. Review your subscription, then try again.',
    unsupported_capability:
      'This Claude capability is not supported by the current runtime.',
    worktree_dirty:
      'Commit, stash, or choose another worktree before resuming.',
    worktree_ambiguous: 'Choose a single unambiguous worktree before resuming.',
    invalid_path:
      'Choose an existing absolute path that Mesh can access before resuming.',
  }[error.code] ??
  'The session could not be resumed.';

export function ResumeSessionDialog({
  open,
  onOpenChange,
  sessions,
  error,
  onResume,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  sessions: readonly DiscoveredSession[];
  error?: SessionFlowError;
  onResume: (command: {
    type: 'session.resume';
    payload: { sessionId: string };
  }) => void;
}) {
  const [selectedId, setSelectedId] = useState(sessions[0]?.id ?? '');
  const selected = sessions.find((session) => session.id === selectedId);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content aria-describedby="resume-session-description">
          <Dialog.Title>Resume session</Dialog.Title>
          <Dialog.Description id="resume-session-description">
            Resume a discovered Claude session using its saved Mesh
            configuration. Prompts are not replayed.
          </Dialog.Description>
          {error ? <p role="alert">{errorMessage(error)}</p> : null}
          {sessions.length === 0 ? (
            <p>No discovered Claude sessions are available.</p>
          ) : (
            <fieldset>
              <legend>Discovered Claude sessions</legend>
              {sessions.map((session) => (
                <label key={session.id}>
                  <input
                    type="radio"
                    name="resume-session"
                    value={session.id}
                    checked={selectedId === session.id}
                    onChange={() => setSelectedId(session.id)}
                  />
                  <span>{session.title}</span>
                  <span>
                    {session.claudeResumeId ?? 'Claude identity unavailable'}
                  </span>
                  <span>{session.lastPath ?? 'Last path unavailable'}</span>
                  <span>
                    {session.applicationMatch ?? 'No application session match'}
                  </span>
                  <span>Permission: {session.permissionMode ?? 'unknown'}</span>
                  <span>Workspace: {session.workspaceType ?? 'unknown'}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div>
            <Dialog.Close asChild>
              <button type="button">Cancel</button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!selected}
              onClick={() =>
                selected &&
                onResume({
                  type: 'session.resume',
                  payload: { sessionId: selected.id },
                })
              }
            >
              Resume session
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
