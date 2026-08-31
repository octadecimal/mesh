import { describe, expect, it } from 'vitest';

import {
  PM_PLAN_REPORT_SCHEMA,
  boardFilterSchema,
  boardFilterSelectionSchema,
  boardTaskCardSchema,
  boardViewSchema,
  deliveryPlanIdSchema,
  deliveryPlanProposalSchema,
  deliveryPlanProposalIdSchema,
  domainEventSchema,
  normalizePlanningCommandSuccess,
  milestoneIdSchema,
  planLabelSchema,
  planTextSchema,
  persistedPlanningCommandSuccessSchema,
  planningCycleViewSchema,
  pmPlanAssignmentSchema,
  pmPlanReportSchema,
  proposalKeySchema,
  proposedDeliveryPlanSchema,
  taskReadinessSchema,
  taskDependencyIdSchema,
  taskIdSchema,
  v2CommandEnvelopeSchema,
  v2CommandResultSchema,
} from './index';

const id = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const issueText = (result: {
  success: boolean;
  error?: { issues: unknown[] };
}) => (result.success ? '' : JSON.stringify(result.error?.issues));
const now = '2026-08-30T12:00:00.000Z';
const projectId = id('1');
const cycleId = id('2');
const humanTurnId = id('3');
const executionId = id('4');
const proposalId = id('5');
const intentId = id('6');
const ledgerId = id('7');
const requirementId = id('8');
const planProposalId = id('9');
const planId = id('10');
const milestoneId = id('11');
const taskId = id('12');
const pmTurnId = id('15');

const legacyLaunchPendingCycle = {
  cycle: {
    id: cycleId,
    projectId,
    lifecycle: 'launch_pending',
    revision: 0,
    profileId: id('13'),
    profileRevision: 1,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 0,
    activeExecutionId: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  },
  turns: [
    {
      id: humanTurnId,
      projectId,
      planningCycleId: cycleId,
      ordinal: 1,
      actor: 'human',
      message: 'Plan Todo.',
      launchState: 'launch_pending',
      executionId: null,
      createdAt: now,
    },
  ],
  questions: [],
  proposals: [],
};

const intentCycle = {
  ...legacyLaunchPendingCycle,
  purpose: {
    kind: 'intent',
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
  deliveryPlanProposals: [],
};

const approvedIntentLedger = {
  projectIntent: {
    id: intentId,
    projectId,
    revision: 1,
    content: {
      goal: 'Track Todo items.',
      targetUsers: ['Operators'],
      desiredCapabilities: ['Create Todo items'],
      constraints: [],
      nonGoals: [],
      successConditions: ['Todo items persist'],
      rationale: 'Approved scope.',
      provenance: [
        {
          kind: 'conversation_turn',
          turnId: humanTurnId,
          rationale: 'Operator request.',
        },
      ],
    },
    proposalId: id('14'),
    approvedBy: 'human',
    approvedAt: now,
  },
  ledger: {
    id: ledgerId,
    projectId,
    revision: 1,
    proposalId: id('14'),
    approvedBy: 'human',
    approvedAt: now,
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
        statement: 'Persist Todo items.',
        rationale: 'Core behavior.',
      },
      provenance: [
        {
          kind: 'conversation_turn',
          turnId: humanTurnId,
          rationale: 'Operator request.',
        },
      ],
      proposalId: id('14'),
      approvedBy: 'human',
      approvedAt: now,
    },
  ],
  relationships: [],
};

const proposedPlan = {
  summary: 'Deliver Todo in one milestone.',
  milestones: [
    {
      operation: 'create',
      key: 'todo-milestone',
      content: {
        title: 'Todo milestone',
        outcome: 'Todo works.',
        stopCondition: 'Todo persists.',
        exclusions: [],
        ordinal: 1,
      },
    },
  ],
  tasks: [
    {
      operation: 'create',
      key: 'persist-todo',
      content: {
        milestone: { kind: 'proposal', key: 'todo-milestone' },
        title: 'Persist Todo',
        outcome: 'Todo survives refresh.',
        acceptanceCriteria: ['Todo is restored.'],
        verificationCriteria: ['Run the Todo test.'],
        priority: 'must',
        labels: ['persistence'],
        ownedSurfaces: ['Todo storage'],
        prohibitedSurfaces: [],
        expectedArtifacts: ['Storage implementation'],
        ordinal: 1,
      },
    },
  ],
  dependencies: [],
  traces: [
    {
      kind: 'milestone_covers',
      milestone: { kind: 'proposal', key: 'todo-milestone' },
      requirement: { recordId: requirementId, recordRevision: 1 },
    },
    {
      kind: 'task_satisfies',
      task: { kind: 'proposal', key: 'persist-todo' },
      requirement: { recordId: requirementId, recordRevision: 1 },
    },
  ],
};

const pendingPlanProposal = {
  id: planProposalId,
  projectId,
  planningCycleId: cycleId,
  revision: 1,
  lifecycle: 'awaiting_approval',
  base: {
    projectIntentId: intentId,
    projectIntentRevision: 1,
    ledgerId,
    ledgerRevision: 1,
    deliveryPlan: { id: null, revision: null },
  },
  proposedPlan,
  reservations: {
    milestones: [{ key: 'todo-milestone', id: milestoneId }],
    tasks: [{ key: 'persist-todo', id: taskId }],
    dependencies: [],
  },
  diff: {
    milestones: { create: 1, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
    tasks: { create: 1, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
    dependencies: { create: 0, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
    traceCreateCount: 2,
    traceRemoveCount: 0,
  },
  createdByTurnId: pmTurnId,
  createdByExecutionId: executionId,
  createdAt: now,
  decision: { kind: 'pending' },
};

const deliveryPlanCycle = {
  cycle: {
    ...legacyLaunchPendingCycle.cycle,
    lifecycle: 'awaiting_approval',
    revision: 2,
    baseProjectIntentRevision: 1,
    baseLedgerRevision: 1,
    latestProposalRevision: 1,
  },
  purpose: {
    kind: 'delivery_plan',
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
  turns: [
    {
      ...legacyLaunchPendingCycle.turns[0],
      launchState: 'execution_bound',
      executionId,
    },
    {
      id: pmTurnId,
      projectId,
      planningCycleId: cycleId,
      ordinal: 2,
      actor: 'pm',
      message: 'Proposed Todo plan.',
      launchState: null,
      executionId,
      createdAt: now,
    },
  ],
  questions: [],
  proposals: [],
  deliveryPlanProposals: [pendingPlanProposal],
};

const emptyBoard = {
  projectId,
  deliveryPlanRevision: null,
  stale: false,
  emptyReason: 'planning_required',
  filter: null,
  totalTaskCount: 0,
  matchedTaskCount: 0,
  facets: {
    milestones: [],
    taskLifecycles: [],
    readiness: [],
    priorities: [],
    labels: [],
    requirements: [],
  },
  cards: [],
};

const activeBoard = {
  projectId,
  deliveryPlanRevision: 1,
  stale: false,
  emptyReason: null,
  filter: {
    projectId,
    revision: 1,
    milestoneIds: [],
    taskLifecycles: ['pending', 'completed'],
    readiness: [],
    priorities: [],
    labels: [],
    requirementRecordIds: [],
    updatedAt: now,
  },
  totalTaskCount: 1,
  matchedTaskCount: 1,
  facets: {
    milestones: [
      {
        value: milestoneId,
        label: 'Todo milestone',
        selected: false,
        matchingTaskCount: 1,
        milestoneRevision: 1,
        lifecycle: 'active',
        historical: false,
      },
    ],
    taskLifecycles: [
      {
        value: 'pending',
        label: 'Pending',
        selected: true,
        matchingTaskCount: 1,
      },
      {
        value: 'completed',
        label: 'Completed',
        selected: true,
        matchingTaskCount: 0,
      },
      {
        value: 'retired',
        label: 'Retired',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    readiness: [
      {
        value: 'actionable',
        label: 'Actionable',
        selected: false,
        matchingTaskCount: 1,
      },
      {
        value: 'blocked',
        label: 'Blocked',
        selected: false,
        matchingTaskCount: 0,
      },
      {
        value: 'inactive',
        label: 'Inactive',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    priorities: [
      { value: 'must', label: 'Must', selected: false, matchingTaskCount: 1 },
      {
        value: 'should',
        label: 'Should',
        selected: false,
        matchingTaskCount: 0,
      },
      { value: 'could', label: 'Could', selected: false, matchingTaskCount: 0 },
    ],
    labels: [
      {
        value: 'persistence',
        label: 'persistence',
        selected: false,
        matchingTaskCount: 1,
        historical: false,
      },
      {
        value: 'ui',
        label: 'ui',
        selected: false,
        matchingTaskCount: 0,
        historical: false,
      },
    ],
    requirements: [
      {
        value: requirementId,
        label: 'Persist Todo items.',
        selected: false,
        matchingTaskCount: 1,
        recordRevision: 1,
        requirementKind: 'functional',
        historical: false,
      },
    ],
  },
  cards: [
    {
      taskId,
      taskContractRevision: 1,
      taskCurrentRevision: 1,
      milestoneId,
      milestoneRevision: 1,
      title: 'Persist Todo',
      outcome: 'Todo survives refresh.',
      lifecycle: 'pending',
      priority: 'must',
      labels: ['persistence'],
      readiness: { state: 'actionable', blockers: [] },
      dependencies: [],
      detail: {
        acceptanceCriteria: ['Todo is restored.'],
        verificationCriteria: ['Run the Todo test.'],
        ownedSurfaces: ['Todo storage'],
        prohibitedSurfaces: [],
        expectedArtifacts: ['Storage implementation'],
        milestoneOutcome: 'Todo works.',
        milestoneStopCondition: 'Todo persists.',
        milestoneExclusions: [],
        requirementTraces: [
          {
            recordId: requirementId,
            recordRevision: 1,
            title: 'Persist Todo items.',
          },
        ],
      },
    },
  ],
};

const terminalPlanProposal = {
  ...pendingPlanProposal,
  lifecycle: 'approved',
  decision: { kind: 'approved', decidedBy: 'human', decidedAt: now },
};

const approvedPlanCycle = {
  ...deliveryPlanCycle,
  cycle: {
    ...deliveryPlanCycle.cycle,
    lifecycle: 'approved',
    endedAt: now,
  },
  deliveryPlanProposals: [terminalPlanProposal],
};

const approvedDeliveryPlan = {
  plan: {
    id: planId,
    projectId,
    revision: 1,
    projectIntentId: intentId,
    projectIntentRevision: 1,
    ledgerId,
    ledgerRevision: 1,
    baseDeliveryPlanRevision: null,
    proposalId: planProposalId,
    summary: proposedPlan.summary,
    approvedBy: 'human',
    approvedAt: now,
  },
  milestones: [
    {
      id: milestoneId,
      projectId,
      revision: 1,
      lifecycle: 'active',
      ...proposedPlan.milestones[0].content,
      proposalId: planProposalId,
      deliveryPlanRevision: 1,
      approvedAt: now,
    },
  ],
  taskContracts: [
    {
      id: taskId,
      projectId,
      revision: 1,
      contractRevision: 1,
      revisionKind: 'plan_contract',
      lifecycle: 'pending',
      milestoneId,
      title: proposedPlan.tasks[0].content.title,
      outcome: proposedPlan.tasks[0].content.outcome,
      acceptanceCriteria: proposedPlan.tasks[0].content.acceptanceCriteria,
      verificationCriteria: proposedPlan.tasks[0].content.verificationCriteria,
      priority: proposedPlan.tasks[0].content.priority,
      labels: proposedPlan.tasks[0].content.labels,
      ownedSurfaces: proposedPlan.tasks[0].content.ownedSurfaces,
      prohibitedSurfaces: proposedPlan.tasks[0].content.prohibitedSurfaces,
      expectedArtifacts: proposedPlan.tasks[0].content.expectedArtifacts,
      ordinal: 1,
      source: {
        kind: 'plan',
        proposalId: planProposalId,
        deliveryPlanRevision: 1,
      },
      createdAt: now,
    },
  ],
  dependencies: [],
  traces: [
    {
      kind: 'milestone_covers',
      milestoneId,
      milestoneRevision: 1,
      requirement: { recordId: requirementId, recordRevision: 1 },
    },
    {
      kind: 'task_satisfies',
      taskId,
      taskContractRevision: 1,
      requirement: { recordId: requirementId, recordRevision: 1 },
    },
  ],
  milestoneDependencies: [],
};

describe('planning and Board contracts', () => {
  it('brands every planning identity and enforces scalar and collection bounds', () => {
    for (const schema of [
      deliveryPlanIdSchema,
      deliveryPlanProposalIdSchema,
      milestoneIdSchema,
      taskIdSchema,
      taskDependencyIdSchema,
    ]) {
      expect(schema.safeParse(id('40')).success).toBe(true);
      expect(schema.safeParse('not-a-uuid').success).toBe(false);
    }
    expect(proposalKeySchema.safeParse('todo-task-1').success).toBe(true);
    expect(proposalKeySchema.safeParse('Todo_task').success).toBe(false);
    expect(planTextSchema.safeParse('x'.repeat(4096)).success).toBe(true);
    expect(planTextSchema.safeParse('x'.repeat(4097)).success).toBe(false);
    expect(planLabelSchema.safeParse('x'.repeat(64)).success).toBe(true);
    expect(planLabelSchema.safeParse('x'.repeat(65)).success).toBe(false);
    for (const candidate of [
      {
        ...proposedPlan,
        milestones: Array(21).fill(proposedPlan.milestones[0]),
      },
      { ...proposedPlan, tasks: Array(101).fill(proposedPlan.tasks[0]) },
      {
        ...proposedPlan,
        dependencies: Array(201).fill({
          operation: 'create',
          key: 'edge',
          prerequisite: { kind: 'proposal', key: 'persist-todo' },
          dependent: { kind: 'proposal', key: 'persist-todo' },
        }),
      },
      { ...proposedPlan, traces: Array(301).fill(proposedPlan.traces[0]) },
    ]) {
      expect(proposedDeliveryPlanSchema.safeParse(candidate).success).toBe(
        false,
      );
    }
    expect(
      boardViewSchema.safeParse({
        ...activeBoard,
        cards: Array(101).fill(activeBoard.cards[0]),
        matchedTaskCount: 100,
      }).success,
    ).toBe(false);
  });

  it('parses strict purpose-aware cycle views and forbids cross-purpose proposals', () => {
    expect(planningCycleViewSchema.parse(intentCycle).purpose.kind).toBe(
      'intent',
    );
    expect(
      planningCycleViewSchema.safeParse({
        ...intentCycle,
        deliveryPlanProposals: [{}],
      }).success,
    ).toBe(false);
    expect(
      planningCycleViewSchema.safeParse({
        ...intentCycle,
        workspaceId: id('99'),
      }).success,
    ).toBe(false);
    expect(planningCycleViewSchema.parse(deliveryPlanCycle)).toEqual(
      deliveryPlanCycle,
    );
    expect(
      planningCycleViewSchema.safeParse({
        ...deliveryPlanCycle,
        deliveryPlanProposals: [
          {
            ...pendingPlanProposal,
            lifecycle: 'superseded',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('validates bounded proposal references, unique keys, and complete trace inputs', () => {
    expect(proposedDeliveryPlanSchema.parse(proposedPlan)).toEqual(
      proposedPlan,
    );
    expect(
      proposedDeliveryPlanSchema.safeParse({
        ...proposedPlan,
        tasks: [
          proposedPlan.tasks[0],
          { ...proposedPlan.tasks[0], key: 'persist-todo' },
        ],
      }).success,
    ).toBe(false);
    expect(
      proposedDeliveryPlanSchema.safeParse({
        ...proposedPlan,
        tasks: [
          {
            ...proposedPlan.tasks[0],
            content: {
              ...proposedPlan.tasks[0].content,
              milestone: { kind: 'proposal', key: 'missing' },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      proposedDeliveryPlanSchema.safeParse({ ...proposedPlan, traces: [] })
        .success,
    ).toBe(false);
  });

  it('binds pm_plan assignments and strict reports without provider session fields', () => {
    const assignment = {
      kind: 'pm_plan',
      projectId,
      outputSchema: PM_PLAN_REPORT_SCHEMA,
      planningCycleId: cycleId,
      humanTurnId,
      expectedCycleRevision: 0,
      expectedProposalRevision: 1,
      baseProjectIntentId: intentId,
      baseProjectIntentRevision: 1,
      baseLedgerId: ledgerId,
      baseLedgerRevision: 1,
      baseDeliveryPlanId: null,
      baseDeliveryPlanRevision: null,
      input: {
        conversation: [
          { turnId: humanTurnId, actor: 'human', message: 'Plan Todo.' },
        ],
        approvedIntentLedger,
        latestProposal: null,
        approvedDeliveryPlan: null,
      },
    };
    expect(pmPlanAssignmentSchema.parse(assignment)).toEqual(assignment);
    const approvedDeliveryPlan = {
      plan: {
        id: planId,
        projectId,
        revision: 1,
        projectIntentId: intentId,
        projectIntentRevision: 1,
        ledgerId,
        ledgerRevision: 1,
        baseDeliveryPlanRevision: null,
        proposalId: planProposalId,
        summary: 'Approved empty plan.',
        approvedBy: 'human',
        approvedAt: now,
      },
      milestones: [],
      taskContracts: [],
      dependencies: [],
      traces: [],
      milestoneDependencies: [],
    };
    const assignmentWithPlan = {
      ...assignment,
      baseDeliveryPlanId: planId,
      baseDeliveryPlanRevision: 1,
      input: { ...assignment.input, approvedDeliveryPlan },
    };
    expect(pmPlanAssignmentSchema.parse(assignmentWithPlan)).toEqual(
      assignmentWithPlan,
    );
    expect(
      pmPlanAssignmentSchema.safeParse({
        ...assignmentWithPlan,
        input: {
          ...assignmentWithPlan.input,
          approvedDeliveryPlan: {
            ...approvedDeliveryPlan,
            plan: { ...approvedDeliveryPlan.plan, projectId: id('90') },
          },
        },
      }).success,
    ).toBe(false);
    for (const plan of [
      {
        ...approvedDeliveryPlan.plan,
        projectIntentId: id('91'),
      },
      {
        ...approvedDeliveryPlan.plan,
        projectIntentRevision: 2,
      },
      { ...approvedDeliveryPlan.plan, ledgerId: id('92') },
      { ...approvedDeliveryPlan.plan, ledgerRevision: 2 },
    ]) {
      expect(
        pmPlanAssignmentSchema.safeParse({
          ...assignmentWithPlan,
          input: {
            ...assignmentWithPlan.input,
            approvedDeliveryPlan: { ...approvedDeliveryPlan, plan },
          },
        }).success,
      ).toBe(false);
    }
    expect(
      pmPlanAssignmentSchema.safeParse({
        ...assignment,
        nativeHandle: 'resume',
      }).success,
    ).toBe(false);
    expect(
      pmPlanReportSchema.parse({
        schema: PM_PLAN_REPORT_SCHEMA,
        planningCycleId: cycleId,
        humanTurnId,
        expectedCycleRevision: 0,
        expectedProposalRevision: 1,
        assistantMessage: 'Proposed Todo plan.',
        result: { kind: 'plan_proposal', proposal: proposedPlan },
      }).result.kind,
    ).toBe('plan_proposal');
    expect(
      pmPlanReportSchema.safeParse({
        schema: PM_PLAN_REPORT_SCHEMA,
        planningCycleId: cycleId,
        humanTurnId,
        expectedCycleRevision: 0,
        expectedProposalRevision: 1,
        assistantMessage: 'Questions.',
        result: {
          kind: 'questions',
          questions: [
            { key: 'scope', prompt: 'Which scope?', rationale: 'Needed.' },
            { key: 'scope', prompt: 'Which scope?', rationale: 'Needed.' },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('validates revision proposal diffs against the frozen approved plan', () => {
    const secondMilestoneId = id('70');
    const secondTaskId = id('71');
    const dependencyId = id('72');
    const approvedPlanWithDependency = {
      ...approvedDeliveryPlan,
      milestones: [
        approvedDeliveryPlan.milestones[0],
        {
          ...approvedDeliveryPlan.milestones[0],
          id: secondMilestoneId,
          title: 'Todo UI milestone',
          ordinal: 2,
        },
      ],
      taskContracts: [
        approvedDeliveryPlan.taskContracts[0],
        {
          ...approvedDeliveryPlan.taskContracts[0],
          id: secondTaskId,
          milestoneId: secondMilestoneId,
          title: 'Render Todo',
        },
      ],
      dependencies: [
        {
          id: dependencyId,
          projectId,
          revision: 1,
          prerequisiteTaskId: taskId,
          dependentTaskId: secondTaskId,
          lifecycle: 'active',
          proposalId: planProposalId,
          deliveryPlanRevision: 1,
          approvedAt: now,
        },
      ],
      traces: [
        ...approvedDeliveryPlan.traces,
        {
          kind: 'milestone_covers',
          milestoneId: secondMilestoneId,
          milestoneRevision: 1,
          requirement: { recordId: requirementId, recordRevision: 1 },
        },
        {
          kind: 'task_satisfies',
          taskId: secondTaskId,
          taskContractRevision: 1,
          requirement: { recordId: requirementId, recordRevision: 1 },
        },
      ],
      milestoneDependencies: [
        {
          prerequisiteMilestoneId: milestoneId,
          dependentMilestoneId: secondMilestoneId,
          throughTaskDependencyIds: [dependencyId],
        },
      ],
    };
    const revisionProposal = {
      ...pendingPlanProposal,
      base: {
        ...pendingPlanProposal.base,
        deliveryPlan: { id: planId, revision: 1 },
      },
      proposedPlan: {
        summary: 'Reuse the approved Todo plan.',
        milestones: [
          {
            operation: 'reuse',
            milestoneId,
            expectedRevision: 1,
          },
          {
            operation: 'reuse',
            milestoneId: secondMilestoneId,
            expectedRevision: 1,
          },
        ],
        tasks: [
          {
            operation: 'reuse',
            taskId,
            expectedContractRevision: 1,
            expectedCurrentRevision: 1,
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
            operation: 'reuse',
            dependencyId,
            expectedRevision: 1,
          },
        ],
        traces: [
          {
            kind: 'milestone_covers',
            milestone: { kind: 'canonical', milestoneId },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
          {
            kind: 'task_satisfies',
            task: { kind: 'canonical', taskId },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
          {
            kind: 'milestone_covers',
            milestone: { kind: 'canonical', milestoneId: secondMilestoneId },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
          {
            kind: 'task_satisfies',
            task: { kind: 'canonical', taskId: secondTaskId },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
        ],
      },
      reservations: { milestones: [], tasks: [], dependencies: [] },
      diff: {
        milestones: {
          create: 0,
          reuse: 2,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        tasks: {
          create: 0,
          reuse: 2,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        dependencies: {
          create: 0,
          reuse: 1,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        traceCreateCount: 0,
        traceRemoveCount: 0,
      },
    };
    const assignment = {
      kind: 'pm_plan',
      projectId,
      outputSchema: PM_PLAN_REPORT_SCHEMA,
      planningCycleId: cycleId,
      humanTurnId,
      expectedCycleRevision: 2,
      expectedProposalRevision: 2,
      baseProjectIntentId: intentId,
      baseProjectIntentRevision: 1,
      baseLedgerId: ledgerId,
      baseLedgerRevision: 1,
      baseDeliveryPlanId: planId,
      baseDeliveryPlanRevision: 1,
      input: {
        conversation: [
          { turnId: humanTurnId, actor: 'human', message: 'Revise Todo.' },
        ],
        approvedIntentLedger,
        latestProposal: revisionProposal,
        approvedDeliveryPlan: approvedPlanWithDependency,
      },
    };
    expect(pmPlanAssignmentSchema.parse(assignment)).toEqual(assignment);
    for (const diff of [
      {
        ...revisionProposal.diff,
        milestones: { ...revisionProposal.diff.milestones, reuse: 0 },
      },
      { ...revisionProposal.diff, traceRemoveCount: 1 },
    ]) {
      expect(
        pmPlanAssignmentSchema.safeParse({
          ...assignment,
          input: {
            ...assignment.input,
            latestProposal: { ...revisionProposal, diff },
          },
        }).success,
      ).toBe(false);
    }

    const withoutSecondMilestone = {
      ...revisionProposal.proposedPlan,
      milestones: revisionProposal.proposedPlan.milestones.slice(0, 1),
      traces: revisionProposal.proposedPlan.traces.filter(
        (trace) =>
          trace.kind !== 'milestone_covers' ||
          trace.milestone.milestoneId !== secondMilestoneId,
      ),
    };
    const withoutSecondTask = {
      ...revisionProposal.proposedPlan,
      tasks: revisionProposal.proposedPlan.tasks.slice(0, 1),
      traces: revisionProposal.proposedPlan.traces.filter(
        (trace) =>
          trace.kind !== 'task_satisfies' || trace.task.taskId !== secondTaskId,
      ),
    };
    for (const [proposedPlan, diff] of [
      [
        withoutSecondMilestone,
        {
          ...revisionProposal.diff,
          milestones: { ...revisionProposal.diff.milestones, reuse: 1 },
          traceRemoveCount: 1,
        },
      ],
      [
        withoutSecondTask,
        {
          ...revisionProposal.diff,
          tasks: { ...revisionProposal.diff.tasks, reuse: 1 },
          traceRemoveCount: 1,
        },
      ],
      [
        { ...revisionProposal.proposedPlan, dependencies: [] },
        {
          ...revisionProposal.diff,
          dependencies: { ...revisionProposal.diff.dependencies, reuse: 0 },
        },
      ],
    ] as const) {
      expect(
        pmPlanAssignmentSchema.safeParse({
          ...assignment,
          input: {
            ...assignment.input,
            latestProposal: { ...revisionProposal, proposedPlan, diff },
          },
        }).success,
      ).toBe(false);
    }

    const inventedMilestoneId = id('75');
    const inventedTaskId = id('76');
    const inventedDependencyId = id('77');
    for (const proposedPlan of [
      {
        ...revisionProposal.proposedPlan,
        milestones: revisionProposal.proposedPlan.milestones.map((milestone) =>
          milestone.milestoneId === secondMilestoneId
            ? { ...milestone, milestoneId: inventedMilestoneId }
            : milestone,
        ),
        traces: revisionProposal.proposedPlan.traces.map((trace) =>
          trace.kind === 'milestone_covers' &&
          trace.milestone.milestoneId === secondMilestoneId
            ? {
                ...trace,
                milestone: {
                  kind: 'canonical' as const,
                  milestoneId: inventedMilestoneId,
                },
              }
            : trace,
        ),
      },
      {
        ...revisionProposal.proposedPlan,
        tasks: revisionProposal.proposedPlan.tasks.map((task) =>
          task.taskId === secondTaskId
            ? { ...task, taskId: inventedTaskId }
            : task,
        ),
        traces: revisionProposal.proposedPlan.traces.map((trace) =>
          trace.kind === 'task_satisfies' && trace.task.taskId === secondTaskId
            ? {
                ...trace,
                task: { kind: 'canonical' as const, taskId: inventedTaskId },
              }
            : trace,
        ),
      },
      {
        ...revisionProposal.proposedPlan,
        dependencies: revisionProposal.proposedPlan.dependencies.map(
          (dependency) => ({
            ...dependency,
            dependencyId: inventedDependencyId,
          }),
        ),
      },
    ]) {
      expect(
        pmPlanAssignmentSchema.safeParse({
          ...assignment,
          input: {
            ...assignment.input,
            latestProposal: { ...revisionProposal, proposedPlan },
          },
        }).success,
      ).toBe(false);
    }

    const retiredDependencyProposal = {
      ...revisionProposal,
      proposedPlan: {
        ...revisionProposal.proposedPlan,
        dependencies: [
          {
            operation: 'revise',
            dependencyId,
            expectedRevision: 1,
            lifecycle: 'retired',
          },
        ],
      },
      diff: {
        ...revisionProposal.diff,
        dependencies: {
          create: 0,
          reuse: 0,
          revise: 0,
          retire: 1,
          reactivate: 0,
        },
      },
    };
    expect(
      pmPlanAssignmentSchema.safeParse({
        ...assignment,
        input: {
          ...assignment.input,
          latestProposal: retiredDependencyProposal,
        },
      }).success,
    ).toBe(true);
    expect(
      pmPlanAssignmentSchema.safeParse({
        ...assignment,
        input: {
          ...assignment.input,
          latestProposal: {
            ...retiredDependencyProposal,
            proposedPlan: {
              ...retiredDependencyProposal.proposedPlan,
              dependencies: [
                {
                  ...retiredDependencyProposal.proposedPlan.dependencies[0],
                  prerequisite: { kind: 'canonical', taskId: secondTaskId },
                  dependent: { kind: 'canonical', taskId },
                },
              ],
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('validates effective ordinals against the frozen approved plan', () => {
    const secondMilestoneId = id('73');
    const secondTaskId = id('74');
    const ordinalProposal = {
      ...pendingPlanProposal,
      base: {
        ...pendingPlanProposal.base,
        deliveryPlan: { id: planId, revision: 1 },
      },
      proposedPlan: {
        summary: 'Extend the approved Todo plan.',
        milestones: [
          {
            operation: 'reuse',
            milestoneId,
            expectedRevision: 1,
          },
          {
            operation: 'create',
            key: 'second-milestone',
            content: {
              ...proposedPlan.milestones[0].content,
              title: 'Todo UI milestone',
              ordinal: 2,
            },
          },
        ],
        tasks: [
          {
            operation: 'reuse',
            taskId,
            expectedContractRevision: 1,
            expectedCurrentRevision: 1,
          },
          {
            operation: 'create',
            key: 'second-task',
            content: {
              ...proposedPlan.tasks[0].content,
              milestone: { kind: 'canonical', milestoneId },
              title: 'Render Todo',
              ordinal: 2,
            },
          },
        ],
        dependencies: [],
        traces: [
          ...pendingPlanProposal.proposedPlan.traces.map((trace) =>
            trace.kind === 'milestone_covers'
              ? {
                  ...trace,
                  milestone: { kind: 'canonical', milestoneId },
                }
              : { ...trace, task: { kind: 'canonical', taskId } },
          ),
          {
            kind: 'milestone_covers',
            milestone: { kind: 'proposal', key: 'second-milestone' },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
          {
            kind: 'task_satisfies',
            task: { kind: 'proposal', key: 'second-task' },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
        ],
      },
      reservations: {
        milestones: [{ key: 'second-milestone', id: secondMilestoneId }],
        tasks: [{ key: 'second-task', id: secondTaskId }],
        dependencies: [],
      },
      diff: {
        milestones: {
          create: 1,
          reuse: 1,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        tasks: {
          create: 1,
          reuse: 1,
          revise: 0,
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
        traceRemoveCount: 0,
      },
    };
    const assignment = {
      kind: 'pm_plan',
      projectId,
      outputSchema: PM_PLAN_REPORT_SCHEMA,
      planningCycleId: cycleId,
      humanTurnId,
      expectedCycleRevision: 2,
      expectedProposalRevision: 2,
      baseProjectIntentId: intentId,
      baseProjectIntentRevision: 1,
      baseLedgerId: ledgerId,
      baseLedgerRevision: 1,
      baseDeliveryPlanId: planId,
      baseDeliveryPlanRevision: 1,
      input: {
        conversation: [
          { turnId: humanTurnId, actor: 'human', message: 'Extend Todo.' },
        ],
        approvedIntentLedger,
        latestProposal: ordinalProposal,
        approvedDeliveryPlan,
      },
    };
    expect(pmPlanAssignmentSchema.safeParse(assignment).success).toBe(true);

    for (const [collection, ordinal] of [
      ['milestones', 1],
      ['milestones', 3],
      ['tasks', 1],
      ['tasks', 3],
    ] as const) {
      const members = ordinalProposal.proposedPlan[collection];
      expect(
        pmPlanAssignmentSchema.safeParse({
          ...assignment,
          input: {
            ...assignment.input,
            latestProposal: {
              ...ordinalProposal,
              proposedPlan: {
                ...ordinalProposal.proposedPlan,
                [collection]: [
                  members[0],
                  {
                    ...members[1],
                    content: { ...members[1].content, ordinal },
                  },
                ],
              },
            },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('parses complete Board projections and rejects incoherent counts and extra run fields', () => {
    expect(boardViewSchema.parse(emptyBoard)).toEqual(emptyBoard);
    expect(boardViewSchema.parse(activeBoard)).toEqual(activeBoard);
    expect(
      boardViewSchema.safeParse({ ...emptyBoard, matchedTaskCount: 1 }).success,
    ).toBe(false);
    expect(
      boardViewSchema.safeParse({
        ...activeBoard,
        facets: {
          ...activeBoard.facets,
          labels: [...activeBoard.facets.labels].reverse(),
        },
      }).success,
    ).toBe(false);
    expect(
      boardViewSchema.safeParse({ ...activeBoard, emptyReason: 'filter_empty' })
        .success,
    ).toBe(false);
    expect(
      boardViewSchema.safeParse({ ...emptyBoard, executionRunId: id('98') })
        .success,
    ).toBe(false);
    expect(
      taskReadinessSchema.safeParse({
        state: 'inactive',
        blockers: [
          {
            kind: 'dependency_incomplete',
            dependencyId: id('90'),
            prerequisiteTaskId: id('91'),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts normalizable command filters but requires canonical stored filters', () => {
    const normalizableSelection = {
      milestoneIds: [id('42'), id('41'), id('42')],
      taskLifecycles: ['completed', 'pending', 'completed'],
      readiness: ['inactive', 'actionable', 'inactive'],
      priorities: ['could', 'must', 'could'],
      labels: ['zeta', 'alpha', 'zeta'],
      requirementRecordIds: [id('44'), id('43'), id('44')],
    };
    expect(boardFilterSelectionSchema.parse(normalizableSelection)).toEqual(
      normalizableSelection,
    );
    expect(
      v2CommandEnvelopeSchema.parse({
        idempotencyKey: 'normalizable-board-filter',
        actor: { kind: 'human' },
        command: {
          type: 'board_filter.set',
          projectId,
          expectedFilterRevision: 1,
          filter: normalizableSelection,
        },
      }).command,
    ).toMatchObject({ filter: normalizableSelection });
    expect(
      boardFilterSchema.safeParse({
        projectId,
        revision: 1,
        ...normalizableSelection,
        updatedAt: now,
      }).success,
    ).toBe(false);
  });

  it('binds Board task lifecycle to deterministic readiness', () => {
    const card = activeBoard.cards[0];
    expect(
      boardTaskCardSchema.safeParse({ ...card, lifecycle: 'completed' })
        .success,
    ).toBe(false);
    expect(
      boardTaskCardSchema.safeParse({
        ...card,
        lifecycle: 'retired',
        readiness: {
          state: 'blocked',
          blockers: [
            {
              kind: 'dependency_incomplete',
              dependencyId: id('45'),
              prerequisiteTaskId: id('46'),
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      boardTaskCardSchema.safeParse({
        ...card,
        readiness: {
          state: 'inactive',
          blockers: [{ kind: 'task_completed' }],
        },
      }).success,
    ).toBe(false);
    expect(
      boardTaskCardSchema.safeParse({
        ...card,
        lifecycle: 'completed',
        readiness: {
          state: 'inactive',
          blockers: [{ kind: 'milestone_retired', milestoneId: id('47') }],
        },
      }).success,
    ).toBe(false);
    for (const candidate of [
      {
        ...card,
        lifecycle: 'completed',
        readiness: {
          state: 'inactive',
          blockers: [{ kind: 'task_completed' }],
        },
      },
      {
        ...card,
        lifecycle: 'retired',
        readiness: {
          state: 'inactive',
          blockers: [{ kind: 'task_retired' }],
        },
      },
      {
        ...card,
        lifecycle: 'completed',
        readiness: {
          state: 'inactive',
          blockers: [{ kind: 'milestone_retired', milestoneId }],
        },
      },
      {
        ...card,
        lifecycle: 'retired',
        readiness: {
          state: 'inactive',
          blockers: [{ kind: 'milestone_retired', milestoneId }],
        },
      },
    ]) {
      expect(boardTaskCardSchema.safeParse(candidate).success).toBe(true);
    }
  });

  it('requires an exact pre-plan Board empty reason', () => {
    expect(boardViewSchema.parse(emptyBoard)).toEqual(emptyBoard);
    for (const emptyReason of [null, 'plan_empty', 'filter_empty'] as const) {
      expect(
        boardViewSchema.safeParse({ ...emptyBoard, emptyReason }).success,
      ).toBe(false);
    }
    expect(
      boardViewSchema.safeParse({
        ...emptyBoard,
        emptyReason: 'intent_required',
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'milestones',
      { ...activeBoard.facets.milestones[0], matchingTaskCount: 0 },
    ],
    [
      'taskLifecycles',
      {
        value: 'pending',
        label: 'Pending',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    [
      'readiness',
      {
        value: 'actionable',
        label: 'Actionable',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    [
      'priorities',
      {
        value: 'must',
        label: 'Must',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    ['labels', { ...activeBoard.facets.labels[0], matchingTaskCount: 0 }],
    [
      'requirements',
      { ...activeBoard.facets.requirements[0], matchingTaskCount: 0 },
    ],
  ] as const)(
    'requires an empty %s facet before plan approval',
    (facet, option) => {
      expect(
        boardViewSchema.safeParse({
          ...emptyBoard,
          facets: { ...emptyBoard.facets, [facet]: [option] },
        }).success,
      ).toBe(false);
    },
  );

  it('binds Board staleness to deterministic pending readiness', () => {
    const card = activeBoard.cards[0];
    const planStaleReadiness = {
      state: 'blocked',
      blockers: [
        {
          kind: 'plan_stale',
          expectedLedgerRevision: 1,
          actualLedgerRevision: 2,
        },
      ],
    };
    const staleBoard = {
      ...activeBoard,
      stale: true,
      cards: [{ ...card, readiness: planStaleReadiness }],
    };
    expect(boardViewSchema.parse(staleBoard)).toEqual(staleBoard);
    for (const readiness of [
      card.readiness,
      {
        state: 'blocked',
        blockers: [
          {
            kind: 'dependency_incomplete',
            dependencyId: id('48'),
            prerequisiteTaskId: id('49'),
          },
        ],
      },
      { state: 'blocked', blockers: [{ kind: 'plan_not_approved' }] },
    ]) {
      expect(
        boardViewSchema.safeParse({
          ...activeBoard,
          stale: true,
          cards: [{ ...card, readiness }],
        }).success,
      ).toBe(false);
    }
    expect(
      boardViewSchema.safeParse({
        ...activeBoard,
        cards: [{ ...card, readiness: planStaleReadiness }],
      }).success,
    ).toBe(false);
    expect(
      boardViewSchema.safeParse({
        ...activeBoard,
        cards: [
          {
            ...card,
            readiness: {
              state: 'blocked',
              blockers: [{ kind: 'plan_not_approved' }],
            },
          },
        ],
      }).success,
    ).toBe(false);
    for (const [lifecycle, blocker] of [
      ['completed', { kind: 'task_completed' }],
      ['retired', { kind: 'task_retired' }],
      [
        'completed',
        { kind: 'milestone_retired', milestoneId: card.milestoneId },
      ],
    ] as const) {
      expect(
        boardViewSchema.safeParse({
          ...activeBoard,
          stale: true,
          cards: [
            {
              ...card,
              lifecycle,
              readiness: { state: 'inactive', blockers: [blocker] },
            },
          ],
        }).success,
      ).toBe(true);
    }
    expect(
      boardViewSchema.safeParse({ ...emptyBoard, stale: true }).success,
    ).toBe(false);
  });

  it('parses strict plan commands with exact new-cycle bases', () => {
    const envelope = {
      idempotencyKey: 'plan-1',
      actor: { kind: 'human' },
      command: {
        type: 'planning_cycle.submit_plan_turn',
        projectId,
        expectedCycleRevision: null,
        profileId: id('13'),
        profileRevision: 1,
        expectedProjectIntentId: intentId,
        expectedProjectIntentRevision: 1,
        expectedLedgerId: ledgerId,
        expectedLedgerRevision: 1,
        expectedDeliveryPlan: { id: null, revision: null },
        message: 'Plan Todo.',
      },
    };
    expect(v2CommandEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      v2CommandEnvelopeSchema.safeParse({
        ...envelope,
        command: { ...envelope.command, planningCycleId: cycleId },
      }).success,
    ).toBe(false);
    for (const command of [
      {
        type: 'planning_cycle.submit_plan_turn',
        projectId,
        planningCycleId: cycleId,
        expectedCycleRevision: 2,
        message: 'Revise the plan.',
      },
      {
        type: 'plan_proposal.approve',
        projectId,
        planningCycleId: cycleId,
        expectedCycleRevision: 2,
        proposalId: planProposalId,
        expectedProposalRevision: 1,
        expectedProjectIntentId: intentId,
        expectedProjectIntentRevision: 1,
        expectedLedgerId: ledgerId,
        expectedLedgerRevision: 1,
        expectedDeliveryPlan: { id: null, revision: null },
      },
      {
        type: 'plan_proposal.reject',
        projectId,
        planningCycleId: cycleId,
        expectedCycleRevision: 2,
        proposalId: planProposalId,
        expectedProposalRevision: 1,
        feedback: 'Keep the plan smaller.',
      },
      {
        type: 'board_filter.set',
        projectId,
        expectedFilterRevision: 1,
        filter: activeBoard.filter,
      },
    ]) {
      const strictCommand =
        command.type === 'board_filter.set'
          ? {
              ...command,
              filter: {
                milestoneIds: [],
                taskLifecycles: ['pending', 'completed'],
                readiness: [],
                priorities: [],
                labels: [],
                requirementRecordIds: [],
              },
            }
          : command;
      expect(
        v2CommandEnvelopeSchema.parse({
          idempotencyKey: `command-${command.type}`,
          actor: { kind: 'human' },
          command: strictCommand,
        }).command.type,
      ).toBe(command.type);
    }
  });

  it('preserves byte-shaped M2 event and result alternatives exactly', () => {
    const seededEvent = JSON.parse(
      JSON.stringify({
        id: id('20'),
        projectId,
        sequence: 7,
        occurredAt: now,
        type: 'planning_cycle.changed',
        payload: { planningCycle: legacyLaunchPendingCycle },
      }),
    );
    const seededResult = JSON.parse(
      JSON.stringify({
        ok: true,
        commandType: 'planning_cycle.submit_turn',
        planningCycle: legacyLaunchPendingCycle,
      }),
    );
    expect(domainEventSchema.parse(seededEvent)).toEqual(seededEvent);
    expect(persistedPlanningCommandSuccessSchema.parse(seededResult)).toEqual(
      seededResult,
    );
    const eventBytes = JSON.stringify(seededEvent);
    const resultBytes = JSON.stringify(seededResult);
    domainEventSchema.parse(seededEvent);
    persistedPlanningCommandSuccessSchema.parse(seededResult);
    expect(JSON.stringify(seededEvent)).toBe(eventBytes);
    expect(JSON.stringify(seededResult)).toBe(resultBytes);
    expect(
      domainEventSchema.safeParse({
        ...seededEvent,
        payload: { ...seededEvent.payload, board: emptyBoard },
      }).success,
    ).toBe(false);
    expect(
      persistedPlanningCommandSuccessSchema.safeParse({
        ...seededResult,
        purpose: 'intent',
      }).success,
    ).toBe(false);
  });

  it('tags legacy success normalization as receipt-only and never invents authority', () => {
    const raw = persistedPlanningCommandSuccessSchema.parse({
      ok: true,
      commandType: 'planning_cycle.submit_turn',
      planningCycle: legacyLaunchPendingCycle,
    });
    const normalized = normalizePlanningCommandSuccess(raw);
    expect(normalized.source).toBe('legacy_m2');
    expect(normalized.projectionAuthority).toBe('receipt_only');
    expect(normalized.result.schemaVersion).toBe(2);
    expect(normalized.result.planningCycle.purpose.kind).toBe('intent');
  });

  it('requires explicit versions for all new event and command-result writes', () => {
    const event = {
      id: id('21'),
      projectId,
      sequence: 8,
      occurredAt: now,
      type: 'planning_cycle.changed',
      payload: { schemaVersion: 2, planningCycle: intentCycle },
    };
    expect(domainEventSchema.parse(event)).toEqual(event);
    expect(
      domainEventSchema.safeParse({
        ...event,
        payload: { planningCycle: intentCycle },
      }).success,
    ).toBe(false);
    expect(
      v2CommandResultSchema.parse({
        ok: true,
        schemaVersion: 2,
        commandType: 'planning_cycle.submit_turn',
        planningCycle: intentCycle,
      }).schemaVersion,
    ).toBe(2);
    expect(
      v2CommandResultSchema.safeParse({
        ok: true,
        schemaVersion: 3,
        commandType: 'planning_cycle.submit_turn',
        planningCycle: intentCycle,
      }).success,
    ).toBe(false);
  });

  it('rejects canonical operations and references without a plan base', () => {
    const canonicalMilestone = {
      operation: 'reuse',
      milestoneId: id('60'),
      expectedRevision: 1,
    };
    const canonicalTask = {
      operation: 'reuse',
      taskId: id('61'),
      expectedContractRevision: 1,
      expectedCurrentRevision: 1,
    };
    const canonicalDependency = {
      operation: 'reuse',
      dependencyId: id('62'),
      expectedRevision: 1,
    };
    for (const proposedPlan of [
      {
        ...pendingPlanProposal.proposedPlan,
        milestones: [
          ...pendingPlanProposal.proposedPlan.milestones,
          canonicalMilestone,
        ],
      },
      {
        ...pendingPlanProposal.proposedPlan,
        milestones: [
          ...pendingPlanProposal.proposedPlan.milestones,
          {
            operation: 'revise',
            milestoneId: id('60'),
            expectedRevision: 1,
            lifecycle: 'retired',
            content: {
              ...pendingPlanProposal.proposedPlan.milestones[0].content,
              ordinal: 2,
            },
          },
        ],
      },
      {
        ...pendingPlanProposal.proposedPlan,
        tasks: [...pendingPlanProposal.proposedPlan.tasks, canonicalTask],
      },
      {
        ...pendingPlanProposal.proposedPlan,
        milestones: [
          ...pendingPlanProposal.proposedPlan.milestones,
          canonicalMilestone,
        ],
        tasks: [
          ...pendingPlanProposal.proposedPlan.tasks,
          {
            operation: 'revise',
            taskId: id('61'),
            expectedContractRevision: 1,
            expectedCurrentRevision: 1,
            lifecycle: 'retired',
            content: {
              ...pendingPlanProposal.proposedPlan.tasks[0].content,
              milestone: { kind: 'canonical', milestoneId: id('60') },
              ordinal: 2,
            },
          },
        ],
      },
      {
        ...pendingPlanProposal.proposedPlan,
        dependencies: [canonicalDependency],
      },
      {
        ...pendingPlanProposal.proposedPlan,
        dependencies: [
          {
            operation: 'revise',
            dependencyId: id('62'),
            expectedRevision: 1,
            lifecycle: 'retired',
          },
        ],
      },
      {
        ...pendingPlanProposal.proposedPlan,
        dependencies: [
          {
            operation: 'create',
            key: 'canonical-edge',
            prerequisite: { kind: 'canonical', taskId: id('63') },
            dependent: { kind: 'proposal', key: 'persist-todo' },
          },
        ],
      },
      {
        ...pendingPlanProposal.proposedPlan,
        traces: [
          ...pendingPlanProposal.proposedPlan.traces,
          {
            kind: 'task_satisfies',
            task: { kind: 'canonical', taskId: id('64') },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
        ],
      },
    ]) {
      const candidate = {
        ...pendingPlanProposal,
        proposedPlan,
        reservations: {
          ...pendingPlanProposal.reservations,
          dependencies:
            proposedPlan.dependencies[0]?.operation === 'create'
              ? [{ key: 'canonical-edge', id: id('65') }]
              : [],
        },
      };
      expect(
        issueText(deliveryPlanProposalSchema.safeParse(candidate)),
      ).toMatch(/null plan base/i);
    }
  });

  it('derives proposal diff counts from the complete proposal', () => {
    for (const diff of [
      {
        ...pendingPlanProposal.diff,
        milestones: { ...pendingPlanProposal.diff.milestones, create: 2 },
      },
      { ...pendingPlanProposal.diff, traceCreateCount: 1 },
      { ...pendingPlanProposal.diff, traceRemoveCount: 1 },
    ]) {
      expect(
        deliveryPlanProposalSchema.safeParse({
          ...pendingPlanProposal,
          diff,
        }).success,
      ).toBe(false);
    }
  });

  it('defers complete ordinal validation until reused members are materialized', () => {
    expect(
      proposedDeliveryPlanSchema.safeParse({
        summary: 'Reuse milestone one and create milestone two.',
        milestones: [
          {
            operation: 'reuse',
            milestoneId: id('66'),
            expectedRevision: 1,
          },
          {
            ...proposedPlan.milestones[0],
            content: { ...proposedPlan.milestones[0].content, ordinal: 2 },
          },
        ],
        tasks: [
          {
            operation: 'reuse',
            taskId: id('67'),
            expectedContractRevision: 1,
            expectedCurrentRevision: 1,
          },
        ],
        dependencies: [],
        traces: [
          {
            kind: 'milestone_covers',
            milestone: { kind: 'canonical', milestoneId: id('66') },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
          {
            kind: 'milestone_covers',
            milestone: { kind: 'proposal', key: 'todo-milestone' },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
          {
            kind: 'task_satisfies',
            task: { kind: 'canonical', taskId: id('67') },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      proposedDeliveryPlanSchema.safeParse({
        summary: 'Reuse task one and create task two.',
        milestones: [
          {
            operation: 'reuse',
            milestoneId: id('66'),
            expectedRevision: 1,
          },
        ],
        tasks: [
          {
            operation: 'reuse',
            taskId: id('67'),
            expectedContractRevision: 1,
            expectedCurrentRevision: 1,
          },
          {
            ...proposedPlan.tasks[0],
            key: 'second-task',
            content: {
              ...proposedPlan.tasks[0].content,
              milestone: { kind: 'canonical', milestoneId: id('66') },
              ordinal: 2,
            },
          },
        ],
        dependencies: [],
        traces: [
          {
            kind: 'milestone_covers',
            milestone: { kind: 'canonical', milestoneId: id('66') },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
          {
            kind: 'task_satisfies',
            task: { kind: 'proposal', key: 'second-task' },
            requirement: { recordId: requirementId, recordRevision: 1 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('requires exact proposal materialization in approval results and events', () => {
    const result = {
      ok: true,
      schemaVersion: 2,
      commandType: 'plan_proposal.approve',
      planningCycle: approvedPlanCycle,
      deliveryPlan: approvedDeliveryPlan,
      board: activeBoard,
    };
    const event = {
      id: id('68'),
      projectId,
      sequence: 68,
      occurredAt: now,
      type: 'delivery_plan.approved',
      payload: {
        schemaVersion: 1,
        planningCycle: approvedPlanCycle,
        deliveryPlan: approvedDeliveryPlan,
        board: activeBoard,
      },
    };
    expect(v2CommandResultSchema.parse(result)).toEqual(result);
    expect(domainEventSchema.parse(event)).toEqual(event);

    const emptyMaterialization = {
      ...approvedDeliveryPlan,
      milestones: [],
      taskContracts: [],
      traces: [],
    };
    expect(
      v2CommandResultSchema.safeParse({
        ...result,
        deliveryPlan: emptyMaterialization,
      }).success,
    ).toBe(false);
    expect(
      domainEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, deliveryPlan: emptyMaterialization },
      }).success,
    ).toBe(false);
    expect(
      v2CommandResultSchema.safeParse({
        ...result,
        planningCycle: {
          ...approvedPlanCycle,
          deliveryPlanProposals: [
            {
              ...terminalPlanProposal,
              reservations: {
                ...terminalPlanProposal.reservations,
                milestones: [{ key: 'todo-milestone', id: id('69') }],
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
    for (const deliveryPlan of [
      {
        ...approvedDeliveryPlan,
        milestones: [
          { ...approvedDeliveryPlan.milestones[0], title: 'Different title' },
        ],
      },
      {
        ...approvedDeliveryPlan,
        taskContracts: [
          { ...approvedDeliveryPlan.taskContracts[0], title: 'Different task' },
        ],
      },
      {
        ...approvedDeliveryPlan,
        traces: approvedDeliveryPlan.traces.map((trace) => ({
          ...trace,
          requirement: { ...trace.requirement, recordRevision: 2 },
        })),
      },
    ]) {
      expect(
        v2CommandResultSchema.safeParse({ ...result, deliveryPlan }).success,
      ).toBe(false);
    }
  });

  it('parses every versioned M3 success with purpose and plan coherence', () => {
    const planSubmitCycle = {
      ...deliveryPlanCycle,
      cycle: {
        ...deliveryPlanCycle.cycle,
        lifecycle: 'launch_pending',
        revision: 3,
      },
      turns: [
        ...deliveryPlanCycle.turns,
        {
          ...deliveryPlanCycle.turns[0],
          id: id('16'),
          ordinal: 3,
          message: 'Revise the plan.',
          launchState: 'launch_pending',
          executionId: null,
        },
      ],
    };
    const rejectedCycle = {
      ...deliveryPlanCycle,
      cycle: {
        ...deliveryPlanCycle.cycle,
        lifecycle: 'proposal_rejected',
        endedAt: now,
      },
      deliveryPlanProposals: [
        {
          ...pendingPlanProposal,
          lifecycle: 'rejected',
          decision: {
            kind: 'rejected',
            decidedBy: 'human',
            feedback: 'Keep it smaller.',
            decidedAt: now,
          },
        },
      ],
    };
    for (const result of [
      {
        ok: true,
        schemaVersion: 2,
        commandType: 'planning_cycle.submit_plan_turn',
        planningCycle: planSubmitCycle,
      },
      {
        ok: true,
        schemaVersion: 2,
        commandType: 'plan_proposal.approve',
        planningCycle: approvedPlanCycle,
        deliveryPlan: approvedDeliveryPlan,
        board: activeBoard,
      },
      {
        ok: true,
        schemaVersion: 2,
        commandType: 'plan_proposal.reject',
        planningCycle: rejectedCycle,
      },
      {
        ok: true,
        schemaVersion: 2,
        commandType: 'board_filter.set',
        board: activeBoard,
      },
    ]) {
      expect(v2CommandResultSchema.parse(result).commandType).toBe(
        result.commandType,
      );
    }
    for (const event of [
      {
        id: id('30'),
        projectId,
        sequence: 30,
        occurredAt: now,
        type: 'delivery_plan.approved',
        payload: {
          schemaVersion: 1,
          planningCycle: approvedPlanCycle,
          deliveryPlan: approvedDeliveryPlan,
          board: activeBoard,
        },
      },
      {
        id: id('31'),
        projectId,
        sequence: 31,
        occurredAt: now,
        type: 'board.filter_changed',
        payload: { schemaVersion: 1, board: activeBoard },
      },
      {
        id: id('32'),
        projectId,
        sequence: 32,
        occurredAt: now,
        type: 'task.lifecycle_changed',
        payload: {
          schemaVersion: 1,
          task: {
            ...approvedDeliveryPlan.taskContracts[0],
            revision: 2,
            revisionKind: 'operational_lifecycle',
            lifecycle: 'completed',
            source: { kind: 'lifecycle', priorRevision: 1 },
          },
          board: activeBoard,
        },
      },
    ]) {
      expect(domainEventSchema.parse(event).type).toBe(event.type);
    }
  });

  it('rejects invalid proposal abandonment successor semantics', () => {
    expect(
      deliveryPlanProposalSchema.safeParse({
        id: planProposalId,
        projectId,
        planningCycleId: cycleId,
        revision: 1,
        lifecycle: 'superseded',
        base: {
          projectIntentId: intentId,
          projectIntentRevision: 1,
          ledgerId,
          ledgerRevision: 1,
          deliveryPlan: { id: null, revision: null },
        },
        proposedPlan,
        reservations: {
          milestones: [{ key: 'todo-milestone', id: milestoneId }],
          tasks: [{ key: 'persist-todo', id: taskId }],
          dependencies: [],
        },
        diff: {
          milestones: {
            create: 1,
            reuse: 0,
            revise: 0,
            retire: 0,
            reactivate: 0,
          },
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
        createdByTurnId: humanTurnId,
        createdByExecutionId: executionId,
        createdAt: now,
        decision: {
          kind: 'superseded',
          reason: 'cycle_abandoned',
          supersededByProposalId: planProposalId,
          decidedAt: now,
        },
      }).success,
    ).toBe(false);
  });
});
