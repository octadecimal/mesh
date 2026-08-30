import { randomUUID } from 'node:crypto';

import {
  PM_DISCOVERY_REPORT_SCHEMA,
  startExecutionEnvelopeSchema,
  type DomainEvent,
  type HarnessAdapter,
  type HarnessEventEnvelope,
  type HarnessOperationResult,
  type HarnessSession,
  type ResolvedWorkerProfileSnapshot,
  type RuntimeEvent,
  type WorkerExecution,
} from '@mesh/v2-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createV2TestDatabase } from '../test/create-v2-test-database';
import { AuditBarrier } from '../executions/audit-barrier';
import { ExecutionRepository } from '../executions/execution-repository';
import {
  ExecutionRuntime,
  PlanningInterruptCleanupError,
} from '../executions/execution-runtime';
import { FakeHarnessAdapter } from '../executions/fake-harness';
import { OperationRepository } from '../executions/operation-repository';
import {
  createPlanningLauncher,
  createPlanningRuntime,
} from './planning-runtime';

const projectId = randomUUID();
const humanTurnId = randomUUID();
const launchInput = startExecutionEnvelopeSchema.parse({
  idempotencyKey: `planning-turn:${randomUUID()}`,
  actor: { kind: 'human' },
  command: {
    type: 'worker_execution.start',
    projectId,
    profileId: randomUUID(),
    profileRevision: 2,
    assignment: {
      kind: 'pm_discovery',
      projectId,
      outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
      planningCycleId: randomUUID(),
      humanTurnId,
      expectedCycleRevision: 3,
      expectedProposalRevision: 1,
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      input: {
        conversation: [
          {
            turnId: humanTurnId,
            actor: 'human',
            message: 'Plan the Todo feature.',
          },
        ],
        latestProposal: null,
        approvedIntentLedger: null,
      },
    },
  },
});

const reservation = {
  execution: { id: randomUUID() } as WorkerExecution,
  result: {
    ok: false as const,
    commandType: 'worker_execution.start' as const,
    error: {
      code: 'required_capability_unavailable' as const,
      message: 'Unavailable',
    },
  },
  activationRequired: false,
};

const runtime = () => ({
  findReservedStart: vi.fn(() => reservation),
  reserveStart: vi.fn(async () => reservation),
  activateReserved: vi.fn(async () => undefined),
  cancelReserved: vi.fn(async () => reservation.execution),
  interruptForPlanning: vi.fn(async () => undefined),
});

const runningPlanningComposition = async ({
  closeError,
  interruptResult = { status: 'succeeded' },
  tripBarrierOnInterrupt = false,
}: {
  closeError?: Error;
  interruptResult?: HarnessOperationResult;
  tripBarrierOnInterrupt?: boolean;
} = {}) => {
  const fixture = createV2TestDatabase();
  const fake = new FakeHarnessAdapter({ pmScenario: 'todo' });
  const executions = new ExecutionRepository(fixture.database);
  const operations = new OperationRepository(fixture.database);
  const barrier = new AuditBarrier();
  const published = {
    domain: [] as DomainEvent[],
    runtime: [] as RuntimeEvent[],
  };
  const trace: string[] = [];
  let releaseConsumer!: () => void;
  const consumerReleased = new Promise<void>((resolve) => {
    releaseConsumer = resolve;
  });
  const adapter: HarnessAdapter = {
    id: fake.id,
    capabilities: () => fake.capabilities(),
    resolveSkills: (requests) => fake.resolveSkills(requests),
    start: async (request) => {
      const session = await fake.start(request);
      return {
        nativeHandle: session.nativeHandle,
        events(afterAdapterCursor) {
          const iterator = session
            .events(afterAdapterCursor)
            [Symbol.asyncIterator]();
          return {
            async next() {
              trace.push('consumer-waiting');
              await consumerReleased;
              trace.push('late-output-returned');
              return iterator.next();
            },
            return: () =>
              iterator.return?.() ??
              Promise.resolve({ done: true as const, value: undefined }),
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        },
        async close() {
          trace.push('session-close');
          releaseConsumer();
          if (closeError) throw closeError;
        },
      } satisfies HarnessSession;
    },
    probe: (nativeHandle) => fake.probe(nativeHandle),
    resume: (request) => fake.resume(request),
    interrupt: async (nativeHandle) => {
      trace.push('adapter-interrupt');
      if (tripBarrierOnInterrupt) {
        barrier.trip(
          new Error('planning interrupt audit failed'),
          '2026-08-28T01:00:00.000Z',
        );
      }
      if (interruptResult.status === 'succeeded') {
        await fake.interrupt(nativeHandle);
      }
      return interruptResult;
    },
  };
  const profile: ResolvedWorkerProfileSnapshot = {
    profileId: fixture.pmProfileRevision.profileId,
    projectId: fixture.pmProfileRevision.projectId,
    profileRevision: fixture.pmProfileRevision.revision,
    baseProfileId: fixture.pmProfileRevision.baseProfileId,
    baseRevision: fixture.pmProfileRevision.baseRevision,
    document: fixture.pmProfileRevision.document,
    digest: fixture.pmProfileRevision.digest,
  };
  const profiles = { resolveApproved: () => profile };
  const executionRuntime = new ExecutionRuntime({
    database: fixture.database,
    commands: fixture.commands,
    events: fixture.events,
    projects: {
      get: (candidate) =>
        candidate === fixture.project.id ? fixture.project : undefined,
    },
    profiles,
    executions,
    operations,
    adapter,
    publisher: {
      domain: (event) => published.domain.push(event),
      runtime: (event) => published.runtime.push(event),
    },
    barrier,
    now: () => '2026-08-28T01:00:00.000Z',
    observer: {
      structuredOutput: (execution, event) =>
        planningObserver.structuredOutput(execution, event),
      terminal: (execution) => planningObserver.terminal(execution),
    },
  });
  const planning = createPlanningRuntime({
    database: fixture.database,
    commands: fixture.commands,
    events: fixture.events,
    executions,
    profiles,
    executionRuntime,
    barrier,
    now: () => '2026-08-28T01:00:00.000Z',
    publishDomain: (event) => published.domain.push(event),
  });
  const planningObserver = planning.observer;
  const submitted = await planning.service.submitTurn({
    idempotencyKey: `composed-cleanup-submit:${randomUUID()}`,
    actor: { kind: 'human' },
    command: {
      type: 'planning_cycle.submit_turn',
      projectId: fixture.project.id,
      expectedCycleRevision: null,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      message: 'Build a persistent Todo application.',
    },
  });
  expect(submitted).toMatchObject({ ok: true });
  const cycle = planning.repository.activeCycle(fixture.project.id);
  if (!cycle?.activeExecutionId) {
    throw new Error('Expected an active planning execution');
  }
  return {
    fixture,
    executions,
    operations,
    executionRuntime,
    planning,
    published,
    trace,
    cycle,
    executionId: cycle.activeExecutionId,
    consumerReleased,
    releaseConsumer,
  };
};

describe('planning runtime composition', () => {
  it('forwards the exact validated launch envelope for lookup and reservation', async () => {
    const executionRuntime = runtime();
    const launcher = createPlanningLauncher(
      executionRuntime as unknown as Pick<
        ExecutionRuntime,
        | 'findReservedStart'
        | 'reserveStart'
        | 'activateReserved'
        | 'cancelReserved'
        | 'interruptForPlanning'
      >,
    );

    expect(launcher.findReserved(launchInput)).toBe(reservation);
    await expect(launcher.reserve(launchInput)).resolves.toBe(reservation);
    expect(executionRuntime.findReservedStart).toHaveBeenCalledWith(
      launchInput,
    );
    expect(executionRuntime.reserveStart).toHaveBeenCalledWith(launchInput);
    expect(executionRuntime.findReservedStart.mock.calls[0]?.[0]).toBe(
      launchInput,
    );
    expect(executionRuntime.reserveStart.mock.calls[0]?.[0]).toBe(launchInput);
  });

  it('maps activation, cancellation, and awaited internal interruption only by execution id', async () => {
    const executionRuntime = runtime();
    let release!: () => void;
    executionRuntime.interruptForPlanning.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const launcher = createPlanningLauncher(
      executionRuntime as unknown as Pick<
        ExecutionRuntime,
        | 'findReservedStart'
        | 'reserveStart'
        | 'activateReserved'
        | 'cancelReserved'
        | 'interruptForPlanning'
      >,
    );
    const executionId = reservation.execution.id;

    await launcher.activate(executionId);
    await launcher.cancelReserved(executionId);
    let settled = false;
    const interrupted = launcher
      .interruptForPlanning(executionId)
      .then(() => (settled = true));
    await Promise.resolve();

    expect(executionRuntime.activateReserved).toHaveBeenCalledWith(executionId);
    expect(executionRuntime.cancelReserved).toHaveBeenCalledWith(executionId);
    expect(executionRuntime.interruptForPlanning).toHaveBeenCalledWith(
      executionId,
    );
    expect(settled).toBe(false);
    release();
    await interrupted;
    expect(settled).toBe(true);
  });

  it('awaits a running Abandon drain and fences late PM output before committing the cycle result', async () => {
    const fixture = createV2TestDatabase();
    const fake = new FakeHarnessAdapter({ pmScenario: 'todo' });
    const executions = new ExecutionRepository(fixture.database);
    const operations = new OperationRepository(fixture.database);
    const barrier = new AuditBarrier();
    const published = {
      domain: [] as DomainEvent[],
      runtime: [] as RuntimeEvent[],
    };
    const trace: string[] = [];
    let closeConsumer!: () => void;
    const consumerClosed = new Promise<void>((resolve) => {
      closeConsumer = resolve;
    });
    let lateOutputReady!: () => void;
    const lateOutputBlocked = new Promise<void>((resolve) => {
      lateOutputReady = resolve;
    });
    let releaseLateOutput!: () => void;
    const lateOutputReleased = new Promise<void>((resolve) => {
      releaseLateOutput = resolve;
    });
    const fakeStart = fake.start.bind(fake);
    vi.spyOn(fake, 'start').mockImplementation(async (request) => {
      const session = await fakeStart(request);
      return {
        nativeHandle: session.nativeHandle,
        events(afterAdapterCursor) {
          const iterator = session
            .events(afterAdapterCursor)
            [Symbol.asyncIterator]();
          let first = true;
          const controlled = {
            async next(): Promise<IteratorResult<HarnessEventEnvelope>> {
              if (first) {
                first = false;
                trace.push('consumer-waiting');
                await consumerClosed;
                trace.push('late-output-ready');
                lateOutputReady();
                await lateOutputReleased;
              }
              const item = await iterator.next();
              trace.push('late-output-returned');
              return item;
            },
            async return(): Promise<IteratorResult<HarnessEventEnvelope>> {
              await iterator.return?.();
              await session.close();
              trace.push('consumer-drained');
              return { done: true, value: undefined };
            },
            [Symbol.asyncIterator]() {
              return controlled;
            },
          };
          return controlled;
        },
        async close() {
          trace.push('session-close');
          closeConsumer();
        },
      } satisfies HarnessSession;
    });
    const fakeInterrupt = fake.interrupt.bind(fake);
    vi.spyOn(fake, 'interrupt').mockImplementation(async (nativeHandle) => {
      trace.push('adapter-interrupt');
      return fakeInterrupt(nativeHandle);
    });
    const storedResults = vi.spyOn(fixture.commands, 'storeInTransaction');
    const profile: ResolvedWorkerProfileSnapshot = {
      profileId: fixture.pmProfileRevision.profileId,
      projectId: fixture.pmProfileRevision.projectId,
      profileRevision: fixture.pmProfileRevision.revision,
      baseProfileId: fixture.pmProfileRevision.baseProfileId,
      baseRevision: fixture.pmProfileRevision.baseRevision,
      document: fixture.pmProfileRevision.document,
      digest: fixture.pmProfileRevision.digest,
    };
    const profiles = {
      resolveApproved: () => profile,
    };
    const executionRuntime = new ExecutionRuntime({
      database: fixture.database,
      commands: fixture.commands,
      events: fixture.events,
      projects: {
        get: (candidate) =>
          candidate === fixture.project.id ? fixture.project : undefined,
      },
      profiles,
      executions,
      operations,
      adapter: fake,
      publisher: {
        domain: (event) => published.domain.push(event),
        runtime: (event) => published.runtime.push(event),
      },
      barrier,
      now: () => '2026-08-28T01:00:00.000Z',
      observer: {
        structuredOutput: (execution, event) =>
          planningObserver.structuredOutput(execution, event),
        terminal: (execution) => planningObserver.terminal(execution),
      },
    });
    const planning = createPlanningRuntime({
      database: fixture.database,
      commands: fixture.commands,
      events: fixture.events,
      executions,
      profiles,
      executionRuntime,
      barrier,
      now: () => '2026-08-28T01:00:00.000Z',
      publishDomain: (event) => published.domain.push(event),
    });
    const planningObserver = planning.observer;

    try {
      const submitted = await planning.service.submitTurn({
        idempotencyKey: 'running-abandon-submit',
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.submit_turn',
          projectId: fixture.project.id,
          expectedCycleRevision: null,
          profileId: profile.profileId,
          profileRevision: profile.profileRevision,
          message: 'Build a persistent Todo application.',
        },
      });
      expect(submitted).toMatchObject({
        ok: true,
        commandType: 'planning_cycle.submit_turn',
      });
      const cycle = planning.repository.activeCycle(fixture.project.id);
      expect(cycle).toMatchObject({ lifecycle: 'execution_active' });
      if (!cycle?.activeExecutionId) {
        throw new Error('Expected an active planning execution');
      }
      const executionId = cycle.activeExecutionId;
      const abandonId = 'running-abandon-command';
      let abandonResolved = false;
      const abandoning = planning.service
        .abandonCycle({
          idempotencyKey: abandonId,
          actor: { kind: 'human' },
          command: {
            type: 'planning_cycle.abandon',
            projectId: fixture.project.id,
            planningCycleId: cycle.id,
            expectedCycleRevision: cycle.revision,
          },
        })
        .then((result) => {
          abandonResolved = true;
          trace.push('abandon-resolved');
          return result;
        });

      await lateOutputBlocked;
      expect(trace).toEqual([
        'consumer-waiting',
        'adapter-interrupt',
        'session-close',
        'late-output-ready',
      ]);
      expect(abandonResolved).toBe(false);
      expect(fixture.commands.find(abandonId)).toBeUndefined();
      expect(planning.repository.cycle(cycle.id)).toMatchObject({
        lifecycle: 'execution_active',
      });
      expect(executions.get(executionId)).toMatchObject({
        lifecycle: 'interrupting',
      });
      expect(planning.repository.receipt(executionId)).toBeUndefined();
      expect(fixture.events.runtimeAfter(fixture.project.id, 0).events).toEqual(
        [],
      );

      releaseLateOutput();
      const abandoned = await abandoning;

      expect(abandoned).toMatchObject({
        ok: true,
        commandType: 'planning_cycle.abandon',
        planningCycle: { cycle: { lifecycle: 'abandoned' } },
      });
      expect(trace).toEqual([
        'consumer-waiting',
        'adapter-interrupt',
        'session-close',
        'late-output-ready',
        'late-output-returned',
        'abandon-resolved',
      ]);
      expect(executions.get(executionId)).toMatchObject({
        lifecycle: 'interrupted',
      });
      expect(planning.repository.receipt(executionId)).toBeUndefined();
      expect(fixture.events.runtimeAfter(fixture.project.id, 0).events).toEqual(
        [],
      );
      expect(published.runtime).toEqual([]);
      expect(
        operations
          .listForExecution(executionId)
          .filter((operation) => operation.kind === 'interrupt'),
      ).toEqual([expect.objectContaining({ state: 'succeeded' })]);
      expect(
        storedResults.mock.calls.map(([result]) => result.commandType),
      ).not.toContain('worker_execution.interrupt');
    } finally {
      releaseLateOutput();
      closeConsumer();
      await executionRuntime.drain();
      fixture.close();
    }
  });

  it.each([
    [
      'unproven adapter interruption',
      { interruptResult: { status: 'unknown', reason: 'interrupt unproven' } },
      'planning_interrupt_unproven',
      'adapter_interrupt',
    ],
    [
      'session close failure',
      { closeError: new Error('planning close failed') },
      'planning_interrupt_quiescence_failure',
      'session_close',
    ],
    [
      'consumer task settlement failure',
      {},
      'planning_interrupt_quiescence_failure',
      'consumer_join',
    ],
    [
      'audit failure after adapter interruption',
      { tripBarrierOnInterrupt: true },
      'planning_interrupt_audit_failure',
      'audit',
    ],
  ] as const)(
    'withholds a successful Abandon after a composed %s',
    async (name, options, code, diagnosticPhase) => {
      const context = await runningPlanningComposition(options);
      const commandId = `composed-cleanup-abandon:${name}`;
      if (name === 'consumer task settlement failure') {
        const active = (
          context.executionRuntime as unknown as {
            active: Map<string, { task: Promise<void> }>;
          }
        ).active;
        const owned = active.get(context.executionId);
        if (!owned) throw new Error('Expected exact active session ownership');
        const original = owned.task;
        void original.catch(() => undefined);
        owned.task = context.consumerReleased
          .then(() => {
            throw new Error('consumer settlement failed');
          })
          .finally(() => {
            if (active.get(context.executionId) === owned) {
              active.delete(context.executionId);
            }
          });
      }
      try {
        await expect(
          context.planning.service.abandonCycle({
            idempotencyKey: commandId,
            actor: { kind: 'human' },
            command: {
              type: 'planning_cycle.abandon',
              projectId: context.fixture.project.id,
              planningCycleId: context.cycle.id,
              expectedCycleRevision: context.cycle.revision,
            },
          }),
        ).rejects.toMatchObject({
          name: PlanningInterruptCleanupError.name,
          code,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ phase: diagnosticPhase }),
          ]),
        });

        expect(context.fixture.commands.find(commandId)).toBeUndefined();
        expect(
          context.planning.repository.cycle(context.cycle.id),
        ).toMatchObject({ revision: context.cycle.revision });
        expect(
          context.planning.repository.cycle(context.cycle.id)?.lifecycle,
        ).not.toBe('abandoned');
        expect(
          context.published.domain.filter(
            (event) =>
              event.type === 'planning_cycle.changed' &&
              event.payload.planningCycle.cycle.lifecycle === 'abandoned',
          ),
        ).toEqual([]);
        expect(
          context.planning.repository.receipt(context.executionId),
        ).toBeUndefined();
        expect(context.published.runtime).toEqual([]);
        expect(context.trace).toEqual(
          expect.arrayContaining([
            'consumer-waiting',
            'adapter-interrupt',
            'session-close',
            'late-output-returned',
          ]),
        );
        expect(
          context.operations
            .listForExecution(context.executionId)
            .filter(({ kind }) => kind === 'interrupt'),
        ).not.toEqual([expect.objectContaining({ state: 'succeeded' })]);
        const counts = {
          domain: context.published.domain.length,
          runtime: context.published.runtime.length,
        };
        context.releaseConsumer();
        await context.executionRuntime.drain();
        expect(context.published.domain).toHaveLength(counts.domain);
        expect(context.published.runtime).toHaveLength(counts.runtime);
      } finally {
        context.releaseConsumer();
        await context.executionRuntime.drain();
        context.fixture.close();
      }
    },
  );

  it('withholds Abandon when the composed runtime reports that the execution is not running', async () => {
    const context = await runningPlanningComposition();
    const commandId = 'composed-cleanup-not-running';
    vi.spyOn(
      context.executionRuntime,
      'interruptForPlanning',
    ).mockRejectedValueOnce(
      new PlanningInterruptCleanupError(
        'planning_interrupt_not_running',
        'Execution is not an active planning runtime',
      ),
    );
    try {
      await expect(
        context.planning.service.abandonCycle({
          idempotencyKey: commandId,
          actor: { kind: 'human' },
          command: {
            type: 'planning_cycle.abandon',
            projectId: context.fixture.project.id,
            planningCycleId: context.cycle.id,
            expectedCycleRevision: context.cycle.revision,
          },
        }),
      ).rejects.toMatchObject({
        name: PlanningInterruptCleanupError.name,
        code: 'planning_interrupt_not_running',
      });
      expect(context.fixture.commands.find(commandId)).toBeUndefined();
      expect(context.planning.repository.cycle(context.cycle.id)).toMatchObject(
        {
          lifecycle: 'execution_active',
          revision: context.cycle.revision,
        },
      );
      expect(
        context.published.domain.filter(
          (event) =>
            event.type === 'planning_cycle.changed' &&
            event.payload.planningCycle.cycle.lifecycle === 'abandoned',
        ),
      ).toEqual([]);
    } finally {
      context.releaseConsumer();
      await context.executionRuntime.drain();
      context.fixture.close();
    }
  });
});
