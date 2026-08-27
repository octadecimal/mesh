import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DeveloperResumeUnavailableError,
  QaAlreadyActiveError,
  QaCapabilityInvalidError,
  QaRejectionCeilingReachedError,
  QaReportIncompleteError,
  ReviewAutomationPausedError,
  UnsafeQaWorkspaceError,
  developerExecutionCycleSchema,
  idSchema,
  projectSchema,
  projectRunSchema,
  qaExecutionCycleSchema,
  qaReportSchema,
  reviewAutomationActionSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  type ProjectRun,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { FakeClaudeSessionDriver } from '../claude/fake-driver.js';
import {
  NodeProcessRunner,
  resolveGitExecutableAtStartup,
} from '../platform/process-runner.js';
import { QaVerificationRunner } from '../platform/qa-verification-runner.js';
import {
  resolveRepositoryIdentity,
  type RepositoryIdentityResolver,
} from '../projects/repository-identity.js';
import { SessionRegistry } from '../runtime/session-registry.js';
import { TaskService } from '../tasks/task-service.js';
import { AttemptService } from '../tasks/attempt-service.js';
import { DeveloperCapabilityRegistry } from '../tasks/developer-capability-registry.js';
import { DeveloperExecutionService } from '../tasks/developer-execution-service.js';
import { DeveloperReworkService } from '../tasks/developer-rework-service.js';
import { QaCapabilityRegistry } from '../tasks/qa-capability-registry.js';
import { QaExecutionService } from '../tasks/qa-execution-service.js';
import { ProjectRunService } from '../tasks/project-run-service.js';
import { ReviewAutomationService } from '../tasks/review-automation-service.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { executeCommand } from './command-handler.js';
import { toHttpError } from './errors.js';

const now = '2026-08-24T00:00:00.000Z';
const exec = promisify(execFile);

const runGit = async (cwd: string, ...args: string[]) => {
  await exec('git', args, { cwd, windowsHide: true });
};

describe('executeCommand', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let resolveIdentity: RepositoryIdentityResolver;

  beforeAll(async () => {
    const trustedGitExecutable = await resolveGitExecutableAtStartup({
      pathValue: process.env.PATH,
      workspaceRoot: tmpdir(),
    });
    if (!trustedGitExecutable) {
      throw new Error('Expected an approved test Git executable');
    }
    const processRunner = new NodeProcessRunner({ trustedGitExecutable });
    resolveIdentity = (repositoryPath, pathOptions) =>
      resolveRepositoryIdentity(repositoryPath, pathOptions, processRunner);
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const createRepository = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mesh-command-project-'));
    const repositoryPath = join(directory, 'repository');
    await runGit(directory, 'init', repositoryPath);
    await writeFile(join(repositoryPath, 'README.md'), 'repository\n');
    await runGit(repositoryPath, 'add', 'README.md');
    await runGit(
      repositoryPath,
      '-c',
      'user.name=Mesh Test',
      '-c',
      'user.email=mesh@example.test',
      'commit',
      '-m',
      'initial',
    );
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return { directory, repositoryPath };
  };

  const commandDependencies = (
    baseDirectory: string,
    createId: () => string = () => 'project-created',
  ) => {
    const repositories = createTestRepositories();
    const driver = new FakeClaudeSessionDriver();
    const capabilities = new DeveloperCapabilityRegistry();
    const qaCapabilities = new QaCapabilityRegistry();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      invalidateDeveloperCapability: (sessionId) => {
        capabilities.invalidateSession(sessionId);
        qaCapabilities.invalidateSession(sessionId);
      },
      closeDatabase: () => undefined,
    });
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
      registry,
      now: () => now,
      createId,
    });
    const pathOptions = { baseDirectory };
    const attemptService = new AttemptService({
      ...repositories,
      taskService,
      capabilities,
      developerReworkService,
      registry,
      pathOptions,
      resolveIdentity,
      now: () => now,
      createId,
    });
    const projectRunService = new ProjectRunService({
      ...repositories,
      attemptService,
      publisher: registry.publisher,
      now: () => now,
      createId,
    });
    const qaExecutionService = new QaExecutionService({
      ...repositories,
      attemptService,
      capabilities: qaCapabilities,
      registry,
      verificationRunner: new QaVerificationRunner({
        run: async (_executable, args) => ({
          exitCode: 0,
          stdout: args.includes('rev-parse') ? 'true\n' : '',
          stderr: '',
        }),
      }),
      now: () => now,
      createId,
    });
    const reviewAutomationService = new ReviewAutomationService({
      ...repositories,
      qaExecutionService,
      developerReworkService,
      publisher: registry.publisher,
      now: () => now,
      createId,
    });
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    return {
      repositories,
      dependencies: {
        ...repositories,
        taskService,
        attemptService,
        developerExecutionService,
        qaExecutionService,
        reviewAutomationService,
        projectRunService,
        registry,
        driver,
        pathOptions,
        resolveIdentity,
        now: () => now,
        createId,
      },
    };
  };

  const projectCommand = (idempotencyKey: string, command: unknown) => ({
    protocolVersion: 1,
    idempotencyKey,
    command,
  });

  it('dispatches all project-run controls and schedules only runnable outcomes', async () => {
    const fixture = commandDependencies(tmpdir());
    const actor = { type: 'human' as const, id: 'operator-run' };
    const run = (
      state: 'running' | 'paused' | 'draining',
      revision: number,
    ): ProjectRun =>
      projectRunSchema.parse({
        id: 'run-1',
        projectId: 'project-run',
        revision,
        concurrency: 2,
        state,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        completionReason: null,
        items: [],
      });
    const inputs: unknown[] = [];
    const drained: string[] = [];
    const projectRunService = {
      startRun: (input: unknown) => {
        inputs.push(input);
        return { run: run('running', 1), events: [] };
      },
      pauseRun: (input: unknown) => {
        inputs.push(input);
        return { run: run('paused', 2), events: [] };
      },
      resumeRun: (input: unknown) => {
        inputs.push(input);
        return { run: run('running', 3), events: [] };
      },
      stopRun: (input: unknown) => {
        inputs.push(input);
        return { run: run('draining', 4), events: [] };
      },
      drainAvailableSlots: async (runId: string) => {
        drained.push(runId);
        return run('running', 3);
      },
      observeTaskOutcome: async () => undefined,
    };
    const execute = (idempotencyKey: string, command: unknown) =>
      executeCommand(projectCommand(idempotencyKey, command), {
        ...fixture.dependencies,
        projectRunService,
      });

    const started = await execute('start-run-command', {
      type: 'project.run.start',
      payload: { projectId: 'project-run', concurrency: 2, actor },
    });
    const paused = await execute('pause-run-command', {
      type: 'project.run.pause',
      payload: { runId: 'run-1', expectedRevision: 1, actor },
    });
    const resumed = await execute('resume-run-command', {
      type: 'project.run.resume',
      payload: { runId: 'run-1', expectedRevision: 2, actor },
    });
    const stopped = await execute('stop-run-command', {
      type: 'project.run.stop',
      payload: { runId: 'run-1', expectedRevision: 3, actor },
    });

    expect(started.result).toEqual({ run: run('running', 1) });
    expect(paused.result).toEqual({ run: run('paused', 2) });
    expect(resumed.result).toEqual({ run: run('running', 3) });
    expect(stopped.result).toEqual({ run: run('draining', 4) });
    expect(inputs).toEqual([
      {
        projectId: 'project-run',
        concurrency: 2,
        actor,
        idempotencyKey: 'start-run-command',
      },
      {
        runId: 'run-1',
        expectedRevision: 1,
        actor,
        idempotencyKey: 'pause-run-command',
      },
      {
        runId: 'run-1',
        expectedRevision: 2,
        actor,
        idempotencyKey: 'resume-run-command',
      },
      {
        runId: 'run-1',
        expectedRevision: 3,
        actor,
        idempotencyKey: 'stop-run-command',
      },
    ]);
    expect(drained).toEqual(['run-1', 'run-1']);
  });

  it('rejects non-human project-run authority at the command boundary', async () => {
    const fixture = commandDependencies(tmpdir());

    const error = await executeCommand(
      projectCommand('start-run-system', {
        type: 'project.run.start',
        payload: {
          projectId: 'project-run',
          concurrency: 1,
          actor: { type: 'system', id: 'scheduler' },
        },
      }),
      fixture.dependencies,
    ).catch(toHttpError);

    expect(error).toMatchObject({
      statusCode: 400,
      body: { error: { code: 'invalid_command' } },
    });
  });

  it('dispatches manual QA launch without exposing runtime capabilities', async () => {
    const { directory } = await createRepository();
    const { dependencies } = commandDependencies(directory);
    let launchInput: unknown;
    (dependencies as { qaExecutionService: unknown }).qaExecutionService = {
      launch: async (input: unknown) => {
        launchInput = input;
        return {
          task: { id: 'task-1' },
          attempt: { id: 'attempt-1' },
          session: { id: 'qa-session-1' },
          cycle: { id: 'qa-cycle-1' },
          event: { sequence: 7 },
          capability: 'must-not-leak',
          driver: { internal: true },
        };
      },
      submitVerdict: () => undefined,
    };

    const result = await executeCommand(
      projectCommand('qa-launch-command', {
        type: 'task.qa.launch',
        payload: {
          taskId: 'task-1',
          expectedRevision: 4,
          actor: { type: 'human', id: 'operator-1' },
        },
      }),
      dependencies,
    );

    expect(launchInput).toEqual({
      commandId: 'qa-launch-command',
      taskId: 'task-1',
      expectedRevision: 4,
      actor: { type: 'human', id: 'operator-1' },
      trigger: 'manual',
    });
    expect(result).toEqual({
      protocolVersion: 1,
      commandType: 'task.qa.launch',
      result: {
        task: { id: 'task-1' },
        attempt: { id: 'attempt-1' },
        session: { id: 'qa-session-1' },
        cycle: { id: 'qa-cycle-1' },
        event: { sequence: 7 },
        projectEventCursor: 7,
      },
      warnings: [],
    });
  });

  it('routes an audited human interrupted-cycle repair', async () => {
    const { directory } = await createRepository();
    const { dependencies } = commandDependencies(directory);
    let repairInput: unknown;
    (dependencies as { qaExecutionService: unknown }).qaExecutionService = {
      launch: async () => undefined,
      submitVerdict: () => undefined,
      repairInterrupted: (input: unknown) => {
        repairInput = input;
        return {
          task: { id: 'task-1' },
          attempt: { id: 'attempt-1' },
          cycle: { id: 'qa-cycle-1', terminalDisposition: 'interrupted' },
          event: { sequence: 8 },
          events: [{ sequence: 8 }],
        };
      },
    };

    const result = await executeCommand(
      projectCommand('qa-repair-command', {
        type: 'task.qa.repair_interrupted',
        payload: {
          taskId: 'task-1',
          cycleId: 'qa-cycle-1',
          expectedRevision: 4,
          actor: { type: 'human', id: 'operator-1' },
        },
      }),
      dependencies,
    );

    expect(repairInput).toEqual({
      commandId: 'qa-repair-command',
      taskId: 'task-1',
      cycleId: 'qa-cycle-1',
      expectedRevision: 4,
      actor: { type: 'human', id: 'operator-1' },
    });
    expect(result).toMatchObject({
      commandType: 'task.qa.repair_interrupted',
      result: { projectEventCursor: 8 },
    });
  });

  it('routes human automation enable and pause through the domain service', async () => {
    const { directory } = await createRepository();
    let nextId = 0;
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => `automation-http-${++nextId}`,
    );
    const observedTaskIds: string[] = [];
    (dependencies as { projectRunService: unknown }).projectRunService = {
      observeTaskOutcome: async (taskId: string) => {
        observedTaskIds.push(taskId);
      },
    };
    const project = repositories.projects.create(
      projectSchema.parse({
        id: 'project-automation',
        displayName: 'Automation project',
        repositoryPath: directory,
        discoveredAt: now,
        discoveryMetadata: {},
        qaConfiguration: {
          instructions: {
            content: 'Verify the task.',
            revision: 1,
            updatedAt: now,
            updatedBy: { type: 'human', id: 'operator-1' },
          },
          reviewPolicy: 'autonomous_review',
          revision: 1,
          updatedAt: now,
          updatedBy: { type: 'human', id: 'operator-1' },
        },
      }),
    );
    const task = repositories.tasks.create(
      taskSchema.parse({
        id: 'task-automation',
        projectId: project.id,
        title: 'Control automation',
        description: '',
        acceptanceCriteria: ['Controls are durable.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'review',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const actor = { type: 'human' as const, id: 'operator-1' };
    const enable = projectCommand('enable-automation-command', {
      type: 'task.review_automation.enable',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        actor,
      },
    });

    const enabled = await executeCommand(enable, dependencies);
    const duplicate = await executeCommand(enable, dependencies);
    const enabledTask = repositories.tasks.get(task.id);
    if (!enabledTask) throw new Error('Expected enabled task');
    const paused = await executeCommand(
      projectCommand('pause-automation-command', {
        type: 'task.review_automation.pause',
        payload: {
          taskId: task.id,
          expectedRevision: enabledTask.revision,
          actor,
        },
      }),
      dependencies,
    );

    expect(duplicate).toEqual(enabled);
    expect(enabled).toMatchObject({
      commandType: 'task.review_automation.enable',
      result: { task: { reviewAutomation: { status: 'enabled' } } },
    });
    expect(paused).toMatchObject({
      commandType: 'task.review_automation.pause',
      result: { task: { reviewAutomation: { status: 'paused' } } },
    });
    expect(observedTaskIds).toEqual([task.id]);

    const conflict = await executeCommand(
      projectCommand('pause-automation-stale', {
        type: 'task.review_automation.pause',
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          actor,
        },
      }),
      dependencies,
    ).catch((error: unknown) => error);
    expect(toHttpError(conflict)).toMatchObject({
      statusCode: 409,
      body: {
        error: {
          code: 'task_revision_conflict',
          details: {
            task: {
              id: task.id,
              revision: task.revision + 2,
              reviewAutomation: { status: 'paused' },
            },
          },
        },
      },
    });
  });

  it('delegates verdict follow-up ownership and returns durable pause truth on failure', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'project-rejected',
        displayName: 'Rejected project',
        repositoryPath: directory,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const task = repositories.tasks.create(
      taskSchema.parse({
        id: 'task-rejected',
        projectId: 'project-rejected',
        title: 'Rejected task',
        description: '',
        acceptanceCriteria: ['QA evidence is retained.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'review',
        labels: [],
        notes: '',
        blocked: null,
        revision: 3,
        createdAt: now,
        updatedAt: now,
        reviewAutomation: {
          status: 'enabled',
          generation: 1,
          rejectionCount: 1,
          pauseReason: null,
          updatedAt: now,
        },
      }),
    );
    const committed = {
      task,
      attempt: { id: 'attempt-1' },
      cycle: {
        id: 'qa-cycle-rejected',
        reviewPolicy: 'manual',
        rejectionOrdinal: 0,
      },
      report: { disposition: 'rejected' },
      event: { sequence: 8 },
      events: [{ sequence: 8 }],
    };
    (dependencies as { qaExecutionService: unknown }).qaExecutionService = {
      launch: async () => undefined,
      submitVerdict: () => committed,
    };
    (
      dependencies as { reviewAutomationService: unknown }
    ).reviewAutomationService = {
      afterQaVerdict: async () => {
        const current = repositories.tasks.get(task.id);
        if (!current) throw new Error('Expected current task');
        repositories.tasks.update(
          {
            ...current,
            reviewAutomation: {
              ...current.reviewAutomation,
              status: 'paused',
              pauseReason: 'Developer resume unavailable.',
            },
          },
          current.revision,
        );
        throw new DeveloperResumeUnavailableError();
      },
    };

    const result = await executeCommand(
      projectCommand('qa-verdict-command', {
        type: 'task.qa.submit_verdict',
        payload: {
          capability: 'qa-capability-1',
          expectedRevision: task.revision,
          report: {
            disposition: 'rejected',
            criterionResults: [
              {
                criterionId: 'criterion-1',
                status: 'failed',
                evidence: 'Focused test failed.',
              },
            ],
            limitations: [],
            residualRisks: ['Regression remains.'],
          },
          actor: { type: 'agent', id: 'qa-agent-1' },
        },
      }),
      dependencies,
    );

    expect(result).toMatchObject({
      commandType: 'task.qa.submit_verdict',
      result: {
        task: {
          id: task.id,
          reviewAutomation: {
            status: 'paused',
            pauseReason: 'Developer resume unavailable.',
          },
        },
        report: { disposition: 'rejected' },
        projectEventCursor: 8,
      },
      warnings: [{ code: 'developer_resume_unavailable' }],
    });
  });

  it('replays a failed verdict follow-up without resuming or emitting again', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    const project = repositories.projects.create(
      projectSchema.parse({
        id: 'project-replay',
        displayName: 'Replay project',
        repositoryPath: directory,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.projects.updateQaConfiguration(
      project.id,
      project.qaConfiguration.revision,
      {
        instructions: { content: 'Verify replay.' },
        reviewPolicy: 'autonomous_review',
      },
      taskActorSchema.parse({ type: 'human', id: 'operator-1' }),
    );
    const task = repositories.tasks.create(
      taskSchema.parse({
        id: 'task-replay',
        projectId: project.id,
        title: 'Replay failed follow-up',
        description: '',
        acceptanceCriteria: ['Failure replay remains stable.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'review',
        labels: [],
        notes: '',
        blocked: null,
        revision: 3,
        createdAt: now,
        updatedAt: now,
        reviewAutomation: {
          status: 'enabled',
          generation: 1,
          rejectionCount: 1,
          pauseReason: null,
          updatedAt: now,
        },
      }),
    );
    const workspace = repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-replay',
        projectId: project.id,
        type: 'shared',
        path: directory,
      }),
    );
    const developerSession = repositories.sessions.create(
      sessionSchema.parse({
        id: 'developer-session-replay',
        projectId: project.id,
        workspaceId: workspace.id,
        title: 'Developer replay',
        permissionMode: 'safe_auto',
        lifecycleState: 'interrupted',
        claudeResumeId: 'claude-developer-replay',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = repositories.attempts.createForTask(
      task.id,
      developerSession.id,
      'launched',
      taskActorSchema.parse({ type: 'human', id: 'operator-1' }),
      'developer',
    );
    const qaSession = repositories.sessions.create(
      sessionSchema.parse({
        id: 'qa-session-replay',
        projectId: project.id,
        workspaceId: workspace.id,
        title: 'QA replay',
        permissionMode: 'safe_auto',
        lifecycleState: 'interrupted',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const startedCycle = repositories.qaExecutions.createCycle(
      qaExecutionCycleSchema.parse({
        id: 'qa-cycle-replay',
        taskId: task.id,
        attemptId: attempt.id,
        sessionId: qaSession.id,
        ordinal: 1,
        authorizedBy: { type: 'system', id: 'review-loop' },
        authorizationCommandId: 'qa-launch-replay',
        policyVersion: 'qa-policy-v1',
        qaInstructions: { content: 'Verify replay.', revision: 1 },
        taskSnapshot: {
          revision: task.revision,
          title: task.title,
          description: task.description,
          acceptanceCriteria: [
            { id: 'criterion-1', text: task.acceptanceCriteria[0] },
          ],
        },
        developerCompletionReportId: 'developer-report-replay',
        workspaceId: workspace.id,
        reviewPolicy: 'autonomous_review',
        reviewPolicyRevision: 1,
        automationGeneration: 1,
        rejectionOrdinal: 0,
        startedAt: now,
        endedAt: null,
        terminalDisposition: null,
        reportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      }),
    );
    const report = repositories.qaExecutions.insertReport(
      qaReportSchema.parse({
        id: 'qa-report-replay',
        cycleId: startedCycle.id,
        disposition: 'rejected',
        criterionResults: [
          {
            criterionId: 'criterion-1',
            status: 'failed',
            evidence: 'Focused test failed.',
          },
        ],
        verificationCommands: [],
        limitations: [],
        residualRisks: ['Regression remains.'],
        workspaceBefore: 'source-state-1',
        workspaceAfter: 'source-state-1',
        createdAt: now,
      }),
    );
    const cycle = repositories.qaExecutions.completeCycle(startedCycle.id, {
      endedAt: now,
      terminalDisposition: 'rejected',
      reportId: report.id,
      terminalCommandId: 'qa-verdict-replay',
      terminalEventId: 'qa-event-replay',
    });
    if (!cycle) throw new Error('Expected completed QA cycle');
    const action = repositories.qaExecutions.insertAutomationAction(
      reviewAutomationActionSchema.parse({
        id: 'resume-action-replay',
        idempotencyKey: `${task.id}:${attempt.id}:${cycle.id}:resume_developer:1`,
        projectId: project.id,
        taskId: task.id,
        attemptId: attempt.id,
        sourceCycleId: cycle.id,
        actionKind: 'resume_developer',
        generation: 1,
        status: 'pending',
        errorCode: null,
        createdAt: now,
        completedAt: null,
      }),
    );
    const committed = {
      task,
      attempt,
      cycle,
      report,
      event: { sequence: 8 },
      events: [{ sequence: 8 }],
    };
    (dependencies as { qaExecutionService: unknown }).qaExecutionService = {
      launch: async () => undefined,
      submitVerdict: () => committed,
    };
    let resumeAttempts = 0;
    (
      dependencies as { reviewAutomationService: unknown }
    ).reviewAutomationService = new ReviewAutomationService({
      ...repositories,
      qaExecutionService: { launch: async () => undefined },
      developerReworkService: {
        resume: async () => {
          resumeAttempts += 1;
          throw new DeveloperResumeUnavailableError();
        },
      },
      publisher: dependencies.registry.publisher,
      now: () => now,
      createId: () => 'automation-failed-event',
    });
    const command = projectCommand('qa-verdict-replay', {
      type: 'task.qa.submit_verdict',
      payload: {
        capability: 'qa-capability-replay',
        expectedRevision: task.revision,
        report: {
          disposition: 'rejected',
          criterionResults: report.criterionResults,
          limitations: [],
          residualRisks: report.residualRisks,
        },
        actor: { type: 'agent', id: 'qa-agent-replay' },
      },
    });

    const first = await executeCommand(command, dependencies);
    const eventCountAfterFailure = repositories.projectEvents.after(
      project.id,
      0,
    ).length;
    const duplicate = await executeCommand(command, dependencies);

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      result: {
        task: {
          id: task.id,
          reviewAutomation: { status: 'paused' },
        },
      },
      warnings: [{ code: 'developer_resume_unavailable' }],
    });
    expect(resumeAttempts).toBe(1);
    expect(eventCountAfterFailure).toBe(1);
    expect(
      repositories.qaExecutions.getAutomationAction(action.id),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'developer_resume_unavailable',
    });
    expect(repositories.projectEvents.after(project.id, 0)).toHaveLength(
      eventCountAfterFailure,
    );
  });

  it('starts review automation only after a committed Developer submission', async () => {
    const { directory } = await createRepository();
    const { dependencies } = commandDependencies(directory);
    const committed = {
      task: { id: 'task-submitted' },
      attempt: { id: 'attempt-submitted' },
      cycle: { id: 'developer-cycle-submitted' },
      report: { id: 'developer-report-submitted' },
      event: { sequence: 5 },
    };
    let followUp: unknown;
    (
      dependencies as { developerExecutionService: unknown }
    ).developerExecutionService = {
      submitForReview: () => committed,
      accept: () => undefined,
      block: () => undefined,
    };
    (
      dependencies as { reviewAutomationService: unknown }
    ).reviewAutomationService = {
      afterDeveloperSubmission: async (input: unknown) => {
        followUp = input;
      },
    };

    const result = await executeCommand(
      projectCommand('developer-submit-command', {
        type: 'task.developer.submit_review',
        payload: {
          capability: 'developer-capability-1',
          expectedRevision: 2,
          report: {
            id: 'developer-report-submitted',
            cycleId: 'developer-cycle-submitted',
            summary: 'Ready for QA.',
            criterionResults: [
              {
                criterionId: 'criterion-1',
                status: 'met',
                evidence: 'Focused test passed.',
              },
            ],
            verification: [],
            limitations: '',
            workspaceState: {
              summary: 'Committed changes.',
              hasUncommittedChanges: false,
              commitsCreated: true,
            },
            reviewerNotes: null,
            createdAt: now,
          },
          actor: { type: 'agent', id: 'developer-agent-1' },
        },
      }),
      dependencies,
    );

    expect(followUp).toEqual({
      taskId: 'task-submitted',
      cycleId: 'developer-cycle-submitted',
    });
    expect(result).toMatchObject({
      commandType: 'task.developer.submit_review',
      result: { projectEventCursor: 5 },
    });
  });

  it('observes a Developer blocker only after its durable outcome commits', async () => {
    const { directory } = await createRepository();
    const { dependencies } = commandDependencies(directory);
    const order: string[] = [];
    (
      dependencies as { developerExecutionService: unknown }
    ).developerExecutionService = {
      markBlocked: () => {
        order.push('committed');
        return {
          task: { id: 'task-blocked', projectId: 'project-blocked' },
          attempt: { id: 'attempt-blocked' },
          cycle: { id: 'cycle-blocked' },
          report: { id: 'report-blocked' },
          event: { sequence: 7 },
        };
      },
    };
    (dependencies as { projectRunService: unknown }).projectRunService = {
      observeTaskOutcome: async (taskId: string) => {
        order.push(`observed:${taskId}`);
      },
    };

    const result = await executeCommand(
      projectCommand('developer-block-command', {
        type: 'task.developer.block',
        payload: {
          capability: 'developer-capability-blocked',
          expectedRevision: 3,
          report: {
            id: 'report-blocked',
            cycleId: 'cycle-blocked',
            reason: 'Operator input required.',
            evidence: 'The required credential is unavailable.',
            attemptedWork: 'Validated the local configuration.',
            suggestedHumanAction: 'Provide the credential.',
            preserveWorkspace: true,
            createdAt: now,
          },
          actor: { type: 'agent', id: 'developer-agent-blocked' },
        },
      }),
      dependencies,
    );

    expect(order).toEqual(['committed', 'observed:task-blocked']);
    expect(result).toMatchObject({
      commandType: 'task.developer.block',
      result: { task: { id: 'task-blocked' }, projectEventCursor: 7 },
    });
  });

  it('maps QA authorization and validation failures to stable HTTP errors', () => {
    for (const [error, statusCode, code] of [
      [new QaCapabilityInvalidError(), 403, 'qa_capability_invalid'],
      [new QaReportIncompleteError(), 422, 'qa_report_incomplete'],
      [new QaAlreadyActiveError(), 409, 'qa_already_active'],
      [new ReviewAutomationPausedError(), 409, 'review_automation_paused'],
      [
        new QaRejectionCeilingReachedError(),
        409,
        'qa_rejection_ceiling_reached',
      ],
      [new UnsafeQaWorkspaceError(), 409, 'unsafe_qa_workspace'],
      [
        new DeveloperResumeUnavailableError(),
        409,
        'developer_resume_unavailable',
      ],
    ] as const) {
      expect(toHttpError(error)).toMatchObject({
        statusCode,
        body: { error: { code } },
      });
    }
  });

  it.each(['system', 'agent'] as const)(
    'rejects %s actors before project and task mutations',
    async (actorType) => {
      const { directory, repositoryPath } = await createRepository();
      const { repositories, dependencies } = commandDependencies(directory);
      repositories.projects.create(
        projectSchema.parse({
          id: 'p1',
          displayName: 'Original',
          repositoryPath,
          repositoryIdentity: 'repository-1',
          discoveredAt: now,
          discoveryMetadata: {},
        }),
      );
      const actor = { type: actorType, id: `${actorType}-1` };

      await expect(
        executeCommand(
          projectCommand(`rename-${actorType}`, {
            type: 'project.rename',
            payload: {
              projectId: 'p1',
              expectedRevision: 1,
              displayName: 'Unauthorized',
              actor,
            },
          }),
          dependencies,
        ),
      ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });
      await expect(
        executeCommand(
          projectCommand(`task-${actorType}`, {
            type: 'task.create',
            payload: { projectId: 'p1', title: 'Unauthorized', actor },
          }),
          dependencies,
        ),
      ).rejects.toMatchObject({ code: 'task_transition_unauthorized' });
      expect(repositories.projects.get('p1')?.displayName).toBe('Original');
      expect(repositories.tasks.listByProject('p1')).toEqual([]);
    },
  );

  it.each(['system', 'agent'] as const)(
    'rejects %s actors from updating developer instructions',
    async (actorType) => {
      const { directory } = await createRepository();
      const { repositories, dependencies } = commandDependencies(directory);
      repositories.projects.create(
        projectSchema.parse({
          id: 'p1',
          displayName: 'Project',
          repositoryPath: directory,
          repositoryIdentity: 'repository-p1',
          discoveredAt: now,
          discoveryMetadata: {},
        }),
      );

      const error = await executeCommand(
        projectCommand(`instructions-${actorType}`, {
          type: 'project.developer_instructions.update',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            content: 'Do not mutate this project.',
            actor: { type: actorType, id: `${actorType}-1` },
          },
        }),
        dependencies,
      ).catch((caught: unknown) => caught);

      expect(toHttpError(error)).toMatchObject({
        statusCode: 400,
        body: { error: { code: 'invalid_command' } },
      });
      expect(
        repositories.projects.get('p1')?.developerInstructions.content,
      ).toBe('');
    },
  );

  it('updates developer instructions atomically before publishing and reuses the original response', async () => {
    const { directory } = await createRepository();
    const ids = ['instructions-event'];
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => ids.shift() ?? 'unexpected-id',
    );
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const publishedAfterPersistence: boolean[] = [];
    dependencies.registry.publisher.subscribeProject('p1', (event) => {
      publishedAfterPersistence.push(
        repositories.projectEvents
          .after('p1', 0)
          .some(({ id }) => id === event.id),
      );
    });
    const command = projectCommand('instructions-update', {
      type: 'project.developer_instructions.update',
      payload: {
        projectId: 'p1',
        expectedRevision: 1,
        content: 'Run the narrowest relevant checks.',
        actor: { type: 'human', id: 'operator' },
      },
    });

    const first = await executeCommand(command, dependencies);
    const duplicate = await executeCommand(command, dependencies);

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      commandType: 'project.developer_instructions.update',
      result: {
        id: 'p1',
        revision: 2,
        developerInstructions: {
          content: 'Run the narrowest relevant checks.',
          revision: 2,
          updatedAt: now,
          updatedBy: taskActorSchema.parse({
            type: 'human',
            id: 'operator',
          }),
        },
      },
    });
    expect(repositories.projectEvents.after('p1', 0)).toEqual([
      expect.objectContaining({
        id: 'instructions-event',
        type: 'project.developer_instructions_changed',
      }),
    ]);
    expect(publishedAfterPersistence).toEqual([true]);
  });

  it('returns the current project for a stale developer-instruction revision', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );

    const error = await executeCommand(
      projectCommand('instructions-stale', {
        type: 'project.developer_instructions.update',
        payload: {
          projectId: 'p1',
          expectedRevision: 2,
          content: 'Stale content.',
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    ).catch((caught: unknown) => caught);

    expect(toHttpError(error)).toMatchObject({
      statusCode: 409,
      body: {
        error: {
          code: 'project_revision_conflict',
          details: {
            project: expect.objectContaining({ id: 'p1', revision: 1 }),
          },
        },
      },
    });
  });

  it.each(['system', 'agent'] as const)(
    'rejects %s actors from updating QA configuration',
    async (actorType) => {
      const { directory } = await createRepository();
      const { repositories, dependencies } = commandDependencies(directory);
      repositories.projects.create(
        projectSchema.parse({
          id: 'p1',
          displayName: 'Project',
          repositoryPath: directory,
          repositoryIdentity: 'repository-p1',
          discoveredAt: now,
          discoveryMetadata: {},
        }),
      );

      const error = await executeCommand(
        projectCommand(`qa-configuration-${actorType}`, {
          type: 'project.qa_configuration.update',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            content: 'Do not mutate this project.',
            reviewPolicy: 'autonomous_review',
            actor: { type: actorType, id: `${actorType}-1` },
          },
        }),
        dependencies,
      ).catch((caught: unknown) => caught);

      expect(toHttpError(error)).toMatchObject({
        statusCode: 400,
        body: { error: { code: 'invalid_command' } },
      });
      expect(repositories.projects.get('p1')?.qaConfiguration).toMatchObject({
        instructions: { content: '', revision: 1, updatedBy: null },
        reviewPolicy: 'manual',
        revision: 1,
        updatedBy: null,
      });
    },
  );

  it('updates QA configuration by its own revision before publishing and reuses the original response', async () => {
    const { directory } = await createRepository();
    const ids = ['qa-configuration-event'];
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => ids.shift() ?? 'unexpected-id',
    );
    const project = repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const renamedInstructions =
      repositories.projects.updateDeveloperInstructions(
        project.id,
        project.revision,
        {
          content: 'The project revision can change independently.',
          updatedAt: now,
          updatedBy: taskActorSchema.parse({
            type: 'human',
            id: 'operator',
          }),
        },
      );
    if (!renamedInstructions) throw new Error('Expected project update');

    const publishedAfterPersistence: boolean[] = [];
    dependencies.registry.publisher.subscribeProject('p1', (event) => {
      publishedAfterPersistence.push(
        repositories.projectEvents
          .after('p1', 0)
          .some(({ id }) => id === event.id),
      );
    });
    const command = projectCommand('qa-configuration-update', {
      type: 'project.qa_configuration.update',
      payload: {
        projectId: 'p1',
        expectedRevision: 1,
        content: 'Run the focused server test before handoff.',
        reviewPolicy: 'autonomous_review',
        actor: { type: 'human', id: 'qa-operator', displayName: 'QA Operator' },
      },
    });

    const first = await executeCommand(command, dependencies);
    const duplicate = await executeCommand(command, dependencies);

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      commandType: 'project.qa_configuration.update',
      result: {
        id: 'p1',
        revision: 3,
        qaConfiguration: {
          instructions: {
            content: 'Run the focused server test before handoff.',
            revision: 2,
            updatedBy: {
              type: 'human',
              id: 'qa-operator',
              displayName: 'QA Operator',
            },
          },
          reviewPolicy: 'autonomous_review',
          revision: 2,
          updatedBy: {
            type: 'human',
            id: 'qa-operator',
            displayName: 'QA Operator',
          },
        },
      },
    });
    expect(repositories.projectEvents.after('p1', 0)).toEqual([
      expect.objectContaining({
        id: 'qa-configuration-event',
        type: 'project.qa_configuration_changed',
      }),
    ]);
    expect(publishedAfterPersistence).toEqual([true]);
  });

  it('returns the current project for a stale QA configuration revision', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
        qaConfiguration: {
          instructions: {
            content: 'Current configuration.',
            revision: 2,
            updatedAt: now,
            updatedBy: { type: 'human', id: 'operator' },
          },
          reviewPolicy: 'autonomous_review',
          revision: 2,
          updatedAt: now,
          updatedBy: { type: 'human', id: 'operator' },
        },
      }),
    );

    const error = await executeCommand(
      projectCommand('qa-configuration-stale', {
        type: 'project.qa_configuration.update',
        payload: {
          projectId: 'p1',
          expectedRevision: 1,
          content: 'Stale content.',
          reviewPolicy: 'manual',
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    ).catch((caught: unknown) => caught);

    expect(toHttpError(error)).toMatchObject({
      statusCode: 409,
      body: {
        error: {
          code: 'project_revision_conflict',
          details: {
            project: expect.objectContaining({
              id: 'p1',
              qaConfiguration: expect.objectContaining({ revision: 2 }),
            }),
          },
        },
      },
    });
  });

  it('rejects developer-instruction updates for archived projects', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
        archivedAt: now,
      }),
    );

    await expect(
      executeCommand(
        projectCommand('instructions-archived', {
          type: 'project.developer_instructions.update',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            content: 'Cannot update archived projects.',
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'project_archived' });
  });

  it('imports a Git repository once and reports the existing project for a duplicate identity', async () => {
    const { directory, repositoryPath } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    const linkedWorktreePath = join(directory, 'linked-worktree');
    await runGit(
      repositoryPath,
      'worktree',
      'add',
      '--detach',
      linkedWorktreePath,
      'HEAD',
    );

    const imported = await executeCommand(
      projectCommand('project-import', {
        type: 'project.import',
        payload: {
          repositoryPath,
          displayName: 'Imported repository',
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    );

    expect(imported.result).toMatchObject({
      id: 'project-created',
      displayName: 'Imported repository',
      repositoryPath,
    });
    expect(repositories.projects.list()).toHaveLength(1);
    await expect(
      executeCommand(
        projectCommand('project-import-duplicate', {
          type: 'project.import',
          payload: {
            repositoryPath: linkedWorktreePath,
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: 'repository_already_imported',
      details: { project: expect.objectContaining({ id: 'project-created' }) },
    });
  });

  it('rejects an import represented by duplicate upgraded legacy repository paths', async () => {
    const { directory, repositoryPath } = await createRepository();
    const linkedWorktreePath = join(directory, 'legacy-linked-worktree');
    await runGit(
      repositoryPath,
      'worktree',
      'add',
      '--detach',
      linkedWorktreePath,
      'HEAD',
    );
    const { repositories, dependencies } = commandDependencies(directory);
    for (const [id, legacyPath] of [
      ['legacy-main', repositoryPath],
      ['legacy-worktree', linkedWorktreePath],
    ] as const) {
      repositories.projects.create(
        projectSchema.parse({
          id,
          displayName: id,
          repositoryPath: legacyPath,
          repositoryIdentity: legacyPath,
          discoveredAt: now,
          discoveryMetadata: { source: 'workspace_root' },
        }),
      );
    }

    await expect(
      executeCommand(
        projectCommand('import-upgraded-legacy', {
          type: 'project.import',
          payload: {
            repositoryPath,
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: 'repository_already_imported',
      details: {
        project: expect.objectContaining({ id: 'legacy-main' }),
      },
    });
    const reconciledProjects = repositories.projects.list();
    expect(reconciledProjects.map((project) => project.id)).toEqual([
      'legacy-main',
      'legacy-worktree',
    ]);
    expect([
      ...new Set(
        reconciledProjects.map((project) => project.repositoryIdentity),
      ),
    ]).toHaveLength(1);
    expect(reconciledProjects.map((project) => project.revision)).toEqual([
      2, 2,
    ]);
  });

  it('returns Git repository suggestions without persisting a project', async () => {
    const { directory, repositoryPath } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);

    const discovered = await executeCommand(
      { protocolVersion: 1, type: 'projects.discover', payload: {} },
      dependencies,
    );

    expect(discovered.result).toEqual({
      projects: [],
      suggestions: [
        expect.objectContaining({
          displayName: 'repository',
          repositoryPath,
        }),
      ],
    });
    expect(repositories.projects.list()).toEqual([]);
  });

  it('refuses to archive a project with a running task attempt', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'w1',
        projectId: 'p1',
        type: 'shared',
        path: directory,
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 'Running attempt',
        permissionMode: 'interactive',
        lifecycleState: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );
    repositories.tasks.create(
      taskSchema.parse({
        id: 't1',
        projectId: 'p1',
        title: 'Task',
        description: '',
        acceptanceCriteria: [],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'in_progress',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    repositories.attempts.create(
      taskAttemptSchema.parse({
        id: 'a1',
        taskId: 't1',
        sessionId: 's1',
        ordinal: 1,
        source: 'launched',
        actor: { type: 'human', id: 'operator' },
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
    );

    await expect(
      executeCommand(
        projectCommand('project-archive', {
          type: 'project.archive',
          payload: {
            projectId: 'p1',
            expectedRevision: 1,
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'project_has_running_attempt' });
    expect(repositories.projects.get('p1')?.archivedAt).toBeNull();
  });

  it('blocks archive and deletion through QA cycle session ownership', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'qa-owned-project',
        displayName: 'QA owned',
        repositoryPath: directory,
        discoveredAt: now,
      }),
    );
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'qa-owned-workspace',
        projectId: 'qa-owned-project',
        type: 'shared',
        path: directory,
      }),
    );
    for (const [id, title] of [
      ['qa-owned-developer', 'Developer'],
      ['qa-owned-session', 'QA'],
    ] as const) {
      repositories.sessions.create(
        sessionSchema.parse({
          id,
          projectId: 'qa-owned-project',
          workspaceId: 'qa-owned-workspace',
          title,
          permissionMode: 'safe_auto',
          lifecycleState: 'completed',
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    const task = repositories.tasks.create(
      taskSchema.parse({
        id: 'qa-owned-task',
        projectId: 'qa-owned-project',
        title: 'QA owned task',
        description: 'Preserve QA history.',
        acceptanceCriteria: ['History is durable'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'review',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = repositories.attempts.create(
      taskAttemptSchema.parse({
        id: 'qa-owned-attempt',
        taskId: task.id,
        sessionId: 'qa-owned-developer',
        ordinal: 1,
        source: 'launched',
        actor: { type: 'human', id: 'operator' },
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: 'developer',
      }),
    );
    repositories.qaExecutions.createCycle(
      qaExecutionCycleSchema.parse({
        id: 'qa-owned-cycle',
        taskId: task.id,
        attemptId: attempt.id,
        sessionId: 'qa-owned-session',
        ordinal: 1,
        authorizedBy: { type: 'human', id: 'operator' },
        authorizationCommandId: 'qa-owned-launch',
        policyVersion: 'qa-policy-v1',
        qaInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 1,
          title: task.title,
          description: task.description,
          acceptanceCriteria: [
            { id: 'criterion-1', text: 'History is durable' },
          ],
        },
        developerCompletionReportId: 'qa-owned-report',
        workspaceId: 'qa-owned-workspace',
        reviewPolicy: 'manual',
        reviewPolicyRevision: 1,
        automationGeneration: 0,
        rejectionOrdinal: 0,
        startedAt: now,
        endedAt: null,
        terminalDisposition: null,
        reportId: null,
        terminalCommandId: null,
        terminalEventId: null,
      }),
    );

    for (const command of [
      {
        type: 'session.archive',
        payload: { sessionId: 'qa-owned-session' },
      },
      {
        type: 'session.delete',
        payload: { sessionId: 'qa-owned-session', confirmed: true },
      },
      {
        type: 'project.archive',
        payload: {
          projectId: 'qa-owned-project',
          expectedRevision: 1,
          actor: { type: 'human', id: 'operator' },
        },
      },
    ]) {
      await expect(
        executeCommand(
          projectCommand(`qa-ownership-${command.type}`, command),
          dependencies,
        ),
      ).rejects.toMatchObject({
        code:
          command.type === 'project.archive'
            ? 'project_has_running_attempt'
            : 'invalid_session_state',
      });
    }
    expect(repositories.qaExecutions.getCycle('qa-owned-cycle')).toBeDefined();
  });

  it('restores an archived project with the next revision', async () => {
    const { directory } = await createRepository();
    const { repositories, dependencies } = commandDependencies(directory);
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
        archivedAt: now,
      }),
    );

    const restored = await executeCommand(
      projectCommand('project-restore', {
        type: 'project.restore',
        payload: {
          projectId: 'p1',
          expectedRevision: 1,
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    );

    expect(restored.result).toMatchObject({
      id: 'p1',
      archivedAt: null,
      revision: 2,
    });
  });

  it('routes task commands through the audited service and maps stale revisions', async () => {
    const { directory } = await createRepository();
    const ids = ['task-created', 'event-created'];
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => ids.shift() ?? 'unexpected-id',
    );
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath: directory,
        repositoryIdentity: 'repository-p1',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    const create = projectCommand('task-create-command', {
      type: 'task.create',
      payload: {
        projectId: 'p1',
        title: 'Add audited task commands',
        actor: { type: 'human', id: 'operator' },
      },
    });

    const first = await executeCommand(create, dependencies);
    const duplicate = await executeCommand(create, dependencies);

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      commandType: 'task.create',
      result: {
        task: { id: 'task-created', revision: 1 },
        event: { id: 'event-created', sequence: 1 },
        projectEventCursor: 1,
      },
    });
    expect(repositories.tasks.listByProject('p1')).toHaveLength(1);
    expect(repositories.projectEvents.after('p1', 0)).toHaveLength(1);

    const error = await executeCommand(
      projectCommand('task-edit-stale', {
        type: 'task.edit',
        payload: {
          taskId: 'task-created',
          expectedRevision: 2,
          patch: { notes: 'Must not overwrite canonical state.' },
          actor: { type: 'human', id: 'operator' },
        },
      }),
      dependencies,
    ).catch((caught: unknown) => caught);
    expect(toHttpError(error)).toMatchObject({
      statusCode: 409,
      body: { error: { code: 'task_revision_conflict' } },
    });
    expect(repositories.tasks.get('task-created')?.revision).toBe(1);
  });

  it('routes attempt launch, unlink, and relink through the application saga', async () => {
    const { directory, repositoryPath } = await createRepository();
    let nextId = 0;
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => `attempt-generated-${++nextId}`,
    );
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath,
        repositoryIdentity: repositoryPath,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.tasks.create(
      taskSchema.parse({
        id: 't1',
        projectId: 'p1',
        title: 'Launch from the board',
        description: 'Start one audited attempt.',
        acceptanceCriteria: ['The task advances after startup.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const launch = projectCommand('attempt-launch-command', {
      type: 'task.attempt.launch',
      payload: {
        taskId: 't1',
        expectedRevision: 1,
        title: 'Attempt one',
        permissionMode: 'interactive',
        workspace: { type: 'shared', path: repositoryPath },
        actor: { type: 'human', id: 'operator' },
      },
    });

    const launched = await executeCommand(launch, dependencies);
    const duplicate = await executeCommand(launch, dependencies);

    expect(duplicate).toEqual(launched);
    expect(launched).toMatchObject({
      commandType: 'task.attempt.launch',
      result: {
        task: { id: 't1', lifecycleState: 'in_progress', revision: 2 },
        attempt: { ordinal: 1, source: 'launched' },
        session: { lifecycleState: 'running' },
        projectEventCursor: 2,
      },
    });
    const attemptId = (launched.result as { attempt: { id: string } }).attempt
      .id;
    const sessionId = (launched.result as { session: { id: string } }).session
      .id;

    await expect(
      executeCommand(
        projectCommand('attempt-unlink-command', {
          type: 'task.attempt.unlink',
          payload: {
            taskId: 't1',
            expectedRevision: 2,
            attemptId,
            reason: 'Correct the association',
            actor: { type: 'human', id: 'operator' },
          },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'invalid_command' });
    expect(sessionId).toBeTruthy();
    expect(repositories.attempts.listByTask('t1')).toHaveLength(1);
  });

  it('routes only a human Developer launch through the audited launch service', async () => {
    const { directory, repositoryPath } = await createRepository();
    let nextId = 0;
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => `developer-generated-${++nextId}`,
    );
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath,
        repositoryIdentity: repositoryPath,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.tasks.create(
      taskSchema.parse({
        id: 't1',
        projectId: 'p1',
        title: 'Launch a Developer',
        description: 'Start one policy-constrained Developer.',
        acceptanceCriteria: ['The execution cycle is durable.'],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const launch = projectCommand('developer-launch-command', {
      type: 'task.developer.launch',
      payload: {
        taskId: 't1',
        expectedRevision: 1,
        title: 'Developer attempt one',
        permissionMode: 'interactive',
        workspace: { type: 'shared', path: repositoryPath },
        actor: { type: 'human', id: 'operator' },
      },
    });

    await expect(
      executeCommand(
        projectCommand('developer-launch-agent', {
          type: 'task.developer.launch',
          payload: {
            ...(
              launch.command as {
                payload: Record<string, unknown>;
              }
            ).payload,
            actor: { type: 'agent', id: 'developer-agent' },
          },
        }),
        dependencies,
      ),
    ).rejects.toBeDefined();
    expect(repositories.attempts.listByTask('t1')).toEqual([]);

    const launched = await executeCommand(launch, dependencies);
    const duplicate = await executeCommand(launch, dependencies);

    expect(duplicate).toEqual(launched);
    expect(launched).toMatchObject({
      commandType: 'task.developer.launch',
      result: {
        task: { id: 't1', lifecycleState: 'in_progress', revision: 2 },
        attempt: { ordinal: 1, source: 'launched', role: 'developer' },
        cycle: { ordinal: 1, mode: 'new' },
        session: { lifecycleState: 'running' },
        projectEventCursor: 2,
      },
    });
    expect(repositories.developerExecutions.listByTask('t1')).toHaveLength(1);
  });

  it('routes human acceptance and both review and unblock recovery choices', async () => {
    const { directory, repositoryPath } = await createRepository();
    let nextId = 0;
    const { repositories, dependencies } = commandDependencies(
      directory,
      () => `review-generated-${++nextId}`,
    );
    const human = { type: 'human' as const, id: idSchema.parse('operator') };
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Project',
        repositoryPath,
        repositoryIdentity: repositoryPath,
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );

    const seed = (taskId: string, kind: 'rejection' | 'unblock') => {
      const task = repositories.tasks.create(
        taskSchema.parse({
          id: taskId,
          projectId: 'p1',
          title: `Recover ${taskId}`,
          description: 'Exercise the human recovery boundary.',
          acceptanceCriteria: ['Recovery remains audited.'],
          priority: 'normal',
          rank: taskId,
          lifecycleState: kind === 'rejection' ? 'review' : 'in_progress',
          labels: [],
          notes: '',
          blocked:
            kind === 'unblock'
              ? {
                  reason: 'Dependency unavailable.',
                  actor: human,
                  blockedAt: now,
                }
              : null,
          revision: 3,
          createdAt: now,
          updatedAt: now,
        }),
      );
      const workspaceId = `workspace-${taskId}`;
      const sessionId = `session-${taskId}`;
      repositories.workspaces.create(
        workspaceSchema.parse({
          id: workspaceId,
          projectId: task.projectId,
          type: 'shared',
          path: repositoryPath,
          cleanupState: 'active',
        }),
      );
      repositories.sessions.create(
        sessionSchema.parse({
          id: sessionId,
          claudeResumeId: `claude-${taskId}`,
          projectId: task.projectId,
          workspaceId,
          title: `Prior ${taskId}`,
          permissionMode: 'safe_auto',
          lifecycleState: 'completed',
          createdAt: now,
          updatedAt: now,
        }),
      );
      const attempt = repositories.attempts.createForTask(
        task.id,
        sessionId,
        'launched',
        human,
        'developer',
      );
      repositories.developerExecutions.createCycle(
        developerExecutionCycleSchema.parse({
          id: `cycle-${taskId}`,
          attemptId: attempt.id,
          ordinal: 1,
          mode: 'new',
          authorizedBy: human,
          authorizationCommandId: `launch-${taskId}`,
          policyVersion: 'developer-policy-v1',
          projectInstructions: { content: '', revision: 1 },
          taskSnapshot: {
            revision: 1,
            title: task.title,
            description: task.description,
            acceptanceCriteria: [
              { id: 'criterion-1', text: task.acceptanceCriteria[0] },
            ],
          },
          workspaceId,
          permissionMode: 'safe_auto',
          startedAt: now,
          endedAt: now,
          terminalDisposition:
            kind === 'rejection' ? 'submitted_for_review' : 'blocked',
          completionReportId: kind === 'rejection' ? `report-${taskId}` : null,
          blockerReportId: kind === 'unblock' ? `blocker-${taskId}` : null,
          terminalCommandId: `terminal-${taskId}`,
          terminalEventId: `event-${taskId}`,
        }),
      );
      return task;
    };

    const acceptedTask = seed('accept', 'rejection');
    const accepted = await executeCommand(
      projectCommand('accept-command', {
        type: 'task.developer.accept',
        payload: {
          taskId: acceptedTask.id,
          expectedRevision: acceptedTask.revision,
          actor: human,
        },
      }),
      dependencies,
    );
    expect(accepted).toMatchObject({
      commandType: 'task.developer.accept',
      result: { task: { lifecycleState: 'done' } },
    });

    for (const [type, taskId, kind] of [
      ['task.developer.reject_resume', 'reject-resume', 'rejection'],
      ['task.developer.reject_new', 'reject-new', 'rejection'],
      ['task.developer.unblock_resume', 'unblock-resume', 'unblock'],
      ['task.developer.unblock_new', 'unblock-new', 'unblock'],
    ] as const) {
      const task = seed(taskId, kind);
      const fresh = type.endsWith('_new');
      const command = projectCommand(`${taskId}-command`, {
        type,
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          feedback: `Human feedback for ${taskId}.`,
          ...(fresh
            ? {
                title: `Fresh ${taskId}`,
                permissionMode: 'interactive',
                workspace: { type: 'shared', path: repositoryPath },
              }
            : {}),
          actor: human,
        },
      });

      const result = await executeCommand(command, dependencies);
      expect(result).toMatchObject({
        commandType: type,
        result: {
          task: { lifecycleState: 'in_progress', blocked: null },
          feedback: { kind },
          cycle: { mode: fresh ? 'new' : 'resume' },
        },
      });
    }
  });

  it('does not decide an already-resolved permission request', async () => {
    const repositories = createTestRepositories();
    repositories.projects.create(
      projectSchema.parse({
        id: 'p1',
        displayName: 'Mesh',
        repositoryPath: 'C:/code/mesh',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repositories.workspaces.create(
      workspaceSchema.parse({
        id: 'w1',
        projectId: 'p1',
        type: 'shared',
        path: 'C:/code/mesh',
      }),
    );
    repositories.sessions.create(
      sessionSchema.parse({
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 'Session',
        permissionMode: 'interactive',
        lifecycleState: 'idle',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const driver = new FakeClaudeSessionDriver();
    const registry = new SessionRegistry({
      ...repositories,
      driver,
      closeDatabase: () => undefined,
    });
    const taskService = new TaskService({ ...repositories, now: () => now });
    cleanups.push(async () => {
      await registry.shutdown();
      repositories.dispose();
    });
    await registry.create('s1');
    driver.createdSessions[0]?.enqueue({
      kind: 'permission_requested',
      permissionId: 'permission-1',
      name: 'Bash',
      input: {},
    });
    for (let attempts = 0; attempts < 20; attempts += 1) {
      if (
        repositories.events
          .after('s1', 0)
          .some((event) => event.type === 'permission.requested')
      )
        break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    repositories.events.append(
      's1',
      {
        id: 'permission-resolved',
        occurredAt: now,
        type: 'permission.resolved',
        payload: {
          permissionId: 'permission-1',
          decision: 'denied',
          resolvedAt: now,
        },
      },
      {
        id: idSchema.parse('raw-resolved'),
        sessionId: idSchema.parse('s1'),
        capturedAt: now,
        payload: {},
      },
    );

    await expect(
      executeCommand(
        {
          protocolVersion: 1,
          idempotencyKey: 'permission-key',
          command: {
            type: 'permission.decide',
            payload: { permissionId: 'permission-1', decision: 'approve' },
          },
        },
        {
          ...repositories,
          taskService,
          registry,
          driver,
          billingConflicts: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_session_state' });
    expect(driver.createdSessions[0]?.permissionDecisions).toEqual([]);
  });
});
