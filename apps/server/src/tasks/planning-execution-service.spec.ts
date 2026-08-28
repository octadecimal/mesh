import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  projectSchema,
  projectPlanProposalInputSchema,
  taskActorSchema,
  taskDependencySchema,
  taskSchema,
  workspaceSchema,
  type ProjectPlanProposalInput,
  type TaskActor,
} from '@mesh-session-platform/contracts';

import type { RepositoryIdentity } from '../projects/repository-identity.js';
import { EventPublisher } from '../runtime/event-publisher.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { PlanningCapabilityRegistry } from './planning-capability-registry.js';
import {
  PlanningExecutionService,
  type PlanningRuntimeConfiguration,
} from './planning-execution-service.js';

const now = '2026-08-27T12:00:00.000Z';
const repositoryPath = 'C:/code/project-one';
const repositoryIdentity = 'C:/code/.git';

const human = taskActorSchema.parse({
  type: 'human',
  id: 'operator-1',
  displayName: 'Operator',
}) as TaskActor;

const agent = taskActorSchema.parse({
  type: 'agent',
  id: 'agent-1',
}) as TaskActor;

const proposal = (
  overrides: Record<string, unknown> = {},
): ProjectPlanProposalInput =>
  projectPlanProposalInputSchema.parse({
    tasks: [
      {
        key: 'persistence',
        title: 'Persist planning state',
        description: 'Add the durable planning lifecycle.',
        acceptanceCriteria: ['Planning state survives restart.'],
        priority: 'high',
        labels: ['planning'],
        rationale: 'The proposal must be reviewable.',
        goalMapping: 'Creates the durable review boundary.',
      },
    ],
    dependencies: [],
    assumptions: ['SQLite remains the audit store.'],
    risks: ['Runtime startup can fail after commit.'],
    exclusions: ['No task creation during planning.'],
    ...overrides,
  });

type TestRepositories = ReturnType<typeof createTestRepositories>;

type RegistryDouble = {
  auditStatus: 'available' | 'audit_unavailable';
  create: ReturnType<
    typeof vi.fn<
      (
        sessionId: string,
        configuration: PlanningRuntimeConfiguration,
      ) => Promise<void>
    >
  >;
  resume: ReturnType<
    typeof vi.fn<
      (
        sessionId: string,
        configuration: { workspaceId: string; permissionMode: string },
        runtimeConfiguration: PlanningRuntimeConfiguration,
      ) => Promise<void>
    >
  >;
  interrupt: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
  reportAuditFailure: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  publisher: EventPublisher;
};

const seedProject = (
  repositories: TestRepositories,
  options: { archived?: boolean; sharedWorkspace?: boolean } = {},
) => {
  const project = repositories.projects.create(
    projectSchema.parse({
      id: 'project-1',
      displayName: 'Project one',
      repositoryPath,
      repositoryIdentity,
      discoveredAt: now,
      discoveryMetadata: {},
      archivedAt: options.archived ? now : null,
    }),
  );
  const sharedWorkspace = options.sharedWorkspace
    ? repositories.workspaces.create(
        workspaceSchema.parse({
          id: 'shared-workspace-1',
          projectId: project.id,
          type: 'shared',
          path: repositoryPath,
          cleanupState: 'active',
        }),
      )
    : undefined;
  repositories.tasks.create(
    taskSchema.parse({
      id: 'task-b',
      projectId: project.id,
      title: 'Second task',
      description: '',
      acceptanceCriteria: ['Second task is complete.'],
      priority: 'normal',
      rank: 'b',
      lifecycleState: 'ready',
      labels: [],
      notes: '',
      blocked: null,
      revision: 3,
      createdAt: now,
      updatedAt: now,
    }),
  );
  repositories.tasks.create(
    taskSchema.parse({
      id: 'task-a',
      projectId: project.id,
      title: 'First task',
      description: '',
      acceptanceCriteria: ['First task is complete.'],
      priority: 'normal',
      rank: 'a',
      lifecycleState: 'backlog',
      labels: [],
      notes: '',
      blocked: {
        reason: 'Waiting for a decision.',
        actor: human,
        blockedAt: now,
      },
      revision: 2,
      createdAt: now,
      updatedAt: now,
    }),
  );
  repositories.dependencies.create(
    taskDependencySchema.parse({
      projectId: project.id,
      taskId: 'task-b',
      prerequisiteTaskId: 'task-a',
      createdBy: human,
      createdAt: now,
    }),
  );
  return { project, sharedWorkspace };
};

const setup = (options?: {
  archived?: boolean;
  billingConflict?: boolean;
  repositories?: Parameters<typeof createTestRepositories>[0];
  sharedWorkspace?: boolean;
}) => {
  const repositories = createTestRepositories(options?.repositories);
  const seeded = seedProject(repositories, options);
  const publisher = new EventPublisher();
  const registry: RegistryDouble = {
    auditStatus: 'available',
    create: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    reportAuditFailure: vi.fn(() => undefined),
    publisher,
  };
  const capabilities = new PlanningCapabilityRegistry({
    now: () => new Date(now),
  });
  let nextId = 0;
  const service = new PlanningExecutionService({
    ...repositories,
    registry,
    capabilities,
    billingConflicts: options?.billingConflict
      ? [{ variable: 'ANTHROPIC_API_KEY' }]
      : [],
    pathOptions: { baseDirectory: 'C:/code' },
    resolveIdentity: async (): Promise<RepositoryIdentity> =>
      ({
        canonicalPath: repositoryPath,
        commonDirectory: repositoryIdentity,
        repositoryIdentity,
        associatedWorktreePaths: [repositoryPath],
        headCommit: 'a'.repeat(40),
      }) as unknown as RepositoryIdentity,
    now: () => now,
    createId: () => `generated-${++nextId}`,
  });
  return {
    capabilities,
    project: seeded.project,
    publisher,
    registry,
    repositories,
    service,
    sharedWorkspace: seeded.sharedWorkspace,
  };
};

const start = (
  service: PlanningExecutionService,
  overrides: Partial<Parameters<PlanningExecutionService['start']>[0]> = {},
) =>
  service.start({
    projectId: 'project-1',
    goal: 'Plan dependency-aware delivery.',
    constraints: 'Preserve current task authority.\nUse durable state.',
    nonGoals: 'Do not schedule continuously.',
    actor: human,
    commandId: 'plan-start-1',
    ...overrides,
  });

const runtimeConfiguration = (
  registry: RegistryDouble,
  call = 0,
): PlanningRuntimeConfiguration =>
  registry.create.mock.calls[call]?.[1] as PlanningRuntimeConfiguration;

const makeResumable = (repositories: TestRepositories, sessionId: string) => {
  repositories.database
    .prepare(
      "UPDATE sessions SET claude_resume_id = ?, lifecycle_state = 'interrupted' WHERE id = ?",
    )
    .run(`resume-${sessionId}`, sessionId);
};

describe('PlanningExecutionService', () => {
  const repositories: TestRepositories[] = [];

  afterEach(() => repositories.splice(0).forEach((repo) => repo.dispose()));

  const arrange = (...args: Parameters<typeof setup>) => {
    const result = setup(...args);
    repositories.push(result.repositories);
    return result;
  };

  it('commits a normalized start, command result, and event before starting the PM runtime', async () => {
    const { project, registry, repositories, service, sharedWorkspace } =
      arrange({ sharedWorkspace: true });
    const published: string[] = [];
    vi.spyOn(registry.publisher, 'publishProject').mockImplementation(
      (event) => {
        published.push(event.id);
      },
    );
    const durableAtStart: boolean[] = [];
    registry.create.mockImplementation(async (sessionId: string) => {
      const command = repositories.database
        .prepare(
          'SELECT state FROM processed_commands WHERE idempotency_key = ?',
        )
        .get('plan-start-1') as { state: string } | undefined;
      durableAtStart.push(
        !repositories.database.inTransaction &&
          repositories.sessions.get(sessionId) !== undefined &&
          repositories.plans.getActiveByProject(project.id) !== undefined &&
          repositories.projectEvents.after(project.id, 0).length === 1 &&
          command?.state === 'completed' &&
          published.length === 1,
      );
    });

    const started = await start(service);

    expect(started.plan).toMatchObject({
      projectId: project.id,
      status: 'planning',
      revision: 1,
      constraints: ['Preserve current task authority.', 'Use durable state.'],
      nonGoals: ['Do not schedule continuously.'],
    });
    expect(started.base).toMatchObject({
      ordinal: 1,
      repositoryIdentity,
      tasks: [
        { id: 'task-a', revision: 2, lifecycleState: 'backlog' },
        { id: 'task-b', revision: 3, lifecycleState: 'ready' },
      ],
      dependencies: [{ taskId: 'task-b', prerequisiteTaskId: 'task-a' }],
      projectArchivedAt: null,
      projectRevision: project.revision,
      policyRevision: project.qaConfiguration.revision,
    });
    expect(started.session?.workspaceId).toBe(sharedWorkspace?.id);
    expect(repositories.workspaces.listByProject(project.id)).toHaveLength(1);
    expect(durableAtStart).toEqual([true]);
    expect(started.events).toHaveLength(1);
    expect(started.events[0]?.type).toBe('project.plan_changed');
    expect(runtimeConfiguration(registry)).toMatchObject({
      role: 'pm',
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'mcp__mesh_pm__submit_project_plan',
      ],
    });
    expect(runtimeConfiguration(registry).initialPrompt).toContain(
      `Plan ID: ${started.plan.id}`,
    );
  });

  it('returns the committed start for a duplicate command without starting twice', async () => {
    const { registry, service } = arrange();

    const first = await start(service);
    const duplicate = await start(service);

    expect(duplicate).toEqual(first);
    expect(registry.create).toHaveBeenCalledTimes(1);
    await expect(start(service, { actor: agent })).rejects.toMatchObject({
      code: 'project_plan_unauthorized',
    });
  });

  it.each([
    ['non-human authority', { actor: agent }, 'project_plan_unauthorized'],
    ['an archived project', {}, 'project_archived'],
  ] as const)(
    'rejects %s without creating planning state',
    async (reason, overrides, code) => {
      const { repositories: repos, service } = arrange({
        archived: reason === 'an archived project',
      });

      await expect(start(service, overrides)).rejects.toMatchObject({ code });
      expect(repos.plans.getActiveByProject('project-1')).toBeUndefined();
      expect(repos.sessions.listByProject('project-1')).toEqual([]);
    },
  );

  it('refuses API-key billing conflicts and a second nonterminal plan', async () => {
    const billing = arrange({ billingConflict: true });
    await expect(start(billing.service)).rejects.toMatchObject({
      code: 'project_plan_billing_conflict',
    });
    expect(
      billing.repositories.plans.getActiveByProject('project-1'),
    ).toBeUndefined();

    const active = arrange();
    await start(active.service);
    await expect(
      start(active.service, { commandId: 'plan-start-2' }),
    ).rejects.toMatchObject({ code: 'project_plan_lifecycle_invalid' });
    expect(active.registry.create).toHaveBeenCalledTimes(1);
  });

  it('rolls back all lifecycle rows and trips the audit barrier when command completion fails', async () => {
    const {
      registry,
      repositories: repos,
      service,
    } = arrange({
      repositories: { failCommandCompleteFor: 'plan-start-1' },
    });

    await expect(start(service)).rejects.toBeDefined();

    expect(repos.plans.getActiveByProject('project-1')).toBeUndefined();
    expect(repos.sessions.listByProject('project-1')).toEqual([]);
    expect(repos.projectEvents.after('project-1', 0)).toEqual([]);
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.reportAuditFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps an invalid structured submission reusable and consumes an accepted generation', async () => {
    const { registry, service } = arrange();
    const started = await start(service);
    const configuration = runtimeConfiguration(registry);
    const invalid = {
      ...proposal(),
      tasks: [
        proposal().tasks[0]!,
        {
          ...proposal().tasks[0]!,
          key: 'runtime',
          title: 'Compose runtime',
        },
      ],
      dependencies: [
        {
          dependentTaskKey: 'persistence',
          prerequisite: { type: 'proposal_task', taskKey: 'runtime' },
        },
        {
          dependentTaskKey: 'runtime',
          prerequisite: { type: 'proposal_task', taskKey: 'persistence' },
        },
      ],
    } as unknown as ProjectPlanProposalInput;

    await expect(
      service.submitProposal({
        capability: configuration.capability,
        proposal: invalid,
      }),
    ).rejects.toMatchObject({ code: 'planning_proposal_invalid' });

    const submitted = await service.submitProposal({
      capability: configuration.capability,
      proposal: proposal(),
    });

    expect(submitted).toMatchObject({
      plan: {
        id: started.plan.id,
        status: 'awaiting_review',
        latestProposalOrdinal: 1,
      },
      proposal: {
        baseId: started.base?.id,
        capabilityGeneration: 1,
        sessionId: started.session?.id,
      },
    });
    await expect(
      service.submitProposal({
        capability: configuration.capability,
        proposal: proposal(),
      }),
    ).rejects.toMatchObject({ code: 'planning_capability_invalid' });
  });

  it('rejects out-of-project existing-task references without consuming the capability', async () => {
    const { registry, repositories: repos, service } = arrange();
    repos.projects.create(
      projectSchema.parse({
        id: 'project-2',
        displayName: 'Other project',
        repositoryPath: 'C:/code/project-two',
        repositoryIdentity: 'C:/code/project-two/.git',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    repos.tasks.create(
      taskSchema.parse({
        id: 'other-task',
        projectId: 'project-2',
        title: 'Other task',
        description: '',
        acceptanceCriteria: ['It stays isolated.'],
        priority: 'normal',
        rank: 'a',
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await start(service);
    const configuration = runtimeConfiguration(registry);

    await expect(
      service.submitProposal({
        capability: configuration.capability,
        proposal: proposal({
          dependencies: [
            {
              dependentTaskKey: 'persistence',
              prerequisite: {
                type: 'existing_task',
                taskId: 'other-task',
              },
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'project_plan_proposal_invalid' });

    await expect(
      service.submitProposal({
        capability: configuration.capability,
        proposal: proposal(),
      }),
    ).resolves.toMatchObject({ plan: { status: 'awaiting_review' } });
  });

  it('captures revision feedback and base two before resuming the same PM session with generation two', async () => {
    const { registry, repositories: repos, service } = arrange();
    const started = await start(service);
    const submitted = await service.submitProposal({
      capability: runtimeConfiguration(registry).capability,
      proposal: proposal(),
    });
    makeResumable(repos, started.session!.id);
    const durableAtResume: boolean[] = [];
    registry.resume.mockImplementation(async (sessionId: string) => {
      const details = repos.plans.getDetails(started.plan.id);
      durableAtResume.push(
        !repos.database.inTransaction &&
          details?.bases.length === 2 &&
          details.feedback.length === 1 &&
          repos.projectEvents.after('project-1', 0).length === 3 &&
          details.plan.currentSessionId === sessionId,
      );
    });

    const revised = await service.requestRevision({
      projectId: 'project-1',
      planId: started.plan.id,
      proposalId: submitted.proposal!.id,
      expectedPlanRevision: submitted.plan.revision,
      feedback: 'Split persistence from runtime composition.',
      actor: human,
      commandId: 'plan-revise-1',
    });

    expect(revised.plan).toMatchObject({ status: 'revising' });
    expect(revised.base?.ordinal).toBe(2);
    expect(revised.session?.id).toBe(started.session?.id);
    expect(registry.resume).toHaveBeenCalledTimes(1);
    expect(registry.resume.mock.calls[0]?.[0]).toBe(started.session?.id);
    expect(
      (registry.resume.mock.calls[0]?.[2] as PlanningRuntimeConfiguration)
        .capabilityGeneration,
    ).toBe(2);
    expect(durableAtResume).toEqual([true]);
    expect(
      repos.database
        .prepare(
          'SELECT capability_generation FROM project_plan_sessions WHERE session_id = ?',
        )
        .get(started.session!.id),
    ).toEqual({ capability_generation: 2 });
  });

  it('rejects a stale human control revision without changing or interrupting the plan', async () => {
    const { registry, service } = arrange();
    const started = await start(service);

    await expect(
      service.cancel({
        projectId: 'project-1',
        planId: started.plan.id,
        expectedPlanRevision: started.plan.revision + 1,
        actor: human,
        commandId: 'plan-cancel-stale',
        reason: 'No longer needed.',
      }),
    ).rejects.toMatchObject({ code: 'project_plan_revision_conflict' });
    expect(registry.interrupt).not.toHaveBeenCalled();
    expect(service).toBeDefined();
  });

  it('persists runtime attention and a diagnostic when initial startup fails', async () => {
    const { registry, repositories: repos, service } = arrange();
    registry.create.mockRejectedValueOnce(new Error('driver unavailable'));

    await expect(start(service)).rejects.toMatchObject({
      code: 'project_plan_repair_required',
    });

    const plan = repos.plans.getActiveByProject('project-1')!;
    expect(plan).toMatchObject({
      status: 'attention_required',
      attention: { type: 'runtime_failure' },
    });
    expect(repos.sessions.get(plan.currentSessionId!)).toBeDefined();
    expect(repos.diagnostics.list(plan.currentSessionId!)).toHaveLength(1);
    expect(repos.projectEvents.after('project-1', 0)).toHaveLength(2);
    await expect(
      service.submitProposal({
        capability: runtimeConfiguration(registry).capability,
        proposal: proposal(),
      }),
    ).rejects.toMatchObject({ code: 'planning_capability_invalid' });
  });

  it('resumes an interrupted attention session with a fresh generation', async () => {
    const { registry, repositories: repos, service } = arrange();
    registry.create.mockRejectedValueOnce(new Error('driver unavailable'));
    await expect(start(service)).rejects.toBeDefined();
    const attention = repos.plans.getActiveByProject('project-1')!;
    makeResumable(repos, attention.currentSessionId!);

    const resumed = await service.resume({
      projectId: 'project-1',
      planId: attention.id,
      expectedPlanRevision: attention.revision,
      actor: human,
      commandId: 'plan-resume-1',
    });

    expect(resumed.plan).toMatchObject({
      id: attention.id,
      status: 'planning',
    });
    expect(resumed.session?.id).toBe(attention.currentSessionId);
    expect(registry.resume).toHaveBeenCalledTimes(1);
    expect(
      (registry.resume.mock.calls[0]?.[2] as PlanningRuntimeConfiguration)
        .capabilityGeneration,
    ).toBe(2);
  });

  it('retries attention with a replacement session without changing plan identity', async () => {
    const { registry, repositories: repos, service } = arrange();
    registry.create.mockRejectedValueOnce(new Error('driver unavailable'));
    await expect(start(service)).rejects.toBeDefined();
    const attention = repos.plans.getActiveByProject('project-1')!;
    registry.create.mockResolvedValue(undefined);

    const retried = await service.retry({
      projectId: 'project-1',
      planId: attention.id,
      expectedPlanRevision: attention.revision,
      actor: human,
      commandId: 'plan-retry-1',
    });

    expect(retried.plan.id).toBe(attention.id);
    expect(retried.plan.status).toBe('planning');
    expect(retried.session?.id).not.toBe(attention.currentSessionId);
    expect(registry.create).toHaveBeenCalledTimes(2);
    expect(
      repos.database
        .prepare(
          'SELECT session_id, capability_generation, ended_at FROM project_plan_sessions WHERE plan_id = ? ORDER BY capability_generation',
        )
        .all(attention.id),
    ).toEqual([
      {
        session_id: attention.currentSessionId,
        capability_generation: 1,
        ended_at: now,
      },
      {
        session_id: retried.session?.id,
        capability_generation: 2,
        ended_at: null,
      },
    ]);
  });

  it('keeps committed revision evidence and returns to attention when resume fails', async () => {
    const { registry, repositories: repos, service } = arrange();
    const started = await start(service);
    const submitted = await service.submitProposal({
      capability: runtimeConfiguration(registry).capability,
      proposal: proposal(),
    });
    makeResumable(repos, started.session!.id);
    registry.resume.mockRejectedValueOnce(new Error('resume failed'));

    await expect(
      service.requestRevision({
        projectId: 'project-1',
        planId: started.plan.id,
        proposalId: submitted.proposal!.id,
        expectedPlanRevision: submitted.plan.revision,
        feedback: 'Try a smaller runtime boundary.',
        actor: human,
        commandId: 'plan-revise-failed',
      }),
    ).rejects.toMatchObject({ code: 'project_plan_repair_required' });

    const details = repos.plans.getDetails(started.plan.id)!;
    expect(details.plan).toMatchObject({
      status: 'attention_required',
      attention: { type: 'runtime_failure' },
    });
    expect(details.bases).toHaveLength(2);
    expect(details.feedback).toMatchObject([
      { content: 'Try a smaller runtime boundary.' },
    ]);
    expect(repos.diagnostics.list(started.session!.id)).toHaveLength(1);
  });

  it('cancels durably, revokes authority, and records interruption failure without restoring it', async () => {
    const { registry, repositories: repos, service } = arrange();
    const started = await start(service);
    const capability = runtimeConfiguration(registry).capability;
    registry.interrupt.mockRejectedValueOnce(new Error('interrupt failed'));

    const cancelled = await service.cancel({
      projectId: 'project-1',
      planId: started.plan.id,
      expectedPlanRevision: started.plan.revision,
      actor: human,
      commandId: 'plan-cancel-1',
      reason: 'The goal changed.',
    });
    const duplicate = await service.cancel({
      projectId: 'project-1',
      planId: started.plan.id,
      expectedPlanRevision: started.plan.revision,
      actor: human,
      commandId: 'plan-cancel-1',
      reason: 'The goal changed.',
    });

    expect(cancelled.plan).toMatchObject({
      status: 'cancelled',
      terminalReason: 'The goal changed.',
      terminalBy: human,
    });
    expect(duplicate).toEqual(cancelled);
    expect(registry.interrupt).toHaveBeenCalledTimes(1);
    expect(repos.diagnostics.list(started.session!.id)).toHaveLength(1);
    await expect(
      service.submitProposal({ capability, proposal: proposal() }),
    ).rejects.toMatchObject({ code: 'planning_capability_invalid' });
  });
});
