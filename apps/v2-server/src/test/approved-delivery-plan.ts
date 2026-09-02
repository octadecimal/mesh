import { randomUUID } from 'node:crypto';

import {
  approvedDeliveryPlanSchema,
  deliveryPlanProposalSchema,
  type LedgerRecordId,
  type PlanningCycleId,
  type PlanningCycle,
  type PlanningProposalId,
  type PlanningProposal,
  type PlanningTurnId,
  type PlanningTurn,
} from '@mesh/v2-contracts';

import { inImmediateTransaction } from '../db/database.js';
import { createV2TestDatabase } from './create-v2-test-database.js';
import { PlanningRepository } from '../planning/planning-repository.js';

const at = '2026-08-29T00:00:00.000Z';

const cycle = (
  fixture: ReturnType<typeof createV2TestDatabase>,
): PlanningCycle => ({
  id: randomUUID() as PlanningCycleId,
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
  id: randomUUID() as PlanningTurnId,
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
    id: randomUUID() as PlanningTurnId,
    projectId: value.projectId,
    planningCycleId: value.id,
    ordinal: 2,
    actor: 'pm',
    message: 'One approved requirement.',
    launchState: null,
    executionId: fixture.execution.id,
    createdAt: at,
  };
  const recordId = randomUUID() as LedgerRecordId;
  const proposal: PlanningProposal = {
    id: randomUUID() as PlanningProposalId,
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
  withDependency = false,
) => {
  const { approved, recordId } = seedApprovedRequirement(fixture, repository);
  const value: PlanningCycle = {
    ...cycle(fixture),
    id: randomUUID() as PlanningCycleId,
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
    id: randomUUID() as PlanningTurnId,
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
  const secondTaskId = randomUUID();
  const dependencyId = randomUUID();
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
        ...(withDependency
          ? [
              {
                operation: 'create' as const,
                key: 'second-task',
                content: {
                  milestone: { kind: 'proposal' as const, key: 'milestone' },
                  title: 'Render task',
                  outcome: 'Task is visible.',
                  acceptanceCriteria: ['Task is rendered.'],
                  verificationCriteria: ['Rendering test passes.'],
                  priority: 'should' as const,
                  labels: ['ui'],
                  ownedSurfaces: ['web'],
                  prohibitedSurfaces: [],
                  expectedArtifacts: ['web.spec.ts'],
                  ordinal: 2,
                },
              },
            ]
          : []),
      ],
      dependencies: withDependency
        ? [
            {
              operation: 'create' as const,
              key: 'dependency',
              prerequisite: { kind: 'proposal' as const, key: 'task' },
              dependent: { kind: 'proposal' as const, key: 'second-task' },
            },
          ]
        : [],
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
        ...(withDependency
          ? [
              {
                kind: 'task_satisfies' as const,
                task: { kind: 'proposal' as const, key: 'second-task' },
                requirement: { recordId, recordRevision: 1 },
              },
            ]
          : []),
      ],
    },
    reservations: {
      milestones: [{ key: 'milestone', id: milestoneId }],
      tasks: withDependency
        ? [
            { key: 'second-task', id: secondTaskId },
            { key: 'task', id: taskId },
          ]
        : [{ key: 'task', id: taskId }],
      dependencies: withDependency
        ? [{ key: 'dependency', id: dependencyId }]
        : [],
    },
    diff: {
      milestones: { create: 1, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
      tasks: {
        create: withDependency ? 2 : 1,
        reuse: 0,
        revise: 0,
        retire: 0,
        reactivate: 0,
      },
      dependencies: {
        create: withDependency ? 1 : 0,
        reuse: 0,
        revise: 0,
        retire: 0,
        reactivate: 0,
      },
      traceCreateCount: withDependency ? 3 : 2,
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
  return {
    approved,
    proposal,
    value,
    milestoneId,
    taskId,
    secondTaskId,
    dependencyId,
    recordId,
  };
};

const approveDeliveryProposal = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  repository: PlanningRepository,
  withDependency = false,
) => {
  const seeded = deliveryProposal(fixture, repository, withDependency);
  const {
    approved,
    proposal,
    value,
    milestoneId,
    taskId,
    secondTaskId,
    dependencyId,
  } = seeded;
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
      ...(withDependency
        ? [
            {
              id: secondTaskId,
              projectId: fixture.project.id,
              revision: 1,
              contractRevision: 1,
              revisionKind: 'plan_contract' as const,
              lifecycle: 'pending' as const,
              milestoneId,
              title: 'Render task',
              outcome: 'Task is visible.',
              acceptanceCriteria: ['Task is rendered.'],
              verificationCriteria: ['Rendering test passes.'],
              priority: 'should' as const,
              labels: ['ui'],
              ownedSurfaces: ['web'],
              prohibitedSurfaces: [],
              expectedArtifacts: ['web.spec.ts'],
              ordinal: 2,
              source: {
                kind: 'plan' as const,
                proposalId: proposal.id,
                deliveryPlanRevision: 1,
              },
              createdAt: at,
            },
          ]
        : []),
    ],
    dependencies: withDependency
      ? [
          {
            id: dependencyId,
            projectId: fixture.project.id,
            revision: 1,
            prerequisiteTaskId: taskId,
            dependentTaskId: secondTaskId,
            lifecycle: 'active' as const,
            proposalId: proposal.id,
            deliveryPlanRevision: 1,
            approvedAt: at,
          },
        ]
      : [],
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
      ...(withDependency
        ? [
            {
              kind: 'task_satisfies' as const,
              taskId: secondTaskId,
              taskContractRevision: 1,
              requirement: {
                recordId: approved.records[0].recordId,
                recordRevision: 1,
              },
            },
          ]
        : []),
    ],
    milestoneDependencies: [],
  });
  inImmediateTransaction(fixture.database, () => {
    repository.applyApprovedDeliveryPlanInTransaction(proposal, plan);
    repository.updateCycleInTransaction(
      { ...value, lifecycle: 'approved', revision: 3, endedAt: at },
      2,
    );
  });
  return { ...seeded, plan };
};

export const createTestDeliveryPlanFixture = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  repository: PlanningRepository,
) => ({
  cycle: () => cycle(fixture),
  humanTurn,
  seedApprovedRequirement: () => seedApprovedRequirement(fixture, repository),
  deliveryProposal: (withDependency = false) =>
    deliveryProposal(fixture, repository, withDependency),
  approveTestDeliveryPlan: (withDependency = false) =>
    approveDeliveryProposal(fixture, repository, withDependency),
});

export const approveTestDeliveryPlan = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  repository: PlanningRepository,
  withDependency = false,
) =>
  createTestDeliveryPlanFixture(fixture, repository).approveTestDeliveryPlan(
    withDependency,
  );
