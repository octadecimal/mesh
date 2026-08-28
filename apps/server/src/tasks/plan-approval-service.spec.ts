import {
  projectPlanBaseSchema,
  projectPlanProposalInputSchema,
  projectPlanSchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskDependencySchema,
  taskSchema,
  workspaceSchema,
  type Project,
  type ProjectPlanProposalInput,
  type Task,
  type TaskActor,
} from '@mesh-session-platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { PM_POLICY_VERSION } from '../domain/planning-policy.js';
import { createTestRepositories } from '../test/create-test-database.js';
import {
  PlanApprovalService,
  type ApproveProjectPlanInput,
} from './plan-approval-service.js';

const now = '2026-08-27T12:00:00.000Z';
const later = '2026-08-27T12:05:00.000Z';

const human = taskActorSchema.parse({
  type: 'human',
  id: 'operator-1',
  displayName: 'Operator',
}) as TaskActor;

const agent = taskActorSchema.parse({
  type: 'agent',
  id: 'pm-agent-1',
}) as TaskActor;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const required = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) throw new Error(message);
  return value;
};

type ProposalInput = z.input<typeof projectPlanProposalInputSchema>;

const proposalTask = (key: string): ProposalInput['tasks'][number] => ({
  key,
  title: `Implement ${key}`,
  description: `Deliver the ${key} task contract.`,
  acceptanceCriteria: [`The ${key} behavior is verified.`],
  priority: 'high' as const,
  labels: ['planning'],
  rationale: `${key} is required by the proposal.`,
  goalMapping: `${key} advances the project goal.`,
});

const proposal = (
  overrides: Partial<ProposalInput> = {},
): ProjectPlanProposalInput =>
  projectPlanProposalInputSchema.parse({
    tasks: [proposalTask('implementation')],
    dependencies: [],
    assumptions: ['SQLite remains the durable audit store.'],
    risks: ['Approval can fail during persistence.'],
    exclusions: ['No existing task edits.'],
    ...overrides,
  });

type TestRepositories = ReturnType<typeof createTestRepositories>;

type ArrangeOptions = {
  existingDependencies?: Array<ReturnType<typeof taskDependencySchema.parse>>;
  existingTasks?: Task[];
  proposalInput?: ProjectPlanProposalInput;
  repositoryOptions?: Parameters<typeof createTestRepositories>[0];
};

const storedTask = (
  projectId: string,
  id: string,
  overrides: Partial<Task> = {},
): Task =>
  taskSchema.parse({
    id,
    projectId,
    title: `Task ${id}`,
    description: `Description for ${id}.`,
    acceptanceCriteria: [`${id} is complete.`],
    priority: 'normal',
    rank: id,
    lifecycleState: 'done',
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

const defaultExistingTask = storedTask('project-1', 'existing-task');

const createPlan = (
  repositories: TestRepositories,
  project: Project,
  sessionId: string,
  proposalInputs: ProjectPlanProposalInput[],
) => {
  const tasks = repositories.tasks
    .listByProject(project.id)
    .map(({ id, revision, lifecycleState, blocked }) => ({
      id,
      revision,
      lifecycleState,
      blocked,
    }));
  const dependencies = repositories.dependencies
    .listByProject(project.id)
    .sort(
      (left, right) =>
        compareText(left.taskId, right.taskId) ||
        compareText(left.prerequisiteTaskId, right.prerequisiteTaskId),
    );
  const base = projectPlanBaseSchema.parse({
    id: 'base-1',
    planId: 'plan-1',
    ordinal: 1,
    repositoryIdentity: project.repositoryIdentity,
    tasks,
    dependencies,
    projectArchivedAt: project.archivedAt,
    projectRevision: project.revision,
    policyRevision: project.qaConfiguration.revision,
    createdAt: now,
  });
  repositories.plans.create({
    plan: projectPlanSchema.parse({
      id: 'plan-1',
      projectId: project.id,
      goal: 'Deliver a dependency-aware milestone.',
      constraints: ['Preserve existing task authority.'],
      nonGoals: ['Do not schedule work continuously.'],
      policyVersion: PM_POLICY_VERSION,
      status: 'planning',
      revision: 1,
      currentBaseId: base.id,
      currentSessionId: sessionId,
      latestProposalOrdinal: 0,
      feedback: [],
      attention: null,
      createdBy: human,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
      terminalBy: null,
      terminalReason: null,
    }),
    base,
    sessionId,
  });

  const proposals = proposalInputs.map((input, index) => {
    const current = repositories.plans.get('plan-1');
    if (!current) throw new Error('Expected current plan');
    return repositories.plans.appendProposal({
      ...input,
      id: `proposal-${index + 1}`,
      planId: current.id,
      expectedRevision: current.revision,
      baseId: base.id,
      sessionId,
      submittedAt: now,
    });
  });
  const current = repositories.plans.get('plan-1');
  if (!current) throw new Error('Expected proposed plan');
  const awaitingReview = repositories.plans.update(
    current.id,
    current.revision,
    {
      status: 'awaiting_review',
      attention: null,
      updatedAt: now,
      terminalAt: null,
      terminalBy: null,
      terminalReason: null,
    },
  );
  if (!awaitingReview) throw new Error('Expected awaiting-review plan');
  return { base, plan: awaitingReview, proposals };
};

const activeCounts = (repositories: TestRepositories) => ({
  tasks: repositories.tasks.listByProject('project-1').length,
  dependencies: repositories.dependencies.listByProject('project-1').length,
  events: repositories.projectEvents.after('project-1', 0).length,
  mappings: (
    repositories.database
      .prepare(
        'SELECT COUNT(*) AS count FROM project_plan_task_mappings WHERE project_id = ?',
      )
      .get('project-1') as { count: number }
  ).count,
});

const disposals: Array<() => void> = [];

const arrange = (options: ArrangeOptions = {}) => {
  const repositories = createTestRepositories(options.repositoryOptions);
  disposals.push(repositories.dispose);
  const project = repositories.projects.create(
    projectSchema.parse({
      id: 'project-1',
      displayName: 'Project one',
      repositoryPath: 'C:/code/project-one',
      repositoryIdentity: 'C:/code/.git',
      discoveredAt: now,
      discoveryMetadata: {},
    }),
  );
  const workspace = repositories.workspaces.create(
    workspaceSchema.parse({
      id: 'workspace-1',
      projectId: project.id,
      type: 'shared',
      path: project.repositoryPath,
      cleanupState: 'active',
    }),
  );
  const session = repositories.sessions.create(
    sessionSchema.parse({
      id: 'session-1',
      projectId: project.id,
      workspaceId: workspace.id,
      title: 'Planning project one',
      permissionMode: 'safe_auto',
      lifecycleState: 'completed',
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (const task of options.existingTasks ?? [defaultExistingTask]) {
    repositories.tasks.create(task);
  }
  for (const dependency of options.existingDependencies ?? []) {
    repositories.dependencies.create(dependency);
  }
  const planning = createPlan(repositories, project, session.id, [
    options.proposalInput ?? proposal(),
  ]);

  const published: Array<{
    eventId: string;
    inTransaction: boolean;
    planStatus: string | undefined;
    taskCount: number;
  }> = [];
  const publisher = {
    publishProject: vi.fn((event: { id: string }) => {
      published.push({
        eventId: event.id,
        inTransaction: repositories.database.inTransaction,
        planStatus: repositories.plans.get(planning.plan.id)?.status,
        taskCount: repositories.tasks.listByProject(project.id).length,
      });
    }),
  };
  const onAuditFailure = vi.fn<(error: unknown) => void>();
  let nextId = 0;
  const service = new PlanApprovalService({
    ...repositories,
    publisher,
    onAuditFailure,
    now: () => later,
    createId: () => `approval-${++nextId}`,
  });
  const approveInput: ApproveProjectPlanInput = {
    projectId: project.id,
    planId: planning.plan.id,
    proposalId: required(
      planning.proposals.at(-1),
      'Expected an approval proposal',
    ).id,
    expectedPlanRevision: planning.plan.revision,
    actor: human,
    commandId: 'plan-approve-1',
  };
  return {
    approveInput,
    onAuditFailure,
    planning,
    project,
    published,
    publisher,
    repositories,
    service,
  };
};

afterEach(() => {
  while (disposals.length > 0) disposals.pop()?.();
});

describe('PlanApprovalService stale approval', () => {
  it.each([
    [
      'task addition',
      (context: ReturnType<typeof arrange>) => {
        context.repositories.tasks.create(
          storedTask(context.project.id, 'task-added'),
        );
        return {
          addedTaskIds: ['task-added'],
          changedTaskIds: [],
          removedTaskIds: [],
        };
      },
    ],
    [
      'task removal',
      (context: ReturnType<typeof arrange>) => {
        context.repositories.database
          .prepare('DELETE FROM tasks WHERE id = ?')
          .run('existing-task');
        return {
          addedTaskIds: [],
          changedTaskIds: [],
          removedTaskIds: ['existing-task'],
        };
      },
    ],
    [
      'task edit',
      (context: ReturnType<typeof arrange>) => {
        const task = required(
          context.repositories.tasks.get('existing-task'),
          'Expected an existing task',
        );
        context.repositories.tasks.update(
          { ...task, title: 'Edited title', updatedAt: later },
          task.revision,
        );
        return {
          addedTaskIds: [],
          changedTaskIds: ['existing-task'],
          removedTaskIds: [],
        };
      },
    ],
    [
      'task transition',
      (context: ReturnType<typeof arrange>) => {
        const task = required(
          context.repositories.tasks.get('existing-task'),
          'Expected an existing task',
        );
        context.repositories.tasks.update(
          { ...task, lifecycleState: 'review', updatedAt: later },
          task.revision,
        );
        return {
          addedTaskIds: [],
          changedTaskIds: ['existing-task'],
          removedTaskIds: [],
        };
      },
    ],
    [
      'task block change',
      (context: ReturnType<typeof arrange>) => {
        const task = required(
          context.repositories.tasks.get('existing-task'),
          'Expected an existing task',
        );
        context.repositories.tasks.update(
          {
            ...task,
            blocked: {
              reason: 'Blocked after planning.',
              actor: human,
              blockedAt: later,
            },
            updatedAt: later,
          },
          task.revision,
        );
        return {
          addedTaskIds: [],
          changedTaskIds: ['existing-task'],
          removedTaskIds: [],
        };
      },
    ],
    [
      'task reorder',
      (context: ReturnType<typeof arrange>) => {
        const task = required(
          context.repositories.tasks.get('existing-task'),
          'Expected an existing task',
        );
        context.repositories.tasks.update(
          { ...task, rank: 'reordered', updatedAt: later },
          task.revision,
        );
        return {
          addedTaskIds: [],
          changedTaskIds: ['existing-task'],
          removedTaskIds: [],
        };
      },
    ],
  ])(
    'reports %s and leaves approval state untouched',
    async (_name, mutate) => {
      const context = arrange();
      const expected = mutate(context);
      const before = activeCounts(context.repositories);

      await expect(
        context.service.approve(context.approveInput),
      ).rejects.toMatchObject({
        code: 'project_plan_stale',
        details: {
          ...expected,
          dependenciesChanged: false,
          policyChanged: false,
        },
      });

      expect(activeCounts(context.repositories)).toEqual(before);
      expect(context.repositories.plans.get('plan-1')?.status).toBe(
        'awaiting_review',
      );
      expect(context.publisher.publishProject).not.toHaveBeenCalled();
    },
  );

  it('reports dependency changes without treating planning events as board changes', async () => {
    const context = arrange({
      existingTasks: [
        storedTask('project-1', 'existing-a'),
        storedTask('project-1', 'existing-b'),
      ],
    });
    context.repositories.dependencies.create(
      taskDependencySchema.parse({
        projectId: context.project.id,
        taskId: 'existing-b',
        prerequisiteTaskId: 'existing-a',
        createdBy: human,
        createdAt: later,
      }),
    );

    await expect(
      context.service.approve(context.approveInput),
    ).rejects.toMatchObject({
      code: 'project_plan_stale',
      details: {
        addedTaskIds: [],
        removedTaskIds: [],
        changedTaskIds: [],
        dependenciesChanged: true,
        policyChanged: false,
      },
    });

    const fresh = arrange();
    fresh.repositories.projectEvents.append(fresh.project.id, {
      protocolVersion: 1,
      id: 'planning-event-only',
      projectId: fresh.project.id,
      occurredAt: later,
      type: 'project.plan_changed',
      payload: { plan: fresh.planning.plan },
    });
    await expect(
      fresh.service.approve(fresh.approveInput),
    ).resolves.toMatchObject({
      plan: { status: 'approved' },
    });
  });

  it('detects a board reorder even when stored task revisions do not change', async () => {
    const context = arrange({
      existingTasks: [
        storedTask('project-1', 'task-a'),
        storedTask('project-1', 'task-b'),
      ],
    });
    context.repositories.database
      .prepare('UPDATE tasks SET rank = ? WHERE id = ?')
      .run('z', 'task-a');

    await expect(
      context.service.approve(context.approveInput),
    ).rejects.toMatchObject({
      code: 'project_plan_stale',
      details: {
        addedTaskIds: [],
        removedTaskIds: [],
        changedTaskIds: ['task-a', 'task-b'],
        dependenciesChanged: false,
        policyChanged: false,
      },
    });
  });

  it.each(['archive', 'policy revision'] as const)(
    'reports a project %s as a policy change',
    async (change) => {
      const context = arrange();
      if (change === 'archive') {
        context.repositories.projects.archive(context.project.id, later);
      } else {
        context.repositories.projects.updateQaConfiguration(
          context.project.id,
          context.project.revision,
          {
            instructions: { content: 'Revised planning-relevant policy.' },
            reviewPolicy: 'manual',
          },
          human,
        );
      }

      await expect(
        context.service.approve(context.approveInput),
      ).rejects.toMatchObject({
        code: 'project_plan_stale',
        details: {
          addedTaskIds: [],
          removedTaskIds: [],
          changedTaskIds: [],
          dependenciesChanged: false,
          policyChanged: true,
        },
      });
    },
  );

  it('bounds every stale task category with exact totals and truncation flags', async () => {
    const existingTasks = Array.from({ length: 180 }, (_, index) =>
      storedTask('project-1', `base-${String(index).padStart(3, '0')}`),
    );
    const context = arrange({ existingTasks });
    for (let index = 0; index < 60; index += 1) {
      context.repositories.database
        .prepare('DELETE FROM tasks WHERE id = ?')
        .run(`base-${String(index).padStart(3, '0')}`);
    }
    for (let index = 60; index < 120; index += 1) {
      context.repositories.database
        .prepare('UPDATE tasks SET revision = revision + 1 WHERE id = ?')
        .run(`base-${String(index).padStart(3, '0')}`);
    }
    for (let index = 0; index < 60; index += 1) {
      context.repositories.tasks.create(
        storedTask('project-1', `new-${String(index).padStart(3, '0')}`),
      );
    }

    await expect(
      context.service.approve(context.approveInput),
    ).rejects.toMatchObject({
      code: 'project_plan_stale',
      details: {
        addedTaskIds: Array.from(
          { length: 50 },
          (_, index) => `new-${String(index).padStart(3, '0')}`,
        ),
        addedTaskTotal: 60,
        addedTaskIdsTruncated: true,
        removedTaskIds: Array.from(
          { length: 50 },
          (_, index) => `base-${String(index).padStart(3, '0')}`,
        ),
        removedTaskTotal: 60,
        removedTaskIdsTruncated: true,
        changedTaskIds: Array.from(
          { length: 50 },
          (_, index) => `base-${String(index + 60).padStart(3, '0')}`,
        ),
        changedTaskTotal: 60,
        changedTaskIdsTruncated: true,
      },
    });
  });
});

describe('PlanApprovalService rejection', () => {
  it('requires a human and a non-empty rejection reason without mutating the board', async () => {
    const unauthorized = arrange();
    const unauthorizedBefore = activeCounts(unauthorized.repositories);
    await expect(
      unauthorized.service.reject({
        projectId: unauthorized.project.id,
        planId: unauthorized.planning.plan.id,
        expectedPlanRevision: unauthorized.planning.plan.revision,
        actor: agent,
        commandId: 'plan-reject-agent',
        reason: 'The PM cannot reject its own proposal.',
      }),
    ).rejects.toMatchObject({ code: 'project_plan_unauthorized' });
    expect(activeCounts(unauthorized.repositories)).toEqual(unauthorizedBefore);

    const emptyReason = arrange();
    const emptyBefore = activeCounts(emptyReason.repositories);
    await expect(
      emptyReason.service.reject({
        projectId: emptyReason.project.id,
        planId: emptyReason.planning.plan.id,
        expectedPlanRevision: emptyReason.planning.plan.revision,
        actor: human,
        commandId: 'plan-reject-empty',
        reason: '   ',
      }),
    ).rejects.toMatchObject({ code: 'project_plan_lifecycle_invalid' });
    expect(activeCounts(emptyReason.repositories)).toEqual(emptyBefore);
  });

  it('records a terminal rejection once and never changes task or dependency truth', async () => {
    const context = arrange();
    const before = activeCounts(context.repositories);
    const input = {
      projectId: context.project.id,
      planId: context.planning.plan.id,
      expectedPlanRevision: context.planning.plan.revision,
      actor: human,
      commandId: 'plan-reject-1',
      reason: 'The proposal omits required operational work.',
    };

    const rejected = await context.service.reject(input);
    const duplicate = await context.service.reject(input);

    expect(rejected.plan).toMatchObject({
      status: 'rejected',
      terminalAt: later,
      terminalBy: human,
      terminalReason: input.reason,
    });
    expect(duplicate).toEqual(rejected);
    expect(activeCounts(context.repositories)).toEqual({
      ...before,
      events: before.events + 1,
    });
    expect(
      context.repositories.tasks.listByProject(context.project.id),
    ).toEqual([defaultExistingTask]);
    expect(context.publisher.publishProject).toHaveBeenCalledTimes(1);
    expect(rejected.events.map(({ type }) => type)).toEqual([
      'project.plan_changed',
    ]);
  });
});

describe('PlanApprovalService approval', () => {
  it('requires a human approval actor without reserving the command', async () => {
    const context = arrange();
    const before = activeCounts(context.repositories);

    await expect(
      context.service.approve({ ...context.approveInput, actor: agent }),
    ).rejects.toMatchObject({ code: 'project_plan_unauthorized' });

    expect(activeCounts(context.repositories)).toEqual(before);
    expect(
      context.repositories.commands.getExisting(context.approveInput.commandId)
        .found,
    ).toBe(false);
    expect(context.publisher.publishProject).not.toHaveBeenCalled();
  });

  it('requires the exact awaiting-review revision and latest proposal', async () => {
    const context = arrange();
    await expect(
      context.service.approve({
        ...context.approveInput,
        expectedPlanRevision: context.approveInput.expectedPlanRevision - 1,
      }),
    ).rejects.toMatchObject({ code: 'project_plan_revision_conflict' });

    const multiple = arrange();
    const current = required(
      multiple.repositories.plans.get('plan-1'),
      'Expected a current plan',
    );
    const older = multiple.repositories.plans.appendProposal({
      ...proposal({ tasks: [proposalTask('new-latest')] }),
      id: 'proposal-2',
      planId: current.id,
      expectedRevision: current.revision,
      baseId: multiple.planning.base.id,
      sessionId: 'session-1',
      submittedAt: later,
    });
    const afterProposal = required(
      multiple.repositories.plans.get('plan-1'),
      'Expected the appended proposal plan',
    );
    const awaiting = required(
      multiple.repositories.plans.update(
        afterProposal.id,
        afterProposal.revision,
        {
          status: 'awaiting_review',
          attention: null,
          updatedAt: later,
          terminalAt: null,
          terminalBy: null,
          terminalReason: null,
        },
      ),
      'Expected the plan to return to review',
    );
    expect(older.ordinal).toBe(2);
    await expect(
      multiple.service.approve({
        ...multiple.approveInput,
        proposalId: 'proposal-1',
        expectedPlanRevision: awaiting.revision,
      }),
    ).rejects.toMatchObject({ code: 'project_plan_proposal_invalid' });

    const wrongState = arrange();
    const revising = required(
      wrongState.repositories.plans.update(
        wrongState.planning.plan.id,
        wrongState.planning.plan.revision,
        {
          status: 'revising',
          attention: null,
          updatedAt: later,
          terminalAt: null,
          terminalBy: null,
          terminalReason: null,
        },
      ),
      'Expected a revising plan',
    );
    await expect(
      wrongState.service.approve({
        ...wrongState.approveInput,
        expectedPlanRevision: revising.revision,
      }),
    ).rejects.toMatchObject({ code: 'project_plan_lifecycle_invalid' });
  });

  it('atomically creates ordered backlog tasks, mappings, dependencies, and events', async () => {
    const input = proposal({
      tasks: [proposalTask('contracts'), proposalTask('server')],
      dependencies: [
        {
          dependentTaskKey: 'server',
          prerequisite: { type: 'proposal_task', taskKey: 'contracts' },
        },
        {
          dependentTaskKey: 'server',
          prerequisite: { type: 'existing_task', taskId: 'existing-task' },
        },
      ],
    });
    const context = arrange({ proposalInput: input });

    const approved = await context.service.approve(context.approveInput);

    expect(approved.plan).toMatchObject({
      status: 'approved',
      terminalAt: later,
      terminalBy: human,
      terminalReason: null,
    });
    expect(approved.createdTasks).toEqual([
      expect.objectContaining({
        id: 'approval-1',
        title: 'Implement contracts',
        rank: 'm',
        lifecycleState: 'backlog',
        revision: 1,
      }),
      expect.objectContaining({
        id: 'approval-2',
        title: 'Implement server',
        rank: 'mm',
        lifecycleState: 'backlog',
        revision: 1,
      }),
    ]);
    expect(approved.taskMappings).toEqual([
      { taskKey: 'contracts', taskId: 'approval-1' },
      { taskKey: 'server', taskId: 'approval-2' },
    ]);
    expect(approved.dependencies).toEqual([
      expect.objectContaining({
        taskId: 'approval-2',
        prerequisiteTaskId: 'approval-1',
        createdBy: human,
      }),
      expect.objectContaining({
        taskId: 'approval-2',
        prerequisiteTaskId: 'existing-task',
        createdBy: human,
      }),
    ]);
    expect(
      context.repositories.database
        .prepare(
          `SELECT proposal_task_key AS taskKey, task_id AS taskId
           FROM project_plan_task_mappings
           WHERE proposal_id = ? ORDER BY proposal_task_key`,
        )
        .all(context.approveInput.proposalId),
    ).toEqual([
      { taskKey: 'contracts', taskId: 'approval-1' },
      { taskKey: 'server', taskId: 'approval-2' },
    ]);

    expect(approved.events.map(({ type }) => type)).toEqual([
      'project.plan_changed',
      'task.changed',
      'task.changed',
      'task.dependencies_changed',
    ]);
    expect(
      context.repositories.projectEvents.after(context.project.id, 0),
    ).toEqual(approved.events);
    expect(
      approved.events.at(-1)?.type === 'task.dependencies_changed'
        ? approved.events.at(-1)?.payload
        : undefined,
    ).toEqual({
      taskId: 'approval-2',
      taskRevision: 1,
      taskUpdatedAt: later,
      dependencies: approved.dependencies,
    });
    expect(context.published).toEqual(
      approved.events.map((event) => ({
        eventId: event.id,
        inTransaction: false,
        planStatus: 'approved',
        taskCount: 3,
      })),
    );
  });

  it('returns the original mapping for duplicate delivery without further effects', async () => {
    const context = arrange({
      proposalInput: proposal({
        tasks: [proposalTask('contracts'), proposalTask('server')],
      }),
    });
    const first = await context.service.approve(context.approveInput);
    const afterFirst = activeCounts(context.repositories);
    const duplicate = await context.service.approve(context.approveInput);

    expect(duplicate).toEqual(first);
    expect(activeCounts(context.repositories)).toEqual(afterFirst);
    expect(context.publisher.publishProject).toHaveBeenCalledTimes(
      first.events.length,
    );
  });

  it('revalidates existing prerequisite state, ownership, and the combined graph', async () => {
    const cancelled = arrange({
      existingTasks: [
        storedTask('project-1', 'cancelled-prerequisite', {
          lifecycleState: 'cancelled',
        }),
      ],
      proposalInput: proposal({
        dependencies: [
          {
            dependentTaskKey: 'implementation',
            prerequisite: {
              type: 'existing_task',
              taskId: 'cancelled-prerequisite',
            },
          },
        ],
      }),
    });
    await expect(
      cancelled.service.approve(cancelled.approveInput),
    ).rejects.toMatchObject({
      code: 'task_dependency_invalid',
    });
    expect(activeCounts(cancelled.repositories).mappings).toBe(0);

    const outside = arrange({
      proposalInput: proposal({
        dependencies: [
          {
            dependentTaskKey: 'implementation',
            prerequisite: {
              type: 'existing_task',
              taskId: 'existing-task',
            },
          },
        ],
      }),
    });
    const outsideProject = outside.repositories.projects.create(
      projectSchema.parse({
        id: 'project-2',
        displayName: 'Project two',
        repositoryPath: 'C:/code/project-two',
        repositoryIdentity: 'C:/code/project-two/.git',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    outside.repositories.tasks.create(
      storedTask(outsideProject.id, 'outside-prerequisite'),
    );
    outside.repositories.database.exec('PRAGMA foreign_keys = OFF');
    outside.repositories.database
      .prepare(
        `UPDATE project_plan_proposal_dependencies
         SET prerequisite_task_id = ? WHERE proposal_id = ?`,
      )
      .run('outside-prerequisite', outside.approveInput.proposalId);
    outside.repositories.database.exec('PRAGMA foreign_keys = ON');
    await expect(
      outside.service.approve(outside.approveInput),
    ).rejects.toMatchObject({ code: 'task_dependency_invalid' });

    const cyclicRepositories = createTestRepositories();
    disposals.push(cyclicRepositories.dispose);
    const project = cyclicRepositories.projects.create(
      projectSchema.parse({
        id: 'project-1',
        displayName: 'Project one',
        repositoryPath: 'C:/code/project-one',
        repositoryIdentity: 'C:/code/.git',
        discoveredAt: now,
        discoveryMetadata: {},
      }),
    );
    cyclicRepositories.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-1',
        projectId: project.id,
        type: 'shared',
        path: project.repositoryPath,
        cleanupState: 'active',
      }),
    );
    cyclicRepositories.sessions.create(
      sessionSchema.parse({
        id: 'session-1',
        projectId: project.id,
        workspaceId: 'workspace-1',
        title: 'Planning project one',
        permissionMode: 'safe_auto',
        lifecycleState: 'completed',
        createdAt: now,
        updatedAt: now,
      }),
    );
    for (const id of ['cycle-a', 'cycle-b']) {
      cyclicRepositories.tasks.create(storedTask(project.id, id));
    }
    for (const [taskId, prerequisiteTaskId] of [
      ['cycle-a', 'cycle-b'],
      ['cycle-b', 'cycle-a'],
    ]) {
      cyclicRepositories.dependencies.create(
        taskDependencySchema.parse({
          projectId: project.id,
          taskId,
          prerequisiteTaskId,
          createdBy: human,
          createdAt: now,
        }),
      );
    }
    const planning = createPlan(cyclicRepositories, project, 'session-1', [
      proposal(),
    ]);
    const service = new PlanApprovalService({
      ...cyclicRepositories,
      publisher: { publishProject: vi.fn() },
      now: () => later,
      createId: () => 'cycle-generated',
    });
    await expect(
      service.approve({
        projectId: project.id,
        planId: planning.plan.id,
        proposalId: required(
          planning.proposals[0],
          'Expected a cyclic-board proposal',
        ).id,
        expectedPlanRevision: planning.plan.revision,
        actor: human,
        commandId: 'approve-cyclic-board',
      }),
    ).rejects.toMatchObject({ code: 'task_dependency_cycle' });
    expect(activeCounts(cyclicRepositories).mappings).toBe(0);
  });

  it('approves an unrelated proposal while retaining a cancelled prerequisite edge', async () => {
    const prerequisite = storedTask('project-1', 'cancelled-prerequisite', {
      lifecycleState: 'cancelled',
    });
    const dependent = storedTask('project-1', 'retained-dependent', {
      lifecycleState: 'backlog',
    });
    const retained = taskDependencySchema.parse({
      projectId: 'project-1',
      taskId: dependent.id,
      prerequisiteTaskId: prerequisite.id,
      createdBy: human,
      createdAt: now,
    });
    const context = arrange({
      existingTasks: [defaultExistingTask, prerequisite, dependent],
      existingDependencies: [retained],
      proposalInput: proposal({ dependencies: [] }),
    });

    const approved = await context.service.approve(context.approveInput);

    expect(approved.plan.status).toBe('approved');
    expect(
      context.repositories.dependencies.listByProject(context.project.id),
    ).toContainEqual(retained);
  });

  it('revalidates stored task contracts and proposal size limits', async () => {
    const invalidContract = arrange();
    invalidContract.repositories.database
      .prepare(
        'UPDATE project_plan_proposal_tasks SET description = ? WHERE proposal_id = ?',
      )
      .run('', invalidContract.approveInput.proposalId);
    await expect(
      invalidContract.service.approve(invalidContract.approveInput),
    ).rejects.toMatchObject({ code: 'project_plan_proposal_invalid' });

    const tooManyTasks = arrange();
    const insertTask = tooManyTasks.repositories.database.prepare(`
      INSERT INTO project_plan_proposal_tasks (
        proposal_id, task_key, ordinal, title, description,
        acceptance_criteria_json, priority, labels_json, rationale, goal_mapping
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 1; index <= 50; index += 1) {
      insertTask.run(
        tooManyTasks.approveInput.proposalId,
        `overflow-${index}`,
        index,
        `Overflow ${index}`,
        'A complete description.',
        JSON.stringify(['A complete criterion.']),
        'normal',
        '[]',
        'Required rationale.',
        'Required goal mapping.',
      );
    }
    await expect(
      tooManyTasks.service.approve(tooManyTasks.approveInput),
    ).rejects.toMatchObject({ code: 'project_plan_proposal_invalid' });

    const fiftyTasks = Array.from({ length: 50 }, (_, index) =>
      proposalTask(`task-${String(index).padStart(2, '0')}`),
    );
    const tooManyEdges = arrange({
      proposalInput: proposal({ tasks: fiftyTasks }),
    });
    const insertEdge = tooManyEdges.repositories.database.prepare(`
      INSERT INTO project_plan_proposal_dependencies (
        proposal_id, project_id, ordinal, dependent_task_key, prerequisite_type,
        prerequisite_task_key, prerequisite_task_id
      ) VALUES (?, ?, ?, ?, 'proposal_task', ?, NULL)
    `);
    let ordinal = 0;
    for (let dependent = 0; dependent < 50 && ordinal < 201; dependent += 1) {
      for (
        let prerequisite = 0;
        prerequisite < 50 && ordinal < 201;
        prerequisite += 1
      ) {
        if (dependent === prerequisite) continue;
        insertEdge.run(
          tooManyEdges.approveInput.proposalId,
          tooManyEdges.project.id,
          ordinal++,
          required(fiftyTasks[dependent], 'Expected a dependent task').key,
          required(fiftyTasks[prerequisite], 'Expected a prerequisite task')
            .key,
        );
      }
    }
    await expect(
      tooManyEdges.service.approve(tooManyEdges.approveInput),
    ).rejects.toMatchObject({ code: 'project_plan_proposal_invalid' });
  });

  it.each([
    ['task insert', 'task', 0],
    ['dependency insert', 'dependency', 0],
    ['event insert', 'event', 1],
    ['command completion', 'command', 1],
  ] as const)(
    'rolls back every approval row on %s failure',
    async (_name, stage, expectedAuditFailures) => {
      const context = arrange({
        proposalInput: proposal({
          dependencies: [
            {
              dependentTaskKey: 'implementation',
              prerequisite: { type: 'existing_task', taskId: 'existing-task' },
            },
          ],
        }),
        repositoryOptions:
          stage === 'command'
            ? { failCommandCompleteFor: 'plan-approve-1' }
            : undefined,
      });
      if (stage === 'task') {
        context.repositories.database.exec(`
          CREATE TRIGGER fail_approval_task
          BEFORE INSERT ON tasks
          WHEN NEW.id LIKE 'approval-%'
          BEGIN SELECT RAISE(FAIL, 'approval task insert failed'); END;
        `);
      } else if (stage === 'dependency') {
        context.repositories.database.exec(`
          CREATE TRIGGER fail_approval_dependency
          BEFORE INSERT ON task_dependencies
          WHEN NEW.task_id LIKE 'approval-%'
          BEGIN SELECT RAISE(FAIL, 'approval dependency insert failed'); END;
        `);
      } else if (stage === 'event') {
        context.repositories.database.exec(`
          CREATE TRIGGER fail_approval_event
          BEFORE INSERT ON project_events
          WHEN NEW.type = 'task.changed'
          BEGIN SELECT RAISE(FAIL, 'approval event insert failed'); END;
        `);
      }
      const before = activeCounts(context.repositories);

      await expect(
        context.service.approve(context.approveInput),
      ).rejects.toThrow();

      expect(activeCounts(context.repositories)).toEqual(before);
      expect(context.repositories.plans.get('plan-1')?.status).toBe(
        'awaiting_review',
      );
      expect(context.publisher.publishProject).not.toHaveBeenCalled();
      expect(context.onAuditFailure).toHaveBeenCalledTimes(
        expectedAuditFailures,
      );
      const command = context.repositories.database
        .prepare(
          'SELECT state FROM processed_commands WHERE idempotency_key = ?',
        )
        .get(context.approveInput.commandId) as { state: string } | undefined;
      expect(command?.state).not.toBe('completed');
    },
  );
});
