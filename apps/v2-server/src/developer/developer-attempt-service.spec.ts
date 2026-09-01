import { randomUUID } from 'node:crypto';

import {
  DEVELOPER_REPORT_SCHEMA,
  type DeveloperAttempt,
  type ResolvedWorkerProfileSnapshot,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DeveloperAttemptService,
  type StartDeveloperAttemptEnvelope,
  type TaskExecutionAuthority,
} from './developer-attempt-service.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';

const now = '2026-09-01T12:00:00.000Z';
const fixtures: ReturnType<typeof createV2TestDatabase>[] = [];

const createAuthority = (
  fixture: ReturnType<typeof createV2TestDatabase>,
): TaskExecutionAuthority => {
  const taskId = randomUUID();
  const planId = randomUUID();
  const requirementId = randomUUID();
  return {
    project: fixture.project,
    deliveryPlan: {
      plan: {
        id: planId,
        projectId: fixture.project.id,
        revision: 1,
        projectIntentId: randomUUID(),
        projectIntentRevision: 1,
        ledgerId: randomUUID(),
        ledgerRevision: 1,
      },
    } as TaskExecutionAuthority['deliveryPlan'],
    intentRevision: 1,
    ledgerRevision: 1,
    task: {
      id: taskId,
      projectId: fixture.project.id,
      revision: 1,
      contractRevision: 1,
      lifecycle: 'pending',
      title: 'Persist Todo items',
      outcome: 'Todo items survive reload.',
      acceptanceCriteria: ['Reload restores one Todo item.'],
      verificationCriteria: ['Run the Todo persistence test.'],
      expectedArtifacts: ['src/todos.ts'],
    } as TaskExecutionAuthority['task'],
    requirementRevisions: [{ recordId: requirementId, recordRevision: 1 }],
    board: { projectId: fixture.project.id } as TaskExecutionAuthority['board'],
    card: {
      taskId,
      taskContractRevision: 1,
      taskCurrentRevision: 1,
      title: 'Persist Todo items',
      outcome: 'Todo items survive reload.',
      readiness: { state: 'actionable', blockers: [] },
      detail: {
        acceptanceCriteria: ['Reload restores one Todo item.'],
        verificationCriteria: ['Run the Todo persistence test.'],
        expectedArtifacts: ['src/todos.ts'],
      },
    } as TaskExecutionAuthority['card'],
  };
};

const createProfile = (
  compatible = true,
): ResolvedWorkerProfileSnapshot =>
  ({
    profileId: randomUUID(),
    profileRevision: 1,
    projectId: null,
    baseProfileId: null,
    baseRevision: null,
    digest: 'a'.repeat(64),
    document: {
      spec: {
        assignmentKinds: compatible ? ['developer_task'] : ['foundation-check'],
        outputSchema: compatible
          ? DEVELOPER_REPORT_SCHEMA
          : 'mesh.dev/foundation-report/v1',
      },
    },
  }) as ResolvedWorkerProfileSnapshot;

const createEnvelope = (
  authority: TaskExecutionAuthority,
): StartDeveloperAttemptEnvelope => ({
  idempotencyKey: 'developer-attempt-start-1',
  actor: { kind: 'human' },
  command: {
    type: 'developer_attempt.start',
    projectId: authority.project.id,
    taskId: authority.task.id,
    expectedTaskRevision: authority.task.revision,
    expectedDeliveryPlanId: authority.deliveryPlan.plan.id,
    expectedDeliveryPlanRevision: authority.deliveryPlan.plan.revision,
    profileId: randomUUID(),
    profileRevision: 1,
  },
});

const setup = (options: {
  authority?: TaskExecutionAuthority | undefined;
  profile?: ResolvedWorkerProfileSnapshot;
  billingConflicts?: readonly { variable: string }[];
  healthy?: boolean;
  repositoryIdentity?: string;
  headCommit?: string;
  existingAttempt?: DeveloperAttempt;
} = {}) => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  let authority = options.authority ?? createAuthority(fixture);
  let profile = options.profile ?? createProfile();
  const phases: string[] = [];
  const attempts: DeveloperAttempt[] = options.existingAttempt
    ? [options.existingAttempt]
    : [];
  const commands = new Map<string, { requestHash: string; result: unknown }>();
  const workspaceCalls: unknown[] = [];
  const executionCalls: unknown[] = [];
  const events: unknown[] = [];
  const service = new DeveloperAttemptService({
    database: fixture.database,
    planning: { taskExecutionAuthority: () => authority },
    developers: {
      attempt: (id) => attempts.find((attempt) => attempt.id === id),
      attemptsForProject: () => attempts,
      nonterminalAttempts: () => attempts,
      reserveAttemptInTransaction: (attempt) => {
        attempts.push(attempt);
        return attempt;
      },
      recordWorkspaceObservationInTransaction: (workspace) => {
        const current = attempts.find(({ id }) => id === workspace.attemptId)!;
        const next = { ...current, workspace };
        attempts.splice(attempts.indexOf(current), 1, next);
        return workspace;
      },
      linkExecutionInTransaction: ({ attemptId, executionId }) => {
        const current = attempts.find(({ id }) => id === attemptId)!;
        const next = {
          ...current,
          revision: current.revision + 1,
          controllingExecutionId: executionId,
          executionIds: [executionId],
        };
        attempts.splice(attempts.indexOf(current), 1, next);
        return next;
      },
      transitionAttemptInTransaction: (attempt) => {
        const current = attempts.find(({ id }) => id === attempt.id)!;
        attempts.splice(attempts.indexOf(current), 1, attempt);
        return attempt;
      },
    },
    profiles: { resolveApproved: () => profile },
    commands: {
      find: (key, requestHash) => {
        const stored = commands.get(key);
        if (stored && requestHash !== stored.requestHash) throw new Error('conflict');
        return stored as never;
      },
      storeInTransaction: (stored) => {
        commands.set(stored.idempotencyKey, stored);
      },
    },
    events: {
      appendDomainInTransaction: (_projectId, event) => {
        events.push(event);
        return event;
      },
    },
    execution: {
      reserveStart: async () => {
        phases.push('workspace_observed_ready', 'execution_reserved');
        executionCalls.push('reserve');
        return {
          execution: fixture.execution,
          result: {
            ok: true,
            commandType: 'worker_execution.start',
            execution: fixture.execution,
          },
          activationRequired: true,
        };
      },
      activateReserved: async () => {
        expect(attempts[0]).toMatchObject({ lifecycle: 'active' });
        phases.push('attempt_activated', 'execution_activated');
      },
    },
    workspace: {
      inspectProject: async () => ({
        repositoryIdentity:
          options.repositoryIdentity ?? fixture.project.repositoryIdentity,
        headCommit: options.headCommit ?? fixture.project.headCommit,
      }),
      create: async () => {
        phases.push('attempt_reserved', 'workspace_effect_started');
        workspaceCalls.push('create');
        return { headCommit: fixture.project.headCommit, dirty: false };
      },
    },
    barrier: {
      assertHealthy: () => {
        if (options.healthy === false) throw new Error('audit barrier tripped');
      },
      trip: () => undefined,
    },
    billingConflicts: options.billingConflicts ?? [],
    now: () => now,
    publishDomain: (event) => events.push(event),
  });
  return {
    service,
    phases,
    attempts,
    workspaceCalls,
    executionCalls,
    events,
    getAuthority: () => authority,
    setAuthority: (value: TaskExecutionAuthority | undefined) => {
      authority = value;
    },
    setProfile: (value: ResolvedWorkerProfileSnapshot) => {
      profile = value;
    },
    command: createEnvelope(authority),
  };
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe('DeveloperAttemptService', () => {
  it('durably reserves and then activates one actionable Developer attempt', async () => {
    const context = setup();

    const result = await context.service.start(context.command);
    const replay = await context.service.start(context.command);

    expect(result).toMatchObject({
      ok: true,
      commandType: 'developer_attempt.start',
      attempt: {
        assignment: {
          taskCurrentRevision: context.getAuthority()!.task.revision,
        },
        workspace: { baseCommit: context.getAuthority()!.project.headCommit },
      },
    });
    expect(replay).toEqual(result);
    expect(context.phases).toEqual([
      'attempt_reserved',
      'workspace_effect_started',
      'workspace_observed_ready',
      'execution_reserved',
      'attempt_activated',
      'execution_activated',
    ]);
    expect(context.workspaceCalls).toHaveLength(1);
    expect(context.executionCalls).toHaveLength(1);
  });

  it.each([
    ['missing authority', (context: ReturnType<typeof setup>) => {
      context.setAuthority(undefined);
    }],
    ['stale plan ID', (context: ReturnType<typeof setup>) => {
      context.command.command.expectedDeliveryPlanId = randomUUID();
    }],
    ['stale plan revision', (context: ReturnType<typeof setup>) => {
      context.command.command.expectedDeliveryPlanRevision = 2;
    }],
    ['stale task revision', (context: ReturnType<typeof setup>) => {
      context.command.command.expectedTaskRevision = 2;
    }],
    ['non-actionable readiness', (context: ReturnType<typeof setup>) => {
      context.setAuthority({
        ...context.getAuthority()!,
        card: {
          ...context.getAuthority()!.card,
          readiness: { state: 'blocked', blockers: [] },
        },
      });
    }],
    ['controlling attempt', (context: ReturnType<typeof setup>) => {
      context.attempts.push({
        taskId: context.getAuthority()!.task.id,
      } as DeveloperAttempt);
    }],
    ['incompatible profile', (context: ReturnType<typeof setup>) => {
      context.setProfile(createProfile(false));
    }],
  ])('rejects %s before durable reservation', async (_name, change) => {
    const context = setup();
    change(context);
    const attemptCount = context.attempts.length;

    const result = await context.service.start(context.command);

    expect(result).toMatchObject({ ok: false });
    expect(context.attempts).toHaveLength(attemptCount);
    expect(context.workspaceCalls).toHaveLength(0);
    expect(context.executionCalls).toHaveLength(0);
    expect(context.events).toHaveLength(0);
  });

  it('rejects repository, billing, and audit changes before durable reservation', async () => {
    for (const options of [
      { repositoryIdentity: 'changed-identity' },
      { headCommit: 'b'.repeat(40) },
      { billingConflicts: [{ variable: 'ANTHROPIC_API_KEY' }] },
      { healthy: false },
    ]) {
      const context = setup(options);
      const result = await context.service.start(context.command);
      expect(result).toMatchObject({ ok: false });
      expect(context.attempts).toHaveLength(0);
      expect(context.workspaceCalls).toHaveLength(0);
      expect(context.executionCalls).toHaveLength(0);
      expect(context.events).toHaveLength(0);
    }
  });
});
