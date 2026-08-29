import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type {
  HarnessOperationResult,
  HarnessProbeResult,
  HarnessSession,
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
  target:
    | 'starting'
    | 'running'
    | 'interrupting'
    | 'attention_required'
    | 'completed',
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
    if (target === 'attention_required') {
      return executions.transitionInTransaction(
        current.id,
        current.revision,
        'attention_required',
        '2026-08-28T02:00:02.000Z',
      );
    }
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

const reconciliationState = (
  fixture: V2TestDatabase,
  executions: ExecutionRepository,
  operations: OperationRepository,
  executionId: string,
) => ({
  execution: executions.get(executionId),
  operations: operations.listForExecution(executionId),
  diagnostics: fixture.database
    .prepare('SELECT * FROM raw_diagnostics ORDER BY id')
    .all(),
  domain: fixture.database.prepare('SELECT * FROM domain_events ORDER BY id').all(),
});

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
      expect(context.operations.get(operation.id)?.state).toBe('unknown');
      expect(result.attentionRequired).toEqual([completed.id]);
      expect(diagnosticCount(context.fixture)).toBe(1);
    } finally {
      context.fixture.close();
    }
  });

  it('skips an attention-required execution without a pending operation', async () => {
    const context = setup();
    try {
      const attention = advance(
        context.fixture,
        context.executions,
        'attention_required',
        2,
      );
      const adapter = new FakeHarnessAdapter();
      const probe = vi.spyOn(adapter, 'probe');
      const before = reconciliationState(
        context.fixture,
        context.executions,
        context.operations,
        attention.id,
      );

      const result = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter,
        events: context.fixture.events,
        barrier: context.barrier,
        attach: () => undefined,
      });

      expect(result).toEqual({
        resumed: [],
        terminalized: [],
        attentionRequired: [],
      });
      expect(probe).not.toHaveBeenCalled();
      expect(
        reconciliationState(
          context.fixture,
          context.executions,
          context.operations,
          attention.id,
        ),
      ).toEqual(before);
    } finally {
      context.fixture.close();
    }
  });

  it('reconciles attention through a pending operation exactly once', async () => {
    const context = setup();
    try {
      const attention = advance(
        context.fixture,
        context.executions,
        'attention_required',
        2,
      );
      const operation = context.executions.transaction(() =>
        context.operations.createPendingInTransaction({
          executionId: attention.id,
          kind: 'start',
          request: { version: 'mesh.v2.execution-start/v1' },
          createdAt: '2026-08-28T02:00:03.000Z',
        }),
      );
      const adapter = new FakeHarnessAdapter();
      const probe = vi.spyOn(adapter, 'probe');

      const first = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter,
        events: context.fixture.events,
        barrier: context.barrier,
        attach: () => undefined,
      });
      const afterFirst = reconciliationState(
        context.fixture,
        context.executions,
        context.operations,
        attention.id,
      );
      const second = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter,
        events: context.fixture.events,
        barrier: context.barrier,
        attach: () => undefined,
      });

      expect(first.attentionRequired).toEqual([attention.id]);
      expect(second.attentionRequired).toEqual([]);
      expect(probe).toHaveBeenCalledOnce();
      expect(context.operations.get(operation.id)?.state).toBe('succeeded');
      expect(diagnosticCount(context.fixture)).toBe(1);
      expect(
        reconciliationState(
          context.fixture,
          context.executions,
          context.operations,
          attention.id,
        ),
      ).toEqual(afterFirst);
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

  it('does not reconcile after the barrier trips while probe is awaited', async () => {
    const context = setup();
    let probeCalledResolve: (() => void) | undefined;
    let releaseProbe: (() => void) | undefined;
    const probeCalled = new Promise<void>((resolve) => {
      probeCalledResolve = resolve;
    });
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    try {
      const running = advance(context.fixture, context.executions, 'running', 2);
      context.executions.transaction(() =>
        context.operations.createPendingInTransaction({
          executionId: running.id,
          kind: 'start',
          request: { version: 'mesh.v2.execution-start/v1' },
          createdAt: '2026-08-28T02:00:03.000Z',
        }),
      );
      const before = reconciliationState(
        context.fixture,
        context.executions,
        context.operations,
        running.id,
      );
      const adapter = new FakeHarnessAdapter();
      vi.spyOn(adapter, 'probe').mockImplementation(async () => {
        probeCalledResolve?.();
        await probeRelease;
        return { status: 'resumable', afterAdapterCursor: 2 };
      });
      const attach = vi.fn();

      const pending = reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter,
        events: context.fixture.events,
        barrier: context.barrier,
        attach,
      });
      await probeCalled;
      context.barrier.trip(new Error('concurrent audit failure'));
      releaseProbe?.();

      await expect(pending).rejects.toThrow('Audit barrier is tripped');
      expect(
        reconciliationState(
          context.fixture,
          context.executions,
          context.operations,
          running.id,
        ),
      ).toEqual(before);
      expect(attach).not.toHaveBeenCalled();
      expect(adapter.resumeCount).toBe(0);
    } finally {
      context.fixture.close();
    }
  });

  it('closes recovery without attaching after the barrier trips while resume is awaited', async () => {
    const context = setup();
    let resumeCalledResolve: (() => void) | undefined;
    let releaseResume: (() => void) | undefined;
    const resumeCalled = new Promise<void>((resolve) => {
      resumeCalledResolve = resolve;
    });
    const resumeRelease = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    try {
      const running = advance(context.fixture, context.executions, 'running', 2);
      const before = reconciliationState(
        context.fixture,
        context.executions,
        context.operations,
        running.id,
      );
      const adapter = new FakeHarnessAdapter();
      let closeCount = 0;
      const recovered: HarnessSession = {
        nativeHandle: running.nativeHandle as string,
        async *events() {
          yield* [];
        },
        async close() {
          closeCount += 1;
          throw new Error('recovered close failed');
        },
      };
      vi.spyOn(adapter, 'resume').mockImplementation(async () => {
        resumeCalledResolve?.();
        await resumeRelease;
        return recovered as Awaited<ReturnType<typeof adapter.resume>>;
      });
      const attach = vi.fn();

      const pending = reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter,
        events: context.fixture.events,
        barrier: context.barrier,
        attach,
      });
      await resumeCalled;
      context.barrier.trip(new Error('concurrent audit failure'));
      releaseResume?.();

      await expect(pending).rejects.toThrow('Audit barrier is tripped');
      expect(closeCount).toBe(1);
      expect(attach).not.toHaveBeenCalled();
      expect(
        reconciliationState(
          context.fixture,
          context.executions,
          context.operations,
          running.id,
        ),
      ).toEqual(before);
      expect(context.barrier.diagnostics).toEqual([
        expect.objectContaining({ cause: 'concurrent audit failure' }),
        expect.objectContaining({
          message:
            'Recovered session close failed after audit barrier rejection',
          cause: 'recovered close failed',
        }),
      ]);
    } finally {
      context.fixture.close();
    }
  });

  it('does not reconcile interrupt proof after the barrier trips while interrupt is awaited', async () => {
    const context = setup();
    try {
      const interrupting = advance(
        context.fixture,
        context.executions,
        'interrupting',
        2,
      );
      context.executions.transaction(() =>
        context.operations.createPendingInTransaction({
          executionId: interrupting.id,
          kind: 'interrupt',
          request: { version: 'mesh.v2.execution-interrupt/v1' },
          createdAt: '2026-08-28T02:00:03.000Z',
        }),
      );
      const before = reconciliationState(
        context.fixture,
        context.executions,
        context.operations,
        interrupting.id,
      );
      const adapter = new FakeHarnessAdapter();
      adapter.blockInterrupt();
      const attach = vi.fn();

      const pending = reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter,
        events: context.fixture.events,
        barrier: context.barrier,
        attach,
      });
      await adapter.waitUntilInterruptCalled();
      context.barrier.trip(new Error('concurrent audit failure'));
      adapter.releaseInterrupt({ status: 'succeeded' });

      await expect(pending).rejects.toThrow('Audit barrier is tripped');
      expect(
        reconciliationState(
          context.fixture,
          context.executions,
          context.operations,
          interrupting.id,
        ),
      ).toEqual(before);
      expect(attach).not.toHaveBeenCalled();
    } finally {
      context.fixture.close();
    }
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
      name: 'succeeded with interrupted terminal proof',
      probe: {
        status: 'terminal',
        outcome: 'interrupted',
      } as HarnessProbeResult,
      interrupt: 'succeeded' as const,
      operationState: 'succeeded',
      lifecycle: 'interrupted',
    },
    {
      name: 'succeeded but completed terminal mismatch',
      probe: { status: 'terminal', outcome: 'completed' } as HarnessProbeResult,
      interrupt: 'succeeded' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
    {
      name: 'succeeded but failed terminal mismatch',
      probe: { status: 'terminal', outcome: 'failed' } as HarnessProbeResult,
      interrupt: 'succeeded' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
    {
      name: 'succeeded but missing probe',
      probe: { status: 'missing' } as HarnessProbeResult,
      interrupt: 'succeeded' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
    {
      name: 'succeeded but unknown probe',
      probe: { status: 'unknown', reason: 'unknown' } as HarnessProbeResult,
      interrupt: 'succeeded' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
    },
    {
      name: 'succeeded but probe errored',
      probe: 'error' as const,
      interrupt: 'succeeded' as const,
      operationState: 'unknown',
      lifecycle: 'attention_required',
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

  it('rolls back no-session reconciliation evidence, operation, lifecycle, and domain together', async () => {
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
      const before = {
        execution: context.executions.get(starting.id),
        operation: context.operations.get(operation.id),
        diagnostics: diagnosticCount(context.fixture),
        domain: context.fixture.events.domainAfter(context.fixture.project.id, 0)
          .events,
      };
      context.fixture.database.exec(`
        CREATE TRIGGER fail_reconciliation_domain BEFORE INSERT ON domain_events
        BEGIN SELECT RAISE(ABORT, 'fail reconciliation domain'); END
      `);
      const adapter = new FakeHarnessAdapter();
      const attach = vi.fn();

      await expect(
        reconcileExecutions({
          executions: context.executions,
          operations: context.operations,
          adapter,
          events: context.fixture.events,
          barrier: context.barrier,
          attach,
        }),
      ).rejects.toThrow('fail reconciliation domain');

      expect({
        execution: context.executions.get(starting.id),
        operation: context.operations.get(operation.id),
        diagnostics: diagnosticCount(context.fixture),
        domain: context.fixture.events.domainAfter(context.fixture.project.id, 0)
          .events,
      }).toEqual(before);
      expect(context.barrier.status).toBe('tripped');
      expect(attach).not.toHaveBeenCalled();
      expect(adapter.startCount).toBe(0);
      expect(adapter.resumeCount).toBe(0);
      expect(adapter.interruptCalls).toEqual([]);
    } finally {
      context.fixture.close();
    }
  });

  it('trips before recovered-session cleanup and preserves the audit failure when close rejects', async () => {
    const context = setup();
    let rejectClose: ((error: Error) => void) | undefined;
    let closeStartedResolve: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      closeStartedResolve = resolve;
    });
    const closeRelease = new Promise<void>((_resolve, reject) => {
      rejectClose = reject;
    });
    try {
      const running = advance(context.fixture, context.executions, 'running', 2);
      const operation = context.executions.transaction(() =>
        context.operations.createPendingInTransaction({
          executionId: running.id,
          kind: 'start',
          request: { version: 'mesh.v2.execution-start/v1' },
          createdAt: '2026-08-28T02:00:03.000Z',
        }),
      );
      const before = {
        execution: context.executions.get(running.id),
        operation: context.operations.get(operation.id),
        diagnostics: diagnosticCount(context.fixture),
        domain: context.fixture.events.domainAfter(context.fixture.project.id, 0)
          .events,
      };
      const adapter = new FakeHarnessAdapter();
      const recovered: HarnessSession = {
        nativeHandle: requiredExecution(context.executions, running.id)
          .nativeHandle as string,
        async *events() {
          yield* [];
        },
        async close() {
          closeStartedResolve?.();
          await closeRelease;
        },
      };
      vi.spyOn(adapter, 'resume').mockResolvedValue(recovered);
      context.fixture.database.exec(`
        CREATE TRIGGER fail_reconciliation_operation AFTER UPDATE ON execution_operations
        BEGIN SELECT RAISE(ABORT, 'fail reconciliation operation'); END
      `);
      const attach = vi.fn();

      const pending = reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter,
        events: context.fixture.events,
        barrier: context.barrier,
        attach,
      });
      await closeStarted;
      expect(context.barrier.status).toBe('tripped');
      rejectClose?.(new Error('recovered close failed'));
      await expect(pending).rejects.toThrow('fail reconciliation operation');

      expect({
        execution: context.executions.get(running.id),
        operation: context.operations.get(operation.id),
        diagnostics: diagnosticCount(context.fixture),
        domain: context.fixture.events.domainAfter(context.fixture.project.id, 0)
          .events,
      }).toEqual(before);
      expect(attach).not.toHaveBeenCalled();
      expect(context.barrier.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Recovered session close failed after reconciliation audit failure',
            cause: 'recovered close failed',
          }),
        ]),
      );
    } finally {
      context.fixture.close();
    }
  });

  it('persists attention when attach and recovered-session cleanup both fail', async () => {
    const context = setup();
    try {
      const running = advance(context.fixture, context.executions, 'running', 2);
      const adapter = new FakeHarnessAdapter();
      let closeCount = 0;
      const recovered: HarnessSession = {
        nativeHandle: running.nativeHandle as string,
        async *events() {
          yield* [];
        },
        async close() {
          closeCount += 1;
          throw new Error('attach cleanup failed');
        },
      };
      vi.spyOn(adapter, 'resume').mockResolvedValue(recovered);

      const result = await reconcileExecutions({
        executions: context.executions,
        operations: context.operations,
        adapter,
        events: context.fixture.events,
        barrier: context.barrier,
        attach: () => {
          throw new Error('attach failed');
        },
      });

      expect(closeCount).toBe(1);
      expect(context.executions.get(running.id)?.lifecycle).toBe(
        'attention_required',
      );
      expect(result.attentionRequired).toEqual([running.id]);
      expect(diagnosticCount(context.fixture)).toBe(2);
      expect(context.barrier.health()).toMatchObject({
        status: 'healthy',
        diagnostics: [
          {
            message: 'Recovered session close failed after attach failure',
            cause: 'attach cleanup failed',
          },
        ],
      });
    } finally {
      context.fixture.close();
    }
  });

  it('trips the barrier when attach-failure evidence cannot be persisted after cleanup rejects', async () => {
    const context = setup();
    try {
      const running = advance(context.fixture, context.executions, 'running', 2);
      const adapter = new FakeHarnessAdapter();
      const recovered: HarnessSession = {
        nativeHandle: running.nativeHandle as string,
        async *events() {
          yield* [];
        },
        async close() {
          throw new Error('attach cleanup failed');
        },
      };
      vi.spyOn(adapter, 'resume').mockResolvedValue(recovered);
      context.fixture.database.exec(`
        CREATE TRIGGER fail_attach_audit BEFORE INSERT ON raw_diagnostics
        WHEN NEW.payload_json LIKE '%reconciliation-attach-failed%'
        BEGIN SELECT RAISE(ABORT, 'fail attach audit'); END
      `);

      await expect(
        reconcileExecutions({
          executions: context.executions,
          operations: context.operations,
          adapter,
          events: context.fixture.events,
          barrier: context.barrier,
          attach: () => {
            throw new Error('attach failed');
          },
        }),
      ).rejects.toThrow('fail attach audit');

      expect(context.barrier.status).toBe('tripped');
      expect(context.executions.get(running.id)?.lifecycle).toBe('running');
      expect(diagnosticCount(context.fixture)).toBe(1);
      expect(context.barrier.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Recovered session close failed after attach failure',
          }),
          expect.objectContaining({
            message: 'Durable audit persistence failed',
            cause: 'fail attach audit',
          }),
        ]),
      );
    } finally {
      context.fixture.close();
    }
  });
});
