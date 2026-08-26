import { z } from 'zod';

import {
  idSchema,
  isoTimestampSchema,
  permissionModeSchema,
  taskActorSchema,
} from './domain.js';

export const developerCycleModeSchema = z.enum(['new', 'resume']);
export const developerCycleDispositionSchema = z.enum([
  'submitted_for_review',
  'blocked',
]);

export const acceptanceCriterionResultSchema = z.object({
  criterionId: idSchema,
  status: z.enum(['met', 'not_met']),
  evidence: z.string().trim().min(1),
});

const taskSnapshotSchema = z
  .object({
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).default(''),
    description: z.string(),
    acceptanceCriteria: z.array(
      z.object({ id: idSchema, text: z.string().trim().min(1) }),
    ),
  })
  .superRefine(({ acceptanceCriteria }, context) => {
    const criterionIds = new Set<string>();

    for (const [index, criterion] of acceptanceCriteria.entries()) {
      if (criterionIds.has(criterion.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Task snapshot criterion IDs must be unique.',
          path: ['acceptanceCriteria', index, 'id'],
        });
      }
      criterionIds.add(criterion.id);
    }
  });

export const developerExecutionCycleSchema = z
  .object({
    id: idSchema,
    attemptId: idSchema,
    ordinal: z.number().int().positive(),
    mode: developerCycleModeSchema,
    authorizedBy: taskActorSchema,
    authorizationCommandId: idSchema,
    policyVersion: z.string().trim().min(1),
    projectInstructions: z.object({
      content: z.string(),
      revision: z.number().int().positive(),
    }),
    taskSnapshot: taskSnapshotSchema,
    workspaceId: idSchema,
    permissionMode: permissionModeSchema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema.nullable(),
    terminalDisposition: developerCycleDispositionSchema.nullable(),
    completionReportId: idSchema.nullable(),
    blockerReportId: idSchema.nullable(),
    terminalCommandId: idSchema.nullable(),
    terminalEventId: idSchema.nullable(),
  })
  .superRefine(({ endedAt, terminalDisposition }, context) => {
    if (terminalDisposition !== null && endedAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal Developer cycle dispositions require an end time.',
        path: ['terminalDisposition'],
      });
    }
  });

const verificationResultSchema = z.object({
  command: z.string().trim().min(1),
  outcome: z.enum(['passed', 'failed', 'not_run']),
  output: z.string(),
});

export const developerCompletionReportSchema = z.object({
  id: idSchema,
  cycleId: idSchema,
  summary: z.string().trim().min(1),
  criterionResults: z.array(acceptanceCriterionResultSchema).min(1),
  verification: z.array(verificationResultSchema),
  limitations: z.string(),
  workspaceState: z.object({
    summary: z.string().trim().min(1),
    hasUncommittedChanges: z.boolean(),
    commitsCreated: z.boolean(),
  }),
  reviewerNotes: z.string().nullable(),
  createdAt: isoTimestampSchema,
});

export const developerBlockerReportSchema = z.object({
  id: idSchema,
  cycleId: idSchema,
  reason: z.string().trim().min(1),
  evidence: z.string().trim().min(1),
  attemptedWork: z.string().trim().min(1),
  suggestedHumanAction: z.string().trim().min(1),
  preserveWorkspace: z.boolean(),
  createdAt: isoTimestampSchema,
});

export const developerCompletionReportInputSchema =
  developerCompletionReportSchema
    .omit({ id: true, cycleId: true, createdAt: true })
    .extend({
      idempotencyKey: idSchema,
    });

export const developerBlockerReportInputSchema = developerBlockerReportSchema
  .omit({ id: true, cycleId: true, createdAt: true })
  .extend({ idempotencyKey: idSchema });

const humanTaskActorSchema = taskActorSchema.extend({
  type: z.literal('human'),
});

export const developerReviewFeedbackSchema = z.object({
  id: idSchema,
  cycleId: idSchema,
  taskId: idSchema,
  kind: z.enum(['rejection', 'unblock']),
  feedback: z.string().trim().min(1),
  actor: humanTaskActorSchema,
  commandId: idSchema,
  createdAt: isoTimestampSchema,
});

export type DeveloperCycleMode = z.infer<typeof developerCycleModeSchema>;
export type DeveloperCycleDisposition = z.infer<
  typeof developerCycleDispositionSchema
>;
export type AcceptanceCriterionResult = z.infer<
  typeof acceptanceCriterionResultSchema
>;
export type DeveloperExecutionCycle = z.infer<
  typeof developerExecutionCycleSchema
>;
export type DeveloperCompletionReport = z.infer<
  typeof developerCompletionReportSchema
>;
export type DeveloperBlockerReport = z.infer<
  typeof developerBlockerReportSchema
>;
export type DeveloperReviewFeedback = z.infer<
  typeof developerReviewFeedbackSchema
>;
export type DeveloperCompletionReportInput = z.infer<
  typeof developerCompletionReportInputSchema
>;
export type DeveloperBlockerReportInput = z.infer<
  typeof developerBlockerReportInputSchema
>;
