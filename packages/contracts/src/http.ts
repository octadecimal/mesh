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
import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  developerReviewFeedbackSchema,
} from './developer-execution.js';
import {
  qaExecutionCycleSchema,
  qaReportSchema,
  reviewAutomationActionSchema,
} from './qa-execution.js';
import { sessionEventSchema } from './events.js';
import { projectEventSchema } from './project-events.js';
import { projectRunSchema } from './project-runs.js';
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

export const projectSnapshotSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    project: projectSchema,
    tasks: z.array(taskSchema),
    attempts: z.array(taskAttemptSchema),
    transitions: z.array(taskTransitionSchema),
    repairs: z.array(attemptRepairSchema),
    developerCycles: z.array(developerExecutionCycleSchema).default([]),
    developerCompletionReports: z
      .array(developerCompletionReportSchema)
      .default([]),
    developerBlockerReports: z.array(developerBlockerReportSchema).default([]),
    developerReviewFeedback: z.array(developerReviewFeedbackSchema).default([]),
    qaCycles: z.array(qaExecutionCycleSchema).default([]),
    qaReports: z.array(qaReportSchema).default([]),
    reviewAutomationActions: z.array(reviewAutomationActionSchema).default([]),
    runs: z.array(projectRunSchema).default([]),
    projectRunLimits: z
      .object({ maxConcurrency: z.number().int().positive() })
      .default({
        maxConcurrency: 1,
      }),
    cursor: z.number().int().nonnegative(),
  })
  .superRefine(({ project, runs }, context) => {
    const runIds = new Set<string>();
    for (const [index, run] of runs.entries()) {
      if (run.projectId !== project.id) {
        context.addIssue({
          code: 'custom',
          message: 'Project snapshot runs must belong to the snapshot project.',
          path: ['runs', index, 'projectId'],
        });
      }
      if (runIds.has(run.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Project snapshot run IDs must be unique.',
          path: ['runs', index, 'id'],
        });
      }
      runIds.add(run.id);
    }
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
