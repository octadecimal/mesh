import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type {
  HarnessOperationResult,
  HarnessProbeResult,
  WorkerExecution,
} from '@mesh/v2-contracts';

import {
  createV2TestDatabase,
  type V2TestDatabase,
} from '../test/create-v2-test-database.js';
import { AuditBarrier } from './audit-barrier.js';
import { ExecutionRepository } from './execution-repository.js';
import { ExecutionRuntime } from './execution-runtime.js';
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
  target: 'starting' | 'running' | 'interrupting' | 'completed',
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
    if (target === 'interrupting') {
      return executions.transitionInTransaction(
        current.id,
        current.revision,
        'interrupting',
        '2026-08-28T02:00:02.000Z',
      );
    }
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

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
};

describe('reconcileExecutions', () => {
  it('terminalizes an unreserved created execution with standalone audit evidence', async () => {
    const context = setup();
    try {
      const result = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter: new FakeHarnessAdapter(),
        events: context.fixture.events,
        barrier: context.barrier,
        attach: () => undefined,
      });
      expect(
        context.executions.get(context.fixture.execution.id),
      ).toMatchObject({
        lifecycle: 'failed',
        failure: {
          code: 'startup_interrupted_before_start',
        },
      });
      expect(diagnosticCount(context.fixture)).toBe(1);
      expect(
        context.fixture.events.domainAfter(context.fixture.project.id, 0)
          .events,
      ).toMatchObject([
        {
          type: 'worker_execution.lifecycle_changed',
          payload: { execution: { lifecycle: 'failed' } },
        },
      ]);
      expect(result).toEqual({
        resumed: [],
        terminalized: [context.fixture.execution.id],
        attentionRequired: [],
      });
    } finally {
      context.fixture.close();
    }
  });

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
        attach: () => undefined,
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
        attach: () => undefined,
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
        attach: () => undefined,
      });
      expect(context.executions.get(starting.id)?.lifecycle).toBe(
        'attention_required',
      );
      expect(context.operations.get(operation.id)?.state).toBe('unknown');
      expect(result.attentionRequired).toEqual([starting.id]);
      expect(diagnosticCount(context.fixture)).toBe(1);
      const details = context.executions.listAttentionDetails(
        context.fixture.project.id,
      );
      expect(details).toMatchObject([
        {
          execution: { id: starting.id, lifecycle: 'attention_required' },
          evidence: [
            {
              executionId: starting.id,
              adapterCursor: null,
              payload: {
                kind: 'mesh.v2.reconciliation-probe/v1',
                operationId: operation.id,
              },
            },
          ],
        },
      ]);
      expect(Object.isFrozen(details)).toBe(true);
      expect(Object.isFrozen(details[0])).toBe(true);
      expect(Object.isFrozen(details[0]?.evidence)).toBe(true);
      expect(
        context.executions.listAttentionDetails(context.fixture.project.id),
      ).not.toBe(details);
    } finally {
      context.fixture.close();
    }
  });

  it('returns immutable audit barrier health snapshots as diagnostics accumulate', () => {
    const barrier = new AuditBarrier();
    barrier.record('first unhealthy detail', new Error('first cause'));
    const first = barrier.health();
    barrier.record('second unhealthy detail');
    barrier.trip(new Error('durable failure'));
    expect(first).toMatchObject({
      status: 'healthy',
      diagnostics: [
        { message: 'first unhealthy detail', cause: 'first cause' },
      ],
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
    expect(barrier.health()).toMatchObject({
      status: 'tripped',
      diagnostics: [
        { message: 'first unhealthy detail' },
        { message: 'second unhealthy detail' },
        { message: 'Durable audit persistence failed' },
      ],
    });
  });

  it.each([
    {
      name: 'succeeded interrupt',
      probe: {
        status: 'resumable',
        afterAdapterCursor: 2,
      } as HarnessProbeResult,
      interrupt: 'succeeded' as const,
      operationState: 'succeeded',
      lifecycle: 'interrupted',
    },
    {
      name: 'already-terminal interrupted proof',
      probe: {
        status: 'terminal',
        outcome: 'interrupted',
      } as HarnessProbeResult,
      interrupt: 'already_terminal' as const,
      operationState: 'succeeded',
      lifecycle: 'interrupted',
    },
    {
      name: 'unknown interrupt',
      probe: {
        status: 'terminal',
        outcome: 'interrupted',
      } as HarnessProbeResult,
      interrupt: 'unknown' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
    {
      name: 'completed terminal mismatch',
      probe: { status: 'terminal', outcome: 'completed' } as HarnessProbeResult,
      interrupt: 'already_terminal' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
    {
      name: 'failed terminal mismatch',
      probe: { status: 'terminal', outcome: 'failed' } as HarnessProbeResult,
      interrupt: 'already_terminal' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
    {
      name: 'probe error',
      probe: 'error' as const,
      interrupt: 'already_terminal' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
    {
      name: 'interrupt error',
      probe: {
        status: 'resumable',
        afterAdapterCursor: 2,
      } as HarnessProbeResult,
      interrupt: 'error' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
  ])(
    'uses proof-gated interrupt reconciliation for $name',
    async (testCase) => {
      const context = setup();
      try {
        const interrupting = advance(
          context.fixture,
          context.executions,
          'interrupting',
          2,
        );
        const operation = context.executions.transaction(() =>
          context.operations.createPendingInTransaction({
            executionId: interrupting.id,
            kind: 'interrupt',
            request: { version: 'mesh.v2.execution-interrupt/v1' },
            createdAt: '2026-08-28T02:00:03.000Z',
          }),
        );
        const adapter = new FakeHarnessAdapter();
        vi.spyOn(adapter, 'probe').mockImplementation(async () => {
          if (testCase.probe === 'error') throw new Error('probe failed');
          return testCase.probe;
        });
        vi.spyOn(adapter, 'interrupt').mockImplementation(async () => {
          if (testCase.interrupt === 'error')
            throw new Error('interrupt failed');
          return {
            status: testCase.interrupt,
            ...(testCase.interrupt === 'unknown'
              ? { reason: 'interrupt outcome is unknown' }
              : {}),
          } as HarnessOperationResult;
        });
        await reconcileExecutions({
          executions: context.executions,
          operations: context.operations,
          adapter,
          events: context.fixture.events,
          barrier: context.barrier,
          attach: () => undefined,
        });
        expect(context.operations.get(operation.id)?.state).toBe(
          testCase.operationState,
        );
        expect(context.executions.get(interrupting.id)?.lifecycle).toBe(
          testCase.lifecycle,
        );
        expect(diagnosticCount(context.fixture)).toBe(1);
      } finally {
        context.fixture.close();
      }
    },
  );

  it('reconciles ordered start and interrupt operations without collapsing either row', async () => {
    const context = setup();
    try {
      const interrupting = advance(
        context.fixture,
        context.executions,
        'interrupting',
        2,
      );
      const [start, interrupt] = context.executions.transaction(() => [
        context.operations.createPendingInTransaction({
          executionId: interrupting.id,
          kind: 'start',
          request: { version: 'mesh.v2.execution-start/v1' },
          createdAt: '2026-08-28T02:00:03.000Z',
        }),
        context.operations.createPendingInTransaction({
          executionId: interrupting.id,
          kind: 'interrupt',
          request: { version: 'mesh.v2.execution-interrupt/v1' },
          createdAt: '2026-08-28T02:00:04.000Z',
        }),
      ]);
      await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter: new FakeHarnessAdapter(),
        events: context.fixture.events,
        barrier: context.barrier,
        attach: () => undefined,
      });
      expect(context.operations.get(start.id)?.state).toBe('succeeded');
      expect(context.operations.get(interrupt.id)?.state).toBe('succeeded');
      const evidence = (
        context.fixture.database
          .prepare(
            `SELECT payload_json FROM raw_diagnostics
             WHERE execution_id = ? ORDER BY received_at, id`,
          )
          .all(interrupting.id) as { payload_json: string }[]
      )
        .map((row) => {
          const payload = JSON.parse(row.payload_json) as {
            operationId: string;
            operationOrder: number;
          };
          return {
            operationId: payload.operationId,
            operationOrder: payload.operationOrder,
          };
        })
        .sort((left, right) => left.operationOrder - right.operationOrder);
      expect(evidence).toEqual([
        { operationId: start.id, operationOrder: 0 },
        { operationId: interrupt.id, operationOrder: 1 },
      ]);
      expect(context.executions.get(interrupting.id)?.lifecycle).toBe(
        'interrupted',
      );
    } finally {
      context.fixture.close();
    }
  });

  it('resumes a parsed cursor in a fresh adapter and attaches through completion', async () => {
    const context = setup();
    try {
      const first = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
      const session = await first.start({
        executionId: context.fixture.execution.id,
        project: context.fixture.project,
        assignment: context.fixture.execution.assignment,
        profile: context.fixture.execution.profileSnapshot,
        resolvedSkills: context.fixture.execution.resolvedSkills,
      });
      const held = await collect(session.events(0));
      context.executions.transaction(() => {
        const starting = context.executions.transitionInTransaction(
          context.fixture.execution.id,
          context.fixture.execution.revision,
          'starting',
          '2026-08-28T02:00:00.000Z',
        );
        context.executions.transitionInTransaction(
          starting.id,
          starting.revision,
          'running',
          '2026-08-28T02:00:01.000Z',
          { nativeHandle: session.nativeHandle },
        );
      });
      for (const envelope of held) {
        context.executions.transaction(() => {
          context.fixture.events.appendRuntimeWithDiagnosticInTransaction(
            context.fixture.project.id,
            {
              projectId: context.fixture.project.id,
              executionId: context.fixture.execution.id,
              adapterId: 'fake',
              adapterCursor: envelope.adapterCursor,
              receivedAt: envelope.normalized.occurredAt,
              payload: envelope.raw,
            },
            envelope.normalized,
          );
        });
      }
      const fresh = new FakeHarnessAdapter();
      const runtime = new ExecutionRuntime({
        database: context.fixture.database,
        commands: context.fixture.commands,
        events: context.fixture.events,
        projects: { get: () => context.fixture.project },
        profiles: {
          resolveApproved: () => context.fixture.execution.profileSnapshot,
        },
        executions: context.executions,
        operations: context.operations,
        adapter: fresh,
        publisher: { domain: () => undefined, runtime: () => undefined },
        barrier: context.barrier,
        now: () => '2026-08-28T02:00:04.000Z',
      });
      const result = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter: fresh,
        events: context.fixture.events,
        barrier: context.barrier,
        attach: (executionId, recovered) =>
          runtime.attach(executionId, recovered),
      });
      await runtime.drain();
      expect(fresh.resumeCount).toBe(1);
      expect(fresh.consumedAdapterCursors).toEqual([3, 4, 5, 6]);
      expect(
        context.fixture.events
          .runtimeAfter(context.fixture.project.id, 0)
          .events.map((event) => event.adapterCursor),
      ).toEqual([1, 2, 3, 4, 5, 6]);
      expect(
        context.executions.get(context.fixture.execution.id),
      ).toMatchObject({
        lifecycle: 'completed',
        lastAdapterCursor: 6,
      });
      expect(result.resumed).toEqual([context.fixture.execution.id]);
    } finally {
      context.fixture.close();
    }
  });
});
