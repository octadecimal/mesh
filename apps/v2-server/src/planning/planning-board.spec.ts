import type {
  ApprovedDeliveryPlan,
  ApprovedIntentLedger,
  BoardFilter,
  TaskRevision,
} from '@mesh/v2-contracts';
import { describe, expect, it } from 'vitest';

import { projectBoard } from './planning-board.js';

const at = '2026-08-30T00:00:00.000Z';
const projectId = '00000000-0000-4000-8000-000000000001';
const intentId = '00000000-0000-4000-8000-000000000002';
const ledgerId = '00000000-0000-4000-8000-000000000003';
const requirementId = '00000000-0000-4000-8000-000000000004';
const proposalId = '00000000-0000-4000-8000-000000000005';
const planId = '00000000-0000-4000-8000-000000000006';
const milestoneOne = '00000000-0000-4000-8000-000000000007';
const milestoneTwo = '00000000-0000-4000-8000-000000000008';
const taskOne = '00000000-0000-4000-8000-000000000009';
const taskTwo = '00000000-0000-4000-8000-00000000000a';
const dependencyId = '00000000-0000-4000-8000-00000000000b';

const intentLedger: ApprovedIntentLedger = {
  projectIntent: {
    id: intentId,
    projectId,
    revision: 1,
    content: {
      goal: 'Ship Todo.',
      targetUsers: ['Operators'],
      desiredCapabilities: ['Manage tasks'],
      constraints: [],
      nonGoals: [],
      successConditions: ['Tasks persist'],
      rationale: 'Requested.',
      provenance: [],
    },
    proposalId,
    approvedBy: 'human',
    approvedAt: at,
  },
  ledger: {
    id: ledgerId,
    projectId,
    revision: 1,
    proposalId,
    approvedBy: 'human',
    approvedAt: at,
  },
  records: [
    {
      recordId: requirementId,
      projectId,
      revision: 1,
      content: {
        type: 'requirement',
        kind: 'functional',
        status: 'approved',
        priority: 'must',
        statement: 'Users manage Todo tasks.',
        rationale: 'Core outcome.',
      },
      provenance: [],
      proposalId,
      approvedBy: 'human',
      approvedAt: at,
    },
  ],
  relationships: [],
};

const task = (
  id: string,
  milestoneId: string,
  ordinal: number,
  title: string,
): TaskRevision => ({
  id,
  projectId,
  revision: 1,
  contractRevision: 1,
  revisionKind: 'plan_contract',
  lifecycle: 'pending',
  milestoneId,
  title,
  outcome: `${title} works.`,
  acceptanceCriteria: [`${title} accepted.`],
  verificationCriteria: [`${title} verified.`],
  priority: ordinal === 1 ? 'must' : 'should',
  labels: ordinal === 1 ? ['core'] : ['later'],
  ownedSurfaces: [`${title}.ts`],
  prohibitedSurfaces: [],
  expectedArtifacts: [`${title}.spec.ts`],
  ordinal,
  source: { kind: 'plan', proposalId, deliveryPlanRevision: 1 },
  createdAt: at,
});

const firstContract = task(taskOne, milestoneOne, 1, 'Store tasks');
const secondContract = task(taskTwo, milestoneTwo, 1, 'Show tasks');

const deliveryPlan: ApprovedDeliveryPlan = {
  plan: {
    id: planId,
    projectId,
    revision: 1,
    projectIntentId: intentId,
    projectIntentRevision: 1,
    ledgerId,
    ledgerRevision: 1,
    baseDeliveryPlanRevision: null,
    proposalId,
    summary: 'Deliver Todo in two milestones.',
    approvedBy: 'human',
    approvedAt: at,
  },
  milestones: [
    {
      id: milestoneOne,
      projectId,
      revision: 1,
      lifecycle: 'active',
      title: 'Persistence',
      outcome: 'Tasks persist.',
      stopCondition: 'Restart preserves tasks.',
      exclusions: [],
      ordinal: 1,
      proposalId,
      deliveryPlanRevision: 1,
      approvedAt: at,
    },
    {
      id: milestoneTwo,
      projectId,
      revision: 1,
      lifecycle: 'active',
      title: 'Board',
      outcome: 'Tasks are visible.',
      stopCondition: 'Board shows tasks.',
      exclusions: [],
      ordinal: 2,
      proposalId,
      deliveryPlanRevision: 1,
      approvedAt: at,
    },
  ],
  taskContracts: [firstContract, secondContract],
  dependencies: [
    {
      id: dependencyId,
      projectId,
      revision: 1,
      prerequisiteTaskId: taskOne,
      dependentTaskId: taskTwo,
      lifecycle: 'active',
      proposalId,
      deliveryPlanRevision: 1,
      approvedAt: at,
    },
  ],
  traces: [
    {
      kind: 'milestone_covers',
      milestoneId: milestoneOne,
      milestoneRevision: 1,
      requirement: { recordId: requirementId, recordRevision: 1 },
    },
    {
      kind: 'milestone_covers',
      milestoneId: milestoneTwo,
      milestoneRevision: 1,
      requirement: { recordId: requirementId, recordRevision: 1 },
    },
    {
      kind: 'task_satisfies',
      taskId: taskOne,
      taskContractRevision: 1,
      requirement: { recordId: requirementId, recordRevision: 1 },
    },
    {
      kind: 'task_satisfies',
      taskId: taskTwo,
      taskContractRevision: 1,
      requirement: { recordId: requirementId, recordRevision: 1 },
    },
  ],
  milestoneDependencies: [
    {
      prerequisiteMilestoneId: milestoneOne,
      dependentMilestoneId: milestoneTwo,
      throughTaskDependencyIds: [dependencyId],
    },
  ],
};

const filter: BoardFilter = {
  projectId,
  revision: 1,
  milestoneIds: [],
  taskLifecycles: ['pending', 'completed'],
  readiness: [],
  priorities: [],
  labels: [],
  requirementRecordIds: [],
  updatedAt: at,
};

describe('projectBoard', () => {
  it('returns the exact pre-plan empty states', () => {
    expect(
      projectBoard({
        projectId,
        intentLedger: null,
        deliveryPlan: null,
        currentTaskRevisions: [],
        filter: null,
      }).emptyReason,
    ).toBe('intent_required');
    expect(
      projectBoard({
        projectId,
        intentLedger,
        deliveryPlan: null,
        currentTaskRevisions: [],
        filter: null,
      }).emptyReason,
    ).toBe('planning_required');
  });

  it('calculates readiness, cross-milestone dependencies, details, and canonical card order', () => {
    const board = projectBoard({
      projectId,
      intentLedger,
      deliveryPlan,
      currentTaskRevisions: [secondContract, firstContract],
      filter,
    });

    expect(board.cards.map(({ taskId }) => taskId)).toEqual([taskOne, taskTwo]);
    expect(board.cards[0].readiness).toEqual({
      state: 'actionable',
      blockers: [],
    });
    expect(board.cards[1].readiness).toEqual({
      state: 'blocked',
      blockers: [
        {
          kind: 'dependency_incomplete',
          dependencyId,
          prerequisiteTaskId: taskOne,
        },
      ],
    });
    expect(board.cards[1].dependencies).toEqual([
      {
        dependencyId,
        dependencyRevision: 1,
        direction: 'prerequisite',
        otherTaskId: taskOne,
        otherTaskTitle: 'Store tasks',
        otherTaskLifecycle: 'pending',
      },
    ]);
    expect(board.cards[1].detail.requirementTraces).toEqual([
      {
        recordId: requirementId,
        recordRevision: 1,
        title: 'Users manage Todo tasks.',
      },
    ]);
  });

  it('reverses dependency readiness after completion and reopen', () => {
    const completed: TaskRevision = {
      ...firstContract,
      revision: 2,
      revisionKind: 'operational_lifecycle',
      lifecycle: 'completed',
      source: { kind: 'lifecycle', priorRevision: 1 },
    };
    const reopened: TaskRevision = {
      ...firstContract,
      revision: 3,
      revisionKind: 'operational_lifecycle',
      lifecycle: 'pending',
      source: { kind: 'lifecycle', priorRevision: 2 },
    };
    const ready = projectBoard({
      projectId,
      intentLedger,
      deliveryPlan,
      currentTaskRevisions: [completed, secondContract],
      filter,
    });
    expect(
      ready.cards.find(({ taskId }) => taskId === taskTwo)?.readiness.state,
      JSON.stringify(ready.cards),
    ).toBe('actionable');
    const blocked = projectBoard({
      projectId,
      intentLedger,
      deliveryPlan,
      currentTaskRevisions: [reopened, secondContract],
      filter,
    });
    expect(
      blocked.cards.find(({ taskId }) => taskId === taskTwo)?.readiness.state,
    ).toBe('blocked');
  });

  it('keeps retired work inactive and distinguishes an approved empty plan', () => {
    const retiredTask: TaskRevision = {
      ...firstContract,
      lifecycle: 'retired',
    };
    const retiredMilestonePlan: ApprovedDeliveryPlan = {
      ...deliveryPlan,
      milestones: deliveryPlan.milestones.map((milestone) =>
        milestone.id === milestoneTwo
          ? { ...milestone, lifecycle: 'retired' as const }
          : milestone,
      ),
    };
    const allLifecycles = { ...filter, taskLifecycles: [] };
    const board = projectBoard({
      projectId,
      intentLedger,
      deliveryPlan: retiredMilestonePlan,
      currentTaskRevisions: [retiredTask, secondContract],
      filter: allLifecycles,
    });
    expect(
      board.cards.find(({ taskId }) => taskId === taskOne)?.readiness,
    ).toEqual({
      state: 'inactive',
      blockers: [{ kind: 'task_retired' }],
    });
    expect(
      board.cards.find(({ taskId }) => taskId === taskTwo)?.readiness,
    ).toEqual({
      state: 'inactive',
      blockers: [{ kind: 'milestone_retired', milestoneId: milestoneTwo }],
    });

    expect(
      projectBoard({
        projectId,
        intentLedger,
        deliveryPlan: {
          ...deliveryPlan,
          milestones: [],
          taskContracts: [],
          dependencies: [],
          traces: [],
          milestoneDependencies: [],
        },
        currentTaskRevisions: [],
        filter,
      }).emptyReason,
    ).toBe('plan_empty');
  });

  it('marks pending work stale and rejects incomplete or obsolete task revision selection', () => {
    const staleLedger = {
      ...intentLedger,
      ledger: { ...intentLedger.ledger, revision: 2 },
    };
    const board = projectBoard({
      projectId,
      intentLedger: staleLedger,
      deliveryPlan,
      currentTaskRevisions: [firstContract, secondContract],
      filter,
    });
    expect(board.stale).toBe(true);
    expect(
      board.cards.every(
        ({ readiness }) => readiness.blockers[0]?.kind === 'plan_stale',
      ),
    ).toBe(true);

    const retiredMilestone = {
      ...deliveryPlan,
      milestones: deliveryPlan.milestones.map((milestone) => ({
        ...milestone,
        lifecycle: 'retired' as const,
      })),
    };
    expect(
      projectBoard({
        projectId,
        intentLedger: staleLedger,
        deliveryPlan: retiredMilestone,
        currentTaskRevisions: [firstContract, secondContract],
        filter,
      }).cards.every(
        ({ readiness }) => readiness.blockers[0]?.kind === 'plan_stale',
      ),
    ).toBe(true);

    expect(() =>
      projectBoard({
        projectId,
        intentLedger: {
          ...staleLedger,
          records: [
            {
              ...intentLedger.records[0],
              revision: 2,
              content: {
                ...intentLedger.records[0].content,
                statement: 'Users manage revised Todo tasks.',
              },
            },
          ],
        },
        deliveryPlan,
        currentTaskRevisions: [firstContract, secondContract],
        filter,
      }),
    ).toThrow(/requirement trace/i);

    for (const revisions of [
      [firstContract],
      [
        firstContract,
        secondContract,
        { ...secondContract, id: '00000000-0000-4000-8000-00000000000c' },
      ],
      [firstContract, { ...secondContract, contractRevision: 2 }],
    ]) {
      expect(() =>
        projectBoard({
          projectId,
          intentLedger,
          deliveryPlan,
          currentTaskRevisions: revisions,
          filter,
        }),
      ).toThrow(/task revision/i);
    }
  });

  it('uses self-excluding facet counts and fails closed on unauthenticated historical options', () => {
    const selected: BoardFilter = {
      ...filter,
      revision: 2,
      milestoneIds: [milestoneOne],
      labels: ['core', 'removed'],
      requirementRecordIds: [requirementId],
    };
    const board = projectBoard({
      projectId,
      intentLedger,
      deliveryPlan,
      currentTaskRevisions: [firstContract, secondContract],
      filter: selected,
    });
    expect(board.emptyReason).toBe(null);
    expect(
      board.facets.labels.find(({ value }) => value === 'removed'),
    ).toEqual({
      value: 'removed',
      label: 'removed',
      selected: true,
      historical: true,
      matchingTaskCount: 0,
    });
    expect(
      board.facets.requirements.find(({ value }) => value === requirementId),
    ).toMatchObject({
      label: 'Users manage Todo tasks.',
      recordRevision: 1,
      requirementKind: 'functional',
      selected: true,
      historical: false,
    });
    expect(
      board.facets.milestones.find(({ value }) => value === milestoneOne)
        ?.matchingTaskCount,
    ).toBe(1);

    expect(() =>
      projectBoard({
        projectId,
        intentLedger,
        deliveryPlan: {
          ...deliveryPlan,
          plan: {
            ...deliveryPlan.plan,
            revision: 2,
            baseDeliveryPlanRevision: 1,
          },
          milestones: [deliveryPlan.milestones[0]],
          taskContracts: [firstContract],
          dependencies: [],
          traces: deliveryPlan.traces.filter(
            (trace) =>
              (trace.kind === 'milestone_covers' &&
                trace.milestoneId === milestoneOne) ||
              (trace.kind === 'task_satisfies' && trace.taskId === taskOne),
          ),
          milestoneDependencies: [],
        },
        currentTaskRevisions: [firstContract],
        filter: { ...filter, revision: 2, milestoneIds: [milestoneTwo] },
      }),
    ).toThrow(/historical milestone/i);

    expect(() =>
      projectBoard({
        projectId,
        intentLedger,
        deliveryPlan,
        currentTaskRevisions: [firstContract, secondContract],
        filter: {
          ...filter,
          requirementRecordIds: ['00000000-0000-4000-8000-00000000000c'],
        },
      }),
    ).toThrow(/historical requirement/i);
  });
});
