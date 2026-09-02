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
import { DeveloperRepository } from '../developer/developer-repository';
import {
  ExecutionRepository,
  type ExecutionAttentionDetail,
} from '../executions/execution-repository';
import { auditAwareRepositoryIdentityResolver } from '../main';
import { PlanningRepository } from '../planning/planning-repository';
import { ProjectRepository } from '../projects/project-repository';
import { ProjectService } from '../projects/project-service';
import { WorkerProfileService } from '../profiles/profile-service';
import { V2IdempotencyConflictError } from '../storage/command-repository';
import { createV2TestDatabase } from '../test/create-v2-test-database';

const projectId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const attemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const deliveryPlanId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const planningCycleId = '44444444-4444-4444-8444-444444444444';
const proposalId = '55555555-5555-4555-8555-555555555555';
const projectIntentId = '66666666-6666-4666-8666-666666666666';
const ledgerId = '77777777-7777-4777-8777-777777777777';
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
  developer: {
    start: async () =>
      failed('developer_attempt.start', 'developer start route'),
    interrupt: async () =>
      failed('developer_attempt.interrupt', 'developer interrupt route'),
    replaceExecution: async () =>
      failed(
        'developer_attempt.replace_execution',
        'developer replacement route',
      ),
  },
  runs: {
    start: async () => failed('execution_run.start', 'run start route'),
    pause: async () => failed('execution_run.pause', 'run pause route'),
    resume: async () => failed('execution_run.resume', 'run resume route'),
    stop: async () => failed('execution_run.stop', 'run stop route'),
  },
  planning: {
    submitTurn: async () =>
      failed('planning_cycle.submit_turn', 'submit turn route'),
    submitPlanTurn: async () =>
      failed('planning_cycle.submit_plan_turn', 'submit plan turn route'),
    approveProposal: () =>
      failed('planning_proposal.approve', 'approve proposal route'),
    rejectProposal: () =>
      failed('planning_proposal.reject', 'reject proposal route'),
    approvePlanProposal: () =>
      failed('plan_proposal.approve', 'approve plan proposal route'),
    rejectPlanProposal: () =>
      failed('plan_proposal.reject', 'reject plan proposal route'),
    setBoardFilter: () => failed('board_filter.set', 'board filter route'),
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
      'submit plan turn route',
      {
        type: 'planning_cycle.submit_plan_turn',
        projectId,
        expectedCycleRevision: null,
        profileId,
        profileRevision: 1,
        expectedProjectIntentId: projectIntentId,
        expectedProjectIntentRevision: 1,
        expectedLedgerId: ledgerId,
        expectedLedgerRevision: 1,
        expectedDeliveryPlan: { id: null, revision: null },
        message: 'Plan the Todo delivery milestones.',
      },
    ],
    [
      'approve plan proposal route',
      {
        type: 'plan_proposal.approve',
        projectId,
        planningCycleId,
        proposalId,
        expectedCycleRevision: 2,
        expectedProposalRevision: 1,
        expectedProjectIntentId: projectIntentId,
        expectedProjectIntentRevision: 1,
        expectedLedgerId: ledgerId,
        expectedLedgerRevision: 1,
        expectedDeliveryPlan: { id: null, revision: null },
      },
    ],
    [
      'reject plan proposal route',
      {
        type: 'plan_proposal.reject',
        projectId,
        planningCycleId,
        proposalId,
        expectedCycleRevision: 2,
        expectedProposalRevision: 1,
        feedback: 'Split the milestones.',
      },
    ],
    [
      'board filter route',
      {
        type: 'board_filter.set',
        projectId,
        expectedFilterRevision: 1,
        filter: {
          milestoneIds: [],
          requirementRecordIds: [],
          priorities: ['must'],
          labels: [],
          readiness: ['actionable'],
          taskLifecycles: ['pending'],
        },
      },
    ],
    [
      'run start route',
      {
        type: 'execution_run.start',
        projectId,
        expectedDeliveryPlanId: deliveryPlanId,
        expectedDeliveryPlanRevision: 1,
        expectedBoardFilterRevision: 1,
        selections: [
          {
            taskId,
            expectedTaskRevision: 1,
            profileId,
            profileRevision: 1,
          },
        ],
        concurrencyLimit: 2,
        subscriptionCapacityConfirmed: true,
      },
    ],
    [
      'run pause route',
      {
        type: 'execution_run.pause',
        projectId,
        runId,
        expectedRunRevision: 1,
      },
    ],
    [
      'run resume route',
      {
        type: 'execution_run.resume',
        projectId,
        runId,
        expectedRunRevision: 1,
      },
    ],
    [
      'run stop route',
      {
        type: 'execution_run.stop',
        projectId,
        runId,
        expectedRunRevision: 1,
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

    expect(response.statusCode).toBe(message.startsWith('run ') ? 400 : 200);
    expect(response.json()).toMatchObject({ ok: false, error: { message } });
  });

  it.each([
    [
      'developer_attempt.start',
      {
        type: 'developer_attempt.start',
        projectId,
        taskId,
        expectedTaskRevision: 1,
        expectedDeliveryPlanId: deliveryPlanId,
        expectedDeliveryPlanRevision: 1,
        profileId,
        profileRevision: 1,
      },
      'developer_task_stale',
      409,
    ],
    [
      'developer_attempt.interrupt',
      {
        type: 'developer_attempt.interrupt',
        projectId,
        attemptId,
        expectedAttemptRevision: 1,
      },
      'developer_attempt_conflict',
      409,
    ],
    [
      'developer_attempt.replace_execution',
      {
        type: 'developer_attempt.replace_execution',
        projectId,
        attemptId,
        expectedAttemptRevision: 1,
      },
      'developer_replacement_unavailable',
      409,
    ],
  ] as const)(
    'dispatches strict %s and preserves its typed conflict status',
    async (commandType, command, code, statusCode) => {
      const calls: string[] = [];
      const dependencies = Object.assign(createDependencies(), {
        developer: {
          start: async () => {
            calls.push('developer_attempt.start');
            return {
              ok: false as const,
              commandType: 'developer_attempt.start' as const,
              error: {
                code: 'developer_task_stale' as const,
                message: 'stale',
              },
            };
          },
          interrupt: async () => {
            calls.push('developer_attempt.interrupt');
            return {
              ok: false as const,
              commandType: 'developer_attempt.interrupt' as const,
              error: {
                code: 'developer_attempt_conflict' as const,
                message: 'conflict',
              },
            };
          },
          replaceExecution: async () => {
            calls.push('developer_attempt.replace_execution');
            return {
              ok: false as const,
              commandType: 'developer_attempt.replace_execution' as const,
              error: {
                code: 'developer_replacement_unavailable' as const,
                message: 'replacement unavailable',
              },
            };
          },
        },
      });
      const response = await createApp(dependencies).inject({
        method: 'POST',
        url: '/api/v2/commands',
        payload: {
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command,
        },
      });

      expect(calls).toEqual([commandType]);
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ ok: false, error: { code } });
    },
  );

  it.each([
    ['developer_report_binding_invalid', 400],
    ['developer_report_coverage_invalid', 400],
    ['adapter_unavailable', 503],
    ['audit_barrier_tripped', 503],
  ] as const)('maps Developer %s to HTTP %i', async (code, statusCode) => {
    const dependencies = Object.assign(createDependencies(), {
      developer: {
        start: async () =>
          ({
            ok: false,
            commandType: 'developer_attempt.start',
            error: { code, message: code },
          }) as const,
        interrupt: async () =>
          failed('developer_attempt.interrupt', 'interrupt route'),
        replaceExecution: async () =>
          failed('developer_attempt.replace_execution', 'replacement route'),
      },
    });
    const response = await createApp(dependencies).inject({
      method: 'POST',
      url: '/api/v2/commands',
      payload: {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'developer_attempt.start',
          projectId,
          taskId,
          expectedTaskRevision: 1,
          expectedDeliveryPlanId: deliveryPlanId,
          expectedDeliveryPlanRevision: 1,
          profileId,
          profileRevision: 1,
        },
      },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ ok: false, error: { code } });
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

  it('allows a Developer replay through a tripped barrier while new work remains gated', async () => {
    const dependencies = createDependencies();
    const replayKey = randomUUID();
    const start = vi.fn(async (envelope) =>
      envelope.idempotencyKey === replayKey
        ? failed('developer_attempt.start', 'stored developer result')
        : ({
            ok: false,
            commandType: 'developer_attempt.start',
            error: {
              code: 'audit_barrier_tripped',
              message: 'Audit persistence failed.',
            },
          } as const),
    );
    dependencies.developer.start = start;
    dependencies.health = () => ({
      status: 'audit_barrier_tripped',
      error: {
        code: 'audit_barrier_tripped',
        message: 'Audit persistence failed.',
      },
    });

    const app = createApp(dependencies);
    const payload = (idempotencyKey: string) => ({
      idempotencyKey,
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.start',
        projectId,
        taskId,
        expectedTaskRevision: 1,
        expectedDeliveryPlanId: deliveryPlanId,
        expectedDeliveryPlanRevision: 1,
        profileId,
        profileRevision: 1,
      },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v2/commands',
      payload: payload(replayKey),
    });
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/v2/commands',
      payload: payload(randomUUID()),
    });

    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({
      error: { message: 'stored developer result' },
    });
    expect(fresh.statusCode).toBe(503);
    expect(fresh.json()).toMatchObject({
      error: { code: 'audit_barrier_tripped' },
    });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'start',
      {
        type: 'developer_attempt.start',
        projectId,
        taskId,
        expectedTaskRevision: 1,
        expectedDeliveryPlanId: deliveryPlanId,
        expectedDeliveryPlanRevision: 1,
        profileId,
        profileRevision: 1,
      },
    ],
    [
      'interrupt',
      {
        type: 'developer_attempt.interrupt',
        projectId,
        attemptId,
        expectedAttemptRevision: 1,
      },
    ],
    [
      'replaceExecution',
      {
        type: 'developer_attempt.replace_execution',
        projectId,
        attemptId,
        expectedAttemptRevision: 1,
      },
    ],
  ] as const)(
    'maps thrown Developer %s idempotency conflicts to 409',
    async (method, command) => {
      const dependencies = createDependencies();
      dependencies.developer[method] = async () => {
        throw new V2IdempotencyConflictError(randomUUID());
      };
      const response = await createApp(dependencies).inject({
        method: 'POST',
        url: '/api/v2/commands',
        payload: {
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'idempotency_conflict' },
      });
    },
  );

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
        developers: new DeveloperRepository(fixture.database),
        runs: { listForProject: () => [] },
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
        executionRuns: [],
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

  it.each([
    [
      'malformed operation ID',
      {
        kind: 'mesh.v2.reconciliation-probe/v1',
        operationId: 'not-an-operation-id',
        probe: { status: 'unknown', reason: 'Probe could not prove start.' },
      },
    ],
    [
      'oversized probe reason',
      {
        kind: 'mesh.v2.reconciliation-probe/v1',
        operationId: '77777777-7777-4777-8777-777777777777',
        probe: { status: 'unknown', reason: 'x'.repeat(1025) },
      },
    ],
  ])('fails closed for %s reconciliation evidence', (_, payload) => {
    const fixture = createV2TestDatabase();
    try {
      const execution = {
        ...fixture.execution,
        lifecycle: 'attention_required' as const,
        failure: null,
      };
      const detail: ExecutionAttentionDetail = {
        execution,
        evidence: [
          {
            id: randomUUID(),
            projectId: fixture.project.id,
            executionId: execution.id,
            adapterId: execution.adapterId,
            adapterCursor: null,
            receivedAt: timestamp,
            payload,
          },
        ],
      };
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
        executions: {
          list: () => [execution],
          listAttentionDetails: () => [detail],
        },
        developers: {
          attemptsForProject: () => [],
          reportsForProject: () => [],
        },
        runs: { listForProject: () => [] },
        planning: new PlanningRepository(fixture.database),
        events: fixture.events,
        barrier: new AuditBarrier(),
      });

      expect(snapshots.project(fixture.project.id)?.attentionItems).toEqual([
        {
          executionId: execution.id,
          code: 'internal_error',
          message: 'Execution requires operator attention.',
        },
      ]);
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
        developers: new DeveloperRepository(fixture.database),
        runs: { listForProject: () => [] },
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
