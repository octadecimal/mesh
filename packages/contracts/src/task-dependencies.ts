import { z } from 'zod';

import { idSchema, isoTimestampSchema, taskActorSchema } from './domain.js';

export const taskDependencySchema = z.object({
  projectId: idSchema,
  taskId: idSchema,
  prerequisiteTaskId: idSchema,
  createdBy: taskActorSchema,
  createdAt: isoTimestampSchema,
});

export const taskReadinessProblemSchema = z.union([
  z.enum(['title', 'description', 'acceptanceCriteria', 'priority']),
  z.object({ type: z.literal('dependency_incomplete'), taskId: idSchema }),
]);

export type TaskDependency = z.infer<typeof taskDependencySchema>;
export type TaskReadinessProblem = z.infer<typeof taskReadinessProblemSchema>;
