import {
  V2_PROTOCOL_VERSION,
  v2ProjectSnapshotSchema,
  v2SystemSnapshotSchema,
  type Project,
  type V2AttentionItem,
  type V2Health,
  type WorkerProfileRevision,
} from '@mesh/v2-contracts';
import { z } from 'zod';

import type { AuditBarrier } from '../executions/audit-barrier.js';
import type {
  ExecutionAttentionDetail,
  ExecutionRepository,
} from '../executions/execution-repository.js';
import type { WorkerProfileService } from '../profiles/profile-service.js';
import type { PlanningRepository } from '../planning/planning-repository.js';
import type { V2EventStore } from '../storage/event-store.js';
import type { DeveloperRepository } from '../developer/developer-repository.js';

type ProjectReader = {
  list(): Project[];
  get(projectId: string): Project | undefined;
};

export type V2SnapshotDependencies = {
  projects: ProjectReader;
  profiles: Pick<
    WorkerProfileService,
    'approvedGlobal' | 'approvedForProject' | 'resolveApproved'
  >;
  executions: Pick<ExecutionRepository, 'list' | 'listAttentionDetails'>;
  developers: Pick<
    DeveloperRepository,
    'attemptsForProject' | 'reportsForProject'
  >;
  planning: Pick<PlanningRepository, 'planningSnapshot'>;
  events: Pick<V2EventStore, 'cursors'>;
  barrier: Pick<AuditBarrier, 'health'>;
};

const health = (barrier: Pick<AuditBarrier, 'health'>): V2Health => {
  const current = barrier.health();
  if (current.status === 'healthy') return { status: 'ok' };
  return {
    status: 'audit_barrier_tripped',
    error: {
      code: 'audit_barrier_tripped',
      message:
        current.diagnostics.at(-1)?.message ??
        'Audit persistence is unavailable.',
    },
  };
};

const summary = (profile: WorkerProfileRevision) => ({
  profileId: profile.profileId,
  projectId: profile.projectId,
  scope: profile.scope,
  name: profile.name,
  displayName: profile.displayName,
  approvedRevision: profile.revision,
});

const reconciliationAttentionSchema = z
  .object({
    kind: z.literal('mesh.v2.reconciliation-probe/v1'),
    operationId: z.string().uuid(),
    probe: z.object({
      status: z.enum(['missing', 'unknown']),
      reason: z.string().trim().min(1).max(1024),
    }),
  })
  .passthrough();

const evidenceMessage = (detail: ExecutionAttentionDetail): string => {
  const payload = detail.evidence.at(-1)?.payload;
  const reconciliation = reconciliationAttentionSchema.safeParse(payload);
  if (reconciliation.success) {
    return `${reconciliation.data.operationId}: ${reconciliation.data.probe.reason}`;
  }
  if (typeof payload === 'object' && payload !== null) {
    const value = payload as Record<string, unknown>;
    for (const key of ['recoveryError', 'reason']) {
      if (typeof value[key] === 'string' && value[key].length > 0) {
        return value[key];
      }
    }
  }
  return 'Execution requires operator attention.';
};

const attentionItem = (detail: ExecutionAttentionDetail): V2AttentionItem => ({
  executionId: detail.execution.id,
  code: detail.execution.failure?.code ?? 'internal_error',
  message: detail.execution.failure?.message ?? evidenceMessage(detail),
});

export const createV2Snapshots = (dependencies: V2SnapshotDependencies) => ({
  system: () =>
    v2SystemSnapshotSchema.parse({
      protocolVersion: V2_PROTOCOL_VERSION,
      health: health(dependencies.barrier),
      projects: dependencies.projects.list(),
      globalProfiles: dependencies.profiles.approvedGlobal().map(summary),
    }),
  project: (projectId: string) => {
    const project = dependencies.projects.get(projectId);
    if (!project) return undefined;
    const profiles = [
      ...dependencies.profiles.approvedGlobal(),
      ...dependencies.profiles.approvedForProject(projectId),
    ].map((profile) =>
      dependencies.profiles.resolveApproved(
        profile.profileId,
        profile.revision,
      ),
    );
    return v2ProjectSnapshotSchema.parse({
      protocolVersion: V2_PROTOCOL_VERSION,
      project,
      profiles,
      executions: dependencies.executions.list(projectId),
      developerAttempts: dependencies.developers.attemptsForProject(projectId),
      developerReports: dependencies.developers.reportsForProject(projectId),
      attentionItems: dependencies.executions
        .listAttentionDetails(projectId)
        .map(attentionItem),
      ...dependencies.planning.planningSnapshot(projectId),
      cursors: dependencies.events.cursors(projectId),
    });
  },
});
