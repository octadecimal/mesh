import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  idSchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  workspaceSchema,
  type Task,
} from '@mesh-session-platform/contracts';

import type { ClaudeSessionDriver } from '../claude/driver.js';
import type { GitAdapter } from '../platform/git.js';
import {
  FakeClaudeSessionDriver,
  FakeDriverSession,
} from '../claude/fake-driver.js';
import { SessionRegistry } from '../runtime/session-registry.js';
import type { RepositoryIdentity } from '../projects/repository-identity.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { AttemptService } from './attempt-service.js';
import { DeveloperCapabilityRegistry } from './developer-capability-registry.js';
import { DeveloperExecutionService } from './developer-execution-service.js';
import { DeveloperReworkService } from './developer-rework-service.js';
import { TaskService } from './task-service.js';

const now = '2026-08-25T12:00:00.000Z';
const actor = taskActorSchema.parse({
  type: 'human',
  id: 'operator-1',
}) as ReturnType<typeof taskActorSchema.parse> & { type: 'human' };

describe('AttemptService', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const setup = (options?: {
    repositories?: Parameters<typeof createTestRepositories>[0];
    driver?: ClaudeSessionDriver;
    git?: Pick<GitAdapter, 'createWorktree'>;
    interrupt?: (sessionId: string) => Promise<void>;
    terminalInterrupt?: (sessionId: string) => Promise<void>;
    emergencyClose?: (sessionId: string) => Promise<void>;
  }) => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-attempt-service-'));
    const repositories = createTestRepositories(options?.repositories);
    const driver = options?.driver ?? new FakeClaudeSessionDriver();
    const capabilities = new DeveloperCapabilityRegistry();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) =>
        capabilities.invalidateSession(sessionId),
      closeDatabase: () => undefined,
    });
    let nextId = 0;
    const createId = () => `generated-${++nextId}`;
    const taskService = new TaskService({
      ...repositories,
      now: () => now,
      createId,
    });
    const developerExecutionService = new DeveloperExecutionService({
      ...repositories,
      taskService,
      capabilities,
      publisher: registry.publisher,
      now: () => now,
      createId,
    });
    const developerReworkService = new DeveloperReworkService({
      ...repositories,
      taskService,
      capabilities,
      developerExecutionService,
      registry: {
        resume: (sessionId, configuration, developer) =>
          registry.resume(sessionId, configuration, developer),
        interrupt:
          options?.terminalInterrupt ??
          ((sessionId) => registry.interrupt(sessionId)),
        emergencyClose:
          options?.emergencyClose ??
          ((sessionId) => registry.emergencyClose(sessionId)),
        publisher: registry.publisher,
      },
      now: () => now,
      createId,
    });
    const service = new AttemptService({
      ...repositories,
      taskService,
      capabilities,
      developerReworkService,
      registry: {
        create: (sessionId, developer) => registry.create(sessionId, developer),
        interrupt:
          options?.interrupt ?? ((sessionId) => registry.interrupt(sessionId)),
        publisher: registry.publisher,
      },
      git: options?.git,
      pathOptions: { baseDirectory: directory },
      resolveIdentity: async (path) =>
        ({
          canonicalPath: path,
          commonDirectory: path,
          repositoryIdentity:
            path === directory || path.endsWith('/project-1')
              ? directory
              : path,
        }) as RepositoryIdentity,
      now: () => now,
      createId,
    });
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project one',
        repositoryPath: directory,
        repositoryIdentity: 'repository-1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
      rmSync(directory, { force: true, recursive: true });
    });
    return {
      capabilities,
      directory,
      driver,
      registry,
      repositories,
      service,
    };
  };

  const seedTask = (
    repositories: ReturnType<typeof createTestRepositories>,
    overrides: Partial<Task> = {},
  ) =>
    repositories.tasks.create(
      taskSchema.parse({
        id: 'task-1',
        projectId: 'project-1',
        title: 'Implement attempt launch',
        description: 'Compose the existing session boundary safely.',
        acceptanceCriteria: ['Startup advances the task only after success.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }),
    );

  const launchInput = (directory: string) => ({
    commandId: 'attempt-launch-1',
    taskId: 'task-1',
    expectedRevision: 1,
    title: 'Attempt one',
    permissionMode: 'interactive' as const,
    workspace: { type: 'shared' as const, path: directory },
    actor,
  });

  const developerLaunchInput = (directory: string) => ({
    ...launchInput(directory),
    commandId: 'developer-launch-1',
  });

  const worktreeLaunchInput = (directory: string) => ({
    ...launchInput(directory),
    workspace: {
      type: 'worktree' as const,
      repositoryPath: directory,
      path: join(directory, 'attempt-worktree'),
      branch: 'attempt-branch',
      startPoint: 'HEAD',
    },
  });

  const seedSession = (
    repositories: ReturnType<typeof createTestRepositories>,
    options: { projectId?: string; sessionId?: string } = {},
  ) => {
    const projectId = options.projectId ?? 'project-1';
    const sessionId = options.sessionId ?? 'session-1';
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: `workspace-${sessionId}`,
        projectId,
        type: 'shared',
        path: `C:/work/${projectId}`,
      }),
    );
    return repositories.sessions.create(
      sessionSchema.parse({
        id: sessionId,
        projectId,
        workspaceId: `workspace-${sessionId}`,
        title: 'Existing session',
        permissionMode: 'interactive',
        lifecycleState: 'interrupted',
        createdAt: now,
        updatedAt: now,
      }),
    );
  };

  const requireOnlyAttempt = (
    repositories: ReturnType<typeof createTestRepositories>,
  ) => {
    const [attempt] = repositories.attempts.listByTask('task-1');
    if (!attempt) throw new Error('Expected one task attempt');
    return attempt;
  };

  const seedRecovery = (
    repositories: ReturnType<typeof createTestRepositories>,
    directory: string,
    kind: 'rejection' | 'unblock',
  ) => {
    const task = seedTask(repositories, {
      lifecycleState: kind === 'rejection' ? 'review' : 'in_progress',
      blocked:
        kind === 'unblock'
          ? { reason: 'Dependency unavailable.', actor, blockedAt: now }
          : null,
      revision: 3,
      title: 'Current task title',
      description: 'Current task description.',
      acceptanceCriteria: ['Current acceptance criterion.'],
    });
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-recovery',
        projectId: task.projectId,
        type: 'shared',
        path: directory,
        cleanupState: 'active',
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 'session-recovery',
        claudeResumeId: 'claude-resume-1',
        projectId: task.projectId,
        workspaceId: 'workspace-recovery',
        title: 'Prior Developer attempt',
        permissionMode: 'safe_auto',
        lifecycleState: 'completed',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = repositories.attempts.createForTask(
      task.id,
      'session-recovery',
      'launched',
      actor,
      'developer',
    );
    const cycle = repositories.developerExecutions.createCycle(
      developerExecutionCycleSchema.parse({
        id: 'cycle-prior',
        attemptId: attempt.id,
        ordinal: 1,
        mode: 'new',
        authorizedBy: actor,
        authorizationCommandId: 'command-prior',
        policyVersion: 'developer-policy-v1',
        projectInstructions: { content: 'Prior instructions.', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: 'Prior task title',
          description: 'Prior task description.',
          acceptanceCriteria: [{ id: 'criterion-1', text: 'Prior criterion.' }],
        },
        workspaceId: 'workspace-recovery',
        permissionMode: 'safe_auto',
        startedAt: now,
        endedAt: now,
        terminalDisposition:
          kind === 'rejection' ? 'submitted_for_review' : 'blocked',
        completionReportId: kind === 'rejection' ? 'report-prior' : null,
        blockerReportId: kind === 'unblock' ? 'blocker-prior' : null,
        terminalCommandId: 'command-terminal',
        terminalEventId: 'event-terminal',
      }),
    );
    if (kind === 'rejection') {
      repositories.developerExecutions.appendCompletionReport(
        developerCompletionReportSchema.parse({
          id: 'report-prior',
          cycleId: cycle.id,
          summary: 'Prior submission.',
          criterionResults: [
            {
              criterionId: 'criterion-1',
              status: 'met',
              evidence: 'Prior evidence.',
            },
          ],
          verification: [],
          limitations: '',
          workspaceState: {
            summary: 'Preserved.',
            hasUncommittedChanges: true,
            commitsCreated: false,
          },
          reviewerNotes: null,
          createdAt: now,
        }),
      );
    } else {
      repositories.developerExecutions.appendBlockerReport(
        developerBlockerReportSchema.parse({
          id: 'blocker-prior',
          cycleId: cycle.id,
          reason: 'Dependency unavailable.',
          evidence: 'Service returned 503.',
          attemptedWork: 'Retried safely.',
          suggestedHumanAction: 'Restore the dependency.',
          preserveWorkspace: true,
          createdAt: now,
        }),
      );
    }
    return { task, attempt, cycle };
  };

  it('persists the launched attempt, starts its runtime, then audits in_progress', async () => {
    const { directory, driver, repositories, service } = setup();
    seedTask(repositories);

    const result = await service.launch(launchInput(directory));

    expect(result).toMatchObject({
      task: { id: 'task-1', lifecycleState: 'in_progress', revision: 2 },
      attempt: { taskId: 'task-1', ordinal: 1, source: 'launched' },
      session: { lifecycleState: 'running' },
    });
    expect((driver as FakeClaudeSessionDriver).createdRequests).toHaveLength(1);
    expect(
      (driver as FakeClaudeSessionDriver).createdRequests[0]?.developer,
    ).toBeUndefined();
    expect(result.attempt.role).toBeNull();
    expect(repositories.attempts.listByTask('task-1')).toHaveLength(1);
    expect(
      repositories.projectEvents
        .after('project-1', 0)
        .map((event) => event.type),
    ).toEqual(['task.attempt_changed', 'task.transitioned']);
  });

  it('resumes the same Developer attempt with immutable feedback and current snapshots', async () => {
    const { directory, driver, repositories, service } = setup();
    const prior = seedRecovery(repositories, directory, 'rejection');
    repositories.projects.updateDeveloperInstructions('project-1', 1, {
      content: 'Current instructions.',
      updatedAt: now,
      updatedBy: actor,
    });
    const input = {
      commandId: 'command-reject-resume',
      taskId: prior.task.id,
      expectedRevision: prior.task.revision,
      kind: 'rejection' as const,
      feedback: 'Add the missing regression proof.',
      actor,
    };

    const resumed = await service.resumeDeveloper(input);
    const duplicate = await service.resumeDeveloper(input);
    const cycles = repositories.developerExecutions.listByTask(prior.task.id);

    expect(resumed).toMatchObject({
      task: { lifecycleState: 'in_progress', blocked: null, revision: 4 },
      attempt: { id: prior.attempt.id, sessionId: prior.attempt.sessionId },
      cycle: {
        ordinal: 2,
        mode: 'resume',
        taskSnapshot: {
          revision: 3,
          title: 'Current task title',
          description: 'Current task description.',
        },
        projectInstructions: { content: 'Current instructions.', revision: 2 },
      },
      feedback: { kind: 'rejection', feedback: input.feedback },
      session: { id: 'session-recovery', lifecycleState: 'running' },
    });
    expect(duplicate).toEqual(resumed);
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toEqual(prior.cycle);
    expect((driver as FakeClaudeSessionDriver).resumedRequests).toHaveLength(1);
    expect(
      (driver as FakeClaudeSessionDriver).resumedRequests[0]?.developer
        ?.initialPrompt,
    ).toContain(input.feedback);
  });

  it('closes a failed resume cycle and retains the prior review truth', async () => {
    const unavailable = new Error('resume unavailable');
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => new FakeDriverSession('unused'),
      resume: async () => {
        throw unavailable;
      },
    };
    const { capabilities, directory, repositories, service } = setup({
      driver,
    });
    const prior = seedRecovery(repositories, directory, 'rejection');
    let issuedToken = '';
    const issue = capabilities.issue.bind(capabilities);
    vi.spyOn(capabilities, 'issue').mockImplementation((binding) => {
      issuedToken = issue(binding);
      return issuedToken;
    });

    await expect(
      service.resumeDeveloper({
        commandId: 'command-reject-resume-failed',
        taskId: prior.task.id,
        expectedRevision: prior.task.revision,
        kind: 'rejection',
        feedback: 'Try the same session again.',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'attempt_start_failed' });

    expect(repositories.tasks.get(prior.task.id)).toEqual(prior.task);
    expect(repositories.developerExecutions.listByTask(prior.task.id)).toEqual([
      prior.cycle,
      expect.objectContaining({
        ordinal: 2,
        mode: 'resume',
        endedAt: now,
        terminalDisposition: null,
      }),
    ]);
    expect(() => capabilities.resolve(issuedToken)).toThrow();
    expect(
      repositories.database
        .prepare('SELECT feedback FROM developer_review_feedback')
        .all(),
    ).toEqual([{ feedback: 'Try the same session again.' }]);
    expect(
      repositories.diagnostics.list(prior.attempt.sessionId),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ stage: 'resume' }),
      }),
    );
  });

  it('restores review truth when resume command completion cannot persist', async () => {
    const resumedSession = new FakeDriverSession('claude-resume-1');
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => new FakeDriverSession('unused'),
      resume: async () => resumedSession,
    };
    const { capabilities, directory, repositories, service } = setup({
      driver,
      repositories: {
        failCommandCompleteFor: 'command-reject-resume-complete-failed',
      },
    });
    const prior = seedRecovery(repositories, directory, 'rejection');
    let issuedToken = '';
    const issue = capabilities.issue.bind(capabilities);
    vi.spyOn(capabilities, 'issue').mockImplementation((binding) => {
      issuedToken = issue(binding);
      return issuedToken;
    });
    const input = {
      commandId: 'command-reject-resume-complete-failed',
      taskId: prior.task.id,
      expectedRevision: prior.task.revision,
      kind: 'rejection' as const,
      feedback: 'Preserve review if command completion fails.',
      actor,
    };

    await expect(service.resumeDeveloper(input)).rejects.toMatchObject({
      code: 'attempt_reconciliation_required',
    });

    expect(repositories.tasks.get(prior.task.id)).toMatchObject({
      lifecycleState: 'review',
      blocked: null,
    });
    expect(repositories.developerExecutions.listByTask(prior.task.id)).toEqual([
      prior.cycle,
      expect.objectContaining({
        mode: 'resume',
        endedAt: now,
        terminalDisposition: null,
      }),
    ]);
    expect(resumedSession.interrupted).toBe(true);
    expect(() => capabilities.resolve(issuedToken)).toThrow();
    expect(
      repositories.diagnostics.list(prior.attempt.sessionId),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'developer_recovery',
          stage: 'command_completion',
          cleanup: 'interrupted',
          reconciliationRequired: true,
        }),
      }),
    );
    await expect(service.resumeDeveloper(input)).rejects.toMatchObject({
      code: 'command_reconciliation_required',
      state: 'pending',
    });
  });

  it('starts fresh rework without replacing prior attempt history', async () => {
    const { directory, driver, repositories, service } = setup();
    const prior = seedRecovery(repositories, directory, 'rejection');
    const input = {
      commandId: 'command-reject-new',
      taskId: prior.task.id,
      expectedRevision: prior.task.revision,
      kind: 'rejection' as const,
      feedback: 'Use a fresh context.',
      title: 'Fresh Developer rework',
      permissionMode: 'interactive' as const,
      workspace: { type: 'shared' as const, path: directory },
      actor,
    };

    const fresh = await service.reworkDeveloperNew(input);
    const duplicate = await service.reworkDeveloperNew(input);
    const attempts = repositories.attempts.listByTask(prior.task.id);
    const cycles = repositories.developerExecutions.listByTask(prior.task.id);

    expect(fresh).toMatchObject({
      task: { lifecycleState: 'in_progress', revision: 4 },
      attempt: { ordinal: 2, role: 'developer' },
      cycle: { ordinal: 1, mode: 'new', taskSnapshot: { revision: 3 } },
      feedback: { kind: 'rejection', feedback: input.feedback },
    });
    expect(duplicate).toEqual(fresh);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(prior.attempt);
    expect(cycles[0]).toEqual(prior.cycle);
    expect((driver as FakeClaudeSessionDriver).createdRequests).toHaveLength(1);
  });

  it.each([
    ['reject-new', 'rejection'],
    ['unblock-new', 'unblock'],
  ] as const)(
    'starts %s recovery in a reserved worktree',
    async (name, kind) => {
      const createWorktree = vi.fn(async () => ({ created: true as const }));
      const { directory, repositories, service } = setup({
        git: { createWorktree },
      });
      const prior = seedRecovery(repositories, directory, kind);

      const result = await service.reworkDeveloperNew({
        commandId: `command-${name}-worktree`,
        taskId: prior.task.id,
        expectedRevision: prior.task.revision,
        kind,
        feedback:
          kind === 'rejection'
            ? 'Address the review feedback in a fresh worktree.'
            : 'The dependency is available in a fresh worktree.',
        title: `Fresh ${name} worktree`,
        permissionMode: 'interactive',
        workspace: worktreeLaunchInput(directory).workspace,
        actor,
      });

      expect(result).toMatchObject({
        task: { lifecycleState: 'in_progress', blocked: null },
        cycle: { mode: 'new' },
        feedback: { kind },
      });
      expect(createWorktree).toHaveBeenCalledOnce();
      expect(
        repositories.workspaces.listByProject(prior.task.projectId),
      ).toContainEqual(
        expect.objectContaining({
          type: 'worktree',
          owner: 'mesh',
          cleanupState: 'active',
        }),
      );
    },
  );

  it('keeps blocker truth and closes the fresh cycle when startup fails', async () => {
    const unavailable = new Error('startup unavailable');
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => {
        throw unavailable;
      },
      resume: async () => new FakeDriverSession('unused'),
    };
    const { directory, repositories, service } = setup({ driver });
    const prior = seedRecovery(repositories, directory, 'unblock');

    await expect(
      service.reworkDeveloperNew({
        commandId: 'command-unblock-new-failed',
        taskId: prior.task.id,
        expectedRevision: prior.task.revision,
        kind: 'unblock',
        feedback: 'Dependency restored.',
        title: 'Fresh unblock attempt',
        permissionMode: 'interactive',
        workspace: { type: 'shared', path: directory },
        actor,
      }),
    ).rejects.toMatchObject({ code: 'attempt_start_failed' });

    expect(repositories.tasks.get(prior.task.id)).toEqual(prior.task);
    expect(repositories.attempts.listByTask(prior.task.id)).toHaveLength(2);
    expect(repositories.developerExecutions.listByTask(prior.task.id)).toEqual([
      prior.cycle,
      expect.objectContaining({
        mode: 'new',
        endedAt: now,
        terminalDisposition: null,
      }),
    ]);
    expect(
      repositories.database
        .prepare('SELECT kind, feedback FROM developer_review_feedback')
        .all(),
    ).toEqual([{ kind: 'unblock', feedback: 'Dependency restored.' }]);
  });

  it('restores blocker truth when fresh command completion cannot persist', async () => {
    const { capabilities, directory, driver, repositories, service } = setup({
      repositories: {
        failCommandCompleteFor: 'command-unblock-new-complete-failed',
      },
    });
    const prior = seedRecovery(repositories, directory, 'unblock');
    let issuedToken = '';
    const issue = capabilities.issue.bind(capabilities);
    vi.spyOn(capabilities, 'issue').mockImplementation((binding) => {
      issuedToken = issue(binding);
      return issuedToken;
    });
    const input = {
      commandId: 'command-unblock-new-complete-failed',
      taskId: prior.task.id,
      expectedRevision: prior.task.revision,
      kind: 'unblock' as const,
      feedback: 'Preserve the blocker if command completion fails.',
      title: 'Fresh unblock command-completion failure',
      permissionMode: 'interactive' as const,
      workspace: { type: 'shared' as const, path: directory },
      actor,
    };

    await expect(service.reworkDeveloperNew(input)).rejects.toMatchObject({
      code: 'attempt_reconciliation_required',
    });

    expect(repositories.tasks.get(prior.task.id)).toMatchObject({
      lifecycleState: 'in_progress',
      blocked: expect.objectContaining({
        reason: prior.task.blocked?.reason,
      }),
    });
    expect(repositories.developerExecutions.listByTask(prior.task.id)).toEqual([
      prior.cycle,
      expect.objectContaining({
        mode: 'new',
        endedAt: now,
        terminalDisposition: null,
      }),
    ]);
    expect(
      (driver as FakeClaudeSessionDriver).createdSessions[0]?.interrupted,
    ).toBe(true);
    expect(() => capabilities.resolve(issuedToken)).toThrow();
    const attempts = repositories.attempts.listByTask(prior.task.id);
    expect(
      repositories.diagnostics.list(attempts[1]?.sessionId ?? ''),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'developer_recovery',
          stage: 'command_completion',
          cleanup: 'interrupted',
          reconciliationRequired: true,
        }),
      }),
    );
    await expect(service.reworkDeveloperNew(input)).rejects.toMatchObject({
      code: 'command_reconciliation_required',
      state: 'pending',
    });
  });

  it('launches a Developer from an exact durable cycle before runtime start', async () => {
    const driver = new FakeClaudeSessionDriver();
    const create = driver.create.bind(driver);
    let assertRuntimeOrdering = () => undefined;
    vi.spyOn(driver, 'create').mockImplementation(async (request) => {
      assertRuntimeOrdering();
      return create(request);
    });
    const { capabilities, directory, repositories, service } = setup({
      driver,
    });
    seedTask(repositories, {
      acceptanceCriteria: [
        'Persist the execution contract.',
        'Install scoped controls.',
      ],
    });
    const project = repositories.projects.updateDeveloperInstructions(
      'project-1',
      1,
      {
        content: 'Run the focused server tests.',
        updatedAt: now,
        updatedBy: actor,
      },
    );
    expect(project?.developerInstructions.revision).toBe(2);
    const issuedTokens: string[] = [];
    const issue = capabilities.issue.bind(capabilities);
    vi.spyOn(capabilities, 'issue').mockImplementation((binding) => {
      const token = issue(binding);
      issuedTokens.push(token);
      return token;
    });
    assertRuntimeOrdering = () => {
      const [cycle] = repositories.developerExecutions.listByTask('task-1');
      expect(cycle).toBeDefined();
      expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
      expect(issuedTokens).toHaveLength(1);
      expect(capabilities.resolve(issuedTokens[0]!)).toMatchObject({
        cycleId: cycle?.id,
        taskId: 'task-1',
      });
    };

    const result = await service.launchDeveloper(
      developerLaunchInput(directory),
    );

    const [cycle] = repositories.developerExecutions.listByTask('task-1');
    expect(result).toMatchObject({
      task: { lifecycleState: 'in_progress', revision: 2 },
      attempt: { role: 'developer', source: 'launched', ordinal: 1 },
      cycle: { id: cycle?.id, ordinal: 1, mode: 'new' },
      session: { lifecycleState: 'running' },
    });
    expect(repositories.attempts.listByTask('task-1')[0]?.role).toBe(
      'developer',
    );
    expect(cycle).toMatchObject({
      ordinal: 1,
      mode: 'new',
      authorizedBy: actor,
      authorizationCommandId: 'developer-launch-1',
      policyVersion: 'developer-policy-v1',
      projectInstructions: {
        content: 'Run the focused server tests.',
        revision: 2,
      },
      taskSnapshot: {
        revision: 1,
        title: 'Implement attempt launch',
        description: 'Compose the existing session boundary safely.',
        acceptanceCriteria: [
          { id: 'criterion-1', text: 'Persist the execution contract.' },
          { id: 'criterion-2', text: 'Install scoped controls.' },
        ],
      },
      workspaceId: result.session?.workspaceId,
      permissionMode: 'interactive',
      startedAt: now,
      endedAt: null,
      terminalDisposition: null,
    });
    const request = driver.createdRequests[0];
    expect(request?.developer?.initialPrompt).toContain(
      'Title: Implement attempt launch',
    );
    expect(request?.developer?.initialPrompt).toContain(
      '[criterion-2] Install scoped controls.',
    );
    expect(request?.developer?.initialPrompt).toContain(
      'Run the focused server tests.',
    );
    expect(request?.developer?.controls.submitForReview).toBeTypeOf('function');
    expect(request?.developer?.controls.markBlocked).toBeTypeOf('function');
    expect(
      repositories.projectEvents
        .after('project-1', 0)
        .map((event) => event.type),
    ).toEqual(['task.developer_execution_changed', 'task.transitioned']);
    const serializedAudit = JSON.stringify({
      result,
      projectEvents: repositories.projectEvents.after('project-1', 0),
      diagnostics: repositories.diagnostics.list(result.session!.id),
      initialPrompt: request?.developer?.initialPrompt,
    });
    expect(serializedAudit).not.toContain(issuedTokens[0]);
  });

  it('retains failed Developer launch truth and invalidates its capability', async () => {
    const unavailable = new Error('driver unavailable');
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => {
        throw unavailable;
      },
      resume: async () => new FakeDriverSession('unused'),
    };
    const { capabilities, directory, repositories, service } = setup({
      driver,
    });
    seedTask(repositories);
    let issuedToken = '';
    const issue = capabilities.issue.bind(capabilities);
    vi.spyOn(capabilities, 'issue').mockImplementation((binding) => {
      issuedToken = issue(binding);
      return issuedToken;
    });

    await expect(
      service.launchDeveloper(developerLaunchInput(directory)),
    ).rejects.toMatchObject({ code: 'attempt_start_failed' });

    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
    expect(repositories.attempts.listByTask('task-1')[0]?.role).toBe(
      'developer',
    );
    expect(repositories.developerExecutions.listByTask('task-1')).toEqual([
      expect.objectContaining({
        ordinal: 1,
        endedAt: now,
        terminalDisposition: null,
      }),
    ]);
    expect(() => capabilities.resolve(issuedToken)).toThrowError(
      expect.objectContaining({ code: 'developer_capability_invalid' }),
    );
  });

  it('binds installed Developer controls to the launched task and cycle', async () => {
    const { directory, driver, repositories, service } = setup();
    seedTask(repositories);
    const launched = await service.launchDeveloper(
      developerLaunchInput(directory),
    );
    const cycle = launched.cycle;
    if (!cycle) throw new Error('Expected a Developer execution cycle');
    const session = launched.session;
    if (!session) throw new Error('Expected a launched Developer session');

    await (driver as FakeClaudeSessionDriver).submitForReview(0, {
      idempotencyKey: idSchema.parse('developer-review-command'),
      summary: 'Launch composition is complete.',
      criterionResults: [
        {
          criterionId: idSchema.parse('criterion-1'),
          status: 'met',
          evidence: 'Focused tests pass.',
        },
      ],
      verification: [
        {
          command: 'corepack pnpm nx test server',
          outcome: 'passed',
          output: 'Focused suite passed.',
        },
      ],
      limitations: '',
      workspaceState: {
        summary: 'Committed implementation.',
        hasUncommittedChanges: false,
        commitsCreated: true,
      },
      reviewerNotes: null,
    });

    expect(repositories.tasks.get('task-1')).toMatchObject({
      lifecycleState: 'review',
      revision: 3,
    });
    expect(repositories.developerExecutions.getCycle(cycle.id)).toMatchObject({
      terminalDisposition: 'submitted_for_review',
      terminalCommandId: expect.stringContaining(
        `${cycle.id}-developer-review-command-`,
      ),
    });
    expect(
      (driver as FakeClaudeSessionDriver).createdSessions[0]?.interrupted,
    ).toBe(true);
    expect(repositories.sessions.get(session.id)?.lifecycleState).toBe(
      'interrupted',
    );
  });

  it('keeps submit-for-review durable when runtime interruption fails', async () => {
    const emergencyClose = vi.fn(async () => undefined);
    const { directory, driver, repositories, service } = setup({
      terminalInterrupt: async () => {
        throw new Error('interrupt failed');
      },
      emergencyClose,
    });
    seedTask(repositories);
    const launched = await service.launchDeveloper(
      developerLaunchInput(directory),
    );
    const cycle = launched.cycle;
    const session = launched.session;
    if (!cycle || !session) throw new Error('Expected Developer launch');

    await (driver as FakeClaudeSessionDriver).submitForReview(0, {
      idempotencyKey: idSchema.parse('review-cleanup-failure'),
      summary: 'Work is complete.',
      criterionResults: [
        {
          criterionId: idSchema.parse('criterion-1'),
          status: 'met',
          evidence: 'Focused verification passed.',
        },
      ],
      verification: [],
      limitations: '',
      workspaceState: {
        summary: 'Work preserved.',
        hasUncommittedChanges: false,
        commitsCreated: true,
      },
      reviewerNotes: null,
    });

    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('review');
    expect(emergencyClose).toHaveBeenCalledWith(session.id);
    expect(repositories.diagnostics.list(session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            kind: 'developer_terminal_cleanup',
            cycleId: cycle.id,
            outcome: 'interrupt_failed',
          }),
        }),
      ]),
    );
  });

  it('replays only an exact cycle-scoped Developer outcome', async () => {
    const { directory, driver, repositories, service } = setup();
    seedTask(repositories);
    const launched = await service.launchDeveloper(
      developerLaunchInput(directory),
    );
    const cycle = launched.cycle;
    if (!cycle) throw new Error('Expected Developer cycle');
    const report = {
      idempotencyKey: idSchema.parse('stable-review-key'),
      summary: 'Work is complete.',
      criterionResults: [
        {
          criterionId: idSchema.parse('criterion-1'),
          status: 'met' as const,
          evidence: 'Focused verification passed.',
        },
      ],
      verification: [],
      limitations: '',
      workspaceState: {
        summary: 'Work preserved.',
        hasUncommittedChanges: false,
        commitsCreated: true,
      },
      reviewerNotes: null,
    };

    await (driver as FakeClaudeSessionDriver).submitForReview(0, report);
    await (driver as FakeClaudeSessionDriver).submitForReview(0, report);
    await expect(
      (driver as FakeClaudeSessionDriver).submitForReview(0, {
        ...report,
        summary: 'Changed payload under the same model key.',
      }),
    ).rejects.toMatchObject({ code: 'developer_capability_invalid' });

    expect(
      repositories.developerExecutions.listCompletionReportsByTask('task-1'),
    ).toHaveLength(1);
    expect(
      repositories.developerExecutions.getCycle(cycle.id)?.terminalCommandId,
    ).toContain(`${cycle.id}-stable-review-key-`);
  });

  it('keeps mark-blocked durable when runtime interruption fails', async () => {
    const emergencyClose = vi.fn(async () => undefined);
    const { directory, driver, repositories, service } = setup({
      terminalInterrupt: async () => {
        throw new Error('interrupt failed');
      },
      emergencyClose,
    });
    seedTask(repositories);
    const launched = await service.launchDeveloper(
      developerLaunchInput(directory),
    );
    const cycle = launched.cycle;
    const session = launched.session;
    if (!cycle || !session) throw new Error('Expected Developer launch');

    await (driver as FakeClaudeSessionDriver).markBlocked(0, {
      idempotencyKey: idSchema.parse('block-cleanup-failure'),
      reason: 'A dependency is missing.',
      evidence: 'The dependency probe failed.',
      attemptedWork: 'Checked the local workspace.',
      suggestedHumanAction: 'Provide the dependency.',
      preserveWorkspace: true,
    });

    expect(repositories.tasks.get('task-1')).toMatchObject({
      lifecycleState: 'in_progress',
      blocked: { reason: 'A dependency is missing.' },
    });
    expect(emergencyClose).toHaveBeenCalledWith(session.id);
    expect(repositories.diagnostics.list(session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            kind: 'developer_terminal_cleanup',
            cycleId: cycle.id,
            outcome: 'interrupt_failed',
          }),
        }),
      ]),
    );
  });

  it('does not issue Developer controls when the launch audit fails', async () => {
    const { capabilities, directory, driver, repositories, service } = setup({
      repositories: { failProjectEventInsert: true },
    });
    seedTask(repositories);
    const issue = vi.spyOn(capabilities, 'issue');

    await expect(
      service.launchDeveloper(developerLaunchInput(directory)),
    ).rejects.toMatchObject({ code: 'audit_unavailable' });

    expect(issue).not.toHaveBeenCalled();
    expect(repositories.developerExecutions.listByTask('task-1')).toEqual([]);
    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
  });

  it('interrupts a failed post-start Developer worktree and invalidates controls', async () => {
    const { capabilities, directory, driver, repositories, service } = setup({
      repositories: { failTaskTransitionInsert: true },
      git: { createWorktree: async () => ({ created: true }) },
    });
    seedTask(repositories);
    let issuedToken = '';
    const issue = capabilities.issue.bind(capabilities);
    vi.spyOn(capabilities, 'issue').mockImplementation((binding) => {
      issuedToken = issue(binding);
      return issuedToken;
    });

    await expect(
      service.launchDeveloper({
        ...developerLaunchInput(directory),
        workspace: worktreeLaunchInput(directory).workspace,
      }),
    ).rejects.toMatchObject({ code: 'attempt_start_failed' });

    expect(
      (driver as FakeClaudeSessionDriver).createdSessions[0]?.interrupted,
    ).toBe(true);
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
    expect(repositories.workspaces.listByProject('project-1')).toEqual([
      expect.objectContaining({
        owner: 'mesh',
        cleanupState: 'active',
      }),
    ]);
    expect(() => capabilities.resolve(issuedToken)).toThrowError(
      expect.objectContaining({ code: 'developer_capability_invalid' }),
    );
  });

  it('interrupts and invalidates a Developer when command completion cannot persist', async () => {
    const { capabilities, directory, driver, repositories, service } = setup({
      repositories: { failCommandCompleteFor: 'developer-launch-1' },
    });
    seedTask(repositories);
    let issuedToken = '';
    const issue = capabilities.issue.bind(capabilities);
    vi.spyOn(capabilities, 'issue').mockImplementation((binding) => {
      issuedToken = issue(binding);
      return issuedToken;
    });

    await expect(
      service.launchDeveloper(developerLaunchInput(directory)),
    ).rejects.toThrow('command complete failed');

    expect(
      (driver as FakeClaudeSessionDriver).createdSessions[0]?.interrupted,
    ).toBe(true);
    expect(repositories.tasks.get('task-1')).toMatchObject({
      lifecycleState: 'in_progress',
      revision: 2,
    });
    expect(repositories.developerExecutions.listByTask('task-1')).toEqual([
      expect.objectContaining({ ordinal: 1, terminalDisposition: null }),
    ]);
    expect(() => capabilities.resolve(issuedToken)).toThrowError(
      expect.objectContaining({ code: 'developer_capability_invalid' }),
    );
    await expect(
      service.launchDeveloper(developerLaunchInput(directory)),
    ).rejects.toMatchObject({
      code: 'command_reconciliation_required',
      state: 'pending',
    });
  });

  it('durably admits only one concurrent launch for a task revision', async () => {
    const { directory, repositories, service } = setup();
    seedTask(repositories);

    const [first, second] = await Promise.allSettled([
      service.launch(launchInput(directory)),
      service.launch({
        ...launchInput(directory),
        commandId: 'attempt-launch-2',
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(repositories.attempts.listByTask('task-1')).toHaveLength(1);
  });

  it('retains the session and attempt but leaves the task ready when startup fails', async () => {
    const unavailable = new Error('driver unavailable');
    const driver: ClaudeSessionDriver = {
      discover: async () => [],
      create: async () => {
        throw unavailable;
      },
      resume: async () => new FakeDriverSession('unused'),
    };
    const { directory, repositories, service } = setup({ driver });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'attempt_start_failed',
    });

    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
    expect(repositories.attempts.listByTask('task-1')).toHaveLength(1);
    expect(repositories.sessions.listByProject('project-1')).toHaveLength(1);
    expect(
      repositories.diagnostics.list(requireOnlyAttempt(repositories).sessionId),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          stage: 'startup',
          outcome: 'failed',
        }),
      }),
    ]);
  });

  it.each([
    [
      'not ready',
      { lifecycleState: 'backlog' as const },
      'task_transition_invalid',
    ],
    [
      'blocked',
      {
        blocked: { reason: 'Waiting', actor, blockedAt: now },
      },
      'task_blocked',
    ],
  ])(
    'rejects a %s task before creating a session',
    async (_name, patch, code) => {
      const { directory, driver, repositories, service } = setup();
      seedTask(repositories, patch);

      await expect(
        service.launch(launchInput(directory)),
      ).rejects.toMatchObject({
        code,
      });

      expect(repositories.sessions.listByProject('project-1')).toEqual([]);
      expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
    },
  );

  it('rejects a stale revision before creating a session', async () => {
    const { directory, driver, repositories, service } = setup();
    seedTask(repositories, { revision: 2 });

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'task_revision_conflict',
    });

    expect(repositories.sessions.listByProject('project-1')).toEqual([]);
    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
  });

  it('does not start a runtime when the attempt audit transaction fails', async () => {
    const { directory, driver, repositories, service } = setup({
      repositories: { failProjectEventInsert: true },
    });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'audit_unavailable',
    });

    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
    expect(repositories.sessions.listByProject('project-1')).toEqual([]);
    expect(repositories.attempts.listByTask('task-1')).toEqual([]);
  });

  it('retains durable worktree ownership when creation succeeds but attempt audit fails', async () => {
    let verifyReservation = () => undefined;
    const { directory, driver, repositories, service } = setup({
      repositories: { failProjectEventInsert: true },
      git: {
        createWorktree: async () => {
          verifyReservation();
          return { created: true };
        },
      },
    });
    seedTask(repositories);
    verifyReservation = () => {
      const [workspace] = repositories.workspaces.listByProject('project-1');
      expect(workspace).toMatchObject({
        owner: 'mesh',
        cleanupState: 'pending',
      });
      expect(repositories.sessions.listByProject('project-1')).toEqual([
        expect.objectContaining({ workspaceId: workspace?.id }),
      ]);
    };

    await expect(
      service.launch(worktreeLaunchInput(directory)),
    ).rejects.toMatchObject({ code: 'workspace_preserved' });

    const [workspace] = repositories.workspaces.listByProject('project-1');
    const [session] = repositories.sessions.listByProject('project-1');
    expect(workspace).toMatchObject({
      projectId: 'project-1',
      path: join(directory, 'attempt-worktree'),
      owner: 'mesh',
      cleanupState: 'pending',
    });
    expect(session).toMatchObject({
      projectId: 'project-1',
      workspaceId: workspace?.id,
    });
    expect(repositories.attempts.listByTask('task-1')).toEqual([]);
    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
    expect(repositories.diagnostics.list(session?.id ?? '')).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          stage: 'attempt_audit',
          outcome: 'workspace_preserved',
        }),
      }),
    );
  });

  it.each([
    [
      'revision change',
      'task_revision_conflict',
      (repositories: ReturnType<typeof createTestRepositories>) => {
        repositories.database
          .prepare('UPDATE tasks SET revision = revision + 1 WHERE id = ?')
          .run('task-1');
      },
    ],
    [
      'blocked change',
      'task_blocked',
      (repositories: ReturnType<typeof createTestRepositories>) => {
        repositories.database
          .prepare('UPDATE tasks SET blocked_json = ? WHERE id = ?')
          .run(
            JSON.stringify({
              reason: 'Concurrent block',
              actor,
              blockedAt: now,
            }),
            'task-1',
          );
      },
    ],
    [
      'lifecycle change',
      'task_transition_invalid',
      (repositories: ReturnType<typeof createTestRepositories>) => {
        repositories.database
          .prepare("UPDATE tasks SET lifecycle_state = 'backlog' WHERE id = ?")
          .run('task-1');
      },
    ],
    [
      'project archive',
      'project_archived',
      (repositories: ReturnType<typeof createTestRepositories>) => {
        repositories.database
          .prepare('UPDATE projects SET archived_at = ? WHERE id = ?')
          .run(now, 'project-1');
      },
    ],
  ])(
    'preserves the stable conflict when async workspace preparation observes a %s',
    async (_name, code, mutate) => {
      let applyConcurrentChange = () => undefined;
      const context = setup({
        git: {
          createWorktree: async () => {
            applyConcurrentChange();
            return { created: true };
          },
        },
      });
      seedTask(context.repositories);
      applyConcurrentChange = () => mutate(context.repositories);

      await expect(
        context.service.launch(worktreeLaunchInput(context.directory)),
      ).rejects.toMatchObject({ code });

      expect(
        (context.driver as FakeClaudeSessionDriver).createdRequests,
      ).toEqual([]);
      expect(
        context.repositories.workspaces.listByProject('project-1'),
      ).toEqual([
        expect.objectContaining({ owner: 'mesh', cleanupState: 'pending' }),
      ]);
    },
  );

  it('preserves a worktree when filesystem creation does not complete', async () => {
    const { directory, driver, repositories, service } = setup({
      git: {
        createWorktree: async () => {
          throw new Error('git worktree add failed');
        },
      },
    });
    seedTask(repositories);

    await expect(
      service.launch({
        ...launchInput(directory),
        workspace: {
          type: 'worktree',
          repositoryPath: directory,
          path: join(directory, 'attempt-worktree'),
          branch: 'attempt-branch',
          startPoint: 'HEAD',
        },
      }),
    ).rejects.toMatchObject({ code: 'workspace_preserved' });

    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
    const [workspace] = repositories.workspaces.listByProject('project-1');
    const [session] = repositories.sessions.listByProject('project-1');
    expect(workspace).toMatchObject({ owner: 'mesh', cleanupState: 'pending' });
    expect(session).toMatchObject({ workspaceId: workspace?.id });
    expect(repositories.diagnostics.list(session?.id ?? '')).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          stage: 'workspace_creation',
          outcome: 'workspace_preserved',
        }),
      }),
    );
  });

  it('rejects launch when the imported project repository is missing', async () => {
    const { directory, driver, repositories, service } = setup({
      git: {
        createWorktree: async () => ({ created: true }),
      },
    });
    seedTask(repositories);
    const project = repositories.projects.get('project-1');
    if (!project) throw new Error('Expected project fixture');
    const missingRepositoryPath = join(directory, 'deleted-project');
    repositories.projects.update(
      { ...project, repositoryPath: missingRepositoryPath },
      project.revision,
    );

    await expect(
      service.launch({
        ...worktreeLaunchInput(directory),
        workspace: {
          ...worktreeLaunchInput(directory).workspace,
          repositoryPath: missingRepositoryPath,
        },
      }),
    ).rejects.toMatchObject({ code: 'repository_invalid' });

    expect((driver as FakeClaudeSessionDriver).createdRequests).toEqual([]);
    expect(repositories.workspaces.listByProject('project-1')).toEqual([]);
    expect(repositories.sessions.listByProject('project-1')).toEqual([]);
  });

  it('interrupts and diagnoses the runtime when the task transition audit fails', async () => {
    const { directory, driver, repositories, service } = setup({
      repositories: { failTaskTransitionInsert: true },
    });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'attempt_start_failed',
    });

    expect(
      (driver as FakeClaudeSessionDriver).createdSessions[0]?.interrupted,
    ).toBe(true);
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
    const attempt = requireOnlyAttempt(repositories);
    expect(repositories.diagnostics.list(attempt.sessionId)).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          stage: 'task_transition',
          cleanup: 'interrupted',
        }),
      }),
    );
  });

  it('requires reconciliation when post-start interruption cannot be proven', async () => {
    const { directory, repositories, service } = setup({
      repositories: { failTaskTransitionInsert: true },
      interrupt: async () => {
        throw new Error('interrupt outcome unknown');
      },
    });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'attempt_reconciliation_required',
    });

    const attempt = requireOnlyAttempt(repositories);
    expect(repositories.diagnostics.list(attempt.sessionId)).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          stage: 'task_transition',
          cleanup: 'unknown',
        }),
      }),
    );
  });

  it('interrupts the runtime and requires reconciliation when transition diagnostics fail', async () => {
    const { directory, driver, repositories, service } = setup({
      repositories: {
        failTaskTransitionInsert: true,
        failDiagnosticInsert: true,
      },
    });
    seedTask(repositories);

    await expect(service.launch(launchInput(directory))).rejects.toMatchObject({
      code: 'attempt_reconciliation_required',
    });

    expect(
      (driver as FakeClaudeSessionDriver).createdSessions[0]?.interrupted,
    ).toBe(true);
    expect(repositories.tasks.get('task-1')?.lifecycleState).toBe('ready');
    expect(
      repositories.diagnostics.list(requireOnlyAttempt(repositories).sessionId),
    ).toEqual([]);
  });

  it('links a same-repository session without changing task lifecycle', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);
    seedSession(repositories);

    const result = await service.link({
      commandId: 'attempt-link-1',
      taskId: 'task-1',
      expectedRevision: 1,
      sessionId: 'session-1',
      actor,
    });

    expect(result).toMatchObject({
      task: { lifecycleState: 'ready', revision: 1 },
      attempt: { sessionId: 'session-1', source: 'linked', ordinal: 1 },
    });
    expect(repositories.tasks.get('task-1')).toMatchObject({
      lifecycleState: 'ready',
      revision: 1,
    });
  });

  it('replays a completed manual link before checking changed task state', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);
    seedSession(repositories);
    const input = {
      commandId: 'attempt-link-replay',
      taskId: 'task-1',
      expectedRevision: 1,
      sessionId: 'session-1',
      actor,
    };
    const first = await service.link(input);
    repositories.projects.archive('project-1', now);

    const replay = await service.link(input);

    expect(replay).toEqual(first);
    expect(repositories.attempts.listByTask('task-1')).toHaveLength(1);
  });

  it('rejects cross-repository and already-linked sessions', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-2',
        displayName: 'Project two',
        repositoryPath: 'C:/different',
        repositoryIdentity: 'repository-2',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    seedSession(repositories, { projectId: 'project-2', sessionId: 'other' });

    await expect(
      service.link({
        commandId: 'attempt-link-cross',
        taskId: 'task-1',
        expectedRevision: 1,
        sessionId: 'other',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'session_repository_mismatch' });

    seedSession(repositories);
    repositories.attempts.createForTask('task-1', 'session-1', 'linked', actor);
    await expect(
      service.link({
        commandId: 'attempt-link-duplicate',
        taskId: 'task-1',
        expectedRevision: 1,
        sessionId: 'session-1',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'session_already_linked' });
  });

  it('requires an unlink reason and preserves both rows when relinking', async () => {
    const { repositories, service } = setup();
    seedTask(repositories);
    seedSession(repositories);
    const first = await service.link({
      commandId: 'attempt-link-first',
      taskId: 'task-1',
      expectedRevision: 1,
      sessionId: 'session-1',
      actor,
    });

    await expect(
      service.unlink({
        commandId: 'attempt-unlink-empty',
        taskId: 'task-1',
        expectedRevision: 1,
        attemptId: first.attempt.id,
        reason: ' ',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_command' });

    const unlinked = await service.unlink({
      commandId: 'attempt-unlink-1',
      taskId: 'task-1',
      expectedRevision: 1,
      attemptId: first.attempt.id,
      reason: 'Linked to the wrong task',
      actor,
    });
    const second = await service.link({
      commandId: 'attempt-link-second',
      taskId: 'task-1',
      expectedRevision: 1,
      sessionId: 'session-1',
      actor,
    });

    expect(unlinked.attempt).toMatchObject({
      unlinkReason: 'Linked to the wrong task',
      unlinkedBy: actor,
    });
    expect(second.attempt.ordinal).toBe(2);
    expect(repositories.attempts.listByTask('task-1')).toEqual([
      unlinked.attempt,
      second.attempt,
    ]);
  });

  it('never unlinks an attempt created by launch', async () => {
    const { directory, repositories, service } = setup();
    seedTask(repositories);
    const launched = await service.launch(launchInput(directory));

    await expect(
      service.unlink({
        commandId: 'attempt-unlink-launched',
        taskId: 'task-1',
        expectedRevision: launched.task.revision,
        attemptId: launched.attempt.id,
        reason: 'Must remain attached',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_command' });
    expect(
      repositories.attempts.listByTask('task-1')[0]?.unlinkedAt,
    ).toBeNull();
  });

  it('verifies the current Developer attempt workspace without creating another workspace', async () => {
    const { directory, repositories, service } = setup();
    seedTask(repositories);
    const launched = await service.launchDeveloper(
      developerLaunchInput(directory),
    );
    if (!launched.session) throw new Error('Expected Developer session');

    const verified = await service.requireQaWorkspace({
      taskId: launched.task.id,
      attemptId: launched.attempt.id,
      workspaceId: launched.session.workspaceId,
    });

    expect(verified).toEqual({
      attempt: launched.attempt,
      session: launched.session,
      workspace: repositories.workspaces.get(launched.session.workspaceId),
    });
    expect(repositories.workspaces.listByProject('project-1')).toHaveLength(1);
  });
});
