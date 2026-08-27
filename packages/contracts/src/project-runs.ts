import { z } from 'zod';

import { idSchema, isoTimestampSchema } from './domain.js';
import { reviewAutomationStatusSchema } from './qa-execution.js';

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
  taskAutomationStatus: reviewAutomationStatusSchema.default('disabled'),
  taskAutomationGeneration: z.number().int().nonnegative().default(0),
  queuePosition: z.number().int().nonnegative(),
  attemptId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  launchIdempotencyKey: z.string().trim().min(1),
  claimedAt: isoTimestampSchema.nullable(),
  startedAt: isoTimestampSchema.nullable(),
  finishedAt: isoTimestampSchema.nullable(),
});

export const projectRunItemSchema = z
  .discriminatedUnion('status', [
    projectRunItemBaseSchema.extend({
      status: z.enum(['queued', 'launch_pending', 'active']),
      outcomeReason: z.null(),
    }),
    projectRunItemBaseSchema.extend({
      status: z.enum(['completed', 'attention_required', 'not_started']),
      outcomeReason: z.string().trim().min(1),
    }),
  ])
  .superRefine((item, context) => {
    const invalid = (message: string) =>
      context.addIssue({ code: 'custom', message });
    const hasLaunchLinks = item.attemptId !== null && item.sessionId !== null;
    const hasNoLaunchLinks = item.attemptId === null && item.sessionId === null;

    if (
      item.status === 'queued' &&
      (item.claimedAt !== null ||
        item.startedAt !== null ||
        item.finishedAt !== null ||
        !hasNoLaunchLinks)
    ) {
      invalid('Queued run items cannot contain launch or finish evidence.');
    }
    if (
      item.status === 'launch_pending' &&
      (item.claimedAt === null ||
        item.startedAt !== null ||
        item.finishedAt !== null ||
        !hasNoLaunchLinks)
    ) {
      invalid('Launch-pending run items require only claim evidence.');
    }
    if (
      item.status === 'active' &&
      (item.claimedAt === null ||
        item.startedAt === null ||
        item.finishedAt !== null ||
        !hasLaunchLinks)
    ) {
      invalid('Active run items require linked launch evidence.');
    }
    if (
      item.status === 'completed' &&
      (item.claimedAt === null ||
        item.startedAt === null ||
        item.finishedAt === null ||
        !hasLaunchLinks)
    ) {
      invalid(
        'Completed run items require complete linked lifecycle evidence.',
      );
    }
    if (
      item.status === 'attention_required' &&
      (item.claimedAt === null ||
        item.finishedAt === null ||
        (item.startedAt === null ? !hasNoLaunchLinks : !hasLaunchLinks))
    ) {
      invalid(
        'Attention run items require coherent prelaunch or linked evidence.',
      );
    }
    if (
      item.status === 'not_started' &&
      (item.claimedAt !== null ||
        item.startedAt !== null ||
        item.finishedAt === null ||
        !hasNoLaunchLinks)
    ) {
      invalid('Not-started run items can contain finish evidence only.');
    }
  });

const projectRunBaseSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  revision: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  startedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  items: z.array(projectRunItemSchema),
});

export const projectRunSchema = z
  .discriminatedUnion('state', [
    projectRunBaseSchema.extend({
      state: z.enum(['running', 'draining']),
      pauseReason: z.null().default(null),
      completionReason: z.null(),
      completedAt: z.null(),
    }),
    projectRunBaseSchema.extend({
      state: z.literal('paused'),
      pauseReason: z.preprocess(
        (value) => value ?? 'operator_paused',
        z.string().trim().min(1),
      ),
      completionReason: z.null(),
      completedAt: z.null(),
    }),
    projectRunBaseSchema.extend({
      state: z.literal('completed'),
      pauseReason: z.null().default(null),
      completionReason: z.string().trim().min(1),
      completedAt: isoTimestampSchema,
    }),
  ])
  .superRefine((run, context) => {
    const itemIds = new Set<string>();
    const taskIds = new Set<string>();
    const queuePositions = new Set<number>();
    for (const [index, item] of run.items.entries()) {
      if (item.runId !== run.id || item.projectId !== run.projectId) {
        context.addIssue({
          code: 'custom',
          message: 'Run item ownership must match its enclosing run.',
          path: ['items', index],
        });
      }
      if (
        itemIds.has(item.id) ||
        taskIds.has(item.taskId) ||
        queuePositions.has(item.queuePosition)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Run item ids, task ids, and queue positions must be unique.',
          path: ['items', index],
        });
      }
      itemIds.add(item.id);
      taskIds.add(item.taskId);
      queuePositions.add(item.queuePosition);
    }
    if (
      run.state === 'completed' &&
      run.items.some(
        ({ status }) => status === 'launch_pending' || status === 'active',
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Completed runs cannot contain occupied items.',
        path: ['items'],
      });
    }
  });

export type ProjectRunItem = z.infer<typeof projectRunItemSchema>;
export type ProjectRun = z.infer<typeof projectRunSchema>;
