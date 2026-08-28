import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import type { WorkerExecution } from '@mesh/v2-contracts';

import {
  createV2TestDatabase,
  type V2TestDatabase,
} from '../test/create-v2-test-database.js';
import { AuditBarrier } from './audit-barrier.js';
import { ExecutionRepository } from './execution-repository.js';
import { FakeHarnessAdapter } from './fake-harness.js';
import { OperationRepository } from './operation-repository.js';
import { reconcileExecutions } from './reconcile-executions.js';

const handle = (executionId: string, checkpointCursor: number) =>
  `fake:v1:${Buffer.from(
    `{"checkpointCursor":${checkpointCursor},"executionId":"${executionId}","scenario":"todo-foundation-v1"}`,
  ).toString('base64url')}`;

const setup = () => {
  const fixture = createV2TestDatabase();
  const executions = new ExecutionRepository(fixture.database);
  const operations = new OperationRepository(fixture.database);
  return { fixture, executions, operations, barrier: new AuditBarrier() };
};

const requiredExecution = (
  executions: ExecutionRepository,
  executionId: string,
): WorkerExecution => {
  const execution = executions.get(executionId);
  if (!execution) throw new Error('Expected reconciliation execution');
  return execution;
};

const advance = (
  fixture: V2TestDatabase,
  executions: ExecutionRepository,
  target: 'starting' | 'running' | 'completed',
  checkpointCursor = 0,
): WorkerExecution =>
  executions.transaction(() => {
    let current = requiredExecution(executions, fixture.execution.id);
    if (current.lifecycle === 'created') {
      current = executions.transitionInTransaction(
        current.id,
        current.revision,
        'starting',
        '2026-08-28T02:00:00.000Z',
      );
    }
    if (target === 'starting') return current;
    current = executions.transitionInTransaction(
      current.id,
      current.revision,
      'running',
      '2026-08-28T02:00:01.000Z',
      { nativeHandle: handle(current.id, checkpointCursor) },
    );
    current = executions.updateInTransaction(
      { ...current, lastAdapterCursor: checkpointCursor },
      current.revision,
    );
    if (target === 'running') return current;
    return executions.transitionInTransaction(
      current.id,
      current.revision,
      'completed',
      '2026-08-28T02:00:02.000Z',
    );
  });

const diagnosticCount = (fixture: V2TestDatabase) =>
  (
    fixture.database
      .prepare('SELECT COUNT(*) AS count FROM raw_diagnostics')
      .get() as {
      count: number;
    }
  ).count;

describe('reconcileExecutions', () => {
  it('reconciles each pending start with standalone raw probe evidence', async () => {
    const context = setup();
    try {
      const running = advance(
        context.fixture,
        context.executions,
        'running',
        2,
      );
      const operation = context.executions.transaction(() =>
        context.operations.createPendingInTransaction({
          executionId: running.id,
          kind: 'start',
          request: { version: 'mesh.v2.execution-start/v1' },
          createdAt: '2026-08-28T02:00:03.000Z',
        }),
      );
      const result = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter: new FakeHarnessAdapter(),
        events: context.fixture.events,
        barrier: context.barrier,
      });
      expect(result).toEqual({
        resumed: [running.id],
        terminalized: [],
        attentionRequired: [],
      });
      expect(context.operations.get(operation.id)?.state).toBe('succeeded');
      expect(diagnosticCount(context.fixture)).toBe(1);
    } finally {
      context.fixture.close();
    }
  });

  it('keeps terminal executions immutable while reporting pending-operation attention', async () => {
    const context = setup();
    try {
      const completed = advance(
        context.fixture,
        context.executions,
        'completed',
        6,
      );
      const operation = context.executions.transaction(() =>
        context.operations.createPendingInTransaction({
          executionId: completed.id,
          kind: 'interrupt',
          request: { version: 'mesh.v2.execution-interrupt/v1' },
          createdAt: '2026-08-28T02:00:03.000Z',
        }),
      );
      const result = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter: new FakeHarnessAdapter(),
        events: context.fixture.events,
        barrier: context.barrier,
      });
      expect(context.executions.get(completed.id)).toMatchObject({
        lifecycle: 'completed',
        revision: completed.revision,
      });
      expect(context.operations.get(operation.id)?.state).toBe('succeeded');
      expect(result.attentionRequired).toEqual([completed.id]);
      expect(diagnosticCount(context.fixture)).toBe(1);
    } finally {
      context.fixture.close();
    }
  });

  it('marks an ambiguous pending start attention-required with probe evidence', async () => {
    const context = setup();
    try {
      const starting = advance(context.fixture, context.executions, 'starting');
      const operation = context.executions.transaction(() =>
        context.operations.createPendingInTransaction({
          executionId: starting.id,
          kind: 'start',
          request: { version: 'mesh.v2.execution-start/v1' },
          createdAt: '2026-08-28T02:00:03.000Z',
        }),
      );
      const result = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter: new FakeHarnessAdapter(),
        events: context.fixture.events,
        barrier: context.barrier,
      });
      expect(context.executions.get(starting.id)?.lifecycle).toBe(
        'attention_required',
      );
      expect(context.operations.get(operation.id)?.state).toBe('unknown');
      expect(result.attentionRequired).toEqual([starting.id]);
      expect(diagnosticCount(context.fixture)).toBe(1);
    } finally {
      context.fixture.close();
    }
  });
});
