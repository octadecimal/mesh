import { afterEach, describe, expect, it } from 'vitest';
import {
  attemptRepairSchema,
  idSchema,
  projectSchema,
  taskSchema,
} from '@mesh-session-platform/contracts';

import { openDatabase } from '../db/database.js';
import { ProjectEventRepository } from '../repositories/project-event-repository.js';
import { createTestRepositories } from '../test/create-test-database.js';
import {
  buildProjectSnapshot,
  readProjectHistory,
} from './project-snapshots.js';

const now = '2026-08-24T00:00:00.000Z';
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const seed = () => {
  const repositories = createTestRepositories();
  cleanups.push(repositories.dispose);
  const project = repositories.projects.create(
    projectSchema.parse({
      id: 'p1',
      displayName: 'Mesh',
      repositoryPath: 'C:/code/mesh',
      discoveredAt: now,
      discoveryMetadata: {},
    }),
  );
  const task = repositories.tasks.create(
    taskSchema.parse({
      id: 't1',
      projectId: project.id,
      title: 'Atomic snapshot',
      description: '',
      acceptanceCriteria: [],
      priority: 'normal',
      rank: 'a',
      lifecycleState: 'backlog',
      labels: [],
      notes: '',
      blocked: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const append = (events: ProjectEventRepository, id: string) =>
    events.append(project.id, {
      protocolVersion: 1,
      id,
      projectId: project.id,
      occurredAt: now,
      type: 'task.changed',
      payload: { task },
    });
  append(repositories.projectEvents, 'event-1');
  const writerDatabase = openDatabase(repositories.path);
  const writerEvents = new ProjectEventRepository(writerDatabase);
  cleanups.push(() => writerDatabase.close());
  return { repositories, project, task, writerEvents, append };
};

const boundProxy = <Target extends object>(
  target: Target,
  interleaveOn: string,
  interleave: () => void,
): Target => {
  let interleaved = false;
  return new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, current, args) as unknown;
        if (property === interleaveOn && !interleaved) {
          interleaved = true;
          interleave();
        }
        return result;
      };
    },
  });
};

describe('project snapshot read consistency', () => {
  it('projects the current developer instructions through the project contract', () => {
    const fixture = seed();
    const updated = fixture.repositories.projects.updateDeveloperInstructions(
      fixture.project.id,
      fixture.project.revision,
      {
        content: 'Run the focused server test before handoff.',
        updatedAt: '2026-08-24T00:01:00.000Z',
        updatedBy: { type: 'human', id: idSchema.parse('operator') },
      },
    );
    if (!updated) throw new Error('Expected developer instructions to update');

    expect(
      buildProjectSnapshot(fixture.repositories, fixture.project.id).project
        .developerInstructions,
    ).toEqual({
      content: 'Run the focused server test before handoff.',
      revision: 2,
      updatedAt: '2026-08-24T00:01:00.000Z',
      updatedBy: { type: 'human', id: 'operator' },
    });
  });

  it('returns repair records in snapshots and durable project history', () => {
    const fixture = seed();
    const repair = attemptRepairSchema.parse({
      taskId: fixture.task.id,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      reason: 'task_in_progress_without_live_session',
    });
    fixture.repositories.projectEvents.append(fixture.project.id, {
      protocolVersion: 1,
      id: 'repair-event-1',
      projectId: fixture.project.id,
      occurredAt: now,
      type: 'task.attempt_repair_detected',
      payload: { repair },
    });

    expect(
      buildProjectSnapshot(
        { ...fixture.repositories, repairs: [repair] },
        fixture.project.id,
      ).repairs,
    ).toEqual([repair]);
    expect(
      readProjectHistory(fixture.repositories, fixture.project.id, { after: 1 })
        .events,
    ).toEqual([
      expect.objectContaining({
        type: 'task.attempt_repair_detected',
        payload: { repair },
      }),
    ]);
  });

  it('keeps snapshot projections and cursor in one SQLite read view', () => {
    const fixture = seed();
    const tasks = boundProxy(fixture.repositories.tasks, 'listByProject', () =>
      fixture.append(fixture.writerEvents, 'event-2'),
    );

    const snapshot = buildProjectSnapshot(
      {
        ...fixture.repositories,
        tasks,
      },
      fixture.project.id,
    );

    expect(snapshot.cursor).toBe(1);
    expect(fixture.writerEvents.latestSequence(fixture.project.id)).toBe(2);
  });

  it('keeps history events and cursor at one captured high-water mark', () => {
    const fixture = seed();
    const projectEvents = new Proxy(fixture.repositories.projectEvents, {
      get(current, property) {
        const value = Reflect.get(current, property, current) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, current, args) as unknown;
          if (property === 'after' || property === 'retainedAfter') {
            fixture.append(fixture.writerEvents, 'event-2');
          }
          return result;
        };
      },
    });

    const history = readProjectHistory(
      { ...fixture.repositories, projectEvents },
      fixture.project.id,
      { after: 0 },
    );

    expect(history.events.map(({ sequence }) => sequence)).toEqual([1]);
    expect(history.cursor).toBe(1);
    expect(fixture.writerEvents.latestSequence(fixture.project.id)).toBe(2);
  });
});
