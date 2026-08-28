import { z } from 'zod';

import { v2CommandTypeSchema } from './commands';
import { v2ErrorCodeSchema, workerExecutionSchema } from './executions';
import { projectEventCursorsSchema } from './events';
import {
  projectIdSchema,
  workerExecutionIdSchema,
  workerProfileIdSchema,
} from './ids';
import { projectSchema } from './projects';
import {
  profileNameSchema,
  resolvedWorkerProfileSnapshotSchema,
  workerProfileRevisionSchema,
} from './profiles';

export const V2_PROTOCOL_VERSION = 'mesh.v2/1' as const;

export const v2ProtocolVersionSchema = z.literal(V2_PROTOCOL_VERSION);
export type V2ProtocolVersion = z.infer<typeof v2ProtocolVersionSchema>;

export const v2HealthSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok') }),
  z.strictObject({
    status: z.literal('audit_barrier_tripped'),
    error: z.strictObject({
      code: z.literal('audit_barrier_tripped'),
      message: z.string().trim().min(1).max(4096),
    }),
  }),
]);
export type V2Health = z.infer<typeof v2HealthSchema>;

export const workerProfileSummarySchema = z.strictObject({
  profileId: workerProfileIdSchema,
  projectId: projectIdSchema.nullable(),
  scope: z.enum(['global', 'project']),
  name: profileNameSchema,
  displayName: z.string().trim().min(1).max(256),
  approvedRevision: z.number().int().nonnegative(),
});
export type WorkerProfileSummary = z.infer<typeof workerProfileSummarySchema>;

export const v2SystemSnapshotSchema = z.strictObject({
  protocolVersion: v2ProtocolVersionSchema,
  health: v2HealthSchema,
  projects: z.array(projectSchema).readonly(),
  globalProfiles: z.array(workerProfileSummarySchema).readonly(),
});
export type V2SystemSnapshot = z.infer<typeof v2SystemSnapshotSchema>;

export const v2AttentionItemSchema = z.strictObject({
  executionId: workerExecutionIdSchema,
  code: v2ErrorCodeSchema,
  message: z.string().trim().min(1).max(4096),
});
export type V2AttentionItem = z.infer<typeof v2AttentionItemSchema>;

export const v2ProjectSnapshotSchema = z.strictObject({
  protocolVersion: v2ProtocolVersionSchema,
  project: projectSchema,
  profiles: z.array(resolvedWorkerProfileSnapshotSchema).readonly(),
  executions: z.array(workerExecutionSchema).readonly(),
  attentionItems: z.array(v2AttentionItemSchema).readonly(),
  cursors: projectEventCursorsSchema,
});
export type V2ProjectSnapshot = z.infer<typeof v2ProjectSnapshotSchema>;

const commandFailureSchema = z.strictObject({
  ok: z.literal(false),
  commandType: v2CommandTypeSchema,
  error: z.strictObject({
    code: v2ErrorCodeSchema,
    message: z.string().trim().min(1).max(4096),
  }),
});

export const v2CommandResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    commandType: z.literal('project.register'),
    project: projectSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    commandType: z.literal('worker_profile.approve_revision'),
    profileRevision: workerProfileRevisionSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    commandType: z.literal('worker_execution.start'),
    execution: workerExecutionSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    commandType: z.literal('worker_execution.interrupt'),
    execution: workerExecutionSchema,
  }),
  commandFailureSchema,
]);
export type V2CommandResult = z.infer<typeof v2CommandResultSchema>;
