import type {
  ProjectEvent,
  ProjectPlan,
  ProjectPlanAttention,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type { PlanningRepository } from '../repositories/planning-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { PlanningCapabilityRegistry } from './planning-capability-registry.js';

export type ReconcileProjectPlansDependencies = {
  database: Database;
  projects: Pick<ProjectRepository, 'list'>;
  plans: Pick<
    PlanningRepository,
    'getActiveByProject' | 'getDetails' | 'getSessionAssociation' | 'update'
  >;
  sessions: Pick<SessionRepository, 'get'>;
  projectEvents: Pick<ProjectEventRepository, 'appendInTransaction'>;
  capabilities: Pick<PlanningCapabilityRegistry, 'clear' | 'invalidateSession'>;
  stoppedSessionId?: string;
  now?: () => string;
};

export type ReconcileProjectPlansResult = {
  attentionPlanIds: string[];
  events: ProjectEvent[];
};

const liveSessionStates = new Set([
  'starting',
  'running',
  'waiting_for_approval',
  'interrupting',
]);

const currentProposalIsCommitted = (
  dependencies: ReconcileProjectPlansDependencies,
  plan: ProjectPlan,
): boolean => {
  const details = dependencies.plans.getDetails(plan.id);
  if (!details || plan.latestProposalOrdinal < 1) return false;
  return details.proposals.some(
    ({ ordinal }) => ordinal === plan.latestProposalOrdinal,
  );
};

const requiredAttention = (
  dependencies: ReconcileProjectPlansDependencies,
  plan: ProjectPlan,
): ProjectPlanAttention | undefined => {
  if (plan.status === 'awaiting_review') {
    return currentProposalIsCommitted(dependencies, plan)
      ? undefined
      : {
          type: 'repair_required',
          message: 'Awaiting-review planning state has no committed proposal.',
        };
  }
  if (plan.status !== 'planning' && plan.status !== 'revising') {
    return undefined;
  }
  if (!plan.currentSessionId) {
    return {
      type: 'repair_required',
      message: 'Active planning state has no current session.',
    };
  }

  const association = dependencies.plans.getSessionAssociation(
    plan.id,
    plan.currentSessionId,
  );
  const session = dependencies.sessions.get(plan.currentSessionId);
  if (
    !association ||
    association.planId !== plan.id ||
    association.projectId !== plan.projectId ||
    association.sessionId !== plan.currentSessionId ||
    association.endedAt !== null ||
    !session ||
    session.projectId !== plan.projectId
  ) {
    return {
      type: 'repair_required',
      message:
        'Active planning session association is missing or inconsistent.',
    };
  }
  if (liveSessionStates.has(session.lifecycleState)) {
    return {
      type: 'repair_required',
      message: 'Planning reconciliation observed an unrecovered live session.',
    };
  }
  return {
    type: 'session_unavailable',
    message: 'The planning session is no longer live after recovery.',
  };
};

const reconcileCommittedPlanningTruth = (
  dependencies: ReconcileProjectPlansDependencies,
): ReconcileProjectPlansResult => {
  const attentionPlanIds: string[] = [];
  const events: ProjectEvent[] = [];
  const occurredAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const plans = dependencies.projects
    .list()
    .flatMap((project) => {
      const plan = dependencies.plans.getActiveByProject(project.id);
      return plan ? [plan] : [];
    })
    .filter(
      (plan) =>
        !dependencies.stoppedSessionId ||
        plan.currentSessionId === dependencies.stoppedSessionId,
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const plan of plans) {
    const attention = requiredAttention(dependencies, plan);
    if (!attention) continue;
    const repaired = dependencies.plans.update(plan.id, plan.revision, {
      status: 'attention_required',
      attention,
      updatedAt: occurredAt,
      terminalAt: null,
      terminalBy: null,
      terminalReason: null,
    });
    if (!repaired) {
      throw new Error(`Planning reconciliation conflicted for '${plan.id}'.`);
    }
    const event = dependencies.projectEvents.appendInTransaction(
      repaired.projectId,
      {
        protocolVersion: 1,
        id: `project-plan-reconcile-${repaired.id}-${repaired.revision}`,
        projectId: repaired.projectId,
        occurredAt,
        type: 'project.plan_changed',
        payload: { plan: repaired },
      },
    );
    attentionPlanIds.push(repaired.id);
    events.push(event);
  }

  return { attentionPlanIds, events };
};

export const reconcileProjectPlans = (
  dependencies: ReconcileProjectPlansDependencies,
): ReconcileProjectPlansResult => {
  if (dependencies.stoppedSessionId) {
    dependencies.capabilities.invalidateSession(dependencies.stoppedSessionId);
  } else {
    dependencies.capabilities.clear();
  }
  return dependencies.database.transaction(() =>
    reconcileCommittedPlanningTruth(dependencies),
  )();
};
