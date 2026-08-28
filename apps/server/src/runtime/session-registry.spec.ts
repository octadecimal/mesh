import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectSchema,
  sessionSchema,
  workspaceSchema,
  type DeveloperBlockerReportInput,
  type DeveloperCompletionReportInput,
} from '@mesh-session-platform/contracts';

import type {
  ClaudeSessionDriver,
  DeveloperRuntimeConfiguration,
  DriverSession,
  PmRuntimeConfiguration,
  RoleRuntimeConfiguration,
} from '../claude/driver.js';
import {
  FakeClaudeSessionDriver,
  FakeDriverSession,
} from '../claude/fake-driver.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { PM_AVAILABLE_TOOLS } from '../domain/planning-policy.js';
import { SessionRegistry } from './session-registry.js';

const now = '2026-08-25T12:00:00.000Z';

const deferred = <Value>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

class ControlledDriverSession implements DriverSession {
  readonly prompts: string[] = [];
  interrupted = false;
  closed = false;
  private readonly nextEvent = deferred<IteratorResult<never>>();

  constructor(readonly claudeResumeId: string | undefined) {}

  events(): AsyncIterable<never> {
    const nextEvent = this.nextEvent;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => nextEvent.promise,
        };
      },
    };
  }

  async sendPrompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
  }

  async resolvePermission(): Promise<void> {
    return;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async endEventStream(): Promise<void> {
    this.nextEvent.resolve({ done: true, value: undefined as never });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

describe('SessionRegistry Developer attachment', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const seed = (
    repositories: ReturnType<typeof createTestRepositories>,
    sessionId: string,
    lifecycleState: 'idle' | 'interrupted' = 'idle',
  ) => {
    if (!repositories.projects.get('project-1')) {
      repositories.projects.create(
        projectSchema.parse({
          id: 'project-1',
          displayName: 'Project one',
          repositoryPath: 'C:/code/project-1',
          repositoryIdentity: 'repository-1',
          discoveredAt: now,
          discoveryMetadata: {},
        }),
      );
      repositories.workspaces.create(
        workspaceSchema.parse({
          id: 'workspace-1',
          projectId: 'project-1',
          type: 'shared',
          path: 'C:/code/project-1',
        }),
      );
    }
    repositories.sessions.create(
      sessionSchema.parse({
        id: sessionId,
        claudeResumeId:
          lifecycleState === 'interrupted' ? `resume-${sessionId}` : undefined,
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        title: `Session ${sessionId}`,
        permissionMode: 'interactive',
        lifecycleState,
        createdAt: now,
        updatedAt: now,
      }),
    );
  };

  const developer = (): DeveloperRuntimeConfiguration => ({
    initialPrompt: 'Execute the assigned Developer cycle.',
    controls: {
      submitForReview: async (_report: DeveloperCompletionReportInput) =>
        undefined,
      markBlocked: async (_report: DeveloperBlockerReportInput) => undefined,
    },
  });

  const seedProtectedWorkspace = (
    repositories: ReturnType<typeof createTestRepositories>,
    id = 'protected-worktree',
  ): string => {
    const path = 'C:/code/project-1/.mesh-project-runs/item';
    repositories.workspaces.create(
      workspaceSchema.parse({
        id,
        projectId: 'project-1',
        type: 'worktree',
        path,
        gitBranch: 'mesh/run/item',
        gitWorktreePath: path,
        owner: 'mesh',
        cleanupState: 'active',
      }),
    );
    return id;
  };

  it('passes Developer configuration only to the requested create and resume attaches', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'create-developer');
    seed(repositories, 'create-ordinary');
    seed(repositories, 'resume-developer', 'interrupted');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    const configuration = developer();

    await registry.create('create-developer', configuration);
    await registry.create('create-ordinary');
    await registry.resume(
      'resume-developer',
      { workspaceId: 'workspace-1', permissionMode: 'safe_auto' },
      configuration,
    );

    expect(driver.createdRequests[0]?.developer).toBe(configuration);
    expect(driver.createdSessions[0]?.prompts).toEqual([
      'Execute the assigned Developer cycle.',
    ]);
    expect(driver.createdRequests[1]?.developer).toBeUndefined();
    expect(driver.resumedRequests[0]).toMatchObject({
      claudeResumeId: 'resume-resume-developer',
      permissionMode: 'safe_auto',
      developer: configuration,
    });
  });

  it('keeps resume configuration unchanged when a Mesh worktree is occupied', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    const tripAuditBarrier = vi.spyOn(
      registry as unknown as {
        tripAuditBarrier(error: unknown): void;
      },
      'tripAuditBarrier',
    );
    seed(repositories, 'resume-protected', 'interrupted');
    const protectedPath = 'C:/code/project-1/.mesh-project-runs/item';
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'protected-worktree',
        projectId: 'project-1',
        type: 'worktree',
        path: protectedPath,
        gitBranch: 'mesh/run/item',
        gitWorktreePath: protectedPath,
        owner: 'mesh',
        cleanupState: 'active',
      }),
    );
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'protected-alias',
        projectId: 'project-1',
        type: 'shared',
        path: protectedPath,
        cleanupState: 'active',
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 'protected-occupant',
        projectId: 'project-1',
        workspaceId: 'protected-worktree',
        title: 'Protected occupant',
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });

    await expect(
      registry.resume('resume-protected', {
        workspaceId: 'protected-alias',
        permissionMode: 'safe_auto',
      }),
    ).rejects.toMatchObject({ code: 'project_run_conflict' });

    expect(repositories.sessions.get('resume-protected')).toMatchObject({
      workspaceId: 'workspace-1',
      permissionMode: 'interactive',
    });
    expect(driver.resumedRequests).toHaveLength(0);
    expect(registry.auditStatus).toBe('available');
    expect(tripAuditBarrier).not.toHaveBeenCalled();
  });

  it('trips the audit barrier once when resume reservation commit fails', async () => {
    const repositories = createTestRepositories();
    const commitFailure = new Error('resume reservation commit failed');
    let failCommit = false;
    let commitAttempts = 0;
    let rollbackCalls = 0;
    const database = new Proxy(repositories.database, {
      get(target, property, receiver) {
        if (property === 'exec') {
          return (sql: string) => {
            if (sql === 'COMMIT') {
              commitAttempts += 1;
              if (failCommit) {
                failCommit = false;
                throw commitFailure;
              }
            }
            if (sql === 'ROLLBACK') rollbackCalls += 1;
            return target.exec(sql);
          };
        }
        if (property === 'prepare') return target.prepare.bind(target);
        return Reflect.get(target, property, receiver);
      },
    });
    const driver = new FakeClaudeSessionDriver();
    const invalidated: string[] = [];
    const registry = new SessionRegistry({
      ...repositories,
      database,
      driver,
      invalidateDeveloperCapability: (sessionId) => invalidated.push(sessionId),
      closeDatabase: () => undefined,
    });
    const tripAuditBarrier = vi.spyOn(
      registry as unknown as {
        tripAuditBarrier(error: unknown): void;
      },
      'tripAuditBarrier',
    );
    seed(repositories, 'active-during-commit-failure');
    seed(repositories, 'commit-failed-resume', 'interrupted');
    const workspaceId = seedProtectedWorkspace(repositories);
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    await registry.create('active-during-commit-failure');
    failCommit = true;

    await expect(
      registry.resume('commit-failed-resume', {
        workspaceId,
        permissionMode: 'safe_auto',
      }),
    ).rejects.toBe(commitFailure);

    expect(commitAttempts).toBe(1);
    expect(rollbackCalls).toBe(1);
    expect(tripAuditBarrier).toHaveBeenCalledOnce();
    expect(tripAuditBarrier).toHaveBeenCalledWith(commitFailure);
    expect(registry.auditStatus).toBe('audit_unavailable');
    expect(repositories.sessions.get('commit-failed-resume')).toMatchObject({
      workspaceId: 'workspace-1',
      permissionMode: 'interactive',
      lifecycleState: 'interrupted',
    });
    expect(repositories.events.after('commit-failed-resume', 0)).toEqual([]);
    expect(repositories.diagnostics.list('commit-failed-resume')).toEqual([]);
    expect(driver.resumedRequests).toHaveLength(0);
    expect(invalidated).toContain('active-during-commit-failure');
    await vi.waitFor(() =>
      expect(driver.createdSessions[0]?.interrupted).toBe(true),
    );
    await expect(
      registry.sendPrompt('active-during-commit-failure', 'blocked'),
    ).rejects.toMatchObject({ code: 'audit_unavailable' });
    await expect(
      registry.resume('commit-failed-resume', {
        workspaceId,
        permissionMode: 'safe_auto',
      }),
    ).rejects.toMatchObject({ code: 'audit_unavailable' });
  });

  it('durably reserves protected occupancy while driver resume is pending', async () => {
    const repositories = createTestRepositories();
    const pendingDriver = deferred<DriverSession>();
    let resumeCalls = 0;
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => new FakeDriverSession('unused'),
      resume: async () => {
        resumeCalls += 1;
        return resumeCalls === 1
          ? pendingDriver.promise
          : new ControlledDriverSession('unexpected-second-resume');
      },
    };
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'first-resume', 'interrupted');
    seed(repositories, 'second-resume', 'interrupted');
    const workspaceId = seedProtectedWorkspace(repositories);
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });

    const firstResume = registry.resume('first-resume', {
      workspaceId,
      permissionMode: 'safe_auto',
    });
    await vi.waitFor(() => expect(resumeCalls).toBe(1));
    const stateWhileDriverIsPending =
      repositories.sessions.get('first-resume')?.lifecycleState;
    const secondResult = await registry
      .resume('second-resume', {
        workspaceId,
        permissionMode: 'safe_auto',
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    pendingDriver.resolve(new ControlledDriverSession('first-resumed-driver'));
    await firstResume;

    expect(stateWhileDriverIsPending).toBe('starting');
    expect(secondResult).toMatchObject({ code: 'project_run_conflict' });
    expect(resumeCalls).toBe(1);
    expect(repositories.sessions.get('first-resume')?.lifecycleState).toBe(
      'running',
    );
  });

  it('records driver resume failure and permits a truthful retry', async () => {
    const repositories = createTestRepositories();
    let resumeCalls = 0;
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => new FakeDriverSession('unused'),
      resume: async () => {
        resumeCalls += 1;
        if (resumeCalls === 1) throw new Error('resume driver unavailable');
        return new ControlledDriverSession('recovered-resume');
      },
    };
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'failed-resume', 'interrupted');
    const workspaceId = seedProtectedWorkspace(repositories);
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });

    await expect(
      registry.resume('failed-resume', {
        workspaceId,
        permissionMode: 'safe_auto',
      }),
    ).rejects.toThrow('resume driver unavailable');

    expect(repositories.sessions.get('failed-resume')?.lifecycleState).toBe(
      'failed',
    );
    expect(repositories.events.after('failed-resume', 0)).toMatchObject([
      {
        sequence: 1,
        type: 'session.status',
        payload: { from: 'interrupted', to: 'starting' },
      },
      {
        sequence: 2,
        type: 'session.error',
        payload: {
          code: 'driver_resume_failed',
          message: 'resume driver unavailable',
        },
      },
      {
        sequence: 3,
        type: 'session.status',
        payload: {
          from: 'starting',
          to: 'failed',
          reason: 'driver_resume_failed',
        },
      },
    ]);
    expect(repositories.diagnostics.list('failed-resume')).toHaveLength(3);

    await registry.resume('failed-resume', {
      workspaceId,
      permissionMode: 'safe_auto',
    });

    expect(resumeCalls).toBe(2);
    expect(repositories.sessions.get('failed-resume')?.lifecycleState).toBe(
      'running',
    );
  });

  it('fails closed when the durable resume reservation cannot be audited', async () => {
    const repositories = createTestRepositories({ failDiagnosticInsert: true });
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'resume-audit-failure', 'interrupted');
    const workspaceId = seedProtectedWorkspace(repositories);
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });

    await expect(
      registry.resume('resume-audit-failure', {
        workspaceId,
        permissionMode: 'safe_auto',
      }),
    ).rejects.toBeDefined();

    expect(registry.auditStatus).toBe('audit_unavailable');
    expect(repositories.sessions.get('resume-audit-failure')).toMatchObject({
      workspaceId: 'workspace-1',
      permissionMode: 'interactive',
      lifecycleState: 'interrupted',
    });
    expect(driver.resumedRequests).toHaveLength(0);
  });

  it('releases a cancelled resume reservation after the driver settles', async () => {
    const repositories = createTestRepositories();
    const pendingDriver = deferred<DriverSession>();
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => new FakeDriverSession('unused'),
      resume: async () => pendingDriver.promise,
    };
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'cancelled-resume', 'interrupted');
    const workspaceId = seedProtectedWorkspace(repositories);
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    const resumed = registry.resume('cancelled-resume', {
      workspaceId,
      permissionMode: 'safe_auto',
    });
    const rejection = resumed.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(
        repositories.sessions.get('cancelled-resume')?.lifecycleState,
      ).toBe('starting'),
    );

    await registry.interrupt('cancelled-resume');
    const session = new ControlledDriverSession('cancelled-driver');
    pendingDriver.resolve(session);

    await expect(rejection).resolves.toMatchObject({
      code: 'invalid_session_state',
      trigger: 'interrupt',
    });
    expect(session.interrupted).toBe(true);
    expect(session.closed).toBe(true);
    expect(repositories.sessions.get('cancelled-resume')?.lifecycleState).toBe(
      'interrupted',
    );
    expect(
      repositories.events.after('cancelled-resume', 0).slice(-2),
    ).toMatchObject([
      {
        type: 'session.status',
        payload: {
          from: 'starting',
          to: 'interrupting',
        },
      },
      {
        type: 'session.status',
        payload: {
          from: 'interrupting',
          to: 'interrupted',
          reason: 'resume_interrupt',
        },
      },
    ]);
  });

  it('resumes its own stopped session in a protected workspace', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'own-protected-resume', 'interrupted');
    const workspaceId = seedProtectedWorkspace(repositories);
    repositories.sessions.configureResume(
      'own-protected-resume',
      workspaceId,
      'safe_auto',
    );
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });

    await registry.resume('own-protected-resume', {
      workspaceId,
      permissionMode: 'safe_auto',
    });

    expect(driver.resumedRequests).toHaveLength(1);
    expect(
      repositories.sessions.get('own-protected-resume')?.lifecycleState,
    ).toBe('running');
  });

  it('keeps resume configuration unchanged when attachment is already live', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'resume-live');
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-2',
        projectId: 'project-1',
        type: 'shared',
        path: 'C:/code/project-1/alternate',
        cleanupState: 'active',
      }),
    );
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    await registry.create('resume-live');

    await expect(
      registry.resume('resume-live', {
        workspaceId: 'workspace-2',
        permissionMode: 'safe_auto',
      }),
    ).rejects.toMatchObject({ code: 'invalid_session_state' });

    expect(repositories.sessions.get('resume-live')).toMatchObject({
      workspaceId: 'workspace-1',
      permissionMode: 'interactive',
    });
    expect(driver.resumedRequests).toHaveLength(0);
  });

  it('keeps resume configuration unchanged without a Claude resume id', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'resume-missing-id');
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-2',
        projectId: 'project-1',
        type: 'shared',
        path: 'C:/code/project-1/alternate',
        cleanupState: 'active',
      }),
    );
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });

    await expect(
      registry.resume('resume-missing-id', {
        workspaceId: 'workspace-2',
        permissionMode: 'safe_auto',
      }),
    ).rejects.toMatchObject({ code: 'invalid_session_state' });

    expect(repositories.sessions.get('resume-missing-id')).toMatchObject({
      workspaceId: 'workspace-1',
      permissionMode: 'interactive',
    });
    expect(driver.resumedRequests).toHaveLength(0);
  });

  it('passes QA role configuration without populating Developer controls', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'create-qa');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    const configuration: RoleRuntimeConfiguration = {
      role: 'qa',
      initialPrompt: 'Verify the assigned Developer cycle.',
      availableTools: [],
      allowedTools: ['mcp__mesh_qa__submit_qa_verdict'],
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit'],
      controlServer: {
        name: 'mesh_qa',
        version: '1',
        tools: [],
      },
    };

    await registry.create('create-qa', configuration);

    expect(driver.createdRequests[0]?.role).toBe(configuration);
    expect(driver.createdRequests[0]?.developer).toBeUndefined();
    expect(driver.createdSessions[0]?.prompts).toEqual([
      'Verify the assigned Developer cycle.',
    ]);
  });

  it('passes PM role configuration without populating Developer controls', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'create-pm');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    const configuration: PmRuntimeConfiguration = {
      role: 'pm',
      initialPrompt: 'Plan the approved project goal.',
      availableTools: PM_AVAILABLE_TOOLS,
      allowedTools: PM_AVAILABLE_TOOLS,
      submitProposal: async () => undefined,
    };

    await registry.create('create-pm', configuration);

    expect(driver.createdRequests[0]?.role).toBe(configuration);
    expect(driver.createdRequests[0]?.developer).toBeUndefined();
    expect(driver.createdSessions[0]?.prompts).toEqual([
      'Plan the approved project goal.',
    ]);
  });

  it('invalidates session capabilities on interruption and shutdown', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const invalidated: string[] = [];
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) => invalidated.push(sessionId),
      closeDatabase: () => undefined,
    });
    seed(repositories, 'interrupted-session');
    seed(repositories, 'shutdown-session');
    cleanups.push(repositories.dispose);
    await registry.create('interrupted-session', developer());
    await registry.create('shutdown-session', developer());

    await registry.interrupt('interrupted-session');
    await registry.shutdown();

    expect(invalidated).toContain('interrupted-session');
    expect(invalidated).toContain('shutdown-session');
  });

  it('notifies reconciliation when a runtime stops after an unexpected crash', async () => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const stopped: string[] = [];
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      onRuntimeStopped: (sessionId) => stopped.push(sessionId),
      closeDatabase: () => undefined,
    });
    seed(repositories, 'crashed-developer');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    await registry.create('crashed-developer', developer());

    driver.createdSessions[0]?.crash(new Error('unexpected stop'));

    await vi.waitFor(() => expect(stopped).toEqual(['crashed-developer']));
  });

  it('invalidates capabilities and interrupts the driver when attach audit fails', async () => {
    const repositories = createTestRepositories({ failDiagnosticInsert: true });
    const driver = new FakeClaudeSessionDriver();
    const invalidated: string[] = [];
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) => invalidated.push(sessionId),
      closeDatabase: () => undefined,
    });
    seed(repositories, 'audit-failure');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });

    await expect(
      registry.create('audit-failure', developer()),
    ).rejects.toBeDefined();

    expect(invalidated).toContain('audit-failure');
    expect(driver.createdSessions[0]?.interrupted).toBe(true);
    expect(registry.auditStatus).toBe('audit_unavailable');
  });

  it('invalidates a capability when the driver cannot attach', async () => {
    const repositories = createTestRepositories();
    const invalidated: string[] = [];
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => {
        throw new Error('driver unavailable');
      },
      resume: async () => new FakeDriverSession('unused'),
    };
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) => invalidated.push(sessionId),
      closeDatabase: () => undefined,
    });
    seed(repositories, 'attach-failure');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });

    await expect(
      registry.create('attach-failure', developer()),
    ).rejects.toThrow('driver unavailable');

    expect(invalidated).toEqual(['attach-failure']);
  });

  it('cancels and invalidates a pending attach before shutdown can close persistence', async () => {
    const repositories = createTestRepositories();
    const pendingDriver = deferred<DriverSession>();
    const invalidated: string[] = [];
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => pendingDriver.promise,
      resume: async () => new FakeDriverSession('unused'),
    };
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) => invalidated.push(sessionId),
      shutdownTimeoutMs: 1_000,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'pending-shutdown');
    cleanups.push(repositories.dispose);
    const attached = registry.create('pending-shutdown', developer());
    const rejection = attached.catch((error: unknown) => error);

    const shutdown = registry.shutdown();

    expect(invalidated).toEqual(['pending-shutdown']);
    const session = new ControlledDriverSession('late-shutdown-driver');
    pendingDriver.resolve(session);
    await expect(rejection).resolves.toMatchObject({
      code: 'invalid_session_state',
      trigger: 'shutdown',
    });
    await shutdown;
    expect(session.interrupted).toBe(true);
    expect(session.closed).toBe(true);
    expect(repositories.sessions.get('pending-shutdown')?.lifecycleState).toBe(
      'idle',
    );
  });

  it('keeps repair authority unavailable while an attach is pending or live', async () => {
    const repositories = createTestRepositories();
    const pendingDriver = deferred<DriverSession>();
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => pendingDriver.promise,
      resume: async () => new FakeDriverSession('unused'),
    };
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    seed(repositories, 'pending-qa-repair');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    const attached = registry.create('pending-qa-repair');
    let cycleEndedAt: string | null = null;

    const pendingReservation = registry.reserveRepair('pending-qa-repair');
    if (pendingReservation) {
      cycleEndedAt = now;
      pendingReservation();
    }

    expect(pendingReservation).toBeUndefined();
    expect(cycleEndedAt).toBeNull();

    const session = new ControlledDriverSession('pending-qa-resume');
    pendingDriver.resolve(session);
    await attached;

    const liveReservation = registry.reserveRepair('pending-qa-repair');
    if (liveReservation) {
      cycleEndedAt = now;
      liveReservation();
    }
    expect(liveReservation).toBeUndefined();
    expect(cycleEndedAt).toBeNull();
  });

  it('cancels a pending attach when another runtime trips the audit barrier', async () => {
    const repositories = createTestRepositories();
    const activeSession = new FakeDriverSession('active-resume-id');
    const pendingDriver = deferred<DriverSession>();
    let createCount = 0;
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => {
        createCount += 1;
        return createCount === 1 ? activeSession : pendingDriver.promise;
      },
      resume: async () => new FakeDriverSession('unused'),
    };
    const invalidated: string[] = [];
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) => invalidated.push(sessionId),
      closeDatabase: () => undefined,
    });
    seed(repositories, 'active-session');
    seed(repositories, 'pending-audit');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    await registry.create('active-session', developer());
    const attached = registry.create('pending-audit', developer());
    const rejection = attached.catch((error: unknown) => error);
    repositories.database.exec(`
      CREATE TRIGGER fail_pending_attach_audit
      BEFORE INSERT ON raw_diagnostics
      BEGIN
        SELECT RAISE(FAIL, 'diagnostic insert failed');
      END;
    `);

    await expect(
      registry.sendPrompt('active-session', 'trip the audit barrier'),
    ).rejects.toBeDefined();

    expect(invalidated).toContain('pending-audit');
    const session = new ControlledDriverSession('late-audit-driver');
    pendingDriver.resolve(session);
    await expect(rejection).resolves.toMatchObject({
      code: 'audit_unavailable',
    });
    expect(session.interrupted).toBe(true);
    expect(session.closed).toBe(true);
    expect(repositories.sessions.get('pending-audit')?.lifecycleState).toBe(
      'idle',
    );
  });

  it('cancels an interrupted pending attach instead of throwing and later starting it', async () => {
    const repositories = createTestRepositories();
    const pendingDriver = deferred<DriverSession>();
    const invalidated: string[] = [];
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => pendingDriver.promise,
      resume: async () => new FakeDriverSession('unused'),
    };
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) => invalidated.push(sessionId),
      closeDatabase: () => undefined,
    });
    seed(repositories, 'pending-interrupt');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    const attached = registry.create('pending-interrupt', developer());
    const rejection = attached.catch((error: unknown) => error);

    await expect(
      registry.interrupt('pending-interrupt'),
    ).resolves.toBeUndefined();

    expect(invalidated).toEqual(['pending-interrupt']);
    const session = new ControlledDriverSession('late-interrupt-driver');
    pendingDriver.resolve(session);
    await expect(rejection).resolves.toMatchObject({
      code: 'invalid_session_state',
      trigger: 'interrupt',
    });
    expect(session.interrupted).toBe(true);
    expect(session.closed).toBe(true);
    expect(repositories.sessions.get('pending-interrupt')?.lifecycleState).toBe(
      'idle',
    );
  });

  it('does not let a stale stopped callback invalidate a replacement runtime', async () => {
    const repositories = createTestRepositories();
    const oldSession = new ControlledDriverSession('old-resume-id');
    const newSession = new ControlledDriverSession('new-resume-id');
    const invalidated: string[] = [];
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => oldSession,
      resume: async () => newSession,
    };
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) => invalidated.push(sessionId),
      closeDatabase: () => undefined,
    });
    seed(repositories, 'replaced-session');
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    await registry.create('replaced-session', developer());
    await registry.interrupt('replaced-session');
    const invalidationsAfterInterrupt = invalidated.length;
    expect(invalidationsAfterInterrupt).toBeGreaterThan(0);
    await registry.resume(
      'replaced-session',
      { workspaceId: 'workspace-1', permissionMode: 'interactive' },
      developer(),
    );

    await oldSession.endEventStream();

    expect(invalidated).toHaveLength(invalidationsAfterInterrupt);
    await registry.sendPrompt('replaced-session', 'replacement remains active');
    expect(newSession.prompts).toEqual(['replacement remains active']);
  });
});
