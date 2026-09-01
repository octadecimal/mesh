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

const now = '2026-09-01T12:01:00.000Z';

const createRecoveryContext = (
  options: {
    attemptLifecycle?: DeveloperAttempt['lifecycle'];
    execution?: WorkerExecution | undefined;
    reportIds?: readonly string[];
    workspace?: Partial<ManagedWorkspace>;
  } = {},
) => {
  const fixture = createV2TestDatabase();
  const execution =
    options.execution === undefined
      ? undefined
      : {
          ...options.execution,
          projectId: fixture.project.id,
        };
  const executionId = execution?.id ?? randomUUID();
  let attempt = {
    id: randomUUID(),
    projectId: fixture.project.id,
    taskId: randomUUID(),
    ordinal: 1,
    lifecycle: options.attemptLifecycle ?? 'interrupted',
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
      attemptId: '',
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
    controllingExecutionId: executionId,
    executionIds: [executionId],
    reportIds: options.reportIds ?? [],
    attention: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    endedAt: '2026-09-01T12:00:00.000Z',
  } as DeveloperAttempt;
  attempt = {
    ...attempt,
    assignment: { ...attempt.assignment, attemptId: attempt.id },
    workspace: {
      ...attempt.workspace,
      ...options.workspace,
      attemptId: attempt.id,
    },
  };
  const executionRecords = new Map<string, WorkerExecution>();
  if (execution) executionRecords.set(execution.id, execution);
  const events: DomainEvent[] = [];
  let onObserve: (() => ManagedWorkspace | undefined) | undefined;

  return {
    fixture,
    executionId,
    events,
    get attempt() {
      return attempt;
    },
    setAttempt(next: DeveloperAttempt) {
      attempt = next;
    },
    setObserveHook(next: (() => ManagedWorkspace | undefined) | undefined) {
      onObserve = next;
    },
    executionRecords,
    reconcile: () =>
      reconcileDeveloperAttempts({
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
        executions: { get: (id: string) => executionRecords.get(id) },
        workspace: {
          observe: async (workspace: ManagedWorkspace) => {
            return onObserve?.() ?? { ...workspace };
          },
        },
        planning: {
          taskExecutionAuthorityInTransaction: () => ({ board: {} }),
        },
        events: {
          appendDomainInTransaction: (
            _projectId: string,
            draft: DomainEvent,
          ) => {
            events.push(draft);
            return draft;
          },
        },
        barrier: { assertHealthy: () => undefined, trip: () => undefined },
        now: () => now,
      }),
  };
};

const execution = (
  context: ReturnType<typeof createRecoveryContext>,
  lifecycle: WorkerExecution['lifecycle'],
): WorkerExecution =>
  ({
    ...context.fixture.execution,
    id: context.executionId,
    projectId: context.fixture.project.id,
    lifecycle,
    revision: lifecycle === 'starting' ? 0 : 4,
    replacementForExecutionId: null,
  }) as WorkerExecution;

describe('reconcileDeveloperAttempts', () => {
  it.each([
    {
      name: 'running execution preserves a durable interrupt pending replay',
      attemptLifecycle: 'interrupted' as const,
      executionLifecycle: 'running' as const,
      reportIds: [],
      expectedLifecycle: 'interrupted' as const,
      events: 0,
      pending: false,
      pendingInterrupt: true,
    },
    {
      name: 'terminal execution without a report interrupts an active attempt',
      attemptLifecycle: 'active' as const,
      executionLifecycle: 'completed' as const,
      reportIds: [],
      expectedLifecycle: 'interrupted' as const,
      events: 1,
      pending: false,
      pendingInterrupt: false,
    },
    {
      name: 'terminal execution retains an attempt with a report',
      attemptLifecycle: 'blocked' as const,
      executionLifecycle: 'completed' as const,
      reportIds: [randomUUID()],
      expectedLifecycle: 'blocked' as const,
      events: 0,
      pending: false,
      pendingInterrupt: false,
    },
    {
      name: 'attention-required execution preserves attention after recovery',
      attemptLifecycle: 'active' as const,
      executionLifecycle: 'attention_required' as const,
      reportIds: [],
      expectedLifecycle: 'attention_required' as const,
      events: 1,
      pending: false,
      pendingInterrupt: false,
    },
    {
      name: 'reserved attempt requires attention after recovery',
      attemptLifecycle: 'reserved' as const,
      executionLifecycle: 'completed' as const,
      reportIds: [],
      expectedLifecycle: 'attention_required' as const,
      events: 1,
      pending: false,
      pendingInterrupt: false,
    },
    {
      name: 'provisioning attempt requires attention after recovery',
      attemptLifecycle: 'provisioning' as const,
      executionLifecycle: 'completed' as const,
      reportIds: [],
      expectedLifecycle: 'attention_required' as const,
      events: 1,
      pending: false,
      pendingInterrupt: false,
    },
    {
      name: 'starting execution remains a pending activation when unchanged',
      attemptLifecycle: 'active' as const,
      executionLifecycle: 'starting' as const,
      reportIds: [],
      expectedLifecycle: 'active' as const,
      events: 0,
      pending: true,
      pendingInterrupt: false,
    },
  ])('$name', async (testCase) => {
    const context = createRecoveryContext({
      attemptLifecycle: testCase.attemptLifecycle,
      reportIds: testCase.reportIds,
      execution: undefined,
    });
    context.executionRecords.set(
      context.executionId,
      execution(context, testCase.executionLifecycle),
    );
    try {
      const recovery = await context.reconcile();

      expect(context.attempt.lifecycle).toBe(testCase.expectedLifecycle);
      expect(recovery.events).toHaveLength(testCase.events);
      expect(recovery.pendingActivationIds).toEqual(
        testCase.pending ? [context.executionId] : [],
      );
      expect(recovery.pendingInterruptAttemptIds).toEqual(
        testCase.pendingInterrupt ? [context.attempt.id] : [],
      );
    } finally {
      context.fixture.close();
    }
  });

  it.each([
    {
      name: 'missing execution',
      workspace: undefined,
      execution: undefined,
    },
    {
      name: 'foreign execution',
      workspace: undefined,
      execution: 'foreign' as const,
    },
    {
      name: 'workspace without owned identity',
      workspace: {
        lifecycle: 'attention_required' as const,
        failure: {
          code: 'developer_workspace_conflict',
          message: 'Ownership was not proven',
        },
      },
      execution: 'running' as const,
    },
  ])('moves an active attempt to attention for $name', async (testCase) => {
    const context = createRecoveryContext({
      attemptLifecycle: 'active',
      execution: undefined,
      workspace: testCase.workspace,
    });
    if (testCase.execution === 'foreign') {
      context.executionRecords.set(context.executionId, {
        ...execution(context, 'running'),
        projectId: randomUUID(),
      });
    } else if (testCase.execution === 'running') {
      context.executionRecords.set(
        context.executionId,
        execution(context, 'running'),
      );
    }
    try {
      const recovery = await context.reconcile();

      expect(context.attempt).toMatchObject({
        lifecycle: 'attention_required',
      });
      expect(recovery.events).toHaveLength(1);
      expect(recovery.pendingActivationIds).toEqual([]);
      expect(recovery.pendingInterruptAttemptIds).toEqual([]);
    } finally {
      context.fixture.close();
    }
  });

  it('returns an owned dirty replacement activation without publishing or activating it', async () => {
    const context = createRecoveryContext({
      attemptLifecycle: 'interrupted',
      execution: undefined,
    });
    const replacement = {
      ...execution(context, 'starting'),
      revision: 4,
      replacementForExecutionId: context.fixture.execution.id,
    } as WorkerExecution;
    context.executionRecords.set(context.executionId, replacement);
    context.setAttempt({
      ...context.attempt,
      executionIds: [context.fixture.execution.id, context.executionId],
    });
    context.setObserveHook(() => ({
      ...context.attempt.workspace,
      observedDirty: true,
    }));
    try {
      const recovery = await context.reconcile();

      expect(recovery).toEqual({
        events: [
          expect.objectContaining({ type: 'developer_attempt.changed' }),
        ],
        pendingActivationIds: [context.executionId],
        pendingInterruptAttemptIds: [],
      });
      expect(context.attempt).toMatchObject({
        lifecycle: 'active',
        workspace: { observedDirty: true },
      });
    } finally {
      context.fixture.close();
    }
  });

  it('does not overwrite a report committed while recovery observes the workspace', async () => {
    const context = createRecoveryContext({
      attemptLifecycle: 'active',
      execution: undefined,
    });
    context.executionRecords.set(
      context.executionId,
      execution(context, 'completed'),
    );
    context.setObserveHook(() => {
      context.setAttempt({
        ...context.attempt,
        lifecycle: 'completed',
        revision: context.attempt.revision + 1,
        reportIds: [randomUUID()],
      });
    });
    try {
      const recovery = await context.reconcile();

      expect(context.attempt).toMatchObject({
        lifecycle: 'completed',
        reportIds: expect.any(Array),
      });
      expect(recovery).toEqual({
        events: [],
        pendingActivationIds: [],
        pendingInterruptAttemptIds: [],
      });
    } finally {
      context.fixture.close();
    }
  });

  it('does not overwrite a replacement linked while recovery observes the workspace', async () => {
    const context = createRecoveryContext({
      attemptLifecycle: 'active',
      execution: undefined,
    });
    context.executionRecords.set(
      context.executionId,
      execution(context, 'completed'),
    );
    const replacementId = randomUUID();
    context.setObserveHook(() => {
      context.setAttempt({
        ...context.attempt,
        controllingExecutionId: replacementId,
        executionIds: [...context.attempt.executionIds, replacementId],
        revision: context.attempt.revision + 1,
      });
    });
    try {
      const recovery = await context.reconcile();

      expect(context.attempt).toMatchObject({
        lifecycle: 'active',
        controllingExecutionId: replacementId,
      });
      expect(recovery).toEqual({
        events: [],
        pendingActivationIds: [],
        pendingInterruptAttemptIds: [],
      });
    } finally {
      context.fixture.close();
    }
  });
});
