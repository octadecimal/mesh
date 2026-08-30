import {
  V2_PROTOCOL_VERSION,
  abandonPlanningCycleEnvelopeSchema,
  approvePlanningProposalEnvelopeSchema,
  interruptExecutionEnvelopeSchema,
  projectIdSchema,
  projectRegisterEnvelopeSchema,
  profileApprovalEnvelopeSchema,
  rejectPlanningProposalEnvelopeSchema,
  startExecutionEnvelopeSchema,
  submitPlanningTurnEnvelopeSchema,
  v2CommandEnvelopeSchema,
  v2ErrorCodeSchema,
  type RetainedDomainWindow,
  type RetainedRuntimeWindow,
  type V2Health,
  type V2ProjectSnapshot,
  type V2SystemSnapshot,
} from '@mesh/v2-contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ExecutionRuntime } from '../executions/execution-runtime.js';
import type { PlanningService } from '../planning/planning-service.js';
import type { ProjectService } from '../projects/project-service.js';
import type { WorkerProfileService } from '../profiles/profile-service.js';

type EventReader = {
  domainAfter(projectId: string, after: number): RetainedDomainWindow;
  runtimeAfter(projectId: string, after: number): RetainedRuntimeWindow;
};

export type V2RouteDependencies = {
  allowedOrigins: ReadonlySet<string>;
  isAccepting(): boolean;
  health(): V2Health;
  projects: Pick<ProjectService, 'get' | 'register'>;
  profiles: Pick<WorkerProfileService, 'approveRevision'>;
  runtime: Pick<ExecutionRuntime, 'start' | 'interrupt'>;
  planning: Pick<
    PlanningService,
    'submitTurn' | 'approveProposal' | 'rejectProposal' | 'abandonCycle'
  >;
  snapshots: {
    system(): V2SystemSnapshot;
    project(projectId: string): V2ProjectSnapshot | undefined;
  };
  events: EventReader;
};

const errorBody = (
  code: z.infer<typeof v2ErrorCodeSchema>,
  message: string,
) => ({
  error: { code, message },
});

const statusFor = (code: z.infer<typeof v2ErrorCodeSchema>) => {
  if (code === 'invalid_origin') return 403;
  if (code.endsWith('_not_found')) return 404;
  if (code === 'audit_barrier_tripped' || code === 'adapter_unavailable')
    return 503;
  if (code.includes('conflict')) return 409;
  if (code === 'internal_error') return 500;
  return 400;
};

const localOrigin = (
  request: FastifyRequest,
  dependencies: V2RouteDependencies,
) => {
  const origin = request.headers.origin;
  return origin === undefined || dependencies.allowedOrigins.has(origin);
};

const replayQuerySchema = z.strictObject({
  stream: z.enum(['domain', 'runtime']),
  after: z.coerce.number().int().nonnegative(),
});

export const registerV2Routes = (
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply
        .status(400)
        .send(errorBody('invalid_request', 'Request is invalid.'));
    }
    const parsedCode = v2ErrorCodeSchema.safeParse(
      (error as { code?: unknown }).code,
    );
    if (parsedCode.success) {
      return reply
        .status(statusFor(parsedCode.data))
        .send(
          errorBody(
            parsedCode.data,
            error instanceof Error ? error.message : String(error),
          ),
        );
    }
    return reply
      .status(500)
      .send(errorBody('internal_error', 'Internal server error.'));
  });

  app.get('/api/v2/health', () => dependencies.health());
  app.get('/api/v2/snapshot', () => dependencies.snapshots.system());
  app.get('/api/v2/projects/:projectId/snapshot', (request, reply) => {
    const { projectId } = z
      .strictObject({ projectId: projectIdSchema })
      .parse(request.params);
    const snapshot = dependencies.snapshots.project(projectId);
    return snapshot
      ? reply.send(snapshot)
      : reply
          .status(404)
          .send(errorBody('project_not_found', 'Project was not found.'));
  });

  app.get('/api/v2/projects/:projectId/events', (request, reply) => {
    const { projectId } = z
      .strictObject({ projectId: projectIdSchema })
      .parse(request.params);
    if (!dependencies.projects.get(projectId)) {
      return reply
        .status(404)
        .send(errorBody('project_not_found', 'Project was not found.'));
    }
    const { stream, after } = replayQuerySchema.parse(request.query);
    const window =
      stream === 'domain'
        ? dependencies.events.domainAfter(projectId, after)
        : dependencies.events.runtimeAfter(projectId, after);
    if (after < window.lowWater - 1 || after > window.highWater) {
      return reply.status(409).send({
        type: 'v2.resync_required',
        protocolVersion: V2_PROTOCOL_VERSION,
        projectId,
        reason: 'retained_gap',
      });
    }
    return reply.send(window);
  });

  app.post('/api/v2/commands', async (request, reply) => {
    if (!dependencies.isAccepting()) {
      return reply
        .status(503)
        .send(errorBody('internal_error', 'Server is stopping.'));
    }
    const health = dependencies.health();
    if (health.status === 'audit_barrier_tripped') {
      return reply.status(503).send({ error: health.error });
    }
    if (!localOrigin(request, dependencies)) {
      return reply
        .status(403)
        .send(errorBody('invalid_origin', 'Origin is not allowed.'));
    }
    const envelope = v2CommandEnvelopeSchema.parse(request.body);
    switch (envelope.command.type) {
      case 'project.register':
        return reply.send(
          await dependencies.projects.register(
            projectRegisterEnvelopeSchema.parse(envelope),
          ),
        );
      case 'worker_profile.approve_revision':
        return reply.send(
          dependencies.profiles.approveRevision(
            profileApprovalEnvelopeSchema.parse(envelope),
          ),
        );
      case 'worker_execution.start':
        return reply.send(
          await dependencies.runtime.start(
            startExecutionEnvelopeSchema.parse(envelope),
          ),
        );
      case 'worker_execution.interrupt':
        return reply.send(
          await dependencies.runtime.interrupt(
            interruptExecutionEnvelopeSchema.parse(envelope),
          ),
        );
      case 'planning_cycle.submit_turn':
        return reply.send(
          await dependencies.planning.submitTurn(
            submitPlanningTurnEnvelopeSchema.parse(envelope),
          ),
        );
      case 'planning_proposal.approve':
        return reply.send(
          dependencies.planning.approveProposal(
            approvePlanningProposalEnvelopeSchema.parse(envelope),
          ),
        );
      case 'planning_proposal.reject':
        return reply.send(
          dependencies.planning.rejectProposal(
            rejectPlanningProposalEnvelopeSchema.parse(envelope),
          ),
        );
      case 'planning_cycle.abandon':
        return reply.send(
          await dependencies.planning.abandonCycle(
            abandonPlanningCycleEnvelopeSchema.parse(envelope),
          ),
        );
    }
  });
};
