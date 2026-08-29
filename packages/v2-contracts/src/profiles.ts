import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  isoTimestampSchema,
  nonNegativeIntegerSchema,
  projectIdSchema,
  workerProfileIdSchema,
} from './ids';

export const WORKER_PROFILE_API_VERSION = 'mesh.dev/v1alpha1' as const;

export const profileNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export type ProfileName = z.infer<typeof profileNameSchema>;

export const logicalSkillIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*(?:\/[a-z0-9.-]+)*$/);
export type LogicalSkillId = z.infer<typeof logicalSkillIdSchema>;

export const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Digest = z.infer<typeof sha256DigestSchema>;

export const logicalSkillConstraintSchema = z.strictObject({
  version: z.string().trim().min(1).max(128).optional(),
  digest: sha256DigestSchema.optional(),
});
export type LogicalSkillConstraint = z.infer<
  typeof logicalSkillConstraintSchema
>;

export const logicalSkillRequestSchema = z.strictObject({
  id: logicalSkillIdSchema,
  constraint: logicalSkillConstraintSchema.optional(),
});
export type LogicalSkillRequest = z.infer<typeof logicalSkillRequestSchema>;

const logicalSkillRequestInputSchema = z
  .union([logicalSkillIdSchema, logicalSkillRequestSchema])
  .transform(
    (value): LogicalSkillRequest =>
      typeof value === 'string' ? { id: value } : value,
  );

export const runtimePreferenceSchema = z.strictObject({
  harness: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
});
export type RuntimePreference = z.infer<typeof runtimePreferenceSchema>;

export const workerProfileSpecSchema = z.strictObject({
  assignmentKinds: z.tuple([z.literal('foundation-check')]).readonly(),
  preferredRuntime: runtimePreferenceSchema,
  alternatives: z.array(runtimePreferenceSchema).max(16).readonly(),
  requiredCapabilities: z
    .array(z.string().trim().min(1).max(128))
    .max(64)
    .readonly(),
  skills: z.strictObject({
    preferred: z.array(logicalSkillRequestInputSchema).max(64).readonly(),
    required: z.array(logicalSkillRequestInputSchema).max(64).readonly(),
  }),
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(32 * 1024),
  outputSchema: z.string().trim().min(1).max(256),
});
export type WorkerProfileSpec = z.infer<typeof workerProfileSpecSchema>;

const partialWorkerProfileSpecSchema = workerProfileSpecSchema.partial();

const duplicateSkillIds = (
  value: z.infer<typeof partialWorkerProfileSpecSchema>,
) => {
  const requests = [
    ...(value.skills?.preferred ?? []),
    ...(value.skills?.required ?? []),
  ];
  const seen = new Set<string>();
  return requests.filter(({ id }) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
};

export const workerProfileDocumentSchema = z
  .strictObject({
    apiVersion: z.literal(WORKER_PROFILE_API_VERSION),
    kind: z.literal('WorkerProfile'),
    metadata: z.strictObject({
      name: profileNameSchema,
      displayName: z.string().trim().min(1).max(256),
      scope: z.enum(['global', 'project']),
    }),
    extends: z
      .strictObject({
        profile: z.templateLiteral(['global/', profileNameSchema]),
        revision: nonNegativeIntegerSchema,
      })
      .optional(),
    spec: partialWorkerProfileSpecSchema,
  })
  .superRefine((value, context) => {
    if (value.metadata.scope === 'global' && value.extends !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['extends'],
        message: 'Only project profiles may extend a global profile',
      });
    }
    if (
      value.extends === undefined &&
      !workerProfileSpecSchema.safeParse(value.spec).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['spec'],
        message: 'Independent profiles must provide a complete spec',
      });
    }
    for (const duplicate of duplicateSkillIds(value.spec)) {
      context.addIssue({
        code: 'custom',
        path: ['spec', 'skills'],
        message: `Duplicate logical skill request: ${duplicate.id}`,
      });
    }
  });
export type WorkerProfileDocument = z.infer<typeof workerProfileDocumentSchema>;

export const resolvedWorkerProfileDocumentSchema = z.strictObject({
  apiVersion: z.literal(WORKER_PROFILE_API_VERSION),
  kind: z.literal('WorkerProfile'),
  metadata: z.strictObject({
    name: profileNameSchema,
    displayName: z.string().trim().min(1).max(256),
    scope: z.enum(['global', 'project']),
  }),
  spec: workerProfileSpecSchema,
});
export type ResolvedWorkerProfileDocument = z.infer<
  typeof resolvedWorkerProfileDocumentSchema
>;

export const workerProfileRevisionSchema = z
  .strictObject({
    profileId: workerProfileIdSchema,
    scope: z.enum(['global', 'project']),
    projectId: projectIdSchema.nullable(),
    name: profileNameSchema,
    displayName: z.string().trim().min(1).max(256),
    revision: nonNegativeIntegerSchema,
    sourceYaml: z
      .string()
      .min(1)
      .max(64 * 1024),
    document: workerProfileDocumentSchema,
    baseProfileId: workerProfileIdSchema.nullable(),
    baseRevision: nonNegativeIntegerSchema.nullable(),
    approvedBy: z.strictObject({ kind: z.literal('human') }),
    approvedAt: isoTimestampSchema,
    digest: sha256DigestSchema,
  })
  .superRefine((value, context) => {
    const projectScoped = value.scope === 'project';
    if (projectScoped !== (value.projectId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'Project ID must match profile scope',
      });
    }
    if (
      value.document.metadata.scope !== value.scope ||
      value.document.metadata.name !== value.name ||
      value.document.metadata.displayName !== value.displayName
    ) {
      context.addIssue({
        code: 'custom',
        path: ['document', 'metadata'],
        message: 'Stored profile identity must match the document metadata',
      });
    }
    if ((value.baseProfileId === null) !== (value.baseRevision === null)) {
      context.addIssue({
        code: 'custom',
        path: ['baseProfileId'],
        message: 'Base profile ID and revision must be present together',
      });
    }
    if (
      value.scope === 'global' &&
      (value.baseProfileId !== null || value.document.extends !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['baseProfileId'],
        message:
          'Global profile revisions cannot have a base or extend another profile',
      });
    }
    if (
      value.scope === 'project' &&
      value.document.extends === undefined &&
      value.baseProfileId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['baseProfileId'],
        message: 'Independent project profile revisions cannot have a base',
      });
    }
    if (
      value.scope === 'project' &&
      value.document.extends !== undefined &&
      (value.baseProfileId === null ||
        value.baseRevision !== value.document.extends.revision)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['baseRevision'],
        message:
          'Project profile base must match its pinned document extension',
      });
    }
  });
export type WorkerProfileRevision = z.infer<typeof workerProfileRevisionSchema>;

export const resolvedWorkerProfileSnapshotSchema = z
  .strictObject({
    profileId: workerProfileIdSchema,
    projectId: projectIdSchema.nullable(),
    profileRevision: nonNegativeIntegerSchema,
    baseProfileId: workerProfileIdSchema.nullable(),
    baseRevision: nonNegativeIntegerSchema.nullable(),
    document: resolvedWorkerProfileDocumentSchema,
    digest: sha256DigestSchema,
  })
  .superRefine((value, context) => {
    if ((value.baseProfileId === null) !== (value.baseRevision === null)) {
      context.addIssue({
        code: 'custom',
        path: ['baseProfileId'],
        message: 'Base profile ID and revision must be present together',
      });
    }
    const projectScoped = value.document.metadata.scope === 'project';
    if (projectScoped !== (value.projectId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'Project ID must match resolved profile scope',
      });
    }
    if (
      value.document.metadata.scope === 'global' &&
      value.baseProfileId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['baseProfileId'],
        message: 'Global resolved profiles cannot have a base',
      });
    }
  });
export type ResolvedWorkerProfileSnapshot = z.infer<
  typeof resolvedWorkerProfileSnapshotSchema
>;

export const parseWorkerProfileYaml = (sourceYaml: string) =>
  workerProfileDocumentSchema.parse(parseYaml(sourceYaml));
