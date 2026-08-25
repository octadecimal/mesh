import { z } from 'zod';

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

export const projectSchema = z.object({
  id: idSchema,
  displayName: z.string().trim().min(1),
  repositoryPath: z.string().trim().min(1),
  discoveredAt: isoTimestampSchema,
  discoveryMetadata: z.record(z.string(), z.unknown()).default({}),
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
export type Project = z.infer<typeof projectSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type RawDiagnostic = z.infer<typeof rawDiagnosticSchema>;
export type SavedLayout = z.infer<typeof savedLayoutSchema>;
