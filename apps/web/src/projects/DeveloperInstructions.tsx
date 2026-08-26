import { useEffect, useState, type FormEvent } from 'react';

import type { Project } from '@mesh-session-platform/contracts';

type SaveInput = {
  content: string;
  expectedRevision: number;
};

type CommandFailure = {
  code?: string;
  message?: string;
  details?: { project?: Project };
};

const failureDetails = (caught: unknown): CommandFailure | undefined =>
  caught && typeof caught === 'object' ? (caught as CommandFailure) : undefined;

export function DeveloperInstructions({
  project,
  disabled,
  onSave,
}: {
  project: Project;
  disabled: boolean;
  onSave: (input: SaveInput) => Promise<void>;
}) {
  const canonical = project.developerInstructions.content;
  const [draft, setDraft] = useState(canonical);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [conflictRevision, setConflictRevision] = useState<number>();
  const waitingForResync =
    conflictRevision !== undefined && project.revision < conflictRevision;

  useEffect(() => {
    setDraft(canonical);
    setError(undefined);
    setConflictRevision((current) =>
      current !== undefined && project.revision >= current
        ? undefined
        : current,
    );
  }, [
    canonical,
    project.id,
    project.developerInstructions.revision,
    project.revision,
  ]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || pending || waitingForResync || draft === canonical) return;
    setPending(true);
    setError(undefined);
    try {
      await onSave({ content: draft, expectedRevision: project.revision });
    } catch (caught) {
      const failure = failureDetails(caught);
      const revision = failure?.details?.project?.revision;
      if (failure?.code === 'project_revision_conflict' && revision) {
        setConflictRevision(revision);
        setError(
          `The server is at revision ${revision}. Waiting for project resync.`,
        );
      } else {
        setError(
          failure?.message ?? 'Developer instructions could not be saved.',
        );
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="developer-instructions"
      aria-label="Developer instructions editor"
    >
      <div className="task-section-heading">
        <div>
          <span className="eyebrow">Developer execution</span>
          <h3>Developer instructions</h3>
        </div>
        <span>
          Instructions revision {project.developerInstructions.revision}
        </span>
      </div>
      <p>
        These instructions are saved as project state and apply to future
        Developer execution cycles.
      </p>
      {error ? (
        <p className="notice notice-warning" role="alert">
          {error}
        </p>
      ) : null}
      <form onSubmit={save}>
        <label>
          Developer instructions
          <textarea
            aria-label="Developer instructions"
            disabled={disabled || pending || waitingForResync}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button
            className="button button-ghost"
            type="button"
            disabled={
              disabled || pending || waitingForResync || draft === canonical
            }
            onClick={() => {
              setDraft(canonical);
              setError(undefined);
            }}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            type="submit"
            disabled={
              disabled || pending || waitingForResync || draft === canonical
            }
          >
            {pending ? 'Saving instructions…' : 'Save instructions'}
          </button>
        </div>
      </form>
    </section>
  );
}
