import { useState } from 'react';
import type * as React from 'react';

import {
  attentionFromSnapshots,
  type GlobalAttentionKind,
} from '../app/global-projection';
import type { GlobalProjectSnapshotState } from '../app/use-global-project-snapshots';

const categoryLabels: Record<GlobalAttentionKind, string> = {
  runtime: 'Active runtime',
  failure: 'Needs recovery',
  decision: 'Decision needed',
  stale: 'Planning is stale',
  ready: 'Ready to start',
};

export function InboxPage({
  state,
  onNavigate,
}: {
  state: GlobalProjectSnapshotState;
  onNavigate(href: string): void;
}): React.JSX.Element {
  const [category, setCategory] = useState<GlobalAttentionKind | 'all'>('all');
  const [projectId, setProjectId] = useState('all');
  const [selectedId, setSelectedId] = useState<string>();
  const items = attentionFromSnapshots(state.snapshots);
  const visibleItems = items.filter(
    (item) =>
      (category === 'all' || item.kind === category) &&
      (projectId === 'all' || item.projectId === projectId),
  );
  const selected =
    visibleItems.find(({ id }) => id === selectedId) ?? visibleItems[0];

  return (
    <section className="v2-page" aria-labelledby="inbox-heading">
      <header className="v2-page-heading">
        <div>
          <p className="v2-eyebrow">Inbox</p>
          <h1 id="inbox-heading">Needs attention</h1>
        </div>
        <button type="button" onClick={state.refresh}>
          Refresh Inbox
        </button>
      </header>
      {state.status !== 'ready' && state.snapshots.length === 0 ? (
        <p role="status">Loading Inbox…</p>
      ) : null}
      {state.refreshing && state.snapshots.length > 0 ? (
        <p role="status">Refreshing Inbox…</p>
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
      {state.status === 'ready' &&
      state.snapshots.length === 0 &&
      state.failures.length === 0 ? (
        <p>No projects have been added yet.</p>
      ) : null}
      {state.snapshots.length > 0 ? (
        <>
          <div className="v2-filters" aria-label="Inbox filters">
            <label>
              Category
              <select
                value={category}
                onChange={(event) =>
                  setCategory(event.target.value as GlobalAttentionKind | 'all')
                }
              >
                <option value="all">All categories</option>
                {Object.entries(categoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="all">All projects</option>
                {state.snapshots.map(({ project }) => (
                  <option key={project.id} value={project.id}>
                    {project.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {items.length === 0 ? <p>No project needs attention.</p> : null}
          {items.length > 0 && visibleItems.length === 0 ? (
            <p>No attention matches these filters.</p>
          ) : null}
          {selected ? (
            <div className="v2-master-detail">
              <section aria-labelledby="attention-queue-heading">
                <h2 id="attention-queue-heading">Attention queue</h2>
                <ul className="v2-master-list">
                  {visibleItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-pressed={selected?.id === item.id}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <strong>{item.title}</strong>
                        <span>{item.projectName}</span>
                        <span>{categoryLabels[item.kind]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="v2-detail" aria-label="Attention details">
                <p className={`v2-state v2-state-${selected.kind}`}>
                  {categoryLabels[selected.kind]}
                </p>
                <h2>{selected.title}</h2>
                <p>{selected.projectName}</p>
                <p>{selected.description}</p>
                <a
                  href={selected.href}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(selected.href);
                  }}
                >
                  Review in project
                </a>
              </section>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
