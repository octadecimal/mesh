import { randomUUID } from 'node:crypto';

import {
  PM_DISCOVERY_REPORT_SCHEMA,
  type PmDiscoveryAssignment,
  type WorkerExecutionStructuredOutputRuntimeEvent,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { inImmediateTransaction } from '../db/database.js';
import { AuditBarrier } from '../executions/audit-barrier.js';
import { ExecutionRepository } from '../executions/execution-repository.js';
import { OperationRepository } from '../executions/operation-repository.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { PlanningRepository } from './planning-repository.js';
import { PlanningService } from './planning-service.js';
import { PmReportConsumer } from './pm-report-consumer.js';

const fixtures: ReturnType<typeof createV2TestDatabase>[] = [];
const now = '2026-08-29T00:00:00.000Z';

const setup = async () => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  const repository = new PlanningRepository(fixture.database);
  const executions = new ExecutionRepository(fixture.database);
  const operations = new OperationRepository(fixture.database);
  let reserved: ReturnType<ExecutionRepository['get']>;
  const launcher = {
    findReserved: vi.fn(() => undefined),
    reserve: vi.fn(async (input) => {
      const assignment = input.command.assignment as PmDiscoveryAssignment;
      const execution = {
        ...fixture.execution,
        id: randomUUID(),
        projectId: fixture.project.id,
        profileId: fixture.pmProfileRevision.profileId,
        profileRevision: fixture.pmProfileRevision.revision,
        assignment,
        profileSnapshot: {
          profileId: fixture.pmProfileRevision.profileId,
          projectId: null,
          profileRevision: fixture.pmProfileRevision.revision,
          baseProfileId: null,
          baseRevision: null,
          document: fixture.pmProfileRevision.document,
          digest: fixture.pmProfileRevision.digest,
        },
        lifecycle: 'starting' as const,
        revision: 0,
        nativeHandle: null,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      };
      inImmediateTransaction(fixture.database, () => {
        executions.insertInTransaction(execution);
        operations.createPendingInTransaction({
          executionId: execution.id,
          kind: 'start',
          request: {
            idempotencyKey: input.idempotencyKey,
            requestHash: 'a'.repeat(64),
          },
          createdAt: now,
        });
      });
      reserved = execution;
      return {
        execution,
        result: {
          ok: true as const,
          commandType: 'worker_execution.start' as const,
          execution,
        },
        activationRequired: true,
      };
    }),
    activate: vi.fn(async (executionId: string) => {
      const execution = executions.get(executionId)!;
      inImmediateTransaction(fixture.database, () => {
        executions.transitionInTransaction(
          execution.id,
          execution.revision,
          'running',
          now,
          { nativeHandle: `fake:${execution.id}` },
        );
      });
      reserved = executions.get(executionId);
    }),
    cancelReserved: vi.fn(async () => reserved!),
    interruptForPlanning: vi.fn(async () => undefined),
  };
  const publish = vi.fn();
  const consumerBarrier = new AuditBarrier();
  const consumer = new PmReportConsumer({
    database: fixture.database,
    repository,
    events: fixture.events,
    barrier: consumerBarrier,
    publishDomain: publish,
  });
  const serviceBarrier = new AuditBarrier();
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
    barrier: serviceBarrier,
    reportConsumer: consumer,
    now: () => now,
    publishDomain: vi.fn(),
  });
  await service.submitTurn({
    idempotencyKey: 'first',
    actor: { kind: 'human' },
    command: {
      type: 'planning_cycle.submit_turn',
      projectId: fixture.project.id,
      expectedCycleRevision: null,
      profileId: fixture.pmProfileRevision.profileId,
      profileRevision: fixture.pmProfileRevision.revision,
      message: 'Build a Todo application.',
    },
  });
  const execution = reserved!;
  return {
    fixture,
    repository,
    executions,
    launcher,
    execution,
    latestExecution: () => reserved!,
    consumer,
    consumerBarrier,
    publish,
    service,
    serviceBarrier,
  };
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const runtimeEvent = (
  context: Awaited<ReturnType<typeof setup>>,
  value: unknown,
) => runtimeEventFor(context, context.execution, value);

const runtimeEventFor = (
  context: Awaited<ReturnType<typeof setup>>,
  execution: NonNullable<ReturnType<ExecutionRepository['get']>>,
  value: unknown,
) =>
  inImmediateTransaction(context.fixture.database, () =>
    context.fixture.events.appendRuntimeWithDiagnosticInTransaction(
      context.fixture.project.id,
      {
        projectId: context.fixture.project.id,
        executionId: execution.id,
        adapterId: 'fake',
        adapterCursor: execution.lastAdapterCursor + 1,
        receivedAt: now,
        payload: { value },
      },
      {
        projectId: context.fixture.project.id,
        executionId: execution.id,
        adapterCursor: execution.lastAdapterCursor + 1,
        occurredAt: now,
        type: 'worker_execution.structured_output',
        payload: { schema: PM_DISCOVERY_REPORT_SCHEMA, value },
      },
    ),
  ) as WorkerExecutionStructuredOutputRuntimeEvent;

const reportBase = (context: Awaited<ReturnType<typeof setup>>) => {
  const assignment = context.execution.assignment as PmDiscoveryAssignment;
  return {
    schema: PM_DISCOVERY_REPORT_SCHEMA,
    planningCycleId: assignment.planningCycleId,
    humanTurnId: assignment.humanTurnId,
    expectedCycleRevision: assignment.expectedCycleRevision,
    expectedProposalRevision: assignment.expectedProposalRevision,
    assistantMessage: 'I need two clarifications.',
  };
};

const proposalReport = (context: Awaited<ReturnType<typeof setup>>) => {
  const assignment = context.execution.assignment as PmDiscoveryAssignment;
  return {
    ...reportBase(context),
    assistantMessage: 'Here is the complete Todo intent.',
    result: {
      kind: 'proposal' as const,
      summary: 'Todo product intent',
      projectIntent: {
        goal: 'Ship Todo.',
        targetUsers: ['People'],
        desiredCapabilities: ['Add and complete items'],
        constraints: [],
        nonGoals: [],
        successConditions: ['Items persist'],
        rationale: 'Requested by the operator.',
        provenance: [
          {
            kind: 'conversation_turn' as const,
            turnId: assignment.humanTurnId,
            rationale: 'Initial request.',
          },
        ],
      },
      records: [
        {
          operation: 'create' as const,
          key: 'add-items',
          content: {
            type: 'requirement' as const,
            kind: 'functional' as const,
            status: 'proposed' as const,
            priority: 'must' as const,
            statement: 'Users can add Todo items.',
            rationale: 'Core workflow.',
          },
          provenance: [
            {
              kind: 'conversation_turn' as const,
              turnId: assignment.humanTurnId,
              rationale: 'Initial request.',
            },
          ],
        },
      ],
      relationships: [],
    },
  };
};

describe('PmReportConsumer', () => {
  it('persists an accepted question receipt, PM turn, questions, and complete event atomically', async () => {
    const context = await setup();
    const report = {
      ...reportBase(context),
      result: {
        kind: 'questions' as const,
        questions: [
          {
            key: 'storage',
            prompt: 'Should items persist?',
            rationale: 'Storage materially changes the product.',
          },
        ],
      },
    };
    const event = runtimeEvent(context, report);

    context.consumer.consume(context.execution, event);

    const receipt = context.repository.receipt(context.execution.id);
    expect(receipt).toMatchObject({
      status: 'accepted',
      rejectionReason: null,
    });
    const view = context.repository.cycleView(report.planningCycleId)!;
    expect(view.cycle.lifecycle).toBe('awaiting_human');
    expect(view.turns.map(({ actor }) => actor)).toEqual(['human', 'pm']);
    expect(view.questions).toHaveLength(1);
    expect(context.publish).toHaveBeenCalledTimes(1);
    context.consumer.consume(context.execution, event);
    expect(context.publish).toHaveBeenCalledTimes(1);
  });

  it('rejects a question key already present in the cycle without tripping the audit barrier', async () => {
    const context = await setup();
    const firstReport = {
      ...reportBase(context),
      result: {
        kind: 'questions' as const,
        questions: [
          {
            key: 'storage',
            prompt: 'Should items persist?',
            rationale: 'Storage materially changes the product.',
          },
        ],
      },
    };
    context.consumer.consume(
      context.execution,
      runtimeEvent(context, firstReport),
    );
    const cycle = context.repository.cycle(firstReport.planningCycleId)!;
    await context.service.submitTurn({
      idempotencyKey: 'answer-storage',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.submit_turn',
        projectId: context.fixture.project.id,
        planningCycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        message: 'Yes, items must persist.',
      },
    });
    const secondExecution = context.latestExecution();
    const assignment = secondExecution.assignment as PmDiscoveryAssignment;
    const duplicateReport = {
      schema: PM_DISCOVERY_REPORT_SCHEMA,
      planningCycleId: assignment.planningCycleId,
      humanTurnId: assignment.humanTurnId,
      expectedCycleRevision: assignment.expectedCycleRevision,
      expectedProposalRevision: assignment.expectedProposalRevision,
      assistantMessage: 'I will ask that again.',
      result: {
        kind: 'questions' as const,
        questions: [
          {
            key: 'storage',
            prompt: 'Should items persist?',
            rationale: 'This key already exists.',
          },
        ],
      },
    };

    context.consumer.consume(
      secondExecution,
      runtimeEventFor(context, secondExecution, duplicateReport),
    );

    expect(context.repository.receipt(secondExecution.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'duplicate_question_key',
    });
    const view = context.repository.cycleView(cycle.id)!;
    expect(view.cycle.lifecycle).toBe('attention_required');
    expect(view.questions.map(({ key }) => key)).toEqual(['storage']);
    expect(view.turns.filter(({ actor }) => actor === 'pm')).toHaveLength(1);
    expect(context.consumerBarrier.status).toBe('healthy');
  });

  it('re-reads the durable execution assignment inside receipt consumption', async () => {
    const context = await setup();
    const report = {
      ...reportBase(context),
      result: {
        kind: 'questions' as const,
        questions: [
          {
            key: 'durable-assignment',
            prompt: 'Use the durable assignment?',
            rationale: 'The runtime argument is not planning authority.',
          },
        ],
      },
    };
    const event = runtimeEvent(context, report);

    context.consumer.consume(
      {
        ...context.execution,
        assignment: context.fixture.execution.assignment,
      },
      event,
    );

    expect(context.repository.receipt(context.execution.id)).toMatchObject({
      status: 'accepted',
    });
  });

  it('consumes durable structured output before terminal reconciliation', async () => {
    const context = await setup();
    runtimeEvent(context, {
      ...reportBase(context),
      result: {
        kind: 'questions',
        questions: [
          {
            key: 'terminal-report',
            prompt: 'Was the durable report consumed?',
            rationale: 'Terminal reconciliation must consume first.',
          },
        ],
      },
    });
    const running = context.executions.get(context.execution.id)!;
    inImmediateTransaction(context.fixture.database, () => {
      context.executions.transitionInTransaction(
        running.id,
        running.revision,
        'completed',
        now,
      );
    });
    const reconciler = new PlanningService({
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
      barrier: new AuditBarrier(),
      reportConsumer: context.consumer,
      now: () => now,
      publishDomain: vi.fn(),
    });

    reconciler.reconcileBoundCycles();

    expect(context.repository.receipt(context.execution.id)).toMatchObject({
      status: 'accepted',
    });
    expect(
      context.repository.cycle(
        (context.execution.assignment as PmDiscoveryAssignment).planningCycleId,
      )?.lifecycle,
    ).toBe('awaiting_human');
  });

  it('persists a complete proposal with server record reservations but no canonical rows', async () => {
    const context = await setup();
    const assignment = context.execution.assignment as PmDiscoveryAssignment;
    const report = {
      ...reportBase(context),
      assistantMessage: 'Here is the complete Todo intent.',
      result: {
        kind: 'proposal' as const,
        summary: 'Todo product intent',
        projectIntent: {
          goal: 'Ship Todo.',
          targetUsers: ['People'],
          desiredCapabilities: ['Add and complete items'],
          constraints: [],
          nonGoals: [],
          successConditions: ['Items persist'],
          rationale: 'Requested by the operator.',
          provenance: [
            {
              kind: 'conversation_turn' as const,
              turnId: assignment.humanTurnId,
              rationale: 'Initial request.',
            },
          ],
        },
        records: [
          {
            operation: 'create' as const,
            key: 'add-items',
            content: {
              type: 'requirement' as const,
              kind: 'functional' as const,
              status: 'proposed' as const,
              priority: 'must' as const,
              statement: 'Users can add Todo items.',
              rationale: 'Core workflow.',
            },
            provenance: [
              {
                kind: 'conversation_turn' as const,
                turnId: assignment.humanTurnId,
                rationale: 'Initial request.',
              },
            ],
          },
        ],
        relationships: [],
      },
    };
    context.consumer.consume(context.execution, runtimeEvent(context, report));

    const view = context.repository.cycleView(assignment.planningCycleId)!;
    expect(view.cycle.lifecycle).toBe('awaiting_approval');
    expect(view.proposals).toHaveLength(1);
    expect(
      context.repository.proposalRecordReservations(view.proposals[0].id),
    ).toHaveLength(1);
    expect(
      context.fixture.database.prepare('SELECT * FROM ledger_records').all(),
    ).toEqual([]);
  });

  it('rejects duplicate provenance turn IDs before persisting a proposal', async () => {
    const context = await setup();
    const report = proposalReport(context);
    report.result.projectIntent.provenance.push({
      ...report.result.projectIntent.provenance[0],
      rationale: 'The same turn must not be repeated.',
    });

    context.consumer.consume(context.execution, runtimeEvent(context, report));

    expect(context.repository.receipt(context.execution.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'duplicate_provenance_turn',
    });
    expect(
      context.fixture.database
        .prepare('SELECT * FROM planning_proposals')
        .all(),
    ).toEqual([]);
    expect(context.consumerBarrier.status).toBe('healthy');
  });

  it('stores a rejected receipt and attention event for malformed or wrongly bound output', async () => {
    const context = await setup();
    const event = runtimeEvent(context, {
      ...reportBase(context),
      planningCycleId: randomUUID(),
      result: { kind: 'questions', questions: [] },
    });

    context.consumer.consume(context.execution, event);

    expect(context.repository.receipt(context.execution.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: expect.any(String),
    });
    expect(
      context.repository.cycle(
        (context.execution.assignment as PmDiscoveryAssignment).planningCycleId,
      )?.lifecycle,
    ).toBe('attention_required');
    expect(
      context.fixture.database
        .prepare('SELECT * FROM planning_proposals')
        .all(),
    ).toEqual([]);
    expect(
      context.fixture.database
        .prepare("SELECT * FROM planning_turns WHERE actor = 'pm'")
        .all(),
    ).toEqual([]);
  });

  it('rolls the rejected receipt and attention transition back when its event append fails', async () => {
    const context = await setup();
    const assignment = context.execution.assignment as PmDiscoveryAssignment;
    const event = runtimeEvent(context, {
      ...reportBase(context),
      planningCycleId: randomUUID(),
      result: { kind: 'questions', questions: [] },
    });
    vi.spyOn(
      context.fixture.events,
      'appendDomainInTransaction',
    ).mockImplementationOnce(() => {
      throw new Error('injected rejected-event failure');
    });

    expect(() => context.consumer.consume(context.execution, event)).toThrow(
      'injected rejected-event failure',
    );

    expect(context.repository.receipt(context.execution.id)).toBeUndefined();
    expect(context.repository.cycle(assignment.planningCycleId)).toMatchObject({
      lifecycle: 'execution_active',
      activeExecutionId: context.execution.id,
    });
    expect(context.publish).not.toHaveBeenCalled();
  });

  it('rejects the exact awaiting proposal without creating canonical intent', async () => {
    const context = await setup();
    const assignment = context.execution.assignment as PmDiscoveryAssignment;
    context.consumer.consume(
      context.execution,
      runtimeEvent(context, proposalReport(context)),
    );
    const cycle = context.repository.cycleView(assignment.planningCycleId)!;
    const proposal = cycle.proposals[0];

    const result = context.service.rejectProposal({
      idempotencyKey: 'reject-proposal',
      actor: { kind: 'human' },
      command: {
        type: 'planning_proposal.reject',
        projectId: context.fixture.project.id,
        planningCycleId: cycle.cycle.id,
        proposalId: proposal.id,
        expectedCycleRevision: cycle.cycle.revision,
        expectedProposalRevision: proposal.revision,
        feedback: 'The persistence requirement needs more detail.',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      commandType: 'planning_proposal.reject',
      planningCycle: {
        cycle: { lifecycle: 'proposal_rejected' },
        proposals: [
          {
            lifecycle: 'rejected',
            rejectionFeedback: 'The persistence requirement needs more detail.',
          },
        ],
      },
    });
    expect(
      context.repository.approvedIntentLedger(context.fixture.project.id),
    ).toBeUndefined();
  });

  it('approves the exact proposal atomically and rejects stale repeat authority', async () => {
    const context = await setup();
    const assignment = context.execution.assignment as PmDiscoveryAssignment;
    const report = {
      ...reportBase(context),
      assistantMessage: 'Approve this complete proposal.',
      result: {
        kind: 'proposal' as const,
        summary: 'Todo intent',
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
              kind: 'conversation_turn' as const,
              turnId: assignment.humanTurnId,
              rationale: 'Request.',
            },
          ],
        },
        records: [
          {
            operation: 'create' as const,
            key: 'add',
            content: {
              type: 'requirement' as const,
              kind: 'functional' as const,
              status: 'proposed' as const,
              priority: 'must' as const,
              statement: 'Users add items.',
              rationale: 'Core.',
            },
            provenance: [
              {
                kind: 'conversation_turn' as const,
                turnId: assignment.humanTurnId,
                rationale: 'Request.',
              },
            ],
          },
        ],
        relationships: [],
      },
    };
    context.consumer.consume(context.execution, runtimeEvent(context, report));
    const cycle = context.repository.cycleView(assignment.planningCycleId)!;
    const proposal = cycle.proposals[0];
    const originalApply =
      context.repository.applyApprovedProposalInTransaction.bind(
        context.repository,
      );
    const apply = vi.spyOn(
      context.repository,
      'applyApprovedProposalInTransaction',
    );
    apply.mockImplementationOnce((...args) => {
      originalApply(...args);
      throw new Error('injected canonical persistence failure');
    });
    expect(() =>
      context.service.approveProposal({
        idempotencyKey: 'approve-failure',
        actor: { kind: 'human' },
        command: {
          type: 'planning_proposal.approve',
          projectId: context.fixture.project.id,
          planningCycleId: cycle.cycle.id,
          proposalId: proposal.id,
          expectedCycleRevision: cycle.cycle.revision,
          expectedProposalRevision: proposal.revision,
          expectedProjectIntentRevision: null,
          expectedLedgerRevision: null,
        },
      }),
    ).toThrow('injected canonical persistence failure');
    apply.mockRestore();
    expect(
      context.repository.approvedIntentLedger(context.fixture.project.id),
    ).toBeUndefined();
    expect(context.repository.cycle(cycle.cycle.id)?.lifecycle).toBe(
      'awaiting_approval',
    );
    expect(context.fixture.commands.find('approve-failure')).toBeUndefined();
    const recoveredService = new PlanningService({
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
      barrier: new AuditBarrier(),
      reportConsumer: context.consumer,
      now: () => now,
      publishDomain: vi.fn(),
    });
    const result = recoveredService.approveProposal({
      idempotencyKey: 'approve',
      actor: { kind: 'human' },
      command: {
        type: 'planning_proposal.approve',
        projectId: context.fixture.project.id,
        planningCycleId: cycle.cycle.id,
        proposalId: proposal.id,
        expectedCycleRevision: cycle.cycle.revision,
        expectedProposalRevision: proposal.revision,
        expectedProjectIntentRevision: null,
        expectedLedgerRevision: null,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      commandType: 'planning_proposal.approve',
    });
    expect(
      context.repository.approvedIntentLedger(context.fixture.project.id)
        ?.records,
    ).toHaveLength(1);
    const stale = recoveredService.approveProposal({
      idempotencyKey: 'approve-stale',
      actor: { kind: 'human' },
      command: {
        type: 'planning_proposal.approve',
        projectId: context.fixture.project.id,
        planningCycleId: cycle.cycle.id,
        proposalId: proposal.id,
        expectedCycleRevision: cycle.cycle.revision,
        expectedProposalRevision: proposal.revision,
        expectedProjectIntentRevision: null,
        expectedLedgerRevision: null,
      },
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'planning_cycle_revision_conflict' },
    });
  });

  it('returns planning_proposal_invalid for defensive approval semantics without partial writes', async () => {
    const context = await setup();
    const assignment = context.execution.assignment as PmDiscoveryAssignment;
    const report = proposalReport(context);
    report.result.records.push({
      operation: 'create',
      key: 'persist-items',
      content: {
        type: 'requirement',
        kind: 'operational',
        status: 'proposed',
        priority: 'must',
        statement: 'Todo items persist.',
        rationale: 'Durability is required.',
      },
      provenance: [
        {
          kind: 'conversation_turn',
          turnId: assignment.humanTurnId,
          rationale: 'Initial request.',
        },
      ],
    });
    report.result.relationships.push({
      kind: 'depends_on',
      from: { proposalKey: 'add-items' },
      to: { proposalKey: 'persist-items' },
    });
    context.consumer.consume(context.execution, runtimeEvent(context, report));
    const view = context.repository.cycleView(assignment.planningCycleId)!;
    const proposal = view.proposals[0];
    context.fixture.database
      .prepare(
        `DELETE FROM planning_proposal_records
         WHERE proposal_id = ? AND proposal_key = 'persist-items'`,
      )
      .run(proposal.id);
    const eventCursor = context.fixture.events.cursors(
      context.fixture.project.id,
    ).domain;

    const result = context.service.approveProposal({
      idempotencyKey: 'approve-invalid-proposal',
      actor: { kind: 'human' },
      command: {
        type: 'planning_proposal.approve',
        projectId: context.fixture.project.id,
        planningCycleId: view.cycle.id,
        proposalId: proposal.id,
        expectedCycleRevision: view.cycle.revision,
        expectedProposalRevision: proposal.revision,
        expectedProjectIntentRevision: null,
        expectedLedgerRevision: null,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'planning_proposal_invalid' },
    });
    expect(
      context.fixture.database.prepare('SELECT * FROM ledger_records').all(),
    ).toEqual([]);
    expect(
      context.repository.approvedIntentLedger(context.fixture.project.id),
    ).toBeUndefined();
    expect(context.repository.cycle(view.cycle.id)?.lifecycle).toBe(
      'awaiting_approval',
    );
    expect(
      context.fixture.events.cursors(context.fixture.project.id).domain,
    ).toBe(eventCursor);
    expect(
      context.fixture.commands.find('approve-invalid-proposal')?.result,
    ).toEqual(result);
    expect(context.serviceBarrier.status).toBe('healthy');
  });
});
