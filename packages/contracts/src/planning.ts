import { z } from 'zod';

import {
  blockedConditionSchema,
  idSchema,
  isoTimestampSchema,
  taskActorSchema,
  taskLifecycleStateSchema,
  taskPrioritySchema,
} from './domain.js';
import { taskDependencySchema } from './task-dependencies.js';

export const projectPlanStatusSchema = z.enum([
  'planning',
  'awaiting_review',
  'revising',
  'attention_required',
  'approved',
  'rejected',
  'cancelled',
]);

export const proposalPrerequisiteSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('proposal_task'), taskKey: idSchema }),
  z.object({ type: z.literal('existing_task'), taskId: idSchema }),
]);

export const projectPlanProposalTaskSchema = z.object({
  key: idSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  priority: taskPrioritySchema,
  labels: z.array(z.string().trim().min(1)),
  rationale: z.string().trim().min(1),
  goalMapping: z.string().trim().min(1),
});

export const projectPlanProposalDependencySchema = z.object({
  dependentTaskKey: idSchema,
  prerequisite: proposalPrerequisiteSchema,
});

export const projectPlanProposalInputSchema = z.object({
  tasks: z.array(projectPlanProposalTaskSchema).max(50),
  dependencies: z.array(projectPlanProposalDependencySchema).max(200),
  assumptions: z.array(z.string().trim().min(1)),
  risks: z.array(z.string().trim().min(1)),
  exclusions: z.array(z.string().trim().min(1)),
});

export const projectPlanProposalSchema = projectPlanProposalInputSchema.extend({
  id: idSchema,
  planId: idSchema,
  baseId: idSchema,
  ordinal: z.number().int().positive(),
  planRevision: z.number().int().positive(),
  capabilityGeneration: z.number().int().positive(),
  sessionId: idSchema,
  submittedAt: isoTimestampSchema,
});

export const projectPlanBaseTaskSchema = z.object({
  id: idSchema,
  revision: z.number().int().positive(),
  lifecycleState: taskLifecycleStateSchema,
  blocked: blockedConditionSchema.nullable(),
});

export const projectPlanBaseSchema = z.object({
  id: idSchema,
  planId: idSchema,
  ordinal: z.number().int().positive(),
  repositoryIdentity: z.string().trim().min(1),
  tasks: z.array(projectPlanBaseTaskSchema),
  dependencies: z.array(taskDependencySchema),
  projectArchivedAt: isoTimestampSchema.nullable(),
  projectRevision: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
  createdAt: isoTimestampSchema,
});

export const projectPlanFeedbackSchema = z.object({
  id: idSchema,
  planId: idSchema,
  proposalId: idSchema.nullable(),
  content: z.string().trim().min(1),
  actor: taskActorSchema.extend({ type: z.literal('human') }),
  createdAt: isoTimestampSchema,
});

const staleTaskChangeSchema = z
  .object({
    addedTaskIds: z.array(idSchema).max(50),
    addedTaskTotal: z.number().int().nonnegative(),
    addedTaskIdsTruncated: z.boolean(),
    removedTaskIds: z.array(idSchema).max(50),
    removedTaskTotal: z.number().int().nonnegative(),
    removedTaskIdsTruncated: z.boolean(),
    changedTaskIds: z.array(idSchema).max(50),
    changedTaskTotal: z.number().int().nonnegative(),
    changedTaskIdsTruncated: z.boolean(),
  })
  .superRefine((evidence, context) => {
    for (const key of ['added', 'removed', 'changed'] as const) {
      const ids = evidence[`${key}TaskIds`];
      const total = evidence[`${key}TaskTotal`];
      const truncated = evidence[`${key}TaskIdsTruncated`];
      if (ids.length > total || (!truncated && ids.length !== total)) {
        context.addIssue({
          code: 'custom',
          message:
            'Stale task evidence must agree with its total and truncation.',
          path: [`${key}TaskIds`],
        });
      }
    }
  });

export const projectPlanAttentionSchema = z.union([
  staleTaskChangeSchema.extend({
    type: z.literal('stale_board'),
    dependenciesChanged: z.boolean(),
    policyChanged: z.boolean(),
  }),
  z.object({
    type: z.enum(['runtime_failure', 'session_unavailable', 'repair_required']),
    message: z.string().trim().min(1),
  }),
]);

export const projectPlanSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  goal: z.string().trim().min(1),
  constraints: z.array(z.string().trim().min(1)),
  nonGoals: z.array(z.string().trim().min(1)),
  policyVersion: z.string().trim().min(1),
  status: projectPlanStatusSchema,
  revision: z.number().int().positive(),
  currentBaseId: idSchema,
  currentSessionId: idSchema.nullable(),
  latestProposalOrdinal: z.number().int().nonnegative(),
  feedback: z.array(projectPlanFeedbackSchema),
  attention: projectPlanAttentionSchema.nullable(),
  createdBy: taskActorSchema.extend({ type: z.literal('human') }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  terminalAt: isoTimestampSchema.nullable(),
  terminalBy: taskActorSchema.extend({ type: z.literal('human') }).nullable(),
  terminalReason: z.string().trim().min(1).nullable(),
});

export const projectPlanSummarySchema = z.object({
  id: idSchema,
  projectId: idSchema,
  goal: z.string().trim().min(1),
  status: z.enum(['approved', 'rejected', 'cancelled']),
  revision: z.number().int().positive(),
  latestProposalOrdinal: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  terminalAt: isoTimestampSchema,
});

export const projectPlanHistoryPageSchema = z.object({
  plans: z.array(projectPlanSummarySchema),
  nextAfter: idSchema.optional(),
});

export const projectPlanDetailsSchema = z.object({
  plan: projectPlanSchema,
  bases: z.array(projectPlanBaseSchema),
  proposals: z.array(projectPlanProposalSchema),
  feedback: z.array(projectPlanFeedbackSchema),
});

export type ProjectPlanStatus = z.infer<typeof projectPlanStatusSchema>;
export type ProposalPrerequisite = z.infer<typeof proposalPrerequisiteSchema>;
export type ProjectPlanProposalTask = z.infer<
  typeof projectPlanProposalTaskSchema
>;
export type ProjectPlanProposalDependency = z.infer<
  typeof projectPlanProposalDependencySchema
>;
export type ProjectPlanProposalInput = z.infer<
  typeof projectPlanProposalInputSchema
>;
export type ProjectPlanProposal = z.infer<typeof projectPlanProposalSchema>;
export type ProjectPlanBase = z.infer<typeof projectPlanBaseSchema>;
export type ProjectPlanFeedback = z.infer<typeof projectPlanFeedbackSchema>;
export type ProjectPlanAttention = z.infer<typeof projectPlanAttentionSchema>;
export type ProjectPlan = z.infer<typeof projectPlanSchema>;
export type ProjectPlanSummary = z.infer<typeof projectPlanSummarySchema>;
export type ProjectPlanHistoryPage = z.infer<
  typeof projectPlanHistoryPageSchema
>;
export type ProjectPlanDetails = z.infer<typeof projectPlanDetailsSchema>;
