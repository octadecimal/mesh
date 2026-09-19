import * as Dialog from '@radix-ui/react-dialog';
import { useState, type FormEvent } from 'react';

import type { ImportedProject } from './ProjectImportDialog';

const isAbsolutePath = (path: string) =>
  /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());

export function ProjectCreateDialog({
  open,
  onOpenChange,
  onBrowse,
  onCreate,
  onCreated,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onBrowse?: () => Promise<string | null>;
  onCreate: (input: {
    parentDirectory: string;
    name: string;
  }) => Promise<ImportedProject>;
  onCreated?: (project: ImportedProject) => void;
}) {
  const [name, setName] = useState('');
  const [parentDirectory, setParentDirectory] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [browsePending, setBrowsePending] = useState(false);
  const browse = async () => {
    if (!onBrowse || browsePending || pending) return;
    setBrowsePending(true);
    setError(undefined);
    try {
      const path = await onBrowse();
      if (path) setParentDirectory(path);
    } catch (caught) {
      setError(
        (caught as { message?: string }).message ??
          'The folder picker could not be opened.',
      );
    } finally {
      setBrowsePending(false);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || browsePending) return;
    if (!name.trim() || !isAbsolutePath(parentDirectory)) {
      setError('Enter a project name and an absolute parent directory.');
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const project = await onCreate({
        name: name.trim(),
        parentDirectory: parentDirectory.trim(),
      });
      onCreated?.(project);
      onOpenChange?.(false);
    } catch (caught) {
      setError(
        (caught as { message?: string }).message ??
          'The project could not be created.',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          aria-describedby="project-create-description"
        >
          <div className="dialog-heading">
            <span className="eyebrow">Project setup</span>
            <Dialog.Title>New project</Dialog.Title>
            <Dialog.Description id="project-create-description">
              Create a new folder and Git repository without an initial commit.
            </Dialog.Description>
          </div>
          {error ? (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          ) : null}
          <form className="dialog-form" onSubmit={submit}>
            <label>
              Project name
              <input
                aria-label="Project name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              Parent directory
              <input
                aria-label="Parent directory"
                required
                value={parentDirectory}
                onChange={(event) => setParentDirectory(event.target.value)}
              />
              <button
                className="button button-secondary"
                type="button"
                aria-label="Browse for parent folder"
                onClick={() => void browse()}
                disabled={!onBrowse || browsePending || pending}
              >
                {browsePending ? 'Opening folder picker…' : 'Browse…'}
              </button>
            </label>
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={pending || browsePending}
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending || browsePending}
              >
                {pending ? 'Creating project…' : 'Create project'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
