import { z } from 'zod';

import {
  blockedConditionSchema,
  idSchema,
  isoTimestampSchema,
  projectSchema,
  taskAttemptSchema,
  taskSchema,
  taskTransitionSchema,
} from './domain.js';
import { protocolVersionSchema } from './protocol.js';

const projectEvent = <Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) =>
  z.object({
    protocolVersion: protocolVersionSchema,
    id: idSchema,
    projectId: idSchema,
    sequence: z.number().int().positive(),
    occurredAt: isoTimestampSchema,
    type: z.literal(type),
    payload,
  });

export const projectChangedEventSchema = projectEvent(
  'project.changed',
  z.object({ project: projectSchema }),
);
export const taskChangedEventSchema = projectEvent(
  'task.changed',
  z.object({ task: taskSchema }),
);
export const taskTransitionedEventSchema = projectEvent(
  'task.transitioned',
  z.object({ task: taskSchema, transition: taskTransitionSchema }),
);
export const taskBlockChangedEventSchema = projectEvent(
  'task.block_changed',
  z.object({ task: taskSchema, blocked: blockedConditionSchema.nullable() }),
);
export const taskRankChangedEventSchema = projectEvent(
  'task.rank_changed',
  z.object({ task: taskSchema }),
);
export const taskAttemptChangedEventSchema = projectEvent(
  'task.attempt_changed',
  z.object({ attempt: taskAttemptSchema }),
);

export const projectEventSchema = z.discriminatedUnion('type', [
  projectChangedEventSchema,
  taskChangedEventSchema,
  taskTransitionedEventSchema,
  taskBlockChangedEventSchema,
  taskRankChangedEventSchema,
  taskAttemptChangedEventSchema,
]);

export type ProjectEvent = z.infer<typeof projectEventSchema>;
export type ProjectEventDraft = Omit<ProjectEvent, 'id' | 'sequence'>;
