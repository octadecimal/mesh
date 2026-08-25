import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import type {
  PermissionMode,
  Workspace,
} from '@mesh-session-platform/contracts';

import type { SessionFlowError } from './NewSessionDialog';

export type DiscoveredSession = {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  claudeResumeId?: string;
  lastPath?: string;
  applicationMatch?: string;
  permissionMode: PermissionMode;
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
  workspaces = [],
  error,
  onResume,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  sessions: readonly DiscoveredSession[];
  workspaces?: readonly Pick<Workspace, 'id' | 'projectId' | 'path' | 'type'>[];
  error?: SessionFlowError;
  onResume: (command: {
    type: 'session.resume';
    payload: {
      sessionId: string;
      workspaceId: string;
      permissionMode: PermissionMode;
    };
  }) => void;
}) {
  const [selectedId, setSelectedId] = useState(sessions[0]?.id ?? '');
  const selected =
    sessions.find((session) => session.id === selectedId) ?? sessions[0];
  const [workspaceId, setWorkspaceId] = useState(
    sessions[0]?.workspaceId ?? '',
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    sessions[0]?.permissionMode ?? 'inherit',
  );
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
                    onChange={() => {
                      setSelectedId(session.id);
                      setWorkspaceId(session.workspaceId);
                      setPermissionMode(session.permissionMode);
                    }}
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
          {selected ? (
            <div>
              <label>
                Resume workspace
                <select
                  aria-label="Resume workspace"
                  value={workspaceId || selected.workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  {workspaces
                    .filter(
                      (workspace) => workspace.projectId === selected.projectId,
                    )
                    .map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.path} ({workspace.type})
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Resume permission mode
                <select
                  aria-label="Resume permission mode"
                  value={permissionMode}
                  onChange={(event) =>
                    setPermissionMode(event.target.value as PermissionMode)
                  }
                >
                  <option value="interactive">interactive</option>
                  <option value="safe_auto">safe auto</option>
                  <option value="inherit">inherit</option>
                </select>
              </label>
            </div>
          ) : null}
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
                  payload: {
                    sessionId: selected.id,
                    workspaceId: workspaceId || selected.workspaceId,
                    permissionMode,
                  },
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
