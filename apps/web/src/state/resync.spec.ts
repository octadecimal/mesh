import { describe, expect, it } from 'vitest';
import {
  projectSchema,
  projectRunSchema,
  projectSnapshotSchema,
  qaExecutionCycleSchema,
  taskAttemptSchema,
  taskSchema,
  type ProjectEvent,
  type SessionSnapshot,
} from '@mesh-session-platform/contracts';

import { createResyncCoordinator } from './resync';
import { createMeshStore } from './store';

const timestamp = '2026-08-24T00:00:00.000Z';

const sessionSnapshot: SessionSnapshot = {
  protocolVersion: 1,
  projects: [],
  workspaces: [],
  sessions: [],
  events: [],
  pendingApprovals: [],
  lastSequenceBySession: {},
  layouts: [],
};

const project = (id: string) =>
  projectSchema.parse({
    id,
    displayName: id,
    repositoryPath: `C:/code/${id}`,
    discoveredAt: timestamp,
    discoveryMetadata: {},
  });

const task = (projectId: string) =>
  taskSchema.parse({
    id: `task-${projectId}`,
    projectId,
    title: `Task for ${projectId}`,
    description: '',
    acceptanceCriteria: [],
    priority: 'normal',
    rank: 'a',
    lifecycleState: 'review',
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

const projectSnapshot = (projectId: string, cursor: number) => {
  const selectedTask = task(projectId);
  const attempt = taskAttemptSchema.parse({
    id: `attempt-${projectId}`,
    taskId: selectedTask.id,
    sessionId: `session-${projectId}`,
    ordinal: 1,
    source: 'launched',
    actor: { type: 'human', id: 'operator' },
    createdAt: timestamp,
    unlinkedAt: null,
    unlinkedBy: null,
    unlinkReason: null,
    role: 'developer',
  });
  const cycle = qaExecutionCycleSchema.parse({
    id: `qa-cycle-${projectId}`,
    taskId: selectedTask.id,
    attemptId: attempt.id,
    sessionId: `qa-session-${projectId}`,
    ordinal: 1,
    authorizedBy: { type: 'human', id: 'operator' },
    authorizationCommandId: `qa-launch-${projectId}`,
    policyVersion: 'qa-policy-v1',
    qaInstructions: { content: '', revision: 1 },
    taskSnapshot: {
      revision: 1,
      title: selectedTask.title,
      description: '',
      acceptanceCriteria: [
        { id: 'criterion-1', text: 'History survives reconnect.' },
      ],
    },
    developerCompletionReportId: `completion-${projectId}`,
    workspaceId: `workspace-${projectId}`,
    reviewPolicy: 'manual',
    reviewPolicyRevision: 1,
    automationGeneration: 0,
    rejectionOrdinal: 0,
    startedAt: timestamp,
    endedAt: null,
    terminalDisposition: null,
    reportId: null,
    terminalCommandId: null,
    terminalEventId: null,
  });
  const run = projectRunSchema.parse({
    id: `run-${projectId}`,
    projectId,
    revision: 1,
    concurrency: 1,
    state: 'running',
    completionReason: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    items: [],
  });
  return projectSnapshotSchema.parse({
    protocolVersion: 1,
    project: project(projectId),
    tasks: [selectedTask],
    attempts: [attempt],
    transitions: [],
    repairs: [],
    runs: [run],
    projectRunLimits: { maxConcurrency: 4 },
    qaCycles: [cycle],
    cursor,
  });
};

describe('project resync', () => {
  it('refreshes project-local QA and run state for only the project that owns the sequence gap', async () => {
    const store = createMeshStore(sessionSnapshot);
    store.replaceProjectSnapshot(projectSnapshot('project-2', 4));
    const requested: string[] = [];
    const coordinator = createResyncCoordinator(
      {
        snapshot: async () => sessionSnapshot,
        projectSnapshot: async (projectId) => {
          requested.push(projectId);
          return projectSnapshot(projectId, 7);
        },
      },
      store,
    );
    const event: ProjectEvent = {
      protocolVersion: 1,
      id: 'project-event-2',
      projectId: 'project-1',
      sequence: 2,
      occurredAt: timestamp,
      type: 'task.rank_changed',
      payload: { task: task('project-1') },
    };

    await coordinator.applyProjectEvent(event);

    expect(requested).toEqual(['project-1']);
    expect(
      store.state.qaCyclesByAttemptId['attempt-project-1'][0].id.get(),
    ).toBe('qa-cycle-project-1');
    expect(
      store.state.qaCyclesByAttemptId['attempt-project-2'][0].id.get(),
    ).toBe('qa-cycle-project-2');
    expect(store.state.projectRunsById['run-project-1'].id.get()).toBe(
      'run-project-1',
    );
    expect(store.state.projectRunsById['run-project-2'].id.get()).toBe(
      'run-project-2',
    );
    expect(
      store.state.projectRunMaxConcurrencyByProjectId['project-1'].get(),
    ).toBe(4);
  });
});
