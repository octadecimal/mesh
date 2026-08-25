import * as Dialog from '@radix-ui/react-dialog';
import { useState, type FormEvent } from 'react';

import { WorkspaceFields, type WorkspaceDraft } from './WorkspaceFields';

type ProjectOption = { id: string; displayName: string; repositoryPath: string };
type SessionCreateCommand = { type: 'session.create'; payload: unknown };
export type SessionFlowError = { code: string; message?: string };

const emptyWorkspace = (repositoryPath = ''): WorkspaceDraft => ({ type: 'shared', sharedPath: '', repositoryPath, worktreePath: '', branch: '', startPoint: '' });
const isAbsolutePath = (path: string) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());
const errorMessage = (error: SessionFlowError) => error.message ?? ({
  billing_conflict: 'Billing is blocking this action. Resolve the billing conflict and try again.',
  subscription_reset: 'Your subscription reset was detected. Review your subscription, then try again.',
  unsupported_capability: 'This Claude capability is not supported by the current runtime.',
  worktree_dirty: 'Commit, stash, or choose another worktree before continuing.',
  worktree_ambiguous: 'Choose a single unambiguous worktree before continuing.',
  invalid_path: 'Choose an existing absolute path that Mesh can access.',
}[error.code] ?? 'The session could not be created.');

export function NewSessionDialog({ open, onOpenChange, projects, collisionWarning, error, onCreate }: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  projects: readonly ProjectOption[];
  collisionWarning?: string;
  error?: SessionFlowError;
  onCreate: (command: SessionCreateCommand) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('New session');
  const [permissionMode, setPermissionMode] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceDraft>(emptyWorkspace());
  const [validationError, setValidationError] = useState<string>();
  const project = projects.find((candidate) => candidate.id === projectId);
  const selectProject = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    setWorkspace((current) => ({ ...current, repositoryPath: projects.find((candidate) => candidate.id === nextProjectId)?.repositoryPath ?? '' }));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = workspace.type === 'shared' ? workspace.sharedPath : workspace.worktreePath;
    if (!isAbsolutePath(path)) return setValidationError('Enter an absolute folder path.');
    if (!project || !permissionMode) return;
    const payload = workspace.type === 'shared'
      ? { projectId, title, permissionMode, workspace: { type: 'shared' as const, path: workspace.sharedPath.trim() } }
      : { projectId, title, permissionMode, workspace: { type: 'worktree' as const, repositoryPath: workspace.repositoryPath.trim(), path: workspace.worktreePath.trim(), branch: workspace.branch.trim(), startPoint: workspace.startPoint.trim() } };
    onCreate({ type: 'session.create', payload });
  };
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay /><Dialog.Content aria-describedby="new-session-description">
    <Dialog.Title>New session</Dialog.Title><Dialog.Description id="new-session-description">Choose a project, workspace, and explicit permission mode.</Dialog.Description>
    {collisionWarning ? <p role="alert">{collisionWarning}</p> : null}{error ? <p role="alert">{errorMessage(error)}</p> : null}{validationError ? <p role="alert">{validationError}</p> : null}
    <form onSubmit={submit}>
      <label>Project<select aria-label="Project" required value={projectId} onChange={(event) => selectProject(event.target.value)}><option value="">Select a project</option>{projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}</select></label>
      <label>Session title<input aria-label="Session title" required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <WorkspaceFields value={workspace} onChange={setWorkspace} />
      <label>Permission mode<select aria-label="Permission mode" required value={permissionMode} onChange={(event) => setPermissionMode(event.target.value)}><option value="">Select permission mode</option><option value="interactive">Interactive approvals</option><option value="safe_auto">Safe automatic actions</option><option value="inherit">Inherit Claude settings</option></select></label>
      <div><Dialog.Close asChild><button type="button">Cancel</button></Dialog.Close><button type="submit">Create session</button></div>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
