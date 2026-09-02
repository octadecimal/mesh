import { z } from 'zod';

import type { HarnessEventEnvelope } from './events';
import {
  PM_PLAN_REPORT_SCHEMA,
  pmPlanAssignmentSchema,
  type PmPlanAssignment,
} from './delivery-plan';
import {
  isoTimestampSchema,
  nonNegativeIntegerSchema,
  projectIdSchema,
  workerExecutionIdSchema,
  workerProfileIdSchema,
} from './ids';
import {
  PM_DISCOVERY_REPORT_SCHEMA,
  pmDiscoveryAssignmentSchema,
  type PmDiscoveryAssignment,
} from './intent';
import {
  DEVELOPER_REPORT_SCHEMA,
  developerTaskAssignmentSchema,
  type DeveloperTaskAssignment,
} from './developer-attempts';
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
  'planning_canonical_base_conflict',
  'planning_intent_required',
  'planning_requirements_required',
  'planning_cycle_active_conflict',
  'planning_cycle_history_limit',
  'planning_cycle_not_found',
  'planning_cycle_revision_conflict',
  'planning_profile_incompatible',
  'planning_proposal_invalid',
  'planning_proposal_not_found',
  'planning_proposal_revision_conflict',
  'plan_proposal_not_found',
  'plan_proposal_revision_conflict',
  'plan_canonical_base_conflict',
  'plan_proposal_invalid',
  'board_filter_not_found',
  'board_filter_revision_conflict',
  'board_filter_invalid',
  'repository_head_ambiguous',
  'repository_head_failed',
  'repository_head_unborn',
  'repository_identity_conflict',
  'repository_invalid',
  'repository_path_escape',
  'required_capability_unavailable',
  'required_skill_unavailable',
  'startup_interrupted_before_start',
  'developer_task_stale',
  'developer_plan_stale',
  'developer_profile_stale',
  'developer_profile_incompatible',
  'developer_task_not_actionable',
  'developer_attempt_conflict',
  'developer_attempt_transition_conflict',
  'developer_workspace_conflict',
  'developer_workspace_identity_mismatch',
  'developer_workspace_operation_failed',
  'developer_report_binding_invalid',
  'developer_report_coverage_invalid',
  'developer_replacement_unavailable',
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

export const workerAssignmentSchema = z.discriminatedUnion('kind', [
  foundationCheckAssignmentSchema,
  pmDiscoveryAssignmentSchema,
  pmPlanAssignmentSchema,
  developerTaskAssignmentSchema,
]);
export type WorkerAssignment = z.infer<typeof workerAssignmentSchema>;

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

export const resolvedSkillSnapshotSchema = z
  .strictObject({
    requested: logicalSkillRequestSchema,
    mode: z.enum(['preferred', 'required']),
    resolution: skillResolutionSchema,
  })
  .superRefine((value, context) => {
    if (value.mode === 'preferred' && value.resolution.kind === 'unavailable') {
      context.addIssue({
        code: 'custom',
        path: ['resolution'],
        message:
          'Preferred skills must resolve natively or use the Mesh fallback',
      });
    }
    if (
      value.mode === 'required' &&
      value.resolution.kind === 'mesh-native-fallback'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['resolution'],
        message: 'Required skills must resolve natively or be unavailable',
      });
    }
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
  missing: z
    .array(z.string().trim().min(1).max(256))
    .min(1)
    .max(64)
    .readonly()
    .optional(),
});
export type ExecutionFailure = z.infer<typeof executionFailureSchema>;

export const workerExecutionSchema = z
  .strictObject({
    id: workerExecutionIdSchema,
    projectId: projectIdSchema,
    profileId: workerProfileIdSchema,
    profileRevision: nonNegativeIntegerSchema,
    assignment: workerAssignmentSchema,
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
    if (
      value.profileSnapshot.projectId !== null &&
      value.profileSnapshot.projectId !== value.projectId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profileSnapshot', 'projectId'],
        message: 'Project profile snapshot must match the execution project',
      });
    }
    if (
      value.profileSnapshot.document.spec.assignmentKinds[0] !==
      value.assignment.kind
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profileSnapshot', 'document', 'spec', 'assignmentKinds'],
        message: 'Profile assignment kind must match the execution assignment',
      });
    }
    if (
      value.assignment.kind === 'pm_discovery' &&
      (value.assignment.outputSchema !== PM_DISCOVERY_REPORT_SCHEMA ||
        value.profileSnapshot.document.spec.outputSchema !==
          PM_DISCOVERY_REPORT_SCHEMA)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profileSnapshot', 'document', 'spec', 'outputSchema'],
        message: 'PM execution output schemas must match the discovery schema',
      });
    }
    if (
      value.assignment.kind === 'pm_plan' &&
      (value.assignment.outputSchema !== PM_PLAN_REPORT_SCHEMA ||
        value.profileSnapshot.document.spec.outputSchema !==
          PM_PLAN_REPORT_SCHEMA)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profileSnapshot', 'document', 'spec', 'outputSchema'],
        message: 'PM execution output schemas must match the plan schema',
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

const harnessStartRequestShape = {
  executionId: workerExecutionIdSchema,
  project: projectSchema,
  assignment: workerAssignmentSchema,
  profile: resolvedWorkerProfileSnapshotSchema,
  resolvedSkills: z.array(resolvedSkillSnapshotSchema).readonly(),
};

const requireHarnessProjectCoherence = (
  value: {
    project: Project;
    assignment:
      | FoundationCheckAssignment
      | PmDiscoveryAssignment
      | PmPlanAssignment
      | DeveloperTaskAssignment;
    profile: ResolvedWorkerProfileSnapshot;
  },
  context: z.RefinementCtx,
) => {
  if (value.project.id !== value.assignment.projectId) {
    context.addIssue({
      code: 'custom',
      path: ['assignment', 'projectId'],
      message: 'Assignment project must match the harness project',
    });
  }
  if (
    value.profile.projectId !== null &&
    value.profile.projectId !== value.project.id
  ) {
    context.addIssue({
      code: 'custom',
      path: ['profile', 'projectId'],
      message: 'Project profile must match the harness project',
    });
  }
  if (
    value.profile.document.spec.assignmentKinds[0] !== value.assignment.kind
  ) {
    context.addIssue({
      code: 'custom',
      path: ['profile', 'document', 'spec', 'assignmentKinds'],
      message: 'Profile assignment kind must match the harness assignment',
    });
  }
  if (
    value.assignment.kind === 'pm_discovery' &&
    (value.assignment.outputSchema !== PM_DISCOVERY_REPORT_SCHEMA ||
      value.profile.document.spec.outputSchema !== PM_DISCOVERY_REPORT_SCHEMA)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['profile', 'document', 'spec', 'outputSchema'],
      message: 'PM harness output schemas must match the discovery schema',
    });
  }
  if (
    value.assignment.kind === 'pm_plan' &&
    (value.assignment.outputSchema !== PM_PLAN_REPORT_SCHEMA ||
      value.profile.document.spec.outputSchema !== PM_PLAN_REPORT_SCHEMA)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['profile', 'document', 'spec', 'outputSchema'],
      message: 'PM harness output schemas must match the plan schema',
    });
  }
  if (
    value.assignment.kind === 'developer_task' &&
    (value.assignment.outputSchema !== DEVELOPER_REPORT_SCHEMA ||
      value.profile.document.spec.outputSchema !== DEVELOPER_REPORT_SCHEMA)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['profile', 'document', 'spec', 'outputSchema'],
      message:
        'Developer harness output schemas must match the Developer schema',
    });
  }
};

export const harnessStartRequestSchema = z
  .strictObject(harnessStartRequestShape)
  .superRefine(requireHarnessProjectCoherence);
export type HarnessStartRequest = z.infer<typeof harnessStartRequestSchema>;

export const harnessResumeRequestSchema = z
  .strictObject({
    ...harnessStartRequestShape,
    nativeHandle: z.string().min(1),
    afterAdapterCursor: nonNegativeIntegerSchema,
  })
  .superRefine(requireHarnessProjectCoherence);
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
