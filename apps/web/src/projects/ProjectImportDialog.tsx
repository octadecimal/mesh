import * as Dialog from '@radix-ui/react-dialog';
import { useState, type FormEvent } from 'react';

export type ProjectImportSuggestion = {
  displayName: string;
  repositoryPath: string;
};

export type ImportedProject = ProjectImportSuggestion & { id: string };

type ImportFailure = {
  code?: string;
  message?: string;
  details?: { project?: ImportedProject };
};

const isAbsolutePath = (path: string) =>
  /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());

const duplicateProject = (error: unknown): ImportedProject | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const failure = error as ImportFailure;
  return failure.code === 'repository_already_imported'
    ? failure.details?.project
    : undefined;
};

export function ProjectImportDialog({
  open,
  onOpenChange,
  suggestions,
  onImport,
  onImported,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  suggestions: readonly ProjectImportSuggestion[];
  onImport: (input: {
    repositoryPath: string;
    displayName?: string;
  }) => Promise<ImportedProject>;
  onImported?: (project: ImportedProject) => void;
}) {
  const [repositoryPath, setRepositoryPath] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const selectSuggestion = (suggestion: ProjectImportSuggestion) => {
    setRepositoryPath(suggestion.repositoryPath);
    setDisplayName(suggestion.displayName);
    setError(undefined);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isAbsolutePath(repositoryPath)) {
      setError('Enter an absolute repository path.');
      return;
    }
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const project = await onImport({
        repositoryPath: repositoryPath.trim(),
        displayName: displayName.trim() || undefined,
      });
      onImported?.(project);
      onOpenChange?.(false);
    } catch (caught) {
      const existing = duplicateProject(caught);
      if (existing) {
        onImported?.(existing);
        onOpenChange?.(false);
        return;
      }
      const failure = caught as ImportFailure;
      setError(failure.message ?? 'The project could not be imported.');
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
          aria-describedby="project-import-description"
        >
          <div className="dialog-heading">
            <span className="eyebrow">Project setup</span>
            <Dialog.Title>Import repository</Dialog.Title>
            <Dialog.Description id="project-import-description">
              Import a local Git repository explicitly to create its project.
            </Dialog.Description>
          </div>
          {error ? (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          ) : null}
          {suggestions.length ? (
            <section
              className="project-suggestions"
              aria-label="Suggested repositories"
            >
              <h3>Suggested repositories</h3>
              <p>Suggestions are not imported projects.</p>
              <ul>
                {suggestions.map((suggestion) => (
                  <li key={suggestion.repositoryPath}>
                    <div>
                      <strong>{suggestion.displayName}</strong>
                      <code>{suggestion.repositoryPath}</code>
                    </div>
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => selectSuggestion(suggestion)}
                    >
                      Use {suggestion.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <form className="dialog-form" onSubmit={submit}>
            <label>
              Repository path
              <input
                aria-label="Repository path"
                autoFocus
                required
                value={repositoryPath}
                onChange={(event) => setRepositoryPath(event.target.value)}
              />
            </label>
            <label>
              Project name (optional)
              <input
                aria-label="Project name (optional)"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={pending}
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? 'Importing project…' : 'Import project'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
