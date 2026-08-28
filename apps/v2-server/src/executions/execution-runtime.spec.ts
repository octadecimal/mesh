import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  HarnessEventEnvelope,
  HarnessSession,
  HarnessStartRequest,
  InterruptExecutionEnvelope,
  ResolvedWorkerProfileSnapshot,
  StartExecutionEnvelope,
} from '@mesh/v2-contracts';

import {
  hashV2Command,
  V2IdempotencyConflictError,
} from '../storage/command-repository.js';
import {
  createV2TestDatabase,
  type V2TestDatabase,
} from '../test/create-v2-test-database.js';
import { AuditBarrier } from './audit-barrier.js';
import { ExecutionRepository } from './execution-repository.js';
import { ExecutionRuntime } from './execution-runtime.js';
import { FakeHarnessAdapter } from './fake-harness.js';
import { OperationRepository } from './operation-repository.js';

const fixtures: V2TestDatabase[] = [];
const required = <T>(value: T | null | undefined, message: string): T => {
  if (value === undefined || value === null) throw new Error(message);
  return value;
};
afterEach(() => {
  while (fixtures.length > 0) {
    required(fixtures.pop(), 'Expected a test fixture').close();
  }
});

const createRuntime = (
  options: {
    fake?: FakeHarnessAdapter;
    profile?: (
      snapshot: ResolvedWorkerProfileSnapshot,
    ) => ResolvedWorkerProfileSnapshot;
  } = {},
) => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  const fake =
    options.fake ?? new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
  const executions = new ExecutionRepository(fixture.database);
  const operations = new OperationRepository(fixture.database);
  const barrier = new AuditBarrier();
  const published = { domain: [] as unknown[], runtime: [] as unknown[] };
  const baseSnapshot: ResolvedWorkerProfileSnapshot = {
    profileId: fixture.profileRevision.profileId,
    projectId: fixture.profileRevision.projectId,
    profileRevision: fixture.profileRevision.revision,
    baseProfileId: fixture.profileRevision.baseProfileId,
    baseRevision: fixture.profileRevision.baseRevision,
    document: fixture.profileRevision.document,
    digest: fixture.profileRevision.digest,
  };
  const profile = options.profile?.(baseSnapshot) ?? baseSnapshot;
  const runtime = new ExecutionRuntime({
    database: fixture.database,
    commands: fixture.commands,
    events: fixture.events,
    projects: {
      get: (id) => (id === fixture.project.id ? fixture.project : undefined),
    },
    profiles: { resolveApproved: () => profile },
    executions,
    operations,
    adapter: fake,
    publisher: {
      domain: (event) => published.domain.push(event),
      runtime: (event) => published.runtime.push(event),
    },
    barrier,
    now: () => '2026-08-28T01:00:00.000Z',
  });
  const start: StartExecutionEnvelope = {
    idempotencyKey: randomUUID(),
    actor: { kind: 'human' },
    command: {
      type: 'worker_execution.start',
      projectId: fixture.project.id,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      assignment: {
        kind: 'foundation-check',
        projectId: fixture.project.id,
        title: 'Foundation check',
        instructions: 'Inspect Todo.',
        fakeScenario: 'todo-foundation-v1',
      },
    },
  };
  return {
    fixture,
    fake,
    executions,
    operations,
    barrier,
    published,
    runtime,
    start,
  };
};

const emitUnknownHarnessInput = (
  adapter: FakeHarnessAdapter,
  candidate: (request: HarnessStartRequest) => unknown,
) => {
  const state = { closeCount: 0, yieldCount: 0, nativeHandle: '' };
  vi.spyOn(adapter, 'start').mockImplementation(async (request) => {
    state.nativeHandle = `malformed:${request.executionId}`;
    const session: HarnessSession = {
      nativeHandle: state.nativeHandle,
      async *events() {
        state.yieldCount += 1;
        yield candidate(request) as HarnessEventEnvelope;
        state.yieldCount += 1;
        yield candidate(request) as HarnessEventEnvelope;
      },
      async close() {
        state.closeCount += 1;
      },
    };
    return session as unknown as Awaited<
      ReturnType<FakeHarnessAdapter['start']>
    >;
  });
  return state;
};

const normalizedOutput = (
  request: HarnessStartRequest,
  adapterCursor: number,
) => ({
  projectId: request.project.id,
  executionId: request.executionId,
  adapterCursor,
  occurredAt: '2026-08-28T01:00:01.000Z',
  type: 'worker_execution.output' as const,
  payload: { text: 'malformed input fixture' },
});

const durableReservationState = (fixture: V2TestDatabase) => ({
  executions: fixture.database
    .prepare('SELECT * FROM worker_executions ORDER BY id')
    .all(),
  operations: fixture.database
    .prepare('SELECT * FROM execution_operations ORDER BY id')
    .all(),
  domain: fixture.database.prepare('SELECT * FROM domain_events ORDER BY id').all(),
  commands: fixture.database
    .prepare('SELECT * FROM command_results ORDER BY idempotency_key')
    .all(),
});

describe('ExecutionRuntime', () => {
  it('durably rejects missing required capabilities before operation or adapter start', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
    const context = createRuntime({ fake });
    const result = await context.runtime.start(context.start);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'required_capability_unavailable' },
    });
    const failed = required(
      context.executions
        .list(context.fixture.project.id)
        .find((execution) => execution.id !== context.fixture.execution.id),
      'Expected a failed execution',
    );
    expect(failed).toMatchObject({
      lifecycle: 'failed',
      failure: {
        code: 'required_capability_unavailable',
        missing: ['execution.stream'],
      },
    });
    expect(context.operations.listForExecution(failed.id)).toEqual([]);
    expect(fake.startCount).toBe(0);
    expect(fake.resolveSkillsCount).toBe(0);
    expect(context.published.domain).toHaveLength(1);
  });

  it('durably rejects a missing required skill while preferred skills visibly fall back', async () => {
    const context = createRuntime({
      profile: (profile) => ({
        ...profile,
        document: {
          ...profile.document,
          spec: {
            ...profile.document.spec,
            skills: {
              preferred: [{ id: 'mesh.preferred' }],
              required: [
                { id: 'mesh.required', constraint: { version: '^0.2.3' } },
              ],
            },
          },
        },
      }),
    });
    const result = await context.runtime.start(context.start);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'required_skill_unavailable' },
    });
    const failed = required(
      context.executions.list(context.fixture.project.id).at(-1),
      'Expected a failed execution',
    );
    expect(failed.failure?.missing).toEqual(['mesh.required']);
    expect(failed.resolvedSkills).toMatchObject([
      { mode: 'preferred', resolution: { kind: 'mesh-native-fallback' } },
      { mode: 'required', resolution: { kind: 'unavailable' } },
    ]);
    expect(context.operations.listForExecution(failed.id)).toEqual([]);
    expect(context.fake.startCount).toBe(0);
  });

  it('stores one immutable starting receipt and pending-operation lineage before start', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
    fake.blockStart();
    const context = createRuntime({ fake });
    const firstPending = context.runtime.start(context.start);
    await fake.waitUntilStartCalled();
    const storedBeforeSideEffect = required(
      context.fixture.commands.find(context.start.idempotencyKey),
      'Expected the start acceptance receipt',
    );
    const replay = await context.runtime.start(context.start);
    expect(replay).toEqual(storedBeforeSideEffect.result);
    expect(fake.startCount).toBe(1);
    fake.releaseStart();
    const first = await firstPending;
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      commandType: 'worker_execution.start',
      execution: { lifecycle: 'starting', nativeHandle: null },
    });
    const accepted = required(
      context.fixture.commands.find(context.start.idempotencyKey),
      'Expected the stored start result',
    );
    expect(accepted.result).toEqual(first);
    expect(context.fake.startCount).toBe(1);
    const executionId =
      first.ok && 'execution' in first ? first.execution.id : '';
    expect(context.operations.listForExecution(executionId)).toMatchObject([
      {
        kind: 'start',
        request: {
          version: 'mesh.v2.execution-start/v1',
          idempotencyKey: context.start.idempotencyKey,
        },
      },
    ]);
  });

  it('interrupts the owned session handle when running finalization rolls back', async () => {
    const context = createRuntime({
      fake: new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 }),
    });
    context.fixture.database.exec(`
      CREATE TRIGGER fail_running_finalization BEFORE INSERT ON domain_events
      WHEN NEW.type = 'worker_execution.lifecycle_changed'
        AND NEW.payload_json LIKE '%"lifecycle":"running"%'
      BEGIN SELECT RAISE(ABORT, 'fail running finalization'); END
    `);

    const result = await context.runtime.start(context.start);
    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';
    const session = required(
      context.fake.sessions[0],
      'Expected an adapter-owned start session',
    );

    expect(context.barrier.status).toBe('tripped');
    expect(context.fake.interruptCalls).toEqual([session.nativeHandle]);
    expect(session.closeCount).toBe(1);
    expect(session.consumedAdapterCursors).toEqual([]);
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'starting',
      nativeHandle: null,
      lastAdapterCursor: 0,
    });
    expect(context.operations.listForExecution(executionId)).toMatchObject([
      { kind: 'start', state: 'pending' },
    ]);
    expect(
      context.fixture.events.domainAfter(context.fixture.project.id, 0).events,
    ).toHaveLength(1);
    expect(
      context.fixture.events.runtimeAfter(context.fixture.project.id, 0).events,
    ).toEqual([]);
    expect(context.published.domain).toHaveLength(1);
    expect(context.published.runtime).toEqual([]);
  });

  it('lets one of two runtime instances reserve start after both miss the fast lookup', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
    fake.blockCapabilities();
    const context = createRuntime({ fake });
    const profile: ResolvedWorkerProfileSnapshot = {
      profileId: context.fixture.profileRevision.profileId,
      projectId: context.fixture.profileRevision.projectId,
      profileRevision: context.fixture.profileRevision.revision,
      baseProfileId: context.fixture.profileRevision.baseProfileId,
      baseRevision: context.fixture.profileRevision.baseRevision,
      document: context.fixture.profileRevision.document,
      digest: context.fixture.profileRevision.digest,
    };
    const second = new ExecutionRuntime({
      database: context.fixture.database,
      commands: context.fixture.commands,
      events: context.fixture.events,
      projects: { get: () => context.fixture.project },
      profiles: { resolveApproved: () => profile },
      executions: context.executions,
      operations: context.operations,
      adapter: fake,
      publisher: { domain: () => undefined, runtime: () => undefined },
      barrier: context.barrier,
      now: () => '2026-08-28T01:00:00.000Z',
    });
    const requestHash = hashV2Command(context.start.command);
    const lookupTransactions: boolean[] = [];
    const originalFind = context.fixture.commands.find.bind(
      context.fixture.commands,
    );
    vi.spyOn(context.fixture.commands, 'find').mockImplementation(
      (idempotencyKey, expectedRequestHash) => {
        if (
          idempotencyKey === context.start.idempotencyKey &&
          expectedRequestHash === requestHash
        ) {
          lookupTransactions.push(context.fixture.database.inTransaction);
        }
        return originalFind(idempotencyKey, expectedRequestHash);
      },
    );
    const firstResult = context.runtime.start(context.start);
    const secondResult = second.start(context.start);
    await fake.waitUntilCapabilitiesCalled(2);
    fake.releaseCapabilities();
    const [first, replay] = await Promise.all([firstResult, secondResult]);
    expect(replay).toEqual(first);
    expect(lookupTransactions.filter((inside) => !inside)).toHaveLength(2);
    expect(lookupTransactions.filter(Boolean)).toHaveLength(2);
    expect(fake.startCount).toBe(1);
    const created = context.executions
      .list(context.fixture.project.id)
      .filter((execution) => execution.id !== context.fixture.execution.id);
    expect(created).toHaveLength(1);
    expect(
      context.operations.listForExecution(
        required(created[0], 'Expected one reserved execution').id,
      ),
    ).toHaveLength(1);
    await context.runtime.drain();
    await second.drain();
  });

  it('keeps the barrier healthy for an inner start idempotency conflict', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
    fake.blockCapabilities();
    const context = createRuntime({ fake });
    const second = new ExecutionRuntime({
      database: context.fixture.database,
      commands: context.fixture.commands,
      events: context.fixture.events,
      projects: { get: () => context.fixture.project },
      profiles: {
        resolveApproved: () => ({
          profileId: context.fixture.profileRevision.profileId,
          projectId: context.fixture.profileRevision.projectId,
          profileRevision: context.fixture.profileRevision.revision,
          baseProfileId: context.fixture.profileRevision.baseProfileId,
          baseRevision: context.fixture.profileRevision.baseRevision,
          document: context.fixture.profileRevision.document,
          digest: context.fixture.profileRevision.digest,
        }),
      },
      executions: context.executions,
      operations: context.operations,
      adapter: fake,
      publisher: { domain: () => undefined, runtime: () => undefined },
      barrier: context.barrier,
      now: () => '2026-08-28T01:00:00.000Z',
    });
    const conflicting: StartExecutionEnvelope = {
      ...context.start,
      command: {
        ...context.start.command,
        assignment: {
          ...context.start.command.assignment,
          title: 'Conflicting foundation check',
        },
      },
    };

    const first = context.runtime.start(context.start);
    const conflict = second.start(conflicting);
    await fake.waitUntilCapabilitiesCalled(2);
    fake.releaseCapabilities();
    const settled = await Promise.allSettled([first, conflict]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = required(
      settled.find((result) => result.status === 'rejected'),
      'Expected one conflicting start',
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(V2IdempotencyConflictError),
    });
    expect(context.barrier.status).toBe('healthy');
    expect(fake.startCount).toBe(1);
    expect(
      context.executions
        .list(context.fixture.project.id)
        .filter((execution) => execution.id !== context.fixture.execution.id),
    ).toHaveLength(1);
    await context.runtime.drain();
    await second.drain();
  });

  it('rejects start when the audit barrier trips during capability resolution', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
    fake.blockCapabilities();
    const context = createRuntime({ fake });
    const before = {
      executions: context.executions.list(context.fixture.project.id),
      pending: context.operations.listPending(),
      domain: context.fixture.events.domainAfter(context.fixture.project.id, 0)
        .events,
      raw: context.fixture.database
        .prepare('SELECT * FROM raw_diagnostics ORDER BY id')
        .all(),
    };

    const pending = context.runtime.start(context.start);
    await fake.waitUntilCapabilitiesCalled(1);
    context.barrier.trip(new Error('concurrent audit failure'));
    fake.releaseCapabilities();

    await expect(pending).rejects.toThrow('Audit barrier is tripped');
    expect(context.fixture.commands.find(context.start.idempotencyKey)).toBe(
      undefined,
    );
    expect({
      executions: context.executions.list(context.fixture.project.id),
      pending: context.operations.listPending(),
      domain: context.fixture.events.domainAfter(context.fixture.project.id, 0)
        .events,
      raw: context.fixture.database
        .prepare('SELECT * FROM raw_diagnostics ORDER BY id')
        .all(),
    }).toEqual(before);
    expect(fake.resolveSkillsCount).toBe(1);
    expect(fake.startCount).toBe(0);
    expect(fake.interruptCalls).toEqual([]);
  });

  it.each([
    ['execution', 'BEFORE INSERT ON worker_executions'],
    ['operation', 'BEFORE INSERT ON execution_operations'],
    ['domain', 'BEFORE INSERT ON domain_events'],
    ['command', 'BEFORE INSERT ON command_results'],
  ])(
    'trips the audit barrier when start reservation %s persistence fails',
    async (faultPoint, triggerTarget) => {
      const context = createRuntime();
      const before = durableReservationState(context.fixture);
      context.fixture.database.exec(`
        CREATE TRIGGER fail_start_${faultPoint} ${triggerTarget}
        BEGIN SELECT RAISE(ABORT, 'fail start ${faultPoint}'); END
      `);

      await expect(context.runtime.start(context.start)).rejects.toThrow(
        `fail start ${faultPoint}`,
      );

      expect(context.barrier.status).toBe('tripped');
      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.fixture.commands.find(context.start.idempotencyKey)).toBe(
        undefined,
      );
      expect(context.fake.startCount).toBe(0);
      expect(context.fake.interruptCalls).toEqual([]);
      expect(context.published).toEqual({ domain: [], runtime: [] });
      await expect(
        context.runtime.start({
          ...context.start,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow('Audit barrier is tripped');
    },
  );

  it('does not infer completion from stream exhaustion', async () => {
    const context = createRuntime({
      fake: new FakeHarnessAdapter({ holdAfterAdapterCursor: 5 }),
    });
    const result = await context.runtime.start(context.start);
    await context.runtime.drain();
    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'running',
      lastAdapterCursor: 5,
    });
  });

  it.each([
    {
      name: 'missing cursor',
      expectedCursor: null,
      candidate: (request: HarnessStartRequest) => ({
        raw: { case: 'missing cursor' },
        normalized: normalizedOutput(request, 1),
      }),
    },
    {
      name: 'non-integer cursor',
      expectedCursor: null,
      candidate: (request: HarnessStartRequest) => ({
        adapterCursor: '1',
        raw: { case: 'non-integer cursor' },
        normalized: normalizedOutput(request, 1),
      }),
    },
    {
      name: 'non-next cursor',
      expectedCursor: null,
      candidate: (request: HarnessStartRequest) => ({
        adapterCursor: 2,
        raw: { case: 'non-next cursor' },
        normalized: normalizedOutput(request, 2),
      }),
    },
    {
      name: 'coherent cursor with invalid normalized type',
      expectedCursor: 1,
      candidate: (request: HarnessStartRequest) => ({
        adapterCursor: 1,
        raw: { case: 'coherent cursor with invalid normalized type' },
        normalized: {
          ...normalizedOutput(request, 1),
          type: 'worker_execution.not-real',
        },
      }),
    },
  ])(
    'audits $name without a runtime event or cursor advance',
    async ({ name, expectedCursor, candidate }) => {
      const adapter = new FakeHarnessAdapter();
      const session = emitUnknownHarnessInput(adapter, candidate);
      const context = createRuntime({ fake: adapter });

      const started = await context.runtime.start(context.start);
      await context.runtime.drain();
      const executionId =
        started.ok && 'execution' in started ? started.execution.id : '';
      const diagnostics = context.fixture.database
        .prepare(
          `SELECT adapter_cursor, payload_json FROM raw_diagnostics
           WHERE execution_id = ? ORDER BY id`,
        )
        .all(executionId) as Array<{
        adapter_cursor: number | null;
        payload_json: string;
      }>;

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.adapter_cursor).toBe(expectedCursor);
      expect(JSON.parse(required(diagnostics[0], 'Expected audit input').payload_json)).toMatchObject({
        kind: 'mesh.v2.invalid-harness-input/v1',
        input: { raw: { case: name } },
      });
      expect(context.executions.get(executionId)).toMatchObject({
        lifecycle: 'failed',
        lastAdapterCursor: 0,
        failure: { code: 'internal_error' },
      });
      expect(
        context.fixture.events.runtimeAfter(context.fixture.project.id, 0)
          .events,
      ).toEqual([]);
      expect(
        context.fixture.events
          .domainAfter(context.fixture.project.id, 0)
          .events.map((event) => event.payload.execution.lifecycle),
      ).toEqual(['starting', 'running', 'failed']);
      expect(context.operations.listForExecution(executionId)).toMatchObject([
        { kind: 'start', state: 'succeeded' },
      ]);
      expect(context.published.runtime).toEqual([]);
      expect(context.published.domain).toHaveLength(3);
      expect(context.barrier.status).toBe('healthy');
      expect(adapter.interruptCalls).toEqual([]);
      expect(session.closeCount).toBe(1);
      expect(session.yieldCount).toBe(1);
    },
  );

  it.each([
    ['raw insert', 'BEFORE INSERT ON raw_diagnostics'],
    [
      'failure lifecycle',
      `BEFORE UPDATE ON worker_executions
       WHEN NEW.lifecycle = 'failed'`,
    ],
  ])(
    'rolls back malformed-input audit and contains a %s fault',
    async (faultName, triggerTarget) => {
      const adapter = new FakeHarnessAdapter();
      const session = emitUnknownHarnessInput(adapter, (request) => ({
        raw: { case: faultName },
        normalized: normalizedOutput(request, 1),
      }));
      const context = createRuntime({ fake: adapter });
      context.fixture.database.exec(`
        CREATE TRIGGER fail_malformed_audit ${triggerTarget}
        BEGIN SELECT RAISE(ABORT, 'fail malformed audit'); END
      `);

      const started = await context.runtime.start(context.start);
      await context.runtime.drain();
      const executionId =
        started.ok && 'execution' in started ? started.execution.id : '';

      expect(context.barrier.status).toBe('tripped');
      expect(adapter.interruptCalls).toEqual([session.nativeHandle]);
      expect(session.closeCount).toBe(1);
      expect(session.yieldCount).toBe(1);
      expect(context.executions.get(executionId)).toMatchObject({
        lifecycle: 'running',
        lastAdapterCursor: 0,
      });
      expect(
        context.fixture.database
          .prepare(
            'SELECT * FROM raw_diagnostics WHERE execution_id = ?',
          )
          .all(executionId),
      ).toEqual([]);
      expect(
        context.fixture.events.runtimeAfter(context.fixture.project.id, 0)
          .events,
      ).toEqual([]);
      expect(
        context.fixture.events
          .domainAfter(context.fixture.project.id, 0)
          .events.map((event) => event.payload.execution.lifecycle),
      ).toEqual(['starting', 'running']);
      expect(context.operations.listForExecution(executionId)).toMatchObject([
        { kind: 'start', state: 'succeeded' },
      ]);
      expect(context.published.runtime).toEqual([]);
      expect(context.published.domain).toHaveLength(2);
    },
  );

  it('records a pending operation observation with malformed-input failure', async () => {
    const context = createRuntime({
      fake: new FakeHarnessAdapter({ holdAfterAdapterCursor: 1 }),
    });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const operation = context.executions.transaction(() =>
      context.operations.createPendingInTransaction({
        executionId: running.id,
        kind: 'interrupt',
        request: { version: 'mesh.v2.execution-interrupt/v1' },
        createdAt: '2026-08-28T01:00:02.000Z',
      }),
    );
    let closeCount = 0;
    const malformedSession: HarnessSession = {
      nativeHandle: required(running.nativeHandle, 'Expected native handle'),
      async *events() {
        yield {
          raw: { case: 'pending operation' },
          normalized: {
            projectId: running.projectId,
            executionId: running.id,
            adapterCursor: 2,
            occurredAt: '2026-08-28T01:00:02.000Z',
            type: 'worker_execution.output',
            payload: { text: 'missing outer cursor' },
          },
        } as HarnessEventEnvelope;
      },
      async close() {
        closeCount += 1;
      },
    };

    context.runtime.attach(running.id, malformedSession);
    await context.runtime.drain();

    expect(context.operations.get(operation.id)).toMatchObject({
      state: 'unknown',
      result: { reason: expect.any(String) },
    });
    expect(context.executions.get(running.id)).toMatchObject({
      lifecycle: 'failed',
      lastAdapterCursor: 1,
    });
    expect(
      context.fixture.database
        .prepare(
          `SELECT adapter_cursor FROM raw_diagnostics
           WHERE execution_id = ?
             AND payload_json LIKE '%invalid-harness-input%'
           LIMIT 1`,
        )
        .get(running.id),
    ).toEqual({ adapter_cursor: null });
    expect(
      context.fixture.events.runtimeAfter(context.fixture.project.id, 0).events,
    ).toHaveLength(1);
    expect(closeCount).toBe(1);
    expect(context.barrier.status).toBe('healthy');
  });

  it('commits cursor-6 normalized completion and publishes runtime before domain', async () => {
    const context = createRuntime({ fake: new FakeHarnessAdapter() });
    const order: string[] = [];
    const runtime = new ExecutionRuntime({
      database: context.fixture.database,
      commands: context.fixture.commands,
      events: context.fixture.events,
      projects: { get: () => context.fixture.project },
      profiles: {
        resolveApproved: () => ({
          profileId: context.fixture.profileRevision.profileId,
          projectId: context.fixture.profileRevision.projectId,
          profileRevision: context.fixture.profileRevision.revision,
          baseProfileId: context.fixture.profileRevision.baseProfileId,
          baseRevision: context.fixture.profileRevision.baseRevision,
          document: context.fixture.profileRevision.document,
          digest: context.fixture.profileRevision.digest,
        }),
      },
      executions: context.executions,
      operations: context.operations,
      adapter: context.fake,
      publisher: {
        runtime: () => order.push('runtime'),
        domain: () => order.push('domain'),
      },
      barrier: context.barrier,
      now: () => '2026-08-28T01:00:00.000Z',
    });
    const result = await runtime.start(context.start);
    await runtime.drain();
    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'completed',
      lastAdapterCursor: 6,
    });
    expect(
      context.fixture.events
        .runtimeAfter(context.fixture.project.id, 0)
        .events.at(-1),
    ).toMatchObject({
      type: 'worker_execution.completed',
      adapterCursor: 6,
      payload: { outcome: 'completed' },
    });
    expect(order.slice(-2)).toEqual(['runtime', 'domain']);
  });

  it('persists immutable interrupt acceptance before proof and replays without another side effect', async () => {
    const context = createRuntime();
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const interrupt: InterruptExecutionEnvelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.interrupt',
        projectId: running.projectId,
        executionId: running.id,
        expectedRevision: running.revision,
      },
    };
    context.fake.blockInterrupt();
    const firstPending = context.runtime.interrupt(interrupt);
    await context.fake.waitUntilInterruptCalled();
    const storedBeforeSideEffect = required(
      context.fixture.commands.find(interrupt.idempotencyKey),
      'Expected the interrupt acceptance receipt',
    );
    const replay = await context.runtime.interrupt(interrupt);
    expect(replay).toEqual(storedBeforeSideEffect.result);
    context.fake.releaseInterrupt({ status: 'succeeded' });
    const first = await firstPending;
    expect(first).toMatchObject({
      ok: true,
      execution: { lifecycle: 'interrupting' },
    });
    expect(replay).toEqual(first);
    expect(context.fake.interruptCalls).toHaveLength(1);
    expect(context.executions.get(running.id)?.lifecycle).toBe('interrupted');
  });

  it('keeps the barrier healthy for a fast interrupt idempotency conflict', async () => {
    const context = createRuntime();
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const interrupt: InterruptExecutionEnvelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.interrupt',
        projectId: running.projectId,
        executionId: running.id,
        expectedRevision: running.revision,
      },
    };
    await context.runtime.interrupt(interrupt);

    await expect(
      context.runtime.interrupt({
        ...interrupt,
        command: {
          ...interrupt.command,
          expectedRevision: interrupt.command.expectedRevision + 1,
        },
      }),
    ).rejects.toBeInstanceOf(V2IdempotencyConflictError);
    expect(context.barrier.status).toBe('healthy');
    expect(context.fake.interruptCalls).toHaveLength(1);
  });

  it('lets one of two runtime instances reserve interrupt after both miss the fast lookup', async () => {
    const context = createRuntime();
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const profile = running.profileSnapshot;
    const second = new ExecutionRuntime({
      database: context.fixture.database,
      commands: context.fixture.commands,
      events: context.fixture.events,
      projects: { get: () => context.fixture.project },
      profiles: { resolveApproved: () => profile },
      executions: context.executions,
      operations: context.operations,
      adapter: context.fake,
      publisher: { domain: () => undefined, runtime: () => undefined },
      barrier: context.barrier,
      now: () => '2026-08-28T01:00:00.000Z',
    });
    const interrupt: InterruptExecutionEnvelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.interrupt',
        projectId: running.projectId,
        executionId: running.id,
        expectedRevision: running.revision,
      },
    };
    const requestHash = hashV2Command(interrupt.command);
    const lookupTransactions: boolean[] = [];
    const originalFind = context.fixture.commands.find.bind(
      context.fixture.commands,
    );
    vi.spyOn(context.fixture.commands, 'find').mockImplementation(
      (idempotencyKey, expectedRequestHash) => {
        if (
          idempotencyKey === interrupt.idempotencyKey &&
          expectedRequestHash === requestHash
        ) {
          lookupTransactions.push(context.fixture.database.inTransaction);
        }
        return originalFind(idempotencyKey, expectedRequestHash);
      },
    );
    const [first, replay] = await Promise.all([
      context.runtime.interrupt(interrupt),
      second.interrupt(interrupt),
    ]);
    expect(replay).toEqual(first);
    expect(lookupTransactions.filter((inside) => !inside)).toHaveLength(2);
    expect(lookupTransactions.filter(Boolean)).toHaveLength(2);
    expect(
      context.operations
        .listForExecution(running.id)
        .filter((operation) => operation.kind === 'interrupt'),
    ).toHaveLength(1);
    expect(context.fake.interruptCalls).toHaveLength(1);
    expect(
      context.fixture.commands.find(interrupt.idempotencyKey)?.result,
    ).toEqual(first);
  });

  it('rejects interrupt when the audit barrier trips before reservation', async () => {
    const context = createRuntime();
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const interrupt: InterruptExecutionEnvelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.interrupt',
        projectId: running.projectId,
        executionId: running.id,
        expectedRevision: running.revision,
      },
    };
    const before = {
      execution: context.executions.get(running.id),
      operations: context.operations.listForExecution(running.id),
      domain: context.fixture.events.domainAfter(context.fixture.project.id, 0)
        .events,
    };

    const pending = context.runtime.interrupt(interrupt);
    context.barrier.trip(new Error('concurrent audit failure'));

    await expect(pending).rejects.toThrow('Audit barrier is tripped');
    expect(context.fixture.commands.find(interrupt.idempotencyKey)).toBe(
      undefined,
    );
    expect({
      execution: context.executions.get(running.id),
      operations: context.operations.listForExecution(running.id),
      domain: context.fixture.events.domainAfter(context.fixture.project.id, 0)
        .events,
    }).toEqual(before);
    expect(context.fake.interruptCalls).toEqual([]);
  });

  it.each([
    [
      'execution',
      `BEFORE UPDATE ON worker_executions
       WHEN NEW.lifecycle = 'interrupting'`,
    ],
    ['operation', 'BEFORE INSERT ON execution_operations'],
    ['domain', 'BEFORE INSERT ON domain_events'],
    ['command', 'BEFORE INSERT ON command_results'],
  ])(
    'trips the audit barrier when interrupt reservation %s persistence fails',
    async (faultPoint, triggerTarget) => {
      const context = createRuntime();
      const started = await context.runtime.start(context.start);
      await context.runtime.drain();
      const running = required(
        context.executions.get(
          started.ok && 'execution' in started ? started.execution.id : '',
        ),
        'Expected a running execution',
      );
      const interrupt: InterruptExecutionEnvelope = {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'worker_execution.interrupt',
          projectId: running.projectId,
          executionId: running.id,
          expectedRevision: running.revision,
        },
      };
      const before = durableReservationState(context.fixture);
      const publishedBefore = {
        domain: [...context.published.domain],
        runtime: [...context.published.runtime],
      };
      context.fixture.database.exec(`
        CREATE TRIGGER fail_interrupt_${faultPoint} ${triggerTarget}
        BEGIN SELECT RAISE(ABORT, 'fail interrupt ${faultPoint}'); END
      `);

      await expect(context.runtime.interrupt(interrupt)).rejects.toThrow(
        `fail interrupt ${faultPoint}`,
      );

      expect(context.barrier.status).toBe('tripped');
      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.fixture.commands.find(interrupt.idempotencyKey)).toBe(
        undefined,
      );
      expect(context.fake.interruptCalls).toEqual([]);
      expect(context.published).toEqual(publishedBefore);
      await expect(
        context.runtime.interrupt({
          ...interrupt,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow('Audit barrier is tripped');
    },
  );

  it.each([
    ['raw_insert', 'BEFORE INSERT ON raw_diagnostics'],
    ['runtime_insert', 'BEFORE INSERT ON runtime_events'],
    [
      'cursor_update',
      'BEFORE UPDATE OF last_adapter_cursor ON worker_executions',
    ],
  ])('contains an audit failure at %s', async (faultPoint, triggerTarget) => {
    const context = createRuntime({
      fake: new FakeHarnessAdapter({ holdAfterAdapterCursor: 1 }),
    });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const execution = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a held execution',
    );
    const before = {
      execution: context.executions.get(execution.id),
      diagnostics: context.fixture.database
        .prepare('SELECT * FROM raw_diagnostics ORDER BY id')
        .all(),
      runtime: context.fixture.database
        .prepare('SELECT * FROM runtime_events ORDER BY id')
        .all(),
    };
    context.fixture.database.exec(`
      CREATE TRIGGER fail_${faultPoint} ${triggerTarget}
      BEGIN SELECT RAISE(ABORT, 'fail ${faultPoint}'); END
    `);
    const resumed = await context.fake.resume({
      executionId: execution.id,
      project: context.fixture.project,
      assignment: execution.assignment,
      profile: execution.profileSnapshot,
      resolvedSkills: execution.resolvedSkills,
      nativeHandle: required(
        execution.nativeHandle,
        'Expected a native handle',
      ),
      afterAdapterCursor: execution.lastAdapterCursor,
    });
    const publishedBefore = context.published.runtime.length;
    context.runtime.attach(execution.id, resumed);
    await context.runtime.drain();
    expect(context.barrier.status).toBe('tripped');
    expect(resumed.closeCount).toBe(1);
    expect(context.fake.interruptCalls).toContain(resumed.nativeHandle);
    expect({
      execution: context.executions.get(execution.id),
      diagnostics: context.fixture.database
        .prepare('SELECT * FROM raw_diagnostics ORDER BY id')
        .all(),
      runtime: context.fixture.database
        .prepare('SELECT * FROM runtime_events ORDER BY id')
        .all(),
    }).toEqual(before);
    expect(context.published.runtime).toHaveLength(publishedBefore);
    expect(resumed.consumedAdapterCursors).toEqual([2]);
  });

  it('still closes and stops consumption when containment interrupt throws', async () => {
    const fake = new FakeHarnessAdapter({
      holdAfterAdapterCursor: 1,
      interruptThrows: true,
    });
    const context = createRuntime({ fake });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const execution = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a held execution',
    );
    context.fixture.database.exec(`
      CREATE TRIGGER fail_raw_interrupt BEFORE INSERT ON raw_diagnostics
      BEGIN SELECT RAISE(ABORT, 'fail raw'); END
    `);
    const resumed = await fake.resume({
      executionId: execution.id,
      project: context.fixture.project,
      assignment: execution.assignment,
      profile: execution.profileSnapshot,
      resolvedSkills: execution.resolvedSkills,
      nativeHandle: required(
        execution.nativeHandle,
        'Expected a native handle',
      ),
      afterAdapterCursor: execution.lastAdapterCursor,
    });
    context.runtime.attach(execution.id, resumed);
    await context.runtime.drain();
    expect(context.barrier.status).toBe('tripped');
    expect(resumed.closeCount).toBe(1);
    expect(resumed.consumedAdapterCursors).toEqual([2]);
    expect(context.barrier.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Adapter interrupt failed during containment',
        }),
      ]),
    );
  });

  it('contains the first failed completion terminalization without a fallback write', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 5 });
    const context = createRuntime({ fake });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const execution = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected an execution held before completion',
    );
    expect(execution).toMatchObject({
      lifecycle: 'running',
      lastAdapterCursor: 5,
    });
    context.fixture.database.exec(`
      CREATE TRIGGER fail_completion_domain BEFORE INSERT ON domain_events
      WHEN NEW.type = 'worker_execution.lifecycle_changed'
      BEGIN SELECT RAISE(ABORT, 'fail completion domain'); END
    `);
    const resumed = await fake.resume({
      executionId: execution.id,
      project: context.fixture.project,
      assignment: execution.assignment,
      profile: execution.profileSnapshot,
      resolvedSkills: execution.resolvedSkills,
      nativeHandle: required(
        execution.nativeHandle,
        'Expected a native handle',
      ),
      afterAdapterCursor: execution.lastAdapterCursor,
    });
    const runtimeCount = context.fixture.events.runtimeAfter(
      context.fixture.project.id,
      0,
    ).events.length;
    const publishedCount = context.published.runtime.length;
    context.runtime.attach(execution.id, resumed);
    await context.runtime.drain();
    expect(context.barrier.status).toBe('tripped');
    expect(context.executions.get(execution.id)).toMatchObject({
      lifecycle: 'running',
      lastAdapterCursor: 5,
    });
    expect(
      context.fixture.events.runtimeAfter(context.fixture.project.id, 0).events,
    ).toHaveLength(runtimeCount);
    expect(context.published.runtime).toHaveLength(publishedCount);
    expect(resumed.consumedAdapterCursors).toEqual([6]);
    expect(resumed.closeCount).toBe(1);
  });

  it('contains failed adapter-error terminalization without masking it', async () => {
    const fake = new FakeHarnessAdapter({
      holdAfterAdapterCursor: 1,
      failAtAdapterCursor: 2,
    });
    const context = createRuntime({ fake });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const execution = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected an execution held before adapter failure',
    );
    context.fixture.database.exec(`
      CREATE TRIGGER fail_adapter_terminalization BEFORE UPDATE ON worker_executions
      BEGIN SELECT RAISE(ABORT, 'fail adapter terminalization'); END
    `);
    const resumed = await fake.resume({
      executionId: execution.id,
      project: context.fixture.project,
      assignment: execution.assignment,
      profile: execution.profileSnapshot,
      resolvedSkills: execution.resolvedSkills,
      nativeHandle: required(
        execution.nativeHandle,
        'Expected a native handle',
      ),
      afterAdapterCursor: execution.lastAdapterCursor,
    });
    context.runtime.attach(execution.id, resumed);
    await context.runtime.drain();
    expect(context.barrier.status).toBe('tripped');
    expect(context.executions.get(execution.id)?.lifecycle).toBe('running');
    expect(resumed.consumedAdapterCursors).toEqual([2]);
    expect(resumed.closeCount).toBe(1);
  });

  it('contains an interrupt proof transaction failure and preserves the accepted receipt', async () => {
    const context = createRuntime();
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    let releaseIterator: (() => void) | undefined;
    const iteratorReleased = new Promise<void>((resolve) => {
      releaseIterator = resolve;
    });
    let closed = false;
    let closeCount = 0;
    const ownedSession: HarnessSession = {
      nativeHandle: required(running.nativeHandle, 'Expected a native handle'),
      events() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await iteratorReleased;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        closeCount += 1;
        releaseIterator?.();
      },
    };
    context.runtime.attach(running.id, ownedSession);
    context.fixture.database.exec(`
      CREATE TRIGGER fail_interrupt_proof BEFORE UPDATE ON worker_executions
      WHEN NEW.lifecycle IN ('interrupted', 'attention_required')
      BEGIN SELECT RAISE(ABORT, 'fail interrupt proof'); END
    `);
    const interrupt: InterruptExecutionEnvelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.interrupt',
        projectId: running.projectId,
        executionId: running.id,
        expectedRevision: running.revision,
      },
    };
    const publishedBefore = context.published.domain.length;
    const result = await context.runtime.interrupt(interrupt);
    await context.runtime.drain();
    expect(result).toMatchObject({
      ok: true,
      execution: { lifecycle: 'interrupting' },
    });
    expect(
      context.fixture.commands.find(interrupt.idempotencyKey)?.result,
    ).toEqual(result);
    expect(context.barrier.status).toBe('tripped');
    expect(closeCount).toBe(1);
    expect(context.fake.interruptCalls).toHaveLength(2);
    expect(context.published.domain).toHaveLength(publishedBefore + 1);
    expect(context.executions.get(running.id)?.lifecycle).toBe('interrupting');
    expect(
      context.operations
        .listForExecution(running.id)
        .find((operation) => operation.kind === 'interrupt')?.state,
    ).toBe('pending');
  });
});
