import { randomUUID } from 'node:crypto';

import type {
  DeveloperAttempt,
  DomainEvent,
  ManagedWorkspace,
  WorkerExecution,
} from '@mesh/v2-contracts';
import { describe, expect, it } from 'vitest';

import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { reconcileDeveloperAttempts } from './reconcile-developer-attempts.js';

describe('reconcileDeveloperAttempts', () => {
  it('returns an owned dirty replacement activation without publishing or activating it', async () => {
    const fixture = createV2TestDatabase();
    const execution = {
      ...fixture.execution,
      id: randomUUID(),
      projectId: fixture.project.id,
      lifecycle: 'starting',
      revision: 4,
      replacementForExecutionId: fixture.execution.id,
    } as WorkerExecution;
    let attempt = {
      id: randomUUID(),
      projectId: fixture.project.id,
      taskId: randomUUID(),
      ordinal: 1,
      lifecycle: 'interrupted',
      revision: 3,
      deliveryPlanId: randomUUID(),
      deliveryPlanRevision: 1,
      intentRevision: 1,
      ledgerRevision: 1,
      taskContractRevision: 1,
      taskCurrentRevision: 1,
      requirementRevisions: [],
      baseCommit: fixture.project.headCommit,
      profileId: fixture.profileRevision.profileId,
      profileRevision: fixture.profileRevision.revision,
      assignment: {
        kind: 'developer_task',
        projectId: fixture.project.id,
        attemptId: randomUUID(),
      },
      workspace: {
        attemptId: '',
        repositoryPath: fixture.project.repositoryPath,
        repositoryIdentity: fixture.project.repositoryIdentity,
        branch: 'mesh/dev/test',
        path: 'C:/owned-workspace',
        baseCommit: fixture.project.headCommit,
        lifecycle: 'ready',
        ownershipToken: 'owner',
        observedHead: fixture.project.headCommit,
        observedDirty: false,
        failure: null,
        revision: 1,
        createdAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
      controllingExecutionId: execution.id,
      executionIds: [fixture.execution.id, execution.id],
      reportIds: [],
      attention: null,
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
      endedAt: '2026-09-01T12:00:00.000Z',
    } as DeveloperAttempt;
    attempt = {
      ...attempt,
      assignment: { ...attempt.assignment, attemptId: attempt.id },
      workspace: { ...attempt.workspace, attemptId: attempt.id },
    };
    let publishCount = 0;
    let activationCount = 0;

    const recovery = await reconcileDeveloperAttempts({
      database: fixture.database,
      developers: {
        attempt: () => attempt,
        nonterminalAttempts: () => [attempt],
        recordWorkspaceObservationInTransaction: (
          workspace: ManagedWorkspace,
        ) => {
          attempt = { ...attempt, workspace };
          return workspace;
        },
        transitionAttemptInTransaction: (next: DeveloperAttempt) => {
          attempt = next;
          return next;
        },
      },
      executions: {
        get: (id: string) => (id === execution.id ? execution : undefined),
      },
      workspace: {
        observe: async (workspace: ManagedWorkspace) => ({
          ...workspace,
          lifecycle: 'ready' as const,
          observedDirty: true,
          failure: null,
        }),
      },
      planning: { taskExecutionAuthority: () => ({ board: {} }) },
      events: {
        appendDomainInTransaction: (_projectId: string, draft: DomainEvent) =>
          draft,
      },
      barrier: { assertHealthy: () => undefined, trip: () => undefined },
      now: () => '2026-09-01T12:01:00.000Z',
      publishDomain: () => {
        publishCount += 1;
      },
      activateReserved: () => {
        activationCount += 1;
      },
    });

    expect(recovery).toEqual({
      events: [expect.objectContaining({ type: 'developer_attempt.changed' })],
      pendingActivationIds: [execution.id],
    });
    expect(attempt).toMatchObject({
      lifecycle: 'active',
      workspace: { observedDirty: true },
    });
    expect(publishCount).toBe(0);
    expect(activationCount).toBe(0);
    fixture.close();
  });
});
