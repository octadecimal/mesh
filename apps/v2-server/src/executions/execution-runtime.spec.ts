import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  InterruptExecutionEnvelope,
  ResolvedWorkerProfileSnapshot,
  StartExecutionEnvelope,
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
    const firstResult = context.runtime.start(context.start);
    const secondResult = second.start(context.start);
    await fake.waitUntilCapabilitiesCalled(2);
    fake.releaseCapabilities();
    const [first, replay] = await Promise.all([firstResult, secondResult]);
    expect(replay).toEqual(first);
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
});
