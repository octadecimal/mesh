import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import {
  V2_PROTOCOL_VERSION,
  planningCycleSchema,
  type V2CommandResult,
  type V2ProjectSnapshot,
  type V2SystemSnapshot,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createV2HttpApp } from './app';
import type { V2RouteDependencies } from './routes';
import { createV2Snapshots } from './snapshots';
import { inImmediateTransaction } from '../db/database';
import { AuditBarrier } from '../executions/audit-barrier';
import { ExecutionRepository } from '../executions/execution-repository';
import { auditAwareRepositoryIdentityResolver } from '../main';
import { PlanningRepository } from '../planning/planning-repository';
import { ProjectRepository } from '../projects/project-repository';
import { ProjectService } from '../projects/project-service';
import { WorkerProfileService } from '../profiles/profile-service';
import { createV2TestDatabase } from '../test/create-v2-test-database';

const projectId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const planningCycleId = '44444444-4444-4444-8444-444444444444';
const proposalId = '55555555-5555-4555-8555-555555555555';
const timestamp = '2026-08-28T00:00:00.000Z';

const systemSnapshot: V2SystemSnapshot = {
  protocolVersion: V2_PROTOCOL_VERSION,
  health: { status: 'ok' },
  projects: [],
  globalProfiles: [],
};

const projectSnapshot: V2ProjectSnapshot = {
  protocolVersion: V2_PROTOCOL_VERSION,
  project: {
    id: projectId,
    displayName: 'Todo',
    repositoryIdentity: 'todo.git',
    repositoryPath: 'C:/work/todo',
    gitCommonDirectory: 'C:/work/todo/.git',
    headCommit: 'a'.repeat(40),
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  profiles: [],
  executions: [],
  attentionItems: [],
  planningCycles: [],
  planningHistoryTruncated: false,
  intentLedger: null,
  cursors: { domain: 0, runtime: 0 },
};

const failed = (
  commandType: V2CommandResult['commandType'],
  message: string,
): V2CommandResult => ({
  ok: false,
  commandType,
  error: { code: 'invalid_request', message },
});

const createDependencies = (): V2RouteDependencies => ({
  allowedOrigins: new Set(['http://127.0.0.1:4300']),
  isAccepting: () => true,
  health: () => ({ status: 'ok' }),
  projects: {
    get: (id) => (id === projectId ? projectSnapshot.project : undefined),
    register: async () => failed('project.register', 'project route'),
  },
  profiles: {
    approveRevision: () =>
      failed('worker_profile.approve_revision', 'profile route'),
  },
  runtime: {
    start: async () => failed('worker_execution.start', 'start route'),
    interrupt: async () =>
      failed('worker_execution.interrupt', 'interrupt route'),
  },
  planning: {
    submitTurn: async () =>
      failed('planning_cycle.submit_turn', 'submit turn route'),
    approveProposal: () =>
      failed('planning_proposal.approve', 'approve proposal route'),
    rejectProposal: () =>
      failed('planning_proposal.reject', 'reject proposal route'),
    abandonCycle: async () =>
      failed('planning_cycle.abandon', 'abandon cycle route'),
  },
  snapshots: {
    system: () => systemSnapshot,
    project: (id) => (id === projectId ? projectSnapshot : undefined),
  },
  events: {
    domainAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
    runtimeAfter: () => ({ lowWater: 1, highWater: 0, events: [] }),
  },
});

const apps: Array<ReturnType<typeof createV2HttpApp>> = [];
const webRoots: string[] = [];
const createApp = (dependencies = createDependencies()) => {
  const app = createV2HttpApp(dependencies);
  apps.push(app);
  return app;
};

const gate = () => {
  let entered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => (entered = resolve)),
    release: new Promise<void>((resolve) => (release = resolve)),
    markEntered: entered,
    open: release,
  };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const webRoot of webRoots.splice(0)) {
    const resolved = resolve(webRoot);
    const fromTemp = relative(resolve(tmpdir()), resolved);
    if (
      fromTemp === '' ||
      fromTemp.startsWith('..') ||
      !resolved.includes('mesh-v2-web-root-test-')
    ) {
      throw new Error('Refusing to remove an unverified V2 web-root fixture');
    }
    rmSync(resolved, { force: true, recursive: true });
  }
});

describe('V2 HTTP routes', () => {
  it('rejects a non-loopback origin before command dispatch', async () => {
    const dependencies = createDependencies();
    const register = vi.spyOn(dependencies.projects, 'register');
    const response = await createApp(dependencies).inject({
      method: 'POST',
      url: '/api/v2/commands',
      headers: { origin: 'https://example.com' },
      payload: {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: { type: 'project.register', repositoryPath: 'todo' },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: 'invalid_origin', message: 'Origin is not allowed.' },
    });
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    ['project route', { type: 'project.register', repositoryPath: 'todo' }],
    [
      'profile route',
      {
        type: 'worker_profile.approve_revision',
        scope: 'global',
        sourceYaml: 'apiVersion: mesh.dev/v1alpha1',
        expectedLatestRevision: 0,
      },
    ],
    [
      'start route',
      {
        type: 'worker_execution.start',
        projectId,
        profileId,
        profileRevision: 1,
        assignment: {
          kind: 'foundation-check',
          projectId,
          title: 'Check Todo',
          instructions: 'Inspect the Todo fixture.',
          fakeScenario: 'todo-foundation-v1',
        },
      },
    ],
    [
      'interrupt route',
      {
        type: 'worker_execution.interrupt',
        projectId,
        executionId,
        expectedRevision: 1,
      },
    ],
    [
      'submit turn route',
      {
        type: 'planning_cycle.submit_turn',
        projectId,
        expectedCycleRevision: null,
        profileId,
        profileRevision: 1,
        message: 'Plan the Todo feature.',
      },
    ],
    [
      'approve proposal route',
      {
        type: 'planning_proposal.approve',
        projectId,
        planningCycleId,
        proposalId,
        expectedCycleRevision: 2,
        expectedProposalRevision: 1,
        expectedProjectIntentRevision: null,
        expectedLedgerRevision: null,
      },
    ],
    [
      'reject proposal route',
      {
        type: 'planning_proposal.reject',
        projectId,
        planningCycleId,
        proposalId,
        expectedCycleRevision: 2,
        expectedProposalRevision: 1,
        feedback: 'Narrow the acceptance criteria.',
      },
    ],
    [
      'abandon cycle route',
      {
        type: 'planning_cycle.abandon',
        projectId,
        planningCycleId,
        expectedCycleRevision: 2,
      },
    ],
  ])('dispatches the strict command to the %s', async (message, command) => {
    const response = await createApp().inject({
      method: 'POST',
      url: '/api/v2/commands',
      headers: { origin: 'http://127.0.0.1:4300' },
      payload: {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, error: { message } });
  });

  it('rejects invalid commands without dispatching', async () => {
    const response = await createApp().inject({
      method: 'POST',
      url: '/api/v2/commands',
      payload: {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'project.register',
          repositoryPath: 'todo',
          extra: true,
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'invalid_request', message: 'Request is invalid.' },
    });
  });

  it('rejects a non-human planning command without dispatching', async () => {
    const dependencies = createDependencies();
    const submitTurn = vi.spyOn(dependencies.planning, 'submitTurn');
    const response = await createApp(dependencies).inject({
      method: 'POST',
      url: '/api/v2/commands',
      payload: {
        idempotencyKey: randomUUID(),
        actor: { kind: 'runtime', executionId },
        command: {
          type: 'planning_cycle.submit_turn',
          projectId,
          expectedCycleRevision: null,
          profileId,
          profileRevision: 1,
          message: 'Plan the Todo feature.',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'invalid_request', message: 'Request is invalid.' },
    });
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it.each([
    'planning_canonical_base_conflict',
    'planning_cycle_active_conflict',
    'planning_cycle_history_limit',
    'planning_cycle_not_found',
    'planning_cycle_revision_conflict',
    'planning_profile_incompatible',
    'planning_proposal_invalid',
    'planning_proposal_not_found',
    'planning_proposal_revision_conflict',
  ] as const)(
    'keeps expected planning failure %s at HTTP 200',
    async (code) => {
      const dependencies = createDependencies();
      dependencies.planning.submitTurn = async () => ({
        ok: false,
        commandType: 'planning_cycle.submit_turn',
        error: { code, message: code },
      });
      const response = await createApp(dependencies).inject({
        method: 'POST',
        url: '/api/v2/commands',
        payload: {
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'planning_cycle.submit_turn',
            projectId,
            expectedCycleRevision: null,
            profileId,
            profileRevision: 1,
            message: 'Plan the Todo feature.',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: false, error: { code } });
    },
  );

  it('maps an unexpected planning failure to HTTP 500', async () => {
    const dependencies = createDependencies();
    dependencies.planning.submitTurn = async () => {
      throw new Error('unexpected planning failure');
    };
    const response = await createApp(dependencies).inject({
      method: 'POST',
      url: '/api/v2/commands',
      payload: {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.submit_turn',
          projectId,
          expectedCycleRevision: null,
          profileId,
          profileRevision: 1,
          message: 'Plan the Todo feature.',
        },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error.' },
    });
  });

  it('serves strict system and project snapshots', async () => {
    const app = createApp();

    const [system, project] = await Promise.all([
      app.inject({ url: '/api/v2/snapshot' }),
      app.inject({ url: `/api/v2/projects/${projectId}/snapshot` }),
    ]);

    expect(system.statusCode).toBe(200);
    expect(system.json()).toEqual(systemSnapshot);
    expect(project.statusCode).toBe(200);
    expect(project.json()).toEqual(projectSnapshot);
  });

  it('maps an unknown project to a stable error', async () => {
    const response = await createApp().inject({
      url: `/api/v2/projects/${randomUUID()}/snapshot`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'project_not_found', message: 'Project was not found.' },
    });
  });

  it.each(['domain', 'runtime'])(
    'returns the retained %s replay',
    async (stream) => {
      const response = await createApp().inject({
        url: `/api/v2/projects/${projectId}/events?stream=${stream}&after=0`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        lowWater: 1,
        highWater: 0,
        events: [],
      });
    },
  );

  it('returns resync-required for a cursor outside retained history', async () => {
    const dependencies = createDependencies();
    dependencies.events.domainAfter = () => ({
      lowWater: 4,
      highWater: 5,
      events: [],
    });
    const response = await createApp(dependencies).inject({
      url: `/api/v2/projects/${projectId}/events?stream=domain&after=1`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      type: 'v2.resync_required',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      reason: 'retained_gap',
    });
  });

  it('rejects mutations after stop-accepting begins', async () => {
    const dependencies = createDependencies();
    dependencies.isAccepting = () => false;
    const response = await createApp(dependencies).inject({
      method: 'POST',
      url: '/api/v2/commands',
      payload: {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: { type: 'project.register', repositoryPath: 'todo' },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: 'internal_error', message: 'Server is stopping.' },
    });
  });

  it('rejects mutations when the audit barrier is tripped', async () => {
    const dependencies = createDependencies();
    dependencies.health = () => ({
      status: 'audit_barrier_tripped',
      error: {
        code: 'audit_barrier_tripped',
        message: 'Audit persistence failed.',
      },
    });
    const response = await createApp(dependencies).inject({
      method: 'POST',
      url: '/api/v2/commands',
      payload: {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: { type: 'project.register', repositoryPath: 'todo' },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'audit_barrier_tripped',
        message: 'Audit persistence failed.',
      },
    });
  });

  it('rechecks the audit barrier after repository identity resolution', async () => {
    const fixture = createV2TestDatabase();
    try {
      const identityGate = gate();
      const barrier = new AuditBarrier();
      const projects = new ProjectRepository(fixture.database);
      const newProjectId = randomUUID();
      const idempotencyKey = randomUUID();
      const beforeProjects = projects.list();
      const service = new ProjectService({
        database: fixture.database,
        projects,
        commands: fixture.commands,
        events: fixture.events,
        projectId: () => newProjectId,
        resolveRepositoryIdentity: auditAwareRepositoryIdentityResolver(
          async () => {
            identityGate.markEntered();
            await identityGate.release;
            return {
              repositoryIdentity: 'delayed-repository',
              canonicalPath: fixture.directory,
              commonDirectory: fixture.directory,
              headCommit: 'c'.repeat(40),
            };
          },
          barrier,
        ),
      });
      const dependencies = createDependencies();
      dependencies.projects = service;
      const pending = createApp(dependencies).inject({
        method: 'POST',
        url: '/api/v2/commands',
        payload: {
          idempotencyKey,
          actor: { kind: 'human' },
          command: {
            type: 'project.register',
            repositoryPath: fixture.directory,
          },
        },
      });

      await identityGate.entered;
      barrier.trip(new Error('audit failed during identity lookup'), timestamp);
      identityGate.open();
      const response = await pending;

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          code: 'audit_barrier_tripped',
          message: 'Audit persistence is unavailable.',
        },
      });
      expect(projects.list()).toEqual(beforeProjects);
      expect(fixture.events.cursors(newProjectId)).toEqual({
        domain: 0,
        runtime: 0,
      });
      expect(fixture.commands.find(idempotencyKey)).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it('does not expose a V1 /api route', async () => {
    expect((await createApp().inject({ url: '/api' })).statusCode).toBe(404);
  });

  it('serves the V2 SPA for direct project-route reloads without masking APIs', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'mesh-v2-web-root-test-'));
    webRoots.push(webRoot);
    writeFileSync(join(webRoot, 'index.html'), '<h1>V2 SPA marker</h1>');
    const app = createV2HttpApp(createDependencies(), { webRoot });
    apps.push(app);

    const [projectRoute, apiRoute] = await Promise.all([
      app.inject({ url: `/projects/${projectId}` }),
      app.inject({ url: '/api' }),
    ]);

    expect(projectRoute.statusCode).toBe(200);
    expect(projectRoute.body).toContain('V2 SPA marker');
    expect(apiRoute.statusCode).toBe(404);
  });
});

describe('V2 snapshots', () => {
  it('maps accepted services into global and project snapshot contracts', () => {
    const fixture = createV2TestDatabase();
    try {
      const projects = new ProjectRepository(fixture.database);
      const profiles = new WorkerProfileService({
        database: fixture.database,
        commands: fixture.commands,
        events: fixture.events,
        projects: { exists: (id) => projects.get(id) !== undefined },
        publishDomain: () => undefined,
        now: () => timestamp,
      });
      const snapshots = createV2Snapshots({
        projects,
        profiles,
        executions: new ExecutionRepository(fixture.database),
        planning: new PlanningRepository(fixture.database),
        events: fixture.events,
        barrier: new AuditBarrier(),
      });

      expect(snapshots.system().globalProfiles).toEqual([
        {
          profileId: fixture.profileRevision.profileId,
          projectId: null,
          scope: 'global',
          name: 'foundation-worker',
          displayName: 'Foundation worker',
          approvedRevision: 1,
        },
        {
          profileId: fixture.pmProfileRevision.profileId,
          projectId: null,
          scope: 'global',
          name: 'project-manager',
          displayName: 'Project manager',
          approvedRevision: 1,
        },
      ]);
      expect(snapshots.project(fixture.project.id)).toMatchObject({
        project: fixture.project,
        profiles: [
          {
            profileId: fixture.profileRevision.profileId,
            profileRevision: 1,
          },
          {
            profileId: fixture.pmProfileRevision.profileId,
            profileRevision: 1,
          },
        ],
        executions: [{ id: fixture.execution.id }],
        attentionItems: [],
        planningCycles: [],
        planningHistoryTruncated: false,
        intentLedger: null,
        cursors: { domain: 0, runtime: 0 },
      });
    } finally {
      fixture.close();
    }
  });

  it('returns one open cycle and the latest 19 terminal cycles with truncation', () => {
    const fixture = createV2TestDatabase();
    try {
      const planning = new PlanningRepository(fixture.database);
      inImmediateTransaction(fixture.database, () => {
        for (let index = 0; index < 20; index += 1) {
          const occurredAt = `2026-08-28T00:00:${String(index).padStart(2, '0')}.000Z`;
          planning.insertCycleInTransaction(
            planningCycleSchema.parse({
              id: randomUUID(),
              projectId: fixture.project.id,
              lifecycle: 'abandoned',
              revision: 1,
              profileId: fixture.pmProfileRevision.profileId,
              profileRevision: fixture.pmProfileRevision.revision,
              baseProjectIntentRevision: null,
              baseLedgerRevision: null,
              latestProposalRevision: 0,
              activeExecutionId: null,
              createdAt: occurredAt,
              updatedAt: occurredAt,
              endedAt: occurredAt,
            }),
          );
        }
        planning.insertCycleInTransaction(
          planningCycleSchema.parse({
            id: planningCycleId,
            projectId: fixture.project.id,
            lifecycle: 'execution_active',
            revision: 1,
            profileId: fixture.pmProfileRevision.profileId,
            profileRevision: fixture.pmProfileRevision.revision,
            baseProjectIntentRevision: null,
            baseLedgerRevision: null,
            latestProposalRevision: 0,
            activeExecutionId: fixture.execution.id,
            createdAt: timestamp,
            updatedAt: timestamp,
            endedAt: null,
          }),
        );
        planning.insertTurnInTransaction({
          id: randomUUID(),
          projectId: fixture.project.id,
          planningCycleId,
          ordinal: 1,
          actor: 'human',
          message: 'Plan Todo.',
          launchState: 'execution_bound',
          executionId: fixture.execution.id,
          createdAt: timestamp,
        });
      });
      const snapshots = createV2Snapshots({
        projects: new ProjectRepository(fixture.database),
        profiles: new WorkerProfileService({
          database: fixture.database,
          commands: fixture.commands,
          events: fixture.events,
          projects: { exists: () => true },
          publishDomain: () => undefined,
          now: () => timestamp,
        }),
        executions: new ExecutionRepository(fixture.database),
        planning,
        events: fixture.events,
        barrier: new AuditBarrier(),
      });

      const snapshot = snapshots.project(fixture.project.id)!;
      expect(snapshot.planningCycles).toHaveLength(20);
      expect(snapshot.planningCycles[0]?.cycle.id).toBe(planningCycleId);
      expect(
        snapshot.planningCycles.filter(
          ({ cycle }) => cycle.lifecycle === 'abandoned',
        ),
      ).toHaveLength(19);
      expect(snapshot.planningHistoryTruncated).toBe(true);
      expect(snapshot.intentLedger).toBeNull();
    } finally {
      fixture.close();
    }
  });
});
