import type { V2ProjectSnapshot } from '@mesh/v2-contracts';
import type { MouseEvent } from 'react';

import type { GlobalAttentionItem } from '../app/global-projection';
import { appHref } from '../app/routes';

const actionLabel = (kind: GlobalAttentionItem['kind']) =>
  kind === 'failure'
    ? 'Review run'
    : kind === 'decision'
      ? 'Review plan'
      : kind === 'stale'
        ? 'Review Board'
        : 'Open Board';

export function ProjectOverview({
  snapshot,
  attention,
  onNavigate,
}: {
  snapshot: V2ProjectSnapshot;
  attention: readonly GlobalAttentionItem[];
  onNavigate(href: string): void;
}) {
  const planHref = appHref({
    page: 'project',
    projectId: snapshot.project.id,
    artifact: 'plans',
  });
  const requirements =
    snapshot.intentLedger?.records.filter(
      ({ content }) => content.type === 'requirement',
    ).length ?? 0;
  const activeExecutions = attention.filter(({ kind }) => kind === 'runtime');
  const actions = attention.filter(({ kind }) => kind !== 'runtime');
  const actionableTasks = actions.filter(({ kind }) => kind === 'ready');
  const planStatus = !snapshot.intentLedger
    ? 'Project intent is not approved.'
    : !snapshot.deliveryPlan
      ? 'Delivery plan is not approved.'
      : snapshot.board.stale
        ? 'Delivery plan is stale.'
        : 'Delivery plan is approved.';
  const planAction = !snapshot.intentLedger
    ? 'Plan project intent'
    : !snapshot.deliveryPlan
      ? 'Create delivery plan'
      : 'Review delivery plan';

  const navigate = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(href);
  };

  return (
    <article className="v2-project-overview">
      <header>
        <p className="v2-eyebrow">Project overview</p>
        <h2>{snapshot.project.displayName}</h2>
        <p>{requirements} requirements</p>
      </header>

      <div className="v2-overview-grid">
        <section aria-labelledby="overview-plan-heading">
          <h3 id="overview-plan-heading">Intent and plan</h3>
          <p>{planStatus}</p>
          <a href={planHref} onClick={navigate(planHref)}>
            {planAction}
          </a>
        </section>

        <section aria-labelledby="overview-board-heading">
          <h3 id="overview-board-heading">Board</h3>
          <p>
            {actionableTasks.length}{' '}
            {actionableTasks.length === 1
              ? 'actionable task'
              : 'actionable tasks'}
          </p>
        </section>

        <section aria-labelledby="overview-runs-heading">
          <h3 id="overview-runs-heading">Active executions</h3>
          <p>
            {activeExecutions.length}{' '}
            {activeExecutions.length === 1
              ? 'active execution'
              : 'active executions'}
          </p>
          {activeExecutions.length > 0 ? (
            <ul>
              {activeExecutions.map((item) => (
                <li key={item.id}>
                  <a href={item.href} onClick={navigate(item.href)}>
                    {item.title}
                  </a>{' '}
                  · {item.description}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <section aria-labelledby="overview-actions-heading">
        <h3 id="overview-actions-heading">Next actions</h3>
        {actions.length === 0 ? (
          <p>No project actions need attention.</p>
        ) : (
          <ul className="v2-overview-actions">
            {actions.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </div>
                <a href={item.href} onClick={navigate(item.href)}>
                  {actionLabel(item.kind)}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="profiles-heading">
        <h3 id="profiles-heading">Approved profiles</h3>
        {snapshot.profiles.length === 0 ? (
          <p>No approved profiles.</p>
        ) : (
          <ul>
            {snapshot.profiles.map((profile) => (
              <li key={profile.profileId}>
                {profile.document.metadata.displayName} · revision{' '}
                {profile.profileRevision}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
