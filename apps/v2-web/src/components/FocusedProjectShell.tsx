import { useState, type KeyboardEvent } from 'react';

import type { WorkerExecution } from '@mesh/v2-contracts';

import { ExecutionActivity } from './ExecutionActivity';
import type { ProjectShellViewModel } from './shell-state';

const futurePanes = ['PM Chat', 'Board', 'Requirements'] as const;

function disabledInterruptReason(status: ProjectShellViewModel['status']) {
  if (status === 'stale') return 'Wait for a fresh project snapshot before interrupting.';
  if (status === 'disconnected') return 'Reconnect before interrupting an execution.';
  return undefined;
}

export function FocusedProjectShell({
  model,
  onDeselect,
  onInterrupt,
}: {
  model: ProjectShellViewModel;
  onDeselect: () => void;
  onInterrupt: (execution: WorkerExecution) => void;
}) {
  const [activePane, setActivePane] = useState<(typeof futurePanes)[number]>('Board');
  if (model.status === 'loading') {
    return <main className="v2-shell"><p role="status">Loading project {model.projectId}…</p></main>;
  }

  const snapshot = model.snapshot;
  if (snapshot === undefined) {
    return (
      <main className="v2-shell">
        <p role="status">{model.status === 'disconnected' ? model.message : 'Project unavailable.'}</p>
        <button type="button" onClick={onDeselect}>Deselect project</button>
      </main>
    );
  }
  const interruptReason = disabledInterruptReason(model.status);
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    setActivePane(futurePanes[(index + offset + futurePanes.length) % futurePanes.length]);
  }

  return (
    <main className="v2-shell" aria-labelledby="focused-project-heading">
      <header className="v2-shell-header">
        <div>
          <p className="v2-eyebrow">Focused project</p>
          <h1 id="focused-project-heading">{snapshot.project.displayName}</h1>
          <p>{snapshot.project.repositoryPath}</p>
        </div>
        <button type="button" onClick={onDeselect}>Deselect project</button>
      </header>
      {model.status === 'stale' || model.status === 'disconnected' ? (
        <p role="status" className="v2-connection-status">{model.message}</p>
      ) : null}
      <p className="v2-cursors">Domain cursor {snapshot.cursors.domain}; runtime cursor {snapshot.cursors.runtime}</p>
      <section aria-labelledby="profiles-heading">
        <h2 id="profiles-heading">Approved profiles</h2>
        <ul>
          {snapshot.profiles.map((profile) => <li key={profile.profileId}>{profile.document.metadata.displayName} · revision {profile.profileRevision}</li>)}
        </ul>
      </section>
      <section aria-labelledby="activity-heading">
        <h2 id="activity-heading">Worker activity</h2>
        {snapshot.executions.length === 0 ? <p>No worker executions yet.</p> : (
          <ul className="v2-execution-list">
            {snapshot.executions.map((execution) => (
              <li key={execution.id}>
                <ExecutionActivity execution={execution} />
                <button
                  type="button"
                  disabled={interruptReason !== undefined}
                  aria-describedby={interruptReason ? `interrupt-reason-${execution.id}` : undefined}
                  onClick={() => onInterrupt(execution)}
                >
                  Interrupt execution
                </button>
                {interruptReason ? <p id={`interrupt-reason-${execution.id}`}>{interruptReason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Future workflow panes">
        <div role="tablist" aria-label="Project panes">
          {futurePanes.map((pane, index) => (
            <button
              key={pane}
              id={`pane-tab-${pane}`}
              role="tab"
              type="button"
              aria-selected={activePane === pane}
              aria-controls={`pane-${pane}`}
              tabIndex={activePane === pane ? 0 : -1}
              onClick={() => setActivePane(pane)}
              onKeyDown={(event) => moveTab(event, index)}
            >
              {pane}
            </button>
          ))}
        </div>
        {futurePanes.map((pane) => (
          <section key={pane} id={`pane-${pane}`} role="tabpanel" aria-labelledby={`pane-tab-${pane}`} hidden={activePane !== pane}>
            <h2>{pane}</h2>
            <p>Available in a later milestone</p>
          </section>
        ))}
      </section>
      {snapshot.attentionItems.length > 0 ? (
        <section aria-label="Attention items">
          <h2>Attention items</h2>
          <ul>{snapshot.attentionItems.map((item) => <li key={`${item.executionId}-${item.code}`}>{item.message}</li>)}</ul>
        </section>
      ) : null}
    </main>
  );
}
