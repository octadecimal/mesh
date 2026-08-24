import { z } from 'zod';

import {
  idSchema,
  projectSchema,
  rawDiagnosticSchema,
  savedLayoutSchema,
  sessionSchema,
  workspaceSchema,
} from './domain.js';
import { sessionEventSchema } from './events.js';
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
});

export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionHistory = z.infer<typeof sessionHistorySchema>;
export type SessionDiagnostics = z.infer<typeof sessionDiagnosticsSchema>;
