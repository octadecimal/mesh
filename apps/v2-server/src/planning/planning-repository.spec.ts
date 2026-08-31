import { randomUUID } from 'node:crypto';

import {
  approvedIntentLedgerSchema,
  approvedDeliveryPlanSchema,
  deliveryPlanProposalSchema,
  planningCycleViewSchema,
  type ApprovedDeliveryPlan,
  type LedgerRelationship,
  type PlanningCycle,
  type PlanningProposal,
  type PlanningTurn,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { inImmediateTransaction, openV2Database } from '../db/database.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { canonicalJson } from '../storage/canonical-json.js';
import { PlanningRepository } from './planning-repository.js';

const fixtures: ReturnType<typeof createV2TestDatabase>[] = [];
const at = '2026-08-29T00:00:00.000Z';

const setup = () => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  return { fixture, repository: new PlanningRepository(fixture.database) };
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const cycle = (
  fixture: ReturnType<typeof createV2TestDatabase>,
): PlanningCycle => ({
  id: randomUUID(),
  projectId: fixture.project.id,
  lifecycle: 'launch_pending',
  revision: 1,
  profileId: fixture.profileRevision.profileId,
  profileRevision: fixture.profileRevision.revision,
  baseProjectIntentRevision: null,
  baseLedgerRevision: null,
  latestProposalRevision: 0,
  activeExecutionId: null,
  createdAt: at,
  updatedAt: at,
  endedAt: null,
});

const humanTurn = (value: PlanningCycle): PlanningTurn => ({
  id: randomUUID(),
  projectId: value.projectId,
  planningCycleId: value.id,
  ordinal: 1,
  actor: 'human',
  message: 'Build a Todo application.',
  launchState: 'launch_pending',
  executionId: null,
  createdAt: at,
});

const seedApprovedRequirement = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  repository: PlanningRepository,
) => {
  const value = cycle(fixture);
  const human = humanTurn(value);
  const pm: PlanningTurn = {
    id: randomUUID(),
    projectId: value.projectId,
    planningCycleId: value.id,
    ordinal: 2,
    actor: 'pm',
    message: 'One approved requirement.',
    launchState: null,
    executionId: fixture.execution.id,
    createdAt: at,
  };
  const recordId = randomUUID();
  const proposal: PlanningProposal = {
    id: randomUUID(),
    projectId: value.projectId,
    planningCycleId: value.id,
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
        {
          kind: 'conversation_turn',
          turnId: human.id,
          rationale: 'Initial request.',
        },
      ],
    },
    records: [
      {
        operation: 'create',
        key: 'requirement',
        recordId,
        content: {
          type: 'requirement',
          kind: 'functional',
          status: 'proposed',
          priority: 'must',
          statement: 'Users manage tasks.',
          rationale: 'Core workflow.',
        },
        provenance: [
          {
            kind: 'conversation_turn',
            turnId: human.id,
            rationale: 'Initial request.',
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
    createdByExecutionId: fixture.execution.id,
    rejectionFeedback: null,
    createdAt: at,
    decidedAt: null,
  };
  let approved: ReturnType<
    PlanningRepository['applyApprovedProposalInTransaction']
  >;
  inImmediateTransaction(fixture.database, () => {
    repository.insertCycleInTransaction({
      ...value,
      lifecycle: 'awaiting_approval',
      revision: 2,
      latestProposalRevision: 1,
    });
    repository.insertTurnInTransaction({
      ...human,
      launchState: 'execution_bound',
      executionId: fixture.execution.id,
    });
    repository.insertTurnInTransaction(pm);
    repository.insertProposalInTransaction(proposal);
    approved = repository.applyApprovedProposalInTransaction(proposal, at);
    repository.updateProposalInTransaction({
      ...proposal,
      lifecycle: 'approved',
      decidedAt: at,
    });
    repository.updateCycleInTransaction(
      {
        ...value,
        lifecycle: 'approved',
        revision: 3,
        latestProposalRevision: 1,
        endedAt: at,
      },
      2,
    );
  });
  return { approved: approved!, recordId };
};

const deliveryProposal = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  repository: PlanningRepository,
) => {
  const { approved, recordId } = seedApprovedRequirement(fixture, repository);
  const value: PlanningCycle = {
    ...cycle(fixture),
    id: randomUUID(),
    profileId: fixture.pmProfileRevision.profileId,
    profileRevision: fixture.pmProfileRevision.revision,
    baseProjectIntentRevision: approved.projectIntent.revision,
    baseLedgerRevision: approved.ledger.revision,
    lifecycle: 'awaiting_approval',
    revision: 2,
    latestProposalRevision: 1,
  };
  const human = humanTurn(value);
  const boundHuman = {
    ...human,
    launchState: 'execution_bound' as const,
    executionId: fixture.execution.id,
  };
  const pm: PlanningTurn = {
    id: randomUUID(),
    projectId: value.projectId,
    planningCycleId: value.id,
    ordinal: 2,
    actor: 'pm',
    message: 'One milestone and task.',
    launchState: null,
    executionId: fixture.execution.id,
    createdAt: at,
  };
  const milestoneId = randomUUID();
  const taskId = randomUUID();
  const proposal = deliveryPlanProposalSchema.parse({
    id: randomUUID(),
    projectId: fixture.project.id,
    planningCycleId: value.id,
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
      summary: 'One Todo milestone.',
      milestones: [
        {
          operation: 'create',
          key: 'milestone',
          content: {
            title: 'Todo',
            outcome: 'Todo works.',
            stopCondition: 'Task persists.',
            exclusions: [],
            ordinal: 1,
          },
        },
      ],
      tasks: [
        {
          operation: 'create',
          key: 'task',
          content: {
            milestone: { kind: 'proposal', key: 'milestone' },
            title: 'Persist task',
            outcome: 'Task survives restart.',
            acceptanceCriteria: ['Task is restored.'],
            verificationCriteria: ['Restart test passes.'],
            priority: 'must',
            labels: ['core'],
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
          milestone: { kind: 'proposal', key: 'milestone' },
          requirement: { recordId, recordRevision: 1 },
        },
        {
          kind: 'task_satisfies',
          task: { kind: 'proposal', key: 'task' },
          requirement: { recordId, recordRevision: 1 },
        },
      ],
    },
    reservations: {
      milestones: [{ key: 'milestone', id: milestoneId }],
      tasks: [{ key: 'task', id: taskId }],
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
    createdByExecutionId: fixture.execution.id,
    createdAt: at,
    decision: { kind: 'pending' },
  });
  inImmediateTransaction(fixture.database, () => {
    repository.insertCycleInTransaction(value, {
      planningCycleId: value.id,
      purpose: 'delivery_plan',
      baseDeliveryPlanId: null,
      baseDeliveryPlanRevision: null,
    });
    repository.insertTurnInTransaction(boundHuman);
    repository.insertTurnInTransaction(pm);
    repository.insertDeliveryPlanProposalInTransaction(proposal);
  });
  return { approved, proposal, value, milestoneId, taskId };
};

describe('PlanningRepository', () => {
  it('persists purpose-aware delivery proposals and reservations without canonical state', () => {
    const { fixture, repository } = setup();
    const { proposal, value, milestoneId, taskId } = deliveryProposal(
      fixture,
      repository,
    );
    expect(repository.cyclePurpose(value.id)).toEqual({
      planningCycleId: value.id,
      purpose: 'delivery_plan',
      baseDeliveryPlanId: null,
      baseDeliveryPlanRevision: null,
    });
    expect(repository.deliveryPlanProposal(proposal.id)).toEqual(proposal);
    expect(repository.deliveryPlanProposalReservations(proposal.id)).toEqual({
      milestones: [{ key: 'milestone', id: milestoneId }],
      tasks: [{ key: 'task', id: taskId }],
      dependencies: [],
    });
    expect(repository.approvedDeliveryPlan(fixture.project.id)).toBeUndefined();

    expect(
      fixture.database
        .prepare(
          `SELECT proposal_key, milestone_id
           FROM delivery_plan_proposal_milestones WHERE proposal_id = ?`,
        )
        .all(proposal.id),
    ).toEqual([{ proposal_key: 'milestone', milestone_id: milestoneId }]);
    expect(
      fixture.database
        .prepare(
          `SELECT kind FROM delivery_plan_proposal_traces
           WHERE proposal_id = ? ORDER BY ordinal`,
        )
        .all(proposal.id),
    ).toEqual([{ kind: 'milestone_covers' }, { kind: 'task_satisfies' }]);

    fixture.database
      .prepare(
        `UPDATE delivery_plan_proposal_tasks SET member_json = '{}'
         WHERE proposal_id = ? AND proposal_key = 'task'`,
      )
      .run(proposal.id);
    expect(() => repository.deliveryPlanProposal(proposal.id)).toThrow(
      /corrupt/i,
    );

    fixture.database
      .prepare(
        `UPDATE delivery_plan_proposals
         SET proposal_json = ' ' || proposal_json WHERE id = ?`,
      )
      .run(proposal.id);
    expect(() => repository.deliveryPlanProposal(proposal.id)).toThrow(
      /corrupt/i,
    );
  });

  it('atomically applies canonical state, default filter, guarded lifecycle, and restart snapshot', () => {
    const { fixture, repository } = setup();
    const { approved, proposal, value, taskId, milestoneId } = deliveryProposal(
      fixture,
      repository,
    );
    const plan = approvedDeliveryPlanSchema.parse({
      plan: {
        id: randomUUID(),
        projectId: fixture.project.id,
        revision: 1,
        projectIntentId: approved.projectIntent.id,
        projectIntentRevision: approved.projectIntent.revision,
        ledgerId: approved.ledger.id,
        ledgerRevision: approved.ledger.revision,
        baseDeliveryPlanRevision: null,
        proposalId: proposal.id,
        summary: proposal.proposedPlan.summary,
        approvedBy: 'human',
        approvedAt: at,
      },
      milestones: [
        {
          id: milestoneId,
          projectId: fixture.project.id,
          revision: 1,
          lifecycle: 'active',
          title: 'Todo',
          outcome: 'Todo works.',
          stopCondition: 'Task persists.',
          exclusions: [],
          ordinal: 1,
          proposalId: proposal.id,
          deliveryPlanRevision: 1,
          approvedAt: at,
        },
      ],
      taskContracts: [
        {
          id: taskId,
          projectId: fixture.project.id,
          revision: 1,
          contractRevision: 1,
          revisionKind: 'plan_contract',
          lifecycle: 'pending',
          milestoneId,
          title: 'Persist task',
          outcome: 'Task survives restart.',
          acceptanceCriteria: ['Task is restored.'],
          verificationCriteria: ['Restart test passes.'],
          priority: 'must',
          labels: ['core'],
          ownedSurfaces: ['storage'],
          prohibitedSurfaces: [],
          expectedArtifacts: ['storage.spec.ts'],
          ordinal: 1,
          source: {
            kind: 'plan',
            proposalId: proposal.id,
            deliveryPlanRevision: 1,
          },
          createdAt: at,
        },
      ],
      dependencies: [],
      traces: [
        {
          kind: 'milestone_covers',
          milestoneId,
          milestoneRevision: 1,
          requirement: {
            recordId: approved.records[0].recordId,
            recordRevision: 1,
          },
        },
        {
          kind: 'task_satisfies',
          taskId,
          taskContractRevision: 1,
          requirement: {
            recordId: approved.records[0].recordId,
            recordRevision: 1,
          },
        },
      ],
      milestoneDependencies: [],
    });
    inImmediateTransaction(fixture.database, () => {
      repository.applyApprovedDeliveryPlanInTransaction(proposal, plan);
      repository.updateCycleInTransaction(
        {
          ...value,
          lifecycle: 'approved',
          revision: 3,
          endedAt: at,
        },
        2,
      );
    });
    expect(repository.approvedDeliveryPlan(fixture.project.id)).toEqual(plan);
    expect(repository.boardFilter(fixture.project.id)).toMatchObject({
      revision: 1,
      taskLifecycles: ['pending', 'completed'],
    });

    const completed = inImmediateTransaction(fixture.database, () =>
      repository.appendTaskLifecycleRevisionInTransaction({
        projectId: fixture.project.id,
        expectedDeliveryPlanRevision: 1,
        taskId,
        expectedContractRevision: 1,
        expectedCurrentRevision: 1,
        lifecycle: 'completed',
        createdAt: at,
      }),
    );
    expect(completed.revision).toBe(2);
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.appendTaskLifecycleRevisionInTransaction({
          projectId: fixture.project.id,
          expectedDeliveryPlanRevision: 1,
          taskId,
          expectedContractRevision: 1,
          expectedCurrentRevision: 2,
          lifecycle: 'completed',
          createdAt: at,
        }),
      ),
    ).toThrow(/unchanged/i);
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.appendTaskLifecycleRevisionInTransaction({
          projectId: fixture.project.id,
          expectedDeliveryPlanRevision: 1,
          taskId,
          expectedContractRevision: 1,
          expectedCurrentRevision: 1,
          lifecycle: 'completed',
          createdAt: at,
        }),
      ),
    ).toThrow(/revision conflict/i);

    fixture.database.close();
    const reopened = openV2Database(fixture.path);
    const reopenedRepository = new PlanningRepository(reopened);
    expect(
      reopenedRepository.planningSnapshot(fixture.project.id),
    ).toMatchObject({
      deliveryPlan: plan,
      board: { totalTaskCount: 1, cards: [{ taskCurrentRevision: 2 }] },
    });
    reopened
      .prepare(
        `UPDATE task_revisions SET lifecycle = 'pending'
         WHERE task_id = ? AND revision = 2`,
      )
      .run(taskId);
    expect(() => reopenedRepository.currentTaskRevisions(plan)).toThrow(
      /corrupt/i,
    );
    reopened
      .prepare(
        `UPDATE task_revisions SET lifecycle = 'completed'
         WHERE task_id = ? AND revision = 2`,
      )
      .run(taskId);
    reopened
      .prepare(
        `UPDATE board_filters SET updated_at = '2026-08-30T00:00:00.000Z'
         WHERE project_id = ?`,
      )
      .run(fixture.project.id);
    expect(() => reopenedRepository.boardFilter(fixture.project.id)).toThrow(
      /corrupt/i,
    );
    reopened
      .prepare(`UPDATE board_filters SET updated_at = ? WHERE project_id = ?`)
      .run(at, fixture.project.id);
    const retiredPlan = {
      ...plan,
      milestones: [{ ...plan.milestones[0], lifecycle: 'retired' as const }],
      taskContracts: [
        { ...plan.taskContracts[0], lifecycle: 'retired' as const },
      ],
    };
    reopened
      .prepare(
        `UPDATE delivery_plan_revisions SET plan_json = ? WHERE project_id = ?`,
      )
      .run(canonicalJson(retiredPlan), fixture.project.id);
    reopened
      .prepare(
        `UPDATE milestone_revisions SET lifecycle = 'retired',
           revision_json = json_set(revision_json, '$.lifecycle', 'retired')
         WHERE milestone_id = ? AND revision = 1`,
      )
      .run(milestoneId);
    reopened
      .prepare(
        `UPDATE task_revisions SET lifecycle = 'retired',
           revision_json = json_set(revision_json, '$.lifecycle', 'retired')
         WHERE task_id = ? AND revision = 1`,
      )
      .run(taskId);
    expect(() =>
      inImmediateTransaction(reopened, () =>
        reopenedRepository.appendTaskLifecycleRevisionInTransaction({
          projectId: fixture.project.id,
          expectedDeliveryPlanRevision: 1,
          taskId,
          expectedContractRevision: 1,
          expectedCurrentRevision: 2,
          lifecycle: 'pending',
          createdAt: at,
        }),
      ),
    ).toThrow(/retired/i);
    reopened
      .prepare(
        `UPDATE milestone_revisions
         SET revision_json = json_set(revision_json, '$.title', 'Corrupt')
         WHERE milestone_id = ?`,
      )
      .run(milestoneId);
    expect(() =>
      reopenedRepository.approvedDeliveryPlan(fixture.project.id),
    ).toThrow(/corrupt/i);
    reopened.close();
  });

  it('rolls back a representative canonical approval failure without partial state', () => {
    const { fixture, repository } = setup();
    const { approved, proposal, taskId, milestoneId } = deliveryProposal(
      fixture,
      repository,
    );
    const plan: ApprovedDeliveryPlan = approvedDeliveryPlanSchema.parse({
      plan: {
        id: randomUUID(),
        projectId: fixture.project.id,
        revision: 1,
        projectIntentId: approved.projectIntent.id,
        projectIntentRevision: approved.projectIntent.revision,
        ledgerId: approved.ledger.id,
        ledgerRevision: approved.ledger.revision,
        baseDeliveryPlanRevision: null,
        proposalId: proposal.id,
        summary: proposal.proposedPlan.summary,
        approvedBy: 'human',
        approvedAt: at,
      },
      milestones: [
        {
          id: milestoneId,
          projectId: fixture.project.id,
          revision: 1,
          lifecycle: 'active',
          title: 'Todo',
          outcome: 'Todo works.',
          stopCondition: 'Task persists.',
          exclusions: [],
          ordinal: 1,
          proposalId: proposal.id,
          deliveryPlanRevision: 1,
          approvedAt: at,
        },
      ],
      taskContracts: [
        {
          id: taskId,
          projectId: fixture.project.id,
          revision: 1,
          contractRevision: 1,
          revisionKind: 'plan_contract',
          lifecycle: 'pending',
          milestoneId,
          title: 'Persist task',
          outcome: 'Task survives restart.',
          acceptanceCriteria: ['Task is restored.'],
          verificationCriteria: ['Restart test passes.'],
          priority: 'must',
          labels: ['core'],
          ownedSurfaces: ['storage'],
          prohibitedSurfaces: [],
          expectedArtifacts: ['storage.spec.ts'],
          ordinal: 1,
          source: {
            kind: 'plan',
            proposalId: proposal.id,
            deliveryPlanRevision: 1,
          },
          createdAt: at,
        },
      ],
      dependencies: [],
      traces: [
        {
          kind: 'milestone_covers',
          milestoneId,
          milestoneRevision: 1,
          requirement: {
            recordId: approved.records[0].recordId,
            recordRevision: 1,
          },
        },
        {
          kind: 'task_satisfies',
          taskId,
          taskContractRevision: 1,
          requirement: {
            recordId: approved.records[0].recordId,
            recordRevision: 1,
          },
        },
      ],
      milestoneDependencies: [],
    });
    fixture.database.exec(`
      CREATE TRIGGER fail_canonical_task_revision
      BEFORE INSERT ON task_revisions
      BEGIN
        SELECT RAISE(ABORT, 'injected canonical approval failure');
      END
    `);
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.applyApprovedDeliveryPlanInTransaction(proposal, plan),
      ),
    ).toThrow(/injected canonical approval failure/);
    expect(repository.approvedDeliveryPlan(fixture.project.id)).toBeUndefined();
    expect(repository.boardFilter(fixture.project.id)).toBeUndefined();
    expect(
      fixture.database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId),
    ).toBeUndefined();
    expect(
      fixture.database
        .prepare('SELECT * FROM milestones WHERE id = ?')
        .get(milestoneId),
    ).toBeUndefined();
    expect(
      fixture.database
        .prepare('SELECT * FROM delivery_plan_proposal_decisions')
        .all(),
    ).toEqual([]);
  });

  it('authenticates current cycle bases and contiguous plan proposal revisions', () => {
    const { fixture, repository } = setup();
    const { approved, proposal } = deliveryProposal(fixture, repository);
    const stale: PlanningCycle = {
      ...cycle(fixture),
      lifecycle: 'abandoned',
      endedAt: at,
    };
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.insertCycleInTransaction(stale),
      ),
    ).toThrow(/base/i);
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.insertDeliveryPlanProposalInTransaction({
          ...proposal,
          id: randomUUID(),
          revision: 3,
          base: {
            ...proposal.base,
            projectIntentId: approved.projectIntent.id,
          },
        }),
      ),
    ).toThrow(/revision/i);
  });

  it('owns one coherent transaction for planning snapshots', () => {
    const { fixture, repository } = setup();
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.planningSnapshot(fixture.project.id),
      ),
    ).toThrow(/already active/i);
  });

  it('persists immutable cycles and ordered turns across reopen', () => {
    const { fixture, repository } = setup();
    const value = cycle(fixture);
    const turn = humanTurn(value);

    inImmediateTransaction(fixture.database, () => {
      repository.insertCycleInTransaction(value);
      repository.insertTurnInTransaction(turn);
    });

    expect(repository.cycleView(value.id)).toEqual(
      planningCycleViewSchema.parse({
        cycle: value,
        purpose: {
          kind: 'intent',
          baseDeliveryPlanId: null,
          baseDeliveryPlanRevision: null,
        },
        turns: [turn],
        questions: [],
        proposals: [],
        deliveryPlanProposals: [],
      }),
    );
    expect(repository.pendingLaunchTurns()).toEqual([turn]);
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.insertTurnInTransaction({ ...turn, id: randomUUID() }),
      ),
    ).toThrow();

    fixture.database.close();
    const reopened = openV2Database(fixture.path);
    expect(new PlanningRepository(reopened).cycleView(value.id)).toEqual(
      planningCycleViewSchema.parse({
        cycle: value,
        purpose: {
          kind: 'intent',
          baseDeliveryPlanId: null,
          baseDeliveryPlanRevision: null,
        },
        turns: [turn],
        questions: [],
        proposals: [],
        deliveryPlanProposals: [],
      }),
    );
    reopened.close();
  });

  it('enforces one nonterminal cycle per project and conversation-turn provenance ownership', () => {
    const { fixture, repository } = setup();
    const first = cycle(fixture);
    const turn = humanTurn(first);
    inImmediateTransaction(fixture.database, () => {
      repository.insertCycleInTransaction(first);
      repository.insertTurnInTransaction(turn);
    });
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.insertCycleInTransaction({ ...first, id: randomUUID() }),
      ),
    ).toThrow();

    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.insertProjectIntentRevisionInTransaction({
          id: randomUUID(),
          projectId: fixture.project.id,
          revision: 1,
          content: {
            goal: 'Ship Todo.',
            targetUsers: ['People'],
            desiredCapabilities: ['Add items'],
            constraints: [],
            nonGoals: [],
            successConditions: ['Items persist'],
            rationale: 'Requested by the operator.',
            provenance: [
              {
                kind: 'conversation_turn',
                turnId: randomUUID(),
                rationale: 'Wrong turn.',
              },
            ],
          },
          proposalId: randomUUID(),
          approvedBy: 'human',
          approvedAt: at,
        }),
      ),
    ).toThrow();
  });

  it('reserves server record IDs without creating canonical records and normalizes symmetric edges', () => {
    const { fixture, repository } = setup();
    const value = cycle(fixture);
    const human = humanTurn(value);
    const executionId = fixture.execution.id;
    const boundHuman = {
      ...human,
      launchState: 'execution_bound' as const,
      executionId,
    };
    const pmTurn: PlanningTurn = {
      id: randomUUID(),
      projectId: value.projectId,
      planningCycleId: value.id,
      ordinal: 2,
      actor: 'pm',
      message: 'Review this proposal.',
      launchState: null,
      executionId,
      createdAt: at,
    };
    const firstRecord = randomUUID();
    const secondRecord = randomUUID();
    const proposal: PlanningProposal = {
      id: randomUUID(),
      projectId: value.projectId,
      planningCycleId: value.id,
      revision: 1,
      lifecycle: 'awaiting_approval',
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      summary: 'Todo intent',
      projectIntent: {
        goal: 'Ship Todo.',
        targetUsers: ['People'],
        desiredCapabilities: ['Add items'],
        constraints: [],
        nonGoals: [],
        successConditions: ['Items persist'],
        rationale: 'Requested by the operator.',
        provenance: [
          {
            kind: 'conversation_turn',
            turnId: human.id,
            rationale: 'Initial request.',
          },
        ],
      },
      records: [
        {
          operation: 'create',
          key: 'first',
          recordId: firstRecord,
          content: {
            type: 'requirement',
            kind: 'functional',
            status: 'proposed',
            priority: 'must',
            statement: 'Users can add items.',
            rationale: 'Core workflow.',
          },
          provenance: [
            {
              kind: 'conversation_turn',
              turnId: human.id,
              rationale: 'Initial request.',
            },
          ],
        },
        {
          operation: 'create',
          key: 'second',
          recordId: secondRecord,
          content: {
            type: 'requirement',
            kind: 'operational',
            status: 'proposed',
            priority: 'must',
            statement: 'Items persist.',
            rationale: 'Durability.',
          },
          provenance: [
            {
              kind: 'conversation_turn',
              turnId: human.id,
              rationale: 'Initial request.',
            },
          ],
        },
      ],
      relationships: [
        {
          kind: 'duplicates',
          from: { proposalKey: 'second' },
          to: { proposalKey: 'first' },
        },
      ],
      diff: {
        intentChanges: [
          'goal',
          'targetUsers',
          'desiredCapabilities',
          'successConditions',
          'rationale',
          'provenance',
        ],
        recordChanges: { create: 2, revise: 0, reuse: 0 },
        relationshipChanges: {
          added: [
            {
              kind: 'duplicates',
              from: { proposalKey: 'second' },
              to: { proposalKey: 'first' },
            },
          ],
          removed: [],
        },
      },
      createdByTurnId: pmTurn.id,
      createdByExecutionId: executionId,
      rejectionFeedback: null,
      createdAt: at,
      decidedAt: null,
    };

    inImmediateTransaction(fixture.database, () => {
      repository.insertCycleInTransaction({
        ...value,
        lifecycle: 'awaiting_approval',
        revision: 2,
        latestProposalRevision: 1,
      });
      repository.insertTurnInTransaction(boundHuman);
      repository.insertTurnInTransaction(pmTurn);
      repository.insertProposalInTransaction(proposal);
    });

    expect(repository.proposalRecordReservations(proposal.id)).toEqual([
      { key: 'first', recordId: firstRecord },
      { key: 'second', recordId: secondRecord },
    ]);
    expect(
      fixture.database.prepare('SELECT * FROM ledger_records').all(),
    ).toEqual([]);

    const normalized: LedgerRelationship = {
      kind: 'duplicates',
      fromRecordId: [firstRecord, secondRecord].sort()[0],
      toRecordId: [firstRecord, secondRecord].sort()[1],
    };
    inImmediateTransaction(fixture.database, () => {
      repository.applyApprovedProposalInTransaction(proposal, at);
    });
    const approved = repository.approvedIntentLedger(fixture.project.id);
    expect(approvedIntentLedgerSchema.parse(approved)).toEqual(approved);
    expect(approved?.relationships).toEqual([normalized]);
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM ledger_records')
        .get(),
    ).toEqual({ count: 2 });
  });
});
