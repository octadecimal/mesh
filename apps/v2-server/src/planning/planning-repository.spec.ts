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
  withDependency = false,
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

const applySecondDeliveryPlanRevision = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  repository: PlanningRepository,
  seeded: ReturnType<typeof approveDeliveryProposal>,
) => {
  const { approved, plan, milestoneId, taskId, secondTaskId, dependencyId } =
    seeded;
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
  const pm: PlanningTurn = {
    id: randomUUID(),
    projectId: value.projectId,
    planningCycleId: value.id,
    ordinal: 2,
    actor: 'pm',
    message: 'Revise the approved delivery plan.',
    launchState: null,
    executionId: fixture.execution.id,
    createdAt: at,
  };
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
      deliveryPlan: { id: plan.plan.id, revision: 1 },
    },
    proposedPlan: {
      summary: 'Revise persistence and retire its edge.',
      milestones: [
        {
          operation: 'revise',
          milestoneId,
          expectedRevision: 1,
          lifecycle: 'active',
          content: {
            title: 'Todo persistence',
            outcome: 'Todo remains durable.',
            stopCondition: 'Both tasks persist.',
            exclusions: [],
            ordinal: 1,
          },
        },
      ],
      tasks: [
        {
          operation: 'revise',
          taskId,
          expectedContractRevision: 1,
          expectedCurrentRevision: 1,
          lifecycle: 'pending',
          content: {
            milestone: { kind: 'canonical', milestoneId },
            title: 'Persist revised task',
            outcome: 'Revised task survives restart.',
            acceptanceCriteria: ['Revised task is restored.'],
            verificationCriteria: ['Revised restart test passes.'],
            priority: 'must',
            labels: ['core'],
            ownedSurfaces: ['storage'],
            prohibitedSurfaces: [],
            expectedArtifacts: ['storage.spec.ts'],
            ordinal: 1,
          },
        },
        {
          operation: 'reuse',
          taskId: secondTaskId,
          expectedContractRevision: 1,
          expectedCurrentRevision: 1,
        },
      ],
      dependencies: [
        {
          operation: 'revise',
          dependencyId,
          expectedRevision: 1,
          lifecycle: 'retired',
        },
      ],
      traces: [
        {
          kind: 'milestone_covers',
          milestone: { kind: 'canonical', milestoneId },
          requirement: { recordId: seeded.recordId, recordRevision: 1 },
        },
        {
          kind: 'task_satisfies',
          task: { kind: 'canonical', taskId },
          requirement: { recordId: seeded.recordId, recordRevision: 1 },
        },
        {
          kind: 'task_satisfies',
          task: { kind: 'canonical', taskId: secondTaskId },
          requirement: { recordId: seeded.recordId, recordRevision: 1 },
        },
      ],
    },
    reservations: { milestones: [], tasks: [], dependencies: [] },
    diff: {
      milestones: { create: 0, reuse: 0, revise: 1, retire: 0, reactivate: 0 },
      tasks: { create: 0, reuse: 1, revise: 1, retire: 0, reactivate: 0 },
      dependencies: {
        create: 0,
        reuse: 0,
        revise: 0,
        retire: 1,
        reactivate: 0,
      },
      traceCreateCount: 2,
      traceRemoveCount: 2,
    },
    createdByTurnId: pm.id,
    createdByExecutionId: fixture.execution.id,
    createdAt: at,
    decision: { kind: 'pending' },
  });
  const revised = approvedDeliveryPlanSchema.parse({
    plan: {
      ...plan.plan,
      revision: 2,
      baseDeliveryPlanRevision: 1,
      proposalId: proposal.id,
      summary: proposal.proposedPlan.summary,
    },
    milestones: [
      {
        ...plan.milestones[0],
        revision: 2,
        title: 'Todo persistence',
        outcome: 'Todo remains durable.',
        stopCondition: 'Both tasks persist.',
        proposalId: proposal.id,
        deliveryPlanRevision: 2,
      },
    ],
    taskContracts: [
      {
        ...plan.taskContracts[0],
        revision: 2,
        contractRevision: 2,
        title: 'Persist revised task',
        outcome: 'Revised task survives restart.',
        acceptanceCriteria: ['Revised task is restored.'],
        verificationCriteria: ['Revised restart test passes.'],
        source: {
          kind: 'plan',
          proposalId: proposal.id,
          deliveryPlanRevision: 2,
        },
      },
      plan.taskContracts[1],
    ],
    dependencies: [
      {
        ...plan.dependencies[0],
        revision: 2,
        lifecycle: 'retired',
        proposalId: proposal.id,
        deliveryPlanRevision: 2,
      },
    ],
    traces: [
      {
        kind: 'milestone_covers',
        milestoneId,
        milestoneRevision: 2,
        requirement: { recordId: seeded.recordId, recordRevision: 1 },
      },
      {
        kind: 'task_satisfies',
        taskId,
        taskContractRevision: 2,
        requirement: { recordId: seeded.recordId, recordRevision: 1 },
      },
      {
        kind: 'task_satisfies',
        taskId: secondTaskId,
        taskContractRevision: 1,
        requirement: { recordId: seeded.recordId, recordRevision: 1 },
      },
    ],
    milestoneDependencies: [],
  });
  inImmediateTransaction(fixture.database, () => {
    repository.insertCycleInTransaction(value, {
      planningCycleId: value.id,
      purpose: 'delivery_plan',
      baseDeliveryPlanId: plan.plan.id,
      baseDeliveryPlanRevision: 1,
    });
    repository.insertTurnInTransaction({
      ...human,
      launchState: 'execution_bound',
      executionId: fixture.execution.id,
    });
    repository.insertTurnInTransaction(pm);
    repository.insertDeliveryPlanProposalInTransaction(proposal);
    repository.applyApprovedDeliveryPlanInTransaction(proposal, revised);
    repository.updateCycleInTransaction(
      { ...value, lifecycle: 'approved', revision: 3, endedAt: at },
      2,
    );
  });
  return { revised, cycle: value, proposal };
};

const applyLifecycleDeliveryPlanRevision = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  repository: PlanningRepository,
  approved: ReturnType<typeof seedApprovedRequirement>['approved'],
  previous: ApprovedDeliveryPlan,
  lifecycle: 'retired' | 'active',
) => {
  const revision = previous.plan.revision + 1;
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
  const pm: PlanningTurn = {
    id: randomUUID(),
    projectId: value.projectId,
    planningCycleId: value.id,
    ordinal: 2,
    actor: 'pm',
    message: `${lifecycle === 'retired' ? 'Retire' : 'Reactivate'} the plan.`,
    launchState: null,
    executionId: fixture.execution.id,
    createdAt: at,
  };
  const milestone = previous.milestones[0];
  const taskMembers = previous.taskContracts.map((task) => ({
    operation: 'revise' as const,
    taskId: task.id,
    expectedContractRevision: task.contractRevision,
    expectedCurrentRevision: task.revision,
    lifecycle:
      lifecycle === 'retired' ? ('retired' as const) : ('pending' as const),
    content: {
      milestone: { kind: 'canonical' as const, milestoneId: milestone.id },
      title: task.title,
      outcome: task.outcome,
      acceptanceCriteria: task.acceptanceCriteria,
      verificationCriteria: task.verificationCriteria,
      priority: task.priority,
      labels: task.labels,
      ownedSurfaces: task.ownedSurfaces,
      prohibitedSurfaces: task.prohibitedSurfaces,
      expectedArtifacts: task.expectedArtifacts,
      ordinal: task.ordinal,
    },
  }));
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
      deliveryPlan: { id: previous.plan.id, revision: previous.plan.revision },
    },
    proposedPlan: {
      summary: `${lifecycle === 'retired' ? 'Retire' : 'Reactivate'} Todo plan.`,
      milestones: [
        {
          operation: 'revise',
          milestoneId: milestone.id,
          expectedRevision: milestone.revision,
          lifecycle,
          content: {
            title: milestone.title,
            outcome: milestone.outcome,
            stopCondition: milestone.stopCondition,
            exclusions: milestone.exclusions,
            ordinal: milestone.ordinal,
          },
        },
      ],
      tasks: taskMembers,
      dependencies: [
        lifecycle === 'retired'
          ? {
              operation: 'reuse' as const,
              dependencyId: previous.dependencies[0].id,
              expectedRevision: previous.dependencies[0].revision,
            }
          : {
              operation: 'revise' as const,
              dependencyId: previous.dependencies[0].id,
              expectedRevision: previous.dependencies[0].revision,
              lifecycle: 'active' as const,
            },
      ],
      traces: previous.traces.map((trace) =>
        trace.kind === 'milestone_covers'
          ? {
              kind: trace.kind,
              milestone: {
                kind: 'canonical' as const,
                milestoneId: trace.milestoneId,
              },
              requirement: trace.requirement,
            }
          : {
              kind: trace.kind,
              task: { kind: 'canonical' as const, taskId: trace.taskId },
              requirement: trace.requirement,
            },
      ),
    },
    reservations: { milestones: [], tasks: [], dependencies: [] },
    diff: {
      milestones: {
        create: 0,
        reuse: 0,
        revise: 0,
        retire: lifecycle === 'retired' ? 1 : 0,
        reactivate: lifecycle === 'active' ? 1 : 0,
      },
      tasks: {
        create: 0,
        reuse: 0,
        revise: 0,
        retire: lifecycle === 'retired' ? taskMembers.length : 0,
        reactivate: lifecycle === 'active' ? taskMembers.length : 0,
      },
      dependencies: {
        create: 0,
        reuse: lifecycle === 'retired' ? 1 : 0,
        revise: 0,
        retire: 0,
        reactivate: lifecycle === 'active' ? 1 : 0,
      },
      traceCreateCount: previous.traces.length,
      traceRemoveCount: previous.traces.length,
    },
    createdByTurnId: pm.id,
    createdByExecutionId: fixture.execution.id,
    createdAt: at,
    decision: { kind: 'pending' },
  });
  const next = approvedDeliveryPlanSchema.parse({
    plan: {
      ...previous.plan,
      revision,
      baseDeliveryPlanRevision: previous.plan.revision,
      proposalId: proposal.id,
      summary: proposal.proposedPlan.summary,
    },
    milestones: [
      {
        ...milestone,
        revision: milestone.revision + 1,
        lifecycle,
        proposalId: proposal.id,
        deliveryPlanRevision: revision,
      },
    ],
    taskContracts: previous.taskContracts.map((task) => ({
      ...task,
      revision: task.revision + 1,
      contractRevision: task.revision + 1,
      lifecycle:
        lifecycle === 'retired' ? ('retired' as const) : ('pending' as const),
      source: {
        kind: 'plan' as const,
        proposalId: proposal.id,
        deliveryPlanRevision: revision,
      },
    })),
    dependencies: [
      lifecycle === 'retired'
        ? previous.dependencies[0]
        : {
            ...previous.dependencies[0],
            revision: previous.dependencies[0].revision + 1,
            lifecycle: 'active' as const,
            proposalId: proposal.id,
            deliveryPlanRevision: revision,
          },
    ],
    traces: previous.traces.map((trace) =>
      trace.kind === 'milestone_covers'
        ? { ...trace, milestoneRevision: milestone.revision + 1 }
        : {
            ...trace,
            taskContractRevision:
              previous.taskContracts.find(({ id }) => id === trace.taskId)!
                .revision + 1,
          },
    ),
    milestoneDependencies: [],
  });
  inImmediateTransaction(fixture.database, () => {
    repository.insertCycleInTransaction(value, {
      planningCycleId: value.id,
      purpose: 'delivery_plan',
      baseDeliveryPlanId: previous.plan.id,
      baseDeliveryPlanRevision: previous.plan.revision,
    });
    repository.insertTurnInTransaction({
      ...human,
      launchState: 'execution_bound',
      executionId: fixture.execution.id,
    });
    repository.insertTurnInTransaction(pm);
    repository.insertDeliveryPlanProposalInTransaction(proposal);
    repository.applyApprovedDeliveryPlanInTransaction(proposal, next);
    repository.updateCycleInTransaction(
      { ...value, lifecycle: 'approved', revision: 3, endedAt: at },
      2,
    );
  });
  return next;
};

const replaceCurrentIntent = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  repository: PlanningRepository,
  approved: ReturnType<typeof seedApprovedRequirement>['approved'],
  recordId: string,
  operation: 'revise' | 'remove',
) => {
  const value: PlanningCycle = {
    ...cycle(fixture),
    lifecycle: 'awaiting_approval',
    revision: 2,
    latestProposalRevision: 1,
    baseProjectIntentRevision: 1,
    baseLedgerRevision: 1,
  };
  const human = humanTurn(value);
  const pm: PlanningTurn = {
    id: randomUUID(),
    projectId: value.projectId,
    planningCycleId: value.id,
    ordinal: 2,
    actor: 'pm',
    message: 'Revise Todo intent.',
    launchState: null,
    executionId: fixture.execution.id,
    createdAt: at,
  };
  const provenance = [
    {
      kind: 'conversation_turn' as const,
      turnId: human.id,
      rationale: 'Revision request.',
    },
  ];
  const records: PlanningProposal['records'] = [
    {
      operation: 'revise',
      recordId,
      expectedRevision: 1,
      content: {
        ...approved.records[0].content,
        status: 'proposed',
        statement: 'Users manage revised tasks.',
      },
      provenance,
    },
  ];
  const proposal: PlanningProposal = {
    id: randomUUID(),
    projectId: value.projectId,
    planningCycleId: value.id,
    revision: 1,
    lifecycle: 'awaiting_approval',
    baseProjectIntentRevision: 1,
    baseLedgerRevision: 1,
    summary: 'Revised Todo intent',
    projectIntent: { ...approved.projectIntent.content, provenance },
    records,
    relationships: [],
    diff: {
      intentChanges: [],
      recordChanges: {
        create: 0,
        revise: 1,
        reuse: 0,
      },
      relationshipChanges: { added: [], removed: [] },
    },
    createdByTurnId: pm.id,
    createdByExecutionId: fixture.execution.id,
    rejectionFeedback: null,
    createdAt: at,
    decidedAt: null,
  };
  inImmediateTransaction(fixture.database, () => {
    repository.insertCycleInTransaction(value);
    repository.insertTurnInTransaction({
      ...human,
      launchState: 'execution_bound',
      executionId: fixture.execution.id,
    });
    repository.insertTurnInTransaction(pm);
    repository.insertProposalInTransaction(proposal);
    repository.applyApprovedProposalInTransaction(proposal, at);
    repository.updateProposalInTransaction({
      ...proposal,
      lifecycle: 'approved',
      decidedAt: at,
    });
    repository.updateCycleInTransaction(
      { ...value, lifecycle: 'approved', revision: 3, endedAt: at },
      2,
    );
    if (operation === 'remove') {
      fixture.database
        .prepare(
          `DELETE FROM ledger_revision_members
           WHERE ledger_id = ? AND ledger_revision = 2 AND record_id = ?`,
        )
        .run(approved.ledger.id, recordId);
    }
  });
};

describe('PlanningRepository', () => {
  it('appends a completion revision without changing the task contract', () => {
    const { fixture, repository } = setup();
    const { plan, taskId } = approveDeliveryProposal(fixture, repository);

    const completed = inImmediateTransaction(fixture.database, () =>
      repository.appendOperationalTaskLifecycleInTransaction({
        projectId: fixture.project.id,
        expectedDeliveryPlanRevision: plan.plan.revision,
        taskId,
        expectedContractRevision: 1,
        expectedCurrentRevision: 1,
        lifecycle: 'completed',
        createdAt: at,
      }),
    );

    expect(completed).toMatchObject({
      id: taskId,
      revision: 2,
      contractRevision: 1,
      revisionKind: 'operational_lifecycle',
      lifecycle: 'completed',
      source: { kind: 'lifecycle', priorRevision: 1 },
    });
    expect(
      repository.taskExecutionAuthority(fixture.project.id, taskId)?.task,
    ).toMatchObject({
      revision: 2,
      contractRevision: 1,
      lifecycle: 'completed',
    });
  });

  it('returns one coherent execution authority for an actionable task', () => {
    const { fixture, repository } = setup();
    const { plan, taskId } = approveDeliveryProposal(fixture, repository);

    const authority = repository.taskExecutionAuthority(
      fixture.project.id,
      taskId,
    );

    expect(authority).toMatchObject({
      project: fixture.project,
      deliveryPlan: plan,
      intentRevision: plan.plan.projectIntentRevision,
      ledgerRevision: plan.plan.ledgerRevision,
      task: { id: taskId, revision: 1, contractRevision: 1 },
      card: {
        taskId,
        readiness: { state: 'actionable', blockers: [] },
      },
    });
    expect(authority?.requirementRevisions).toEqual([
      { recordId: plan.traces[1].requirement.recordId, recordRevision: 1 },
    ]);
  });

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

  it('round-trips nonlexical reservation membership without treating order as corruption', () => {
    const { fixture, repository } = setup();
    const { approved, proposal, recordId } = deliveryProposal(
      fixture,
      repository,
    );
    const milestoneTemplate = proposal.proposedPlan.milestones[0];
    const taskTemplate = proposal.proposedPlan.tasks[0];
    if (
      milestoneTemplate?.operation !== 'create' ||
      taskTemplate?.operation !== 'create'
    ) {
      throw new Error('Expected create-member proposal templates');
    }
    const milestone = (key: string, ordinal: number) => ({
      ...milestoneTemplate,
      key,
      content: { ...milestoneTemplate.content, ordinal },
    });
    const task = (key: string, milestoneKey: string, ordinal: number) => ({
      ...taskTemplate,
      key,
      content: {
        ...taskTemplate.content,
        milestone: { kind: 'proposal' as const, key: milestoneKey },
        ordinal,
      },
    });
    const milestones = [
      milestone('z-milestone', 1),
      milestone('a-milestone', 2),
    ];
    const tasks = [
      task('z-task', 'z-milestone', 1),
      task('middle-task', 'z-milestone', 2),
      task('a-task', 'a-milestone', 1),
    ];
    const dependencies = [
      {
        operation: 'create' as const,
        key: 'z-dependency',
        prerequisite: { kind: 'proposal' as const, key: 'z-task' },
        dependent: { kind: 'proposal' as const, key: 'middle-task' },
      },
      {
        operation: 'create' as const,
        key: 'a-dependency',
        prerequisite: { kind: 'proposal' as const, key: 'middle-task' },
        dependent: { kind: 'proposal' as const, key: 'a-task' },
      },
    ];
    const successor = deliveryPlanProposalSchema.parse({
      ...proposal,
      id: randomUUID(),
      revision: 2,
      proposedPlan: {
        summary: 'Two Todo milestones in proposal order.',
        milestones,
        tasks,
        dependencies,
        traces: [
          ...milestones.map(({ key }) => ({
            kind: 'milestone_covers' as const,
            milestone: { kind: 'proposal' as const, key },
            requirement: { recordId, recordRevision: 1 },
          })),
          ...tasks.map(({ key }) => ({
            kind: 'task_satisfies' as const,
            task: { kind: 'proposal' as const, key },
            requirement: { recordId, recordRevision: 1 },
          })),
        ],
      },
      reservations: {
        milestones: milestones.map(({ key }) => ({ key, id: randomUUID() })),
        tasks: tasks.map(({ key }) => ({ key, id: randomUUID() })),
        dependencies: dependencies.map(({ key }) => ({
          key,
          id: randomUUID(),
        })),
      },
      diff: {
        milestones: {
          create: 2,
          reuse: 0,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        tasks: {
          create: 3,
          reuse: 0,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        dependencies: {
          create: 2,
          reuse: 0,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        traceCreateCount: 5,
        traceRemoveCount: 0,
      },
    });
    inImmediateTransaction(fixture.database, () => {
      repository.insertDeliveryPlanProposalInTransaction(successor);
      expect(repository.deliveryPlanProposal(successor.id)).toEqual(successor);
      repository.settleDeliveryPlanProposalInTransaction(proposal.id, {
        kind: 'superseded',
        reason: 'replacement_accepted',
        supersededByProposalId: successor.id,
        decidedAt: at,
      });
    });
    expect(
      fixture.database
        .prepare(
          'SELECT proposal_json FROM delivery_plan_proposals WHERE id = ?',
        )
        .pluck()
        .get(successor.id),
    ).toBe(canonicalJson(successor));

    fixture.database
      .prepare(
        'UPDATE delivery_plan_proposals SET proposal_json = ? WHERE id = ?',
      )
      .run(
        canonicalJson({
          ...successor,
          reservations: {
            ...successor.reservations,
            tasks: successor.reservations.tasks.slice(1),
          },
        }),
        successor.id,
      );
    expect(() => repository.deliveryPlanProposal(successor.id)).toThrow(
      /Reservations must exactly match created proposal members/,
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

  it.each(['revise', 'remove'] as const)(
    'keeps stale plan cards traceable to the exact immutable requirement after %s',
    (operation) => {
      const { fixture, repository } = setup();
      const { approved, recordId, plan } = approveDeliveryProposal(
        fixture,
        repository,
      );
      replaceCurrentIntent(fixture, repository, approved, recordId, operation);

      const expected = {
        stale: true,
        cards: [
          {
            readiness: { blockers: [{ kind: 'plan_stale' }] },
            detail: {
              requirementTraces: [
                {
                  recordId,
                  recordRevision: 1,
                  title: 'Users manage tasks.',
                },
              ],
            },
          },
        ],
        facets: {
          requirements: [
            {
              value: recordId,
              label: 'Users manage tasks.',
              recordRevision: 1,
              requirementKind: 'functional',
              historical: false,
            },
          ],
        },
      };
      expect(
        repository.planningSnapshot(fixture.project.id).board,
      ).toMatchObject(expected);

      fixture.database.close();
      const reopened = openV2Database(fixture.path);
      expect(
        new PlanningRepository(reopened).planningSnapshot(fixture.project.id)
          .board,
      ).toMatchObject(expected);
      expect(
        new PlanningRepository(reopened).approvedDeliveryPlan(
          fixture.project.id,
        ),
      ).toEqual(plan);
      reopened.close();
    },
  );

  it('fails closed on normalized proposal, decision, and canonical scalar corruption', () => {
    {
      const { fixture, repository } = setup();
      const { proposal } = deliveryProposal(fixture, repository);
      fixture.database
        .prepare(
          `UPDATE delivery_plan_proposal_tasks
           SET milestone_identity_key = NULL WHERE proposal_id = ?`,
        )
        .run(proposal.id);
      expect(() => repository.deliveryPlanProposal(proposal.id)).toThrow(
        /corrupt/i,
      );
    }
    {
      const { fixture, repository } = setup();
      const { proposal } = deliveryProposal(fixture, repository);
      const successor = {
        ...proposal,
        id: randomUUID(),
        revision: 2,
        reservations: {
          milestones: [{ key: 'milestone', id: randomUUID() }],
          tasks: [{ key: 'task', id: randomUUID() }],
          dependencies: [],
        },
      };
      inImmediateTransaction(fixture.database, () => {
        repository.insertDeliveryPlanProposalInTransaction(successor);
        repository.settleDeliveryPlanProposalInTransaction(proposal.id, {
          kind: 'superseded',
          reason: 'replacement_accepted',
          supersededByProposalId: successor.id,
          decidedAt: at,
        });
      });
      fixture.database
        .prepare(
          `UPDATE delivery_plan_proposal_decisions
           SET successor_proposal_id = proposal_id WHERE proposal_id = ?`,
        )
        .run(proposal.id);
      expect(() => repository.deliveryPlanProposal(proposal.id)).toThrow(
        /corrupt/i,
      );
    }
    {
      const { fixture, repository } = setup();
      const { milestoneId } = approveDeliveryProposal(fixture, repository);
      fixture.database
        .prepare(
          `UPDATE milestone_revisions SET lifecycle = 'retired'
           WHERE milestone_id = ? AND revision = 1`,
        )
        .run(milestoneId);
      expect(() => repository.approvedDeliveryPlan(fixture.project.id)).toThrow(
        /corrupt/i,
      );
    }
    {
      const { fixture, repository } = setup();
      const { plan } = approveDeliveryProposal(fixture, repository);
      fixture.database
        .prepare(
          `UPDATE delivery_plan_revision_milestones SET ordinal = 2
           WHERE delivery_plan_id = ? AND delivery_plan_revision = 1`,
        )
        .run(plan.plan.id);
      expect(() => repository.approvedDeliveryPlan(fixture.project.id)).toThrow(
        /corrupt/i,
      );
    }
  });

  it('authenticates first-creation and selected-revision provenance independently', () => {
    const { fixture, repository } = setup();
    const seeded = approveDeliveryProposal(fixture, repository, true);
    const { revised } = applySecondDeliveryPlanRevision(
      fixture,
      repository,
      seeded,
    );
    const retired = applyLifecycleDeliveryPlanRevision(
      fixture,
      repository,
      seeded.approved,
      revised,
      'retired',
    );
    const reactivated = applyLifecycleDeliveryPlanRevision(
      fixture,
      repository,
      seeded.approved,
      retired,
      'active',
    );

    expect(repository.approvedDeliveryPlan(fixture.project.id)).toEqual(
      reactivated,
    );
    for (const table of ['milestones', 'tasks', 'task_dependencies']) {
      expect(
        fixture.database
          .prepare(`SELECT created_proposal_id FROM ${table} ORDER BY id`)
          .all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ created_proposal_id: seeded.proposal.id }),
        ]),
      );
    }

    fixture.database.close();
    const reopened = openV2Database(fixture.path);
    expect(
      new PlanningRepository(reopened).approvedDeliveryPlan(fixture.project.id),
    ).toEqual(reactivated);
    reopened.close();
  });

  it('rejects duplicate and foreign exact-revision requirement trace subjects', () => {
    const { fixture, repository } = setup();
    const { plan, recordId } = approveDeliveryProposal(fixture, repository);
    const insert = fixture.database.prepare(
      `INSERT INTO delivery_plan_revision_traces (
        delivery_plan_id, delivery_plan_revision, project_id, ordinal, kind,
        milestone_id, milestone_revision, task_id, task_contract_revision,
        record_id, record_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const milestone = plan.milestones[0];
    expect(() =>
      insert.run(
        plan.plan.id,
        1,
        fixture.project.id,
        99,
        'milestone_covers',
        milestone.id,
        milestone.revision,
        null,
        null,
        recordId,
        1,
      ),
    ).toThrow(/unique/i);
    expect(() =>
      insert.run(
        plan.plan.id,
        1,
        fixture.project.id,
        99,
        'milestone_covers',
        randomUUID(),
        1,
        null,
        null,
        recordId,
        1,
      ),
    ).toThrow(/foreign key/i);
    const task = plan.taskContracts[0];
    expect(() =>
      insert.run(
        plan.plan.id,
        1,
        fixture.project.id,
        99,
        'task_satisfies',
        null,
        null,
        task.id,
        task.contractRevision,
        recordId,
        1,
      ),
    ).toThrow(/unique/i);
    expect(() =>
      insert.run(
        plan.plan.id,
        1,
        fixture.project.id,
        99,
        'task_satisfies',
        null,
        null,
        randomUUID(),
        1,
        recordId,
        1,
      ),
    ).toThrow(/foreign key/i);
  });

  it.each([
    {
      label: 'cycle wrong revision',
      table: 'planning_cycle_purposes',
      column: 'base_delivery_plan_revision',
      value: 99,
      key: 'planning_cycle_id',
      select: 'cycle' as const,
    },
    {
      label: 'cycle missing plan',
      table: 'planning_cycle_purposes',
      column: 'base_delivery_plan_id',
      value: randomUUID(),
      key: 'planning_cycle_id',
      select: 'cycle' as const,
    },
    {
      label: 'proposal wrong revision',
      table: 'delivery_plan_proposals',
      column: 'base_delivery_plan_revision',
      value: 99,
      key: 'id',
      select: 'proposal' as const,
    },
    {
      label: 'proposal cross-project identity',
      table: 'delivery_plan_proposals',
      column: 'project_id',
      value: randomUUID(),
      key: 'id',
      select: 'proposal' as const,
    },
  ])('fails closed across reopen on $label base corruption', (corruption) => {
    const { fixture, repository } = setup();
    const seeded = approveDeliveryProposal(fixture, repository, true);
    const revision = applySecondDeliveryPlanRevision(
      fixture,
      repository,
      seeded,
    );
    fixture.database.pragma('foreign_keys = OFF');
    fixture.database
      .prepare(
        `UPDATE ${corruption.table} SET ${corruption.column} = ? WHERE ${corruption.key} = ?`,
      )
      .run(
        corruption.value,
        corruption.select === 'cycle'
          ? revision.cycle.id
          : revision.proposal.id,
      );
    fixture.database.close();

    const reopened = openV2Database(fixture.path);
    const reopenedRepository = new PlanningRepository(reopened);
    expect(() =>
      corruption.select === 'cycle'
        ? reopenedRepository.cyclePurpose(revision.cycle.id)
        : reopenedRepository.deliveryPlanProposal(revision.proposal.id),
    ).toThrow(/corrupt/i);
    reopened.close();
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
