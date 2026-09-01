import { z } from 'zod';

import {
  deliveryPlanIdSchema,
  developerAttemptIdSchema,
  developerReportIdSchema,
  isoTimestampSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  projectIdSchema,
  taskIdSchema,
  workerExecutionIdSchema,
  workerProfileIdSchema,
} from './ids';
import { planRequirementRefSchema, planTextSchema } from './delivery-plan';
import { gitCommitSchema } from './projects';

export const DEVELOPER_REPORT_SCHEMA = 'mesh.dev/developer-report/v1' as const;

const evidenceItemSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4096),
});

const developerWorkspaceObservationSchema = z.strictObject({
  headCommit: gitCommitSchema,
  dirty: z.boolean(),
});

export const developerTaskAssignmentSchema = z
  .strictObject({
    kind: z.literal('developer_task'),
    projectId: projectIdSchema,
    attemptId: developerAttemptIdSchema,
    taskId: taskIdSchema,
    taskContractRevision: positiveIntegerSchema,
    taskCurrentRevision: positiveIntegerSchema,
    deliveryPlanId: deliveryPlanIdSchema,
    deliveryPlanRevision: positiveIntegerSchema,
    requirementRevisions: z.array(planRequirementRefSchema).max(100).readonly(),
    baseCommit: gitCommitSchema,
    workspacePath: z.string().trim().min(1).max(4096),
    title: planTextSchema,
    outcome: planTextSchema,
    acceptanceCriteria: z.array(planTextSchema).min(1).max(100).readonly(),
    verification: z.array(planTextSchema).max(100).readonly(),
    expectedArtifacts: z.array(planTextSchema).max(100).readonly(),
    outputSchema: z.literal(DEVELOPER_REPORT_SCHEMA),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.requirementRevisions.forEach((requirement, index) => {
      if (ids.has(requirement.recordId)) {
        context.addIssue({
          code: 'custom',
          path: ['requirementRevisions', index, 'recordId'],
          message: 'Requirement IDs must be unique',
        });
      }
      ids.add(requirement.recordId);
    });
  });
export type DeveloperTaskAssignment = z.infer<
  typeof developerTaskAssignmentSchema
>;

export const developerAttemptLifecycleSchema = z.enum([
  'reserved',
  'provisioning',
  'active',
  'completed',
  'blocked',
  'interrupted',
  'attention_required',
]);
export type DeveloperAttemptLifecycle = z.infer<
  typeof developerAttemptLifecycleSchema
>;

export const managedWorkspaceLifecycleSchema = z.enum([
  'reserved',
  'creating',
  'ready',
  'attention_required',
]);
export type ManagedWorkspaceLifecycle = z.infer<
  typeof managedWorkspaceLifecycleSchema
>;

export const developerAttentionSchema = z.strictObject({
  code: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(4096),
});
export type DeveloperAttention = z.infer<typeof developerAttentionSchema>;

export const managedWorkspaceSchema = z.strictObject({
  attemptId: developerAttemptIdSchema,
  repositoryPath: z.string().trim().min(1).max(4096),
  repositoryIdentity: z.string().trim().min(1).max(4096),
  branch: z.string().trim().min(1).max(256),
  path: z.string().trim().min(1).max(4096),
  baseCommit: gitCommitSchema,
  lifecycle: managedWorkspaceLifecycleSchema,
  ownershipToken: z.string().trim().min(1).max(256),
  observedHead: gitCommitSchema.nullable(),
  observedDirty: z.boolean().nullable(),
  failure: developerAttentionSchema.nullable(),
  revision: nonNegativeIntegerSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type ManagedWorkspace = z.infer<typeof managedWorkspaceSchema>;

const requirementEvidenceSchema = z.strictObject({
  recordId: z.string().uuid(),
  recordRevision: positiveIntegerSchema,
  passed: z.literal(true),
  evidence: z.array(evidenceItemSchema).max(100).readonly(),
});
const criterionEvidenceSchema = z.strictObject({
  index: nonNegativeIntegerSchema,
  text: planTextSchema,
  passed: z.literal(true),
  evidence: z.array(evidenceItemSchema).max(100).readonly(),
});

const developerReportBase = {
  schema: z.literal(DEVELOPER_REPORT_SCHEMA),
  attemptId: developerAttemptIdSchema,
  executionId: workerExecutionIdSchema,
  taskId: taskIdSchema,
  taskContractRevision: positiveIntegerSchema,
  workspace: developerWorkspaceObservationSchema,
};

export const developerCompletionReportSchema = z
  .strictObject({
    ...developerReportBase,
    disposition: z.literal('completed'),
    requirementCoverage: z.array(requirementEvidenceSchema).max(100).readonly(),
    criterionCoverage: z.array(criterionEvidenceSchema).max(100).readonly(),
    changedArtifacts: z
      .array(z.strictObject({ path: z.string().trim().min(1).max(4096), summary: planTextSchema }))
      .max(100)
      .readonly(),
    verification: z
      .array(
        z.strictObject({
          command: z.string().trim().min(1).max(4096),
          passed: z.literal(true),
          evidence: z.array(evidenceItemSchema).max(100).readonly(),
        }),
      )
      .min(1)
      .max(100)
      .readonly(),
    unresolvedConcerns: z.array(planTextSchema).max(100).readonly(),
  })
  .superRefine((value, context) => {
    const requirementIds = new Set<string>();
    value.requirementCoverage.forEach((coverage, index) => {
      if (requirementIds.has(coverage.recordId)) {
        context.addIssue({ code: 'custom', path: ['requirementCoverage', index, 'recordId'], message: 'Requirement IDs must be unique' });
      }
      requirementIds.add(coverage.recordId);
    });
    const criterionIndexes = new Set<number>();
    value.criterionCoverage.forEach((coverage, index) => {
      if (criterionIndexes.has(coverage.index)) {
        context.addIssue({ code: 'custom', path: ['criterionCoverage', index, 'index'], message: 'Criterion indexes must be unique' });
      }
      criterionIndexes.add(coverage.index);
    });
  });
export type DeveloperCompletionReport = z.infer<
  typeof developerCompletionReportSchema
>;

export const developerBlockerReportSchema = z.strictObject({
  ...developerReportBase,
  disposition: z.literal('blocked'),
  blocker: planTextSchema,
  evidence: z.array(evidenceItemSchema).max(100).readonly(),
  suggestedNextAction: planTextSchema,
  preserveWorkspace: z.literal(true),
});
export type DeveloperBlockerReport = z.infer<typeof developerBlockerReportSchema>;

export const developerReportSchema = z.discriminatedUnion('disposition', [
  developerCompletionReportSchema,
  developerBlockerReportSchema,
]);
export type DeveloperReport = z.infer<typeof developerReportSchema>;

export const developerReportRecordSchema = z.strictObject({
  id: developerReportIdSchema,
  report: developerReportSchema,
  recordedAt: isoTimestampSchema,
});
export type DeveloperReportRecord = z.infer<typeof developerReportRecordSchema>;

export const developerAttemptSchema = z.strictObject({
  id: developerAttemptIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  ordinal: positiveIntegerSchema,
  lifecycle: developerAttemptLifecycleSchema,
  revision: nonNegativeIntegerSchema,
  deliveryPlanId: deliveryPlanIdSchema,
  deliveryPlanRevision: positiveIntegerSchema,
  intentRevision: positiveIntegerSchema,
  ledgerRevision: positiveIntegerSchema,
  taskContractRevision: positiveIntegerSchema,
  taskCurrentRevision: positiveIntegerSchema,
  requirementRevisions: z.array(planRequirementRefSchema).max(100).readonly(),
  baseCommit: gitCommitSchema,
  profileId: workerProfileIdSchema,
  profileRevision: positiveIntegerSchema,
  assignment: developerTaskAssignmentSchema,
  workspace: managedWorkspaceSchema,
  controllingExecutionId: workerExecutionIdSchema.nullable(),
  executionIds: z.array(workerExecutionIdSchema).max(100).readonly(),
  reportIds: z.array(developerReportIdSchema).max(100).readonly(),
  attention: developerAttentionSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  endedAt: isoTimestampSchema.nullable(),
});
export type DeveloperAttempt = z.infer<typeof developerAttemptSchema>;
