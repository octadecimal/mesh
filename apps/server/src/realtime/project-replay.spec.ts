import { describe, expect, it } from 'vitest';
import {
  attemptRepairSchema,
  idSchema,
  projectEventSchema,
  projectPlanSchema,
  projectRunSchema,
  taskDependencySchema,
  taskSchema,
  type ProjectEvent,
} from '@mesh-session-platform/contracts';

import { ProjectReplayService } from './project-replay.js';

const task = (projectId: string) =>
  taskSchema.parse({
    id: idSchema.parse(`task-${projectId}`),
    projectId: idSchema.parse(projectId),
    title: 'Task',
    description: '',
    acceptanceCriteria: [],
    priority: 'normal' as const,
    rank: 'a',
    lifecycleState: 'backlog' as const,
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  });

const event = (projectId: string, sequence: number): ProjectEvent => ({
  protocolVersion: 1,
  id: idSchema.parse(`event-${projectId}-${sequence}`),
  projectId: idSchema.parse(projectId),
  sequence,
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'task.changed',
  payload: { task: task(projectId) },
});

const repairEvent = projectEventSchema.parse({
  protocolVersion: 1,
  id: 'repair-event-1',
  projectId: 'project-1',
  sequence: 1,
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'task.attempt_repair_detected',
  payload: {
    repair: attemptRepairSchema.parse({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      reason: 'task_in_progress_without_live_session',
    }),
  },
});

const developerEvent = projectEventSchema.parse({
  protocolVersion: 1,
  id: 'developer-event-1',
  projectId: 'project-1',
  sequence: 2,
  occurredAt: '2026-08-24T00:02:00.000Z',
  type: 'task.developer_execution_changed',
  payload: {
    task: task('project-1'),
    attempt: {
      id: 'attempt-1',
      taskId: 'task-project-1',
      sessionId: 'session-1',
      ordinal: 1,
      source: 'launched',
      actor: { type: 'human', id: 'operator' },
      createdAt: '2026-08-24T00:00:00.000Z',
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
      role: 'developer',
    },
    cycle: {
      id: 'cycle-1',
      attemptId: 'attempt-1',
      ordinal: 1,
      mode: 'new',
      authorizedBy: { type: 'human', id: 'operator' },
      authorizationCommandId: 'launch-1',
      policyVersion: 'developer-policy-v1',
      projectInstructions: { content: '', revision: 1 },
      taskSnapshot: {
        revision: 1,
        title: 'Task',
        description: '',
        acceptanceCriteria: [
          { id: 'criterion-1', text: 'History reconnects.' },
        ],
      },
      workspaceId: 'workspace-1',
      permissionMode: 'interactive',
      startedAt: '2026-08-24T00:00:00.000Z',
      endedAt: '2026-08-24T00:02:00.000Z',
      terminalDisposition: 'submitted_for_review',
      completionReportId: 'completion-1',
      blockerReportId: null,
      terminalCommandId: 'submit-1',
      terminalEventId: 'developer-event-1',
    },
    completionReport: {
      id: 'completion-1',
      cycleId: 'cycle-1',
      summary: 'Ready for review.',
      criterionResults: [
        { criterionId: 'criterion-1', status: 'met', evidence: 'Passed.' },
      ],
      verification: [],
      limitations: '',
      workspaceState: {
        summary: 'Clean.',
        hasUncommittedChanges: false,
        commitsCreated: true,
      },
      reviewerNotes: null,
      createdAt: '2026-08-24T00:02:00.000Z',
    },
    blockerReport: null,
    reviewFeedback: null,
  },
});

const runEvent = projectEventSchema.parse({
  protocolVersion: 1,
  id: 'run-event-1',
  projectId: 'project-1',
  sequence: 3,
  occurredAt: '2026-08-24T00:03:00.000Z',
  type: 'project.run_changed',
  payload: {
    run: projectRunSchema.parse({
      id: 'run-1',
      projectId: 'project-1',
      revision: 2,
      concurrency: 2,
      state: 'paused',
      startedAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:03:00.000Z',
      completedAt: null,
      completionReason: null,
      items: [],
    }),
  },
});

const planEvent = projectEventSchema.parse({
  protocolVersion: 1,
  id: 'plan-event-1',
  projectId: 'project-1',
  sequence: 4,
  occurredAt: '2026-08-24T00:04:00.000Z',
  type: 'project.plan_changed',
  payload: {
    plan: projectPlanSchema.parse({
      id: 'plan-1',
      projectId: 'project-1',
      goal: 'Project dependency-aware work.',
      constraints: [],
      nonGoals: [],
      policyVersion: 'pm-v1',
      status: 'planning',
      revision: 1,
      currentBaseId: 'base-1',
      currentSessionId: 'pm-session-1',
      latestProposalOrdinal: 0,
      feedback: [],
      attention: null,
      createdBy: { type: 'human', id: 'operator' },
      createdAt: '2026-08-24T00:04:00.000Z',
      updatedAt: '2026-08-24T00:04:00.000Z',
      terminalAt: null,
      terminalBy: null,
      terminalReason: null,
    }),
  },
});

const dependencyEvent = projectEventSchema.parse({
  protocolVersion: 1,
  id: 'dependency-event-1',
  projectId: 'project-1',
  sequence: 5,
  occurredAt: '2026-08-24T00:05:00.000Z',
  type: 'task.dependencies_changed',
  payload: {
    taskId: 'task-project-1',
    dependencies: [
      taskDependencySchema.parse({
        projectId: 'project-1',
        taskId: 'task-project-1',
        prerequisiteTaskId: 'prerequisite-1',
        createdBy: { type: 'human', id: 'operator' },
        createdAt: '2026-08-24T00:05:00.000Z',
      }),
    ],
  },
});

describe('ProjectReplayService', () => {
  it('replays repair-bearing project events without losing repair data', () => {
    const replay = new ProjectReplayService({
      retainedAfter: () => ({
        events: [repairEvent],
        lowWater: 1,
        highWater: 1,
      }),
    });

    expect(replay.after({ 'project-1': 0 }).events).toEqual([repairEvent]);
  });

  it('replays Developer events unchanged without capability material', () => {
    const replay = new ProjectReplayService({
      retainedAfter: () => ({
        events: [developerEvent],
        lowWater: 2,
        highWater: 2,
      }),
    });

    expect(replay.after({ 'project-1': 1 })).toEqual({
      events: [developerEvent],
      highWaterByProject: { 'project-1': 2 },
      resyncProjectIds: [],
    });
    expect(JSON.stringify(replay.after({ 'project-1': 1 }))).not.toContain(
      'capability',
    );
  });

  it('replays authoritative project-run changes after the requested cursor', () => {
    const replay = new ProjectReplayService({
      retainedAfter: (_projectId, after) => ({
        events: after < runEvent.sequence ? [runEvent] : [],
        lowWater: 3,
        highWater: 3,
      }),
    });

    expect(replay.after({ 'project-1': 2 })).toMatchObject({
      events: [runEvent],
      resyncProjectIds: [],
      highWaterByProject: { 'project-1': 3 },
    });
    expect(replay.after({ 'project-1': 3 }).events).toEqual([]);
  });

  it('replays planning and dependency changes in sequence without redelivery', () => {
    const retained = [planEvent, dependencyEvent];
    const replay = new ProjectReplayService({
      retainedAfter: (_projectId, after) => ({
        events: retained.filter(({ sequence }) => sequence > after),
        lowWater: 4,
        highWater: 5,
      }),
    });

    expect(replay.after({ 'project-1': 3 })).toEqual({
      events: retained,
      highWaterByProject: { 'project-1': 5 },
      resyncProjectIds: [],
    });
    expect(replay.after({ 'project-1': 5 })).toEqual({
      events: [],
      highWaterByProject: { 'project-1': 5 },
      resyncProjectIds: [],
    });
  });

  it('replays retained project events after independent cursors', () => {
    const retained = {
      'project-1': [event('project-1', 4), event('project-1', 5)],
      'project-2': [event('project-2', 1)],
    };
    const replay = new ProjectReplayService({
      retainedAfter: (projectId, sequence) => {
        const events = retained[projectId as keyof typeof retained] ?? [];
        return {
          events: events.filter((candidate) => candidate.sequence > sequence),
          lowWater: events[0]?.sequence ?? 1,
          highWater: events.at(-1)?.sequence ?? 0,
        };
      },
    });

    expect(replay.after({ 'project-1': 4, 'project-2': 1 })).toEqual({
      events: [event('project-1', 5)],
      highWaterByProject: { 'project-1': 5, 'project-2': 1 },
      resyncProjectIds: [],
    });
  });

  it('requires an explicit resync when retained project history has a gap', () => {
    const replay = new ProjectReplayService({
      retainedAfter: () => ({
        events: [event('project-1', 4), event('project-1', 5)],
        lowWater: 4,
        highWater: 5,
      }),
    });

    expect(replay.after({ 'project-1': 1 })).toEqual({
      events: [],
      highWaterByProject: { 'project-1': 5 },
      resyncProjectIds: ['project-1'],
    });
  });

  it('requires resync for an ahead cursor or unavailable positive history', () => {
    const ahead = new ProjectReplayService({
      retainedAfter: () => ({
        events: [],
        lowWater: 4,
        highWater: 5,
      }),
    });
    const unavailable = new ProjectReplayService({
      retainedAfter: () => ({ events: [], lowWater: 1, highWater: 0 }),
    });

    expect(ahead.after({ 'project-1': 6 }).resyncProjectIds).toEqual([
      'project-1',
    ]);
    expect(unavailable.after({ 'project-1': 1 }).resyncProjectIds).toEqual([
      'project-1',
    ]);
  });

  it('never replays an event returned under another project subscription', () => {
    const replay = new ProjectReplayService({
      retainedAfter: () => ({
        events: [event('project-2', 1)],
        lowWater: 1,
        highWater: 1,
      }),
    });

    expect(replay.after({ 'project-1': 0 })).toEqual({
      events: [],
      highWaterByProject: { 'project-1': 1 },
      resyncProjectIds: ['project-1'],
    });
  });

  it('requires resync when retained replay has an interior sequence gap', () => {
    const replay = new ProjectReplayService({
      retainedAfter: () => ({
        events: [event('project-1', 1), event('project-1', 3)],
        lowWater: 1,
        highWater: 3,
      }),
    });

    expect(replay.after({ 'project-1': 0 })).toMatchObject({
      events: [],
      resyncProjectIds: ['project-1'],
    });
  });

  it('requires resync when history was fully purged after prior events', () => {
    const replay = new ProjectReplayService({
      retainedAfter: () => ({ events: [], lowWater: 6, highWater: 5 }),
    });

    expect(replay.after({ 'project-1': 0 })).toMatchObject({
      events: [],
      resyncProjectIds: ['project-1'],
    });
  });
});
