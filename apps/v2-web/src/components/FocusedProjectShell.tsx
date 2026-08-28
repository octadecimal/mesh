import { useRef, useState, type KeyboardEvent } from 'react';

import type { WorkerExecution } from '@mesh/v2-contracts';

import {
  ExecutionActivity,
  type ChildActivity,
} from './ExecutionActivity';
import type { ProjectShellViewModel } from './shell-state';

const futurePanes = [
  { label: 'Board', slug: 'board' },
  { label: 'Requirements', slug: 'requirements' },
] as const;

type FuturePane = (typeof futurePanes)[number];
type FuturePaneSlug = FuturePane['slug'];

export type ExecutionActivityProjection = {
  childActivities: readonly ChildActivity[];
  diagnosticId?: string;
};

function disabledInterruptReason(status: ProjectShellViewModel['status']) {
  if (status === 'stale') return 'Wait for a fresh project snapshot before interrupting.';
  if (status === 'disconnected') return 'Reconnect before interrupting an execution.';
  return undefined;
}

export function FocusedProjectShell({
  model,
  onDeselect,
  onInterrupt,
  activityByExecutionId = {},
}: {
  model: ProjectShellViewModel;
  onDeselect: () => void;
  onInterrupt: (execution: WorkerExecution) => void;
  activityByExecutionId?: Readonly<Record<string, ExecutionActivityProjection>>;
}) {
  const [activePane, setActivePane] = useState<FuturePaneSlug>('board');
  const tabRefs = useRef<Record<FuturePaneSlug, HTMLButtonElement | null>>({
    board: null,
    requirements: null,
  });
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
  const interruptReason =
    model.status === 'ready'
      ? model.interrupt.enabled
        ? undefined
        : model.interrupt.disabledReason
      : disabledInterruptReason(model.status);
  function activatePane(pane: FuturePane) {
    setActivePane(pane.slug);
    tabRefs.current[pane.slug]?.focus();
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const targetIndex =
      key === 'Home'
        ? 0
        : key === 'End'
          ? futurePanes.length - 1
          : (index + (key === 'ArrowRight' ? 1 : -1) + futurePanes.length) % futurePanes.length;
    activatePane(futurePanes[targetIndex]);
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
      <div className="v2-project-layout">
        <aside className="v2-pm-pane" aria-label="PM Chat">
          <h2>PM Chat</h2>
          <p>Available in a later milestone</p>
        </aside>
        <div className="v2-project-content">
          <section aria-label="Future workflow panes">
            <div role="tablist" aria-label="Project panes">
              {futurePanes.map((pane, index) => (
            <button
              key={pane.slug}
              ref={(element) => { tabRefs.current[pane.slug] = element; }}
              id={`project-pane-tab-${pane.slug}`}
              role="tab"
              type="button"
              aria-selected={activePane === pane.slug}
              aria-controls={`project-pane-panel-${pane.slug}`}
              tabIndex={activePane === pane.slug ? 0 : -1}
              onClick={() => activatePane(pane)}
              onKeyDown={(event) => moveTab(event, index)}
            >
              {pane.label}
            </button>
              ))}
            </div>
            {futurePanes.map((pane) => (
              <section key={pane.slug} id={`project-pane-panel-${pane.slug}`} role="tabpanel" aria-labelledby={`project-pane-tab-${pane.slug}`} hidden={activePane !== pane.slug}>
                <h2>{pane.label}</h2>
                <p>Available in a later milestone</p>
              </section>
            ))}
          </section>
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
                {snapshot.executions.map((execution) => {
                  const activity = activityByExecutionId[execution.id];
                  return (
                    <li key={execution.id}>
                      <ExecutionActivity execution={execution} childActivities={activity?.childActivities} diagnosticId={activity?.diagnosticId} projectCursors={snapshot.cursors} />
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
                  );
                })}
              </ul>
            )}
          </section>
          {snapshot.attentionItems.length > 0 ? (
            <section aria-label="Attention items">
              <h2>Attention items</h2>
              <ul>{snapshot.attentionItems.map((item) => <li key={`${item.executionId}-${item.code}`}>{item.message}</li>)}</ul>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
