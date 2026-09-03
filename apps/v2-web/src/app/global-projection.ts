import type { V2ProjectSnapshot, WorkerExecution } from '@mesh/v2-contracts';

import { appHref } from './routes';

export type GlobalAttentionKind =
  | 'runtime'
  | 'failure'
  | 'decision'
  | 'stale'
  | 'ready';

export type GlobalAttentionItem = Readonly<{
  id: string;
  projectId: string;
  projectName: string;
  kind: GlobalAttentionKind;
  title: string;
  description: string;
  href: string;
  sortRevision: number;
}>;

export type GlobalRunSummary = Readonly<{
  executionId: string;
  projectId: string;
  projectName: string;
  title: string;
  lifecycle: WorkerExecution['lifecycle'];
  active: boolean;
  updatedAt: string;
  href: string;
}>;

const attentionOrder: Record<GlobalAttentionKind, number> = {
  runtime: 0,
  failure: 1,
  decision: 2,
  stale: 3,
  ready: 4,
};

const active = (lifecycle: WorkerExecution['lifecycle']) =>
  lifecycle === 'starting' || lifecycle === 'running';

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export function attentionFromSnapshots(
  snapshots: readonly V2ProjectSnapshot[],
): readonly GlobalAttentionItem[] {
  const items = new Map<string, GlobalAttentionItem>();
  const add = (item: GlobalAttentionItem) => items.set(item.id, item);

  for (const snapshot of snapshots) {
    const { project, board } = snapshot;
    const projectName = project.displayName;
    for (const execution of snapshot.executions) {
      if (!active(execution.lifecycle)) continue;
      add({
        id: `runtime:${project.id}:${execution.id}`,
        projectId: project.id,
        projectName,
        kind: 'runtime',
        title: execution.assignment.title,
        description:
          execution.lifecycle === 'starting' ? 'Starting' : 'Running',
        href: appHref({
          page: 'project',
          projectId: project.id,
          artifact: 'runs',
          selectedId: execution.id,
        }),
        sortRevision: execution.revision,
      });
    }
    for (const item of snapshot.attentionItems) {
      const execution = snapshot.executions.find(
        ({ id }) => id === item.executionId,
      );
      add({
        id: `failure:${project.id}:${item.executionId}:${item.code}`,
        projectId: project.id,
        projectName,
        kind: 'failure',
        title: execution?.assignment.title ?? 'Execution needs attention',
        description: item.message,
        href: appHref({
          page: 'project',
          projectId: project.id,
          artifact: 'runs',
          selectedId: item.executionId,
        }),
        sortRevision: execution?.revision ?? snapshot.cursors.runtime,
      });
    }
    const cycle = snapshot.planningCycles
      .filter(
        ({ cycle }) =>
          cycle.lifecycle !== 'approved' &&
          cycle.lifecycle !== 'proposal_rejected' &&
          cycle.lifecycle !== 'abandoned',
      )
      .reduce<(typeof snapshot.planningCycles)[number] | undefined>(
        (latest, candidate) => {
          if (latest === undefined) return candidate;
          return candidate.cycle.revision > latest.cycle.revision ||
            (candidate.cycle.revision === latest.cycle.revision &&
              (compareText(candidate.cycle.updatedAt, latest.cycle.updatedAt) >
                0 ||
                (candidate.cycle.updatedAt === latest.cycle.updatedAt &&
                  compareText(candidate.cycle.id, latest.cycle.id) > 0)))
            ? candidate
            : latest;
        },
        undefined,
      );
    const proposals =
      cycle?.purpose.kind === 'delivery_plan'
        ? cycle.deliveryPlanProposals
        : cycle?.proposals;
    const proposal = proposals
      ?.filter(({ lifecycle }) => lifecycle === 'awaiting_approval')
      .reduce<
        (typeof proposals)[number] | undefined
      >((latest, candidate) => (latest === undefined || candidate.revision > latest.revision ? candidate : latest), undefined);
    if (cycle !== undefined && proposal !== undefined) {
      add({
        id: `decision:${cycle.cycle.id}:${proposal.id}`,
        projectId: project.id,
        projectName,
        kind: 'decision',
        title: 'Decision needed',
        description:
          'summary' in proposal
            ? proposal.summary
            : 'Delivery plan proposal awaiting approval.',
        href: appHref({
          page: 'project',
          projectId: project.id,
          artifact: 'plans',
        }),
        sortRevision: proposal.revision,
      });
    }
    if (board.stale) {
      add({
        id: `stale:${project.id}`,
        projectId: project.id,
        projectName,
        kind: 'stale',
        title: 'Board is stale',
        description:
          'Refresh the delivery plan before working from this Board.',
        href: appHref({
          page: 'project',
          projectId: project.id,
          artifact: 'board',
        }),
        sortRevision: board.deliveryPlanRevision ?? snapshot.cursors.domain,
      });
    }
    for (const card of board.cards) {
      if (card.readiness.state !== 'actionable') continue;
      add({
        id: `ready:${project.id}:${card.taskId}`,
        projectId: project.id,
        projectName,
        kind: 'ready',
        title: card.title,
        description: card.outcome,
        href: appHref({
          page: 'project',
          projectId: project.id,
          artifact: 'board',
          selectedId: card.taskId,
        }),
        sortRevision: card.taskCurrentRevision,
      });
    }
  }

  return [...items.values()].sort(
    (left, right) =>
      attentionOrder[left.kind] - attentionOrder[right.kind] ||
      right.sortRevision - left.sortRevision ||
      compareText(left.projectName, right.projectName) ||
      compareText(left.id, right.id),
  );
}

export function runsFromSnapshots(
  snapshots: readonly V2ProjectSnapshot[],
): readonly GlobalRunSummary[] {
  const runs = new Map<string, GlobalRunSummary>();
  for (const snapshot of snapshots) {
    for (const execution of snapshot.executions) {
      const key = `${snapshot.project.id}:${execution.id}`;
      runs.set(key, {
        executionId: execution.id,
        projectId: snapshot.project.id,
        projectName: snapshot.project.displayName,
        title: execution.assignment.title,
        lifecycle: execution.lifecycle,
        active: active(execution.lifecycle),
        updatedAt: execution.updatedAt,
        href: appHref({
          page: 'project',
          projectId: snapshot.project.id,
          artifact: 'runs',
          selectedId: execution.id,
        }),
      });
    }
  }
  return [...runs.values()].sort(
    (left, right) =>
      Number(right.active) - Number(left.active) ||
      compareText(right.updatedAt, left.updatedAt) ||
      compareText(left.projectName, right.projectName) ||
      compareText(left.executionId, right.executionId),
  );
}
