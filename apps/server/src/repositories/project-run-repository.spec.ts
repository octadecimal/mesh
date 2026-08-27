import {
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSourceSchema,
  taskAttemptSchema,
  taskSchema,
  workspaceSchema,
  type TaskAttemptSource,
} from '@mesh-session-platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectRunRepository } from './project-run-repository.js';
import { createTestRepositories } from '../test/create-test-database.js';

const at = '2026-08-27T00:00:00.000Z';

const setup = (options?: {
  failProjectEventInsert?: boolean;
  attemptSource?: TaskAttemptSource;
}) => {
  const repositories = createTestRepositories(options);
  repositories.projects.create(
    projectSchema.parse({
      id: 'project-1',
      displayName: 'Project',
      repositoryPath: 'C:/code/project',
      discoveredAt: at,
      discoveryMetadata: {},
    }),
  );
  for (const [id, rank] of [
    ['task-a', 'a'],
    ['task-b', 'b'],
    ['task-c', 'c'],
  ] as const) {
    repositories.tasks.create(
      taskSchema.parse({
        id,
        projectId: 'project-1',
        title: id,
        description: 'Persist this task.',
        acceptanceCriteria: ['Persist it'],
        priority: 'normal',
        rank,
        lifecycleState: 'ready',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      }),
    );
  }
  repositories.workspaces.create(
    workspaceSchema.parse({
      id: 'workspace-1',
      projectId: 'project-1',
      type: 'shared',
      path: 'C:/code/project',
    }),
  );
  repositories.sessions.create(
    sessionSchema.parse({
      id: 'session-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      title: 'Task A',
      permissionMode: 'safe_auto',
      lifecycleState: 'running',
      createdAt: at,
      updatedAt: at,
    }),
  );
  repositories.attempts.create(
    taskAttemptSchema.parse({
      id: 'attempt-1',
      taskId: 'task-a',
      sessionId: 'session-1',
      ordinal: 1,
      source: options?.attemptSource ?? {
        type: 'project_run',
        runId: 'run-1',
        runItemId: 'item-task-a',
      },
      actor: { type: 'system', id: 'system-1' },
      createdAt: at,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
      role: null,
    }),
  );
  return {
    ...repositories,
    projectRuns: new ProjectRunRepository(repositories.database),
  };
};

const createRun = (
  repository: ProjectRunRepository,
  taskIds = ['task-a', 'task-b'],
) =>
  repository.create({
    id: 'run-1',
    projectId: 'project-1',
    concurrency: 2,
    startedAt: at,
    items: taskIds.map((taskId, queuePosition) => ({
      id: `item-${taskId}`,
      taskId,
      taskRevision: 1,
      policyRevision: 1,
      taskAutomationGeneration: 0,
      queuePosition,
      launchIdempotencyKey: `launch-${taskId}`,
    })),
  });

describe('ProjectRunRepository', () => {
  const repositories: Array<ReturnType<typeof setup>> = [];

  afterEach(() =>
    repositories.splice(0).forEach((repository) => repository.dispose()),
  );

  it('creates a run and retains deterministic queue order', () => {
    const repository = setup();
    repositories.push(repository);

    expect(createRun(repository.projectRuns)).toMatchObject({
      id: 'run-1',
      state: 'running',
      revision: 1,
      items: [
        {
          taskId: 'task-a',
          queuePosition: 0,
          status: 'queued',
          policyRevision: 1,
          taskAutomationGeneration: 0,
        },
        {
          taskId: 'task-b',
          queuePosition: 1,
          status: 'queued',
          policyRevision: 1,
          taskAutomationGeneration: 0,
        },
      ],
    });
    expect(repository.projectRuns.listByProject('project-1')).toHaveLength(1);
  });

  it('persists the pause reason and clears it when the run resumes', () => {
    const repository = setup();
    repositories.push(repository);
    const run = createRun(repository.projectRuns, ['task-a']);

    const paused = repository.projectRuns.changeState({
      runId: run.id,
      expectedRunRevision: run.revision,
      state: 'paused',
      pauseReason: 'operator_paused',
      occurredAt: at,
    });
    expect(paused).toMatchObject({
      state: 'paused',
      pauseReason: 'operator_paused',
    });
    if (!paused) throw new Error('Expected paused run');

    expect(
      repository.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: paused.revision,
        state: 'running',
        occurredAt: at,
      }),
    ).toMatchObject({ state: 'running', pauseReason: null });
  });

  it('claims only the configured concurrency in queue order', () => {
    const repository = setup();
    repositories.push(repository);
    const run = createRun(repository.projectRuns, [
      'task-a',
      'task-b',
      'task-c',
    ]);

    const first = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: 1,
      occurredAt: at,
    });
    const second = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: first!.run.revision,
      occurredAt: at,
    });
    const full = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: second!.run.revision,
      occurredAt: at,
    });

    expect([first!.item.taskId, second!.item.taskId]).toEqual([
      'task-a',
      'task-b',
    ]);
    expect(full).toBeUndefined();
  });

  it('resets only the expected effect-free launch claim to queued', () => {
    const repository = setup({
      attemptSource: taskAttemptSourceSchema.parse('launched'),
    });
    repositories.push(repository);
    repository.attempts.unlink(
      'attempt-1',
      taskActorSchema.parse({ type: 'human', id: 'operator-1' }),
      'Historical attempt is no longer current.',
      at,
    );
    const run = createRun(repository.projectRuns, ['task-a']);
    const claim = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: run.revision,
      occurredAt: at,
    });
    if (!claim) throw new Error('Expected a claimed item');

    const reset = repository.projectRuns.resetLaunchClaim({
      runId: run.id,
      itemId: claim.item.id,
      expectedRunRevision: claim.run.revision,
      occurredAt: at,
    });

    expect(reset).toMatchObject({
      revision: claim.run.revision + 1,
      items: [
        {
          id: claim.item.id,
          status: 'queued',
          claimedAt: null,
          attemptId: null,
          sessionId: null,
        },
      ],
    });
    expect(() =>
      repository.projectRuns.resetLaunchClaim({
        runId: run.id,
        itemId: claim.item.id,
        expectedRunRevision: claim.run.revision,
        occurredAt: at,
      }),
    ).toThrow('Project run revision does not match');
  });

  it('rejects resetting a launch claim with any current attempt', () => {
    const repository = setup({
      attemptSource: taskAttemptSourceSchema.parse('launched'),
    });
    repositories.push(repository);
    const run = createRun(repository.projectRuns, ['task-a']);
    const claim = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: run.revision,
      occurredAt: at,
    });
    if (!claim) throw new Error('Expected a claimed item');

    expect(() =>
      repository.projectRuns.resetLaunchClaim({
        runId: run.id,
        itemId: claim.item.id,
        expectedRunRevision: claim.run.revision,
        occurredAt: at,
      }),
    ).toThrow('Project run launch claim cannot be reset');
    expect(repository.projectRuns.get(run.id)).toEqual(claim.run);
  });

  it('rejects resetting a launch claim after it becomes active', () => {
    const repository = setup();
    repositories.push(repository);
    const run = createRun(repository.projectRuns, ['task-a']);
    const claim = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: run.revision,
      occurredAt: at,
    });
    if (!claim) throw new Error('Expected a claimed item');
    const active = repository.projectRuns.linkLaunch({
      runId: run.id,
      itemId: claim.item.id,
      expectedRunRevision: claim.run.revision,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      occurredAt: at,
    });

    expect(() =>
      repository.projectRuns.resetLaunchClaim({
        runId: run.id,
        itemId: claim.item.id,
        expectedRunRevision: active.revision,
        occurredAt: at,
      }),
    ).toThrow('Project run launch claim cannot be reset');
    expect(repository.projectRuns.get(run.id)).toEqual(active);
  });

  it('rejects another open run for the project and a duplicate queued task', () => {
    const repository = setup();
    repositories.push(repository);
    createRun(repository.projectRuns);

    expect(() =>
      repository.projectRuns.create({
        id: 'run-2',
        projectId: 'project-1',
        concurrency: 1,
        startedAt: at,
        items: [],
      }),
    ).toThrow();
    expect(() =>
      repository.projectRuns.create({
        id: 'completed-run',
        projectId: 'project-1',
        concurrency: 1,
        startedAt: at,
        state: 'completed',
        completedAt: at,
        completionReason: 'previous',
        items: [
          {
            id: 'duplicate-task',
            taskId: 'task-a',
            taskRevision: 1,
            policyRevision: 1,
            taskAutomationGeneration: 0,
            queuePosition: 0,
            launchIdempotencyKey: 'launch-duplicate',
          },
        ],
      }),
    ).toThrow();
  });

  it('links a launch and persists a terminal outcome at the expected revision', () => {
    const repository = setup();
    repositories.push(repository);
    const run = createRun(repository.projectRuns, ['task-a']);
    const claim = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: run.revision,
      occurredAt: at,
    });
    const launched = repository.projectRuns.linkLaunch({
      runId: run.id,
      itemId: claim!.item.id,
      expectedRunRevision: claim!.run.revision,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      occurredAt: at,
    });

    const finished = repository.projectRuns.finishItem({
      runId: run.id,
      itemId: claim!.item.id,
      expectedRunRevision: launched.revision,
      status: 'completed',
      outcomeReason: 'task completed',
      occurredAt: at,
    });
    expect(finished.items[0]).toMatchObject({
      status: 'completed',
      outcomeReason: 'task completed',
      finishedAt: at,
    });
    expect(
      repository.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: launched.revision,
        state: 'paused',
        pauseReason: 'operator_paused',
        occurredAt: at,
      }),
    ).toBeUndefined();
  });

  it('persists attention required for a proven failure before launch linking', () => {
    const repository = setup();
    repositories.push(repository);
    const run = createRun(repository.projectRuns, ['task-a']);
    const claim = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: run.revision,
      occurredAt: at,
    });
    if (!claim) throw new Error('Expected a claimed item');

    const finished = repository.projectRuns.finishItem({
      runId: run.id,
      itemId: claim.item.id,
      expectedRunRevision: claim.run.revision,
      status: 'attention_required',
      outcomeReason: 'task_revision_conflict',
      occurredAt: at,
    });

    expect(finished.items[0]).toMatchObject({
      status: 'attention_required',
      attemptId: null,
      sessionId: null,
      startedAt: null,
      finishedAt: at,
      outcomeReason: 'task_revision_conflict',
    });
  });

  it.each([
    ['legacy launch', 'launched'],
    ['manual link', 'linked'],
  ] as const)(
    'rejects %s attempt provenance without changing the durable claim',
    (_label, attemptSource) => {
      const repository = setup({
        attemptSource: taskAttemptSourceSchema.parse(attemptSource),
      });
      repositories.push(repository);
      const run = createRun(repository.projectRuns, ['task-a']);
      const claim = repository.projectRuns.claimNext({
        runId: run.id,
        expectedRunRevision: run.revision,
        occurredAt: at,
      });
      if (!claim) throw new Error('Expected a claimed item');

      expect(() =>
        repository.projectRuns.linkLaunch({
          runId: run.id,
          itemId: claim.item.id,
          expectedRunRevision: claim.run.revision,
          attemptId: 'attempt-1',
          sessionId: 'session-1',
          occurredAt: at,
        }),
      ).toThrow('Project run item launch cannot be linked');
      expect(repository.database.inTransaction).toBe(false);
      expect(repository.projectRuns.get(run.id)).toMatchObject({
        revision: claim.run.revision,
        items: [
          {
            id: claim.item.id,
            status: 'launch_pending',
            attemptId: null,
            sessionId: null,
          },
        ],
      });
    },
  );

  it.each([
    [
      'another run',
      { type: 'project_run', runId: 'run-2', runItemId: 'item-task-a' },
    ],
    [
      'another item',
      { type: 'project_run', runId: 'run-1', runItemId: 'item-other' },
    ],
  ] as const)(
    'rejects project-run attempt provenance bound to %s',
    (_label, attemptSource) => {
      const repository = setup({
        attemptSource: taskAttemptSourceSchema.parse(attemptSource),
      });
      repositories.push(repository);
      const run = createRun(repository.projectRuns, ['task-a']);
      const claim = repository.projectRuns.claimNext({
        runId: run.id,
        expectedRunRevision: run.revision,
        occurredAt: at,
      });
      if (!claim) throw new Error('Expected a claimed item');

      expect(() =>
        repository.projectRuns.linkLaunch({
          runId: run.id,
          itemId: claim.item.id,
          expectedRunRevision: claim.run.revision,
          attemptId: 'attempt-1',
          sessionId: 'session-1',
          occurredAt: at,
        }),
      ).toThrow('Project run item launch cannot be linked');
      expect(repository.database.inTransaction).toBe(false);
      expect(repository.projectRuns.get(run.id)).toMatchObject({
        revision: claim.run.revision,
        items: [
          {
            id: claim.item.id,
            status: 'launch_pending',
            attemptId: null,
            sessionId: null,
          },
        ],
      });
    },
  );

  it('rejects launch links whose attempt task or session does not match the item', () => {
    const repository = setup();
    repositories.push(repository);
    repository.sessions.create(
      sessionSchema.parse({
        id: 'session-2',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        title: 'Task B',
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: at,
        updatedAt: at,
      }),
    );
    repository.attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-2',
        taskId: 'task-b',
        sessionId: 'session-2',
        ordinal: 1,
        source: 'launched',
        actor: { type: 'system', id: 'system-1' },
        createdAt: at,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: null,
      }),
    );
    const run = createRun(repository.projectRuns, ['task-a']);
    const claim = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: run.revision,
      occurredAt: at,
    });
    const input = {
      runId: run.id,
      itemId: claim!.item.id,
      expectedRunRevision: claim!.run.revision,
      occurredAt: at,
    };

    expect(() =>
      repository.projectRuns.linkLaunch({
        ...input,
        attemptId: 'attempt-2',
        sessionId: 'session-2',
      }),
    ).toThrow('Project run item launch cannot be linked');
    expect(repository.projectRuns.get(run.id)).toMatchObject({
      revision: claim!.run.revision,
      items: [{ id: claim!.item.id, status: 'launch_pending' }],
    });
    expect(() =>
      repository.projectRuns.linkLaunch({
        ...input,
        attemptId: 'attempt-1',
        sessionId: 'session-2',
      }),
    ).toThrow('Project run item launch cannot be linked');
    expect(repository.projectRuns.get(run.id)).toMatchObject({
      revision: claim!.run.revision,
      items: [{ id: claim!.item.id, status: 'launch_pending' }],
    });
  });

  it('rejects a launch link whose matching session belongs to another project', () => {
    const repository = setup();
    repositories.push(repository);
    repository.projects.create(
      projectSchema.parse({
        id: 'project-2',
        displayName: 'Other project',
        repositoryPath: 'C:/code/other-project',
        discoveredAt: at,
        discoveryMetadata: {},
      }),
    );
    repository.workspaces.create(
      workspaceSchema.parse({
        id: 'workspace-2',
        projectId: 'project-2',
        type: 'shared',
        path: 'C:/code/other-project',
      }),
    );
    repository.sessions.create(
      sessionSchema.parse({
        id: 'session-other-project',
        projectId: 'project-2',
        workspaceId: 'workspace-2',
        title: 'Other project task',
        permissionMode: 'safe_auto',
        lifecycleState: 'running',
        createdAt: at,
        updatedAt: at,
      }),
    );
    repository.attempts.create(
      taskAttemptSchema.parse({
        id: 'attempt-other-project',
        taskId: 'task-a',
        sessionId: 'session-other-project',
        ordinal: 2,
        source: 'launched',
        actor: { type: 'system', id: 'system-1' },
        createdAt: at,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        role: null,
      }),
    );
    const run = createRun(repository.projectRuns, ['task-a']);
    const claim = repository.projectRuns.claimNext({
      runId: run.id,
      expectedRunRevision: run.revision,
      occurredAt: at,
    });

    expect(() =>
      repository.projectRuns.linkLaunch({
        runId: run.id,
        itemId: claim!.item.id,
        expectedRunRevision: claim!.run.revision,
        attemptId: 'attempt-other-project',
        sessionId: 'session-other-project',
        occurredAt: at,
      }),
    ).toThrow('Project run item launch cannot be linked');
    expect(repository.projectRuns.get(run.id)).toMatchObject({
      revision: claim!.run.revision,
      items: [{ id: claim!.item.id, status: 'launch_pending' }],
    });
  });

  it('normalizes durable run identifiers and launch keys before storing and querying', () => {
    const repository = setup();
    repositories.push(repository);

    const run = repository.projectRuns.create({
      id: ' run-normalized ',
      projectId: ' project-1 ',
      concurrency: 1,
      startedAt: at,
      items: [
        {
          id: ' item-normalized ',
          taskId: ' task-a ',
          taskRevision: 1,
          policyRevision: 7,
          taskAutomationGeneration: 3,
          queuePosition: 0,
          launchIdempotencyKey: ' launch-normalized ',
        },
      ],
    });

    expect(run).toMatchObject({
      id: 'run-normalized',
      projectId: 'project-1',
      items: [
        {
          id: 'item-normalized',
          taskId: 'task-a',
          policyRevision: 7,
          taskAutomationGeneration: 3,
          launchIdempotencyKey: 'launch-normalized',
        },
      ],
    });
    expect(repository.projectRuns.reconcileCounts(' run-normalized ')).toEqual({
      queued: 1,
      launchPending: 0,
      active: 0,
      completed: 0,
      attentionRequired: 0,
      notStarted: 0,
    });
  });

  it('returns aggregate counts and rolls back a run with a failing project event', () => {
    const repository = setup({ failProjectEventInsert: true });
    repositories.push(repository);
    const run = createRun(repository.projectRuns, ['task-a']);
    expect(repository.projectRuns.reconcileCounts(run.id)).toEqual({
      queued: 1,
      launchPending: 0,
      active: 0,
      completed: 0,
      attentionRequired: 0,
      notStarted: 0,
    });

    repository.database.exec('BEGIN IMMEDIATE');
    try {
      repository.projectRuns.create({
        id: 'rolled-back-run',
        projectId: 'project-1',
        concurrency: 1,
        startedAt: at,
        state: 'completed',
        completedAt: at,
        completionReason: 'stopped',
        items: [],
      });
      expect(() =>
        repository.projectEvents.appendInTransaction('project-1', {
          protocolVersion: 1,
          projectId: repository.projects.get('project-1')!.id,
          occurredAt: at,
          type: 'project.changed',
          payload: { project: repository.projects.get('project-1')! },
        }),
      ).toThrow('project event insert failed');
    } finally {
      repository.database.exec('ROLLBACK');
    }
    expect(repository.projectRuns.get('rolled-back-run')).toBeUndefined();
  });
});
