import { randomUUID } from 'node:crypto';

import {
  type ExecutionRunView,
  type ResolvedWorkerProfileSnapshot,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { inImmediateTransaction } from '../db/database.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import {
  ExecutionRunRepository,
  ExecutionRunRevisionConflictError,
} from './execution-run-repository.js';

const fixtures: ReturnType<typeof createV2TestDatabase>[] = [];
const now = '2026-09-02T00:00:00.000Z';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const setup = () => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  return {
    fixture,
    repository: new ExecutionRunRepository(fixture.database),
  };
};

const viewFor = (
  fixture: ReturnType<typeof createV2TestDatabase>,
): ExecutionRunView => {
  const runId = randomUUID();
  const itemId = randomUUID();
  const taskId = randomUUID();
  const profileSnapshot: ResolvedWorkerProfileSnapshot = {
    profileId: fixture.profileRevision.profileId,
    projectId: null,
    profileRevision: 1,
    baseProfileId: null,
    baseRevision: null,
    document: fixture.profileRevision.document,
    digest: fixture.profileRevision.digest,
  };
  const item = {
    id: itemId,
    runId,
    projectId: fixture.project.id,
    taskId,
    ordinal: 0,
    revision: 1,
    lifecycle: 'waiting' as const,
    taskContractRevision: 1,
    taskCurrentRevision: 1,
    requirementRevisions: [],
    prerequisiteTaskIds: [],
    profileSnapshot,
    launchIdempotencyKey: `execution-run:${itemId}`,
    developerAttemptId: null,
    attention: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
  return {
    run: {
      id: runId,
      projectId: fixture.project.id,
      revision: 1,
      lifecycle: 'running',
      completionReason: null,
      deliveryPlanId: randomUUID(),
      deliveryPlanRevision: 1,
      intentRevision: 1,
      ledgerRevision: 1,
      repositoryIdentity: fixture.project.repositoryIdentity,
      baseCommit: fixture.project.headCommit,
      concurrencyLimit: 1,
      subscriptionCapacityConfirmed: true,
      attention: null,
      itemIds: [itemId],
      counts: {
        waiting: 1,
        launchPending: 0,
        active: 0,
        completed: 0,
        attentionRequired: 0,
        notStarted: 0,
      },
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    },
    items: [item],
  };
};

describe('ExecutionRunRepository', () => {
  it('creates and reads a validated aggregate in deterministic order', () => {
    const { fixture, repository } = setup();
    const view = viewFor(fixture);

    inImmediateTransaction(fixture.database, () =>
      repository.createInTransaction(view),
    );

    expect(repository.view(view.run.id)).toEqual(view);
    expect(repository.listForProject(fixture.project.id)).toEqual([view]);
    expect(repository.nonterminal()).toEqual([view]);
  });

  it('requires a transaction for mutations and one nonterminal run per project', () => {
    const { fixture, repository } = setup();
    const first = viewFor(fixture);
    expect(() => repository.createInTransaction(first)).toThrow(/transaction/i);
    inImmediateTransaction(fixture.database, () =>
      repository.createInTransaction(first),
    );
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.createInTransaction(viewFor(fixture)),
      ),
    ).toThrow(/unique|nonterminal/i);
  });

  it('replaces an aggregate only at its expected revision', () => {
    const { fixture, repository } = setup();
    const first = viewFor(fixture);
    inImmediateTransaction(fixture.database, () =>
      repository.createInTransaction(first),
    );
    const paused: ExecutionRunView = {
      run: {
        ...first.run,
        revision: 2,
        lifecycle: 'paused',
        updatedAt: '2026-09-02T00:01:00.000Z',
      },
      items: first.items,
    };
    inImmediateTransaction(fixture.database, () =>
      repository.replaceInTransaction(paused, 1),
    );
    expect(repository.view(first.run.id)).toEqual(paused);
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.replaceInTransaction(
          {
            ...paused,
            run: { ...paused.run, revision: 3 },
          },
          1,
        ),
      ),
    ).toThrow(ExecutionRunRevisionConflictError);
  });
});
