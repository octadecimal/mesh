import {
  projectPlanBaseSchema,
  projectPlanProposalInputSchema,
  projectPlanSchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  workspaceSchema,
  type ProjectPlan,
  type ProjectPlanStatus,
} from '@mesh-session-platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { PM_POLICY_VERSION } from '../domain/planning-policy.js';
import { createTestRepositories } from '../test/create-test-database.js';
import {
  PlanningCapabilityError,
  PlanningCapabilityRegistry,
} from './planning-capability-registry.js';
import { reconcileProjectPlans } from './reconcile-project-plans.js';

const now = '2026-08-27T12:00:00.000Z';
const recoveredAt = '2026-08-27T12:05:00.000Z';
const human = taskActorSchema.parse({
  type: 'human',
  id: 'operator-1',
  displayName: 'Operator',
}) as ProjectPlan['createdBy'];

type TestRepositories = ReturnType<typeof createTestRepositories>;

const proposal = projectPlanProposalInputSchema.parse({
  tasks: [
    {
      key: 'implementation',
      title: 'Implement the plan',
      description: 'Deliver the approved project outcome.',
      acceptanceCriteria: ['The planned outcome is verified.'],
      priority: 'high',
      labels: ['planning'],
      rationale: 'The project goal requires implementation.',
      goalMapping: 'This task delivers the project goal.',
    },
  ],
  dependencies: [],
  assumptions: [],
  risks: [],
  exclusions: [],
});

const disposals: Array<() => void> = [];

const required = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) throw new Error(message);
  return value;
};

const createPlan = (
  repositories: TestRepositories,
  id: string,
  options: {
    status?: ProjectPlanStatus;
    sessionState?: 'running' | 'interrupted' | 'completed' | 'failed';
    withProposal?: boolean;
  } = {},
): ProjectPlan => {
  const projectId = `project-${id}`;
  const workspaceId = `workspace-${id}`;
  const sessionId = `session-${id}`;
  const project = repositories.projects.create(
    projectSchema.parse({
      id: projectId,
      displayName: `Project ${id}`,
      repositoryPath: `C:/code/${projectId}`,
      repositoryIdentity: `repository-${id}`,
      discoveredAt: now,
      discoveryMetadata: {},
    }),
  );
  repositories.workspaces.create(
    workspaceSchema.parse({
      id: workspaceId,
      projectId,
      type: 'shared',
      path: project.repositoryPath,
      cleanupState: 'active',
    }),
  );
  repositories.sessions.create(
    sessionSchema.parse({
      id: sessionId,
      projectId,
      workspaceId,
      title: `Planning ${id}`,
      permissionMode: 'safe_auto',
      lifecycleState: options.sessionState ?? 'interrupted',
      createdAt: now,
      updatedAt: now,
    }),
  );
  const base = projectPlanBaseSchema.parse({
    id: `base-${id}`,
    planId: id,
    ordinal: 1,
    repositoryIdentity: project.repositoryIdentity,
    tasks: [],
    dependencies: [],
    projectArchivedAt: null,
    projectRevision: project.revision,
    policyRevision: project.qaConfiguration.revision,
    createdAt: now,
  });
  let plan = repositories.plans.create({
    plan: projectPlanSchema.parse({
      id,
      projectId,
      goal: `Plan ${id}`,
      constraints: [],
      nonGoals: [],
      policyVersion: PM_POLICY_VERSION,
      status: 'planning',
      revision: 1,
      currentBaseId: base.id,
      currentSessionId: sessionId,
      latestProposalOrdinal: 0,
      feedback: [],
      attention: null,
      createdBy: human,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
      terminalBy: null,
      terminalReason: null,
    }),
    base,
    sessionId,
  });

  if (options.withProposal) {
    repositories.plans.appendProposal({
      ...proposal,
      id: `proposal-${id}`,
      planId: id,
      expectedRevision: plan.revision,
      baseId: base.id,
      sessionId,
      submittedAt: now,
    });
    plan = required(
      repositories.plans.get(id),
      'Expected the proposal plan to remain available',
    );
  }

  const status = options.status ?? 'planning';
  if (status !== 'planning') {
    plan = required(
      repositories.plans.update(id, plan.revision, {
        status,
        attention:
          status === 'attention_required'
            ? { type: 'repair_required', message: 'Existing repair evidence.' }
            : null,
        updatedAt: now,
        terminalAt: ['approved', 'rejected', 'cancelled'].includes(status)
          ? now
          : null,
        terminalBy: ['approved', 'rejected', 'cancelled'].includes(status)
          ? human
          : null,
        terminalReason: ['approved', 'rejected', 'cancelled'].includes(status)
          ? 'Operator decision.'
          : null,
      }),
      'Expected the plan status update to succeed',
    );
  }
  return plan;
};

const arrange = (options?: Parameters<typeof createTestRepositories>[0]) => {
  const repositories = createTestRepositories(options);
  disposals.push(repositories.dispose);
  const capabilities = new PlanningCapabilityRegistry({
    now: () => new Date(now),
  });
  const reconcile = () =>
    reconcileProjectPlans({
      database: repositories.database,
      projects: repositories.projects,
      plans: repositories.plans,
      sessions: repositories.sessions,
      projectEvents: repositories.projectEvents,
      capabilities,
      now: () => recoveredAt,
    });
  return { capabilities, reconcile, repositories };
};

afterEach(() => {
  while (disposals.length > 0) disposals.pop()?.();
});

describe('reconcileProjectPlans', () => {
  it('preserves committed awaiting-review truth without a live PM session', () => {
    const { reconcile, repositories } = arrange();
    const review = createPlan(repositories, 'plan-review', {
      status: 'awaiting_review',
      sessionState: 'interrupted',
      withProposal: true,
    });

    const result = reconcile();

    expect(result).toEqual({ attentionPlanIds: [], events: [] });
    expect(repositories.plans.get(review.id)).toMatchObject({
      status: 'awaiting_review',
      latestProposalOrdinal: 1,
      attention: null,
    });
  });

  it.each(['planning', 'revising'] as const)(
    'moves formerly live %s work to durable attention without resuming runtime',
    (status) => {
      const { reconcile, repositories } = arrange();
      const plan = createPlan(repositories, `plan-${status}`, {
        status,
        sessionState: 'interrupted',
        withProposal: status === 'revising',
      });

      const result = reconcile();

      expect(result.attentionPlanIds).toEqual([plan.id]);
      expect(result.events).toHaveLength(1);
      expect(repositories.plans.get(plan.id)).toMatchObject({
        status: 'attention_required',
        attention: { type: 'session_unavailable' },
      });
      expect(result.events[0]).toMatchObject({
        projectId: plan.projectId,
        type: 'project.plan_changed',
        payload: {
          plan: { id: plan.id, status: 'attention_required' },
        },
      });
    },
  );

  it('lets a committed awaiting-review proposal win over stale runtime state', () => {
    const { reconcile, repositories } = arrange();
    const plan = createPlan(repositories, 'plan-proposed', {
      status: 'awaiting_review',
      sessionState: 'running',
      withProposal: true,
    });

    reconcile();

    expect(repositories.plans.get(plan.id)).toMatchObject({
      status: 'awaiting_review',
      latestProposalOrdinal: 1,
      attention: null,
    });
    expect(repositories.projectEvents.after(plan.projectId, 0)).toEqual([]);
  });

  it('never infers awaiting-review state from a proposal row alone', () => {
    const { reconcile, repositories } = arrange();
    const plan = createPlan(repositories, 'plan-stale-proposal', {
      sessionState: 'interrupted',
      withProposal: true,
    });

    reconcile();

    expect(repositories.plans.get(plan.id)).toMatchObject({
      status: 'attention_required',
      latestProposalOrdinal: 1,
    });
  });

  it.each([
    [
      'missing association',
      (repositories: TestRepositories, plan: ProjectPlan) => {
        repositories.database
          .prepare('DELETE FROM project_plan_sessions WHERE plan_id = ?')
          .run(plan.id);
      },
    ],
    [
      'mismatched current session',
      (repositories: TestRepositories, plan: ProjectPlan) => {
        repositories.sessions.create(
          sessionSchema.parse({
            id: `unassociated-${plan.id}`,
            projectId: plan.projectId,
            workspaceId: `workspace-${plan.id}`,
            title: 'Unassociated session',
            permissionMode: 'safe_auto',
            lifecycleState: 'interrupted',
            createdAt: now,
            updatedAt: now,
          }),
        );
        repositories.database
          .prepare(
            'UPDATE project_plans SET current_session_id = ? WHERE id = ?',
          )
          .run(`unassociated-${plan.id}`, plan.id);
      },
    ],
  ] as const)('persists repair evidence for a %s', (_case, corrupt) => {
    const { reconcile, repositories } = arrange();
    const plan = createPlan(repositories, `plan-${_case.replace(/ /g, '-')}`);
    corrupt(repositories, plan);

    const result = reconcile();

    expect(result.attentionPlanIds).toEqual([plan.id]);
    expect(repositories.plans.get(plan.id)).toMatchObject({
      status: 'attention_required',
      attention: { type: 'repair_required' },
    });
    expect(repositories.projectEvents.after(plan.projectId, 0)).toHaveLength(1);
  });

  it('leaves terminal and already-attention plans unchanged', () => {
    const { reconcile, repositories } = arrange();
    const terminal = createPlan(repositories, 'plan-approved', {
      status: 'approved',
      sessionState: 'completed',
      withProposal: true,
    });
    const attention = createPlan(repositories, 'plan-attention', {
      status: 'attention_required',
    });
    const before = repositories.plans.get(attention.id);

    expect(reconcile()).toEqual({ attentionPlanIds: [], events: [] });

    expect(repositories.plans.get(terminal.id)).toEqual(terminal);
    expect(repositories.plans.get(attention.id)).toEqual(before);
  });

  it('invalidates every ephemeral planning capability', async () => {
    const { capabilities, reconcile, repositories } = arrange();
    const plan = createPlan(repositories, 'plan-capability');
    const sessionId = required(
      plan.currentSessionId ?? undefined,
      'Expected a current planning session',
    );
    const token = capabilities.issue({
      planId: plan.id,
      planRevision: plan.revision,
      sessionId,
      baseId: plan.currentBaseId,
      policyVersion: plan.policyVersion,
      generation: 1,
      expiresAt: '2026-08-27T13:00:00.000Z',
    });

    reconcile();

    await expect(
      capabilities.submit({
        token,
        context: {
          planId: plan.id,
          planRevision: plan.revision,
          sessionId,
          baseId: plan.currentBaseId,
          policyVersion: plan.policyVersion,
          generation: 1,
        },
        proposal,
        accept: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(PlanningCapabilityError);
  });

  it('is idempotent when reconciliation is repeated', () => {
    const { reconcile, repositories } = arrange();
    const plan = createPlan(repositories, 'plan-idempotent');

    const first = reconcile();
    const second = reconcile();

    expect(first.attentionPlanIds).toEqual([plan.id]);
    expect(first.events).toHaveLength(1);
    expect(second).toEqual({ attentionPlanIds: [], events: [] });
    expect(repositories.projectEvents.after(plan.projectId, 0)).toHaveLength(1);
  });

  it('rolls back attention when the audit event cannot be inserted', () => {
    const { reconcile, repositories } = arrange({
      failProjectEventInsert: true,
    });
    const plan = createPlan(repositories, 'plan-audit-failure');

    expect(() => reconcile()).toThrow('project event insert failed');

    expect(repositories.plans.get(plan.id)).toEqual(plan);
    expect(repositories.projectEvents.after(plan.projectId, 0)).toEqual([]);
  });
});
