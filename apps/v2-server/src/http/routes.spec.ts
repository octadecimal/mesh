import { randomUUID } from 'node:crypto';

import {
  V2_PROTOCOL_VERSION,
  type V2CommandResult,
  type V2ProjectSnapshot,
  type V2SystemSnapshot,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createV2HttpApp } from './app';
import type { V2RouteDependencies } from './routes';
import { createV2Snapshots } from './snapshots';
import { AuditBarrier } from '../executions/audit-barrier';
import { ExecutionRepository } from '../executions/execution-repository';
import { ProjectRepository } from '../projects/project-repository';
import { WorkerProfileService } from '../profiles/profile-service';
import { createV2TestDatabase } from '../test/create-v2-test-database';

const projectId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
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
const createApp = (dependencies = createDependencies()) => {
  const app = createV2HttpApp(dependencies);
  apps.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
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

  it('does not expose a V1 /api route', async () => {
    expect((await createApp().inject({ url: '/api' })).statusCode).toBe(404);
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
      ]);
      expect(snapshots.project(fixture.project.id)).toMatchObject({
        project: fixture.project,
        profiles: [
          {
            profileId: fixture.profileRevision.profileId,
            profileRevision: 1,
          },
        ],
        executions: [{ id: fixture.execution.id }],
        attentionItems: [],
        cursors: { domain: 0, runtime: 0 },
      });
    } finally {
      fixture.close();
    }
  });
});
