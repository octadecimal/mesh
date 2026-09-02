import { z } from 'zod';

import {
  deliveryPlanIdSchema,
  deliveryPlanProposalIdSchema,
  developerAttemptIdSchema,
  ledgerIdSchema,
  nonNegativeIntegerSchema,
  planningCycleIdSchema,
  planningProposalIdSchema,
  positiveIntegerSchema,
  projectIdSchema,
  projectIntentIdSchema,
  taskIdSchema,
  workerExecutionIdSchema,
  workerProfileIdSchema,
} from './ids';
import { workerAssignmentSchema } from './executions';
import { boardFilterSelectionSchema } from './board';
import { planTextSchema } from './delivery-plan';

export const v2CommandTypeSchema = z.enum([
  'project.register',
  'worker_profile.approve_revision',
  'worker_execution.start',
  'worker_execution.interrupt',
  'planning_cycle.submit_turn',
  'planning_proposal.approve',
  'planning_proposal.reject',
  'planning_cycle.abandon',
  'planning_cycle.submit_plan_turn',
  'plan_proposal.approve',
  'plan_proposal.reject',
  'board_filter.set',
  'developer_attempt.start',
  'developer_attempt.interrupt',
  'developer_attempt.replace_execution',
]);
export type V2CommandType = z.infer<typeof v2CommandTypeSchema>;

export const projectRegisterCommandSchema = z.strictObject({
  type: z.literal('project.register'),
  repositoryPath: z.string().trim().min(1).max(4096),
  displayName: z.string().trim().min(1).max(256).optional(),
});
export type ProjectRegisterCommand = z.infer<
  typeof projectRegisterCommandSchema
>;

export const profileApprovalCommandSchema = z
  .strictObject({
    type: z.literal('worker_profile.approve_revision'),
    scope: z.enum(['global', 'project']),
    projectId: projectIdSchema.optional(),
    sourceYaml: z
      .string()
      .min(1)
      .max(64 * 1024),
    expectedLatestRevision: nonNegativeIntegerSchema,
  })
  .superRefine((value, context) => {
    if (value.scope === 'global' && value.projectId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'Global profile approvals must not include a project ID',
      });
    }
    if (value.scope === 'project' && value.projectId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'Project profile approvals require a project ID',
      });
    }
  });
export type ProfileApprovalCommand = z.infer<
  typeof profileApprovalCommandSchema
>;

export const startExecutionCommandSchema = z
  .strictObject({
    type: z.literal('worker_execution.start'),
    projectId: projectIdSchema,
    profileId: workerProfileIdSchema,
    profileRevision: nonNegativeIntegerSchema,
    assignment: workerAssignmentSchema,
  })
  .superRefine((value, context) => {
    if (value.projectId !== value.assignment.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['assignment', 'projectId'],
        message: 'Assignment project must match command project',
      });
    }
  });
export type StartExecutionCommand = z.infer<typeof startExecutionCommandSchema>;

export const interruptExecutionCommandSchema = z.strictObject({
  type: z.literal('worker_execution.interrupt'),
  projectId: projectIdSchema,
  executionId: workerExecutionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
});
export type InterruptExecutionCommand = z.infer<
  typeof interruptExecutionCommandSchema
>;

const requireProfileOnlyForNewCycle = (
  value: {
    planningCycleId?: string;
    expectedCycleRevision: number | null;
    profileId?: string;
    profileRevision?: number;
  },
  context: z.RefinementCtx,
) => {
  const newCycle = value.planningCycleId === undefined;
  if (
    newCycle &&
    (value.expectedCycleRevision !== null ||
      value.profileId === undefined ||
      value.profileRevision === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['planningCycleId'],
      message:
        'New cycles require a profile and null revision; existing cycles require only an expected revision',
    });
  }
  if (
    !newCycle &&
    (value.expectedCycleRevision === null ||
      value.profileId !== undefined ||
      value.profileRevision !== undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['profileId'],
      message: 'Existing cycles reuse their frozen profile',
    });
  }
};

export const submitPlanningTurnCommandSchema = z
  .strictObject({
    type: z.literal('planning_cycle.submit_turn'),
    projectId: projectIdSchema,
    planningCycleId: planningCycleIdSchema.optional(),
    expectedCycleRevision: nonNegativeIntegerSchema.nullable(),
    profileId: workerProfileIdSchema.optional(),
    profileRevision: positiveIntegerSchema.optional(),
    message: z.string().trim().min(1).max(16_384),
  })
  .superRefine(requireProfileOnlyForNewCycle);
export type SubmitPlanningTurnCommand = z.infer<
  typeof submitPlanningTurnCommandSchema
>;

export const approvePlanningProposalCommandSchema = z.strictObject({
  type: z.literal('planning_proposal.approve'),
  projectId: projectIdSchema,
  planningCycleId: planningCycleIdSchema,
  proposalId: planningProposalIdSchema,
  expectedCycleRevision: nonNegativeIntegerSchema,
  expectedProposalRevision: positiveIntegerSchema,
  expectedProjectIntentRevision: positiveIntegerSchema.nullable(),
  expectedLedgerRevision: positiveIntegerSchema.nullable(),
});
export type ApprovePlanningProposalCommand = z.infer<
  typeof approvePlanningProposalCommandSchema
>;

export const rejectPlanningProposalCommandSchema = z.strictObject({
  type: z.literal('planning_proposal.reject'),
  projectId: projectIdSchema,
  planningCycleId: planningCycleIdSchema,
  proposalId: planningProposalIdSchema,
  expectedCycleRevision: nonNegativeIntegerSchema,
  expectedProposalRevision: positiveIntegerSchema,
  feedback: z.string().trim().min(1).max(4096),
});
export type RejectPlanningProposalCommand = z.infer<
  typeof rejectPlanningProposalCommandSchema
>;

export const abandonPlanningCycleCommandSchema = z.strictObject({
  type: z.literal('planning_cycle.abandon'),
  projectId: projectIdSchema,
  planningCycleId: planningCycleIdSchema,
  expectedCycleRevision: nonNegativeIntegerSchema,
});
export type AbandonPlanningCycleCommand = z.infer<
  typeof abandonPlanningCycleCommandSchema
>;

const expectedDeliveryPlanSchema = z.union([
  z.strictObject({ id: deliveryPlanIdSchema, revision: positiveIntegerSchema }),
  z.strictObject({ id: z.null(), revision: z.null() }),
]);

const startPlanCycleCommandSchema = z.strictObject({
  type: z.literal('planning_cycle.submit_plan_turn'),
  projectId: projectIdSchema,
  expectedCycleRevision: z.null(),
  profileId: workerProfileIdSchema,
  profileRevision: positiveIntegerSchema,
  expectedProjectIntentId: projectIntentIdSchema,
  expectedProjectIntentRevision: positiveIntegerSchema,
  expectedLedgerId: ledgerIdSchema,
  expectedLedgerRevision: positiveIntegerSchema,
  expectedDeliveryPlan: expectedDeliveryPlanSchema,
  message: z.string().trim().min(1).max(16_384),
});

const continuePlanCycleCommandSchema = z.strictObject({
  type: z.literal('planning_cycle.submit_plan_turn'),
  projectId: projectIdSchema,
  planningCycleId: planningCycleIdSchema,
  expectedCycleRevision: nonNegativeIntegerSchema,
  message: z.string().trim().min(1).max(16_384),
});

export const submitPlanTurnCommandSchema = z.union([
  startPlanCycleCommandSchema,
  continuePlanCycleCommandSchema,
]);
export type SubmitPlanTurnCommand = z.infer<typeof submitPlanTurnCommandSchema>;

export const approvePlanProposalCommandSchema = z.strictObject({
  type: z.literal('plan_proposal.approve'),
  projectId: projectIdSchema,
  planningCycleId: planningCycleIdSchema,
  expectedCycleRevision: nonNegativeIntegerSchema,
  proposalId: deliveryPlanProposalIdSchema,
  expectedProposalRevision: positiveIntegerSchema,
  expectedProjectIntentId: projectIntentIdSchema,
  expectedProjectIntentRevision: positiveIntegerSchema,
  expectedLedgerId: ledgerIdSchema,
  expectedLedgerRevision: positiveIntegerSchema,
  expectedDeliveryPlan: expectedDeliveryPlanSchema,
});
export type ApprovePlanProposalCommand = z.infer<
  typeof approvePlanProposalCommandSchema
>;

export const rejectPlanProposalCommandSchema = z.strictObject({
  type: z.literal('plan_proposal.reject'),
  projectId: projectIdSchema,
  planningCycleId: planningCycleIdSchema,
  expectedCycleRevision: nonNegativeIntegerSchema,
  proposalId: deliveryPlanProposalIdSchema,
  expectedProposalRevision: positiveIntegerSchema,
  feedback: planTextSchema,
});
export type RejectPlanProposalCommand = z.infer<
  typeof rejectPlanProposalCommandSchema
>;

export const setBoardFilterCommandSchema = z.strictObject({
  type: z.literal('board_filter.set'),
  projectId: projectIdSchema,
  expectedFilterRevision: positiveIntegerSchema,
  filter: boardFilterSelectionSchema,
});
export type SetBoardFilterCommand = z.infer<typeof setBoardFilterCommandSchema>;

export const startDeveloperAttemptCommandSchema = z.strictObject({
  type: z.literal('developer_attempt.start'),
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  expectedTaskRevision: positiveIntegerSchema,
  expectedDeliveryPlanId: deliveryPlanIdSchema,
  expectedDeliveryPlanRevision: positiveIntegerSchema,
  profileId: workerProfileIdSchema,
  profileRevision: positiveIntegerSchema,
});
export type StartDeveloperAttemptCommand = z.infer<
  typeof startDeveloperAttemptCommandSchema
>;

const developerAttemptMutationShape = {
  projectId: projectIdSchema,
  attemptId: developerAttemptIdSchema,
  expectedAttemptRevision: nonNegativeIntegerSchema,
};

export const interruptDeveloperAttemptCommandSchema = z.strictObject({
  type: z.literal('developer_attempt.interrupt'),
  ...developerAttemptMutationShape,
});
export type InterruptDeveloperAttemptCommand = z.infer<
  typeof interruptDeveloperAttemptCommandSchema
>;

export const replaceDeveloperAttemptExecutionCommandSchema = z.strictObject({
  type: z.literal('developer_attempt.replace_execution'),
  ...developerAttemptMutationShape,
});
export type ReplaceDeveloperAttemptExecutionCommand = z.infer<
  typeof replaceDeveloperAttemptExecutionCommandSchema
>;

export const v2CommandSchema = z.union([
  projectRegisterCommandSchema,
  profileApprovalCommandSchema,
  startExecutionCommandSchema,
  interruptExecutionCommandSchema,
  submitPlanningTurnCommandSchema,
  approvePlanningProposalCommandSchema,
  rejectPlanningProposalCommandSchema,
  abandonPlanningCycleCommandSchema,
  submitPlanTurnCommandSchema,
  approvePlanProposalCommandSchema,
  rejectPlanProposalCommandSchema,
  setBoardFilterCommandSchema,
  startDeveloperAttemptCommandSchema,
  interruptDeveloperAttemptCommandSchema,
  replaceDeveloperAttemptExecutionCommandSchema,
]);
export type V2Command = z.infer<typeof v2CommandSchema>;

const v2CommandEnvelopeBase = {
  idempotencyKey: z.string().trim().min(1).max(256),
  actor: z.strictObject({ kind: z.literal('human') }),
};

export const projectRegisterEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: projectRegisterCommandSchema,
});
export const profileApprovalEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: profileApprovalCommandSchema,
});
export const startExecutionEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: startExecutionCommandSchema,
});
export const interruptExecutionEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: interruptExecutionCommandSchema,
});
export const startDeveloperAttemptEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: startDeveloperAttemptCommandSchema,
});
export const interruptDeveloperAttemptEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: interruptDeveloperAttemptCommandSchema,
});
export const replaceDeveloperAttemptExecutionEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: replaceDeveloperAttemptExecutionCommandSchema,
});
export const submitPlanningTurnEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: submitPlanningTurnCommandSchema,
});
export const approvePlanningProposalEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: approvePlanningProposalCommandSchema,
});
export const rejectPlanningProposalEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: rejectPlanningProposalCommandSchema,
});
export const abandonPlanningCycleEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: abandonPlanningCycleCommandSchema,
});
export const submitPlanTurnEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: submitPlanTurnCommandSchema,
});
export const approvePlanProposalEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: approvePlanProposalCommandSchema,
});
export const rejectPlanProposalEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: rejectPlanProposalCommandSchema,
});
export const setBoardFilterEnvelopeSchema = z.strictObject({
  ...v2CommandEnvelopeBase,
  command: setBoardFilterCommandSchema,
});

export const v2CommandEnvelopeSchema = z.union([
  projectRegisterEnvelopeSchema,
  profileApprovalEnvelopeSchema,
  startExecutionEnvelopeSchema,
  interruptExecutionEnvelopeSchema,
  startDeveloperAttemptEnvelopeSchema,
  interruptDeveloperAttemptEnvelopeSchema,
  replaceDeveloperAttemptExecutionEnvelopeSchema,
  submitPlanningTurnEnvelopeSchema,
  approvePlanningProposalEnvelopeSchema,
  rejectPlanningProposalEnvelopeSchema,
  abandonPlanningCycleEnvelopeSchema,
  submitPlanTurnEnvelopeSchema,
  approvePlanProposalEnvelopeSchema,
  rejectPlanProposalEnvelopeSchema,
  setBoardFilterEnvelopeSchema,
]);
export type V2CommandEnvelope = z.infer<typeof v2CommandEnvelopeSchema>;

export type ProjectRegisterEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'project.register' }>;
};
export type ProfileApprovalEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'worker_profile.approve_revision' }>;
};
export type StartExecutionEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'worker_execution.start' }>;
};
export type InterruptExecutionEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'worker_execution.interrupt' }>;
};
export type SubmitPlanningTurnEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_cycle.submit_turn' }>;
};
export type ApprovePlanningProposalEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_proposal.approve' }>;
};
export type RejectPlanningProposalEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_proposal.reject' }>;
};
export type AbandonPlanningCycleEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_cycle.abandon' }>;
};
export type SubmitPlanTurnEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'planning_cycle.submit_plan_turn' }>;
};
export type ApprovePlanProposalEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'plan_proposal.approve' }>;
};
export type RejectPlanProposalEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'plan_proposal.reject' }>;
};
export type SetBoardFilterEnvelope = V2CommandEnvelope & {
  command: Extract<V2Command, { type: 'board_filter.set' }>;
};
