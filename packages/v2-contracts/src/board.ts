import { z } from 'zod';

import {
  planLabelSchema,
  planTextSchema,
  taskReadinessSchema,
} from './delivery-plan';
import {
  isoTimestampSchema,
  ledgerRecordIdSchema,
  milestoneIdSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  projectIdSchema,
  taskDependencyIdSchema,
  taskIdSchema,
} from './ids';
import { requirementKindSchema } from './intent';

export const taskLifecycleSchema = z.enum(['pending', 'completed', 'retired']);
export type TaskLifecycle = z.infer<typeof taskLifecycleSchema>;
export const readinessStateSchema = z.enum([
  'actionable',
  'blocked',
  'inactive',
]);
export type ReadinessState = z.infer<typeof readinessStateSchema>;
export const taskPrioritySchema = z.enum(['must', 'should', 'could']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

const compareUnicodeCodePoints = (left: string, right: string) => {
  const leftPoints = [...left].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightPoints = [...right].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

const isCanonical = <T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
) =>
  values.every(
    (value, index) => index === 0 || compare(values[index - 1], value) < 0,
  );

const uniqueArray = <T extends z.ZodType>(
  schema: T,
  maximum: number,
  compare: (left: z.infer<T>, right: z.infer<T>) => number,
) =>
  z
    .array(schema)
    .max(maximum)
    .readonly()
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          message: 'Filter values must be unique',
        });
      }
      if (!isCanonical(values, compare)) {
        context.addIssue({
          code: 'custom',
          message: 'Filter values must use canonical order',
        });
      }
    });

const boundedArray = <T extends z.ZodType>(schema: T, maximum: number) =>
  z.array(schema).max(maximum).readonly();

const enumOrder = (values: readonly string[]) => {
  const ranks = new Map(values.map((value, index) => [value, index] as const));
  return (left: string, right: string) =>
    (ranks.get(left) ?? -1) - (ranks.get(right) ?? -1);
};

const boardFilterSelectionShape = {
  milestoneIds: boundedArray(milestoneIdSchema, 20),
  taskLifecycles: boundedArray(taskLifecycleSchema, 3),
  readiness: boundedArray(readinessStateSchema, 3),
  priorities: boundedArray(taskPrioritySchema, 3),
  labels: boundedArray(planLabelSchema, 100),
  requirementRecordIds: boundedArray(ledgerRecordIdSchema, 300),
};

const canonicalBoardFilterSelectionShape = {
  milestoneIds: uniqueArray(milestoneIdSchema, 20, compareUnicodeCodePoints),
  taskLifecycles: uniqueArray(
    taskLifecycleSchema,
    3,
    enumOrder(['pending', 'completed', 'retired'] as const),
  ),
  readiness: uniqueArray(
    readinessStateSchema,
    3,
    enumOrder(['actionable', 'blocked', 'inactive'] as const),
  ),
  priorities: uniqueArray(
    taskPrioritySchema,
    3,
    enumOrder(['must', 'should', 'could'] as const),
  ),
  labels: uniqueArray(planLabelSchema, 100, compareUnicodeCodePoints),
  requirementRecordIds: uniqueArray(
    ledgerRecordIdSchema,
    300,
    compareUnicodeCodePoints,
  ),
};

export const boardFilterSelectionSchema = z.strictObject(
  boardFilterSelectionShape,
);
export type BoardFilterSelection = z.infer<typeof boardFilterSelectionSchema>;

export const boardFilterSchema = z.strictObject({
  projectId: projectIdSchema,
  revision: positiveIntegerSchema,
  ...canonicalBoardFilterSelectionShape,
  updatedAt: isoTimestampSchema,
});
export type BoardFilter = z.infer<typeof boardFilterSchema>;

const boardFacetOption = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    value,
    label: z.string().trim().min(1).max(4096),
    selected: z.boolean(),
    matchingTaskCount: nonNegativeIntegerSchema.max(100),
  });

export const boardTaskLifecycleOptionSchema =
  boardFacetOption(taskLifecycleSchema);
export const boardReadinessOptionSchema =
  boardFacetOption(readinessStateSchema);
export const boardPriorityOptionSchema = boardFacetOption(taskPrioritySchema);

export const boardMilestoneOptionSchema = boardFacetOption(milestoneIdSchema)
  .extend({
    milestoneRevision: positiveIntegerSchema,
    lifecycle: z.enum(['active', 'retired']),
    historical: z.boolean(),
  })
  .superRefine((value, context) => {
    if (
      value.historical &&
      (!value.selected || value.matchingTaskCount !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['historical'],
        message: 'Historical milestones must be selected zero-count options',
      });
    }
  });
export type BoardMilestoneOption = z.infer<typeof boardMilestoneOptionSchema>;

export const boardRequirementOptionSchema = boardFacetOption(
  ledgerRecordIdSchema,
)
  .extend({
    recordRevision: positiveIntegerSchema,
    requirementKind: requirementKindSchema,
    historical: z.boolean(),
  })
  .superRefine((value, context) => {
    if (
      value.historical &&
      (!value.selected || value.matchingTaskCount !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['historical'],
        message: 'Historical requirements must be selected zero-count options',
      });
    }
  });
export type BoardRequirementOption = z.infer<
  typeof boardRequirementOptionSchema
>;

export const boardLabelOptionSchema = boardFacetOption(planLabelSchema)
  .extend({ historical: z.boolean() })
  .superRefine((value, context) => {
    if (value.label !== value.value) {
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'Board label display must equal its canonical value',
      });
    }
    if (
      value.historical &&
      (!value.selected || value.matchingTaskCount !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['historical'],
        message: 'Historical labels must be selected zero-count options',
      });
    }
  });
export type BoardLabelOption = z.infer<typeof boardLabelOptionSchema>;

export type BoardFacetOption<Value> = Readonly<{
  value: Value;
  label: string;
  selected: boolean;
  matchingTaskCount: number;
}>;

export const boardDependencySummarySchema = z.strictObject({
  dependencyId: taskDependencyIdSchema,
  dependencyRevision: positiveIntegerSchema,
  direction: z.enum(['prerequisite', 'dependent']),
  otherTaskId: taskIdSchema,
  otherTaskTitle: z.string().trim().min(1).max(4096),
  otherTaskLifecycle: taskLifecycleSchema,
});
export type BoardDependencySummary = z.infer<
  typeof boardDependencySummarySchema
>;

export const boardTaskDetailSchema = z.strictObject({
  acceptanceCriteria: z.array(planTextSchema).min(1).max(20).readonly(),
  verificationCriteria: z.array(planTextSchema).min(1).max(20).readonly(),
  ownedSurfaces: z.array(planTextSchema).max(20).readonly(),
  prohibitedSurfaces: z.array(planTextSchema).max(20).readonly(),
  expectedArtifacts: z.array(planTextSchema).max(20).readonly(),
  milestoneOutcome: planTextSchema,
  milestoneStopCondition: planTextSchema,
  milestoneExclusions: z.array(planTextSchema).max(20).readonly(),
  requirementTraces: z
    .array(
      z.strictObject({
        recordId: ledgerRecordIdSchema,
        recordRevision: positiveIntegerSchema,
        title: z.string().trim().min(1).max(4096),
      }),
    )
    .max(300)
    .readonly(),
});
export type BoardTaskDetail = z.infer<typeof boardTaskDetailSchema>;

export const boardTaskCardSchema = z
  .strictObject({
    taskId: taskIdSchema,
    taskContractRevision: positiveIntegerSchema,
    taskCurrentRevision: positiveIntegerSchema,
    milestoneId: milestoneIdSchema,
    milestoneRevision: positiveIntegerSchema,
    title: z.string().trim().min(1).max(4096),
    outcome: planTextSchema,
    lifecycle: taskLifecycleSchema,
    priority: taskPrioritySchema,
    labels: z.array(planLabelSchema).max(20).readonly(),
    readiness: taskReadinessSchema,
    dependencies: z.array(boardDependencySummarySchema).max(200).readonly(),
    detail: boardTaskDetailSchema,
  })
  .superRefine((value, context) => {
    if (value.taskCurrentRevision < value.taskContractRevision) {
      context.addIssue({
        code: 'custom',
        path: ['taskCurrentRevision'],
        message: 'Current task revision cannot precede its contract anchor',
      });
    }
    if (new Set(value.labels).size !== value.labels.length) {
      context.addIssue({
        code: 'custom',
        path: ['labels'],
        message: 'Board task labels must be unique',
      });
    }
    const blocker = value.readiness.blockers[0];
    const retiredMilestone = blocker?.kind === 'milestone_retired';
    const terminalTaskBlocker =
      blocker?.kind === 'task_completed' || blocker?.kind === 'task_retired';
    if (
      (value.lifecycle === 'pending' && terminalTaskBlocker) ||
      (value.lifecycle === 'completed' &&
        !retiredMilestone &&
        blocker?.kind !== 'task_completed') ||
      (value.lifecycle === 'retired' &&
        !retiredMilestone &&
        blocker?.kind !== 'task_retired')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['readiness'],
        message: 'Board task readiness must match its task lifecycle',
      });
    }
    if (retiredMilestone && blocker.milestoneId !== value.milestoneId) {
      context.addIssue({
        code: 'custom',
        path: ['readiness', 'blockers', 0, 'milestoneId'],
        message: 'Retired-milestone readiness must name the task milestone',
      });
    }
    const dependencyIds = value.dependencies.map(
      (dependency) => dependency.dependencyId,
    );
    if (!isCanonical(dependencyIds, compareUnicodeCodePoints)) {
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'Board dependency summaries must be unique and ordered',
      });
    }
    const traceKeys = value.detail.requirementTraces.map(
      (trace) => `${trace.recordId}:${trace.recordRevision}`,
    );
    if (!isCanonical(traceKeys, compareUnicodeCodePoints)) {
      context.addIssue({
        code: 'custom',
        path: ['detail', 'requirementTraces'],
        message: 'Board requirement traces must be unique and ordered',
      });
    }
  });
export type BoardTaskCard = z.infer<typeof boardTaskCardSchema>;

const uniqueOptions = (
  values: readonly { value: unknown }[],
  path: (string | number)[],
  context: z.RefinementCtx,
) => {
  const keys = values.map(({ value }) => String(value));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Board facet options must be unique',
    });
  }
};

export const boardViewSchema = z
  .strictObject({
    projectId: projectIdSchema,
    deliveryPlanRevision: positiveIntegerSchema.nullable(),
    stale: z.boolean(),
    emptyReason: z
      .enum([
        'intent_required',
        'planning_required',
        'plan_empty',
        'filter_empty',
      ])
      .nullable(),
    filter: boardFilterSchema.nullable(),
    totalTaskCount: nonNegativeIntegerSchema.max(100),
    matchedTaskCount: nonNegativeIntegerSchema.max(100),
    facets: z.strictObject({
      milestones: z.array(boardMilestoneOptionSchema).max(40).readonly(),
      taskLifecycles: z.array(boardTaskLifecycleOptionSchema).max(3).readonly(),
      readiness: z.array(boardReadinessOptionSchema).max(3).readonly(),
      priorities: z.array(boardPriorityOptionSchema).max(3).readonly(),
      labels: z.array(boardLabelOptionSchema).max(2100).readonly(),
      requirements: z.array(boardRequirementOptionSchema).max(600).readonly(),
    }),
    cards: z.array(boardTaskCardSchema).max(100).readonly(),
  })
  .superRefine((value, context) => {
    if (value.matchedTaskCount > value.totalTaskCount) {
      context.addIssue({
        code: 'custom',
        path: ['matchedTaskCount'],
        message: 'Matched Board count cannot exceed total count',
      });
    }
    if (value.cards.length !== value.matchedTaskCount) {
      context.addIssue({
        code: 'custom',
        path: ['cards'],
        message: 'Board card count must equal matched task count',
      });
    }
    if (value.filter !== null && value.filter.projectId !== value.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['filter', 'projectId'],
        message: 'Board filter must match the Board project',
      });
    }
    const beforePlan = value.deliveryPlanRevision === null;
    if (beforePlan !== (value.filter === null)) {
      context.addIssue({
        code: 'custom',
        path: ['filter'],
        message:
          'Approved plans require one Board filter and pre-plan Boards forbid one',
      });
    }
    if (
      beforePlan &&
      value.emptyReason !== 'intent_required' &&
      value.emptyReason !== 'planning_required'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['emptyReason'],
        message:
          'Pre-plan Board requires an intent-required or planning-required reason',
      });
    }
    const fixedFacetValues = {
      taskLifecycles: ['pending', 'completed', 'retired'],
      readiness: ['actionable', 'blocked', 'inactive'],
      priorities: ['must', 'should', 'could'],
    } as const;
    for (const [name, expected] of Object.entries(fixedFacetValues)) {
      const actual = value.facets[name as keyof typeof fixedFacetValues].map(
        ({ value: option }) => option,
      );
      if (
        beforePlan
          ? actual.length !== 0
          : actual.length !== expected.length ||
            actual.some((option, index) => option !== expected[index])
      ) {
        context.addIssue({
          code: 'custom',
          path: ['facets', name],
          message:
            'Board enum facets must be empty before planning and complete afterward',
        });
      }
    }
    if (
      (value.emptyReason === 'intent_required' ||
        value.emptyReason === 'planning_required') &&
      (!beforePlan ||
        value.stale ||
        value.filter !== null ||
        value.totalTaskCount !== 0 ||
        value.matchedTaskCount !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['emptyReason'],
        message:
          'Pre-plan Board empty reasons require an empty null-filter Board',
      });
    }
    if (
      value.emptyReason === 'plan_empty' &&
      (beforePlan || value.totalTaskCount !== 0 || value.matchedTaskCount !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['emptyReason'],
        message: 'Plan-empty requires an approved empty plan',
      });
    }
    if (
      value.emptyReason === 'filter_empty' &&
      (beforePlan || value.totalTaskCount === 0 || value.matchedTaskCount !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['emptyReason'],
        message: 'Filter-empty requires existing tasks and zero matches',
      });
    }
    const expectedEmptyReason = beforePlan
      ? value.emptyReason
      : value.totalTaskCount === 0
        ? 'plan_empty'
        : value.matchedTaskCount === 0
          ? 'filter_empty'
          : null;
    if (value.emptyReason !== expectedEmptyReason) {
      context.addIssue({
        code: 'custom',
        path: ['emptyReason'],
        message: 'Board empty reason must match its plan and task counts',
      });
    }
    for (const [name, options] of Object.entries(value.facets)) {
      uniqueOptions(options, ['facets', name], context);
      options.forEach((option, index) => {
        if (option.matchingTaskCount > value.totalTaskCount) {
          context.addIssue({
            code: 'custom',
            path: ['facets', name, index, 'matchingTaskCount'],
            message: 'Facet count cannot exceed total task count',
          });
        }
      });
    }
    const canonicalFacetValues = [
      ['milestones', value.facets.milestones, compareUnicodeCodePoints],
      [
        'taskLifecycles',
        value.facets.taskLifecycles,
        enumOrder(['pending', 'completed', 'retired'] as const),
      ],
      [
        'readiness',
        value.facets.readiness,
        enumOrder(['actionable', 'blocked', 'inactive'] as const),
      ],
      [
        'priorities',
        value.facets.priorities,
        enumOrder(['must', 'should', 'could'] as const),
      ],
      ['labels', value.facets.labels, compareUnicodeCodePoints],
      ['requirements', value.facets.requirements, compareUnicodeCodePoints],
    ] as const;
    for (const [name, options, compare] of canonicalFacetValues) {
      if (
        !isCanonical(
          options.map(({ value: option }) => option),
          compare,
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['facets', name],
          message: 'Board facet options must use canonical ordering',
        });
      }
    }
    const labels = value.facets.labels.map(({ value: label }) => label);
    if (!isCanonical(labels, compareUnicodeCodePoints)) {
      context.addIssue({
        code: 'custom',
        path: ['facets', 'labels'],
        message: 'Board labels must use canonical Unicode ordering',
      });
    }
    if (value.filter !== null) {
      const selectedByFacet = {
        milestones: new Set(value.filter.milestoneIds),
        taskLifecycles: new Set(value.filter.taskLifecycles),
        readiness: new Set(value.filter.readiness),
        priorities: new Set(value.filter.priorities),
        labels: new Set(value.filter.labels),
        requirements: new Set(value.filter.requirementRecordIds),
      };
      for (const [name, options] of Object.entries(value.facets)) {
        const selected = selectedByFacet[name as keyof typeof selectedByFacet];
        options.forEach((option, index) => {
          if (option.selected !== selected.has(option.value as never)) {
            context.addIssue({
              code: 'custom',
              path: ['facets', name, index, 'selected'],
              message: 'Board facet selection must match the saved filter',
            });
          }
        });
        const optionValues = new Set(
          options.map(({ value: option }) => option),
        );
        if (
          [...selected].some(
            (selection) => !optionValues.has(selection as never),
          )
        ) {
          context.addIssue({
            code: 'custom',
            path: ['facets', name],
            message: 'Every saved Board selection must have a facet option',
          });
        }
      }
    }
    const cardIds = value.cards.map(({ taskId }) => taskId);
    if (new Set(cardIds).size !== cardIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['cards'],
        message: 'Board cards must use unique task identities',
      });
    }
  });
export type BoardView = z.infer<typeof boardViewSchema>;
