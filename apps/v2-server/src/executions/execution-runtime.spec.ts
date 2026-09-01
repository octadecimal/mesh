import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DomainEvent,
  HarnessEventEnvelope,
  HarnessSession,
  HarnessStartRequest,
  InterruptExecutionEnvelope,
  Project,
  ResolvedWorkerProfileSnapshot,
  RuntimeEvent,
  StartExecutionEnvelope,
  WorkerExecution,
} from '@mesh/v2-contracts';
import {
  approvedIntentLedgerSchema,
  PM_DISCOVERY_REPORT_SCHEMA,
  PM_PLAN_REPORT_SCHEMA,
  pmDiscoveryReportSchema,
  pmPlanReportSchema,
} from '@mesh/v2-contracts';

import { inImmediateTransaction } from '../db/database.js';
import {
  hashV2Command,
  V2IdempotencyConflictError,
} from '../storage/command-repository.js';
import {
  createV2TestDatabase,
  insertV2TestProject,
  type V2TestDatabase,
} from '../test/create-v2-test-database.js';
import { AuditBarrier } from './audit-barrier.js';
import { ExecutionRepository } from './execution-repository.js';
import {
  ExecutionReservationError,
  ExecutionRuntime,
  PlanningInterruptCleanupError,
  type ExecutionRuntimeObserver,
} from './execution-runtime.js';
import { FakeHarnessAdapter, type FakeHarnessOptions } from './fake-harness.js';
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
    project?: (project: Project) => Project;
    publisher?: {
      domain(event: DomainEvent): void;
      runtime(event: RuntimeEvent): void;
    };
    observer?: ExecutionRuntimeObserver;
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
  const project = options.project?.(fixture.project) ?? fixture.project;
  const runtime = new ExecutionRuntime({
    database: fixture.database,
    commands: fixture.commands,
    events: fixture.events,
    projects: {
      get: (id) => (id === fixture.project.id ? project : undefined),
    },
    profiles: { resolveApproved: () => profile },
    executions,
    operations,
    adapter: fake,
    publisher: options.publisher ?? {
      domain: (event) => published.domain.push(event),
      runtime: (event) => published.runtime.push(event),
    },
    barrier,
    now: () => '2026-08-28T01:00:00.000Z',
    observer: options.observer,
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

const createPmRuntime = (
  scenario: 'todo' | 'malformed',
  fakeOptions: Omit<FakeHarnessOptions, 'pmScenario'> = {},
  publisher?: {
    domain(event: DomainEvent): void;
    runtime(event: RuntimeEvent): void;
  },
  observer?: ExecutionRuntimeObserver,
) => {
  const context = createRuntime({
    fake: new FakeHarnessAdapter({ ...fakeOptions, pmScenario: scenario }),
    publisher,
    observer,
    profile: (profile) => ({
      ...profile,
      document: {
        ...profile.document,
        spec: {
          ...profile.document.spec,
          assignmentKinds: ['pm_discovery'],
          outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
        },
      },
    }),
  });
  const humanTurnId = randomUUID();
  context.start.command.assignment = {
    kind: 'pm_discovery',
    projectId: context.fixture.project.id,
    outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
    planningCycleId: randomUUID(),
    humanTurnId,
    expectedCycleRevision: 1,
    expectedProposalRevision: 1,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    input: {
      conversation: [
        {
          turnId: humanTurnId,
          actor: 'human',
          message: 'Build a Todo application.',
        },
      ],
      latestProposal: null,
      approvedIntentLedger: null,
    },
  };
  return context;
};

const createPlanRuntime = (
  scenario:
    | 'todo'
    | 'malformed'
    | 'duplicate'
    | 'conflicting'
    | 'missing_output',
  fakeOptions: Omit<FakeHarnessOptions, 'pmScenario'> = {},
  publisher?: {
    domain(event: DomainEvent): void;
    runtime(event: RuntimeEvent): void;
  },
  observer?: ExecutionRuntimeObserver,
) => {
  const context = createRuntime({
    fake: new FakeHarnessAdapter({ ...fakeOptions, pmScenario: scenario }),
    publisher,
    observer,
    profile: (profile) => ({
      ...profile,
      document: {
        ...profile.document,
        spec: {
          ...profile.document.spec,
          assignmentKinds: ['pm_plan'],
          outputSchema: PM_PLAN_REPORT_SCHEMA,
        },
      },
    }),
  });
  const humanTurnId = randomUUID();
  const intentId = randomUUID();
  const ledgerId = randomUUID();
  const proposalId = randomUUID();
  const requirementId = randomUUID();
  const provenance = [
    {
      kind: 'conversation_turn' as const,
      turnId: humanTurnId,
      rationale: 'The operator approved the Todo requirement.',
    },
  ];
  context.start.command.assignment = {
    kind: 'pm_plan',
    projectId: context.fixture.project.id,
    outputSchema: PM_PLAN_REPORT_SCHEMA,
    planningCycleId: randomUUID(),
    humanTurnId,
    expectedCycleRevision: 1,
    expectedProposalRevision: 1,
    baseProjectIntentId: intentId,
    baseProjectIntentRevision: 1,
    baseLedgerId: ledgerId,
    baseLedgerRevision: 1,
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
    input: {
      conversation: [
        {
          turnId: humanTurnId,
          actor: 'human',
          message: 'Propose the approved Todo delivery plan.',
        },
      ],
      approvedIntentLedger: approvedIntentLedgerSchema.parse({
        projectIntent: {
          id: intentId,
          projectId: context.fixture.project.id,
          revision: 1,
          content: {
            goal: 'Track Todo items.',
            targetUsers: ['Individuals'],
            desiredCapabilities: ['Add and complete Todo items'],
            constraints: ['Keyboard controls'],
            nonGoals: ['Collaboration'],
            successConditions: ['Todo items persist'],
            rationale: 'Approved Todo scope.',
            provenance,
          },
          proposalId,
          approvedBy: 'human',
          approvedAt: '2026-08-30T00:00:00.000Z',
        },
        ledger: {
          id: ledgerId,
          projectId: context.fixture.project.id,
          revision: 1,
          proposalId,
          approvedBy: 'human',
          approvedAt: '2026-08-30T00:00:00.000Z',
        },
        records: [
          {
            recordId: requirementId,
            projectId: context.fixture.project.id,
            revision: 1,
            content: {
              type: 'requirement',
              kind: 'functional',
              status: 'approved',
              priority: 'must',
              statement: 'Users can add and complete Todo items.',
              rationale: 'This is the core Todo workflow.',
            },
            provenance,
            proposalId,
            approvedBy: 'human',
            approvedAt: '2026-08-30T00:00:00.000Z',
          },
        ],
        relationships: [],
      }),
      latestProposal: null,
      approvedDeliveryPlan: null,
    },
  };
  return context;
};

describe('planning observer', () => {
  it('notifies after durable runtime and terminal publication exactly once', async () => {
    const trace: string[] = [];
    const observer: ExecutionRuntimeObserver = {
      structuredOutput: vi.fn((execution, event) => {
        expect(
          context.fixture.events.runtimeAfter(execution.projectId, 0).events,
        ).toContainEqual(event);
        trace.push('consume');
      }),
      terminal: vi.fn((execution) => {
        expect(context.executions.get(execution.id)?.lifecycle).toBe(
          'completed',
        );
        trace.push('terminal');
      }),
    };
    const context = createPmRuntime(
      'todo',
      {},
      {
        runtime: (event) => {
          if (event.type === 'worker_execution.structured_output') {
            trace.push('publish-output');
          }
        },
        domain: (event) => {
          if (
            event.type === 'worker_execution.lifecycle_changed' &&
            event.payload.execution.lifecycle === 'completed'
          ) {
            trace.push('publish-terminal');
          }
        },
      },
      observer,
    );

    await context.runtime.start(context.start);
    await context.runtime.drain();

    expect(observer.structuredOutput).toHaveBeenCalledTimes(1);
    expect(observer.terminal).toHaveBeenCalledTimes(1);
    expect(trace).toEqual([
      'publish-output',
      'consume',
      'publish-terminal',
      'terminal',
    ]);
  });

  it('contains an observer audit failure without recording an adapter failure', async () => {
    let context!: ReturnType<typeof createPmRuntime>;
    const observer: ExecutionRuntimeObserver = {
      structuredOutput: () => {
        const error = new Error('Developer receipt audit failed');
        context.barrier.trip(error);
        throw error;
      },
      terminal: vi.fn(),
    };
    context = createPmRuntime('todo', {}, undefined, observer);

    const result = await context.runtime.start(context.start);
    await context.runtime.drain();

    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';
    expect(context.barrier.status).toBe('tripped');
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'running',
      failure: null,
    });
    expect(
      context.published.domain.filter((event) => {
        const domain = event as DomainEvent;
        return (
          domain.type === 'worker_execution.lifecycle_changed' &&
          domain.payload.execution.lifecycle === 'failed'
        );
      }),
    ).toHaveLength(0);
    expect(observer.terminal).not.toHaveBeenCalled();
  });
});

const durableReservationState = (fixture: V2TestDatabase) => ({
  executions: fixture.database
    .prepare('SELECT * FROM worker_executions ORDER BY id')
    .all(),
  operations: fixture.database
    .prepare('SELECT * FROM execution_operations ORDER BY id')
    .all(),
  domain: fixture.database
    .prepare('SELECT * FROM domain_events ORDER BY id')
    .all(),
  commands: fixture.database
    .prepare('SELECT * FROM command_results ORDER BY idempotency_key')
    .all(),
});

const durableRuntimeState = (fixture: V2TestDatabase) => ({
  ...durableReservationState(fixture),
  diagnostics: fixture.database
    .prepare('SELECT * FROM raw_diagnostics ORDER BY id')
    .all(),
  runtime: fixture.database
    .prepare('SELECT * FROM runtime_events ORDER BY id')
    .all(),
});

const recordPlanningMigration = (
  fixture: V2TestDatabase,
  appliedAt: string,
): void => {
  const existing = fixture.database
    .prepare(
      `UPDATE v2_schema_migrations
       SET applied_at = ?
       WHERE version = 2`,
    )
    .run(appliedAt);
  if (existing.changes > 0) return;

  fixture.database
    .prepare(
      `INSERT INTO v2_schema_migrations (version, name, applied_at)
       VALUES (2, '002_intent_ledger', ?)`,
    )
    .run(appliedAt);
};

const removePlanningMigrationAuthority = (fixture: V2TestDatabase): void => {
  fixture.database
    .prepare('DELETE FROM v2_schema_migrations WHERE version = 2')
    .run();
};

const seedLegacyTerminalFoundationStart = (
  context: ReturnType<typeof createRuntime>,
) => {
  const requestHash = hashV2Command(context.start.command);
  const occurredAt = '2026-08-28T01:00:00.000Z';
  const failure = {
    code: 'required_capability_unavailable' as const,
    message: 'Required adapter capabilities are unavailable',
    missing: ['execution.stream'],
  };
  const execution: WorkerExecution = {
    id: randomUUID(),
    projectId: context.fixture.project.id,
    profileId: context.fixture.profileRevision.profileId,
    profileRevision: context.fixture.profileRevision.revision,
    assignment: context.start.command.assignment,
    profileSnapshot: {
      profileId: context.fixture.profileRevision.profileId,
      projectId: context.fixture.profileRevision.projectId,
      profileRevision: context.fixture.profileRevision.revision,
      baseProfileId: context.fixture.profileRevision.baseProfileId,
      baseRevision: context.fixture.profileRevision.baseRevision,
      document: context.fixture.profileRevision.document,
      digest: context.fixture.profileRevision.digest,
    },
    skillRequests: { preferred: [], required: [] },
    resolvedSkills: [],
    capabilitySnapshot: context.fake.capabilitiesValue,
    adapterId: context.fake.capabilitiesValue.adapterId,
    model: context.fixture.profileRevision.document.spec.preferredRuntime.model,
    nativeHandle: null,
    lifecycle: 'failed',
    revision: 1,
    lastAdapterCursor: 0,
    lastRuntimeSequence: 0,
    replacementForExecutionId: null,
    failure,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    endedAt: occurredAt,
  };
  const result = {
    ok: false,
    commandType: 'worker_execution.start',
    error: {
      code: 'required_capability_unavailable',
      message: failure.message,
    },
  } as const;
  inImmediateTransaction(context.fixture.database, () => {
    context.executions.insertInTransaction(execution);
    context.fixture.commands.storeInTransaction({
      idempotencyKey: context.start.idempotencyKey,
      commandType: context.start.command.type,
      requestHash,
      result,
      createdAt: occurredAt,
    });
  });
  return { execution, result };
};

const attachBlockedPlanningSession = async (
  context: ReturnType<typeof createPmRuntime>,
  running: WorkerExecution,
  closeThrows = false,
) => {
  let releaseNext: (() => void) | undefined;
  const blockedNext = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  let nextCalledResolve: (() => void) | undefined;
  const nextCalled = new Promise<void>((resolve) => {
    nextCalledResolve = resolve;
  });
  const state = { closeCount: 0 };
  const session: HarnessSession = {
    nativeHandle: required(running.nativeHandle, 'Expected a native handle'),
    events: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<HarnessEventEnvelope>> {
            nextCalledResolve?.();
            await blockedNext;
            return { done: true, value: undefined };
          },
        };
      },
    }),
    async close() {
      state.closeCount += 1;
      releaseNext?.();
      if (closeThrows) throw new Error('planning close failure');
    },
  };
  context.runtime.attach(running.id, session);
  await nextCalled;
  return { session, state };
};

const attachLatePlanningSession = async (
  context: ReturnType<typeof createPmRuntime>,
  execution: WorkerExecution,
  nativeHandle = required(execution.nativeHandle, 'Expected a native handle'),
) => {
  let releaseNext: (() => void) | undefined;
  const blockedNext = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  let nextCalledResolve: (() => void) | undefined;
  const nextCalled = new Promise<void>((resolve) => {
    nextCalledResolve = resolve;
  });
  const state = { closeCount: 0 };
  const session: HarnessSession = {
    nativeHandle,
    events: () => ({
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next(): Promise<IteratorResult<HarnessEventEnvelope>> {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            nextCalledResolve?.();
            await blockedNext;
            return {
              done: false,
              value: {
                adapterCursor: execution.lastAdapterCursor + 1,
                raw: { source: 'late planning audit-conflict output' },
                normalized: {
                  projectId: execution.projectId,
                  executionId: execution.id,
                  adapterCursor: execution.lastAdapterCursor + 1,
                  occurredAt: '2026-08-28T01:00:03.000Z',
                  type: 'worker_execution.structured_output',
                  payload: {
                    schema: PM_DISCOVERY_REPORT_SCHEMA,
                    value: { late: true },
                  },
                },
              },
            };
          },
        };
      },
    }),
    async close() {
      state.closeCount += 1;
      releaseNext?.();
    },
  };
  context.runtime.attach(execution.id, session);
  await nextCalled;
  return { release: () => releaseNext?.(), session, state };
};

describe('ExecutionRuntime', () => {
  it('binds the exact plan assignment before one finite activation', async () => {
    const context = createPlanRuntime('todo');

    const reservation = await context.runtime.reserveStart(context.start);

    expect(context.fake.startCount).toBe(0);
    expect(reservation.execution).toMatchObject({
      assignment: context.start.command.assignment,
      lifecycle: 'starting',
      nativeHandle: null,
    });
    await context.runtime.activateReserved(reservation.execution.id);
    await context.runtime.drain();
    expect(context.fake.startCount).toBe(1);
    expect(context.fake.resumeCount).toBe(0);
    expect(context.executions.get(reservation.execution.id)).toMatchObject({
      lifecycle: 'completed',
    });
  });

  it('audits the exact plan report before runtime publication', async () => {
    const published: RuntimeEvent[] = [];
    const contextRef: { current?: ReturnType<typeof createPlanRuntime> } = {};
    const context = createPlanRuntime(
      'todo',
      {},
      {
        domain: () => undefined,
        runtime: (event) => {
          const current = required(contextRef.current, 'Expected plan runtime');
          expect(
            current.fixture.database
              .prepare('SELECT id FROM raw_diagnostics WHERE id = ?')
              .get(event.diagnosticId),
          ).toEqual({ id: event.diagnosticId });
          published.push(event);
        },
      },
    );
    contextRef.current = context;

    await context.runtime.start(context.start);
    await context.runtime.drain();

    const runtime = context.fixture.events.runtimeAfter(
      context.fixture.project.id,
      0,
    ).events;
    const output = runtime[0];
    expect(runtime.map(({ type }) => type)).toEqual([
      'worker_execution.structured_output',
      'worker_execution.completed',
    ]);
    if (output?.type !== 'worker_execution.structured_output') {
      throw new Error('Expected plan structured output');
    }
    expect(output.payload.schema).toBe(PM_PLAN_REPORT_SCHEMA);
    expect(pmPlanReportSchema.parse(output.payload.value)).toMatchObject({
      schema: PM_PLAN_REPORT_SCHEMA,
      result: { kind: 'plan_proposal' },
    });
    expect(published).toEqual(runtime);
  });

  it.each([
    ['duplicate' as const, true],
    ['conflicting' as const, false],
  ])(
    'forwards %s plan receipts without runtime deduplication',
    async (scenario, same) => {
      const receipts: unknown[] = [];
      const observer: ExecutionRuntimeObserver = {
        structuredOutput: (_execution, event) =>
          receipts.push(event.payload.value),
        terminal: () => undefined,
      };
      const context = createPlanRuntime(scenario, {}, undefined, observer);

      await context.runtime.start(context.start);
      await context.runtime.drain();

      expect(receipts).toHaveLength(2);
      expect(receipts[0] === receipts[1]).toBe(false);
      if (same) expect(receipts[0]).toEqual(receipts[1]);
      else expect(receipts[0]).not.toEqual(receipts[1]);
    },
  );

  it('keeps terminal plan completion observable when no output was accepted', async () => {
    const observer: ExecutionRuntimeObserver = {
      structuredOutput: vi.fn(),
      terminal: vi.fn(),
    };
    const context = createPlanRuntime(
      'missing_output',
      {},
      undefined,
      observer,
    );

    const result = await context.runtime.start(context.start);
    await context.runtime.drain();

    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'completed',
    });
    expect(observer.structuredOutput).not.toHaveBeenCalled();
    expect(observer.terminal).toHaveBeenCalledTimes(1);
  });

  it('keeps plan adapter failure terminal and finite', async () => {
    const context = createPlanRuntime('todo', { failAtAdapterCursor: 1 });

    const result = await context.runtime.start(context.start);
    await context.runtime.drain();

    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'failed',
      failure: { code: 'internal_error' },
    });
    expect(context.fake.resumeCount).toBe(0);
  });

  it('audits and publishes a strict PM structured output before completion', async () => {
    const published: RuntimeEvent[] = [];
    const contextRef: { current?: ReturnType<typeof createPmRuntime> } = {};
    const context = createPmRuntime(
      'todo',
      {},
      {
        domain: () => undefined,
        runtime: (event) => {
          const current = required(
            contextRef.current,
            'Expected runtime context',
          );
          expect(
            current.fixture.database
              .prepare('SELECT id FROM raw_diagnostics WHERE id = ?')
              .get(event.diagnosticId),
          ).toEqual({ id: event.diagnosticId });
          published.push(event);
        },
      },
    );
    contextRef.current = context;

    const result = await context.runtime.start(context.start);
    await context.runtime.drain();

    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'completed',
      lastAdapterCursor: 2,
      lastRuntimeSequence: 2,
    });
    const runtime = context.fixture.events.runtimeAfter(
      context.fixture.project.id,
      0,
    ).events;
    expect(runtime.map((event) => event.type)).toEqual([
      'worker_execution.structured_output',
      'worker_execution.completed',
    ]);
    expect(runtime[0]).toMatchObject({
      payload: {
        schema: PM_DISCOVERY_REPORT_SCHEMA,
        value: { schema: PM_DISCOVERY_REPORT_SCHEMA },
      },
    });
    expect(published).toEqual(runtime);
    expect(
      context.fixture.database
        .prepare(
          'SELECT COUNT(*) AS count FROM raw_diagnostics WHERE execution_id = ?',
        )
        .get(executionId),
    ).toEqual({ count: 2 });
    expect(context.fake.sessions[0]?.closeCount).toBe(1);
  });

  it('audits and publishes malformed PM value for strict consumer validation', async () => {
    const context = createPmRuntime('malformed');

    const result = await context.runtime.start(context.start);
    await context.runtime.drain();

    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'completed',
      lastAdapterCursor: 2,
      lastRuntimeSequence: 2,
    });
    const runtime = context.fixture.events.runtimeAfter(
      context.fixture.project.id,
      0,
    ).events;
    expect(runtime.map((event) => event.type)).toEqual([
      'worker_execution.structured_output',
      'worker_execution.completed',
    ]);
    const output = runtime[0];
    if (output?.type !== 'worker_execution.structured_output') {
      throw new Error('Expected malformed structured output');
    }
    expect(
      pmDiscoveryReportSchema.safeParse(output.payload.value).success,
    ).toBe(false);
    expect(context.published.runtime).toEqual(runtime);
    expect(
      context.fixture.database
        .prepare(
          'SELECT payload_json FROM raw_diagnostics WHERE execution_id = ?',
        )
        .all(executionId),
    ).toHaveLength(2);
    expect(context.fake.sessions[0]?.closeCount).toBe(1);
  });

  it('reserves an exact linked execution without starting or consuming it', async () => {
    const context = createRuntime();

    const reservation = await context.runtime.reserveStart(context.start);

    expect(reservation).toMatchObject({
      activationRequired: true,
      result: { ok: true, commandType: 'worker_execution.start' },
      execution: { lifecycle: 'starting', nativeHandle: null },
    });
    expect(context.fake.startCount).toBe(0);
    expect(context.fake.sessions).toEqual([]);
    expect(context.published.runtime).toEqual([]);
    expect(
      context.operations.listForExecution(reservation.execution.id),
    ).toMatchObject([
      {
        executionId: reservation.execution.id,
        kind: 'start',
        state: 'pending',
        request: {
          version: 'mesh.v2.execution-start/v1',
          idempotencyKey: context.start.idempotencyKey,
          requestHash: hashV2Command(context.start.command),
        },
      },
    ]);
    expect(context.runtime.findReservedStart(context.start)).toEqual(
      reservation,
    );
    await expect(context.runtime.reserveStart(context.start)).resolves.toEqual(
      reservation,
    );

    await context.runtime.activateReserved(reservation.execution.id);
    await context.runtime.drain();
    expect(context.fake.startCount).toBe(1);
    expect(context.executions.get(reservation.execution.id)).toMatchObject({
      lifecycle: 'running',
      nativeHandle: expect.stringMatching(/^fake:v1:/),
    });
  });

  it('reserves an unactivated replacement linked to a terminal execution', async () => {
    const context = createRuntime();
    const first = await context.runtime.reserveStart(context.start);
    await context.runtime.activateReserved(first.execution.id);
    await context.runtime.drain();
    const running = required(
      context.executions.get(first.execution.id),
      'Expected a running execution',
    );
    await context.runtime.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.interrupt',
        projectId: running.projectId,
        executionId: running.id,
        expectedRevision: running.revision,
      },
    });
    const replacementEnvelope = {
      ...context.start,
      idempotencyKey: randomUUID(),
    };

    const replacement = await context.runtime.reserveReplacement(
      replacementEnvelope,
      first.execution.id,
    );

    expect(replacement.execution).toMatchObject({
      lifecycle: 'starting',
      replacementForExecutionId: first.execution.id,
      assignment: first.execution.assignment,
      profileSnapshot: first.execution.profileSnapshot,
    });
    expect(context.fake.startCount).toBe(1);
    expect(
      context.operations.listForExecution(replacement.execution.id),
    ).toMatchObject([
      {
        kind: 'start',
        request: { replacementForExecutionId: first.execution.id },
      },
    ]);
    await expect(
      context.runtime.reserveReplacement(
        replacementEnvelope,
        first.execution.id,
      ),
    ).resolves.toEqual(replacement);
  });

  it.each([
    { name: 'nonterminal predecessor' },
    { name: 'foreign predecessor' },
    { name: 'different assignment' },
    { name: 'different profile revision' },
    { name: 'different profile snapshot' },
  ])(
    'refuses replacement with $name before reserving any new authority',
    async ({ name }) => {
      const context = createRuntime();
      const prior = await context.runtime.reserveStart(context.start);
      if (name !== 'nonterminal predecessor') {
        await context.runtime.cancelReserved(prior.execution.id);
      }
      if (name === 'foreign predecessor') {
        const foreignProject = insertV2TestProject(context.fixture.database, {
          id: randomUUID(),
          displayName: 'Foreign',
          repositoryIdentity: 'foreign-repository',
        });
        context.fixture.database
          .prepare(
            'UPDATE worker_executions SET project_id = ?, assignment_json = ? WHERE id = ?',
          )
          .run(
            foreignProject.id,
            JSON.stringify({
              ...prior.execution.assignment,
              projectId: foreignProject.id,
            }),
            prior.execution.id,
          );
      }
      if (name === 'different profile revision') {
        context.fixture.database
          .prepare(
            `INSERT INTO worker_profile_revisions (
            profile_id, revision, source_yaml, normalized_json,
            base_profile_id, base_revision, approved_by, approved_at, digest
          ) SELECT profile_id, 2, source_yaml, normalized_json,
            base_profile_id, base_revision, approved_by, approved_at, digest
          FROM worker_profile_revisions
          WHERE profile_id = ? AND revision = 1`,
          )
          .run(prior.execution.profileId);
        context.fixture.database
          .prepare(
            'UPDATE worker_executions SET profile_revision = ?, profile_snapshot_json = ? WHERE id = ?',
          )
          .run(
            prior.execution.profileRevision + 1,
            JSON.stringify({
              ...prior.execution.profileSnapshot,
              profileRevision: prior.execution.profileRevision + 1,
            }),
            prior.execution.id,
          );
      }
      if (name === 'different profile snapshot') {
        context.fixture.database
          .prepare(
            'UPDATE worker_executions SET profile_snapshot_json = ? WHERE id = ?',
          )
          .run(
            JSON.stringify({
              ...prior.execution.profileSnapshot,
              digest: 'c'.repeat(64),
            }),
            prior.execution.id,
          );
      }
      const replacement = {
        ...context.start,
        idempotencyKey: randomUUID(),
        command:
          name === 'different assignment'
            ? {
                ...context.start.command,
                assignment: {
                  ...context.start.command.assignment,
                  title: 'A different authority',
                },
              }
            : context.start.command,
      };
      const before = durableReservationState(context.fixture);

      await expect(
        context.runtime.reserveReplacement(replacement, prior.execution.id),
      ).rejects.toBeInstanceOf(ExecutionReservationError);

      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.fake.startCount).toBe(0);
    },
  );

  it('preserves public pre-migration replay but fails direct reservation closed', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
    const context = createRuntime({ fake });
    const { result: storedResult } = seedLegacyTerminalFoundationStart(context);
    removePlanningMigrationAuthority(context.fixture);
    recordPlanningMigration(context.fixture, '2026-08-28T01:00:00.001Z');

    await expect(context.runtime.start(context.start)).resolves.toEqual(
      storedResult,
    );
    expect(context.fake.startCount).toBe(0);
    expect(
      context.fixture.database
        .prepare('SELECT * FROM execution_operations')
        .all(),
    ).toEqual([]);
    expect(() => context.runtime.findReservedStart(context.start)).toThrow(
      'Reserved start operation was not found',
    );
    expect(context.barrier.status).toBe('tripped');
  });

  it('fails terminal-shaped legacy replay closed without migration authority', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
    const context = createRuntime({ fake });
    removePlanningMigrationAuthority(context.fixture);
    seedLegacyTerminalFoundationStart(context);
    const before = durableReservationState(context.fixture);

    await expect(context.runtime.start(context.start)).rejects.toThrow(
      'Reserved start operation was not found',
    );

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(fake.startCount).toBe(0);
  });

  it.each([
    ['after', '2026-08-28T00:59:59.999Z'],
    ['at', '2026-08-28T01:00:00.000Z'],
  ] as const)(
    'fails terminal-shaped reservation created %s migration 2 closed',
    async (_relation, appliedAt) => {
      const fake = new FakeHarnessAdapter();
      fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
      const context = createRuntime({ fake });
      recordPlanningMigration(context.fixture, appliedAt);
      const reservation = await context.runtime.reserveStart(context.start);
      const operation = required(
        context.operations.listForExecution(reservation.execution.id)[0],
        'Expected failed start operation',
      );
      context.fixture.database
        .prepare('DELETE FROM execution_operations WHERE id = ?')
        .run(operation.id);
      const before = durableReservationState(context.fixture);

      await expect(context.runtime.start(context.start)).rejects.toThrow(
        'Reserved start operation was not found',
      );

      expect(context.barrier.status).toBe('tripped');
      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(fake.startCount).toBe(0);
    },
  );

  it('fails unproven legacy terminal replay closed', async () => {
    const context = createRuntime();
    const requestHash = hashV2Command(context.start.command);
    inImmediateTransaction(context.fixture.database, () => {
      context.fixture.commands.storeInTransaction({
        idempotencyKey: context.start.idempotencyKey,
        commandType: context.start.command.type,
        requestHash,
        result: {
          ok: false,
          commandType: 'worker_execution.start',
          error: {
            code: 'required_capability_unavailable',
            message: 'Required adapter capabilities are unavailable',
          },
        },
        createdAt: '2026-08-28T01:00:00.000Z',
      });
    });
    const before = durableReservationState(context.fixture);

    await expect(context.runtime.start(context.start)).rejects.toThrow(
      'Reserved start operation was not found',
    );

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(context.fake.startCount).toBe(0);
  });

  it('fails public replay closed when a successful reservation loses its operation', async () => {
    const context = createRuntime();
    const reservation = await context.runtime.reserveStart(context.start);
    const operation = required(
      context.operations.listForExecution(reservation.execution.id)[0],
      'Expected start operation',
    );
    context.fixture.database
      .prepare('DELETE FROM execution_operations WHERE id = ?')
      .run(operation.id);
    const before = durableReservationState(context.fixture);

    await expect(context.runtime.start(context.start)).rejects.toThrow(
      'Reserved start operation was not found',
    );

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(context.executions.get(reservation.execution.id)).toMatchObject({
      lifecycle: 'starting',
    });
    expect(context.fake.startCount).toBe(0);
  });

  it('fails exact reservation lookup closed when its durable link is missing', async () => {
    const context = createRuntime();
    const reservation = await context.runtime.reserveStart(context.start);
    const operation = required(
      context.operations.listForExecution(reservation.execution.id)[0],
      'Expected start operation',
    );
    context.fixture.database
      .prepare('DELETE FROM execution_operations WHERE id = ?')
      .run(operation.id);

    expect(() => context.runtime.findReservedStart(context.start)).toThrow(
      'Reserved start operation was not found',
    );
    expect(context.barrier.status).toBe('tripped');
    expect(context.fake.startCount).toBe(0);
  });

  it('fails exact reservation replay closed for a forged receipt timestamp', async () => {
    const context = createRuntime();
    const reservation = await context.runtime.reserveStart(context.start);
    context.fixture.database
      .prepare(
        'UPDATE command_results SET created_at = ? WHERE idempotency_key = ?',
      )
      .run('2026-08-28T01:00:00.001Z', context.start.idempotencyKey);
    const before = durableReservationState(context.fixture);

    expect(() => context.runtime.findReservedStart(context.start)).toThrow(
      'Reserved start operation authority is inconsistent',
    );

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(context.fake.startCount).toBe(0);
    expect(reservation.execution.createdAt).toBe('2026-08-28T01:00:00.000Z');
  });

  it.each(['version', 'embedded-request', 'receipt'] as const)(
    'fails exact reservation lookup closed for a corrupted %s authority field',
    async (fault) => {
      const context = createRuntime();
      const reservation = await context.runtime.reserveStart(context.start);
      const operation = required(
        context.operations.listForExecution(reservation.execution.id)[0],
        'Expected start operation',
      );
      if (fault === 'receipt') {
        context.fixture.database
          .prepare(
            'UPDATE command_results SET result_json = ? WHERE idempotency_key = ?',
          )
          .run(
            JSON.stringify({
              ok: false,
              commandType: 'worker_execution.start',
              error: { code: 'internal_error', message: 'corrupted receipt' },
            }),
            context.start.idempotencyKey,
          );
      } else {
        const request = operation.request as Record<string, unknown>;
        context.fixture.database
          .prepare(
            'UPDATE execution_operations SET request_json = ? WHERE id = ?',
          )
          .run(
            JSON.stringify({
              ...request,
              ...(fault === 'version'
                ? { version: 'mesh.v2.execution-start/v0' }
                : {
                    request: {
                      ...context.start.command,
                      projectId: randomUUID(),
                    },
                  }),
            }),
            operation.id,
          );
      }

      expect(() => context.runtime.findReservedStart(context.start)).toThrow();
      expect(context.barrier.status).toBe('tripped');
      expect(context.fake.startCount).toBe(0);
    },
  );

  it.each(['assignment', 'initial-lifecycle'] as const)(
    'fails linked replay closed for a forged successful %s receipt',
    async (fault) => {
      const context = createRuntime();
      const reservation = await context.runtime.reserveStart(context.start);
      if (!reservation.result.ok || !('execution' in reservation.result)) {
        throw new Error('Expected a successful reservation receipt');
      }
      const assignment = reservation.result.execution.assignment;
      if (assignment.kind !== 'foundation-check') {
        throw new Error('Expected a foundation assignment');
      }
      context.fixture.database
        .prepare(
          'UPDATE command_results SET result_json = ? WHERE idempotency_key = ?',
        )
        .run(
          JSON.stringify({
            ...reservation.result,
            execution: {
              ...reservation.result.execution,
              ...(fault === 'assignment'
                ? {
                    assignment: {
                      ...assignment,
                      title: 'Forged receipt assignment',
                    },
                  }
                : { lifecycle: 'completed' }),
            },
          }),
          context.start.idempotencyKey,
        );
      const before = durableReservationState(context.fixture);

      expect(() => context.runtime.findReservedStart(context.start)).toThrow();

      expect(context.barrier.status).toBe('tripped');
      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.fake.startCount).toBe(0);
    },
  );

  it.each(['replay', 'activation'] as const)(
    'fails %s closed for a coherent durable assignment mutation',
    async (boundary) => {
      const context = createRuntime();
      const reservation = await context.runtime.reserveStart(context.start);
      const assignment = reservation.execution.assignment;
      if (assignment.kind !== 'foundation-check') {
        throw new Error('Expected a foundation assignment');
      }
      context.fixture.database
        .prepare(
          'UPDATE worker_executions SET assignment_json = ? WHERE id = ?',
        )
        .run(
          JSON.stringify({
            ...assignment,
            title: 'Mutated durable assignment',
          }),
          reservation.execution.id,
        );
      const before = durableReservationState(context.fixture);
      let authorityError: unknown;

      try {
        if (boundary === 'replay') {
          context.runtime.findReservedStart(context.start);
        } else {
          await context.runtime.activateReserved(reservation.execution.id);
        }
      } catch (error) {
        authorityError = error;
      } finally {
        await context.runtime.close();
      }

      expect(authorityError).toBeInstanceOf(Error);
      expect(context.barrier.status).toBe('tripped');
      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.fake.startCount).toBe(0);
    },
  );

  it('fails linked replay closed when terminal failure missing evidence changes', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
    const context = createRuntime({ fake });
    const reservation = await context.runtime.reserveStart(context.start);
    const failure = required(
      reservation.execution.failure,
      'Expected terminal reservation failure',
    );
    expect(
      context.operations
        .listForExecution(reservation.execution.id)
        .find(({ kind }) => kind === 'start')?.result,
    ).toEqual({ reason: failure.message, failure });
    context.fixture.database
      .prepare('UPDATE worker_executions SET failure_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...failure, missing: ['forged.missing'] }),
        reservation.execution.id,
      );
    const before = durableReservationState(context.fixture);

    expect(() => context.runtime.findReservedStart(context.start)).toThrow();

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(fake.startCount).toBe(0);
  });

  it.each([
    {
      name: 'forged internal failure',
      failure: { code: 'internal_error', message: 'forged start failure' },
      reason: 'forged start failure',
    },
    {
      name: 'adapter failure with missing evidence',
      failure: {
        code: 'adapter_unavailable',
        message: 'adapter start failed',
        missing: ['forged.missing'],
      },
      reason: 'adapter start failed',
    },
    {
      name: 'cancel failure with forged message',
      failure: {
        code: 'startup_interrupted_before_start',
        message: 'forged cancellation message',
      },
      reason: 'planning_cycle_abandoned',
    },
    {
      name: 'cancel failure with adapter reason',
      failure: {
        code: 'startup_interrupted_before_start',
        message: 'Execution start was cancelled before adapter startup',
      },
      reason: 'Execution start was cancelled before adapter startup',
    },
  ])(
    'fails successful receipt replay closed for $name',
    async ({ failure, reason }) => {
      const context = createRuntime();
      const reservation = await context.runtime.reserveStart(context.start);
      const operation = required(
        context.operations.listForExecution(reservation.execution.id)[0],
        'Expected start operation',
      );
      inImmediateTransaction(context.fixture.database, () => {
        const failed = context.executions.transitionInTransaction(
          reservation.execution.id,
          reservation.execution.revision,
          'failed',
          '2026-08-28T01:00:01.000Z',
          { failure },
        );
        context.operations.finishInTransaction(
          operation.id,
          'failed',
          { reason, failure: failed.failure },
          '2026-08-28T01:00:01.000Z',
        );
      });
      const before = durableReservationState(context.fixture);

      expect(() => context.runtime.findReservedStart(context.start)).toThrow(
        'Reserved start operation state is inconsistent',
      );

      expect(context.barrier.status).toBe('tripped');
      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.fake.startCount).toBe(0);
    },
  );

  it('replays exact adapter-start failure evidence from a successful receipt', async () => {
    const fake = new FakeHarnessAdapter();
    const start = vi
      .spyOn(fake, 'start')
      .mockRejectedValueOnce(new Error('fixture adapter start failure'));
    const context = createRuntime({ fake });

    const receipt = await context.runtime.start(context.start);
    if (!receipt.ok || !('execution' in receipt)) {
      throw new Error('Expected successful starting receipt');
    }
    const failed = required(
      context.executions.get(receipt.execution.id),
      'Expected failed execution',
    );
    expect(failed).toMatchObject({
      lifecycle: 'failed',
      failure: {
        code: 'adapter_unavailable',
        message: 'fixture adapter start failure',
      },
    });
    expect(context.operations.listForExecution(failed.id)).toMatchObject([
      {
        kind: 'start',
        state: 'failed',
        result: {
          reason: 'fixture adapter start failure',
          failure: failed.failure,
        },
      },
    ]);
    expect(context.runtime.findReservedStart(context.start)).toEqual({
      execution: failed,
      result: receipt,
      activationRequired: false,
    });
    await expect(context.runtime.start(context.start)).resolves.toEqual(
      receipt,
    );
    expect(context.barrier.status).toBe('healthy');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('fails linked replay closed for a forged successful operation result', async () => {
    const context = createRuntime();
    const reservation = await context.runtime.reserveStart(context.start);
    await context.runtime.activateReserved(reservation.execution.id);
    await context.runtime.drain();
    const operation = required(
      context.operations
        .listForExecution(reservation.execution.id)
        .find(({ kind }) => kind === 'start'),
      'Expected start operation',
    );
    context.fixture.database
      .prepare('UPDATE execution_operations SET result_json = ? WHERE id = ?')
      .run(JSON.stringify({ nativeHandle: 'forged:handle' }), operation.id);
    const before = durableReservationState(context.fixture);

    expect(() => context.runtime.findReservedStart(context.start)).toThrow();

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    await context.runtime.close();
  });

  it('fails activation closed when the loaded project identity changes', async () => {
    let loadedProjectId: string | undefined = undefined;
    const context = createRuntime({
      project: (project) =>
        new Proxy(project, {
          get: (target, property, receiver) =>
            property === 'id' && loadedProjectId !== undefined
              ? loadedProjectId
              : Reflect.get(target, property, receiver),
        }),
    });
    const reservation = await context.runtime.reserveStart(context.start);
    loadedProjectId = randomUUID();
    const before = durableReservationState(context.fixture);
    let activationError: unknown;

    try {
      await context.runtime.activateReserved(reservation.execution.id);
    } catch (error) {
      activationError = error;
    } finally {
      await context.runtime.close();
    }

    expect(activationError).toBeInstanceOf(Error);
    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(context.fake.startCount).toBe(0);
  });

  it('links terminal capability reservations and never activates them', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
    const context = createRuntime({ fake });

    const reservation = await context.runtime.reserveStart(context.start);

    expect(reservation).toMatchObject({
      activationRequired: false,
      result: {
        ok: false,
        error: { code: 'required_capability_unavailable' },
      },
      execution: {
        lifecycle: 'failed',
        failure: { code: 'required_capability_unavailable' },
      },
    });
    expect(
      context.operations.listForExecution(reservation.execution.id),
    ).toMatchObject([
      {
        kind: 'start',
        state: 'failed',
        request: {
          idempotencyKey: context.start.idempotencyKey,
          requestHash: hashV2Command(context.start.command),
        },
      },
    ]);
    expect(context.runtime.findReservedStart(context.start)).toEqual(
      reservation,
    );
    await context.runtime.activateReserved(reservation.execution.id);
    expect(fake.startCount).toBe(0);
  });

  it('fails terminal reservation replay closed for a forged valid error receipt', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
    const context = createRuntime({ fake });
    await context.runtime.reserveStart(context.start);
    context.fixture.database
      .prepare(
        'UPDATE command_results SET result_json = ? WHERE idempotency_key = ?',
      )
      .run(
        JSON.stringify({
          ok: false,
          commandType: 'worker_execution.start',
          error: {
            code: 'required_skill_unavailable',
            message: 'Forged but schema-valid terminal error',
          },
        }),
        context.start.idempotencyKey,
      );
    const before = durableReservationState(context.fixture);

    expect(() => context.runtime.findReservedStart(context.start)).toThrow();

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(fake.startCount).toBe(0);
  });

  it('fails public linked replay closed for a forged terminal receipt', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = { ...fake.capabilitiesValue, capabilities: [] };
    const context = createRuntime({ fake });
    await context.runtime.reserveStart(context.start);
    context.fixture.database
      .prepare(
        'UPDATE command_results SET result_json = ? WHERE idempotency_key = ?',
      )
      .run(
        JSON.stringify({
          ok: false,
          commandType: 'worker_execution.start',
          error: {
            code: 'required_skill_unavailable',
            message: 'Forged public replay error',
          },
        }),
        context.start.idempotencyKey,
      );
    const before = durableReservationState(context.fixture);

    await expect(context.runtime.start(context.start)).rejects.toThrow();

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(fake.startCount).toBe(0);
  });

  it('coalesces concurrent activation before adapter start and attachment', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
    fake.blockStart();
    const context = createRuntime({ fake });
    const reservation = await context.runtime.reserveStart(context.start);

    const first = context.runtime.activateReserved(reservation.execution.id);
    await fake.waitUntilStartCalled();
    const replay = context.runtime.activateReserved(reservation.execution.id);
    fake.releaseStart();
    await Promise.all([first, replay]);
    await context.runtime.drain();

    expect(fake.startCount).toBe(1);
    expect(fake.sessions).toHaveLength(1);
    expect(
      context.operations.listForExecution(reservation.execution.id),
    ).toMatchObject([{ kind: 'start', state: 'succeeded' }]);
  });

  it('cancels the exact unactivated reservation without adapter work', async () => {
    const context = createRuntime();
    const reservation = await context.runtime.reserveStart(context.start);

    const cancelling = context.runtime.cancelReserved(reservation.execution.id);
    const activation = context.runtime.activateReserved(
      reservation.execution.id,
    );
    const cancelled = await cancelling;
    await activation;

    expect(cancelled).toMatchObject({
      lifecycle: 'failed',
      failure: { code: 'startup_interrupted_before_start' },
    });
    expect(
      context.operations.listForExecution(reservation.execution.id),
    ).toMatchObject([
      {
        kind: 'start',
        state: 'failed',
        result: { reason: 'planning_cycle_abandoned' },
      },
    ]);
    expect({
      starts: context.fake.startCount,
      sessions: context.fake.sessions.length,
      interrupts: context.fake.interruptCalls.length,
    }).toEqual({ starts: 0, sessions: 0, interrupts: 0 });
    await expect(
      context.runtime.cancelReserved(reservation.execution.id),
    ).resolves.toEqual(cancelled);
    expect(context.runtime.findReservedStart(context.start)).toEqual({
      execution: cancelled,
      result: reservation.result,
      activationRequired: false,
    });
    await expect(context.runtime.start(context.start)).resolves.toEqual(
      reservation.result,
    );
    expect(context.barrier.status).toBe('healthy');
  });

  it.each(['missing', 'multiple', 'wrong'] as const)(
    'fails reserved cancellation closed for a %s durable start link',
    async (fault) => {
      const context = createRuntime();
      const reservation = await context.runtime.reserveStart(context.start);
      const operation = required(
        context.operations.listForExecution(reservation.execution.id)[0],
        'Expected start operation',
      );
      if (fault === 'missing') {
        context.fixture.database
          .prepare('DELETE FROM execution_operations WHERE id = ?')
          .run(operation.id);
      } else if (fault === 'multiple') {
        inImmediateTransaction(context.fixture.database, () => {
          context.operations.finishInTransaction(
            operation.id,
            'failed',
            { reason: 'conflicting test link' },
            '2026-08-28T01:00:01.000Z',
          );
          context.operations.createPendingInTransaction({
            executionId: reservation.execution.id,
            kind: 'start',
            request: {
              version: 'mesh.v2.execution-start/v1',
              idempotencyKey: randomUUID(),
              requestHash: hashV2Command(context.start.command),
              request: context.start.command,
            },
            createdAt: '2026-08-28T01:00:02.000Z',
          });
        });
      } else {
        const request = operation.request as Record<string, unknown>;
        context.fixture.database
          .prepare(
            'UPDATE execution_operations SET request_json = ? WHERE id = ?',
          )
          .run(
            JSON.stringify({ ...request, idempotencyKey: randomUUID() }),
            operation.id,
          );
      }
      const before = durableReservationState(context.fixture);
      const publishedBefore = context.published.domain.length;

      await expect(
        context.runtime.cancelReserved(reservation.execution.id),
      ).rejects.toThrow();

      expect(context.barrier.status).toBe('tripped');
      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.published.domain).toHaveLength(publishedBefore);
      expect(context.fake.startCount).toBe(0);
    },
  );

  it.each([
    'terminal-pending',
    'starting-failed',
    'created-succeeded',
  ] as const)(
    'fails reserved cancellation closed for %s state mismatch',
    async (fault) => {
      const context = createRuntime();
      const reservation = await context.runtime.reserveStart(context.start);
      const operation = required(
        context.operations.listForExecution(reservation.execution.id)[0],
        'Expected start operation',
      );
      inImmediateTransaction(context.fixture.database, () => {
        if (fault === 'terminal-pending') {
          context.executions.transitionInTransaction(
            reservation.execution.id,
            reservation.execution.revision,
            'failed',
            '2026-08-28T01:00:01.000Z',
            {
              failure: {
                code: 'internal_error',
                message: 'inconsistent test lifecycle',
              },
            },
          );
          return;
        }
        const state = fault === 'starting-failed' ? 'failed' : 'succeeded';
        context.operations.finishInTransaction(
          operation.id,
          state,
          { reason: 'inconsistent test operation' },
          '2026-08-28T01:00:01.000Z',
        );
        if (fault === 'created-succeeded') {
          context.fixture.database
            .prepare(
              "UPDATE worker_executions SET lifecycle = 'created' WHERE id = ?",
            )
            .run(reservation.execution.id);
        }
      });
      const before = durableReservationState(context.fixture);
      const publishedBefore = context.published.domain.length;

      await expect(
        context.runtime.cancelReserved(reservation.execution.id),
      ).rejects.toThrow('Reserved start operation state is inconsistent');

      expect(context.barrier.status).toBe('tripped');
      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.published.domain).toHaveLength(publishedBefore);
      expect(context.fake.startCount).toBe(0);
    },
  );

  it('waits for activation that owns the reservation interlock first', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
    fake.blockStart();
    const context = createRuntime({ fake });
    const reservation = await context.runtime.reserveStart(context.start);

    const activation = context.runtime.activateReserved(
      reservation.execution.id,
    );
    await fake.waitUntilStartCalled();
    const cancellation = context.runtime.cancelReserved(
      reservation.execution.id,
    );
    fake.releaseStart();
    await activation;
    const settled = await cancellation;
    await context.runtime.drain();

    expect(settled).toMatchObject({ lifecycle: 'running' });
    expect(fake.startCount).toBe(1);
    expect(context.operations.listForExecution(settled.id)).toMatchObject([
      { kind: 'start', state: 'succeeded' },
    ]);
  });

  it('registers activation ownership before synchronous cancellation reentry', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
    const originalStart = fake.start.bind(fake);
    const contextRef: { current?: ReturnType<typeof createRuntime> } = {};
    let cancellation: Promise<WorkerExecution> | undefined;
    vi.spyOn(fake, 'start').mockImplementation(async (request) => {
      const context = required(contextRef.current, 'Expected runtime context');
      cancellation = context.runtime.cancelReserved(request.executionId);
      return originalStart(request);
    });
    const context = createRuntime({ fake });
    contextRef.current = context;
    const reservation = await context.runtime.reserveStart(context.start);

    await context.runtime.activateReserved(reservation.execution.id);
    const settled = await required(
      cancellation,
      'Expected synchronous cancellation reentry',
    );
    await context.runtime.drain();

    expect(settled).toMatchObject({ lifecycle: 'running' });
    expect(context.barrier.status).toBe('healthy');
    expect(fake.startCount).toBe(1);
    expect(context.operations.listForExecution(settled.id)).toMatchObject([
      { kind: 'start', state: 'succeeded' },
    ]);
  });

  it('fails activation closed before adapter start for corrupt durable authority', async () => {
    const context = createRuntime();
    const reservation = await context.runtime.reserveStart(context.start);
    const operation = required(
      context.operations.listForExecution(reservation.execution.id)[0],
      'Expected start operation',
    );
    const request = operation.request as Record<string, unknown>;
    context.fixture.database
      .prepare('UPDATE execution_operations SET request_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          ...request,
          version: 'mesh.v2.execution-start/v0',
        }),
        operation.id,
      );
    const before = durableReservationState(context.fixture);

    await expect(
      context.runtime.activateReserved(reservation.execution.id),
    ).rejects.toThrow('link is invalid');

    expect(context.barrier.status).toBe('tripped');
    expect(durableReservationState(context.fixture)).toEqual(before);
    expect(context.fake.startCount).toBe(0);
  });

  it('trips the barrier when reserved cancellation cannot commit', async () => {
    const context = createRuntime();
    const reservation = await context.runtime.reserveStart(context.start);
    const publishedBefore = context.published.domain.length;
    context.fixture.database.exec(`
      CREATE TRIGGER fail_reserved_cancellation
      BEFORE UPDATE ON worker_executions
      WHEN NEW.lifecycle = 'failed'
      BEGIN SELECT RAISE(ABORT, 'fail reserved cancellation'); END
    `);

    await expect(
      context.runtime.cancelReserved(reservation.execution.id),
    ).rejects.toThrow('fail reserved cancellation');

    expect(context.barrier.status).toBe('tripped');
    expect(context.executions.get(reservation.execution.id)).toMatchObject({
      lifecycle: 'starting',
    });
    expect(
      context.operations.listForExecution(reservation.execution.id),
    ).toMatchObject([{ kind: 'start', state: 'pending' }]);
    expect(context.published.domain).toHaveLength(publishedBefore);
    expect(context.fake.startCount).toBe(0);
  });

  it.each(['structured_output', 'completion', 'failure'] as const)(
    'fences and joins the exact planning session before late %s settles',
    async (late) => {
      const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
      const started = await context.runtime.start(context.start);
      await context.runtime.drain();
      const running = required(
        context.executions.get(
          started.ok && 'execution' in started ? started.execution.id : '',
        ),
        'Expected a running execution',
      );
      let releaseNext: (() => void) | undefined;
      const blockedNext = new Promise<void>((resolve) => {
        releaseNext = resolve;
      });
      let nextCalledResolve: (() => void) | undefined;
      const nextCalled = new Promise<void>((resolve) => {
        nextCalledResolve = resolve;
      });
      let closeCount = 0;
      const session: HarnessSession = {
        nativeHandle: required(
          running.nativeHandle,
          'Expected a native handle',
        ),
        events: () => ({
          [Symbol.asyncIterator]() {
            let delivered = false;
            return {
              async next(): Promise<IteratorResult<HarnessEventEnvelope>> {
                if (delivered) return { done: true, value: undefined };
                delivered = true;
                nextCalledResolve?.();
                await blockedNext;
                if (late === 'failure') {
                  throw new Error('late planning iterator failure');
                }
                const normalized: HarnessEventEnvelope['normalized'] =
                  late === 'completion'
                    ? {
                        projectId: running.projectId,
                        executionId: running.id,
                        adapterCursor: running.lastAdapterCursor + 1,
                        occurredAt: '2026-08-28T01:00:03.000Z',
                        type: 'worker_execution.completed',
                        payload: { outcome: 'completed' },
                      }
                    : {
                        projectId: running.projectId,
                        executionId: running.id,
                        adapterCursor: running.lastAdapterCursor + 1,
                        occurredAt: '2026-08-28T01:00:03.000Z',
                        type: 'worker_execution.structured_output',
                        payload: {
                          schema: PM_DISCOVERY_REPORT_SCHEMA,
                          value: { late: true },
                        },
                      };
                return {
                  done: false,
                  value: {
                    adapterCursor: running.lastAdapterCursor + 1,
                    raw: { source: `late planning ${late}` },
                    normalized,
                  },
                };
              },
            };
          },
        }),
        async close() {
          closeCount += 1;
          releaseNext?.();
        },
      };
      context.runtime.attach(running.id, session);
      await nextCalled;
      const before = durableRuntimeState(context.fixture);
      const publishedBefore = {
        domain: context.published.domain.length,
        runtime: context.published.runtime.length,
      };
      const commandCount = context.fixture.database
        .prepare('SELECT COUNT(*) AS count FROM command_results')
        .get() as { count: number };

      await context.runtime.interruptForPlanning(running.id);

      expect(closeCount).toBe(1);
      expect(context.fake.interruptCalls).toContain(session.nativeHandle);
      expect(context.executions.get(running.id)).toMatchObject({
        lifecycle: 'interrupted',
        lastAdapterCursor: running.lastAdapterCursor,
      });
      expect(
        context.fixture.database
          .prepare('SELECT * FROM raw_diagnostics ORDER BY id')
          .all(),
      ).toEqual(before.diagnostics);
      expect(durableRuntimeState(context.fixture).runtime).toEqual(
        before.runtime,
      );
      expect(context.published.runtime).toHaveLength(publishedBefore.runtime);
      expect(context.published.domain).toHaveLength(publishedBefore.domain + 2);
      expect(
        context.operations
          .listForExecution(running.id)
          .find(
            (operation) =>
              operation.kind === 'interrupt' &&
              typeof operation.request === 'object' &&
              operation.request !== null &&
              'version' in operation.request &&
              operation.request.version === 'mesh.v2.planning-interrupt/v1',
          ),
      ).toMatchObject({
        kind: 'interrupt',
        state: 'succeeded',
        request: { version: 'mesh.v2.planning-interrupt/v1' },
      });
      expect(
        context.fixture.database
          .prepare('SELECT COUNT(*) AS count FROM command_results')
          .get(),
      ).toEqual(commandCount);
      const interruptCount = context.fake.interruptCalls.length;
      await context.runtime.interruptForPlanning(running.id);
      expect(context.fake.interruptCalls).toHaveLength(interruptCount);
    },
  );

  it('contains and joins a blocked planning session when the barrier is already tripped', async () => {
    const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    let releaseNext: (() => void) | undefined;
    const blockedNext = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    let nextCalledResolve: (() => void) | undefined;
    const nextCalled = new Promise<void>((resolve) => {
      nextCalledResolve = resolve;
    });
    let closeCount = 0;
    const session: HarnessSession = {
      nativeHandle: required(running.nativeHandle, 'Expected native handle'),
      events: () => ({
        [Symbol.asyncIterator]() {
          let delivered = false;
          return {
            async next(): Promise<IteratorResult<HarnessEventEnvelope>> {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              nextCalledResolve?.();
              await blockedNext;
              return {
                done: false,
                value: {
                  adapterCursor: running.lastAdapterCursor + 1,
                  raw: { source: 'late after pre-tripped planning barrier' },
                  normalized: {
                    projectId: running.projectId,
                    executionId: running.id,
                    adapterCursor: running.lastAdapterCursor + 1,
                    occurredAt: '2026-08-28T01:00:03.000Z',
                    type: 'worker_execution.structured_output',
                    payload: {
                      schema: PM_DISCOVERY_REPORT_SCHEMA,
                      value: { late: true },
                    },
                  },
                },
              };
            },
          };
        },
      }),
      async close() {
        closeCount += 1;
        releaseNext?.();
      },
    };
    context.runtime.attach(running.id, session);
    await nextCalled;
    const before = durableRuntimeState(context.fixture);
    const publishedBefore = {
      domain: context.published.domain.length,
      runtime: context.published.runtime.length,
    };
    context.barrier.trip(new Error('pre-existing planning audit failure'));

    let cleanupError: unknown;
    try {
      await context.runtime.interruptForPlanning(running.id);
    } catch (error) {
      cleanupError = error;
    }
    const closeCountAtRejection = closeCount;
    releaseNext?.();
    await context.runtime.drain();

    expect(cleanupError).toMatchObject({
      name: PlanningInterruptCleanupError.name,
      code: 'planning_interrupt_audit_failure',
      diagnostics: [
        {
          phase: 'audit',
          message: 'pre-existing planning audit failure',
        },
      ],
    });
    expect(closeCountAtRejection).toBe(1);
    expect(closeCount).toBe(1);
    expect(context.fake.interruptCalls).toContain(session.nativeHandle);
    expect(durableRuntimeState(context.fixture)).toEqual(before);
    expect(context.published.domain).toHaveLength(publishedBefore.domain);
    expect(context.published.runtime).toHaveLength(publishedBefore.runtime);
  });

  it('coalesces concurrent planning interruption around one exact session', async () => {
    const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const { state } = await attachBlockedPlanningSession(context, running);
    context.fake.blockInterrupt();

    const first = context.runtime.interruptForPlanning(running.id);
    await context.fake.waitUntilInterruptCalled();
    const second = context.runtime.interruptForPlanning(running.id);
    context.fake.releaseInterrupt({ status: 'succeeded' });
    await Promise.all([first, second]);

    expect(state.closeCount).toBe(1);
    expect(context.fake.interruptCalls).toHaveLength(1);
    expect(context.executions.get(running.id)).toMatchObject({
      lifecycle: 'interrupted',
    });
    expect(
      context.operations
        .listForExecution(running.id)
        .filter((operation) => operation.kind === 'interrupt'),
    ).toMatchObject([{ state: 'succeeded' }]);
  });

  it('coalesces synchronous planning interruption reentry during publication', async () => {
    const runtimeRef: { current?: ExecutionRuntime } = {};
    let reentry: Promise<void> | undefined;
    const context = createPmRuntime(
      'todo',
      { holdAfterAdapterCursor: 1 },
      {
        domain: (event) => {
          if (
            event.type === 'worker_execution.lifecycle_changed' &&
            event.payload.execution.lifecycle === 'interrupting'
          ) {
            reentry = required(
              runtimeRef.current,
              'Expected planning runtime',
            ).interruptForPlanning(event.payload.execution.id);
          }
        },
        runtime: () => undefined,
      },
    );
    runtimeRef.current = context.runtime;
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const { state } = await attachBlockedPlanningSession(context, running);
    context.fake.blockInterrupt();

    const first = context.runtime.interruptForPlanning(running.id);
    await context.fake.waitUntilInterruptCalled();
    const coalesced = required(reentry, 'Expected synchronous reentry');
    expect(context.fake.interruptCalls).toHaveLength(1);
    context.fake.releaseInterrupt({ status: 'succeeded' });
    await Promise.all([first, coalesced]);

    expect(state.closeCount).toBe(1);
    expect(context.fake.interruptCalls).toHaveLength(1);
    expect(
      context.operations
        .listForExecution(running.id)
        .filter((operation) => operation.kind === 'interrupt'),
    ).toMatchObject([{ state: 'succeeded' }]);
  });

  it('contains the exact blocked session before rejecting conflicting planning audit tags', async () => {
    const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const { session, state } = await attachBlockedPlanningSession(
      context,
      running,
    );
    inImmediateTransaction(context.fixture.database, () => {
      const first = context.operations.createPendingInTransaction({
        executionId: running.id,
        kind: 'interrupt',
        request: { version: 'mesh.v2.planning-interrupt/v1' },
        createdAt: '2026-08-28T01:00:01.000Z',
      });
      context.operations.finishInTransaction(
        first.id,
        'unknown',
        { reason: 'conflicting audit tag' },
        '2026-08-28T01:00:02.000Z',
      );
      context.operations.createPendingInTransaction({
        executionId: running.id,
        kind: 'interrupt',
        request: { version: 'mesh.v2.planning-interrupt/v1' },
        createdAt: '2026-08-28T01:00:03.000Z',
      });
    });
    const before = durableRuntimeState(context.fixture);

    await expect(
      context.runtime.interruptForPlanning(running.id),
    ).rejects.toMatchObject({
      code: 'planning_interrupt_audit_failure',
      diagnostics: [
        {
          phase: 'audit',
          message: 'Conflicting planning interrupt operations found',
        },
      ],
    });

    expect(context.barrier.status).toBe('tripped');
    expect(state.closeCount).toBe(1);
    expect(context.fake.interruptCalls).toContain(session.nativeHandle);
    await context.runtime.drain();
    expect(durableRuntimeState(context.fixture)).toEqual(before);
  });

  it.each(['pending', 'succeeded', 'unknown', 'failed'] as const)(
    'contains the exact blocked session before rejecting a %s planning tag on a running lifecycle',
    async (state) => {
      const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
      const started = await context.runtime.start(context.start);
      await context.runtime.drain();
      const running = required(
        context.executions.get(
          started.ok && 'execution' in started ? started.execution.id : '',
        ),
        'Expected a running execution',
      );
      const { session, state: sessionState } =
        await attachBlockedPlanningSession(context, running);
      inImmediateTransaction(context.fixture.database, () => {
        const operation = context.operations.createPendingInTransaction({
          executionId: running.id,
          kind: 'interrupt',
          request: { version: 'mesh.v2.planning-interrupt/v1' },
          createdAt: '2026-08-28T01:00:01.000Z',
        });
        if (state !== 'pending') {
          context.operations.finishInTransaction(
            operation.id,
            state,
            { reason: 'mismatched planning audit fixture' },
            '2026-08-28T01:00:02.000Z',
          );
        }
      });
      const before = durableRuntimeState(context.fixture);
      const publishedBefore = context.published.domain.length;

      await expect(
        context.runtime.interruptForPlanning(running.id),
      ).rejects.toMatchObject({
        code: 'planning_interrupt_audit_failure',
        diagnostics: [
          {
            phase: 'audit',
            message:
              'Planning interrupt operation does not match execution lifecycle',
          },
        ],
      });

      expect(context.barrier.status).toBe('tripped');
      expect(sessionState.closeCount).toBe(1);
      expect(context.fake.interruptCalls).toContain(session.nativeHandle);
      await context.runtime.drain();
      expect(durableRuntimeState(context.fixture)).toEqual(before);
      expect(context.published.domain).toHaveLength(publishedBefore);
    },
  );

  it('contains a live non-PM session before rejecting its tagged planning operation', async () => {
    const context = createRuntime({
      fake: new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 }),
    });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const { session, state } = await attachBlockedPlanningSession(
      context,
      running,
    );
    inImmediateTransaction(context.fixture.database, () => {
      context.operations.createPendingInTransaction({
        executionId: running.id,
        kind: 'interrupt',
        request: { version: 'mesh.v2.planning-interrupt/v1' },
        createdAt: '2026-08-28T01:00:01.000Z',
      });
    });
    const before = durableRuntimeState(context.fixture);

    await expect(
      context.runtime.interruptForPlanning(running.id),
    ).rejects.toMatchObject({
      code: 'planning_interrupt_audit_failure',
      diagnostics: [
        {
          phase: 'audit',
          message: 'Planning interrupt operation is not owned by a PM runtime',
        },
      ],
    });

    expect(context.barrier.status).toBe('tripped');
    expect(state.closeCount).toBe(1);
    expect(context.fake.interruptCalls).toContain(session.nativeHandle);
    await context.runtime.drain();
    expect(durableRuntimeState(context.fixture)).toEqual(before);
  });

  it.each([
    'succeeded-interrupted',
    'unknown-attention',
    'untagged-completed',
    'untagged-attention',
    'native-handle-mismatch',
  ] as const)(
    'contains any runtime-owned session before rejecting %s planning audit state',
    async (fault) => {
      const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
      const started = await context.runtime.start(context.start);
      await context.runtime.drain();
      const running = required(
        context.executions.get(
          started.ok && 'execution' in started ? started.execution.id : '',
        ),
        'Expected a running execution',
      );
      if (fault !== 'native-handle-mismatch') {
        inImmediateTransaction(context.fixture.database, () => {
          const exact = required(
            context.executions.get(running.id),
            'Expected durable execution',
          );
          if (
            fault === 'untagged-completed' ||
            fault === 'untagged-attention'
          ) {
            context.executions.transitionInTransaction(
              exact.id,
              exact.revision,
              fault === 'untagged-completed'
                ? 'completed'
                : 'attention_required',
              '2026-08-28T01:00:01.000Z',
            );
            return;
          }
          const interrupting = context.executions.transitionInTransaction(
            exact.id,
            exact.revision,
            'interrupting',
            '2026-08-28T01:00:01.000Z',
          );
          const operation = context.operations.createPendingInTransaction({
            executionId: exact.id,
            kind: 'interrupt',
            request: { version: 'mesh.v2.planning-interrupt/v1' },
            createdAt: '2026-08-28T01:00:01.000Z',
          });
          context.operations.finishInTransaction(
            operation.id,
            fault === 'succeeded-interrupted' ? 'succeeded' : 'unknown',
            { diagnostics: [] },
            '2026-08-28T01:00:02.000Z',
          );
          context.executions.transitionInTransaction(
            interrupting.id,
            interrupting.revision,
            fault === 'succeeded-interrupted'
              ? 'interrupted'
              : 'attention_required',
            '2026-08-28T01:00:02.000Z',
          );
        });
      }
      const durable = required(
        context.executions.get(running.id),
        'Expected durable planning execution',
      );
      const { release, session, state } = await attachLatePlanningSession(
        context,
        durable,
        fault === 'native-handle-mismatch'
          ? `mismatched:${running.id}`
          : required(durable.nativeHandle, 'Expected a durable native handle'),
      );
      const before = durableRuntimeState(context.fixture);
      const publishedBefore = {
        domain: context.published.domain.length,
        runtime: context.published.runtime.length,
      };
      let cleanupError: unknown;

      try {
        await context.runtime.interruptForPlanning(running.id);
      } catch (error) {
        cleanupError = error;
      }
      const closeCountAtRejection = state.closeCount;
      release();
      await context.runtime.drain();

      expect(cleanupError).toMatchObject({
        code: 'planning_interrupt_audit_failure',
        diagnostics: [{ phase: 'audit' }],
      });
      expect(context.barrier.status).toBe('tripped');
      expect(closeCountAtRejection).toBe(1);
      expect(state.closeCount).toBe(1);
      expect(context.fake.interruptCalls).toContain(session.nativeHandle);
      expect(durableRuntimeState(context.fixture)).toEqual(before);
      expect(context.published.domain).toHaveLength(publishedBefore.domain);
      expect(context.published.runtime).toHaveLength(publishedBefore.runtime);
    },
  );

  it.each([
    'profile-id',
    'profile-revision',
    'profile-project',
    'loaded-project',
  ] as const)(
    'rejects mismatched %s authority before adapter probing or writes',
    async (fault) => {
      const context = createRuntime(
        fault === 'loaded-project'
          ? {
              project: (project) => ({ ...project, id: randomUUID() }),
            }
          : {
              profile: (profile) =>
                fault === 'profile-id'
                  ? { ...profile, profileId: randomUUID() }
                  : fault === 'profile-revision'
                    ? {
                        ...profile,
                        profileRevision: profile.profileRevision + 1,
                      }
                    : {
                        ...profile,
                        projectId: randomUUID(),
                        document: {
                          ...profile.document,
                          metadata: {
                            ...profile.document.metadata,
                            scope: 'project',
                          },
                        },
                      },
            },
      );
      if (fault === 'profile-id') {
        context.start.command.profileId =
          context.fixture.profileRevision.profileId;
      }
      if (fault === 'profile-revision') {
        context.start.command.profileRevision =
          context.fixture.profileRevision.revision;
      }
      const before = durableReservationState(context.fixture);

      await expect(
        context.runtime.reserveStart(context.start),
      ).rejects.toBeInstanceOf(ExecutionReservationError);

      expect(durableReservationState(context.fixture)).toEqual(before);
      expect(context.published.domain).toEqual([]);
      expect({
        capabilities: context.fake.capabilitiesCount,
        skills: context.fake.resolveSkillsCount,
        starts: context.fake.startCount,
      }).toEqual({ capabilities: 0, skills: 0, starts: 0 });
    },
  );

  it('records an unproven already-terminal probe before rejecting cleanup', async () => {
    const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const { state } = await attachBlockedPlanningSession(context, running);
    context.fake.blockInterrupt();

    const cleanup = context.runtime.interruptForPlanning(running.id);
    await context.fake.waitUntilInterruptCalled();
    context.fake.releaseInterrupt({ status: 'already_terminal' });
    await expect(cleanup).rejects.toMatchObject({
      code: 'planning_interrupt_unproven',
      diagnostics: [
        {
          phase: 'adapter_probe',
          message: 'Adapter session remains resumable',
        },
      ],
    });

    expect(state.closeCount).toBe(1);
    expect(context.executions.get(running.id)).toMatchObject({
      lifecycle: 'attention_required',
    });
    expect(
      context.operations
        .listForExecution(running.id)
        .find((operation) => operation.kind === 'interrupt'),
    ).toMatchObject({
      state: 'unknown',
      result: {
        proof: {
          interrupted: { status: 'already_terminal' },
          probe: { status: 'resumable', afterAdapterCursor: 1 },
        },
      },
    });
  });

  it('returns durable typed diagnostics when planning interruption is unproven', async () => {
    const context = createPmRuntime('todo', {
      holdAfterAdapterCursor: 1,
      interruptThrows: true,
    });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const { state } = await attachBlockedPlanningSession(context, running);

    await expect(
      context.runtime.interruptForPlanning(running.id),
    ).rejects.toMatchObject({
      name: PlanningInterruptCleanupError.name,
      code: 'planning_interrupt_unproven',
      diagnostics: [
        {
          phase: 'adapter_interrupt',
          message: 'fake interrupt failure',
        },
      ],
    });

    expect(state.closeCount).toBe(1);
    expect(context.executions.get(running.id)).toMatchObject({
      lifecycle: 'attention_required',
    });
    expect(
      context.operations
        .listForExecution(running.id)
        .find((operation) => operation.kind === 'interrupt'),
    ).toMatchObject({
      state: 'unknown',
      result: {
        diagnostics: [
          {
            phase: 'adapter_interrupt',
            message: 'fake interrupt failure',
          },
        ],
      },
    });
    const interruptCount = context.fake.interruptCalls.length;
    await expect(
      context.runtime.interruptForPlanning(running.id),
    ).rejects.toMatchObject({
      code: 'planning_interrupt_unproven',
    });
    expect(context.fake.interruptCalls).toHaveLength(interruptCount);
  });

  it('returns durable typed diagnostics when exact session close fails', async () => {
    const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const { state } = await attachBlockedPlanningSession(
      context,
      running,
      true,
    );

    await expect(
      context.runtime.interruptForPlanning(running.id),
    ).rejects.toMatchObject({
      name: PlanningInterruptCleanupError.name,
      code: 'planning_interrupt_quiescence_failure',
      diagnostics: [
        {
          phase: 'session_close',
          message: 'planning close failure',
        },
      ],
    });

    expect(state.closeCount).toBe(1);
    expect(context.executions.get(running.id)).toMatchObject({
      lifecycle: 'attention_required',
    });
    expect(
      context.operations
        .listForExecution(running.id)
        .find((operation) => operation.kind === 'interrupt'),
    ).toMatchObject({
      state: 'unknown',
      result: {
        diagnostics: [
          {
            phase: 'session_close',
            message: 'planning close failure',
          },
        ],
      },
    });
    const interruptCount = context.fake.interruptCalls.length;
    await expect(
      context.runtime.interruptForPlanning(running.id),
    ).rejects.toMatchObject({
      code: 'planning_interrupt_quiescence_failure',
    });
    expect(context.fake.interruptCalls).toHaveLength(interruptCount);
  });

  it.each([
    [
      'reservation_transition',
      `BEFORE UPDATE ON worker_executions
       WHEN NEW.lifecycle = 'interrupting'`,
      'running',
      0,
    ],
    [
      'operation_insert',
      `BEFORE INSERT ON execution_operations
       WHEN NEW.kind = 'interrupt'`,
      'running',
      0,
    ],
    ['interrupting_event', 'BEFORE INSERT ON domain_events', 'running', 0],
    [
      'terminal_execution',
      `BEFORE UPDATE ON worker_executions
       WHEN NEW.lifecycle = 'interrupted'`,
      'interrupting',
      1,
    ],
    [
      'operation_proof',
      `BEFORE UPDATE ON execution_operations
       WHEN OLD.kind = 'interrupt'`,
      'interrupting',
      1,
    ],
  ] as const)(
    'contains a planning interrupt %s audit failure after fencing',
    async (fault, triggerTarget, expectedLifecycle, publishedDomainDelta) => {
      const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
      const started = await context.runtime.start(context.start);
      await context.runtime.drain();
      const running = required(
        context.executions.get(
          started.ok && 'execution' in started ? started.execution.id : '',
        ),
        'Expected a running execution',
      );
      const { session, state } = await attachBlockedPlanningSession(
        context,
        running,
      );
      const publishedBefore = context.published.domain.length;
      context.fixture.database.exec(`
        CREATE TRIGGER fail_planning_interrupt_${fault}
        ${triggerTarget}
        BEGIN SELECT RAISE(ABORT, 'fail planning ${fault}'); END
      `);

      await expect(
        context.runtime.interruptForPlanning(running.id),
      ).rejects.toMatchObject({
        name: PlanningInterruptCleanupError.name,
        code: 'planning_interrupt_audit_failure',
        diagnostics: [
          {
            phase: 'audit',
            message: `fail planning ${fault}`,
          },
        ],
      });

      expect(context.barrier.status).toBe('tripped');
      expect(state.closeCount).toBe(1);
      expect(context.fake.interruptCalls).toContain(session.nativeHandle);
      expect(context.executions.get(running.id)).toMatchObject({
        lifecycle: expectedLifecycle,
      });
      expect(context.published.domain).toHaveLength(
        publishedBefore + publishedDomainDelta,
      );
      expect(
        context.operations
          .listForExecution(running.id)
          .filter((operation) => operation.kind === 'interrupt'),
      ).toMatchObject(
        expectedLifecycle === 'running' ? [] : [{ state: 'pending' }],
      );
    },
  );

  it('contains a terminal planning event audit failure after adapter proof', async () => {
    const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
    const started = await context.runtime.start(context.start);
    await context.runtime.drain();
    const running = required(
      context.executions.get(
        started.ok && 'execution' in started ? started.execution.id : '',
      ),
      'Expected a running execution',
    );
    const { state } = await attachBlockedPlanningSession(context, running);
    context.fake.blockInterrupt();
    const publishedBefore = context.published.domain.length;

    const cleanup = context.runtime.interruptForPlanning(running.id);
    await context.fake.waitUntilInterruptCalled();
    context.fixture.database.exec(`
      CREATE TRIGGER fail_planning_terminal_event
      BEFORE INSERT ON domain_events
      BEGIN SELECT RAISE(ABORT, 'fail planning terminal event'); END
    `);
    context.fake.releaseInterrupt({ status: 'succeeded' });
    await expect(cleanup).rejects.toMatchObject({
      code: 'planning_interrupt_audit_failure',
      diagnostics: [
        {
          phase: 'audit',
          message: 'fail planning terminal event',
        },
      ],
    });

    expect(context.barrier.status).toBe('tripped');
    expect(state.closeCount).toBe(1);
    expect(context.executions.get(running.id)).toMatchObject({
      lifecycle: 'interrupting',
    });
    expect(context.published.domain).toHaveLength(publishedBefore + 1);
    expect(
      context.operations
        .listForExecution(running.id)
        .find((operation) => operation.kind === 'interrupt'),
    ).toMatchObject({ state: 'pending' });
  });

  it('rejects consumer-task self-wait before fencing or interruption', async () => {
    const domain: DomainEvent[] = [];
    const runtimeEvents: RuntimeEvent[] = [];
    const runtimeRef: { current?: ExecutionRuntime } = {};
    let cleanup: Promise<void> | undefined;
    let cleanupStartedResolve: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      cleanupStartedResolve = resolve;
    });
    const context = createPmRuntime(
      'todo',
      {},
      {
        domain: (event) => domain.push(event),
        runtime: (event) => {
          runtimeEvents.push(event);
          if (event.type === 'worker_execution.structured_output') {
            cleanup = required(
              runtimeRef.current,
              'Expected runtime',
            ).interruptForPlanning(event.executionId);
            cleanupStartedResolve?.();
          }
        },
      },
    );
    runtimeRef.current = context.runtime;

    const started = await context.runtime.start(context.start);
    await cleanupStarted;
    await expect(
      required(cleanup, 'Expected planning cleanup'),
    ).rejects.toMatchObject({
      code: 'planning_interrupt_quiescence_failure',
      diagnostics: [
        {
          phase: 'consumer_join',
          message: 'Self-wait was rejected before fencing',
        },
      ],
    });
    await context.runtime.drain();

    const executionId =
      started.ok && 'execution' in started ? started.execution.id : '';
    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'completed',
      lastAdapterCursor: 2,
      lastRuntimeSequence: 2,
    });
    expect(runtimeEvents.map((event) => event.type)).toEqual([
      'worker_execution.structured_output',
      'worker_execution.completed',
    ]);
    expect(domain.at(-1)).toMatchObject({
      type: 'worker_execution.lifecycle_changed',
      payload: { execution: { lifecycle: 'completed' } },
    });
    expect(context.fake.sessions[0]?.closeCount).toBe(1);
    expect(context.fake.interruptCalls).toEqual([]);
    expect(
      context.operations
        .listForExecution(executionId)
        .filter((operation) => operation.kind === 'interrupt'),
    ).toEqual([]);
  });

  it('rejects planning interruption for unrelated non-running executions', async () => {
    const context = createRuntime();
    const before = durableRuntimeState(context.fixture);

    await expect(
      context.runtime.interruptForPlanning(context.fixture.execution.id),
    ).rejects.toMatchObject({
      name: PlanningInterruptCleanupError.name,
      code: 'planning_interrupt_not_running',
    });

    expect(durableRuntimeState(context.fixture)).toEqual(before);
    expect(context.fake.interruptCalls).toEqual([]);
  });

  it.each([
    'completed',
    'failed',
    'interrupted',
    'attention_required',
  ] as const)(
    'rejects untagged %s PM execution as unrelated non-running state',
    async (lifecycle) => {
      const context = createPmRuntime('todo', { holdAfterAdapterCursor: 1 });
      const started = await context.runtime.start(context.start);
      await context.runtime.drain();
      const running = required(
        context.executions.get(
          started.ok && 'execution' in started ? started.execution.id : '',
        ),
        'Expected running PM execution',
      );
      inImmediateTransaction(context.fixture.database, () => {
        const exact = required(
          context.executions.get(running.id),
          'Expected durable PM execution',
        );
        if (lifecycle === 'interrupted') {
          const interrupting = context.executions.transitionInTransaction(
            exact.id,
            exact.revision,
            'interrupting',
            '2026-08-28T01:00:01.000Z',
          );
          context.executions.transitionInTransaction(
            interrupting.id,
            interrupting.revision,
            lifecycle,
            '2026-08-28T01:00:02.000Z',
          );
          return;
        }
        context.executions.transitionInTransaction(
          exact.id,
          exact.revision,
          lifecycle,
          '2026-08-28T01:00:01.000Z',
          lifecycle === 'failed'
            ? {
                failure: {
                  code: 'internal_error',
                  message: 'Untagged terminal PM fixture',
                },
              }
            : {},
        );
      });
      expect(
        context.operations
          .listForExecution(running.id)
          .filter((operation) => operation.kind === 'interrupt'),
      ).toEqual([]);
      const before = durableRuntimeState(context.fixture);
      const publishedBefore = {
        domain: context.published.domain.length,
        runtime: context.published.runtime.length,
      };

      await expect(
        context.runtime.interruptForPlanning(running.id),
      ).rejects.toMatchObject({
        name: PlanningInterruptCleanupError.name,
        code: 'planning_interrupt_not_running',
        diagnostics: [],
      });

      expect(context.barrier.status).toBe('healthy');
      expect(durableRuntimeState(context.fixture)).toEqual(before);
      expect(context.published.domain).toHaveLength(publishedBefore.domain);
      expect(context.published.runtime).toHaveLength(publishedBefore.runtime);
      expect(context.fake.interruptCalls).toEqual([]);
    },
  );

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
    expect(context.operations.listForExecution(failed.id)).toMatchObject([
      { kind: 'start', state: 'failed' },
    ]);
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
    expect(context.operations.listForExecution(failed.id)).toMatchObject([
      { kind: 'start', state: 'failed' },
    ]);
    expect(context.fake.startCount).toBe(0);
  });

  it('durably rejects ambiguous required skills while preferred ambiguity falls back', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = {
      ...fake.capabilitiesValue,
      skills: [
        {
          logicalId: 'mesh.preferred',
          nativeId: 'fake.preferred-a',
          version: '1.3.0',
          digest: 'a'.repeat(64),
        },
        {
          logicalId: 'mesh.preferred',
          nativeId: 'fake.preferred-b',
          version: '1.9.0',
          digest: 'b'.repeat(64),
        },
        {
          logicalId: 'mesh.required',
          nativeId: 'fake.required-a',
          version: '0.2.4',
          digest: 'c'.repeat(64),
        },
        {
          logicalId: 'mesh.required',
          nativeId: 'fake.required-b',
          version: '0.2.9',
          digest: 'd'.repeat(64),
        },
      ],
    };
    const context = createRuntime({
      fake,
      profile: (profile) => ({
        ...profile,
        document: {
          ...profile.document,
          spec: {
            ...profile.document.spec,
            skills: {
              preferred: [
                { id: 'mesh.preferred', constraint: { version: '^1.2.3' } },
              ],
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
    expect(failed).toMatchObject({
      lifecycle: 'failed',
      failure: {
        code: 'required_skill_unavailable',
        missing: ['mesh.required'],
      },
      resolvedSkills: [
        { mode: 'preferred', resolution: { kind: 'mesh-native-fallback' } },
        { mode: 'required', resolution: { kind: 'unavailable' } },
      ],
    });
    expect(
      context.fixture.commands.find(context.start.idempotencyKey)?.result,
    ).toEqual(result);
    expect(context.operations.listForExecution(failed.id)).toMatchObject([
      { kind: 'start', state: 'failed' },
    ]);
    expect(fake.startCount).toBe(0);
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
    expect(lookupTransactions.filter((inside) => !inside)).toHaveLength(3);
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

    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
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
    expect(fake.resolveSkillsCount).toBe(0);
    expect(fake.startCount).toBe(0);
    expect(fake.interruptCalls).toEqual([]);
  });

  it('does not attach or persist a session returned after the barrier trips', async () => {
    const fake = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
    fake.blockStart();
    const context = createRuntime({ fake });
    const pending = context.runtime.start(context.start);
    await fake.waitUntilStartCalled();
    const before = durableRuntimeState(context.fixture);

    context.barrier.trip(new Error('blocked start audit failure'));
    fake.releaseStart();
    await pending;
    await context.runtime.drain();

    expect(durableRuntimeState(context.fixture)).toEqual(before);
    expect(fake.sessions[0]?.consumedAdapterCursors).toEqual([]);
    expect(fake.sessions[0]?.closeCount).toBe(1);
    expect(fake.interruptCalls).toEqual([fake.sessions[0]?.nativeHandle]);
    expect(context.barrier.diagnostics).toEqual([
      expect.objectContaining({ cause: 'blocked start audit failure' }),
    ]);
  });

  it('does not persist a start rejection returned after the barrier trips', async () => {
    const fake = new FakeHarnessAdapter();
    let startCalledResolve: (() => void) | undefined;
    const startCalled = new Promise<void>((resolve) => {
      startCalledResolve = resolve;
    });
    let rejectStart: ((error: Error) => void) | undefined;
    const blockedStart = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    vi.spyOn(fake, 'start').mockImplementation(async () => {
      startCalledResolve?.();
      return blockedStart;
    });
    const context = createRuntime({ fake });
    const pending = context.runtime.start(context.start);
    await startCalled;
    const before = durableRuntimeState(context.fixture);

    context.barrier.trip(new Error('blocked start rejection audit failure'));
    rejectStart?.(new Error('blocked start rejected'));
    await pending;

    expect(durableRuntimeState(context.fixture)).toEqual(before);
    expect(fake.interruptCalls).toEqual([]);
    expect(context.barrier.diagnostics).toEqual([
      expect.objectContaining({
        cause: 'blocked start rejection audit failure',
      }),
    ]);
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
      expect(
        JSON.parse(
          required(diagnostics[0], 'Expected audit input').payload_json,
        ),
      ).toMatchObject({
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
          .prepare('SELECT * FROM raw_diagnostics WHERE execution_id = ?')
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

  it.each(['starting', 'running'] as const)(
    'preserves committed start truth when %s publication throws',
    async (lifecycle) => {
      const publisher = {
        domain: vi.fn((event: DomainEvent) => {
          if (
            event.type === 'worker_execution.lifecycle_changed' &&
            event.payload.execution.lifecycle === lifecycle
          ) {
            throw new Error(`publish ${lifecycle} failed`);
          }
        }),
        runtime: vi.fn(),
      };
      const context = createRuntime({
        fake: new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 }),
        publisher,
      });

      const result = await context.runtime.start(context.start);
      await context.runtime.drain();
      const executionId =
        result.ok && 'execution' in result ? result.execution.id : '';

      expect(context.fake.startCount).toBe(1);
      expect(context.executions.get(executionId)).toMatchObject({
        lifecycle: 'running',
        lastAdapterCursor: 2,
        failure: null,
      });
      expect(context.operations.listForExecution(executionId)).toMatchObject([
        { kind: 'start', state: 'succeeded' },
      ]);
      expect(
        context.fixture.events.domainAfter(context.fixture.project.id, 0)
          .events,
      ).toHaveLength(2);
      expect(context.barrier.status).toBe('healthy');
      expect(context.barrier.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Domain publication failed',
            cause: `publish ${lifecycle} failed`,
          }),
        ]),
      );
    },
  );

  it('continues after runtime publication fails without misclassifying adapter input', async () => {
    const publisher = {
      domain: vi.fn(),
      runtime: vi.fn((event: RuntimeEvent) => {
        if (event.adapterCursor === 1) {
          throw new Error('runtime publish failed');
        }
      }),
    };
    const context = createRuntime({
      fake: new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 }),
      publisher,
    });

    const result = await context.runtime.start(context.start);
    await context.runtime.drain();
    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';

    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'running',
      lastAdapterCursor: 2,
      failure: null,
    });
    expect(
      context.fixture.events.runtimeAfter(context.fixture.project.id, 0).events,
    ).toHaveLength(2);
    expect(context.barrier.status).toBe('healthy');
    expect(context.barrier.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Runtime publication failed',
          cause: 'runtime publish failed',
        }),
      ]),
    );
  });

  it('preserves terminal completion when terminal publication throws', async () => {
    const publisher = {
      domain: vi.fn((event: DomainEvent) => {
        if (
          event.type === 'worker_execution.lifecycle_changed' &&
          event.payload.execution.lifecycle === 'completed'
        ) {
          throw new Error('completion domain publish failed');
        }
      }),
      runtime: vi.fn((event: RuntimeEvent) => {
        if (event.adapterCursor === 6) {
          throw new Error('completion runtime publish failed');
        }
      }),
    };
    const fake = new FakeHarnessAdapter();
    const context = createRuntime({ fake, publisher });

    const result = await context.runtime.start(context.start);
    await context.runtime.drain();
    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';

    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'completed',
      lastAdapterCursor: 6,
      failure: null,
    });
    expect(fake.sessions[0]?.closeCount).toBe(1);
    expect(fake.interruptCalls).toEqual([]);
    expect(context.barrier.status).toBe('healthy');
    expect(context.barrier.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Runtime publication failed' }),
        expect.objectContaining({ message: 'Domain publication failed' }),
      ]),
    );
  });

  it('preserves terminal completion when successful cleanup close throws', async () => {
    const fake = new FakeHarnessAdapter();
    const originalStart = fake.start.bind(fake);
    let closeCount = 0;
    vi.spyOn(fake, 'start').mockImplementation(async (request) => {
      const session = await originalStart(request);
      const wrapper: HarnessSession = {
        get nativeHandle() {
          return session.nativeHandle;
        },
        events: (afterAdapterCursor) => session.events(afterAdapterCursor),
        async close() {
          closeCount += 1;
          throw new Error('terminal close failed');
        },
      };
      return wrapper as unknown as Awaited<ReturnType<typeof fake.start>>;
    });
    const context = createRuntime({ fake });

    const result = await context.runtime.start(context.start);
    await context.runtime.drain();
    const executionId =
      result.ok && 'execution' in result ? result.execution.id : '';

    expect(context.executions.get(executionId)).toMatchObject({
      lifecycle: 'completed',
      lastAdapterCursor: 6,
      failure: null,
    });
    expect(closeCount).toBe(1);
    expect(fake.interruptCalls).toEqual([]);
    expect(context.barrier.status).toBe('healthy');
    expect(context.barrier.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Session close failed after successful completion',
          cause: 'terminal close failed',
        }),
      ]),
    );
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

  it('does not persist interrupt proof returned after the barrier trips', async () => {
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
    const pending = context.runtime.interrupt(interrupt);
    await context.fake.waitUntilInterruptCalled();
    const before = durableRuntimeState(context.fixture);

    context.barrier.trip(new Error('blocked interrupt audit failure'));
    context.fake.releaseInterrupt({ status: 'succeeded' });
    await pending;

    expect(durableRuntimeState(context.fixture)).toEqual(before);
    expect(context.barrier.diagnostics).toEqual([
      expect.objectContaining({ cause: 'blocked interrupt audit failure' }),
    ]);
  });

  it('does not persist follow-up probe proof returned after the barrier trips', async () => {
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
    let probeCalledResolve: (() => void) | undefined;
    const probeCalled = new Promise<void>((resolve) => {
      probeCalledResolve = resolve;
    });
    let releaseProbe: (() => void) | undefined;
    const blockedProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.spyOn(context.fake, 'probe').mockImplementation(async () => {
      probeCalledResolve?.();
      await blockedProbe;
      return { status: 'terminal', outcome: 'interrupted' };
    });
    context.fake.blockInterrupt();
    const pending = context.runtime.interrupt(interrupt);
    await context.fake.waitUntilInterruptCalled();
    context.fake.releaseInterrupt({ status: 'already_terminal' });
    await probeCalled;
    const before = durableRuntimeState(context.fixture);

    context.barrier.trip(new Error('blocked probe audit failure'));
    releaseProbe?.();
    await pending;

    expect(durableRuntimeState(context.fixture)).toEqual(before);
    expect(context.barrier.diagnostics).toEqual([
      expect.objectContaining({ cause: 'blocked probe audit failure' }),
    ]);
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

  it.each(['interrupting', 'interrupted'] as const)(
    'preserves committed interrupt truth when %s publication throws',
    async (lifecycle) => {
      const publisher = {
        domain: vi.fn((event: DomainEvent) => {
          if (
            event.type === 'worker_execution.lifecycle_changed' &&
            event.payload.execution.lifecycle === lifecycle
          ) {
            throw new Error(`publish ${lifecycle} failed`);
          }
        }),
        runtime: vi.fn(),
      };
      const context = createRuntime({ publisher });
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

      expect(context.fake.interruptCalls).toHaveLength(1);
      expect(context.executions.get(running.id)).toMatchObject({
        lifecycle: 'interrupted',
        failure: null,
      });
      expect(
        context.operations
          .listForExecution(running.id)
          .find((operation) => operation.kind === 'interrupt'),
      ).toMatchObject({ state: 'succeeded' });
      expect(
        context.fixture.commands.find(interrupt.idempotencyKey),
      ).toBeDefined();
      expect(context.barrier.status).toBe('healthy');
      expect(context.barrier.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Domain publication failed',
            cause: `publish ${lifecycle} failed`,
          }),
        ]),
      );
    },
  );

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

  it('does not persist an envelope returned after the barrier trips during next', async () => {
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
    let nextCalledResolve: (() => void) | undefined;
    const nextCalled = new Promise<void>((resolve) => {
      nextCalledResolve = resolve;
    });
    let releaseNext: (() => void) | undefined;
    const blockedNext = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    let nextCount = 0;
    let closeCount = 0;
    const session: HarnessSession = {
      nativeHandle: required(running.nativeHandle, 'Expected native handle'),
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<HarnessEventEnvelope>> {
              nextCount += 1;
              if (nextCount > 1) return { done: true, value: undefined };
              nextCalledResolve?.();
              await blockedNext;
              return {
                done: false,
                value: {
                  adapterCursor: 2,
                  raw: { source: 'blocked next' },
                  normalized: {
                    projectId: running.projectId,
                    executionId: running.id,
                    adapterCursor: 2,
                    occurredAt: '2026-08-28T01:00:02.000Z',
                    type: 'worker_execution.output',
                    payload: { text: 'must not persist' },
                  },
                },
              };
            },
          };
        },
      }),
      async close() {
        closeCount += 1;
      },
    };
    const before = durableRuntimeState(context.fixture);
    context.runtime.attach(running.id, session);
    await nextCalled;

    context.barrier.trip(new Error('blocked next audit failure'));
    releaseNext?.();
    await context.runtime.drain();

    expect(durableRuntimeState(context.fixture)).toEqual(before);
    expect(nextCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(context.fake.interruptCalls).toContain(session.nativeHandle);
    expect(context.barrier.diagnostics).toEqual([
      expect.objectContaining({ cause: 'blocked next audit failure' }),
    ]);
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
