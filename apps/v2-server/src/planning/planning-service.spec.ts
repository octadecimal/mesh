import { randomUUID } from 'node:crypto';

import {
  PM_PLAN_REPORT_SCHEMA,
  deliveryPlanProposalSchema,
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
import {
  hashV2Command,
  V2IdempotencyConflictError,
} from '../storage/command-repository.js';
import {
  createV2TestDatabase,
  insertV2TestProject,
} from '../test/create-v2-test-database.js';
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
        document: {
          ...this.fixture.pmProfileRevision.document,
          spec: {
            ...this.fixture.pmProfileRevision.document.spec,
            assignmentKinds: [parsed.command.assignment.kind],
            outputSchema: parsed.command.assignment.outputSchema,
          },
        },
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

const seedApprovedRequirement = (context: ReturnType<typeof setup>) => {
  const cycle: PlanningCycle = {
    id: randomUUID(),
    projectId: context.fixture.project.id,
    lifecycle: 'awaiting_approval',
    revision: 2,
    profileId: context.fixture.pmProfileRevision.profileId,
    profileRevision: context.fixture.pmProfileRevision.revision,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 1,
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
    message: 'Build Todo.',
    launchState: 'execution_bound',
    executionId: context.fixture.execution.id,
    createdAt: now,
  };
  const pm: PlanningTurn = {
    ...human,
    id: randomUUID(),
    ordinal: 2,
    actor: 'pm',
    message: 'Approve the requirement.',
    launchState: null,
  };
  const proposal: PlanningProposal = {
    id: randomUUID(),
    projectId: cycle.projectId,
    planningCycleId: cycle.id,
    revision: 1,
    lifecycle: 'awaiting_approval',
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    summary: 'Todo intent',
    projectIntent: {
      goal: 'Ship Todo.',
      targetUsers: ['People'],
      desiredCapabilities: ['Manage tasks'],
      constraints: [],
      nonGoals: [],
      successConditions: ['Tasks persist'],
      rationale: 'Requested.',
      provenance: [
        { kind: 'conversation_turn', turnId: human.id, rationale: 'Request.' },
      ],
    },
    records: [
      {
        operation: 'create',
        key: 'requirement',
        recordId: randomUUID(),
        content: {
          type: 'requirement',
          kind: 'functional',
          status: 'proposed',
          priority: 'must',
          statement: 'Users manage tasks.',
          rationale: 'Core.',
        },
        provenance: [
          {
            kind: 'conversation_turn',
            turnId: human.id,
            rationale: 'Request.',
          },
        ],
      },
    ],
    relationships: [],
    diff: {
      intentChanges: [
        'goal',
        'targetUsers',
        'desiredCapabilities',
        'successConditions',
        'rationale',
        'provenance',
      ],
      recordChanges: { create: 1, revise: 0, reuse: 0 },
      relationshipChanges: { added: [], removed: [] },
    },
    createdByTurnId: pm.id,
    createdByExecutionId: context.fixture.execution.id,
    rejectionFeedback: null,
    createdAt: now,
    decidedAt: null,
  };
  return inImmediateTransaction(context.fixture.database, () => {
    context.repository.insertCycleInTransaction(cycle);
    context.repository.insertTurnInTransaction(human);
    context.repository.insertTurnInTransaction(pm);
    context.repository.insertProposalInTransaction(proposal);
    const approved = context.repository.applyApprovedProposalInTransaction(
      proposal,
      now,
    );
    context.repository.updateProposalInTransaction({
      ...proposal,
      lifecycle: 'approved',
      decidedAt: now,
    });
    context.repository.updateCycleInTransaction(
      { ...cycle, lifecycle: 'approved', revision: 3, endedAt: now },
      2,
    );
    return approved;
  });
};

const seedDeliveryPlanProposal = (
  context: ReturnType<typeof setup>,
  approved: ReturnType<typeof seedApprovedRequirement>,
) => {
  const cycle: PlanningCycle = {
    id: randomUUID(),
    projectId: context.fixture.project.id,
    lifecycle: 'awaiting_approval',
    revision: 2,
    profileId: context.fixture.pmProfileRevision.profileId,
    profileRevision: context.fixture.pmProfileRevision.revision,
    baseProjectIntentRevision: approved.projectIntent.revision,
    baseLedgerRevision: approved.ledger.revision,
    latestProposalRevision: 1,
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
    message: 'Plan Todo.',
    launchState: 'execution_bound',
    executionId: context.fixture.execution.id,
    createdAt: now,
  };
  const pm: PlanningTurn = {
    ...human,
    id: randomUUID(),
    ordinal: 2,
    actor: 'pm',
    message: 'One milestone and task.',
    launchState: null,
    executionId: context.fixture.execution.id,
  };
  const milestoneId = randomUUID();
  const taskId = randomUUID();
  const requirement = approved.records.find(
    ({ content }) => content.type === 'requirement',
  )!;
  const proposal = deliveryPlanProposalSchema.parse({
    id: randomUUID(),
    projectId: cycle.projectId,
    planningCycleId: cycle.id,
    revision: 1,
    lifecycle: 'awaiting_approval',
    base: {
      projectIntentId: approved.projectIntent.id,
      projectIntentRevision: approved.projectIntent.revision,
      ledgerId: approved.ledger.id,
      ledgerRevision: approved.ledger.revision,
      deliveryPlan: { id: null, revision: null },
    },
    proposedPlan: {
      summary: 'Todo delivery plan.',
      milestones: [
        {
          operation: 'create',
          key: 'todo',
          content: {
            title: 'Todo',
            outcome: 'Todo works.',
            stopCondition: 'Todo is usable.',
            exclusions: [],
            ordinal: 1,
          },
        },
      ],
      tasks: [
        {
          operation: 'create',
          key: 'persist',
          content: {
            milestone: { kind: 'proposal', key: 'todo' },
            title: 'Persist tasks',
            outcome: 'Tasks survive restart.',
            acceptanceCriteria: ['Task persists.'],
            verificationCriteria: ['Restart passes.'],
            priority: 'must',
            labels: ['storage'],
            ownedSurfaces: ['storage'],
            prohibitedSurfaces: [],
            expectedArtifacts: ['storage.spec.ts'],
            ordinal: 1,
          },
        },
      ],
      dependencies: [],
      traces: [
        {
          kind: 'milestone_covers',
          milestone: { kind: 'proposal', key: 'todo' },
          requirement: {
            recordId: requirement.recordId,
            recordRevision: requirement.revision,
          },
        },
        {
          kind: 'task_satisfies',
          task: { kind: 'proposal', key: 'persist' },
          requirement: {
            recordId: requirement.recordId,
            recordRevision: requirement.revision,
          },
        },
      ],
    },
    reservations: {
      milestones: [{ key: 'todo', id: milestoneId }],
      tasks: [{ key: 'persist', id: taskId }],
      dependencies: [],
    },
    diff: {
      milestones: { create: 1, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
      tasks: { create: 1, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
      dependencies: {
        create: 0,
        reuse: 0,
        revise: 0,
        retire: 0,
        reactivate: 0,
      },
      traceCreateCount: 2,
      traceRemoveCount: 0,
    },
    createdByTurnId: pm.id,
    createdByExecutionId: context.fixture.execution.id,
    createdAt: now,
    decision: { kind: 'pending' },
  });
  inImmediateTransaction(context.fixture.database, () => {
    context.repository.insertCycleInTransaction(cycle, {
      planningCycleId: cycle.id,
      purpose: 'delivery_plan',
      baseDeliveryPlanId: null,
      baseDeliveryPlanRevision: null,
    });
    context.repository.insertTurnInTransaction(human);
    context.repository.insertTurnInTransaction(pm);
    context.repository.insertDeliveryPlanProposalInTransaction(proposal);
    context.fixture.database
      .prepare(
        `UPDATE worker_executions
         SET lifecycle = 'completed', revision = revision + 1, ended_at = ?
         WHERE id = ?`,
      )
      .run(now, context.fixture.execution.id);
  });
  return { cycle, proposal, milestoneId, taskId };
};

const approveSeededDeliveryPlan = (
  context: ReturnType<typeof setup>,
  approved: ReturnType<typeof seedApprovedRequirement>,
  seeded: ReturnType<typeof seedDeliveryPlanProposal>,
  idempotencyKey: string,
) =>
  context.service.approvePlanProposal({
    idempotencyKey,
    actor: { kind: 'human' },
    command: {
      type: 'plan_proposal.approve',
      projectId: seeded.cycle.projectId,
      planningCycleId: seeded.cycle.id,
      expectedCycleRevision: seeded.cycle.revision,
      proposalId: seeded.proposal.id,
      expectedProposalRevision: seeded.proposal.revision,
      expectedProjectIntentId: approved.projectIntent.id,
      expectedProjectIntentRevision: approved.projectIntent.revision,
      expectedLedgerId: approved.ledger.id,
      expectedLedgerRevision: approved.ledger.revision,
      expectedDeliveryPlan: seeded.proposal.base.deliveryPlan,
    },
  });

const seedReplacementPlanProposal = (
  context: ReturnType<typeof setup>,
  approved: ReturnType<typeof seedApprovedRequirement>,
  operation: 'reuse' | 'revise',
  expectedCurrentRevision: number,
) => {
  const current = context.repository.approvedDeliveryPlan(
    context.fixture.project.id,
  )!;
  const milestone = current.milestones[0];
  const task = current.taskContracts[0];
  const requirement = approved.records.find(
    ({ content }) => content.type === 'requirement',
  )!;
  const cycle: PlanningCycle = {
    id: randomUUID(),
    projectId: context.fixture.project.id,
    lifecycle: 'awaiting_approval',
    revision: 2,
    profileId: context.fixture.pmProfileRevision.profileId,
    profileRevision: context.fixture.pmProfileRevision.revision,
    baseProjectIntentRevision: approved.projectIntent.revision,
    baseLedgerRevision: approved.ledger.revision,
    latestProposalRevision: 1,
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
    message: 'Replace the Todo plan.',
    launchState: 'execution_bound',
    executionId: context.fixture.execution.id,
    createdAt: now,
  };
  const pm: PlanningTurn = {
    ...human,
    id: randomUUID(),
    ordinal: 2,
    actor: 'pm',
    message: 'Replacement plan ready.',
    launchState: null,
  };
  const taskMember =
    operation === 'reuse'
      ? {
          operation,
          taskId: task.id,
          expectedContractRevision: task.contractRevision,
          expectedCurrentRevision,
        }
      : {
          operation,
          taskId: task.id,
          expectedContractRevision: task.contractRevision,
          expectedCurrentRevision,
          lifecycle: 'pending' as const,
          content: {
            milestone: {
              kind: 'canonical' as const,
              milestoneId: milestone.id,
            },
            title: 'Persist revised tasks',
            outcome: 'Revised tasks survive restart.',
            acceptanceCriteria: ['Revised task persists.'],
            verificationCriteria: ['Revised restart passes.'],
            priority: task.priority,
            labels: task.labels,
            ownedSurfaces: task.ownedSurfaces,
            prohibitedSurfaces: task.prohibitedSurfaces,
            expectedArtifacts: task.expectedArtifacts,
            ordinal: task.ordinal,
          },
        };
  const proposal = deliveryPlanProposalSchema.parse({
    id: randomUUID(),
    projectId: cycle.projectId,
    planningCycleId: cycle.id,
    revision: 1,
    lifecycle: 'awaiting_approval',
    base: {
      projectIntentId: approved.projectIntent.id,
      projectIntentRevision: approved.projectIntent.revision,
      ledgerId: approved.ledger.id,
      ledgerRevision: approved.ledger.revision,
      deliveryPlan: { id: current.plan.id, revision: current.plan.revision },
    },
    proposedPlan: {
      summary: 'Replacement Todo delivery plan.',
      milestones: [
        {
          operation: 'revise',
          milestoneId: milestone.id,
          expectedRevision: milestone.revision,
          lifecycle: milestone.lifecycle,
          content: {
            title: milestone.title,
            outcome: milestone.outcome,
            stopCondition: milestone.stopCondition,
            exclusions: milestone.exclusions,
            ordinal: milestone.ordinal,
          },
        },
      ],
      tasks: [taskMember],
      dependencies: [],
      traces: [
        {
          kind: 'milestone_covers',
          milestone: { kind: 'canonical', milestoneId: milestone.id },
          requirement: {
            recordId: requirement.recordId,
            recordRevision: requirement.revision,
          },
        },
        {
          kind: 'task_satisfies',
          task: { kind: 'canonical', taskId: task.id },
          requirement: {
            recordId: requirement.recordId,
            recordRevision: requirement.revision,
          },
        },
      ],
    },
    reservations: { milestones: [], tasks: [], dependencies: [] },
    diff: {
      milestones: { create: 0, reuse: 0, revise: 1, retire: 0, reactivate: 0 },
      tasks: {
        create: 0,
        reuse: operation === 'reuse' ? 1 : 0,
        revise: operation === 'revise' ? 1 : 0,
        retire: 0,
        reactivate: 0,
      },
      dependencies: {
        create: 0,
        reuse: 0,
        revise: 0,
        retire: 0,
        reactivate: 0,
      },
      traceCreateCount: 2,
      traceRemoveCount: 2,
    },
    createdByTurnId: pm.id,
    createdByExecutionId: context.fixture.execution.id,
    createdAt: now,
    decision: { kind: 'pending' },
  });
  inImmediateTransaction(context.fixture.database, () => {
    context.repository.insertCycleInTransaction(cycle, {
      planningCycleId: cycle.id,
      purpose: 'delivery_plan',
      baseDeliveryPlanId: current.plan.id,
      baseDeliveryPlanRevision: current.plan.revision,
    });
    context.repository.insertTurnInTransaction(human);
    context.repository.insertTurnInTransaction(pm);
    context.repository.insertDeliveryPlanProposalInTransaction(proposal);
  });
  return { cycle, proposal };
};

describe('PlanningService', () => {
  it('stores a typed no-write failure when Board filter state is absent', () => {
    const context = setup();
    const beforeCursor = context.fixture.events.cursors(
      context.fixture.project.id,
    ).domain;

    const result = context.service.setBoardFilter({
      idempotencyKey: 'filter-without-board',
      actor: { kind: 'human' },
      command: {
        type: 'board_filter.set',
        projectId: context.fixture.project.id,
        expectedFilterRevision: 1,
        filter: {
          milestoneIds: [],
          requirementRecordIds: [],
          priorities: [],
          labels: [],
          readiness: [],
          taskLifecycles: ['pending'],
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      commandType: 'board_filter.set',
      error: {
        code: 'board_filter_not_found',
        message: 'Board filter state was not found',
      },
    });
    expect(
      context.repository.boardFilter(context.fixture.project.id),
    ).toBeUndefined();
    expect(
      context.fixture.events.cursors(context.fixture.project.id).domain,
    ).toBe(beforeCursor);
    expect(context.publish).not.toHaveBeenCalled();
    expect(
      context.fixture.commands.find('filter-without-board')?.result,
    ).toEqual(result);
    expect(() => context.barrier.assertHealthy()).not.toThrow();
  });

  it('stores only one idempotent failure receipt for an empty current requirement ledger', async () => {
    const context = setup();
    const approved = seedApprovedRequirement(context);
    const requirement = approved.records.find(
      ({ content }) => content.type === 'requirement',
    )!;
    context.fixture.database
      .prepare(
        'UPDATE ledger_record_revisions SET content_json = ? WHERE record_id = ?',
      )
      .run(
        JSON.stringify({ ...requirement.content, status: 'retired' }),
        requirement.recordId,
      );
    const beforeCursor = context.fixture.events.cursors(
      context.fixture.project.id,
    ).domain;
    const input = {
      idempotencyKey: 'plan-without-current-requirement',
      actor: { kind: 'human' as const },
      command: {
        type: 'planning_cycle.submit_plan_turn' as const,
        projectId: context.fixture.project.id,
        expectedCycleRevision: null,
        profileId: context.fixture.pmProfileRevision.profileId,
        profileRevision: context.fixture.pmProfileRevision.revision,
        expectedProjectIntentId: approved.projectIntent.id,
        expectedProjectIntentRevision: approved.projectIntent.revision,
        expectedLedgerId: approved.ledger.id,
        expectedLedgerRevision: approved.ledger.revision,
        expectedDeliveryPlan: { id: null, revision: null } as const,
        message: 'Plan Todo delivery.',
      },
    };

    const first = await context.service.submitPlanTurn(input);
    const replay = await context.service.submitPlanTurn(input);

    expect(first).toEqual({
      ok: false,
      commandType: 'planning_cycle.submit_plan_turn',
      error: {
        code: 'planning_requirements_required',
        message:
          'At least one approved current requirement is required for delivery planning.',
      },
    });
    expect(replay).toEqual(first);
    expect(
      context.repository.activeCycle(context.fixture.project.id),
    ).toBeUndefined();
    expect(
      context.fixture.events.cursors(context.fixture.project.id).domain,
    ).toBe(beforeCursor);
    expect(context.publish).not.toHaveBeenCalled();
    expect(context.launcher.inputs).toEqual([]);
    expect(
      context.fixture.database
        .prepare(
          'SELECT COUNT(*) AS count FROM command_results WHERE idempotency_key = ?',
        )
        .get(input.idempotencyKey),
    ).toEqual({ count: 1 });
    expect(() => context.barrier.assertHealthy()).not.toThrow();
  });

  it('stores only a failure receipt when delivery planning has no approved intent', async () => {
    const context = setup();
    const beforeCursor = context.fixture.events.cursors(
      context.fixture.project.id,
    ).domain;
    const result = await context.service.submitPlanTurn({
      idempotencyKey: 'plan-without-intent',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.submit_plan_turn',
        projectId: context.fixture.project.id,
        expectedCycleRevision: null,
        profileId: context.fixture.pmProfileRevision.profileId,
        profileRevision: context.fixture.pmProfileRevision.revision,
        expectedProjectIntentId: randomUUID(),
        expectedProjectIntentRevision: 1,
        expectedLedgerId: randomUUID(),
        expectedLedgerRevision: 1,
        expectedDeliveryPlan: { id: null, revision: null },
        message: 'Plan Todo delivery.',
      },
    });

    expect(result).toEqual({
      ok: false,
      commandType: 'planning_cycle.submit_plan_turn',
      error: {
        code: 'planning_intent_required',
        message: 'Approved intent is required before delivery planning',
      },
    });
    expect(
      context.repository.activeCycle(context.fixture.project.id),
    ).toBeUndefined();
    expect(
      context.fixture.events.cursors(context.fixture.project.id).domain,
    ).toBe(beforeCursor);
    expect(
      context.fixture.commands.find('plan-without-intent')?.result,
    ).toEqual(result);
  });

  it('atomically approves a plan proposal into canonical Board state', () => {
    const context = setup();
    const approved = seedApprovedRequirement(context);
    const { cycle, proposal, taskId } = seedDeliveryPlanProposal(
      context,
      approved,
    );

    const result = context.service.approvePlanProposal({
      idempotencyKey: 'approve-plan',
      actor: { kind: 'human' },
      command: {
        type: 'plan_proposal.approve',
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        proposalId: proposal.id,
        expectedProposalRevision: proposal.revision,
        expectedProjectIntentId: approved.projectIntent.id,
        expectedProjectIntentRevision: approved.projectIntent.revision,
        expectedLedgerId: approved.ledger.id,
        expectedLedgerRevision: approved.ledger.revision,
        expectedDeliveryPlan: { id: null, revision: null },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      schemaVersion: 2,
      commandType: 'plan_proposal.approve',
      planningCycle: { cycle: { lifecycle: 'approved' } },
      deliveryPlan: { plan: { revision: 1, proposalId: proposal.id } },
      board: {
        cards: [{ taskId, readiness: { state: 'actionable', blockers: [] } }],
      },
    });
    expect(
      context.repository.deliveryPlanProposal(proposal.id)?.decision,
    ).toMatchObject({
      kind: 'approved',
    });
  });

  it.each(['reuse', 'revise'] as const)(
    'rejects a %s proposal whose current task revision is stale without mutation',
    (operation) => {
      const context = setup();
      const approved = seedApprovedRequirement(context);
      const initial = seedDeliveryPlanProposal(context, approved);
      expect(
        approveSeededDeliveryPlan(
          context,
          approved,
          initial,
          `approve-initial-${operation}`,
        ),
      ).toMatchObject({ ok: true });
      const plan = context.repository.approvedDeliveryPlan(
        context.fixture.project.id,
      )!;
      inImmediateTransaction(context.fixture.database, () => {
        context.repository.appendTaskLifecycleRevisionInTransaction({
          projectId: context.fixture.project.id,
          expectedDeliveryPlanRevision: 1,
          taskId: initial.taskId,
          expectedContractRevision: 1,
          expectedCurrentRevision: 1,
          lifecycle: 'completed',
          createdAt: now,
        });
      });
      const replacement = seedReplacementPlanProposal(
        context,
        approved,
        operation,
        1,
      );
      const beforeCursor = context.fixture.events.cursors(
        context.fixture.project.id,
      ).domain;
      context.publish.mockClear();

      const result = approveSeededDeliveryPlan(
        context,
        approved,
        replacement,
        `approve-stale-${operation}`,
      );

      expect(result).toMatchObject({
        ok: false,
        commandType: 'plan_proposal.approve',
        error: { code: 'plan_canonical_base_conflict' },
      });
      expect(
        context.repository.approvedDeliveryPlan(context.fixture.project.id),
      ).toEqual(plan);
      expect(
        context.repository.deliveryPlanProposal(replacement.proposal.id),
      ).toEqual(replacement.proposal);
      expect(context.repository.cycle(replacement.cycle.id)).toEqual(
        replacement.cycle,
      );
      expect(
        context.repository
          .currentTaskRevisions(plan)
          .find(({ id }) => id === initial.taskId),
      ).toMatchObject({
        revision: 2,
        contractRevision: 1,
        lifecycle: 'completed',
      });
      expect(
        context.fixture.events.cursors(context.fixture.project.id).domain,
      ).toBe(beforeCursor);
      expect(context.publish).not.toHaveBeenCalled();
      expect(
        context.fixture.commands.find(`approve-stale-${operation}`)?.result,
      ).toEqual(result);
      expect(() => context.barrier.assertHealthy()).not.toThrow();
    },
  );

  it('accepts a correctly guarded task revision while preserving revision one', () => {
    const context = setup();
    const approved = seedApprovedRequirement(context);
    const initial = seedDeliveryPlanProposal(context, approved);
    expect(
      approveSeededDeliveryPlan(
        context,
        approved,
        initial,
        'approve-initial-correct-guard',
      ),
    ).toMatchObject({ ok: true });
    const revisionOne = structuredClone(
      context.repository.approvedDeliveryPlan(context.fixture.project.id)!,
    );
    const persistedRevisionOne = context.fixture.database
      .prepare(
        `SELECT plan_json FROM delivery_plan_revisions
         WHERE delivery_plan_id = ? AND project_id = ? AND revision = 1`,
      )
      .get(revisionOne.plan.id, context.fixture.project.id) as {
      plan_json: string;
    };
    const persistedTaskRevisionOne = context.fixture.database
      .prepare(
        `SELECT revision_json FROM task_revisions
         WHERE task_id = ? AND project_id = ? AND revision = 1`,
      )
      .get(initial.taskId, context.fixture.project.id) as {
      revision_json: string;
    };
    expect(persistedRevisionOne).toEqual({ plan_json: expect.any(String) });
    expect(persistedTaskRevisionOne).toEqual({
      revision_json: expect.any(String),
    });
    inImmediateTransaction(context.fixture.database, () => {
      context.repository.appendTaskLifecycleRevisionInTransaction({
        projectId: context.fixture.project.id,
        expectedDeliveryPlanRevision: 1,
        taskId: initial.taskId,
        expectedContractRevision: 1,
        expectedCurrentRevision: 1,
        lifecycle: 'completed',
        createdAt: now,
      });
    });
    const replacement = seedReplacementPlanProposal(
      context,
      approved,
      'revise',
      2,
    );

    const result = approveSeededDeliveryPlan(
      context,
      approved,
      replacement,
      'approve-correctly-guarded-replacement',
    );

    expect(result).toMatchObject({
      ok: true,
      schemaVersion: 2,
      deliveryPlan: {
        plan: {
          id: revisionOne.plan.id,
          revision: 2,
          baseDeliveryPlanRevision: 1,
        },
        taskContracts: [
          {
            id: initial.taskId,
            revision: 3,
            contractRevision: 3,
            title: 'Persist revised tasks',
          },
        ],
      },
    });
    expect(
      context.repository.deliveryPlanProposal(initial.proposal.id)?.decision,
    ).toMatchObject({ kind: 'approved' });
    expect(revisionOne).toMatchObject({
      plan: { revision: 1, proposalId: initial.proposal.id },
      taskContracts: [{ id: initial.taskId, revision: 1, contractRevision: 1 }],
    });
    expect(
      context.repository.currentTaskRevisions(
        context.repository.approvedDeliveryPlan(context.fixture.project.id)!,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: initial.taskId,
          revision: 3,
          contractRevision: 3,
        }),
      ]),
    );
    expect(
      context.fixture.database
        .prepare(
          `SELECT plan_json FROM delivery_plan_revisions
           WHERE delivery_plan_id = ? AND project_id = ? AND revision = 1`,
        )
        .get(revisionOne.plan.id, context.fixture.project.id),
    ).toEqual(persistedRevisionOne);
    expect(
      context.fixture.database
        .prepare(
          `SELECT revision_json FROM task_revisions
           WHERE task_id = ? AND project_id = ? AND revision = 1`,
        )
        .get(initial.taskId, context.fixture.project.id),
    ).toEqual(persistedTaskRevisionOne);
  });

  it('rolls back every approval write seam and trips the audit barrier', () => {
    for (const seam of [
      'materialization',
      'board_projection',
      'event_append',
      'command_result',
    ] as const) {
      const context = setup();
      const approved = seedApprovedRequirement(context);
      const seeded = seedDeliveryPlanProposal(context, approved);
      const failure = new Error(`forced ${seam} failure`);
      if (seam === 'materialization') {
        const original =
          context.repository.applyApprovedDeliveryPlanInTransaction.bind(
            context.repository,
          );
        vi.spyOn(
          context.repository,
          'applyApprovedDeliveryPlanInTransaction',
        ).mockImplementation((proposal, plan) => {
          original(proposal, plan);
          throw failure;
        });
      } else if (seam === 'board_projection') {
        vi.spyOn(context.repository, 'currentTaskRevisions').mockImplementation(
          () => {
            throw failure;
          },
        );
      } else if (seam === 'event_append') {
        const original = context.fixture.events.appendDomainInTransaction.bind(
          context.fixture.events,
        );
        vi.spyOn(
          context.fixture.events,
          'appendDomainInTransaction',
        ).mockImplementation((projectId, event) => {
          original(projectId, event);
          throw failure;
        });
      } else {
        const original = context.fixture.commands.storeInTransaction.bind(
          context.fixture.commands,
        );
        vi.spyOn(
          context.fixture.commands,
          'storeInTransaction',
        ).mockImplementation((receipt) => {
          original(receipt);
          throw failure;
        });
      }
      const beforeCursor = context.fixture.events.cursors(
        context.fixture.project.id,
      ).domain;

      expect(() =>
        approveSeededDeliveryPlan(
          context,
          approved,
          seeded,
          `approve-forced-${seam}`,
        ),
      ).toThrow(failure);

      expect(
        context.repository.approvedDeliveryPlan(context.fixture.project.id),
      ).toBeUndefined();
      expect(
        context.repository.deliveryPlanProposal(seeded.proposal.id),
      ).toEqual(seeded.proposal);
      expect(context.repository.cycle(seeded.cycle.id)).toEqual(seeded.cycle);
      expect(
        context.fixture.events.cursors(context.fixture.project.id).domain,
      ).toBe(beforeCursor);
      expect(
        context.fixture.commands.find(`approve-forced-${seam}`),
      ).toBeUndefined();
      expect(context.publish).not.toHaveBeenCalled();
      expect(() => context.barrier.assertHealthy()).toThrow(
        'Audit barrier is tripped',
      );
    }
  });

  it('rejects a plan proposal without materializing canonical work', () => {
    const context = setup();
    const approved = seedApprovedRequirement(context);
    const { cycle, proposal } = seedDeliveryPlanProposal(context, approved);

    const result = context.service.rejectPlanProposal({
      idempotencyKey: 'reject-plan',
      actor: { kind: 'human' },
      command: {
        type: 'plan_proposal.reject',
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        proposalId: proposal.id,
        expectedProposalRevision: proposal.revision,
        feedback: 'Split the milestone.',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      schemaVersion: 2,
      commandType: 'plan_proposal.reject',
      planningCycle: { cycle: { lifecycle: 'proposal_rejected' } },
    });
    expect(
      context.repository.approvedDeliveryPlan(cycle.projectId),
    ).toBeUndefined();
    expect(
      context.repository.deliveryPlanProposal(proposal.id)?.decision,
    ).toMatchObject({
      kind: 'rejected',
      feedback: 'Split the milestone.',
    });
  });

  it('persists a revision-guarded Board filter and reprojects the Board', () => {
    const context = setup();
    const approved = seedApprovedRequirement(context);
    const { cycle, proposal } = seedDeliveryPlanProposal(context, approved);
    context.service.approvePlanProposal({
      idempotencyKey: 'approve-before-filter',
      actor: { kind: 'human' },
      command: {
        type: 'plan_proposal.approve',
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        proposalId: proposal.id,
        expectedProposalRevision: proposal.revision,
        expectedProjectIntentId: approved.projectIntent.id,
        expectedProjectIntentRevision: approved.projectIntent.revision,
        expectedLedgerId: approved.ledger.id,
        expectedLedgerRevision: approved.ledger.revision,
        expectedDeliveryPlan: { id: null, revision: null },
      },
    });

    const result = context.service.setBoardFilter({
      idempotencyKey: 'filter-board',
      actor: { kind: 'human' },
      command: {
        type: 'board_filter.set',
        projectId: cycle.projectId,
        expectedFilterRevision: 1,
        filter: {
          milestoneIds: [],
          requirementRecordIds: [],
          priorities: ['must'],
          labels: ['storage'],
          readiness: ['actionable'],
          taskLifecycles: ['pending'],
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      schemaVersion: 2,
      commandType: 'board_filter.set',
      board: {
        filter: { revision: 2, priorities: ['must'], labels: ['storage'] },
        matchedTaskCount: 1,
      },
    });
    expect(context.repository.boardFilter(cycle.projectId)?.revision).toBe(2);
  });

  it('abandons delivery planning by superseding its pending proposal', async () => {
    const context = setup();
    const approved = seedApprovedRequirement(context);
    const { cycle, proposal } = seedDeliveryPlanProposal(context, approved);

    const result = await context.service.abandonCycle({
      idempotencyKey: 'abandon-plan',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.abandon',
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      schemaVersion: 2,
      commandType: 'planning_cycle.abandon',
      planningCycle: { cycle: { lifecycle: 'abandoned' } },
    });
    expect(
      context.repository.deliveryPlanProposal(proposal.id)?.decision,
    ).toMatchObject({
      kind: 'superseded',
      reason: 'cycle_abandoned',
      supersededByProposalId: null,
    });
  });

  it('starts delivery planning only from the exact approved intent and plan base', async () => {
    const context = setup();
    const approved = seedApprovedRequirement(context);
    const baseProfile = context.fixture.pmProfileRevision;
    const service = new PlanningService({
      database: context.fixture.database,
      repository: context.repository,
      commands: context.fixture.commands,
      events: context.fixture.events,
      executions: context.executions,
      profiles: {
        resolveApproved: () => ({
          profileId: baseProfile.profileId,
          projectId: null,
          profileRevision: baseProfile.revision,
          baseProfileId: null,
          baseRevision: null,
          document: {
            ...baseProfile.document,
            spec: {
              ...baseProfile.document.spec,
              assignmentKinds: ['pm_plan'],
              outputSchema: PM_PLAN_REPORT_SCHEMA,
            },
          },
          digest: baseProfile.digest,
        }),
      },
      launcher: context.launcher,
      barrier: context.barrier,
      reportConsumer: { consume: vi.fn() },
      now: () => now,
      publishDomain: context.publish,
    });

    const result = await service.submitPlanTurn({
      idempotencyKey: 'plan-first',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.submit_plan_turn',
        projectId: context.fixture.project.id,
        expectedCycleRevision: null,
        profileId: baseProfile.profileId,
        profileRevision: baseProfile.revision,
        expectedProjectIntentId: approved.projectIntent.id,
        expectedProjectIntentRevision: approved.projectIntent.revision,
        expectedLedgerId: approved.ledger.id,
        expectedLedgerRevision: approved.ledger.revision,
        expectedDeliveryPlan: { id: null, revision: null },
        message: 'Plan two Todo milestones.',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      schemaVersion: 2,
      commandType: 'planning_cycle.submit_plan_turn',
      planningCycle: { purpose: { kind: 'delivery_plan' } },
    });
    expect(context.launcher.inputs.at(-1)?.command.assignment).toMatchObject({
      kind: 'pm_plan',
      outputSchema: PM_PLAN_REPORT_SCHEMA,
      input: { approvedIntentLedger: approved, approvedDeliveryPlan: null },
    });
  });
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

  it('replays one success for identical concurrent abandonment envelopes', async () => {
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
    const envelope = {
      idempotencyKey: 'abandon-race-replay',
      actor: { kind: 'human' as const },
      command: {
        type: 'planning_cycle.abandon' as const,
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
      },
    };

    const results = await Promise.all([
      context.service.abandonCycle(envelope),
      context.service.abandonCycle(envelope),
    ]);

    expect(results[0]).toMatchObject({
      ok: true,
      planningCycle: { cycle: { lifecycle: 'abandoned' } },
    });
    expect(results[1]).toEqual(results[0]);
    expect(
      context.fixture.commands.find(
        envelope.idempotencyKey,
        hashV2Command(envelope.command),
      )?.result,
    ).toEqual(results[0]);
    expect(context.fixture.events.cursors(cycle.projectId).domain).toBe(
      beforeCursor + 1,
    );
    expect(context.publish).toHaveBeenCalledTimes(beforePublish + 1);
    expect(() => context.barrier.assertHealthy()).not.toThrow();

    await expect(
      context.service.abandonCycle({
        ...envelope,
        command: {
          ...envelope.command,
          expectedCycleRevision: cycle.revision + 1,
        },
      }),
    ).rejects.toMatchObject({
      name: 'V2IdempotencyConflictError',
      code: 'idempotency_conflict',
    });
  });

  it('keeps concurrent cross-project digest conflict outside audit failure', async () => {
    const context = setup();
    const secondProject = insertV2TestProject(context.fixture.database, {
      id: randomUUID(),
      displayName: 'Notes',
      repositoryIdentity: 'notes-repository',
    });
    const reserve = vi
      .spyOn(context.launcher, 'reserve')
      .mockRejectedValue(new Error('reservation transport stopped'));
    await expect(
      context.service.submitTurn(firstTurn(context.fixture)),
    ).rejects.toThrow('reservation transport stopped');
    await expect(
      context.service.submitTurn({
        idempotencyKey: 'planning-second-project',
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.submit_turn',
          projectId: secondProject.id,
          expectedCycleRevision: null,
          profileId: context.fixture.pmProfileRevision.profileId,
          profileRevision: context.fixture.pmProfileRevision.revision,
          message: 'Build a persistent Notes application.',
        },
      }),
    ).rejects.toThrow('reservation transport stopped');
    const winningCycle = context.repository.activeCycle(
      context.fixture.project.id,
    );
    const losingCycle = context.repository.activeCycle(secondProject.id);
    if (!winningCycle || !losingCycle) {
      throw new Error('Expected both project cycles to be active');
    }
    const beforeWinningCursor = context.fixture.events.cursors(
      winningCycle.projectId,
    ).domain;
    const beforeLosingCursor = context.fixture.events.cursors(
      losingCycle.projectId,
    ).domain;
    const beforePublish = context.publish.mock.calls.length;
    const idempotencyKey = 'abandon-cross-project-race';

    const results = await Promise.allSettled([
      context.service.abandonCycle({
        idempotencyKey,
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.abandon',
          projectId: winningCycle.projectId,
          planningCycleId: winningCycle.id,
          expectedCycleRevision: winningCycle.revision,
        },
      }),
      context.service.abandonCycle({
        idempotencyKey,
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.abandon',
          projectId: losingCycle.projectId,
          planningCycleId: losingCycle.id,
          expectedCycleRevision: losingCycle.revision,
        },
      }),
    ]);

    expect(results[0]).toMatchObject({
      status: 'fulfilled',
      value: {
        ok: true,
        planningCycle: { cycle: { lifecycle: 'abandoned' } },
      },
    });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.any(V2IdempotencyConflictError),
    });
    if (results[0].status !== 'fulfilled') {
      throw new Error('Expected first abandonment to win');
    }
    expect(context.fixture.commands.find(idempotencyKey)?.result).toEqual(
      results[0].value,
    );
    expect(
      context.fixture.database
        .prepare(
          'SELECT COUNT(*) AS count FROM command_results WHERE idempotency_key = ?',
        )
        .get(idempotencyKey),
    ).toEqual({ count: 1 });
    expect(context.fixture.events.cursors(winningCycle.projectId).domain).toBe(
      beforeWinningCursor + 1,
    );
    expect(context.fixture.events.cursors(losingCycle.projectId).domain).toBe(
      beforeLosingCursor,
    );
    expect(context.publish).toHaveBeenCalledTimes(beforePublish + 1);
    expect(context.repository.cycle(losingCycle.id)).toEqual(losingCycle);
    expect(() => context.barrier.assertHealthy()).not.toThrow();

    const losingTurn = context.repository.cycleView(losingCycle.id)?.turns[0];
    if (!losingTurn) throw new Error('Expected losing cycle turn');
    expect(context.repository.pendingLaunchTurns().map(({ id }) => id)).toEqual(
      [losingTurn.id],
    );
    reserve.mockRestore();
    context.launcher.trace.splice(0);

    await context.service.drainPendingLaunches();

    const drained = context.repository.cycleView(losingCycle.id);
    const executionId = drained?.turns[0]?.executionId;
    if (!drained || !executionId) {
      throw new Error('Expected losing cycle launch to bind');
    }
    expect(drained.cycle).toMatchObject({
      lifecycle: 'execution_active',
      activeExecutionId: executionId,
    });
    expect(drained.turns[0]).toMatchObject({
      launchState: 'execution_bound',
      executionId,
    });
    expect(context.executions.get(executionId)?.lifecycle).toBe('running');
    expect(context.launcher.trace).toEqual(['reserve', 'activate']);
    expect(context.repository.cycle(winningCycle.id)).toMatchObject({
      lifecycle: 'abandoned',
      revision: winningCycle.revision + 1,
    });
    expect(
      context.repository.cycleView(winningCycle.id)?.turns[0],
    ).toMatchObject({
      launchState: 'launch_pending',
      executionId: null,
    });
    expect(context.fixture.events.cursors(losingCycle.projectId).domain).toBe(
      beforeLosingCursor + 1,
    );
    expect(context.publish).toHaveBeenCalledTimes(beforePublish + 2);

    context.fixture.database.exec(`
      CREATE TRIGGER fail_planning_cycle_audit_write
      BEFORE UPDATE ON planning_cycles
      BEGIN
        SELECT RAISE(ABORT, 'forced planning audit failure');
      END
    `);
    await expect(
      context.service.abandonCycle({
        idempotencyKey: 'abandon-real-audit-failure',
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.abandon',
          projectId: drained.cycle.projectId,
          planningCycleId: drained.cycle.id,
          expectedCycleRevision: drained.cycle.revision,
        },
      }),
    ).rejects.toThrow('forced planning audit failure');
    expect(() => context.barrier.assertHealthy()).toThrow(
      'Audit barrier is tripped',
    );
  });

  it('does not clear another active abandonment cancellation owner', async () => {
    const context = setup();
    let releaseReservation!: () => void;
    context.launcher.reserveBarrier = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const submit = context.service.submitTurn(firstTurn(context.fixture));
    while (!context.launcher.trace.includes('reserve')) await Promise.resolve();
    const cycle = context.repository.activeCycle(context.fixture.project.id);
    const turn = cycle
      ? context.repository.cycleView(cycle.id)?.turns[0]
      : undefined;
    if (!cycle || !turn) throw new Error('Expected pending planning launch');

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
      launcher: context.launcher,
      barrier: context.barrier,
      reportConsumer: { consume: vi.fn() },
      now: () => now,
      publishDomain: context.publish,
    });
    const cancelReserved = context.launcher.cancelReserved.bind(
      context.launcher,
    );
    let releaseCleanup!: () => void;
    const cleanupBarrier = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cancel = vi
      .spyOn(context.launcher, 'cancelReserved')
      .mockImplementationOnce(async (executionId) => {
        await cleanupBarrier;
        return cancelReserved(executionId);
      })
      .mockRejectedValueOnce(new Error('competing cleanup failed'));
    const command = {
      type: 'planning_cycle.abandon' as const,
      projectId: cycle.projectId,
      planningCycleId: cycle.id,
      expectedCycleRevision: cycle.revision,
    };

    const winning = restarted.abandonCycle({
      idempotencyKey: 'abandon-owner-active',
      actor: { kind: 'human' },
      command,
    });
    while (cancel.mock.calls.length === 0) await Promise.resolve();
    const losing = restarted.abandonCycle({
      idempotencyKey: 'abandon-owner-fails',
      actor: { kind: 'human' },
      command,
    });
    await expect(losing).rejects.toThrow('competing cleanup failed');
    expect(() => context.barrier.assertHealthy()).not.toThrow();

    await restarted.drainPendingLaunches();

    expect(context.repository.cycle(cycle.id)).toEqual(cycle);
    expect(context.repository.turn(turn.id)).toMatchObject({
      launchState: 'launch_pending',
      executionId: null,
    });
    expect(cancel).toHaveBeenCalledTimes(2);

    releaseCleanup();
    await expect(winning).resolves.toMatchObject({
      ok: true,
      planningCycle: { cycle: { lifecycle: 'abandoned' } },
    });
    await restarted.drainPendingLaunches();
    expect(context.repository.cycle(cycle.id)).toMatchObject({
      lifecycle: 'abandoned',
      revision: cycle.revision + 1,
    });
    expect(context.repository.turn(turn.id)).toMatchObject({
      launchState: 'launch_pending',
      executionId: null,
    });
    expect(cancel).toHaveBeenCalledTimes(2);

    releaseReservation();
    await submit;
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
