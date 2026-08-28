import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  idSchema,
  projectPlanDetailsSchema,
  projectPlanHistoryPageSchema,
} from '@mesh-session-platform/contracts';

import { executeCommand, type CommandDependencies } from './command-handler.js';
import { CommandError, toHttpError } from './errors.js';
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

const planHistoryQuerySchema = z.object({ before: idSchema.optional() });

const requireProject = (dependencies: HttpDependencies, projectId: string) => {
  const project = dependencies.projects.get(projectId);
  if (!project) {
    throw new CommandError(
      'project_not_found',
      `Project '${projectId}' was not found`,
    );
  }
  return project;
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

  app.get('/api/projects/:projectId/plans', async (request, reply) => {
    try {
      const { projectId } = request.params as { projectId: string };
      requireProject(dependencies, projectId);
      const query = planHistoryQuerySchema.parse(request.query);
      const plans = dependencies.plans.listSummaries(projectId, {
        before: query.before,
        limit: 20,
      });
      return projectPlanHistoryPageSchema.parse({
        plans,
        nextAfter: plans.length === 20 ? plans.at(-1)?.id : undefined,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(
    '/api/projects/:projectId/plans/:planId',
    async (request, reply) => {
      try {
        const { projectId, planId } = request.params as {
          projectId: string;
          planId: string;
        };
        requireProject(dependencies, projectId);
        const details = dependencies.plans.getDetails(planId);
        if (!details || details.plan.projectId !== projectId) {
          throw new CommandError(
            'project_plan_not_found',
            `Project plan '${planId}' was not found`,
          );
        }
        return projectPlanDetailsSchema.parse(details);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
};
