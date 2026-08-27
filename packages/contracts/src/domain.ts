import { z } from 'zod';

import {
  qaConfigurationSchema,
  qaExecutionCycleSchema,
  reviewAutomationStateSchema,
} from './qa-execution.js';

export const idSchema = z.string().trim().min(1).brand<'Id'>();
export const isoTimestampSchema = z.string().datetime({ offset: true });

export const workspaceTypeSchema = z.enum(['shared', 'worktree']);
export const permissionModeSchema = z.enum([
  'interactive',
  'safe_auto',
  'inherit',
]);
export const lifecycleStateSchema = z.enum([
  'idle',
  'starting',
  'running',
  'waiting_for_approval',
  'interrupting',
  'completed',
  'failed',
  'interrupted',
  'archived',
]);

export const taskActorSchema = z.object({
  type: z.enum(['human', 'system', 'agent']),
  id: idSchema,
  displayName: z.string().trim().min(1).optional(),
});

export const developerInstructionsSchema = z.object({
  content: z.string(),
  revision: z.number().int().positive(),
  updatedAt: isoTimestampSchema,
  updatedBy: taskActorSchema.nullable(),
});

export const projectSchema = z
  .object({
    id: idSchema,
    displayName: z.string().trim().min(1),
    repositoryPath: z.string().trim().min(1),
    discoveredAt: isoTimestampSchema,
    discoveryMetadata: z.record(z.string(), z.unknown()).default({}),
    repositoryIdentity: z.string().trim().min(1).optional(),
    revision: z.number().int().positive().default(1),
    createdAt: isoTimestampSchema.optional(),
    updatedAt: isoTimestampSchema.optional(),
    archivedAt: isoTimestampSchema.nullable().default(null),
    developerInstructions: developerInstructionsSchema.optional(),
    qaConfiguration: qaConfigurationSchema.optional(),
  })
  .transform((project) => ({
    ...project,
    repositoryIdentity: project.repositoryIdentity ?? project.repositoryPath,
    createdAt: project.createdAt ?? project.discoveredAt,
    updatedAt: project.updatedAt ?? project.discoveredAt,
    developerInstructions: project.developerInstructions ?? {
      content: '',
      revision: 1,
      updatedAt: project.updatedAt ?? project.discoveredAt,
      updatedBy: null,
    },
    qaConfiguration: project.qaConfiguration ?? {
      instructions: {
        content: '',
        revision: 1,
        updatedAt: project.updatedAt ?? project.discoveredAt,
        updatedBy: null,
      },
      reviewPolicy: 'manual',
      revision: 1,
      updatedAt: project.updatedAt ?? project.discoveredAt,
      updatedBy: null,
    },
  }));

export const taskLifecycleStateSchema = z.enum([
  'backlog',
  'ready',
  'in_progress',
  'review',
  'done',
  'cancelled',
]);
export const taskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const blockedConditionSchema = z.object({
  reason: z.string().trim().min(1),
  actor: taskActorSchema,
  blockedAt: isoTimestampSchema,
});

const taskSchemaBase = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string().trim().min(1),
  description: z.string(),
  acceptanceCriteria: z.array(z.string().trim().min(1)),
  priority: taskPrioritySchema,
  rank: z.string().trim().min(1),
  lifecycleState: taskLifecycleStateSchema,
  labels: z.array(z.string().trim().min(1)),
  notes: z.string(),
  blocked: blockedConditionSchema.nullable(),
  revision: z.number().int().positive(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  reviewAutomation: reviewAutomationStateSchema.optional(),
});

type TaskSchemaOutput = Omit<
  z.output<typeof taskSchemaBase>,
  'reviewAutomation'
> & {
  reviewAutomation: z.output<typeof reviewAutomationStateSchema>;
};

export const taskSchema = taskSchemaBase.transform((task) => ({
  ...task,
  reviewAutomation: task.reviewAutomation ?? {
    status: 'disabled' as const,
    generation: 0,
    rejectionCount: 0,
    pauseReason: null,
    updatedAt: task.updatedAt,
  },
})) as z.ZodType<TaskSchemaOutput, z.input<typeof taskSchemaBase>>;

export const taskAttemptSourceSchema = z.union([
  z.enum(['launched', 'linked']),
  z.object({
    type: z.literal('project_run'),
    runId: idSchema,
    runItemId: idSchema,
  }),
]);
const taskAttemptSchemaBase = z.object({
  id: idSchema,
  taskId: idSchema,
  sessionId: idSchema,
  ordinal: z.number().int().positive(),
  source: taskAttemptSourceSchema,
  actor: taskActorSchema,
  createdAt: isoTimestampSchema,
  unlinkedAt: isoTimestampSchema.nullable(),
  unlinkedBy: taskActorSchema.nullable(),
  unlinkReason: z.string().trim().min(1).nullable(),
  role: z.literal('developer').nullable().default(null),
  qaCycles: z.array(qaExecutionCycleSchema).default([]),
});

type TaskAttemptSchemaOutput = Omit<
  z.output<typeof taskAttemptSchemaBase>,
  'qaCycles'
> & {
  qaCycles: Array<z.output<typeof qaExecutionCycleSchema>>;
};

export const taskAttemptSchema = taskAttemptSchemaBase as z.ZodType<
  TaskAttemptSchemaOutput,
  z.input<typeof taskAttemptSchemaBase>
>;

export const taskTransitionSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  commandId: idSchema,
  previousState: taskLifecycleStateSchema,
  nextState: taskLifecycleStateSchema,
  actor: taskActorSchema,
  reason: z.string().trim().min(1).nullable(),
  occurredAt: isoTimestampSchema,
});

export const attemptRepairSchema = z.object({
  taskId: idSchema,
  attemptId: idSchema,
  sessionId: idSchema,
  reason: z.enum([
    'task_in_progress_without_live_session',
    'developer_cycle_without_live_session',
    'startup_outcome_unknown',
    'qa_cycle_without_trustworthy_outcome',
    'qa_session_workspace_mismatch',
    'review_automation_action_incomplete',
  ]),
});

export const workspaceSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  type: workspaceTypeSchema,
  path: z.string().trim().min(1),
  gitBranch: z.string().optional(),
  gitWorktreePath: z.string().optional(),
  owner: z.string().optional(),
  cleanupState: z.enum(['active', 'pending', 'cleaned']).default('active'),
});

export const sessionSchema = z.object({
  id: idSchema,
  claudeResumeId: idSchema.optional(),
  projectId: idSchema,
  workspaceId: idSchema,
  title: z.string().trim().min(1),
  permissionMode: permissionModeSchema,
  lifecycleState: lifecycleStateSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const rawDiagnosticSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  normalizedEventId: idSchema.optional(),
  capturedAt: isoTimestampSchema,
  payload: z.unknown(),
});

export const savedLayoutSchema = z.object({
  id: idSchema,
  projectId: idSchema.optional(),
  sessionId: idSchema.optional(),
  workspaceId: idSchema.optional(),
  dockview: z.unknown(),
  sidebar: z.unknown().optional(),
  visiblePanels: z.array(z.string()).default([]),
  updatedAt: isoTimestampSchema,
});

export type Id = z.infer<typeof idSchema>;
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;
export type WorkspaceType = z.infer<typeof workspaceTypeSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type DeveloperInstructions = z.infer<typeof developerInstructionsSchema>;
export type Project = z.infer<typeof projectSchema>;
export type TaskLifecycleState = z.infer<typeof taskLifecycleStateSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskActor = z.infer<typeof taskActorSchema>;
export type BlockedCondition = z.infer<typeof blockedConditionSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskAttemptSource = z.infer<typeof taskAttemptSourceSchema>;
export type TaskAttempt = z.infer<typeof taskAttemptSchema>;
export type TaskTransition = z.infer<typeof taskTransitionSchema>;
export type AttemptRepair = z.infer<typeof attemptRepairSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type RawDiagnostic = z.infer<typeof rawDiagnosticSchema>;
export type SavedLayout = z.infer<typeof savedLayoutSchema>;
