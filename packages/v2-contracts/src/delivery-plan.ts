import { z } from 'zod';

import {
  deliveryPlanIdSchema,
  deliveryPlanProposalIdSchema,
  isoTimestampSchema,
  ledgerIdSchema,
  ledgerRecordIdSchema,
  milestoneIdSchema,
  nonNegativeIntegerSchema,
  planningCycleIdSchema,
  planningTurnIdSchema,
  positiveIntegerSchema,
  projectIdSchema,
  projectIntentIdSchema,
  taskDependencyIdSchema,
  taskIdSchema,
  workerExecutionIdSchema,
} from './ids';
import {
  approvedIntentLedgerSchema,
  legacyM2PlanningCycleViewSchema,
  planningCycleSchema,
  pmQuestionResultSchema,
  planningProposalSchema,
  planningQuestionSchema,
  planningTurnSchema,
  type LegacyM2PlanningCycleView,
} from './intent';

export const PM_PLAN_REPORT_SCHEMA = 'mesh.dev/pm-plan-report/v1' as const;

export const proposalKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export type ProposalKey = z.infer<typeof proposalKeySchema>;

export const planTextSchema = z.string().trim().min(1).max(4096);
export type PlanText = z.infer<typeof planTextSchema>;

export const planLabelSchema = z.string().trim().min(1).max(64);
export type PlanLabel = z.infer<typeof planLabelSchema>;

export const planningCyclePurposeSchema = z.enum(['intent', 'delivery_plan']);
export type PlanningCyclePurpose = z.infer<typeof planningCyclePurposeSchema>;

export const planningCyclePurposeStateSchema = z
  .strictObject({
    planningCycleId: planningCycleIdSchema,
    purpose: planningCyclePurposeSchema,
    baseDeliveryPlanId: deliveryPlanIdSchema.nullable(),
    baseDeliveryPlanRevision: positiveIntegerSchema.nullable(),
  })
  .superRefine((value, context) => {
    const hasPlanBase = value.baseDeliveryPlanId !== null;
    if (hasPlanBase !== (value.baseDeliveryPlanRevision !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['baseDeliveryPlanRevision'],
        message:
          'Delivery plan base ID and revision must be jointly null or non-null',
      });
    }
    if (value.purpose === 'intent' && hasPlanBase) {
      context.addIssue({
        code: 'custom',
        path: ['baseDeliveryPlanId'],
        message: 'Intent cycles cannot have a delivery plan base',
      });
    }
  });
export type PlanningCyclePurposeState = z.infer<
  typeof planningCyclePurposeStateSchema
>;

export const proposedMilestoneRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('canonical'),
    milestoneId: milestoneIdSchema,
  }),
  z.strictObject({ kind: z.literal('proposal'), key: proposalKeySchema }),
]);
export type ProposedMilestoneRef = z.infer<typeof proposedMilestoneRefSchema>;

export const proposedTaskRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('canonical'), taskId: taskIdSchema }),
  z.strictObject({ kind: z.literal('proposal'), key: proposalKeySchema }),
]);
export type ProposedTaskRef = z.infer<typeof proposedTaskRefSchema>;

const uniqueTextList = (maximum: number) =>
  z
    .array(planTextSchema)
    .max(maximum)
    .readonly()
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: 'custom', message: 'Values must be unique' });
      }
    });

export const milestoneContractInputSchema = z.strictObject({
  title: planTextSchema,
  outcome: planTextSchema,
  stopCondition: planTextSchema,
  exclusions: z.array(planTextSchema).max(20).readonly(),
  ordinal: positiveIntegerSchema,
});
export type MilestoneContractInput = z.infer<
  typeof milestoneContractInputSchema
>;

export const taskContractInputSchema = z
  .strictObject({
    milestone: proposedMilestoneRefSchema,
    title: planTextSchema,
    outcome: planTextSchema,
    acceptanceCriteria: z.array(planTextSchema).min(1).max(20).readonly(),
    verificationCriteria: z.array(planTextSchema).min(1).max(20).readonly(),
    priority: z.enum(['must', 'should', 'could']),
    labels: z.array(planLabelSchema).max(20).readonly(),
    ownedSurfaces: uniqueTextList(20),
    prohibitedSurfaces: uniqueTextList(20),
    expectedArtifacts: uniqueTextList(20),
    ordinal: positiveIntegerSchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.labels).size !== value.labels.length) {
      context.addIssue({
        code: 'custom',
        path: ['labels'],
        message: 'Task labels must be unique',
      });
    }
  });
export type TaskContractInput = z.infer<typeof taskContractInputSchema>;

export const proposedMilestoneMemberSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'),
    key: proposalKeySchema,
    content: milestoneContractInputSchema,
  }),
  z.strictObject({
    operation: z.literal('reuse'),
    milestoneId: milestoneIdSchema,
    expectedRevision: positiveIntegerSchema,
  }),
  z.strictObject({
    operation: z.literal('revise'),
    milestoneId: milestoneIdSchema,
    expectedRevision: positiveIntegerSchema,
    lifecycle: z.enum(['active', 'retired']),
    content: milestoneContractInputSchema,
  }),
]);
export type ProposedMilestoneMember = z.infer<
  typeof proposedMilestoneMemberSchema
>;

export const proposedTaskMemberSchema = z
  .discriminatedUnion('operation', [
    z.strictObject({
      operation: z.literal('create'),
      key: proposalKeySchema,
      content: taskContractInputSchema,
    }),
    z.strictObject({
      operation: z.literal('reuse'),
      taskId: taskIdSchema,
      expectedContractRevision: positiveIntegerSchema,
      expectedCurrentRevision: positiveIntegerSchema,
    }),
    z.strictObject({
      operation: z.literal('revise'),
      taskId: taskIdSchema,
      expectedContractRevision: positiveIntegerSchema,
      expectedCurrentRevision: positiveIntegerSchema,
      lifecycle: z.enum(['pending', 'retired']),
      content: taskContractInputSchema,
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.operation !== 'create' &&
      value.expectedCurrentRevision < value.expectedContractRevision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedCurrentRevision'],
        message: 'Current task revision cannot precede its contract anchor',
      });
    }
  });
export type ProposedTaskMember = z.infer<typeof proposedTaskMemberSchema>;

export const proposedDependencyMemberSchema = z.discriminatedUnion(
  'operation',
  [
    z.strictObject({
      operation: z.literal('create'),
      key: proposalKeySchema,
      prerequisite: proposedTaskRefSchema,
      dependent: proposedTaskRefSchema,
    }),
    z.strictObject({
      operation: z.literal('reuse'),
      dependencyId: taskDependencyIdSchema,
      expectedRevision: positiveIntegerSchema,
    }),
    z.strictObject({
      operation: z.literal('revise'),
      dependencyId: taskDependencyIdSchema,
      expectedRevision: positiveIntegerSchema,
      lifecycle: z.enum(['active', 'retired']),
    }),
  ],
);
export type ProposedDependencyMember = z.infer<
  typeof proposedDependencyMemberSchema
>;

export const proposedRequirementTraceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('milestone_covers'),
    milestone: proposedMilestoneRefSchema,
    requirement: z.strictObject({
      recordId: ledgerRecordIdSchema,
      recordRevision: positiveIntegerSchema,
    }),
  }),
  z.strictObject({
    kind: z.literal('task_satisfies'),
    task: proposedTaskRefSchema,
    requirement: z.strictObject({
      recordId: ledgerRecordIdSchema,
      recordRevision: positiveIntegerSchema,
    }),
  }),
]);
export type ProposedRequirementTrace = z.infer<
  typeof proposedRequirementTraceSchema
>;

const memberIdentity = (
  member:
    | ProposedMilestoneMember
    | ProposedTaskMember
    | ProposedDependencyMember,
) =>
  member.operation === 'create'
    ? `proposal:${member.key}`
    : 'milestoneId' in member
      ? `canonical:${member.milestoneId}`
      : 'taskId' in member
        ? `canonical:${member.taskId}`
        : `canonical:${member.dependencyId}`;

const milestoneRefIdentity = (ref: ProposedMilestoneRef) =>
  ref.kind === 'proposal'
    ? `proposal:${ref.key}`
    : `canonical:${ref.milestoneId}`;
const taskRefIdentity = (ref: ProposedTaskRef) =>
  ref.kind === 'proposal' ? `proposal:${ref.key}` : `canonical:${ref.taskId}`;

export const proposedDeliveryPlanSchema = z
  .strictObject({
    summary: planTextSchema,
    milestones: z
      .array(proposedMilestoneMemberSchema)
      .min(1)
      .max(20)
      .readonly(),
    tasks: z.array(proposedTaskMemberSchema).min(1).max(100).readonly(),
    dependencies: z.array(proposedDependencyMemberSchema).max(200).readonly(),
    traces: z.array(proposedRequirementTraceSchema).min(1).max(300).readonly(),
  })
  .superRefine((value, context) => {
    const allKeys = new Set<string>();
    const milestoneRefs = new Set<string>();
    const taskRefs = new Set<string>();
    const dependencyIds = new Set<string>();
    for (const [collectionName, members] of [
      ['milestones', value.milestones],
      ['tasks', value.tasks],
      ['dependencies', value.dependencies],
    ] as const) {
      const identities = new Set<string>();
      members.forEach((member, index) => {
        const identity = memberIdentity(member);
        if (identities.has(identity)) {
          context.addIssue({
            code: 'custom',
            path: [collectionName, index],
            message: 'Proposal members must be unique',
          });
        }
        identities.add(identity);
        if (member.operation === 'create') {
          if (allKeys.has(member.key)) {
            context.addIssue({
              code: 'custom',
              path: [collectionName, index, 'key'],
              message: 'Create keys must be unique across the proposal',
            });
          }
          allKeys.add(member.key);
        }
        if (collectionName === 'milestones') milestoneRefs.add(identity);
        if (collectionName === 'tasks') taskRefs.add(identity);
        if (
          collectionName === 'dependencies' &&
          member.operation !== 'create'
        ) {
          dependencyIds.add(identity);
        }
      });
    }

    value.tasks.forEach((member, index) => {
      if (member.operation === 'reuse') return;
      const milestone = milestoneRefIdentity(member.content.milestone);
      if (!milestoneRefs.has(milestone)) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', index, 'content', 'milestone'],
          message: 'Task milestone must resolve inside the complete proposal',
        });
      }
    });

    const edges = new Set<string>();
    value.dependencies.forEach((member, index) => {
      if (member.operation !== 'create') return;
      const prerequisite = taskRefIdentity(member.prerequisite);
      const dependent = taskRefIdentity(member.dependent);
      if (!taskRefs.has(prerequisite) || !taskRefs.has(dependent)) {
        context.addIssue({
          code: 'custom',
          path: ['dependencies', index],
          message: 'Dependency endpoints must resolve inside the proposal',
        });
      }
      if (prerequisite === dependent) {
        context.addIssue({
          code: 'custom',
          path: ['dependencies', index, 'dependent'],
          message: 'Dependencies cannot be self-edges',
        });
      }
      const edge = `${prerequisite}->${dependent}`;
      if (edges.has(edge)) {
        context.addIssue({
          code: 'custom',
          path: ['dependencies', index],
          message: 'Dependency endpoints must be unique',
        });
      }
      edges.add(edge);
    });

    const traces = new Set<string>();
    const milestoneCoverage = new Set<string>();
    const taskCoverage = new Set<string>();
    value.traces.forEach((trace, index) => {
      const subject =
        trace.kind === 'milestone_covers'
          ? milestoneRefIdentity(trace.milestone)
          : taskRefIdentity(trace.task);
      const subjects =
        trace.kind === 'milestone_covers' ? milestoneRefs : taskRefs;
      if (!subjects.has(subject)) {
        context.addIssue({
          code: 'custom',
          path: ['traces', index],
          message: 'Trace subject must resolve inside the proposal',
        });
      }
      const key = `${trace.kind}:${subject}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
      if (traces.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['traces', index],
          message: 'Requirement traces must be unique',
        });
      }
      traces.add(key);
      const coverageKey = `${subject}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
      (trace.kind === 'milestone_covers'
        ? milestoneCoverage
        : taskCoverage
      ).add(coverageKey);
    });
    for (const [index, milestone] of value.milestones.entries()) {
      if (
        milestone.operation !== 'reuse' &&
        (milestone.operation === 'create' ||
          milestone.lifecycle === 'active') &&
        ![...milestoneCoverage].some((key) =>
          key.startsWith(`${memberIdentity(milestone)}:`),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['milestones', index],
          message:
            'Every explicit active milestone requires a requirement trace',
        });
      }
    }
    for (const [index, task] of value.tasks.entries()) {
      if (
        task.operation === 'reuse' ||
        (task.operation === 'revise' && task.lifecycle === 'retired')
      ) {
        continue;
      }
      const taskIdentity = memberIdentity(task);
      const milestoneIdentity = milestoneRefIdentity(task.content.milestone);
      const coverage = [...taskCoverage].filter((key) =>
        key.startsWith(`${taskIdentity}:`),
      );
      if (
        coverage.length === 0 ||
        coverage.some(
          (key) =>
            !milestoneCoverage.has(
              `${milestoneIdentity}:${key.slice(taskIdentity.length + 1)}`,
            ),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', index],
          message:
            'Every explicit active task requires milestone-covered requirement traces',
        });
      }
    }
  });
export type ProposedDeliveryPlan = z.infer<typeof proposedDeliveryPlanSchema>;

export const planProposalDiffCountsSchema = z.strictObject({
  create: nonNegativeIntegerSchema,
  reuse: nonNegativeIntegerSchema,
  revise: nonNegativeIntegerSchema,
  retire: nonNegativeIntegerSchema,
  reactivate: nonNegativeIntegerSchema,
});
export type PlanProposalDiffCounts = z.infer<
  typeof planProposalDiffCountsSchema
>;

const deliveryPlanProposalDecisionSchema = z.union([
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({
    kind: z.literal('superseded'),
    reason: z.literal('replacement_accepted'),
    supersededByProposalId: deliveryPlanProposalIdSchema,
    decidedAt: isoTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal('superseded'),
    reason: z.literal('cycle_abandoned'),
    supersededByProposalId: z.null(),
    decidedAt: isoTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal('approved'),
    decidedBy: z.literal('human'),
    decidedAt: isoTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal('rejected'),
    decidedBy: z.literal('human'),
    feedback: planTextSchema,
    decidedAt: isoTimestampSchema,
  }),
]);

export const deliveryPlanProposalSchema = z
  .strictObject({
    id: deliveryPlanProposalIdSchema,
    projectId: projectIdSchema,
    planningCycleId: planningCycleIdSchema,
    revision: positiveIntegerSchema,
    lifecycle: z.enum([
      'awaiting_approval',
      'superseded',
      'approved',
      'rejected',
    ]),
    base: z.strictObject({
      projectIntentId: projectIntentIdSchema,
      projectIntentRevision: positiveIntegerSchema,
      ledgerId: ledgerIdSchema,
      ledgerRevision: positiveIntegerSchema,
      deliveryPlan: z.union([
        z.strictObject({
          id: deliveryPlanIdSchema,
          revision: positiveIntegerSchema,
        }),
        z.strictObject({ id: z.null(), revision: z.null() }),
      ]),
    }),
    proposedPlan: proposedDeliveryPlanSchema,
    reservations: z.strictObject({
      milestones: z
        .array(
          z.strictObject({ key: proposalKeySchema, id: milestoneIdSchema }),
        )
        .max(20)
        .readonly(),
      tasks: z
        .array(z.strictObject({ key: proposalKeySchema, id: taskIdSchema }))
        .max(100)
        .readonly(),
      dependencies: z
        .array(
          z.strictObject({
            key: proposalKeySchema,
            id: taskDependencyIdSchema,
          }),
        )
        .max(200)
        .readonly(),
    }),
    diff: z.strictObject({
      milestones: planProposalDiffCountsSchema,
      tasks: planProposalDiffCountsSchema,
      dependencies: planProposalDiffCountsSchema,
      traceCreateCount: nonNegativeIntegerSchema.max(300),
      traceRemoveCount: nonNegativeIntegerSchema.max(300),
    }),
    createdByTurnId: planningTurnIdSchema,
    createdByExecutionId: workerExecutionIdSchema,
    createdAt: isoTimestampSchema,
    decision: deliveryPlanProposalDecisionSchema,
  })
  .superRefine((value, context) => {
    const decisionLifecycle =
      value.decision.kind === 'pending'
        ? 'awaiting_approval'
        : value.decision.kind;
    if (value.lifecycle !== decisionLifecycle) {
      context.addIssue({
        code: 'custom',
        path: ['decision'],
        message: 'Proposal lifecycle and decision must agree',
      });
    }
    const expectedReservations = {
      milestones: new Set(
        value.proposedPlan.milestones.flatMap((member) =>
          member.operation === 'create' ? [member.key] : [],
        ),
      ),
      tasks: new Set(
        value.proposedPlan.tasks.flatMap((member) =>
          member.operation === 'create' ? [member.key] : [],
        ),
      ),
      dependencies: new Set(
        value.proposedPlan.dependencies.flatMap((member) =>
          member.operation === 'create' ? [member.key] : [],
        ),
      ),
    };
    for (const collection of ['milestones', 'tasks', 'dependencies'] as const) {
      const keys = value.reservations[collection].map(({ key }) => key);
      const ids = value.reservations[collection].map(({ id }) => id);
      if (
        new Set(keys).size !== keys.length ||
        new Set(ids).size !== ids.length ||
        keys.length !== expectedReservations[collection].size ||
        keys.some((key) => !expectedReservations[collection].has(key))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['reservations', collection],
          message: 'Reservations must exactly match created proposal members',
        });
      }
    }
    const proposedCollections = {
      milestones: value.proposedPlan.milestones,
      tasks: value.proposedPlan.tasks,
      dependencies: value.proposedPlan.dependencies,
    } as const;
    for (const [name, members] of Object.entries(proposedCollections)) {
      const expected = {
        create: members.filter(({ operation }) => operation === 'create')
          .length,
        reuse: members.filter(({ operation }) => operation === 'reuse').length,
        revise: members.filter(({ operation }) => operation === 'revise')
          .length,
      };
      const actual = value.diff[name as keyof typeof proposedCollections];
      if (
        actual.create !== expected.create ||
        actual.reuse !== expected.reuse ||
        actual.revise + actual.retire + actual.reactivate !== expected.revise
      ) {
        context.addIssue({
          code: 'custom',
          path: ['diff', name],
          message: 'Proposal diff counts must classify every member exactly',
        });
      }
    }
    if (
      value.base.deliveryPlan.id === null &&
      (Object.values(proposedCollections).some((members) =>
        members.some(({ operation }) => operation !== 'create'),
      ) ||
        value.proposedPlan.tasks.some(
          (member) =>
            member.operation !== 'reuse' &&
            member.content.milestone.kind === 'canonical',
        ) ||
        value.proposedPlan.dependencies.some(
          (member) =>
            member.operation === 'create' &&
            (member.prerequisite.kind === 'canonical' ||
              member.dependent.kind === 'canonical'),
        ) ||
        value.proposedPlan.traces.some((trace) =>
          trace.kind === 'milestone_covers'
            ? trace.milestone.kind === 'canonical'
            : trace.task.kind === 'canonical',
        ))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['proposedPlan'],
        message: 'A null plan base forbids canonical operations and references',
      });
    }
    if (value.base.deliveryPlan.id === null) {
      const milestoneOrdinalsMatch = value.proposedPlan.milestones.every(
        (member, index) =>
          member.operation !== 'create' || member.content.ordinal === index + 1,
      );
      const taskOrdinals = new Map<string, number>();
      const taskOrdinalsMatch = value.proposedPlan.tasks.every((member) => {
        if (
          member.operation !== 'create' ||
          member.content.milestone.kind !== 'proposal'
        ) {
          return true;
        }
        const expected =
          (taskOrdinals.get(member.content.milestone.key) ?? 0) + 1;
        taskOrdinals.set(member.content.milestone.key, expected);
        return member.content.ordinal === expected;
      });
      if (!milestoneOrdinalsMatch || !taskOrdinalsMatch) {
        context.addIssue({
          code: 'custom',
          path: ['proposedPlan'],
          message: 'Initial plan ordinals must be ordered and contiguous',
        });
      }
    }
    if (
      value.base.deliveryPlan.id === null &&
      (value.diff.traceCreateCount !== value.proposedPlan.traces.length ||
        value.diff.traceRemoveCount !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['diff'],
        message: 'Initial plan trace diff must exactly match proposal traces',
      });
    }
  });
export type DeliveryPlanProposal = z.infer<typeof deliveryPlanProposalSchema>;

export const deliveryPlanRevisionSchema = z.strictObject({
  id: deliveryPlanIdSchema,
  projectId: projectIdSchema,
  revision: positiveIntegerSchema,
  projectIntentId: projectIntentIdSchema,
  projectIntentRevision: positiveIntegerSchema,
  ledgerId: ledgerIdSchema,
  ledgerRevision: positiveIntegerSchema,
  baseDeliveryPlanRevision: positiveIntegerSchema.nullable(),
  proposalId: deliveryPlanProposalIdSchema,
  summary: planTextSchema,
  approvedBy: z.literal('human'),
  approvedAt: isoTimestampSchema,
});
export type DeliveryPlanRevision = z.infer<typeof deliveryPlanRevisionSchema>;

export const planRequirementRefSchema = z.strictObject({
  recordId: ledgerRecordIdSchema,
  recordRevision: positiveIntegerSchema,
});
export type PlanRequirementRef = z.infer<typeof planRequirementRefSchema>;

export const milestoneRevisionSchema = z.strictObject({
  id: milestoneIdSchema,
  projectId: projectIdSchema,
  revision: positiveIntegerSchema,
  lifecycle: z.enum(['active', 'retired']),
  title: planTextSchema,
  outcome: planTextSchema,
  stopCondition: planTextSchema,
  exclusions: z.array(planTextSchema).max(20).readonly(),
  ordinal: positiveIntegerSchema,
  proposalId: deliveryPlanProposalIdSchema,
  deliveryPlanRevision: positiveIntegerSchema,
  approvedAt: isoTimestampSchema,
});
export type MilestoneRevision = z.infer<typeof milestoneRevisionSchema>;

const taskContractShape = {
  milestoneId: milestoneIdSchema,
  title: planTextSchema,
  outcome: planTextSchema,
  acceptanceCriteria: z.array(planTextSchema).min(1).max(20).readonly(),
  verificationCriteria: z.array(planTextSchema).min(1).max(20).readonly(),
  priority: z.enum(['must', 'should', 'could']),
  labels: z.array(planLabelSchema).max(20).readonly(),
  ownedSurfaces: uniqueTextList(20),
  prohibitedSurfaces: uniqueTextList(20),
  expectedArtifacts: uniqueTextList(20),
  ordinal: positiveIntegerSchema,
};

export const taskRevisionSchema = z
  .strictObject({
    id: taskIdSchema,
    projectId: projectIdSchema,
    revision: positiveIntegerSchema,
    contractRevision: positiveIntegerSchema,
    revisionKind: z.enum(['plan_contract', 'operational_lifecycle']),
    lifecycle: z.enum(['pending', 'completed', 'retired']),
    ...taskContractShape,
    source: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('plan'),
        proposalId: deliveryPlanProposalIdSchema,
        deliveryPlanRevision: positiveIntegerSchema,
      }),
      z.strictObject({
        kind: z.literal('lifecycle'),
        priorRevision: positiveIntegerSchema,
      }),
    ]),
    createdAt: isoTimestampSchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.labels).size !== value.labels.length) {
      context.addIssue({
        code: 'custom',
        path: ['labels'],
        message: 'Task labels must be unique',
      });
    }
    const planRevision = value.revisionKind === 'plan_contract';
    if (
      planRevision !== (value.source.kind === 'plan') ||
      (planRevision && value.contractRevision !== value.revision)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['contractRevision'],
        message: 'Task revision kind, source, and contract anchor must agree',
      });
    }
    if (planRevision && value.lifecycle === 'completed') {
      context.addIssue({
        code: 'custom',
        path: ['lifecycle'],
        message: 'Plan-authored task revisions cannot be completed',
      });
    }
    if (!planRevision && value.lifecycle === 'retired') {
      context.addIssue({
        code: 'custom',
        path: ['lifecycle'],
        message: 'Operational task revisions cannot retire a task',
      });
    }
    if (
      !planRevision &&
      (value.contractRevision >= value.revision ||
        value.source.kind !== 'lifecycle' ||
        value.source.priorRevision !== value.revision - 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message:
          'Operational task revisions must follow their prior revision and anchor an older contract',
      });
    }
  });
export type TaskRevision = z.infer<typeof taskRevisionSchema>;

export const taskDependencyRevisionSchema = z
  .strictObject({
    id: taskDependencyIdSchema,
    projectId: projectIdSchema,
    revision: positiveIntegerSchema,
    prerequisiteTaskId: taskIdSchema,
    dependentTaskId: taskIdSchema,
    lifecycle: z.enum(['active', 'retired']),
    proposalId: deliveryPlanProposalIdSchema,
    deliveryPlanRevision: positiveIntegerSchema,
    approvedAt: isoTimestampSchema,
  })
  .refine((value) => value.prerequisiteTaskId !== value.dependentTaskId, {
    path: ['dependentTaskId'],
    message: 'Task dependencies cannot be self-edges',
  });
export type TaskDependencyRevision = z.infer<
  typeof taskDependencyRevisionSchema
>;

export const milestoneDependencySchema = z
  .strictObject({
    prerequisiteMilestoneId: milestoneIdSchema,
    dependentMilestoneId: milestoneIdSchema,
    throughTaskDependencyIds: z
      .array(taskDependencyIdSchema)
      .min(1)
      .max(200)
      .readonly(),
  })
  .superRefine((value, context) => {
    if (value.prerequisiteMilestoneId === value.dependentMilestoneId) {
      context.addIssue({
        code: 'custom',
        path: ['dependentMilestoneId'],
        message: 'Milestone dependencies cannot be self-edges',
      });
    }
    const ids = value.throughTaskDependencyIds;
    const sorted = [...ids].sort();
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id, index) => id !== sorted[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['throughTaskDependencyIds'],
        message: 'Contributing dependency IDs must be unique and ordered',
      });
    }
  });
export type MilestoneDependency = z.infer<typeof milestoneDependencySchema>;

export const approvedPlanTraceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('milestone_covers'),
    milestoneId: milestoneIdSchema,
    milestoneRevision: positiveIntegerSchema,
    requirement: planRequirementRefSchema,
  }),
  z.strictObject({
    kind: z.literal('task_satisfies'),
    taskId: taskIdSchema,
    taskContractRevision: positiveIntegerSchema,
    requirement: planRequirementRefSchema,
  }),
]);
export type ApprovedPlanTrace = z.infer<typeof approvedPlanTraceSchema>;

export const approvedDeliveryPlanSchema = z
  .strictObject({
    plan: deliveryPlanRevisionSchema,
    milestones: z.array(milestoneRevisionSchema).max(20).readonly(),
    taskContracts: z.array(taskRevisionSchema).max(100).readonly(),
    dependencies: z.array(taskDependencyRevisionSchema).max(200).readonly(),
    traces: z.array(approvedPlanTraceSchema).max(300).readonly(),
    milestoneDependencies: z
      .array(milestoneDependencySchema)
      .max(200)
      .readonly(),
  })
  .superRefine((value, context) => {
    if (
      value.plan.revision === 1
        ? value.plan.baseDeliveryPlanRevision !== null
        : value.plan.baseDeliveryPlanRevision !== value.plan.revision - 1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['plan', 'baseDeliveryPlanRevision'],
        message:
          'Delivery plan base must be null for revision one and otherwise previous',
      });
    }
    for (const [name, records] of [
      ['milestones', value.milestones],
      ['taskContracts', value.taskContracts],
      ['dependencies', value.dependencies],
    ] as const) {
      const ids = records.map((record) => record.id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'Approved plan memberships must use unique identities',
        });
      }
      records.forEach((record, index) => {
        if (record.projectId !== value.plan.projectId) {
          context.addIssue({
            code: 'custom',
            path: [name, index],
            message: 'Approved plan members must match the plan project',
          });
        }
      });
    }
    value.taskContracts.forEach((task, index) => {
      if (
        task.revisionKind !== 'plan_contract' ||
        task.contractRevision !== task.revision ||
        task.source.kind !== 'plan' ||
        task.source.deliveryPlanRevision > value.plan.revision
      ) {
        context.addIssue({
          code: 'custom',
          path: ['taskContracts', index],
          message: 'Plan task membership must anchor a plan-contract revision',
        });
      }
    });
    const milestones = new Map(
      value.milestones.map((milestone) => [milestone.id, milestone] as const),
    );
    const tasks = new Map(
      value.taskContracts.map((task) => [task.id, task] as const),
    );
    value.milestones.forEach((milestone, index) => {
      if (milestone.deliveryPlanRevision > value.plan.revision) {
        context.addIssue({
          code: 'custom',
          path: ['milestones', index, 'deliveryPlanRevision'],
          message: 'Milestone provenance cannot follow the approved plan',
        });
      }
      if (milestone.ordinal !== index + 1) {
        context.addIssue({
          code: 'custom',
          path: ['milestones', index, 'ordinal'],
          message: 'Plan milestones must be ordered with contiguous ordinals',
        });
      }
    });
    const taskOrdinals = new Map<string, number>();
    value.taskContracts.forEach((task, index) => {
      if (!milestones.has(task.milestoneId)) {
        context.addIssue({
          code: 'custom',
          path: ['taskContracts', index, 'milestoneId'],
          message: 'Plan tasks must belong to a plan milestone',
        });
      }
      const priorOrdinal = taskOrdinals.get(task.milestoneId) ?? 0;
      if (task.ordinal !== priorOrdinal + 1) {
        context.addIssue({
          code: 'custom',
          path: ['taskContracts', index, 'ordinal'],
          message:
            'Plan tasks must be ordered with contiguous milestone ordinals',
        });
      }
      taskOrdinals.set(task.milestoneId, task.ordinal);
    });
    const dependencyEdges = new Set<string>();
    const dependenciesById = new Map<string, TaskDependencyRevision>();
    value.dependencies.forEach((dependency, index) => {
      const edge = `${dependency.prerequisiteTaskId}->${dependency.dependentTaskId}`;
      if (
        dependency.deliveryPlanRevision > value.plan.revision ||
        !tasks.has(dependency.prerequisiteTaskId) ||
        !tasks.has(dependency.dependentTaskId) ||
        dependencyEdges.has(edge)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['dependencies', index],
          message:
            'Plan dependencies require matching provenance and unique plan-member endpoints',
        });
      }
      dependencyEdges.add(edge);
      dependenciesById.set(dependency.id, dependency);
      if (index > 0 && value.dependencies[index - 1].id >= dependency.id) {
        context.addIssue({
          code: 'custom',
          path: ['dependencies', index, 'id'],
          message: 'Plan dependency identities must be canonically ordered',
        });
      }
    });
    const traceKeys = new Set<string>();
    const milestoneCoverage = new Map<string, Set<string>>();
    const taskCoverage = new Map<string, Set<string>>();
    value.traces.forEach((trace, index) => {
      const subject =
        trace.kind === 'milestone_covers'
          ? milestones.get(trace.milestoneId)
          : tasks.get(trace.taskId);
      const revision =
        trace.kind === 'milestone_covers'
          ? trace.milestoneRevision
          : trace.taskContractRevision;
      if (subject === undefined || subject.revision !== revision) {
        context.addIssue({
          code: 'custom',
          path: ['traces', index],
          message: 'Plan traces must target exact plan member revisions',
        });
      }
      const key = `${trace.kind}:${
        trace.kind === 'milestone_covers' ? trace.milestoneId : trace.taskId
      }:${revision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
      if (traceKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['traces', index],
          message: 'Approved plan traces must be unique',
        });
      }
      traceKeys.add(key);
      const coverage =
        trace.kind === 'milestone_covers' ? milestoneCoverage : taskCoverage;
      const subjectId =
        trace.kind === 'milestone_covers' ? trace.milestoneId : trace.taskId;
      const requirementKey = `${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
      const requirements = coverage.get(subjectId) ?? new Set<string>();
      requirements.add(requirementKey);
      coverage.set(subjectId, requirements);
    });
    const milestoneDependencyKeys = new Set<string>();
    value.milestoneDependencies.forEach((dependency, index) => {
      const key = `${dependency.prerequisiteMilestoneId}->${dependency.dependentMilestoneId}`;
      if (
        !milestones.has(dependency.prerequisiteMilestoneId) ||
        !milestones.has(dependency.dependentMilestoneId) ||
        milestoneDependencyKeys.has(key)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['milestoneDependencies', index],
          message: 'Milestone dependencies must be unique plan-member pairs',
        });
      }
      milestoneDependencyKeys.add(key);
    });
    for (const [milestoneId, milestone] of milestones) {
      if (milestone.lifecycle !== 'active') continue;
      const ownedTasks = value.taskContracts.filter(
        (task) =>
          task.milestoneId === milestoneId && task.lifecycle === 'pending',
      );
      if (
        ownedTasks.length === 0 ||
        (milestoneCoverage.get(milestoneId)?.size ?? 0) === 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['milestones'],
          message:
            'Every active milestone requires active tasks and requirement coverage',
        });
      }
    }
    for (const task of value.taskContracts) {
      if (task.lifecycle !== 'pending') continue;
      const milestone = milestones.get(task.milestoneId);
      const requirements = taskCoverage.get(task.id) ?? new Set<string>();
      const milestoneRequirements =
        milestoneCoverage.get(task.milestoneId) ?? new Set<string>();
      if (
        milestone?.lifecycle !== 'active' ||
        requirements.size === 0 ||
        [...requirements].some(
          (requirement) => !milestoneRequirements.has(requirement),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['taskContracts'],
          message:
            'Every active task requires an active milestone and covered requirement traces',
        });
      }
    }
    const activeEdges = value.dependencies.filter(
      (dependency) => dependency.lifecycle === 'active',
    );
    const adjacency = new Map<string, string[]>();
    for (const dependency of activeEdges) {
      const prerequisite = tasks.get(dependency.prerequisiteTaskId);
      const dependent = tasks.get(dependency.dependentTaskId);
      if (
        prerequisite?.lifecycle !== 'pending' ||
        dependent?.lifecycle !== 'pending'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['dependencies'],
          message: 'Active dependencies require active plan task endpoints',
        });
      }
      const dependents = adjacency.get(dependency.prerequisiteTaskId) ?? [];
      dependents.push(dependency.dependentTaskId);
      adjacency.set(dependency.prerequisiteTaskId, dependents);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (taskId: string): boolean => {
      if (visiting.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      visiting.add(taskId);
      const cyclic = (adjacency.get(taskId) ?? []).some(hasCycle);
      visiting.delete(taskId);
      visited.add(taskId);
      return cyclic;
    };
    if ([...tasks.keys()].some(hasCycle)) {
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'Active plan dependencies must form a DAG',
      });
    }
    const expectedMilestoneDependencies = new Map<string, string[]>();
    for (const dependency of activeEdges) {
      const prerequisite = tasks.get(dependency.prerequisiteTaskId);
      const dependent = tasks.get(dependency.dependentTaskId);
      if (
        prerequisite === undefined ||
        dependent === undefined ||
        prerequisite.milestoneId === dependent.milestoneId
      ) {
        continue;
      }
      const key = `${prerequisite.milestoneId}->${dependent.milestoneId}`;
      const ids = expectedMilestoneDependencies.get(key) ?? [];
      ids.push(dependency.id);
      expectedMilestoneDependencies.set(key, ids);
    }
    const actualMilestoneDependencies = new Map(
      value.milestoneDependencies.map((dependency) => [
        `${dependency.prerequisiteMilestoneId}->${dependency.dependentMilestoneId}`,
        dependency.throughTaskDependencyIds,
      ]),
    );
    if (
      expectedMilestoneDependencies.size !== actualMilestoneDependencies.size ||
      [...expectedMilestoneDependencies].some(([key, ids]) => {
        const actual = actualMilestoneDependencies.get(key);
        const expected = [...ids].sort();
        return (
          actual === undefined ||
          actual.length !== expected.length ||
          actual.some((id, index) => id !== expected[index])
        );
      }) ||
      [...actualMilestoneDependencies.values()].some((ids) =>
        ids.some((id) => !dependenciesById.has(id)),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['milestoneDependencies'],
        message:
          'Milestone dependencies must exactly derive from active cross-milestone task edges',
      });
    }
  });
export type ApprovedDeliveryPlan = z.infer<typeof approvedDeliveryPlanSchema>;

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

const matchesApprovedMaterialization = (
  proposal: DeliveryPlanProposal,
  baseDeliveryPlan: ApprovedDeliveryPlan | null | undefined,
  deliveryPlan: ApprovedDeliveryPlan,
) => {
  const { plan } = deliveryPlan;
  const expectedPlanRevision = (proposal.base.deliveryPlan.revision ?? 0) + 1;
  if (
    plan.proposalId !== proposal.id ||
    plan.projectId !== proposal.projectId ||
    plan.revision !== expectedPlanRevision ||
    plan.projectIntentId !== proposal.base.projectIntentId ||
    plan.projectIntentRevision !== proposal.base.projectIntentRevision ||
    plan.ledgerId !== proposal.base.ledgerId ||
    plan.ledgerRevision !== proposal.base.ledgerRevision ||
    plan.baseDeliveryPlanRevision !== proposal.base.deliveryPlan.revision ||
    (proposal.base.deliveryPlan.id !== null &&
      plan.id !== proposal.base.deliveryPlan.id) ||
    plan.summary !== proposal.proposedPlan.summary
  ) {
    return false;
  }

  const milestoneReservations = new Map(
    proposal.reservations.milestones.map(({ key, id }) => [key, id]),
  );
  const taskReservations = new Map(
    proposal.reservations.tasks.map(({ key, id }) => [key, id]),
  );
  const dependencyReservations = new Map(
    proposal.reservations.dependencies.map(({ key, id }) => [key, id]),
  );
  const resolveMilestoneId = (ref: ProposedMilestoneRef) =>
    ref.kind === 'canonical'
      ? ref.milestoneId
      : milestoneReservations.get(ref.key);
  const resolveTaskId = (ref: ProposedTaskRef) =>
    ref.kind === 'canonical' ? ref.taskId : taskReservations.get(ref.key);

  if (
    deliveryPlan.milestones.length !==
      proposal.proposedPlan.milestones.length ||
    deliveryPlan.taskContracts.length !== proposal.proposedPlan.tasks.length ||
    deliveryPlan.dependencies.length !==
      proposal.proposedPlan.dependencies.length
  ) {
    return false;
  }

  for (const [index, member] of proposal.proposedPlan.milestones.entries()) {
    const materialized = deliveryPlan.milestones[index];
    const id =
      member.operation === 'create'
        ? milestoneReservations.get(member.key)
        : member.milestoneId;
    if (materialized?.id !== id) return false;
    if (member.operation === 'reuse') {
      const prior = baseDeliveryPlan?.milestones.find(
        ({ id }) => id === member.milestoneId,
      );
      if (
        materialized.revision !== member.expectedRevision ||
        (baseDeliveryPlan !== undefined &&
          (prior === undefined || !sameJson(materialized, prior)))
      ) {
        return false;
      }
      continue;
    }
    if (
      materialized.revision !==
        (member.operation === 'create' ? 1 : member.expectedRevision + 1) ||
      materialized.lifecycle !==
        (member.operation === 'create' ? 'active' : member.lifecycle) ||
      materialized.title !== member.content.title ||
      materialized.outcome !== member.content.outcome ||
      materialized.stopCondition !== member.content.stopCondition ||
      !sameJson(materialized.exclusions, member.content.exclusions) ||
      materialized.ordinal !== member.content.ordinal ||
      materialized.proposalId !== proposal.id ||
      materialized.deliveryPlanRevision !== plan.revision ||
      materialized.approvedAt !== plan.approvedAt
    ) {
      return false;
    }
  }

  for (const [index, member] of proposal.proposedPlan.tasks.entries()) {
    const materialized = deliveryPlan.taskContracts[index];
    const id =
      member.operation === 'create'
        ? taskReservations.get(member.key)
        : member.taskId;
    if (materialized?.id !== id) return false;
    if (member.operation === 'reuse') {
      const prior = baseDeliveryPlan?.taskContracts.find(
        ({ id }) => id === member.taskId,
      );
      if (
        materialized.revision !== member.expectedContractRevision ||
        (baseDeliveryPlan !== undefined &&
          (prior === undefined || !sameJson(materialized, prior)))
      )
        return false;
      continue;
    }
    const expectedRevision =
      member.operation === 'create' ? 1 : member.expectedCurrentRevision + 1;
    if (
      materialized.revision !== expectedRevision ||
      materialized.contractRevision !== expectedRevision ||
      materialized.lifecycle !==
        (member.operation === 'create' ? 'pending' : member.lifecycle) ||
      materialized.milestoneId !==
        resolveMilestoneId(member.content.milestone) ||
      materialized.title !== member.content.title ||
      materialized.outcome !== member.content.outcome ||
      !sameJson(
        materialized.acceptanceCriteria,
        member.content.acceptanceCriteria,
      ) ||
      !sameJson(
        materialized.verificationCriteria,
        member.content.verificationCriteria,
      ) ||
      materialized.priority !== member.content.priority ||
      !sameJson(materialized.labels, member.content.labels) ||
      !sameJson(materialized.ownedSurfaces, member.content.ownedSurfaces) ||
      !sameJson(
        materialized.prohibitedSurfaces,
        member.content.prohibitedSurfaces,
      ) ||
      !sameJson(
        materialized.expectedArtifacts,
        member.content.expectedArtifacts,
      ) ||
      materialized.ordinal !== member.content.ordinal ||
      materialized.source.kind !== 'plan' ||
      materialized.source.proposalId !== proposal.id ||
      materialized.source.deliveryPlanRevision !== plan.revision ||
      materialized.createdAt !== plan.approvedAt
    ) {
      return false;
    }
  }

  const dependencies = new Map(
    deliveryPlan.dependencies.map((dependency) => [dependency.id, dependency]),
  );
  for (const member of proposal.proposedPlan.dependencies) {
    const id =
      member.operation === 'create'
        ? dependencyReservations.get(member.key)
        : member.dependencyId;
    const materialized = id === undefined ? undefined : dependencies.get(id);
    if (materialized === undefined) return false;
    if (member.operation === 'reuse') {
      const prior = baseDeliveryPlan?.dependencies.find(
        ({ id }) => id === member.dependencyId,
      );
      if (
        materialized.revision !== member.expectedRevision ||
        (baseDeliveryPlan !== undefined &&
          (prior === undefined || !sameJson(materialized, prior)))
      ) {
        return false;
      }
      continue;
    }
    const prior =
      member.operation === 'revise'
        ? baseDeliveryPlan?.dependencies.find(
            ({ id }) => id === member.dependencyId,
          )
        : undefined;
    if (
      materialized.revision !==
        (member.operation === 'create' ? 1 : member.expectedRevision + 1) ||
      materialized.lifecycle !==
        (member.operation === 'create' ? 'active' : member.lifecycle) ||
      (member.operation === 'create' &&
        (materialized.prerequisiteTaskId !==
          resolveTaskId(member.prerequisite) ||
          materialized.dependentTaskId !== resolveTaskId(member.dependent))) ||
      (member.operation === 'revise' &&
        baseDeliveryPlan !== undefined &&
        (materialized.prerequisiteTaskId !== prior?.prerequisiteTaskId ||
          materialized.dependentTaskId !== prior?.dependentTaskId)) ||
      materialized.proposalId !== proposal.id ||
      materialized.deliveryPlanRevision !== plan.revision ||
      materialized.approvedAt !== plan.approvedAt
    ) {
      return false;
    }
  }

  const milestoneRevisions = new Map(
    deliveryPlan.milestones.map(({ id, revision }) => [id, revision]),
  );
  const taskRevisions = new Map(
    deliveryPlan.taskContracts.map(({ id, contractRevision }) => [
      id,
      contractRevision,
    ]),
  );
  const expectedTraces = proposal.proposedPlan.traces.map((trace) => {
    if (trace.kind === 'milestone_covers') {
      const milestoneId = resolveMilestoneId(trace.milestone);
      const milestoneRevision =
        milestoneId === undefined
          ? undefined
          : milestoneRevisions.get(milestoneId);
      return `milestone_covers:${milestoneId}:${milestoneRevision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
    }
    const taskId = resolveTaskId(trace.task);
    const taskRevision =
      taskId === undefined ? undefined : taskRevisions.get(taskId);
    return `task_satisfies:${taskId}:${taskRevision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
  });
  const actualTraces = deliveryPlan.traces.map((trace) =>
    trace.kind === 'milestone_covers'
      ? `milestone_covers:${trace.milestoneId}:${trace.milestoneRevision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`
      : `task_satisfies:${trace.taskId}:${trace.taskContractRevision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`,
  );
  return (
    new Set(expectedTraces).size === expectedTraces.length &&
    expectedTraces.length === actualTraces.length &&
    expectedTraces.every((trace) => actualTraces.includes(trace))
  );
};

function proposalDiffMatchesBase(
  proposal: DeliveryPlanProposal,
  base: ApprovedDeliveryPlan,
) {
  if (
    proposal.reservations.milestones.some(
      ({ id }) =>
        base.milestones.some((member) => member.id === id) ||
        base.traces.some(
          (trace) =>
            trace.kind === 'milestone_covers' && trace.milestoneId === id,
        ),
    ) ||
    proposal.reservations.tasks.some(
      ({ id }) =>
        base.taskContracts.some((member) => member.id === id) ||
        base.traces.some(
          (trace) => trace.kind === 'task_satisfies' && trace.taskId === id,
        ),
    ) ||
    proposal.reservations.dependencies.some(({ id }) =>
      base.dependencies.some((member) => member.id === id),
    )
  ) {
    return false;
  }
  const baseCollections = {
    milestones: new Map(base.milestones.map((member) => [member.id, member])),
    tasks: new Map(base.taskContracts.map((member) => [member.id, member])),
    dependencies: new Map(
      base.dependencies.map((member) => [member.id, member]),
    ),
  };
  const expected = {
    milestones: { create: 0, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
    tasks: { create: 0, reuse: 0, revise: 0, retire: 0, reactivate: 0 },
    dependencies: {
      create: 0,
      reuse: 0,
      revise: 0,
      retire: 0,
      reactivate: 0,
    },
  };
  for (const [name, members] of [
    ['milestones', proposal.proposedPlan.milestones],
    ['tasks', proposal.proposedPlan.tasks],
    ['dependencies', proposal.proposedPlan.dependencies],
  ] as const) {
    const baseIds = new Set<string>(baseCollections[name].keys());
    const representedBaseIds = new Set<string>();
    for (const member of members) {
      if (member.operation === 'create') {
        expected[name].create += 1;
        continue;
      }
      const id =
        'milestoneId' in member
          ? member.milestoneId
          : 'taskId' in member
            ? member.taskId
            : member.dependencyId;
      const prior = baseCollections[name].get(id as never) as
        | { revision: number; lifecycle: string }
        | undefined;
      const guardedRevision =
        'expectedContractRevision' in member
          ? member.expectedContractRevision
          : member.expectedRevision;
      if (prior?.revision !== guardedRevision) return false;
      representedBaseIds.add(id);
      if (member.operation === 'reuse') {
        expected[name].reuse += 1;
      } else if (prior.lifecycle === member.lifecycle) {
        expected[name].revise += 1;
      } else if (member.lifecycle === 'retired') {
        expected[name].retire += 1;
      } else {
        expected[name].reactivate += 1;
      }
    }
    if (
      representedBaseIds.size !== baseIds.size ||
      [...baseIds].some((id) => !representedBaseIds.has(id))
    ) {
      return false;
    }
  }

  const milestoneReservations = new Map(
    proposal.reservations.milestones.map(({ key, id }) => [key, id]),
  );
  const taskReservations = new Map(
    proposal.reservations.tasks.map(({ key, id }) => [key, id]),
  );
  const effectiveMilestones = proposal.proposedPlan.milestones.map((member) => {
    if (member.operation === 'create') {
      return {
        id: milestoneReservations.get(member.key),
        ordinal: member.content.ordinal,
      };
    }
    return {
      id: member.milestoneId,
      ordinal:
        member.operation === 'reuse'
          ? baseCollections.milestones.get(member.milestoneId)?.ordinal
          : member.content.ordinal,
    };
  });
  if (
    effectiveMilestones.some(
      (milestone, index) =>
        milestone.id === undefined || milestone.ordinal !== index + 1,
    )
  ) {
    return false;
  }
  const effectiveMilestoneIds = new Set(
    effectiveMilestones.map(({ id }) => id as string),
  );
  const taskOrdinals = new Map<string, number>();
  for (const member of proposal.proposedPlan.tasks) {
    const prior =
      member.operation === 'create'
        ? undefined
        : baseCollections.tasks.get(member.taskId);
    const milestoneId =
      member.operation === 'reuse'
        ? prior?.milestoneId
        : member.content.milestone.kind === 'canonical'
          ? member.content.milestone.milestoneId
          : milestoneReservations.get(member.content.milestone.key);
    const ordinal =
      member.operation === 'reuse' ? prior?.ordinal : member.content.ordinal;
    const expectedOrdinal =
      milestoneId === undefined ? 1 : (taskOrdinals.get(milestoneId) ?? 0) + 1;
    if (
      milestoneId === undefined ||
      !effectiveMilestoneIds.has(milestoneId) ||
      ordinal !== expectedOrdinal
    ) {
      return false;
    }
    taskOrdinals.set(milestoneId, expectedOrdinal);
  }
  const milestoneRevisions = new Map(
    proposal.proposedPlan.milestones.map((member) => [
      member.operation === 'create'
        ? milestoneReservations.get(member.key)
        : member.milestoneId,
      member.operation === 'create'
        ? 1
        : member.expectedRevision + (member.operation === 'revise' ? 1 : 0),
    ]),
  );
  const taskRevisions = new Map(
    proposal.proposedPlan.tasks.map((member) => [
      member.operation === 'create'
        ? taskReservations.get(member.key)
        : member.taskId,
      member.operation === 'create'
        ? 1
        : member.operation === 'reuse'
          ? member.expectedContractRevision
          : member.expectedCurrentRevision + 1,
    ]),
  );
  const proposedTraceKeys = new Set(
    proposal.proposedPlan.traces.map((trace) => {
      if (trace.kind === 'milestone_covers') {
        const id =
          trace.milestone.kind === 'canonical'
            ? trace.milestone.milestoneId
            : milestoneReservations.get(trace.milestone.key);
        return `${trace.kind}:${id}:${milestoneRevisions.get(id)}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
      }
      const id =
        trace.task.kind === 'canonical'
          ? trace.task.taskId
          : taskReservations.get(trace.task.key);
      return `${trace.kind}:${id}:${taskRevisions.get(id)}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
    }),
  );
  const baseTraceKeys = new Set(
    base.traces.map((trace) =>
      trace.kind === 'milestone_covers'
        ? `${trace.kind}:${trace.milestoneId}:${trace.milestoneRevision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`
        : `${trace.kind}:${trace.taskId}:${trace.taskContractRevision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`,
    ),
  );
  return (
    sameJson(proposal.diff.milestones, expected.milestones) &&
    sameJson(proposal.diff.tasks, expected.tasks) &&
    sameJson(proposal.diff.dependencies, expected.dependencies) &&
    proposal.diff.traceCreateCount ===
      [...proposedTraceKeys].filter((trace) => !baseTraceKeys.has(trace))
        .length &&
    proposal.diff.traceRemoveCount ===
      [...baseTraceKeys].filter((trace) => !proposedTraceKeys.has(trace)).length
  );
}

export const approvedDeliveryPlanMaterializationSchema = z
  .strictObject({
    proposal: deliveryPlanProposalSchema,
    baseDeliveryPlan: approvedDeliveryPlanSchema.nullable(),
    deliveryPlan: approvedDeliveryPlanSchema,
  })
  .refine(
    ({ proposal, baseDeliveryPlan, deliveryPlan }) => {
      const base = proposal.base.deliveryPlan;
      const baseMatches =
        base.id === null
          ? baseDeliveryPlan === null
          : baseDeliveryPlan !== null &&
            baseDeliveryPlan.plan.id === base.id &&
            baseDeliveryPlan.plan.revision === base.revision &&
            baseDeliveryPlan.plan.projectId === proposal.projectId &&
            proposalDiffMatchesBase(proposal, baseDeliveryPlan);
      return (
        baseMatches &&
        matchesApprovedMaterialization(proposal, baseDeliveryPlan, deliveryPlan)
      );
    },
    {
      path: ['deliveryPlan'],
      message:
        'Approved delivery plan must exactly materialize its plan proposal',
    },
  );

export const approvedDeliveryPlanPublicMaterializationSchema = z
  .strictObject({
    proposal: deliveryPlanProposalSchema,
    deliveryPlan: approvedDeliveryPlanSchema,
  })
  .refine(
    ({ proposal, deliveryPlan }) =>
      matchesApprovedMaterialization(proposal, undefined, deliveryPlan),
    {
      path: ['deliveryPlan'],
      message:
        'Approved delivery plan must locally materialize its plan proposal',
    },
  );

export const taskReadinessBlockerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan_not_approved') }),
  z.strictObject({
    kind: z.literal('plan_stale'),
    expectedLedgerRevision: positiveIntegerSchema,
    actualLedgerRevision: positiveIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal('milestone_retired'),
    milestoneId: milestoneIdSchema,
  }),
  z.strictObject({ kind: z.literal('task_completed') }),
  z.strictObject({ kind: z.literal('task_retired') }),
  z.strictObject({
    kind: z.literal('dependency_incomplete'),
    dependencyId: taskDependencyIdSchema,
    prerequisiteTaskId: taskIdSchema,
  }),
]);
export type TaskReadinessBlocker = z.infer<typeof taskReadinessBlockerSchema>;

const dependencyBlockedReadinessSchema = z
  .strictObject({
    state: z.literal('blocked'),
    blockers: z
      .array(
        z.strictObject({
          kind: z.literal('dependency_incomplete'),
          dependencyId: taskDependencyIdSchema,
          prerequisiteTaskId: taskIdSchema,
        }),
      )
      .min(1)
      .max(200)
      .readonly(),
  })
  .superRefine((value, context) => {
    const ids = value.blockers.map(({ dependencyId }) => dependencyId);
    const sorted = [...ids].sort();
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id, index) => id !== sorted[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['blockers'],
        message:
          'Dependency blockers must be unique and ordered by dependency ID',
      });
    }
  });

export const taskReadinessSchema = z.union([
  z.strictObject({
    state: z.literal('actionable'),
    blockers: z.tuple([]).readonly(),
  }),
  z.strictObject({
    state: z.literal('blocked'),
    blockers: z
      .tuple([z.strictObject({ kind: z.literal('plan_not_approved') })])
      .readonly(),
  }),
  z.strictObject({
    state: z.literal('blocked'),
    blockers: z
      .tuple([
        z.strictObject({
          kind: z.literal('plan_stale'),
          expectedLedgerRevision: positiveIntegerSchema,
          actualLedgerRevision: positiveIntegerSchema,
        }),
      ])
      .readonly(),
  }),
  dependencyBlockedReadinessSchema,
  z.strictObject({
    state: z.literal('inactive'),
    blockers: z
      .tuple([
        z.strictObject({
          kind: z.literal('milestone_retired'),
          milestoneId: milestoneIdSchema,
        }),
      ])
      .readonly(),
  }),
  z.strictObject({
    state: z.literal('inactive'),
    blockers: z
      .tuple([z.strictObject({ kind: z.literal('task_completed') })])
      .readonly(),
  }),
  z.strictObject({
    state: z.literal('inactive'),
    blockers: z
      .tuple([z.strictObject({ kind: z.literal('task_retired') })])
      .readonly(),
  }),
]);
export type TaskReadiness = z.infer<typeof taskReadinessSchema>;

const validateLegacyCore = (
  value: LegacyM2PlanningCycleView,
  context: z.RefinementCtx,
) => {
  const parsed = legacyM2PlanningCycleViewSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
    }
  }
};

const validateSharedPlanningCore = (
  value: {
    cycle: z.infer<typeof planningCycleSchema>;
    turns: readonly z.infer<typeof planningTurnSchema>[];
    questions: readonly z.infer<typeof planningQuestionSchema>[];
  },
  context: z.RefinementCtx,
) => {
  const turnsById = new Map(value.turns.map((turn) => [turn.id, turn]));
  value.turns.forEach((turn, index) => {
    if (turn.ordinal !== index + 1) {
      context.addIssue({
        code: 'custom',
        path: ['turns', index, 'ordinal'],
        message: 'Planning turn ordinals must be ordered and contiguous',
      });
    }
    if (
      turn.projectId !== value.cycle.projectId ||
      turn.planningCycleId !== value.cycle.id
    ) {
      context.addIssue({
        code: 'custom',
        path: ['turns', index],
        message: 'Planning view children must match the cycle project and ID',
      });
    }
    if (turn.actor === 'pm') {
      const triggeringTurn = value.turns[index - 1];
      if (
        triggeringTurn?.actor !== 'human' ||
        triggeringTurn.launchState !== 'execution_bound'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['turns', index],
          message:
            'PM turns must immediately follow an execution-bound human turn',
        });
      } else if (turn.executionId !== triggeringTurn.executionId) {
        context.addIssue({
          code: 'custom',
          path: ['turns', index, 'executionId'],
          message: 'Paired human and PM turns must share an execution',
        });
      }
    }
  });
  if (turnsById.size !== value.turns.length) {
    context.addIssue({
      code: 'custom',
      path: ['turns'],
      message: 'Planning turn IDs must be unique',
    });
  }
  const humanTurnCount = value.turns.filter(
    (turn) => turn.actor === 'human',
  ).length;
  if (humanTurnCount > 32 || value.turns.length - humanTurnCount > 32) {
    context.addIssue({
      code: 'custom',
      path: ['turns'],
      message: 'Planning cycles allow at most 32 turns for each actor',
    });
  }
  const questionIds = new Set<string>();
  value.questions.forEach((question, index) => {
    if (
      question.projectId !== value.cycle.projectId ||
      question.planningCycleId !== value.cycle.id
    ) {
      context.addIssue({
        code: 'custom',
        path: ['questions', index],
        message: 'Planning view children must match the cycle project and ID',
      });
    }
    const turn = turnsById.get(question.turnId);
    if (turn === undefined || turn.actor !== 'pm') {
      context.addIssue({
        code: 'custom',
        path: ['questions', index, 'turnId'],
        message:
          'Planning questions must reference a PM-authored turn in the view',
      });
    }
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: 'custom',
        path: ['questions', index, 'id'],
        message: 'Planning question IDs must be unique',
      });
    }
    questionIds.add(question.id);
  });
  const latestTurn = value.turns.at(-1);
  if (
    value.cycle.lifecycle === 'launch_pending' &&
    (latestTurn?.actor !== 'human' ||
      latestTurn.launchState !== 'launch_pending')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['turns'],
      message: 'Launch-pending cycles require a launch-pending human turn',
    });
  }
  if (
    value.cycle.lifecycle === 'execution_active' &&
    (latestTurn?.actor !== 'human' ||
      latestTurn.launchState !== 'execution_bound' ||
      value.cycle.activeExecutionId !== latestTurn.executionId)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['turns'],
      message: 'Execution-active cycles require the active bound human turn',
    });
  }
  if (
    value.cycle.lifecycle === 'awaiting_human' &&
    (latestTurn?.actor !== 'pm' ||
      !value.questions.some((question) => question.turnId === latestTurn.id))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['questions'],
      message:
        'Awaiting-human cycles require questions from the latest PM turn',
    });
  }
};

export const intentPlanningCycleViewSchema = z
  .strictObject({
    cycle: planningCycleSchema,
    purpose: z.strictObject({
      kind: z.literal('intent'),
      baseDeliveryPlanId: z.null(),
      baseDeliveryPlanRevision: z.null(),
    }),
    turns: z.array(planningTurnSchema).max(64).readonly(),
    questions: z.array(planningQuestionSchema).max(20).readonly(),
    proposals: z.array(planningProposalSchema).max(16).readonly(),
    deliveryPlanProposals: z.tuple([]).readonly(),
  })
  .superRefine((value, context) =>
    validateLegacyCore(
      {
        cycle: value.cycle,
        turns: value.turns,
        questions: value.questions,
        proposals: value.proposals,
      },
      context,
    ),
  );

export const deliveryPlanPlanningCycleViewSchema = z
  .strictObject({
    cycle: planningCycleSchema,
    purpose: z.union([
      z.strictObject({
        kind: z.literal('delivery_plan'),
        baseDeliveryPlanId: deliveryPlanIdSchema,
        baseDeliveryPlanRevision: positiveIntegerSchema,
      }),
      z.strictObject({
        kind: z.literal('delivery_plan'),
        baseDeliveryPlanId: z.null(),
        baseDeliveryPlanRevision: z.null(),
      }),
    ]),
    turns: z.array(planningTurnSchema).max(64).readonly(),
    questions: z.array(planningQuestionSchema).max(20).readonly(),
    proposals: z.tuple([]).readonly(),
    deliveryPlanProposals: z
      .array(deliveryPlanProposalSchema)
      .max(16)
      .readonly(),
  })
  .superRefine((value, context) => {
    validateSharedPlanningCore(value, context);
    const proposals = value.deliveryPlanProposals;
    const turnsById = new Map(value.turns.map((turn) => [turn.id, turn]));
    const proposalIds = new Set<string>();
    proposals.forEach((proposal, index) => {
      if (
        proposal.projectId !== value.cycle.projectId ||
        proposal.planningCycleId !== value.cycle.id ||
        proposal.revision !== index + 1
      ) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryPlanProposals', index],
          message: 'Plan proposals must match the cycle and be contiguous',
        });
      }
      const turn = turnsById.get(proposal.createdByTurnId);
      if (
        turn?.actor !== 'pm' ||
        proposal.createdByExecutionId !== turn.executionId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryPlanProposals', index, 'createdByTurnId'],
          message:
            'Plan proposals must reference their producing PM turn and execution',
        });
      }
      if (proposalIds.has(proposal.id)) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryPlanProposals', index, 'id'],
          message: 'Plan proposal IDs must be unique',
        });
      }
      proposalIds.add(proposal.id);
      if (
        proposal.base.projectIntentRevision !==
          value.cycle.baseProjectIntentRevision ||
        proposal.base.ledgerRevision !== value.cycle.baseLedgerRevision ||
        proposal.base.deliveryPlan.id !== value.purpose.baseDeliveryPlanId ||
        proposal.base.deliveryPlan.revision !==
          value.purpose.baseDeliveryPlanRevision
      ) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryPlanProposals', index, 'base', 'deliveryPlan'],
          message: 'Plan proposal base must match the cycle purpose base',
        });
      }
      if (index < proposals.length - 1 && proposal.lifecycle !== 'superseded') {
        context.addIssue({
          code: 'custom',
          path: ['deliveryPlanProposals', index, 'lifecycle'],
          message: 'Non-latest plan proposals must be superseded',
        });
      }
      if (index < proposals.length - 1) {
        const next = proposals[index + 1];
        if (
          proposal.decision.kind !== 'superseded' ||
          proposal.decision.reason !== 'replacement_accepted' ||
          proposal.decision.supersededByProposalId !== next.id
        ) {
          context.addIssue({
            code: 'custom',
            path: ['deliveryPlanProposals', index, 'decision'],
            message:
              'Replaced proposals must name the exact successor proposal',
          });
        }
      }
    });
    const latest = proposals.at(-1);
    if (value.cycle.latestProposalRevision !== (latest?.revision ?? 0)) {
      context.addIssue({
        code: 'custom',
        path: ['cycle', 'latestProposalRevision'],
        message: 'Cycle proposal revision must match delivery plan history',
      });
    }
    if (
      value.cycle.lifecycle === 'awaiting_approval' &&
      latest?.lifecycle !== 'awaiting_approval'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlanProposals'],
        message: 'Awaiting-approval cycles require an awaiting plan proposal',
      });
    }
    if (
      value.cycle.lifecycle === 'approved' &&
      latest?.lifecycle !== 'approved'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlanProposals'],
        message: 'Approved cycles require an approved plan proposal',
      });
    }
    if (
      value.cycle.lifecycle === 'proposal_rejected' &&
      latest?.lifecycle !== 'rejected'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlanProposals'],
        message: 'Rejected cycles require a rejected plan proposal',
      });
    }
    if (
      value.cycle.lifecycle === 'abandoned' &&
      latest !== undefined &&
      (latest.lifecycle !== 'superseded' ||
        latest.decision.kind !== 'superseded' ||
        latest.decision.reason !== 'cycle_abandoned' ||
        latest.decision.decidedAt !== value.cycle.endedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlanProposals'],
        message: 'Abandoned latest proposal must record cycle abandonment',
      });
    }
    const latestTurn = value.turns.at(-1);
    if (
      latest !== undefined &&
      (value.cycle.lifecycle === 'awaiting_approval' ||
        value.cycle.lifecycle === 'approved' ||
        value.cycle.lifecycle === 'proposal_rejected') &&
      latestTurn?.id !== latest.createdByTurnId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['turns'],
        message: 'Cycle must end at the plan-proposal-producing PM turn',
      });
    }
    const proposalTurnIndex = value.turns.findIndex(
      (turn) => turn.id === latest?.createdByTurnId,
    );
    const revisionHumanTurn = value.turns.at(-2);
    const awaitingHumanRevision =
      value.cycle.lifecycle === 'awaiting_human' &&
      latestTurn?.actor === 'pm' &&
      revisionHumanTurn?.actor === 'human' &&
      revisionHumanTurn.launchState === 'execution_bound' &&
      revisionHumanTurn.executionId === latestTurn.executionId &&
      proposalTurnIndex >= 0 &&
      proposalTurnIndex < value.turns.length - 2 &&
      value.questions.some((question) => question.turnId === latestTurn.id);
    const awaitingProposalMatchesCycle =
      latest?.lifecycle === 'awaiting_approval' &&
      (value.cycle.lifecycle === 'awaiting_approval' ||
        value.cycle.lifecycle === 'launch_pending' ||
        value.cycle.lifecycle === 'execution_active' ||
        awaitingHumanRevision ||
        (value.cycle.lifecycle === 'attention_required' &&
          latestTurn?.actor === 'human' &&
          (latestTurn.launchState === 'launch_pending' ||
            latestTurn.launchState === 'execution_bound')));
    if (
      latest?.lifecycle === 'awaiting_approval' &&
      !awaitingProposalMatchesCycle
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlanProposals', proposals.length - 1, 'lifecycle'],
        message:
          'Latest plan proposal lifecycle must match the cycle lifecycle',
      });
    }
    if (
      (latest?.lifecycle === 'approved' &&
        value.cycle.lifecycle !== 'approved') ||
      (latest?.lifecycle === 'rejected' &&
        value.cycle.lifecycle !== 'proposal_rejected') ||
      (latest?.lifecycle === 'superseded' &&
        value.cycle.lifecycle !== 'abandoned')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryPlanProposals', proposals.length - 1, 'lifecycle'],
        message:
          'Terminal plan proposal lifecycle must match the cycle lifecycle',
      });
    }
  });

export const planningCycleViewSchema = z.union([
  intentPlanningCycleViewSchema,
  deliveryPlanPlanningCycleViewSchema,
]);
export type PlanningCycleView = z.infer<typeof planningCycleViewSchema>;
export type IntentPlanningCycleView = z.infer<
  typeof intentPlanningCycleViewSchema
>;
export type DeliveryPlanPlanningCycleView = z.infer<
  typeof deliveryPlanPlanningCycleViewSchema
>;

export const planningConversationTurnSchema = z.strictObject({
  turnId: planningTurnIdSchema,
  actor: z.enum(['human', 'pm']),
  message: z.string().trim().min(1).max(16_384),
});
export type PlanningConversationTurn = z.infer<
  typeof planningConversationTurnSchema
>;

export const pmPlanAssignmentSchema = z
  .strictObject({
    kind: z.literal('pm_plan'),
    projectId: projectIdSchema,
    outputSchema: z.literal(PM_PLAN_REPORT_SCHEMA),
    planningCycleId: planningCycleIdSchema,
    humanTurnId: planningTurnIdSchema,
    expectedCycleRevision: nonNegativeIntegerSchema,
    expectedProposalRevision: positiveIntegerSchema,
    baseProjectIntentId: projectIntentIdSchema,
    baseProjectIntentRevision: positiveIntegerSchema,
    baseLedgerId: ledgerIdSchema,
    baseLedgerRevision: positiveIntegerSchema,
    baseDeliveryPlanId: deliveryPlanIdSchema.nullable(),
    baseDeliveryPlanRevision: positiveIntegerSchema.nullable(),
    input: z.strictObject({
      conversation: z.array(planningConversationTurnSchema).max(64).readonly(),
      approvedIntentLedger: approvedIntentLedgerSchema,
      latestProposal: deliveryPlanProposalSchema.nullable(),
      approvedDeliveryPlan: approvedDeliveryPlanSchema.nullable(),
    }),
  })
  .superRefine((value, context) => {
    if (
      (value.baseDeliveryPlanId === null) !==
      (value.baseDeliveryPlanRevision === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['baseDeliveryPlanRevision'],
        message: 'Plan base ID and revision must be jointly null or non-null',
      });
    }
    const latestTurn = value.input.conversation.at(-1);
    if (
      latestTurn?.actor !== 'human' ||
      latestTurn.turnId !== value.humanTurnId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['humanTurnId'],
        message: 'Assignment must end at its target human turn',
      });
    }
    const conversationTurnIds = value.input.conversation.map(
      ({ turnId }) => turnId,
    );
    const humanTurnCount = value.input.conversation.filter(
      ({ actor }) => actor === 'human',
    ).length;
    if (
      new Set(conversationTurnIds).size !== conversationTurnIds.length ||
      humanTurnCount > 32 ||
      value.input.conversation.length - humanTurnCount > 32
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'conversation'],
        message: 'Conversation turns must be unique and bounded per actor',
      });
    }
    const approved = value.input.approvedIntentLedger;
    if (
      approved.projectIntent.projectId !== value.projectId ||
      approved.projectIntent.id !== value.baseProjectIntentId ||
      approved.projectIntent.revision !== value.baseProjectIntentRevision ||
      approved.ledger.id !== value.baseLedgerId ||
      approved.ledger.revision !== value.baseLedgerRevision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'approvedIntentLedger'],
        message: 'Assignment intent and ledger must match its exact base',
      });
    }
    if (
      !approved.records.some(
        (record) =>
          record.content.type === 'requirement' &&
          record.content.status === 'approved',
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'approvedIntentLedger', 'records'],
        message: 'Plan assignments require an approved current requirement',
      });
    }
    const approvedDeliveryPlan = value.input.approvedDeliveryPlan;
    const approvedPlan = approvedDeliveryPlan?.plan ?? null;
    if (
      (approvedPlan?.id ?? null) !== value.baseDeliveryPlanId ||
      (approvedPlan?.revision ?? null) !== value.baseDeliveryPlanRevision ||
      (approvedPlan !== null && approvedPlan.projectId !== value.projectId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'approvedDeliveryPlan'],
        message: 'Assignment approved plan must match its exact base',
      });
    }
    const latestProposal = value.input.latestProposal;
    if (
      value.expectedProposalRevision !== (latestProposal?.revision ?? 0) + 1 ||
      (latestProposal !== null &&
        (latestProposal.projectId !== value.projectId ||
          latestProposal.planningCycleId !== value.planningCycleId ||
          latestProposal.base.projectIntentId !== value.baseProjectIntentId ||
          latestProposal.base.projectIntentRevision !==
            value.baseProjectIntentRevision ||
          latestProposal.base.ledgerId !== value.baseLedgerId ||
          latestProposal.base.ledgerRevision !== value.baseLedgerRevision ||
          latestProposal.base.deliveryPlan.id !== value.baseDeliveryPlanId ||
          latestProposal.base.deliveryPlan.revision !==
            value.baseDeliveryPlanRevision))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedProposalRevision'],
        message: 'Expected proposal revision must follow this cycle history',
      });
    }
    if (
      latestProposal !== null &&
      latestProposal.proposedPlan.traces.some((trace) =>
        approved.records.every(
          (record) =>
            record.recordId !== trace.requirement.recordId ||
            record.revision !== trace.requirement.recordRevision ||
            record.content.type !== 'requirement' ||
            record.content.status !== 'approved',
        ),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'latestProposal', 'proposedPlan', 'traces'],
        message: 'Proposal traces must target current approved requirements',
      });
    }
    if (
      latestProposal !== null &&
      approvedDeliveryPlan !== null &&
      !proposalDiffMatchesBase(latestProposal, approvedDeliveryPlan)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input', 'latestProposal', 'diff'],
        message: 'Proposal diff must exactly match its frozen approved plan',
      });
    }
  });
export type PmPlanAssignment = z.infer<typeof pmPlanAssignmentSchema>;

export const pmPlanReportSchema = z.strictObject({
  schema: z.literal(PM_PLAN_REPORT_SCHEMA),
  planningCycleId: planningCycleIdSchema,
  humanTurnId: planningTurnIdSchema,
  expectedCycleRevision: nonNegativeIntegerSchema,
  expectedProposalRevision: positiveIntegerSchema,
  assistantMessage: planTextSchema,
  result: z.discriminatedUnion('kind', [
    pmQuestionResultSchema,
    z.strictObject({
      kind: z.literal('plan_proposal'),
      proposal: proposedDeliveryPlanSchema,
    }),
  ]),
});
export type PmPlanReport = z.infer<typeof pmPlanReportSchema>;
