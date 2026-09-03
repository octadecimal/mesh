import type * as React from 'react';

import { runsFromSnapshots } from '../app/global-projection';
import type { GlobalProjectSnapshotState } from '../app/use-global-project-snapshots';
import { RunsView } from './RunsView';

export function GlobalRunsPage({
  state,
  onNavigate,
}: {
  state: GlobalProjectSnapshotState;
  onNavigate(href: string): void;
}): React.JSX.Element {
  return (
    <section className="v2-page" aria-labelledby="global-runs-heading">
      <header className="v2-page-heading">
        <div>
          <p className="v2-eyebrow">All projects</p>
          <h1 id="global-runs-heading">Runs</h1>
        </div>
        <button type="button" onClick={state.refresh}>
          Refresh runs
        </button>
      </header>
      {state.status !== 'ready' && state.snapshots.length === 0 ? (
        <p role="status">Loading runs…</p>
      ) : null}
      {state.refreshing && state.snapshots.length > 0 ? (
        <p role="status">Refreshing runs…</p>
      ) : null}
      {state.failures.length > 0 ? (
        <div className="v2-warning" role="alert">
          <p>Some projects could not be refreshed.</p>
          <ul>
            {state.failures.map((failure) => {
              const project = state.snapshots.find(
                ({ project }) => project.id === failure.projectId,
              )?.project;
              return (
                <li key={failure.projectId}>
                  <strong>{project?.displayName ?? failure.projectId}</strong>
                  {' — '}
                  {failure.message}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {state.status === 'ready' || state.snapshots.length > 0 ? (
        <RunsView
          runs={runsFromSnapshots(state.snapshots)}
          onNavigate={onNavigate}
        />
      ) : null}
    </section>
  );
}
