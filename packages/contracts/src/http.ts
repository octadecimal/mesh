import { z } from 'zod';

import {
  idSchema,
  attemptRepairSchema,
  projectSchema,
  rawDiagnosticSchema,
  savedLayoutSchema,
  sessionSchema,
  taskAttemptSchema,
  taskSchema,
  taskTransitionSchema,
  workspaceSchema,
} from './domain.js';
import { sessionEventSchema } from './events.js';
import { projectEventSchema } from './project-events.js';
import { protocolVersionSchema } from './protocol.js';

export const sessionSnapshotSchema = z.object({
  protocolVersion: protocolVersionSchema,
  projects: z.array(projectSchema),
  workspaces: z.array(workspaceSchema),
  sessions: z.array(sessionSchema),
  events: z.array(sessionEventSchema),
  pendingApprovals: z.array(sessionEventSchema).default([]),
  lastSequenceBySession: z
    .record(z.string(), z.number().int().nonnegative())
    .default({}),
  layouts: z.array(savedLayoutSchema).default([]),
});

export const sessionHistorySchema = z.object({
  protocolVersion: protocolVersionSchema,
  sessionId: idSchema,
  events: z.array(sessionEventSchema),
});

export const sessionDiagnosticsSchema = z.object({
  protocolVersion: protocolVersionSchema,
  sessionId: idSchema,
  diagnostics: z.array(rawDiagnosticSchema),
  nextAfter: idSchema.optional(),
});

export const projectSnapshotSchema = z.object({
  protocolVersion: protocolVersionSchema,
  project: projectSchema,
  tasks: z.array(taskSchema),
  attempts: z.array(taskAttemptSchema),
  transitions: z.array(taskTransitionSchema),
  repairs: z.array(attemptRepairSchema),
  cursor: z.number().int().nonnegative(),
});

export const projectHistorySchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    projectId: idSchema,
    events: z.array(projectEventSchema),
    cursor: z.number().int().nonnegative(),
  })
  .superRefine(({ projectId, events }, context) => {
    let previousSequence = -1;

    for (const [index, event] of events.entries()) {
      if (event.projectId !== projectId) {
        context.addIssue({
          code: 'custom',
          message:
            'Project history events must belong to the requested project.',
          path: ['events', index, 'projectId'],
        });
      }
      if (event.sequence <= previousSequence) {
        context.addIssue({
          code: 'custom',
          message:
            'Project history event sequences must be strictly increasing.',
          path: ['events', index, 'sequence'],
        });
      }
      previousSequence = event.sequence;
    }
  });

export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionHistory = z.infer<typeof sessionHistorySchema>;
export type SessionDiagnostics = z.infer<typeof sessionDiagnosticsSchema>;
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;
export type ProjectHistory = z.infer<typeof projectHistorySchema>;
