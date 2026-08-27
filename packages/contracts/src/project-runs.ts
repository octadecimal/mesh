import { z } from 'zod';

import { idSchema, isoTimestampSchema } from './domain.js';

export const projectRunItemStatusSchema = z.enum([
  'queued',
  'launch_pending',
  'active',
  'completed',
  'attention_required',
  'not_started',
]);

export const projectRunStateSchema = z.enum([
  'running',
  'paused',
  'draining',
  'completed',
]);

const projectRunItemBaseSchema = z.object({
  id: idSchema,
  runId: idSchema,
  projectId: idSchema,
  taskId: idSchema,
  taskRevision: z.number().int().positive(),
  policyRevision: z.number().int().positive().default(1),
  taskAutomationGeneration: z.number().int().nonnegative().default(0),
  queuePosition: z.number().int().nonnegative(),
  attemptId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  launchIdempotencyKey: z.string().trim().min(1),
  claimedAt: isoTimestampSchema.nullable(),
  startedAt: isoTimestampSchema.nullable(),
  finishedAt: isoTimestampSchema.nullable(),
});

export const projectRunItemSchema = z.discriminatedUnion('status', [
  projectRunItemBaseSchema.extend({
    status: z.enum(['queued', 'launch_pending', 'active']),
    outcomeReason: z.null(),
  }),
  projectRunItemBaseSchema.extend({
    status: z.enum(['completed', 'attention_required', 'not_started']),
    outcomeReason: z.string().trim().min(1),
  }),
]);

const projectRunBaseSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  revision: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  startedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  items: z.array(projectRunItemSchema),
});

export const projectRunSchema = z.discriminatedUnion('state', [
  projectRunBaseSchema.extend({
    state: z.enum(['running', 'paused', 'draining']),
    completionReason: z.null(),
    completedAt: z.null(),
  }),
  projectRunBaseSchema.extend({
    state: z.literal('completed'),
    completionReason: z.string().trim().min(1),
    completedAt: isoTimestampSchema,
  }),
]);

export type ProjectRunItem = z.infer<typeof projectRunItemSchema>;
export type ProjectRun = z.infer<typeof projectRunSchema>;
