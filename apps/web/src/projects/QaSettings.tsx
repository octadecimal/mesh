import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { Project, ReviewPolicy } from '@mesh-session-platform/contracts';

type SaveInput = {
  content: string;
  reviewPolicy: ReviewPolicy;
  expectedRevision: number;
};

type CommandFailure = {
  code?: string;
  message?: string;
  details?: { project?: Project };
};

const failureDetails = (caught: unknown): CommandFailure | undefined =>
  caught && typeof caught === 'object' ? (caught as CommandFailure) : undefined;

export function QaSettings({
  project,
  disabled,
  saving = false,
  onSave,
}: {
  project: Project;
  disabled: boolean;
  saving?: boolean;
  onSave: (input: SaveInput) => Promise<void>;
}) {
  const canonical = project.qaConfiguration ?? {
    instructions: {
      content: '',
      revision: 1,
      updatedAt: project.updatedAt,
      updatedBy: null,
    },
    reviewPolicy: 'manual' as const,
    revision: 1,
    updatedAt: project.updatedAt,
    updatedBy: null,
  };
  const [content, setContent] = useState(canonical.instructions.content);
  const [reviewPolicy, setReviewPolicy] = useState<ReviewPolicy>(
    canonical.reviewPolicy,
  );
  const [pending, setPending] = useState(false);
  const [confirmingAutonomous, setConfirmingAutonomous] = useState(false);
  const [error, setError] = useState<string>();
  const [conflictRevision, setConflictRevision] = useState<number>();
  const projectId = useRef(project.id);
  const dirty = useRef(false);
  const keepManualButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const waitingForResync =
    conflictRevision !== undefined && canonical.revision < conflictRevision;
  const isSaving = saving || pending;
  const changed =
    content !== canonical.instructions.content ||
    reviewPolicy !== canonical.reviewPolicy;

  useEffect(() => {
    if (projectId.current !== project.id) {
      projectId.current = project.id;
      dirty.current = false;
      setContent(canonical.instructions.content);
      setReviewPolicy(canonical.reviewPolicy);
      setError(undefined);
      setConflictRevision(undefined);
      setConfirmingAutonomous(false);
      return;
    }
    if (!dirty.current || !changed) {
      dirty.current = false;
      setContent(canonical.instructions.content);
      setReviewPolicy(canonical.reviewPolicy);
      setError(undefined);
      setConflictRevision(undefined);
    }
  }, [
    canonical.instructions.content,
    canonical.reviewPolicy,
    changed,
    project.id,
  ]);

  const persist = async () => {
    if (disabled || isSaving || waitingForResync || !changed) return;
    setConfirmingAutonomous(false);
    setPending(true);
    setError(undefined);
    try {
      await onSave({
        content,
        reviewPolicy,
        expectedRevision: canonical.revision,
      });
    } catch (caught) {
      const failure = failureDetails(caught);
      const revision = failure?.details?.project?.qaConfiguration?.revision;
      if (failure?.code === 'project_revision_conflict' && revision) {
        setConflictRevision(revision);
        setError(
          `The server is at QA configuration revision ${revision}. Waiting for authoritative project refresh.`,
        );
      } else {
        setError(failure?.message ?? 'QA settings could not be saved.');
      }
    } finally {
      setPending(false);
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      reviewPolicy === 'autonomous_review' &&
      canonical.reviewPolicy !== 'autonomous_review'
    ) {
      setConfirmingAutonomous(true);
      return;
    }
    void persist();
  };

  const reset = () => {
    dirty.current = false;
    setContent(canonical.instructions.content);
    setReviewPolicy(canonical.reviewPolicy);
    setError(undefined);
    setConflictRevision(undefined);
    setConfirmingAutonomous(false);
  };

  return (
    <Dialog.Root
      open={confirmingAutonomous}
      onOpenChange={setConfirmingAutonomous}
    >
      <section className="qa-settings" aria-label="QA settings">
        <div className="task-section-heading">
          <div>
            <span className="eyebrow">QA execution</span>
            <h3>QA settings</h3>
          </div>
          <span>QA configuration revision {canonical.revision}</span>
        </div>
        <p>
          These instructions and the review policy apply only to future QA
          eligibility. Changing policy does not process existing review tasks
          retroactively.
        </p>
        <p>
          Disabling autonomous review does not interrupt a running QA session;
          use the task’s Pause automation control to stop later automatic steps.
        </p>
        {error ? (
          <p className="notice notice-warning" role="alert">
            {error}
          </p>
        ) : null}
        <form onSubmit={save}>
          <label>
            QA instructions
            <textarea
              aria-label="QA instructions"
              disabled={disabled || isSaving || waitingForResync}
              value={content}
              onChange={(event) => {
                dirty.current = true;
                setContent(event.target.value);
              }}
            />
          </label>
          <label>
            Review policy
            <select
              aria-label="Review policy"
              disabled={disabled || isSaving || waitingForResync}
              value={reviewPolicy}
              onChange={(event) => {
                dirty.current = true;
                setReviewPolicy(event.target.value as ReviewPolicy);
              }}
            >
              <option value="manual">Manual review</option>
              <option value="autonomous_review">Autonomous review</option>
            </select>
          </label>
          <div className="dialog-actions">
            <button
              className="button button-ghost"
              type="button"
              disabled={disabled || isSaving || waitingForResync || !changed}
              onClick={reset}
            >
              Cancel
            </button>
            <button
              ref={saveButton}
              className="button button-primary"
              type="submit"
              disabled={disabled || isSaving || waitingForResync || !changed}
            >
              {isSaving ? 'Saving QA settings…' : 'Save QA settings'}
            </button>
          </div>
        </form>
      </section>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content qa-autonomy-confirmation"
          aria-describedby="qa-autonomy-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            keepManualButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            saveButton.current?.focus();
          }}
        >
          <div className="dialog-heading">
            <span className="eyebrow">Subscription confirmation</span>
            <Dialog.Title>Enable autonomous review</Dialog.Title>
            <Dialog.Description id="qa-autonomy-description">
              Autonomous review may start or resume Claude sessions and consume
              Claude subscription quota. Mesh uses subscription-backed sessions,
              never API billing.
            </Dialog.Description>
          </div>
          <p>
            Only newly eligible task events are considered; existing review
            tasks are not processed retroactively.
          </p>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button
                ref={keepManualButton}
                className="button button-ghost"
                type="button"
              >
                Keep manual review
              </button>
            </Dialog.Close>
            <button
              className="button button-primary"
              type="button"
              onClick={() => void persist()}
            >
              Enable autonomous review
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
