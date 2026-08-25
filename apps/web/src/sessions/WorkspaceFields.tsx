import type { ChangeEvent } from 'react';

export type WorkspaceDraft = {
  type: 'shared' | 'worktree';
  sharedPath: string;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  startPoint: string;
};

export function WorkspaceFields({ value, onChange }: {
  value: WorkspaceDraft;
  onChange: (next: WorkspaceDraft) => void;
}) {
  const update = (key: keyof WorkspaceDraft) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...value, [key]: event.target.value });

  return <fieldset>
    <legend>Workspace</legend>
    <label>Workspace type
      <select aria-label="Workspace type" value={value.type} onChange={update('type')}>
        <option value="shared">Shared folder</option>
        <option value="worktree">Isolated Git worktree</option>
      </select>
    </label>
    {value.type === 'shared' ? <label>Shared folder path
      <input aria-label="Shared folder path" value={value.sharedPath} onChange={update('sharedPath')} required />
    </label> : <>
      <label>Repository<input aria-label="Repository" value={value.repositoryPath} onChange={update('repositoryPath')} required /></label>
      <label>Branch<input aria-label="Branch" value={value.branch} onChange={update('branch')} required /></label>
      <label>Start point<input aria-label="Start point" value={value.startPoint} onChange={update('startPoint')} required /></label>
      <label>Worktree path<input aria-label="Worktree path" value={value.worktreePath} onChange={update('worktreePath')} required /></label>
    </>}
  </fieldset>;
}
