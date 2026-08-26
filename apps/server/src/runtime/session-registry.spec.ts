import { afterEach, describe, expect, it } from 'vitest';
import {
  projectSchema,
  sessionSchema,
  workspaceSchema,
  type DeveloperBlockerReport,
  type DeveloperCompletionReport,
} from '@mesh-session-platform/contracts';

import type {
  ClaudeSessionDriver,
  DeveloperRuntimeConfiguration,
  DriverSession,
} from '../claude/driver.js';
import {
  FakeClaudeSessionDriver,
  FakeDriverSession,
} from '../claude/fake-driver.js';
import { createTestRepositories } from '../test/create-test-database.js';
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
      submitForReview: async (_report: DeveloperCompletionReport) => undefined,
      markBlocked: async (_report: DeveloperBlockerReport) => undefined,
    },
  });

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
