import type { FastifyInstance, FastifyReply } from 'fastify';

import { executeCommand, type CommandDependencies } from './command-handler.js';
import { toHttpError } from './errors.js';
import {
  buildProjectSnapshot,
  readProjectHistory,
  type ProjectSnapshotDependencies,
} from './project-snapshots.js';
import {
  buildSnapshot,
  readDiagnostics,
  readHistory,
  type SnapshotDependencies,
} from './snapshots.js';

export type HttpDependencies = CommandDependencies &
  SnapshotDependencies &
  ProjectSnapshotDependencies;

const sendError = (reply: FastifyReply, error: unknown) => {
  const mapped = toHttpError(error);
  return reply.code(mapped.statusCode).send(mapped.body);
};

export const registerRoutes = (
  app: FastifyInstance,
  dependencies: HttpDependencies,
): void => {
  app.post('/api/commands', async (request, reply) => {
    try {
      return await executeCommand(request.body, dependencies);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/snapshot', async (_request, reply) => {
    try {
      return buildSnapshot(dependencies);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/sessions/:id/events', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return readHistory(dependencies, id, request.query);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/sessions/:id/diagnostics', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return readDiagnostics(dependencies, id, request.query);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/projects/:projectId/snapshot', async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      return buildProjectSnapshot(dependencies, projectId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/projects/:projectId/history', async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      return readProjectHistory(dependencies, projectId, request.query);
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
