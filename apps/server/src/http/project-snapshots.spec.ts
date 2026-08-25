import { afterEach, describe, expect, it } from 'vitest';
import {
  projectSchema,
  taskSchema,
  type ProjectEvent,
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
  it('keeps snapshot projections and cursor in one SQLite read view', () => {
    const fixture = seed();
    const tasks = boundProxy(
      fixture.repositories.tasks,
      'listByProject',
      () => fixture.append(fixture.writerEvents, 'event-2'),
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
