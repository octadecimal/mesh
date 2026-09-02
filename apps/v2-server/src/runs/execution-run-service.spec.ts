import { randomUUID } from 'node:crypto';

import {
  DEVELOPER_REPORT_SCHEMA,
  type DeveloperAttempt,
  type ExecutionRunView,
  type ResolvedWorkerProfileSnapshot,
  type V2CommandResult,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { TaskExecutionAuthority } from '../planning/planning-repository.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { ExecutionRunService } from './execution-run-service.js';

const fixtures: ReturnType<typeof createV2TestDatabase>[] = [];
const now = '2026-09-02T12:00:00.000Z';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const setup = () => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  const planId = randomUUID();
  const milestoneId = randomUUID();
  const taskIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  const profile: ResolvedWorkerProfileSnapshot = {
    profileId: randomUUID(),
    projectId: null,
    profileRevision: 1,
    baseProfileId: null,
    baseRevision: null,
    document: {
      apiVersion: 'mesh.dev/v1alpha1',
      kind: 'WorkerProfile',
      metadata: {
        name: 'todo-developer',
        displayName: 'Todo Developer',
        scope: 'global',
      },
      spec: {
        assignmentKinds: ['developer_task'],
        preferredRuntime: { harness: 'fake', model: 'deterministic' },
        alternatives: [],
        requiredCapabilities: [],
        skills: { preferred: [], required: [] },
        instructions: 'Implement one Todo task.',
        outputSchema: DEVELOPER_REPORT_SCHEMA,
      },
    },
    digest: 'd'.repeat(64),
  };
  const dependency = (otherTaskId: string) => ({
    dependencyId: randomUUID(),
    dependencyRevision: 1,
    direction: 'prerequisite' as const,
    otherTaskId,
    otherTaskTitle: 'Prerequisite',
    otherTaskLifecycle: 'pending' as const,
  });
  const plan = {
    plan: {
      id: planId,
      projectId: fixture.project.id,
      revision: 1,
      projectIntentRevision: 1,
      ledgerRevision: 1,
    },
    taskContracts: taskIds.map((id, index) => ({ id, ordinal: index + 1 })),
  };
  const authorities = new Map<string, TaskExecutionAuthority>();
  taskIds.forEach((taskId, index) => {
    const prerequisites =
      index === 2 ? taskIds.slice(0, 2).map(dependency) : [];
    authorities.set(taskId, {
      project: fixture.project,
      deliveryPlan: plan,
      intentRevision: 1,
      ledgerRevision: 1,
      task: {
        id: taskId,
        projectId: fixture.project.id,
        revision: 1,
        contractRevision: 1,
        lifecycle: 'pending',
        milestoneId,
        title: `Task ${index + 1}`,
        outcome: `Task ${index + 1} works.`,
        acceptanceCriteria: [`Task ${index + 1} passes.`],
        verificationCriteria: [`Verify task ${index + 1}.`],
        expectedArtifacts: [`task-${index + 1}.txt`],
      },
      requirementRevisions: [],
      board: {
        projectId: fixture.project.id,
        deliveryPlanRevision: 1,
        filter: { revision: 1 },
      },
      card: {
        taskId,
        taskContractRevision: 1,
        taskCurrentRevision: 1,
        readiness: {
          state: index === 2 ? 'blocked' : 'actionable',
          blockers: [],
        },
        dependencies: prerequisites,
        detail: {
          acceptanceCriteria: [`Task ${index + 1} passes.`],
          verificationCriteria: [`Verify task ${index + 1}.`],
          expectedArtifacts: [`task-${index + 1}.txt`],
        },
      },
    } as unknown as TaskExecutionAuthority);
  });
  const attempts = new Map<string, DeveloperAttempt>();
  const launches: string[] = [];
  const published: unknown[] = [];
  const views: ExecutionRunView[] = [];
  let boardHidesTasks = false;
  let barrierHealthy = true;
  const runs = {
    view: (runId: string) => views.find(({ run }) => run.id === runId),
    listForProject: (projectId: string) =>
      views
        .filter(({ run }) => run.projectId === projectId)
        .sort((left, right) =>
          right.run.createdAt.localeCompare(left.run.createdAt),
        ),
    nonterminal: () => views.filter(({ run }) => run.lifecycle !== 'completed'),
    createInTransaction: (view: ExecutionRunView) => {
      views.push(view);
    },
    replaceInTransaction: (
      view: ExecutionRunView,
      expectedRevision: number,
    ) => {
      const index = views.findIndex(({ run }) => run.id === view.run.id);
      if (index < 0 || views[index].run.revision !== expectedRevision)
        throw new Error('Execution run revision changed');
      views[index] = view;
    },
  };
  const service = new ExecutionRunService({
    database: fixture.database,
    runs,
    commands: fixture.commands,
    events: fixture.events,
    projects: { get: () => fixture.project },
    planning: Object.assign(
      {
        taskExecutionAuthority: (_projectId: string, taskId: string) =>
          boardHidesTasks ? undefined : authorities.get(taskId),
      },
      {
        taskExecutionAuthorityUnfiltered: (
          _projectId: string,
          taskId: string,
        ) => authorities.get(taskId),
      },
    ),
    profiles: {
      resolveApproved: (profileId, revision) => {
        if (profileId !== profile.profileId || revision !== 1)
          throw new Error('Profile not found');
        return profile;
      },
    },
    developer: {
      startFromRun: async (input) => {
        launches.push(input.command.taskId);
        const attempt = {
          id: randomUUID(),
          projectId: fixture.project.id,
          taskId: input.command.taskId,
          lifecycle: 'active',
          attention: null,
        } as DeveloperAttempt;
        attempts.set(attempt.id, attempt);
        return {
          ok: true,
          commandType: 'developer_attempt.start',
          schemaVersion: 1,
          attempt,
          board: authorities.get(input.command.taskId)!.board,
        } as V2CommandResult;
      },
      attempt: (attemptId) => attempts.get(attemptId),
    },
    inspectProject: async () => ({
      repositoryIdentity: fixture.project.repositoryIdentity,
      headCommit: fixture.project.headCommit,
    }),
    barrier: {
      assertHealthy: () => {
        if (!barrierHealthy) throw new Error('Audit barrier tripped');
      },
      trip: () => undefined,
    },
    billingConflicts: [],
    now: () => now,
    publishDomain: (event) => published.push(event),
  });
  const start = (selectedTaskIds = taskIds, idempotencyKey = randomUUID()) =>
    service.start({
      idempotencyKey,
      actor: { kind: 'human' },
      command: {
        type: 'execution_run.start',
        projectId: fixture.project.id,
        expectedDeliveryPlanId: planId,
        expectedDeliveryPlanRevision: 1,
        expectedBoardFilterRevision: 1,
        selections: selectedTaskIds.map((taskId) => ({
          taskId,
          expectedTaskRevision: 1,
          profileId: profile.profileId,
          profileRevision: 1,
        })),
        concurrencyLimit: 2,
        subscriptionCapacityConfirmed: true,
      },
    });
  const complete = async (attemptId: string) => {
    attempts.set(attemptId, {
      ...attempts.get(attemptId)!,
      lifecycle: 'completed',
    });
    await service.developerAttemptChanged(attemptId);
  };
  return {
    fixture,
    service,
    runs,
    taskIds,
    authorities,
    attempts,
    launches,
    published,
    hideTasksOnBoard: () => {
      boardHidesTasks = true;
    },
    tripBarrier: () => {
      barrierHealthy = false;
    },
    start,
    complete,
  };
};

describe('ExecutionRunService', () => {
  it('runs dependency-ready waves, holds while paused, and resumes once', async () => {
    const context = setup();

    const started = await context.start();

    expect(started).toMatchObject({
      ok: true,
      commandType: 'execution_run.start',
    });
    expect(context.launches).toEqual(context.taskIds.slice(0, 2));
    let view = context.runs.nonterminal()[0];
    expect(view.items.map(({ lifecycle }) => lifecycle)).toEqual([
      'active',
      'active',
      'waiting',
    ]);

    await context.complete(view.items[0].developerAttemptId!);
    view = context.runs.nonterminal()[0];
    const paused = await context.service.pause({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'execution_run.pause',
        projectId: context.fixture.project.id,
        runId: view.run.id,
        expectedRunRevision: view.run.revision,
      },
    });
    expect(paused).toMatchObject({ ok: true, run: { lifecycle: 'paused' } });

    view = context.runs.nonterminal()[0];
    const dependent = context.authorities.get(context.taskIds[2])!;
    context.authorities.set(context.taskIds[2], {
      ...dependent,
      card: {
        ...dependent.card,
        readiness: { state: 'actionable', blockers: [] },
      },
    });
    await context.complete(view.items[1].developerAttemptId!);
    expect(context.launches).toHaveLength(2);
    view = context.runs.nonterminal()[0];
    expect(view.items[2].lifecycle).toBe('waiting');

    await context.service.resume({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'execution_run.resume',
        projectId: context.fixture.project.id,
        runId: view.run.id,
        expectedRunRevision: view.run.revision,
      },
    });
    expect(context.launches).toEqual([...context.taskIds]);
    view = context.runs.nonterminal()[0];
    await context.complete(view.items[2].developerAttemptId!);

    const finished = context.runs.listForProject(context.fixture.project.id)[0];
    expect(finished.run).toMatchObject({
      lifecycle: 'completed',
      completionReason: 'finished',
      counts: { completed: 3 },
    });
    expect(context.published.length).toBeGreaterThan(0);
  });

  it('keeps scheduling frozen items when the Board filter hides them', async () => {
    const context = setup();
    await context.start();
    let view = context.runs.nonterminal()[0];
    const dependent = context.authorities.get(context.taskIds[2])!;
    context.authorities.set(context.taskIds[2], {
      ...dependent,
      card: {
        ...dependent.card,
        readiness: { state: 'actionable', blockers: [] },
      },
    });
    context.hideTasksOnBoard();

    await context.complete(view.items[0].developerAttemptId!);
    view = context.runs.nonterminal()[0];
    await context.complete(view.items[1].developerAttemptId!);

    expect(context.launches).toEqual(context.taskIds);
  });

  it('replays controls but rejects new mutations after the audit barrier trips', async () => {
    const context = setup();
    await context.start();
    let view = context.runs.nonterminal()[0];
    const pause = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' as const },
      command: {
        type: 'execution_run.pause' as const,
        projectId: context.fixture.project.id,
        runId: view.run.id,
        expectedRunRevision: view.run.revision,
      },
    };
    const paused = await context.service.pause(pause);
    context.tripBarrier();

    await expect(context.service.pause(pause)).resolves.toEqual(paused);
    view = context.runs.nonterminal()[0];
    const stopped = await context.service.stop({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'execution_run.stop',
        projectId: context.fixture.project.id,
        runId: view.run.id,
        expectedRunRevision: view.run.revision,
      },
    });

    expect(stopped).toMatchObject({
      ok: false,
      error: { code: 'audit_barrier_tripped' },
    });
    expect(context.runs.nonterminal()[0].run).toMatchObject({
      lifecycle: 'paused',
      revision: view.run.revision,
    });
  });

  it('does not persist a new Start failure after the audit barrier trips', async () => {
    const context = setup();
    const idempotencyKey = randomUUID();
    context.tripBarrier();

    const result = await context.start(context.taskIds, idempotencyKey);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'audit_barrier_tripped' },
    });
    expect(context.fixture.commands.find(idempotencyKey)).toBeUndefined();
  });

  it('settles active work without launching another wave after quiescing', async () => {
    const context = setup();
    await context.start();
    let view = context.runs.nonterminal()[0];
    const dependent = context.authorities.get(context.taskIds[2])!;
    context.authorities.set(context.taskIds[2], {
      ...dependent,
      card: {
        ...dependent.card,
        readiness: { state: 'actionable', blockers: [] },
      },
    });
    await (
      context.service as unknown as { quiesce?(): Promise<void> }
    ).quiesce?.();

    await context.complete(view.items[0].developerAttemptId!);
    view = context.runs.nonterminal()[0];
    await context.complete(view.items[1].developerAttemptId!);

    expect(context.launches).toEqual(context.taskIds.slice(0, 2));
    expect(context.runs.nonterminal()[0].run.counts).toMatchObject({
      waiting: 1,
      active: 0,
      completed: 2,
    });
  });

  it('rejects a selection missing unfinished prerequisites', async () => {
    const context = setup();

    const result = await context.start([context.taskIds[2]]);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'execution_run_dependency_not_closed' },
    });
    expect(context.launches).toEqual([]);
    expect(context.runs.nonterminal()).toEqual([]);
  });

  it('stops future launches and completes after active work drains', async () => {
    const context = setup();
    await context.start();
    let view = context.runs.nonterminal()[0];

    await context.service.stop({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'execution_run.stop',
        projectId: context.fixture.project.id,
        runId: view.run.id,
        expectedRunRevision: view.run.revision,
      },
    });

    view = context.runs.nonterminal()[0];
    expect(view.run.lifecycle).toBe('stopping');
    expect(view.items[2].lifecycle).toBe('not_started');
    expect(context.launches).toHaveLength(2);
    await context.complete(view.items[0].developerAttemptId!);
    view = context.runs.nonterminal()[0];
    await context.complete(view.items[1].developerAttemptId!);

    const stopped = context.runs.listForProject(context.fixture.project.id)[0];
    expect(stopped.run).toMatchObject({
      lifecycle: 'completed',
      completionReason: 'stopped',
      counts: { completed: 2, notStarted: 1 },
    });
    expect(context.launches).toHaveLength(2);
  });

  it('contains a task-local blocker and closes its impossible dependent', async () => {
    const context = setup();
    await context.start();
    let view = context.runs.nonterminal()[0];
    const blockedAttemptId = view.items[0].developerAttemptId!;
    context.attempts.set(blockedAttemptId, {
      ...context.attempts.get(blockedAttemptId)!,
      lifecycle: 'blocked',
      attention: {
        code: 'developer_report_binding_invalid',
        message: 'Developer reported a blocker.',
      },
    });

    await context.service.developerAttemptChanged(blockedAttemptId);

    view = context.runs.nonterminal()[0];
    expect(view.items.map(({ lifecycle }) => lifecycle)).toEqual([
      'attention_required',
      'active',
      'attention_required',
    ]);
    expect(context.launches).toHaveLength(2);
    await context.complete(view.items[1].developerAttemptId!);
    const finished = context.runs.listForProject(context.fixture.project.id)[0];
    expect(finished.run).toMatchObject({
      lifecycle: 'completed',
      completionReason: 'finished',
      counts: { completed: 1, attentionRequired: 2 },
    });
  });

  it('pauses restart reconciliation when a linked attempt is missing', async () => {
    const context = setup();
    await context.start();
    const view = context.runs.nonterminal()[0];
    context.attempts.delete(view.items[0].developerAttemptId!);

    await context.service.reconcile();

    expect(context.runs.nonterminal()[0].run).toMatchObject({
      lifecycle: 'paused',
      attention: { code: 'execution_run_recovery_ambiguous' },
    });
    expect(context.launches).toHaveLength(2);
  });
});
