import { randomUUID } from 'node:crypto';

import {
  startExecutionEnvelopeSchema,
  workerExecutionSchema,
  type PmDiscoveryAssignment,
  type PlanningCycle,
  type PlanningProposal,
  type PlanningTurn,
  type StartExecutionEnvelope,
  type V2CommandResult,
  type WorkerExecution,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { inImmediateTransaction } from '../db/database.js';
import { AuditBarrier } from '../executions/audit-barrier.js';
import { ExecutionRepository } from '../executions/execution-repository.js';
import { OperationRepository } from '../executions/operation-repository.js';
import { hashV2Command } from '../storage/command-repository.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { PlanningRepository } from './planning-repository.js';
import {
  PlanningService,
  type PmExecutionLauncher,
  type PmExecutionLaunchInput,
  type PmExecutionReservation,
} from './planning-service.js';

const fixtures: ReturnType<typeof createV2TestDatabase>[] = [];
const now = '2026-08-29T00:00:00.000Z';

class FakeLauncher implements PmExecutionLauncher {
  readonly inputs: PmExecutionLaunchInput[] = [];
  readonly trace: string[] = [];
  readonly byKey = new Map<string, PmExecutionReservation>();
  reserveBarrier: Promise<void> | undefined;
  activateBarrier: Promise<void> | undefined;
  cancelError: Error | undefined;
  interruptError: Error | undefined;

  constructor(
    private readonly fixture: ReturnType<typeof createV2TestDatabase>,
    private readonly executions: ExecutionRepository,
    private readonly operations: OperationRepository,
  ) {}

  findReserved(input: StartExecutionEnvelope) {
    this.inputs.push(startExecutionEnvelopeSchema.parse(input));
    return this.byKey.get(input.idempotencyKey);
  }

  async reserve(input: StartExecutionEnvelope) {
    const parsed = startExecutionEnvelopeSchema.parse(input);
    this.inputs.push(parsed);
    this.trace.push('reserve');
    const existing = this.byKey.get(parsed.idempotencyKey);
    if (existing) return existing;
    const execution = workerExecutionSchema.parse({
      id: randomUUID(),
      projectId: parsed.command.projectId,
      profileId: parsed.command.profileId,
      profileRevision: parsed.command.profileRevision,
      assignment: parsed.command.assignment,
      profileSnapshot: {
        profileId: this.fixture.pmProfileRevision.profileId,
        projectId: null,
        profileRevision: this.fixture.pmProfileRevision.revision,
        baseProfileId: null,
        baseRevision: null,
        document: this.fixture.pmProfileRevision.document,
        digest: this.fixture.pmProfileRevision.digest,
      },
      skillRequests: { preferred: [], required: [] },
      resolvedSkills: [],
      capabilitySnapshot: {
        adapterId: 'fake',
        capabilities: ['execution.stream'],
        skills: [],
        exactResume: true,
      },
      adapterId: 'fake',
      model: 'deterministic',
      nativeHandle: null,
      lifecycle: 'starting',
      revision: 0,
      lastAdapterCursor: 0,
      lastRuntimeSequence: 0,
      replacementForExecutionId: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });
    const result: V2CommandResult = {
      ok: true,
      commandType: 'worker_execution.start',
      execution,
    };
    inImmediateTransaction(this.fixture.database, () => {
      this.executions.insertInTransaction(execution);
      this.operations.createPendingInTransaction({
        executionId: execution.id,
        kind: 'start',
        request: {
          version: 'mesh.v2.execution-start/v1',
          idempotencyKey: parsed.idempotencyKey,
          requestHash: hashV2Command(parsed.command),
          request: parsed.command,
        },
        createdAt: now,
      });
    });
    const reservation = { execution, result, activationRequired: true };
    this.byKey.set(parsed.idempotencyKey, reservation);
    await this.reserveBarrier;
    return reservation;
  }

  async activate(executionId: string) {
    this.trace.push('activate');
    await this.activateBarrier;
    const current = this.executions.get(executionId)!;
    if (current.lifecycle !== 'starting') return;
    inImmediateTransaction(this.fixture.database, () => {
      this.executions.transitionInTransaction(
        executionId,
        current.revision,
        'running',
        now,
        { nativeHandle: `fake:${executionId}` },
      );
      const operation = this.operations
        .listForExecution(executionId)
        .find(({ kind }) => kind === 'start')!;
      this.operations.finishInTransaction(
        operation.id,
        'succeeded',
        { status: 'succeeded' },
        now,
      );
    });
  }

  async cancelReserved(executionId: string): Promise<WorkerExecution> {
    this.trace.push('cancel');
    if (this.cancelError) throw this.cancelError;
    const current = this.executions.get(executionId)!;
    if (current.lifecycle !== 'starting') return current;
    return inImmediateTransaction(this.fixture.database, () => {
      const failed = this.executions.transitionInTransaction(
        executionId,
        current.revision,
        'failed',
        now,
        {
          failure: {
            code: 'startup_interrupted_before_start',
            message: 'Planning cycle was abandoned before adapter start',
          },
        },
      );
      const operation = this.operations
        .listForExecution(executionId)
        .find(({ kind }) => kind === 'start')!;
      this.operations.finishInTransaction(
        operation.id,
        'failed',
        { reason: 'planning_cycle_abandoned' },
        now,
      );
      return failed;
    });
  }

  async interruptForPlanning(executionId: string): Promise<void> {
    this.trace.push('interrupt');
    if (this.interruptError) throw this.interruptError;
    const current = this.executions.get(executionId)!;
    if (current.lifecycle !== 'running') return;
    inImmediateTransaction(this.fixture.database, () => {
      const interrupting = this.executions.transitionInTransaction(
        executionId,
        current.revision,
        'interrupting',
        now,
      );
      this.executions.transitionInTransaction(
        executionId,
        interrupting.revision,
        'interrupted',
        now,
      );
    });
  }
}

const setup = () => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  const repository = new PlanningRepository(fixture.database);
  const executions = new ExecutionRepository(fixture.database);
  const operations = new OperationRepository(fixture.database);
  const launcher = new FakeLauncher(fixture, executions, operations);
  const publish = vi.fn();
  const barrier = new AuditBarrier();
  const service = new PlanningService({
    database: fixture.database,
    repository,
    commands: fixture.commands,
    events: fixture.events,
    executions,
    profiles: {
      resolveApproved: () => ({
        profileId: fixture.pmProfileRevision.profileId,
        projectId: null,
        profileRevision: fixture.pmProfileRevision.revision,
        baseProfileId: null,
        baseRevision: null,
        document: fixture.pmProfileRevision.document,
        digest: fixture.pmProfileRevision.digest,
      }),
    },
    launcher,
    barrier,
    reportConsumer: { consume: vi.fn() },
    now: () => now,
    publishDomain: publish,
  });
  return {
    fixture,
    repository,
    executions,
    operations,
    launcher,
    barrier,
    publish,
    service,
  };
};

const seedProposalHistory = (
  context: ReturnType<typeof setup>,
): { cycle: PlanningCycle; human: PlanningTurn } => {
  const cycle: PlanningCycle = {
    id: randomUUID(),
    projectId: context.fixture.project.id,
    lifecycle: 'awaiting_approval',
    revision: 1,
    profileId: context.fixture.pmProfileRevision.profileId,
    profileRevision: context.fixture.pmProfileRevision.revision,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 16,
    activeExecutionId: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
  const human: PlanningTurn = {
    id: randomUUID(),
    projectId: cycle.projectId,
    planningCycleId: cycle.id,
    ordinal: 1,
    actor: 'human',
    message: 'Build a persistent Todo application.',
    launchState: 'execution_bound',
    executionId: context.fixture.execution.id,
    createdAt: now,
  };
  const pm: PlanningTurn = {
    id: randomUUID(),
    projectId: cycle.projectId,
    planningCycleId: cycle.id,
    ordinal: 2,
    actor: 'pm',
    message: 'Review this proposal.',
    launchState: null,
    executionId: context.fixture.execution.id,
    createdAt: now,
  };
  const proposal = (revision: number): PlanningProposal => ({
    id: randomUUID(),
    projectId: cycle.projectId,
    planningCycleId: cycle.id,
    revision,
    lifecycle: revision === 16 ? 'awaiting_approval' : 'superseded',
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    summary: `Todo proposal ${revision}`,
    projectIntent: {
      goal: 'Ship Todo.',
      targetUsers: ['People'],
      desiredCapabilities: ['Add items'],
      constraints: [],
      nonGoals: [],
      successConditions: ['Items persist'],
      rationale: 'Requested.',
      provenance: [
        {
          kind: 'conversation_turn',
          turnId: human.id,
          rationale: 'Initial request.',
        },
      ],
    },
    records: [],
    relationships: [],
    diff: {
      intentChanges: [],
      recordChanges: { create: 0, revise: 0, reuse: 0 },
      relationshipChanges: { added: [], removed: [] },
    },
    createdByTurnId: pm.id,
    createdByExecutionId: context.fixture.execution.id,
    rejectionFeedback: null,
    createdAt: now,
    decidedAt: revision === 16 ? null : now,
  });
  inImmediateTransaction(context.fixture.database, () => {
    context.repository.insertCycleInTransaction(cycle);
    context.repository.insertTurnInTransaction(human);
    context.repository.insertTurnInTransaction(pm);
    for (let revision = 1; revision <= 16; revision += 1) {
      context.repository.insertProposalInTransaction(proposal(revision));
    }
  });
  return { cycle, human };
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const firstTurn = (fixture: ReturnType<typeof createV2TestDatabase>) => ({
  idempotencyKey: 'planning-first',
  actor: { kind: 'human' as const },
  command: {
    type: 'planning_cycle.submit_turn' as const,
    projectId: fixture.project.id,
    expectedCycleRevision: null,
    profileId: fixture.pmProfileRevision.profileId,
    profileRevision: fixture.pmProfileRevision.revision,
    message: 'Build a persistent Todo application.',
  },
});

describe('PlanningService', () => {
  it('commits a human turn, publishes it, binds the exact reservation, then activates', async () => {
    const { fixture, repository, launcher, publish, service } = setup();

    const result = await service.submitTurn(firstTurn(fixture));

    expect(result).toMatchObject({
      ok: true,
      commandType: 'planning_cycle.submit_turn',
      planningCycle: { cycle: { lifecycle: 'launch_pending' } },
    });
    const active = repository.activeCycle(fixture.project.id)!;
    const view = repository.cycleView(active.id)!;
    const human = view.turns[0];
    expect(view.cycle.lifecycle).toBe('execution_active');
    expect(human.launchState).toBe('execution_bound');
    expect(launcher.trace).toEqual(['reserve', 'activate']);
    expect(publish).toHaveBeenCalledTimes(2);
    const launch = launcher.inputs.at(-1)!;
    expect(startExecutionEnvelopeSchema.parse(launch)).toEqual(launch);
    expect(launch).toMatchObject({
      idempotencyKey: `planning-turn:${human.id}`,
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.start',
        projectId: fixture.project.id,
        profileId: fixture.pmProfileRevision.profileId,
        profileRevision: fixture.pmProfileRevision.revision,
        assignment: {
          kind: 'pm_discovery',
          planningCycleId: active.id,
          humanTurnId: human.id,
          expectedCycleRevision: 1,
          expectedProposalRevision: 1,
        } satisfies Partial<PmDiscoveryAssignment>,
      },
    });
  });

  it('replays the exact submit result and rejects a distinct concurrent turn without writes', async () => {
    const { fixture, repository, launcher, service } = setup();
    const envelope = firstTurn(fixture);
    const first = await service.submitTurn(envelope);
    const active = repository.activeCycle(fixture.project.id)!;
    const replay = await service.submitTurn(envelope);
    const distinct = await service.submitTurn({
      idempotencyKey: 'planning-distinct',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.submit_turn',
        projectId: fixture.project.id,
        planningCycleId: active.id,
        expectedCycleRevision: active.revision,
        message: 'A second turn while execution is active.',
      },
    });

    expect(replay).toEqual(first);
    expect(distinct).toMatchObject({
      ok: false,
      error: { code: 'planning_cycle_revision_conflict' },
    });
    expect(repository.cycleView(active.id)?.turns).toHaveLength(1);
    expect(launcher.trace.filter((entry) => entry === 'reserve')).toHaveLength(
      1,
    );
  });

  it('rejects an incompatible PM profile before a turn, event, or launch write', async () => {
    const context = setup();
    const service = new PlanningService({
      database: context.fixture.database,
      repository: context.repository,
      commands: context.fixture.commands,
      events: context.fixture.events,
      executions: context.executions,
      profiles: {
        resolveApproved: () => ({
          profileId: context.fixture.profileRevision.profileId,
          projectId: null,
          profileRevision: context.fixture.profileRevision.revision,
          baseProfileId: null,
          baseRevision: null,
          document: context.fixture.profileRevision.document,
          digest: context.fixture.profileRevision.digest,
        }),
      },
      launcher: context.launcher,
      barrier: new AuditBarrier(),
      reportConsumer: { consume: vi.fn() },
      now: () => now,
      publishDomain: context.publish,
    });

    const result = await service.submitTurn(firstTurn(context.fixture));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'planning_profile_incompatible' },
    });
    expect(
      context.repository.activeCycle(context.fixture.project.id),
    ).toBeUndefined();
    expect(
      context.fixture.events.cursors(context.fixture.project.id).domain,
    ).toBe(0);
    expect(context.launcher.trace).toEqual([]);
  });

  it('rejects the proposal history cap before any durable or launcher side effect', async () => {
    const context = setup();
    const { cycle } = seedProposalHistory(context);
    const before = {
      turns: context.repository.cycleView(cycle.id)!.turns,
      cursor: context.fixture.events.cursors(cycle.projectId).domain,
      executions: context.executions.list(cycle.projectId),
    };

    const result = await context.service.submitTurn({
      idempotencyKey: 'proposal-cap',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.submit_turn',
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        message: 'Please revise the proposal.',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'planning_cycle_history_limit' },
    });
    expect(context.repository.cycleView(cycle.id)!.turns).toEqual(before.turns);
    expect(context.fixture.events.cursors(cycle.projectId).domain).toBe(
      before.cursor,
    );
    expect(context.executions.list(cycle.projectId)).toEqual(before.executions);
    expect(context.launcher.inputs).toEqual([]);
    expect(context.launcher.trace).toEqual([]);
    expect(context.fixture.commands.find('proposal-cap')).toBeUndefined();
  });

  it('cancels a reserved launch before binding and commits abandonment last', async () => {
    const { fixture, repository, launcher, service } = setup();
    let release!: () => void;
    launcher.reserveBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = service.submitTurn(firstTurn(fixture));
    while (!launcher.trace.includes('reserve')) await Promise.resolve();
    const cycle = repository.activeCycle(fixture.project.id)!;
    const abandon = service.abandonCycle({
      idempotencyKey: 'abandon-reserved',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.abandon',
        projectId: fixture.project.id,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
      },
    });
    release();
    await submit;
    const result = await abandon;

    expect(result).toMatchObject({
      ok: true,
      commandType: 'planning_cycle.abandon',
      planningCycle: { cycle: { lifecycle: 'abandoned' } },
    });
    expect(launcher.trace).toEqual(['reserve', 'cancel']);
    expect(repository.cycle(cycle.id)?.lifecycle).toBe('abandoned');
    const abandoned = repository.cycle(cycle.id)!;
    const repeat = await service.abandonCycle({
      idempotencyKey: 'abandon-distinct-after-terminal',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.abandon',
        projectId: fixture.project.id,
        planningCycleId: cycle.id,
        expectedCycleRevision: abandoned.revision,
      },
    });
    expect(repeat).toMatchObject({
      ok: false,
      error: { code: 'planning_cycle_revision_conflict' },
    });
  });

  it('stops after reserve when the audit barrier trips across the await', async () => {
    const context = setup();
    let release!: () => void;
    context.launcher.reserveBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = context.service.submitTurn(firstTurn(context.fixture));
    while (!context.launcher.trace.includes('reserve')) await Promise.resolve();
    const cycle = context.repository.activeCycle(context.fixture.project.id)!;
    const turn = context.repository.cycleView(cycle.id)!.turns[0];

    context.barrier.trip(new Error('audit failed while reserving'), now);
    release();

    await expect(submit).rejects.toThrow('Audit barrier is tripped');
    expect(context.repository.cycle(cycle.id)?.lifecycle).toBe(
      'launch_pending',
    );
    expect(context.repository.turn(turn.id)).toMatchObject({
      launchState: 'launch_pending',
      executionId: null,
    });
    expect(context.launcher.trace).toEqual(['reserve']);
  });

  it('does not store abandonment when cleanup fails', async () => {
    const { fixture, repository, launcher, service } = setup();
    await service.submitTurn(firstTurn(fixture));
    const cycle = repository.activeCycle(fixture.project.id)!;
    launcher.interruptError = new Error('interrupt cleanup failed');

    await expect(
      service.abandonCycle({
        idempotencyKey: 'abandon-fails',
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.abandon',
          projectId: fixture.project.id,
          planningCycleId: cycle.id,
          expectedCycleRevision: cycle.revision,
        },
      }),
    ).rejects.toThrow('interrupt cleanup failed');
    expect(repository.cycle(cycle.id)?.lifecycle).not.toBe('abandoned');
    expect(fixture.commands.find('abandon-fails')).toBeUndefined();
  });

  it('rediscovers and contains a pre-bind reservation when abandonment cleanup is retried', async () => {
    const context = setup();
    let release!: () => void;
    context.launcher.reserveBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = context.service.submitTurn(firstTurn(context.fixture));
    while (!context.launcher.trace.includes('reserve')) await Promise.resolve();
    const cycle = context.repository.activeCycle(context.fixture.project.id)!;
    context.launcher.cancelError = new Error('reservation cleanup failed');
    const firstAbandonment = context.service.abandonCycle({
      idempotencyKey: 'abandon-prebind-fails',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.abandon',
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
      },
    });
    release();

    await expect(submit).rejects.toThrow('reservation cleanup failed');
    await expect(firstAbandonment).rejects.toThrow(
      'reservation cleanup failed',
    );
    expect(context.repository.cycle(cycle.id)?.lifecycle).toBe(
      'launch_pending',
    );
    expect(
      context.fixture.commands.find('abandon-prebind-fails'),
    ).toBeUndefined();

    context.launcher.cancelError = undefined;
    const retried = await context.service.abandonCycle({
      idempotencyKey: 'abandon-prebind-retry',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.abandon',
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
      },
    });

    expect(retried).toMatchObject({
      ok: true,
      planningCycle: { cycle: { lifecycle: 'abandoned' } },
    });
    const reservation = [...context.launcher.byKey.values()][0]!;
    expect(context.executions.get(reservation.execution.id)?.lifecycle).toBe(
      'failed',
    );
    expect(
      context.operations.listForExecution(reservation.execution.id)[0].state,
    ).toBe('failed');
    expect(context.launcher.trace).toEqual(['reserve', 'cancel', 'cancel']);
  });

  it('allows only one distinct same-revision abandonment to commit after awaiting', async () => {
    const context = setup();
    vi.spyOn(context.launcher, 'reserve').mockRejectedValueOnce(
      new Error('reservation transport stopped'),
    );
    await expect(
      context.service.submitTurn(firstTurn(context.fixture)),
    ).rejects.toThrow('reservation transport stopped');
    const cycle = context.repository.activeCycle(context.fixture.project.id)!;
    const beforeCursor = context.fixture.events.cursors(cycle.projectId).domain;
    const beforePublish = context.publish.mock.calls.length;
    const command = {
      type: 'planning_cycle.abandon' as const,
      projectId: cycle.projectId,
      planningCycleId: cycle.id,
      expectedCycleRevision: cycle.revision,
    };

    const results = await Promise.all([
      context.service.abandonCycle({
        idempotencyKey: 'abandon-race-first',
        actor: { kind: 'human' },
        command,
      }),
      context.service.abandonCycle({
        idempotencyKey: 'abandon-race-second',
        actor: { kind: 'human' },
        command,
      }),
    ]);

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([
      expect.objectContaining({
        error: {
          code: 'planning_cycle_revision_conflict',
          message: expect.any(String),
        },
      }),
    ]);
    expect(context.repository.cycle(cycle.id)).toMatchObject({
      lifecycle: 'abandoned',
      revision: cycle.revision + 1,
    });
    expect(context.fixture.events.cursors(cycle.projectId).domain).toBe(
      beforeCursor + 1,
    );
    expect(context.publish).toHaveBeenCalledTimes(beforePublish + 1);
    expect(
      ['abandon-race-first', 'abandon-race-second']
        .map((key) => context.fixture.commands.find(key)?.result)
        .filter((result) => result?.ok),
    ).toHaveLength(1);
  });

  it('does not reopen a failed launch after abandonment and restart', async () => {
    const context = setup();
    vi.spyOn(context.launcher, 'reserve').mockRejectedValueOnce(
      new Error('reservation transport stopped'),
    );
    await expect(
      context.service.submitTurn(firstTurn(context.fixture)),
    ).rejects.toThrow('reservation transport stopped');
    const pending = context.repository.pendingLaunchTurns()[0];
    const cycle = context.repository.cycle(pending.planningCycleId)!;

    const abandoned = await context.service.abandonCycle({
      idempotencyKey: 'abandon-after-reservation-failure',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.abandon',
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
      },
    });
    expect(abandoned).toMatchObject({
      ok: true,
      planningCycle: { cycle: { lifecycle: 'abandoned' } },
    });

    const restartedLauncher = new FakeLauncher(
      context.fixture,
      context.executions,
      context.operations,
    );
    const restarted = new PlanningService({
      database: context.fixture.database,
      repository: context.repository,
      commands: context.fixture.commands,
      events: context.fixture.events,
      executions: context.executions,
      profiles: {
        resolveApproved: () => ({
          profileId: context.fixture.pmProfileRevision.profileId,
          projectId: null,
          profileRevision: context.fixture.pmProfileRevision.revision,
          baseProfileId: null,
          baseRevision: null,
          document: context.fixture.pmProfileRevision.document,
          digest: context.fixture.pmProfileRevision.digest,
        }),
      },
      launcher: restartedLauncher,
      barrier: new AuditBarrier(),
      reportConsumer: { consume: vi.fn() },
      now: () => now,
      publishDomain: vi.fn(),
    });

    restarted.reconcilePendingReservations();
    await restarted.drainPendingLaunches();

    expect(context.repository.pendingLaunchTurns()).toEqual([]);
    expect(context.repository.turn(pending.id)).toMatchObject({
      launchState: 'launch_pending',
      executionId: null,
    });
    expect(context.repository.cycle(cycle.id)?.lifecycle).toBe('abandoned');
    expect(restartedLauncher.inputs).toEqual([]);
    expect(restartedLauncher.trace).toEqual([]);
  });

  it('projects an existing reconciled reservation to attention without reserving or activating', async () => {
    const { fixture, repository, executions, operations, launcher, service } =
      setup();
    const reserveFailure = vi
      .spyOn(launcher, 'reserve')
      .mockRejectedValueOnce(new Error('reservation transport stopped'));
    await expect(service.submitTurn(firstTurn(fixture))).rejects.toThrow(
      'reservation transport stopped',
    );
    reserveFailure.mockRestore();
    const turn = repository.pendingLaunchTurns()[0];
    const launch = launcher.inputs.at(-1)!;
    const reservation = await launcher.reserve(launch);
    const starting = executions.get(reservation.execution.id)!;
    inImmediateTransaction(fixture.database, () => {
      executions.transitionInTransaction(
        starting.id,
        starting.revision,
        'attention_required',
        now,
        {
          failure: {
            code: 'internal_error',
            message: 'Startup state was unknown after restart',
          },
        },
      );
      operations.finishInTransaction(
        operations.listForExecution(starting.id)[0].id,
        'unknown',
        { reason: 'restart_reconciliation' },
        now,
      );
    });
    launcher.trace.splice(0);
    const findReserved = vi.spyOn(launcher, 'findReserved');

    service.reconcilePendingReservations();

    expect(repository.turn(turn.id)).toMatchObject({
      launchState: 'execution_bound',
      executionId: starting.id,
    });
    expect(repository.cycle(turn.planningCycleId)?.lifecycle).toBe(
      'attention_required',
    );
    expect(launcher.trace).toEqual([]);

    const operationBefore = operations.listForExecution(starting.id)[0];
    const attentionCycle = repository.cycle(turn.planningCycleId)!;
    const abandoned = await service.abandonCycle({
      idempotencyKey: 'abandon-reconciled-attention',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.abandon',
        projectId: fixture.project.id,
        planningCycleId: attentionCycle.id,
        expectedCycleRevision: attentionCycle.revision,
      },
    });
    expect(abandoned).toMatchObject({
      ok: true,
      planningCycle: { cycle: { lifecycle: 'abandoned' } },
    });
    expect(findReserved).toHaveBeenCalledTimes(2);
    expect(launcher.trace).toEqual([]);
    expect(operations.listForExecution(starting.id)[0]).toEqual(
      operationBefore,
    );
  });

  it('does not observe or bind a pending reservation when reconciliation starts unhealthy', async () => {
    const context = setup();
    const reserveFailure = vi
      .spyOn(context.launcher, 'reserve')
      .mockRejectedValueOnce(new Error('reservation transport stopped'));
    await expect(
      context.service.submitTurn(firstTurn(context.fixture)),
    ).rejects.toThrow('reservation transport stopped');
    reserveFailure.mockRestore();
    const turn = context.repository.pendingLaunchTurns()[0];
    const launch = context.launcher.inputs.at(-1)!;
    const reservation = await context.launcher.reserve(launch);
    context.launcher.trace.splice(0);
    const inputCount = context.launcher.inputs.length;
    context.barrier.trip(new Error('audit unavailable'), now);

    expect(() => context.service.reconcilePendingReservations()).toThrow(
      'Audit barrier is tripped',
    );
    await expect(context.service.drainPendingLaunches()).rejects.toThrow(
      'Audit barrier is tripped',
    );

    expect(context.repository.turn(turn.id)).toMatchObject({
      launchState: 'launch_pending',
      executionId: null,
    });
    expect(context.repository.cycle(turn.planningCycleId)?.lifecycle).toBe(
      'launch_pending',
    );
    expect(context.executions.get(reservation.execution.id)?.lifecycle).toBe(
      'starting',
    );
    expect(context.launcher.inputs).toHaveLength(inputCount);
    expect(context.launcher.trace).toEqual([]);
  });
});
