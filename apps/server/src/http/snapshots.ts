import { z } from 'zod';
import {
  idSchema,
  sessionDiagnosticsSchema,
  sessionHistorySchema,
  sessionSnapshotSchema,
} from '@mesh-session-platform/contracts';

import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { LayoutRepository } from '../repositories/layout-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import { CommandError } from './errors.js';

export interface SnapshotDependencies {
  projects: ProjectRepository;
  workspaces: WorkspaceRepository;
  sessions: SessionRepository;
  events: EventRepository;
  diagnostics: DiagnosticRepository;
  layouts: LayoutRepository;
}

const paginationSchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .default(100)
    .transform((value) => Math.min(value, 200)),
});

const diagnosticPaginationSchema = z.object({
  after: idSchema.optional(),
  limit: z.coerce.number().int().positive().default(100).transform((value) => Math.min(value, 200)),
});

const requireSession = (
  dependencies: SnapshotDependencies,
  sessionId: string,
) => {
  const session = dependencies.sessions.get(sessionId);
  if (!session)
    throw new CommandError(
      'session_not_found',
      `Session '${sessionId}' was not found`,
    );
  return session;
};

export const buildSnapshot = (dependencies: SnapshotDependencies) => {
  const projects = dependencies.projects.list();
  const workspaces = projects.flatMap((project) =>
    dependencies.workspaces.listByProject(project.id),
  );
  const sessions = projects.flatMap((project) =>
    dependencies.sessions.listByProject(project.id, { includeArchived: true }),
  );
  const events = sessions.flatMap((session) =>
    dependencies.events.after(session.id, 0),
  );
  const pending = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    if (event.type === 'permission.requested')
      pending.set(event.payload.permissionId, event);
    if (event.type === 'permission.resolved')
      pending.delete(event.payload.permissionId);
  }
  const lastSequenceBySession = Object.fromEntries(
    sessions.map((session) => {
      const last =
        events.filter((event) => event.sessionId === session.id).at(-1)
          ?.sequence ?? 0;
      return [session.id, last];
    }),
  );
  return sessionSnapshotSchema.parse({
    protocolVersion: 1,
    projects,
    workspaces,
    sessions,
    events,
    pendingApprovals: [...pending.values()],
    lastSequenceBySession,
    layouts: dependencies.layouts.list(),
  });
};

export const readHistory = (
  dependencies: SnapshotDependencies,
  sessionId: string,
  query: unknown,
) => {
  requireSession(dependencies, sessionId);
  const { after, limit } = paginationSchema.parse(query);
  return sessionHistorySchema.parse({
    protocolVersion: 1,
    sessionId,
    events: dependencies.events.after(sessionId, after).slice(0, limit),
  });
};

export const readDiagnostics = (
  dependencies: SnapshotDependencies,
  sessionId: string,
  query: unknown,
) => {
  requireSession(dependencies, sessionId);
  const { after, limit } = diagnosticPaginationSchema.parse(query);
  const all = dependencies.diagnostics.list(sessionId);
  const start = after === undefined ? 0 : Math.max(0, all.findIndex((diagnostic) => diagnostic.id === after) + 1);
  const diagnostics = all.slice(start, start + limit);
  return sessionDiagnosticsSchema.parse({
    protocolVersion: 1,
    sessionId,
    diagnostics,
    nextAfter: start + diagnostics.length < all.length ? diagnostics.at(-1)?.id : undefined,
  });
};
