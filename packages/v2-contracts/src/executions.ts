import { z } from 'zod';

import type { HarnessEventEnvelope } from './events';
import {
  isoTimestampSchema,
  nonNegativeIntegerSchema,
  projectIdSchema,
  workerExecutionIdSchema,
  workerProfileIdSchema,
} from './ids';
import { projectSchema, type Project } from './projects';
import {
  logicalSkillIdSchema,
  logicalSkillRequestSchema,
  resolvedWorkerProfileSnapshotSchema,
  sha256DigestSchema,
  type LogicalSkillRequest,
  type ResolvedWorkerProfileSnapshot,
} from './profiles';

export const V2_ERROR_CODES = [
  'adapter_unavailable',
  'audit_barrier_tripped',
  'database_identity_mismatch',
  'execution_lifecycle_conflict',
  'execution_not_found',
  'execution_revision_conflict',
  'idempotency_conflict',
  'internal_error',
  'invalid_origin',
  'invalid_request',
  'project_not_found',
  'profile_not_found',
  'profile_revision_conflict',
  'profile_scope_invalid',
  'repository_head_ambiguous',
  'repository_head_failed',
  'repository_head_unborn',
  'repository_identity_conflict',
  'repository_invalid',
  'repository_path_escape',
  'required_capability_unavailable',
  'required_skill_unavailable',
  'startup_interrupted_before_start',
] as const;

export const v2ErrorCodeSchema = z.enum(V2_ERROR_CODES);
export type V2ErrorCode = z.infer<typeof v2ErrorCodeSchema>;

export const foundationCheckAssignmentSchema = z.strictObject({
  kind: z.literal('foundation-check'),
  projectId: projectIdSchema,
  title: z.string().trim().min(1).max(256),
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(32 * 1024),
  fakeScenario: z.literal('todo-foundation-v1'),
});
export type FoundationCheckAssignment = z.infer<
  typeof foundationCheckAssignmentSchema
>;

export const harnessSkillDescriptorSchema = z.strictObject({
  logicalId: logicalSkillIdSchema,
  nativeId: z.string().trim().min(1).max(256),
  version: z.string().trim().min(1).max(128).optional(),
  digest: sha256DigestSchema,
});
export type HarnessSkillDescriptor = z.infer<
  typeof harnessSkillDescriptorSchema
>;

export const harnessCapabilitiesSchema = z.strictObject({
  adapterId: z.string().trim().min(1).max(128),
  capabilities: z.array(z.string().trim().min(1).max(128)).max(64).readonly(),
  skills: z.array(harnessSkillDescriptorSchema).max(128).readonly(),
  exactResume: z.boolean(),
});
export type HarnessCapabilities = z.infer<typeof harnessCapabilitiesSchema>;

const nativeSkillResolutionSchema = z.strictObject({
  kind: z.literal('native'),
  nativeId: z.string().trim().min(1).max(256),
  version: z.string().trim().min(1).max(128).optional(),
  digest: sha256DigestSchema,
});

const meshNativeFallbackSchema = z.strictObject({
  kind: z.literal('mesh-native-fallback'),
  workflow: z.literal('mesh.foundation-check/v1'),
});

const unavailableSkillResolutionSchema = z.strictObject({
  kind: z.literal('unavailable'),
  reason: z.string().trim().min(1).max(1024),
});

export const skillResolutionSchema = z.discriminatedUnion('kind', [
  nativeSkillResolutionSchema,
  meshNativeFallbackSchema,
  unavailableSkillResolutionSchema,
]);
export type SkillResolution = z.infer<typeof skillResolutionSchema>;

export const resolvedSkillSnapshotSchema = z.strictObject({
  requested: logicalSkillRequestSchema,
  mode: z.enum(['preferred', 'required']),
  resolution: skillResolutionSchema,
});
export type ResolvedSkillSnapshot = z.infer<typeof resolvedSkillSnapshotSchema>;

export const workerExecutionLifecycleSchema = z.enum([
  'created',
  'starting',
  'running',
  'interrupting',
  'completed',
  'failed',
  'interrupted',
  'attention_required',
]);
export type WorkerExecutionLifecycle = z.infer<
  typeof workerExecutionLifecycleSchema
>;

export const executionFailureSchema = z.strictObject({
  code: v2ErrorCodeSchema,
  message: z.string().trim().min(1).max(4096),
});
export type ExecutionFailure = z.infer<typeof executionFailureSchema>;

export const workerExecutionSchema = z
  .strictObject({
    id: workerExecutionIdSchema,
    projectId: projectIdSchema,
    profileId: workerProfileIdSchema,
    profileRevision: nonNegativeIntegerSchema,
    assignment: foundationCheckAssignmentSchema,
    profileSnapshot: resolvedWorkerProfileSnapshotSchema,
    skillRequests: z.strictObject({
      preferred: z.array(logicalSkillRequestSchema).readonly(),
      required: z.array(logicalSkillRequestSchema).readonly(),
    }),
    resolvedSkills: z.array(resolvedSkillSnapshotSchema).readonly(),
    capabilitySnapshot: harnessCapabilitiesSchema,
    adapterId: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256),
    nativeHandle: z.string().min(1).nullable(),
    lifecycle: workerExecutionLifecycleSchema,
    revision: nonNegativeIntegerSchema,
    lastAdapterCursor: nonNegativeIntegerSchema,
    lastRuntimeSequence: nonNegativeIntegerSchema,
    replacementForExecutionId: workerExecutionIdSchema.nullable(),
    failure: executionFailureSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.assignment.projectId !== value.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['assignment', 'projectId'],
        message: 'Assignment project must match execution project',
      });
    }
    if (
      value.profileSnapshot.profileId !== value.profileId ||
      value.profileSnapshot.profileRevision !== value.profileRevision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profileSnapshot'],
        message: 'Profile snapshot identity must match the execution',
      });
    }
    if (value.capabilitySnapshot.adapterId !== value.adapterId) {
      context.addIssue({
        code: 'custom',
        path: ['capabilitySnapshot', 'adapterId'],
        message: 'Capability adapter must match the execution adapter',
      });
    }
  });
export type WorkerExecution = z.infer<typeof workerExecutionSchema>;

export const harnessStartRequestSchema = z.strictObject({
  executionId: workerExecutionIdSchema,
  project: projectSchema,
  assignment: foundationCheckAssignmentSchema,
  profile: resolvedWorkerProfileSnapshotSchema,
  resolvedSkills: z.array(resolvedSkillSnapshotSchema).readonly(),
});
export type HarnessStartRequest = z.infer<typeof harnessStartRequestSchema>;

export const harnessResumeRequestSchema = harnessStartRequestSchema.extend({
  nativeHandle: z.string().min(1),
  afterAdapterCursor: nonNegativeIntegerSchema,
});
export type HarnessResumeRequest = z.infer<typeof harnessResumeRequestSchema>;

export const harnessProbeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('resumable'),
    afterAdapterCursor: nonNegativeIntegerSchema,
  }),
  z.strictObject({
    status: z.literal('terminal'),
    outcome: z.enum(['completed', 'failed', 'interrupted']),
  }),
  z.strictObject({
    status: z.enum(['missing', 'unknown']),
    reason: z.string().trim().min(1).max(1024),
  }),
]);
export type HarnessProbeResult = z.infer<typeof harnessProbeResultSchema>;

export const harnessOperationResultSchema = z.strictObject({
  status: z.enum(['succeeded', 'already_terminal', 'unknown']),
  reason: z.string().trim().min(1).max(1024).optional(),
});
export type HarnessOperationResult = z.infer<
  typeof harnessOperationResultSchema
>;

export interface HarnessAdapter {
  readonly id: string;
  capabilities(): Promise<HarnessCapabilities>;
  resolveSkills(
    requests: readonly LogicalSkillRequest[],
  ): Promise<readonly HarnessSkillDescriptor[]>;
  start(request: HarnessStartRequest): Promise<HarnessSession>;
  probe(nativeHandle: string): Promise<HarnessProbeResult>;
  resume(request: HarnessResumeRequest): Promise<HarnessSession>;
  interrupt(nativeHandle: string): Promise<HarnessOperationResult>;
}

export interface HarnessSession {
  readonly nativeHandle: string;
  events(afterAdapterCursor: number): AsyncIterable<HarnessEventEnvelope>;
  close(): Promise<void>;
}

export type { Project, ResolvedWorkerProfileSnapshot };
