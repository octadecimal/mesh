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
} from '../claude/driver.js';
import {
  FakeClaudeSessionDriver,
  FakeDriverSession,
} from '../claude/fake-driver.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { SessionRegistry } from './session-registry.js';

const now = '2026-08-25T12:00:00.000Z';

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
});
