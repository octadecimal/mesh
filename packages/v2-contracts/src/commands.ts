import { z } from 'zod';

import {
  nonNegativeIntegerSchema,
  projectIdSchema,
  workerExecutionIdSchema,
  workerProfileIdSchema,
} from './ids';
import { foundationCheckAssignmentSchema } from './executions';

export const v2CommandTypeSchema = z.enum([
  'project.register',
  'worker_profile.approve_revision',
  'worker_execution.start',
  'worker_execution.interrupt',
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
    assignment: foundationCheckAssignmentSchema,
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

export const v2CommandSchema = z.union([
  projectRegisterCommandSchema,
  profileApprovalCommandSchema,
  startExecutionCommandSchema,
  interruptExecutionCommandSchema,
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

export const v2CommandEnvelopeSchema = z.union([
  projectRegisterEnvelopeSchema,
  profileApprovalEnvelopeSchema,
  startExecutionEnvelopeSchema,
  interruptExecutionEnvelopeSchema,
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
