import { z } from 'zod';

import {
  developerAttemptIdSchema,
  executionRunIdSchema,
  executionRunItemIdSchema,
  isoTimestampSchema,
  ledgerRecordIdSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  projectIdSchema,
  taskIdSchema,
} from './ids';
import { gitCommitSchema } from './projects';
import { resolvedWorkerProfileSnapshotSchema } from './profiles';
import { deliveryPlanIdSchema } from './ids';

export const executionRunLifecycleSchema = z.enum([
  'running',
  'paused',
  'stopping',
  'completed',
]);
export type ExecutionRunLifecycle = z.infer<typeof executionRunLifecycleSchema>;

export const executionRunCompletionReasonSchema = z.enum([
  'finished',
  'stopped',
]);
export type ExecutionRunCompletionReason = z.infer<
  typeof executionRunCompletionReasonSchema
>;

export const executionRunItemLifecycleSchema = z.enum([
  'waiting',
  'launch_pending',
  'active',
  'completed',
  'attention_required',
  'not_started',
]);
export type ExecutionRunItemLifecycle = z.infer<
  typeof executionRunItemLifecycleSchema
>;

export const executionRunAttentionSchema = z.strictObject({
  code: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(4096),
});
export type ExecutionRunAttention = z.infer<typeof executionRunAttentionSchema>;

export const executionRunCountsSchema = z.strictObject({
  waiting: nonNegativeIntegerSchema,
  launchPending: nonNegativeIntegerSchema,
  active: nonNegativeIntegerSchema,
  completed: nonNegativeIntegerSchema,
  attentionRequired: nonNegativeIntegerSchema,
  notStarted: nonNegativeIntegerSchema,
});
export type ExecutionRunCounts = z.infer<typeof executionRunCountsSchema>;

const uniqueStrings = (
  values: readonly string[],
  context: z.RefinementCtx,
  path: string,
) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: 'custom',
      path: [path],
      message: `${path} must be unique`,
    });
  }
};

export const executionRunItemSchema = z
  .strictObject({
    id: executionRunItemIdSchema,
    runId: executionRunIdSchema,
    projectId: projectIdSchema,
    taskId: taskIdSchema,
    ordinal: nonNegativeIntegerSchema,
    revision: positiveIntegerSchema,
    lifecycle: executionRunItemLifecycleSchema,
    taskContractRevision: positiveIntegerSchema,
    taskCurrentRevision: positiveIntegerSchema,
    requirementRevisions: z
      .array(
        z.strictObject({
          recordId: ledgerRecordIdSchema,
          recordRevision: positiveIntegerSchema,
        }),
      )
      .max(300)
      .readonly(),
    prerequisiteTaskIds: z.array(taskIdSchema).max(200).readonly(),
    profileSnapshot: resolvedWorkerProfileSnapshotSchema,
    launchIdempotencyKey: z.string().trim().min(1).max(256),
    developerAttemptId: developerAttemptIdSchema.nullable(),
    attention: executionRunAttentionSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.taskCurrentRevision < value.taskContractRevision) {
      context.addIssue({
        code: 'custom',
        path: ['taskCurrentRevision'],
        message: 'Current task revision cannot precede its contract revision',
      });
    }
    uniqueStrings(value.prerequisiteTaskIds, context, 'prerequisiteTaskIds');
    uniqueStrings(
      value.requirementRevisions.map(
        ({ recordId, recordRevision }) => `${recordId}:${recordRevision}`,
      ),
      context,
      'requirementRevisions',
    );
    if (value.prerequisiteTaskIds.includes(value.taskId)) {
      context.addIssue({
        code: 'custom',
        path: ['prerequisiteTaskIds'],
        message: 'A run item cannot depend on itself',
      });
    }
    if (
      value.profileSnapshot.projectId !== null &&
      value.profileSnapshot.projectId !== value.projectId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profileSnapshot', 'projectId'],
        message: 'Run item profile must match its project',
      });
    }
    const terminal = [
      'completed',
      'attention_required',
      'not_started',
    ].includes(value.lifecycle);
    if (terminal !== (value.endedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'Run item terminal lifecycle and end time must agree',
      });
    }
    if (
      (value.lifecycle === 'attention_required') !==
      (value.attention !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['attention'],
        message: 'Only attention-required items carry attention',
      });
    }
    if (value.lifecycle === 'active' && value.developerAttemptId === null) {
      context.addIssue({
        code: 'custom',
        path: ['developerAttemptId'],
        message: 'Active run items require a Developer attempt',
      });
    }
    if (
      (value.lifecycle === 'waiting' || value.lifecycle === 'launch_pending') &&
      value.developerAttemptId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['developerAttemptId'],
        message: 'Unlaunched run items cannot carry a Developer attempt',
      });
    }
  });
export type ExecutionRunItem = z.infer<typeof executionRunItemSchema>;

export const executionRunSchema = z
  .strictObject({
    id: executionRunIdSchema,
    projectId: projectIdSchema,
    revision: positiveIntegerSchema,
    lifecycle: executionRunLifecycleSchema,
    completionReason: executionRunCompletionReasonSchema.nullable(),
    deliveryPlanId: deliveryPlanIdSchema,
    deliveryPlanRevision: positiveIntegerSchema,
    intentRevision: positiveIntegerSchema,
    ledgerRevision: positiveIntegerSchema,
    repositoryIdentity: z.string().trim().min(1).max(4096),
    baseCommit: gitCommitSchema,
    concurrencyLimit: positiveIntegerSchema.max(4),
    subscriptionCapacityConfirmed: z.literal(true),
    attention: executionRunAttentionSchema.nullable(),
    itemIds: z.array(executionRunItemIdSchema).min(1).max(300).readonly(),
    counts: executionRunCountsSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    uniqueStrings(value.itemIds, context, 'itemIds');
    const completed = value.lifecycle === 'completed';
    if (
      completed !== (value.completionReason !== null && value.endedAt !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['completionReason'],
        message: 'Completed run metadata must agree with lifecycle',
      });
    }
    if (
      !completed &&
      (value.completionReason !== null || value.endedAt !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'A nonterminal run cannot carry completion metadata',
      });
    }
  });
export type ExecutionRun = z.infer<typeof executionRunSchema>;

const countItems = (
  items: readonly ExecutionRunItem[],
): ExecutionRunCounts => ({
  waiting: items.filter(({ lifecycle }) => lifecycle === 'waiting').length,
  launchPending: items.filter(({ lifecycle }) => lifecycle === 'launch_pending')
    .length,
  active: items.filter(({ lifecycle }) => lifecycle === 'active').length,
  completed: items.filter(({ lifecycle }) => lifecycle === 'completed').length,
  attentionRequired: items.filter(
    ({ lifecycle }) => lifecycle === 'attention_required',
  ).length,
  notStarted: items.filter(({ lifecycle }) => lifecycle === 'not_started')
    .length,
});

export const executionRunViewSchema = z
  .strictObject({
    run: executionRunSchema,
    items: z.array(executionRunItemSchema).min(1).max(300).readonly(),
  })
  .superRefine((value, context) => {
    const itemIds = value.items.map(({ id }) => id);
    if (
      itemIds.length !== value.run.itemIds.length ||
      itemIds.some((id, index) => id !== value.run.itemIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Run item order must match its item IDs',
      });
    }
    uniqueStrings(itemIds, context, 'items');
    uniqueStrings(
      value.items.map(({ taskId }) => taskId),
      context,
      'taskIds',
    );
    value.items.forEach((item, index) => {
      if (
        item.runId !== value.run.id ||
        item.projectId !== value.run.projectId ||
        item.ordinal !== index
      ) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'Run item identity, project, and ordinal must match its run',
        });
      }
    });
    const actualCounts = countItems(value.items);
    if (
      Object.entries(actualCounts).some(
        ([name, count]) =>
          value.run.counts[name as keyof ExecutionRunCounts] !== count,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['run', 'counts'],
        message: 'Run counts must match its items',
      });
    }
    if (
      actualCounts.launchPending + actualCounts.active >
      value.run.concurrencyLimit
    ) {
      context.addIssue({
        code: 'custom',
        path: ['run', 'concurrencyLimit'],
        message: 'Occupied run capacity cannot exceed its concurrency limit',
      });
    }
    if (
      value.run.lifecycle === 'completed' &&
      (actualCounts.launchPending > 0 || actualCounts.active > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['run', 'lifecycle'],
        message: 'A completed run cannot contain active work',
      });
    }
    if (
      value.run.completionReason === 'finished' &&
      (actualCounts.waiting > 0 || actualCounts.notStarted > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['run', 'completionReason'],
        message: 'A finished run cannot contain waiting or not-started work',
      });
    }
  });
export type ExecutionRunView = z.infer<typeof executionRunViewSchema>;

export const executionRunItemSummarySchema = z.strictObject({
  runId: executionRunIdSchema,
  itemId: executionRunItemIdSchema,
  lifecycle: executionRunItemLifecycleSchema,
  developerAttemptId: developerAttemptIdSchema.nullable(),
  attention: executionRunAttentionSchema.nullable(),
});
export type ExecutionRunItemSummary = z.infer<
  typeof executionRunItemSummarySchema
>;
