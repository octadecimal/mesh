import { describe, expect, it } from 'vitest';
import { idSchema, type ProjectEvent } from '@mesh-session-platform/contracts';

import { ProjectReplayService } from './project-replay.js';

const event = (projectId: string, sequence: number): ProjectEvent => ({
  protocolVersion: 1,
  id: idSchema.parse(`event-${projectId}-${sequence}`),
  projectId: idSchema.parse(projectId),
  sequence,
  occurredAt: '2026-08-24T00:00:00.000Z',
  type: 'task.changed',
  payload: {
    task: {
      id: idSchema.parse(`task-${projectId}`),
      projectId: idSchema.parse(projectId),
      title: 'Task',
      description: '',
      acceptanceCriteria: [],
      priority: 'normal',
      rank: 'a',
      lifecycleState: 'backlog',
      labels: [],
      notes: '',
      blocked: null,
      revision: 1,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
  },
});

describe('ProjectReplayService', () => {
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
