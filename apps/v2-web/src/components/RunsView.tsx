import { useEffect, useState } from 'react';
import type * as React from 'react';

import type { GlobalRunSummary } from '../app/global-projection';

const lifecycleLabel = (lifecycle: GlobalRunSummary['lifecycle']) => {
  const words = lifecycle.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function RunsView({
  runs,
  projectId,
  selectedId,
  onNavigate,
}: {
  runs: readonly GlobalRunSummary[];
  projectId?: string;
  selectedId?: string;
  onNavigate(href: string): void;
}): React.JSX.Element {
  const filteredRuns = projectId
    ? runs.filter((run) => run.projectId === projectId)
    : runs;
  const activeRuns = filteredRuns.filter(({ active }) => active);
  const historyRuns = filteredRuns.filter(({ active }) => !active);
  const selectedRun = selectedId
    ? filteredRuns.find(({ executionId }) => executionId === selectedId)
    : undefined;
  const preferredRun = selectedRun ?? activeRuns[0] ?? historyRuns[0];
  const [tab, setTab] = useState<'active' | 'history'>(
    preferredRun && !preferredRun.active ? 'history' : 'active',
  );
  useEffect(() => {
    if (selectedRun) {
      setTab(selectedRun.active ? 'active' : 'history');
    } else if (activeRuns.length > 0) {
      setTab('active');
    } else if (historyRuns.length > 0) {
      setTab('history');
    }
  }, [selectedId, selectedRun?.active, activeRuns.length, historyRuns.length]);
  const rows = tab === 'active' ? activeRuns : historyRuns;
  const selected =
    rows.find(({ executionId }) => executionId === selectedId) ?? rows[0];

  return (
    <section className="v2-runs-view" aria-label="Runs">
      <div role="tablist" aria-label="Run state">
        <button
          id="active-runs-tab"
          type="button"
          role="tab"
          aria-selected={tab === 'active'}
          aria-controls="active-runs-panel"
          onClick={() => setTab('active')}
        >
          Active {activeRuns.length}
        </button>
        <button
          id="history-runs-tab"
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          aria-controls="history-runs-panel"
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>
      <div
        id={`${tab}-runs-panel`}
        role="tabpanel"
        aria-labelledby={`${tab}-runs-tab`}
      >
        {!selected ? (
          <p>{tab === 'active' ? 'No active runs.' : 'No run history.'}</p>
        ) : (
          <div className="v2-master-detail">
            <ul
              className="v2-master-list"
              aria-label={tab === 'active' ? 'Active runs' : 'History runs'}
            >
              {rows.map((run) => (
                <li key={`${run.projectId}:${run.executionId}`}>
                  <a
                    href={run.href}
                    aria-current={
                      selected.executionId === run.executionId
                        ? 'true'
                        : undefined
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate(run.href);
                    }}
                  >
                    <strong>{run.title}</strong>
                    <span>{run.projectName}</span>
                    <span>{lifecycleLabel(run.lifecycle)}</span>
                  </a>
                </li>
              ))}
            </ul>
            <section className="v2-detail" aria-label="Run details">
              <p
                className={`v2-state ${selected.active ? 'v2-state-runtime' : ''}`}
              >
                {selected.active ? 'Active' : 'History'}
              </p>
              <h2>{selected.title}</h2>
              <dl>
                <dt>Project</dt>
                <dd>{selected.projectName}</dd>
                <dt>Lifecycle</dt>
                <dd>{lifecycleLabel(selected.lifecycle)}</dd>
                <dt>Last updated</dt>
                <dd>
                  <time dateTime={selected.updatedAt}>
                    {selected.updatedAt}
                  </time>
                </dd>
              </dl>
              <a
                href={selected.href}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(selected.href);
                }}
              >
                Open run in project
              </a>
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
