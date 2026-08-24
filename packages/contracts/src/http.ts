import { z } from 'zod';

import { projectSchema, sessionSchema, workspaceSchema } from './domain.js';
import { sessionEventSchema } from './events.js';

export const sessionSnapshotSchema = z.object({
  projects: z.array(projectSchema),
  workspaces: z.array(workspaceSchema),
  sessions: z.array(sessionSchema),
  events: z.array(sessionEventSchema),
});

export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
