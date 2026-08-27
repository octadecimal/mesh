import { afterEach, describe, expect, it } from 'vitest';

import {
  projectPlanBaseSchema,
  projectPlanSchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  workspaceSchema,
  type ProjectPlan,
  type ProjectPlanBase,
} from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';
import {
  PlanningRepository,
  type CreatePlanBaseInput,
} from './planning-repository.js';

const actor = (): ProjectPlan['createdBy'] =>
  taskActorSchema.parse({ type: 'human', id: 'operator-1' }) as ProjectPlan['createdBy'];

const project = (id = 'project-1') =>
  projectSchema.parse({
    id,
    displayName: id,
    repositoryPath: `C:/code/${id}`,
    discoveredAt: '2026-08-27T00:00:00.000Z',
    discoveryMetadata: {},
  });

const seedSession = (
  repos: ReturnType<typeof createTestRepositories>,
  projectId = 'project-1',
  sessionId = 'pm-session-1',
) => {
  repos.projects.create(project(projectId));
  repos.workspaces.create(
    workspaceSchema.parse({
      id: `${projectId}-workspace`,
      projectId,
      type: 'worktree',
      path: `C:/code/${projectId}-workspace`,
      gitBranch: `mesh/${projectId}`,
    }),
  );
  repos.sessions.create(
    sessionSchema.parse({
      id: sessionId,
      projectId,
      workspaceId: `${projectId}-workspace`,
      title: 'Plan the project',
      permissionMode: 'interactive',
      lifecycleState: 'running',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }),
  );
};

const plan = (
  overrides: Record<string, unknown> = {},
): ProjectPlan =>
  projectPlanSchema.parse({
    id: 'plan-1',
    projectId: 'project-1',
    goal: 'Persist a reviewable plan.',
    constraints: ['Use SQLite.'],
    nonGoals: ['Do not publish tasks.'],
    policyVersion: 'pm-v1',
    status: 'planning',
    revision: 1,
    currentBaseId: 'base-1',
    currentSessionId: 'pm-session-1',
    latestProposalOrdinal: 0,
    feedback: [],
    attention: null,
    createdBy: actor(),
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    terminalAt: null,
    terminalBy: null,
    terminalReason: null,
    ...overrides,
  });

const base = (
  overrides: Record<string, unknown> = {},
): ProjectPlanBase =>
  projectPlanBaseSchema.parse({
    id: 'base-1',
    planId: 'plan-1',
    ordinal: 1,
    repositoryIdentity: 'C:/code/project-1',
    tasks: [],
    dependencies: [],
    projectArchivedAt: null,
    projectRevision: 1,
    policyRevision: 1,
    createdAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  });

const nextBase = (): CreatePlanBaseInput => ({
  id: 'base-2',
  repositoryIdentity: 'C:/code/project-1',
  tasks: [],
  dependencies: [],
  projectArchivedAt: null,
  projectRevision: 2,
  policyRevision: 1,
  createdAt: '2026-08-27T00:01:00.000Z',
});

describe('PlanningRepository', () => {
  const repositories: Array<ReturnType<typeof createTestRepositories>> = [];

  afterEach(() => repositories.splice(0).forEach((repo) => repo.dispose()));

  it('creates an active planning cycle with an immutable first base and session', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedSession(repos);
    const repository = new PlanningRepository(repos.database);

    const created = repository.create({
      plan: plan(),
      base: base(),
      sessionId: 'pm-session-1',
    });

    expect(created).toEqual(plan());
    expect(repository.getDetails('plan-1')).toEqual({
      plan: plan(),
      bases: [base()],
      proposals: [],
      feedback: [],
    });
  });

  it('lets SQLite reject a second active plan for the project without changing the first', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedSession(repos);
    const repository = new PlanningRepository(repos.database);
    repository.create({ plan: plan(), base: base(), sessionId: 'pm-session-1' });

    expect(() =>
      repository.create({
        plan: plan({
          id: 'plan-2',
          currentBaseId: 'base-2',
          currentSessionId: null,
        }),
        base: base({ id: 'base-2', planId: 'plan-2' }),
        sessionId: 'pm-session-1',
      }),
    ).toThrow();
    expect(repository.get('plan-1')).toEqual(plan());
  });

  it('appends bases with monotonic ordinals and preserves prior serialized bases', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedSession(repos);
    const repository = new PlanningRepository(repos.database);
    const created = repository.create({
      plan: plan(),
      base: base(),
      sessionId: 'pm-session-1',
    });

    const appended = repository.appendBase(created.id, created.revision, nextBase());

    expect(appended).toEqual(base({ ...nextBase(), ordinal: 2 }));
    expect(repository.getDetails(created.id)?.bases).toEqual([
      base(),
      base({ ...nextBase(), ordinal: 2 }),
    ]);
    expect(repository.get(created.id)).toMatchObject({
      currentBaseId: 'base-2',
      revision: 2,
    });
  });

  it('increments session capability generations and rejects a stale plan revision', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedSession(repos);
    repos.workspaces.create(
      workspaceSchema.parse({
        id: 'project-1-workspace-2',
        projectId: 'project-1',
        type: 'worktree',
        path: 'C:/code/project-1-workspace-2',
        gitBranch: 'mesh/project-1-2',
      }),
    );
    repos.sessions.create(
      sessionSchema.parse({
        id: 'pm-session-2',
        projectId: 'project-1',
        workspaceId: 'project-1-workspace-2',
        title: 'Revise the plan',
        permissionMode: 'interactive',
        lifecycleState: 'running',
        createdAt: '2026-08-27T00:02:00.000Z',
        updatedAt: '2026-08-27T00:02:00.000Z',
      }),
    );
    const repository = new PlanningRepository(repos.database);
    repository.create({ plan: plan(), base: base(), sessionId: 'pm-session-1' });

    expect(() => repository.appendSession('plan-1', 2, 'pm-session-2')).toThrow(
      'Plan revision conflict',
    );
    expect(repository.appendSession('plan-1', 1, 'pm-session-2')).toMatchObject({
      currentSessionId: 'pm-session-2',
      revision: 2,
    });
    expect(
      repos.database
        .prepare('SELECT session_id, capability_generation FROM project_plan_sessions WHERE plan_id = ? ORDER BY capability_generation')
        .all('plan-1'),
    ).toEqual([
      { session_id: 'pm-session-1', capability_generation: 1 },
      { session_id: 'pm-session-2', capability_generation: 2 },
    ]);
  });

  it('preserves proposal and feedback order while reconstructing parsed details', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedSession(repos);
    const repository = new PlanningRepository(repos.database);
    repository.create({ plan: plan(), base: base(), sessionId: 'pm-session-1' });

    const first = repository.appendProposal({
      id: 'proposal-1',
      planId: 'plan-1',
      expectedRevision: 1,
      baseId: 'base-1',
      sessionId: 'pm-session-1',
      tasks: [
        {
          key: 'proposal-task-1',
          title: 'Add storage',
          description: 'Persist it.',
          acceptanceCriteria: ['It round-trips.'],
          priority: 'high',
          labels: ['storage'],
          rationale: 'The plan needs storage.',
          goalMapping: 'Durability.',
        },
      ],
      dependencies: [],
      assumptions: ['The database is available.'],
      risks: ['A stale board may invalidate this.'],
      exclusions: ['No publication.'],
      submittedAt: '2026-08-27T00:03:00.000Z',
    });
    const second = repository.appendProposal({
      id: 'proposal-2',
      planId: 'plan-1',
      expectedRevision: 2,
      baseId: 'base-1',
      sessionId: 'pm-session-1',
      tasks: [],
      dependencies: [],
      assumptions: [],
      risks: [],
      exclusions: [],
      submittedAt: '2026-08-27T00:04:00.000Z',
    });
    repository.appendFeedback({
      id: 'feedback-2',
      planId: 'plan-1',
      expectedRevision: 3,
      proposalId: second.id,
      content: 'Second feedback.',
      actor: actor(),
      createdAt: '2026-08-27T00:05:00.000Z',
    });
    repository.appendFeedback({
      id: 'feedback-1',
      planId: 'plan-1',
      expectedRevision: 4,
      proposalId: first.id,
      content: 'First feedback.',
      actor: actor(),
      createdAt: '2026-08-27T00:05:00.000Z',
    });

    expect([first.ordinal, second.ordinal]).toEqual([1, 2]);
    expect(repository.getDetails('plan-1')).toMatchObject({
      plan: { latestProposalOrdinal: 2 },
      proposals: [
        { id: 'proposal-1', ordinal: 1, tasks: [{ key: 'proposal-task-1' }] },
        { id: 'proposal-2', ordinal: 2 },
      ],
      feedback: [
        { id: 'feedback-1', content: 'First feedback.' },
        { id: 'feedback-2', content: 'Second feedback.' },
      ],
    });
  });

  it('updates only at the expected revision and records immutable approval mappings', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedSession(repos);
    repos.tasks.create(
      taskSchema.parse({
        id: 'task-1', projectId: 'project-1', title: 'Published task',
        description: 'This is canonical.', acceptanceCriteria: ['It exists.'],
        priority: 'normal', rank: 'a', lifecycleState: 'backlog', labels: [], notes: '',
        blocked: null, revision: 1, createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
      }),
    );
    const repository = new PlanningRepository(repos.database);
    repository.create({ plan: plan(), base: base(), sessionId: 'pm-session-1' });
    repository.appendProposal({
      id: 'proposal-1', planId: 'plan-1', expectedRevision: 1, baseId: 'base-1', sessionId: 'pm-session-1',
      tasks: [{ key: 'proposal-task-1', title: 'Publish task', description: 'Create it.', acceptanceCriteria: ['It exists.'], priority: 'normal', labels: [], rationale: 'Needed.', goalMapping: 'Goal.' }],
      dependencies: [], assumptions: [], risks: [], exclusions: [], submittedAt: '2026-08-27T00:03:00.000Z',
    });

    expect(repository.update('plan-1', 1, {
      status: 'approved', attention: null, updatedAt: '2026-08-27T00:04:00.000Z', terminalAt: '2026-08-27T00:04:00.000Z', terminalBy: actor(), terminalReason: 'Approved',
    })).toBeUndefined();
    const updated = repository.update('plan-1', 2, {
      status: 'approved', attention: null, updatedAt: '2026-08-27T00:04:00.000Z', terminalAt: '2026-08-27T00:04:00.000Z', terminalBy: actor(), terminalReason: 'Approved',
    });
    expect(updated).toMatchObject({ status: 'approved', revision: 3, terminalReason: 'Approved' });

    repository.recordApprovalMappings('plan-1', 'proposal-1', [{ proposalTaskKey: 'proposal-task-1', taskId: 'task-1', createdAt: '2026-08-27T00:04:00.000Z' }]);
    expect(
      repos.database
        .prepare('SELECT proposal_task_key, task_id FROM project_plan_task_mappings')
        .all(),
    ).toEqual([{ proposal_task_key: 'proposal-task-1', task_id: 'task-1' }]);
    expect(() => repository.recordApprovalMappings('plan-1', 'proposal-1', [{ proposalTaskKey: 'proposal-task-1', taskId: 'task-1', createdAt: '2026-08-27T00:04:00.000Z' }])).toThrow();
  });

  it('returns the active plan and terminal summaries in deterministic cursor order', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedSession(repos);
    const repository = new PlanningRepository(repos.database);
    repository.create({ plan: plan(), base: base(), sessionId: 'pm-session-1' });

    for (let index = 1; index <= 22; index += 1) {
      const id = `terminal-${String(index).padStart(2, '0')}`;
      const sessionId = `terminal-session-${String(index).padStart(2, '0')}`;
      const workspaceId = `terminal-workspace-${String(index).padStart(2, '0')}`;
      repos.workspaces.create(
        workspaceSchema.parse({
          id: workspaceId,
          projectId: 'project-1',
          type: 'worktree',
          path: `C:/code/${workspaceId}`,
          gitBranch: `mesh/${workspaceId}`,
        }),
      );
      repos.sessions.create(
        sessionSchema.parse({
          id: sessionId,
          projectId: 'project-1',
          workspaceId,
          title: 'Completed plan',
          permissionMode: 'interactive',
          lifecycleState: 'idle',
          createdAt: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
        }),
      );
      repository.create({
        plan: plan({ id, status: 'approved', currentBaseId: `base-${id}`, currentSessionId: null, createdAt: `2026-08-27T01:${String(index).padStart(2, '0')}:00.000Z`, updatedAt: `2026-08-27T01:${String(index).padStart(2, '0')}:00.000Z`, terminalAt: `2026-08-27T01:${String(index).padStart(2, '0')}:00.000Z`, terminalBy: actor(), terminalReason: 'Approved' }),
        base: base({ id: `base-${id}`, planId: id, createdAt: `2026-08-27T01:${String(index).padStart(2, '0')}:00.000Z` }),
        sessionId,
      });
    }

    expect(repository.getActiveByProject('project-1')?.id).toBe('plan-1');
    const first = repository.listSummaries('project-1', { limit: 20 });
    const second = repository.listSummaries('project-1', { before: first.at(-1)?.id, limit: 20 });
    expect(first.map((summary) => summary.id)).toEqual(Array.from({ length: 20 }, (_, offset) => `terminal-${String(22 - offset).padStart(2, '0')}`));
    expect(second.map((summary) => summary.id)).toEqual(['terminal-02', 'terminal-01']);
  });

  it('allows caller-owned transactions to roll back a partially composed base append', () => {
    const repos = createTestRepositories();
    repositories.push(repos);
    seedSession(repos);
    const repository = new PlanningRepository(repos.database);
    repository.create({ plan: plan(), base: base(), sessionId: 'pm-session-1' });

    repos.database.exec('BEGIN IMMEDIATE');
    try {
      expect(() => repository.appendBase('plan-1', 1, { ...nextBase(), id: 'base-1' })).toThrow();
    } finally {
      repos.database.exec('ROLLBACK');
    }

    expect(repository.get('plan-1')).toEqual(plan());
    expect(repository.getDetails('plan-1')?.bases).toEqual([base()]);
  });
});
