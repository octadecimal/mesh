import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildSync } from 'esbuild';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  projectSchema,
  rawDiagnosticSchema,
  savedLayoutSchema,
  sessionSchema,
  taskAttemptSchema,
  taskSchema,
  taskTransitionSchema,
  taskActorSchema,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';
import { waitForWorkerMessage } from '../test/wait-for-worker-message.js';
import { CommandReconciliationRequiredError } from './command-repository.js';
import { TaskAttemptRepository } from './task-attempt-repository.js';

const project = () =>
  projectSchema.parse({
    id: 'p1',
    displayName: 'Platform',
    repositoryPath: 'C:/code/platform',
    discoveredAt: '2026-08-24T00:00:00.000Z',
    discoveryMetadata: { source: 'test' },
  });

const workspace = () =>
  workspaceSchema.parse({
    id: 'w1',
    projectId: 'p1',
    type: 'worktree',
    path: 'C:/code/platform-worktree',
    gitBranch: 'feature/persistence',
  });

const session = () =>
  sessionSchema.parse({
    id: 's1',
    projectId: 'p1',
    workspaceId: 'w1',
    title: 'Persistence',
    permissionMode: 'interactive',
    lifecycleState: 'running',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  });

const diagnostic = (id: string, kind: string) =>
  rawDiagnosticSchema.parse({
    id,
    sessionId: 's1',
    capturedAt: '2026-08-24T00:01:00.000Z',
    payload: { kind },
  });

const userMessage = (text: string) => ({
  id: `event-${text}`,
  occurredAt: '2026-08-24T00:01:00.000Z',
  type: 'message.user' as const,
  payload: { text },
});

const assistantMessage = (text: string) => ({
  id: `event-${text}`,
  occurredAt: '2026-08-24T00:02:00.000Z',
  type: 'message.assistant' as const,
  payload: { text },
});

const seedSession = (repos: ReturnType<typeof createTestRepositories>) => {
  repos.projects.create(project());
  repos.workspaces.create(workspace());
  repos.sessions.create(session());
};

describe('repositories', () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
  });

  it('persists project and workspace records using their contract fields', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);

    repos.projects.create(project());
    repos.workspaces.create(workspace());

    expect(repos.projects.get('p1')).toMatchObject({
      displayName: 'Platform',
      discoveryMetadata: { source: 'test' },
    });
    expect(repos.workspaces.listByProject('p1')).toMatchObject([
      { id: 'w1', cleanupState: 'active' },
    ]);
  });

const actor = () => taskActorSchema.parse({ type: 'human', id: 'user-1' });

const task = (overrides: Record<string, unknown> = {}) =>
  taskSchema.parse({
    id: 'task-1',
    projectId: 'p1',
    title: 'Persist tasks',
    description: 'Store board tasks in SQLite.',
    acceptanceCriteria: ['Task is persisted'],
    priority: 'normal',
    rank: 'b',
    lifecycleState: 'backlog',
    labels: ['persistence'],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  });

const attempt = (overrides: Record<string, unknown> = {}) =>
  taskAttemptSchema.parse({
    id: 'attempt-1',
    taskId: 'task-1',
    sessionId: 's1',
    ordinal: 1,
    source: 'linked',
    actor: actor(),
    createdAt: '2026-08-24T00:00:00.000Z',
    unlinkedAt: null,
    unlinkedBy: null,
    unlinkReason: null,
    ...overrides,
  });

const transition = (overrides: Record<string, unknown> = {}) =>
  taskTransitionSchema.parse({
    id: 'transition-1',
    taskId: 'task-1',
    commandId: 'command-1',
    previousState: 'backlog',
    nextState: 'ready',
    actor: actor(),
    reason: 'Ready to start',
    occurredAt: '2026-08-24T00:01:00.000Z',
    ...overrides,
  });

  it('persists additive project metadata for new project records', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);

    repos.projects.create(project());

    expect(
      repos.database
        .prepare(
          `SELECT repository_identity, revision, created_at, updated_at, archived_at
           FROM projects WHERE id = ?`,
        )
        .get('p1'),
    ).toEqual({
      repository_identity: 'C:/code/platform',
      revision: 1,
      created_at: '2026-08-24T00:00:00.000Z',
      updated_at: '2026-08-24T00:00:00.000Z',
      archived_at: null,
    });
  });

  it('finds projects by repository identity and guards updates by revision', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    repos.projects.create(project());

    expect(repos.projects.getByRepositoryIdentity('C:/code/platform')).toMatchObject({
      id: 'p1',
    });
    expect(
      repos.projects.update(
        { ...project(), displayName: 'Renamed', updatedAt: '2026-08-24T00:03:00.000Z' },
        1,
      ),
    ).toMatchObject({ displayName: 'Renamed', revision: 2 });
    expect(repos.projects.update({ ...project(), displayName: 'Stale' }, 1)).toBeUndefined();
    expect(repos.projects.archive('p1', '2026-08-24T00:04:00.000Z')).toMatchObject({
      archivedAt: '2026-08-24T00:04:00.000Z',
      revision: 3,
    });
    expect(repos.projects.restore('p1', '2026-08-24T00:05:00.000Z')).toMatchObject({
      archivedAt: null,
      revision: 4,
    });
  });

  it('orders project tasks for the board and guards task updates by revision', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    repos.projects.create(project());
    repos.tasks.create(task({ id: 'task-ready', lifecycleState: 'ready', rank: 'a' }));
    repos.tasks.create(task({ id: 'task-backlog-later', rank: 'c' }));
    repos.tasks.create(task({ id: 'task-backlog-first', rank: 'a' }));

    expect(repos.tasks.listByProject('p1').map((value) => value.id)).toEqual([
      'task-backlog-first',
      'task-backlog-later',
      'task-ready',
    ]);
    const stored = repos.tasks.get('task-backlog-first');
    expect(stored).toBeDefined();
    if (!stored) throw new Error('Expected stored task');
    expect(
      repos.tasks.update(
        { ...stored, title: 'Updated task', updatedAt: '2026-08-24T00:04:00.000Z' },
        1,
      ),
    ).toMatchObject({ title: 'Updated task', revision: 2 });
    expect(repos.tasks.update({ ...stored, title: 'Stale task' }, 1)).toBeUndefined();
  });

  it('creates monotonic task attempts and preserves unlink history', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);
    repos.tasks.create(task());

    const first = repos.attempts.createForTask('task-1', 's1', 'linked', actor());
    const unlinked = repos.attempts.unlink(
      first.id,
      actor(),
      'Session completed',
      '2026-08-24T00:02:00.000Z',
    );
    const second = repos.attempts.create(
      attempt({
        id: 'attempt-2',
        ordinal: 2,
        createdAt: '2026-08-24T00:03:00.000Z',
      }),
    );

    expect(unlinked).toMatchObject({
      unlinkedAt: '2026-08-24T00:02:00.000Z',
      unlinkReason: 'Session completed',
    });
    expect(first.ordinal).toBe(1);
    expect(second.ordinal).toBe(2);
    expect(repos.attempts.listByTask('task-1').map((value) => value.ordinal)).toEqual([
      1,
      2,
    ]);
    expect(repos.attempts.getCurrentBySession('s1')).toMatchObject({ id: 'attempt-2' });
    expect(() =>
      repos.attempts.create(attempt({ id: 'attempt-3', ordinal: 3 })),
    ).toThrow();
  });

  it('allocates a generated attempt ordinal after beginning its write transaction', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);
    repos.tasks.create(task());
    let inImmediateTransaction = false;
    const database = new Proxy(repos.database, {
      get(target, property, receiver) {
        if (property === 'exec') {
          return (sql: string) => {
            if (sql === 'BEGIN IMMEDIATE') inImmediateTransaction = true;
            try {
              return target.exec(sql);
            } finally {
              if (sql === 'COMMIT' || sql === 'ROLLBACK') {
                inImmediateTransaction = false;
              }
            }
          };
        }
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('MAX(ordinal)')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty, statementReceiver) {
                const value = Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementReceiver,
                );
                if (statementProperty !== 'get') return value;
                return (...args: unknown[]) => {
                  expect(inImmediateTransaction).toBe(true);
                  return Reflect.apply(value, statementTarget, args);
                };
              },
            });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const attempts = new TaskAttemptRepository(database);

    expect(() =>
      attempts.createForTask('task-1', 's1', 'linked', actor()),
    ).not.toThrow();
    expect(attempts.getCurrentBySession('s1')).toMatchObject({ ordinal: 1 });
  });

  it('appends immutable task transitions and rejects duplicate commands', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    repos.projects.create(project());
    repos.tasks.create(task());
    repos.transitions.append(transition());

    expect(repos.transitions.listByTask('task-1')).toEqual([transition()]);
    expect(() =>
      repos.transitions.append(transition({ id: 'transition-2' })),
    ).toThrow();
  });

  it('appends project events with monotonic cursor sequences and rejects duplicate ids', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    repos.projects.create(project());
    const first = repos.projectEvents.append('p1', {
      protocolVersion: 1,
      id: 'project-event-1',
      projectId: project().id,
      occurredAt: '2026-08-24T00:01:00.000Z',
      type: 'project.changed',
      payload: { project: project() },
    });
    const second = repos.projectEvents.append('p1', {
      protocolVersion: 1,
      id: 'project-event-2',
      projectId: project().id,
      occurredAt: '2026-08-24T00:02:00.000Z',
      type: 'project.changed',
      payload: { project: project() },
    });

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(repos.projectEvents.after('p1', 0).map((event) => event.sequence)).toEqual([
      1,
      2,
    ]);
    expect(repos.projectEvents.latestSequence('p1')).toBe(2);
    expect(() =>
      repos.projectEvents.append('p1', {
        protocolVersion: 1,
        id: 'project-event-2',
        projectId: project().id,
        occurredAt: '2026-08-24T00:03:00.000Z',
        type: 'project.changed',
        payload: { project: project() },
      }),
    ).toThrow();
  });

  it('retains durable project stream watermarks after all events are purged', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    repos.projects.create(project());
    const append = (id: string) =>
      repos.projectEvents.append('p1', {
        protocolVersion: 1,
        id,
        projectId: project().id,
        occurredAt: '2026-08-24T00:01:00.000Z',
        type: 'project.changed',
        payload: { project: project() },
      });
    append('project-event-1');
    append('project-event-2');

    repos.database
      .prepare('DELETE FROM project_events WHERE project_id = ?')
      .run('p1');

    expect(repos.projectEvents.retainedAfter('p1', 0)).toEqual({
      events: [],
      lowWater: 3,
      highWater: 2,
    });
    expect(append('project-event-3').sequence).toBe(3);
  });

  it('omits archived sessions unless requested', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);

    repos.sessions.archive('s1');

    expect(repos.sessions.listByProject('p1')).toEqual([]);
    expect(
      repos.sessions.listByProject('p1', { includeArchived: true }),
    ).toMatchObject([{ id: 's1', lifecycleState: 'archived' }]);
  });

  it('appends normalized events and raw diagnostics atomically with consecutive sequence numbers', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);

    const first = repos.events.append(
      's1',
      userMessage('one'),
      diagnostic('d1', 'user'),
    );
    const second = repos.events.append(
      's1',
      assistantMessage('two'),
      diagnostic('d2', 'assistant'),
    );

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(repos.diagnostics.list('s1')).toMatchObject([
      { id: 'd1', normalizedEventId: 'event-one' },
      { id: 'd2', normalizedEventId: 'event-two' },
    ]);
  });

  it('rolls back event persistence when diagnostic persistence fails', () => {
    const repos = createTestRepositories({ failDiagnosticInsert: true });
    disposers.push(repos.dispose);
    seedSession(repos);

    expect(() =>
      repos.events.append('s1', userMessage('one'), diagnostic('d1', 'user')),
    ).toThrow('diagnostic insert failed');

    expect(repos.events.after('s1', 0)).toEqual([]);
    expect(repos.diagnostics.list('s1')).toEqual([]);
  });

  it('does not commit records when the normalized event is invalid', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);

    expect(() =>
      repos.events.append(
        's1',
        { ...userMessage('one'), payload: { text: 1 } },
        diagnostic('d1', 'user'),
      ),
    ).toThrow();

    expect(repos.events.after('s1', 0)).toEqual([]);
    expect(repos.diagnostics.list('s1')).toEqual([]);
  });

  it('keeps cascade coverage in raw fixture SQL without exposing project removal', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);
    repos.events.append('s1', userMessage('one'), diagnostic('d1', 'user'));

    expect('remove' in repos.projects).toBe(false);
    repos.database.prepare('DELETE FROM projects WHERE id = ?').run('p1');

    expect(repos.sessions.get('s1')).toBeUndefined();
    expect(repos.events.after('s1', 0)).toEqual([]);
    expect(repos.diagnostics.list('s1')).toEqual([]);
  });

  it('round-trips saved layouts with optional JSON fields', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);
    const layout = savedLayoutSchema.parse({
      id: 'layout-1',
      projectId: 'p1',
      sessionId: 's1',
      workspaceId: 'w1',
      dockview: { groups: [] },
      sidebar: { expanded: true },
      visiblePanels: ['history'],
      updatedAt: '2026-08-24T00:03:00.000Z',
    });

    repos.layouts.save(layout);

    expect(repos.layouts.get('layout-1')).toEqual(layout);
  });

  it('returns a stored command response without re-executing a duplicate key', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    let executions = 0;

    const first = repos.commands.executeOnce('command-1', () => {
      executions += 1;
      return { accepted: true };
    });
    const second = repos.commands.executeOnce('command-1', () => {
      executions += 1;
      return { accepted: false };
    });

    expect(first).toEqual({ accepted: true });
    expect(second).toEqual({ accepted: true });
    expect(executions).toBe(1);
  });

  it('marks a throwing command as failed and blocks automatic retry', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);

    expect(() =>
      repos.commands.executeOnce('command-fails', () => {
        throw new Error('external effect failed');
      }),
    ).toThrow('external effect failed');
    expect(
      repos.database
        .prepare(
          'SELECT state FROM processed_commands WHERE idempotency_key = ?',
        )
        .get('command-fails'),
    ).toEqual({ state: 'failed' });
    expect(() =>
      repos.commands.executeOnce('command-fails', () => ({ accepted: true })),
    ).toThrow(CommandReconciliationRequiredError);
  });

  it('keeps a failed atomic command while rolling back its application writes', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    repos.projects.create(project());
    const original = repos.tasks.create(task());
    let executions = 0;

    expect(() =>
      repos.commands.executeOnceInImmediateTransaction('atomic-failure', () => {
        executions += 1;
        repos.tasks.update({ ...original, notes: 'Must roll back' }, 1);
        throw new Error('atomic mutation failed');
      }),
    ).toThrow('atomic mutation failed');

    expect(repos.tasks.get(original.id)).toEqual(original);
    expect(
      repos.database
        .prepare(
          'SELECT state FROM processed_commands WHERE idempotency_key = ?',
        )
        .get('atomic-failure'),
    ).toEqual({ state: 'failed' });
    expect(() =>
      repos.commands.executeOnceInImmediateTransaction('atomic-failure', () => {
        executions += 1;
        return { accepted: true };
      }),
    ).toThrow(CommandReconciliationRequiredError);
    expect(executions).toBe(1);
  });

  it('marks an unserializable response indeterminate and blocks automatic retry', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    let executions = 0;

    expect(() =>
      repos.commands.executeOnce('command-unserializable', () => {
        executions += 1;
        return { value: BigInt(1) };
      }),
    ).toThrow();
    expect(
      repos.database
        .prepare(
          'SELECT state FROM processed_commands WHERE idempotency_key = ?',
        )
        .get('command-unserializable'),
    ).toEqual({ state: 'indeterminate' });
    expect(() =>
      repos.commands.executeOnce('command-unserializable', () => {
        executions += 1;
        return { accepted: true };
      }),
    ).toThrow(CommandReconciliationRequiredError);
    expect(executions).toBe(1);
  });

  it('does not execute a key left pending by a prior process', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    repos.database
      .prepare(
        `
      INSERT INTO processed_commands (id, idempotency_key, state, created_at, updated_at)
      VALUES ('pending-command', 'command-pending', 'pending', ?, ?)
    `,
      )
      .run('2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
    let executions = 0;

    expect(() =>
      repos.commands.executeOnce('command-pending', () => {
        executions += 1;
        return { accepted: true };
      }),
    ).toThrow(CommandReconciliationRequiredError);
    expect(executions).toBe(0);
  });

  it('returns the same canonical nested JSON value on first execution and duplicate lookup', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    const response = Object.defineProperty(
      { nested: { values: [1, true, null, 'x'] } },
      'stable',
      { configurable: false, enumerable: true, value: 'yes', writable: false },
    );
    const canonical = {
      nested: { values: [1, true, null, 'x'] },
      stable: 'yes',
    };

    const first = repos.commands.executeOnce('nested-json', () => response);
    const duplicate = repos.commands.executeOnce('nested-json', () => ({
      changed: true,
    }));

    expect(first).toEqual(canonical);
    expect(duplicate).toEqual(canonical);
    expect(first).not.toBe(response);
  });

  const unsafeResponses: Array<[string, () => unknown]> = [
    [
      'null-prototype object',
      () => Object.assign(Object.create(null), { value: 1 }),
    ],
    ['class instance', () => new (class ResponseValue {})()],
    ['Date', () => new Date('2026-08-24T00:00:00.000Z')],
    [
      'non-enumerable own property',
      () => Object.defineProperty({ visible: true }, 'hidden', { value: true }),
    ],
    [
      'accessor property',
      () =>
        Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 }),
    ],
    [
      'object symbol property',
      () => Object.assign({ value: 1 }, { [Symbol('hidden')]: true }),
    ],
    [
      'array hole',
      () => {
        const value = [1, 2, 3];
        delete value[1];
        return value;
      },
    ],
    ['array extra key', () => Object.assign([1], { extra: true })],
    [
      'array symbol property',
      () => Object.assign([1], { [Symbol('hidden')]: true }),
    ],
    [
      'cycle',
      () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      },
    ],
    ['function', () => () => undefined],
    ['undefined', () => undefined],
    ['bigint', () => BigInt(1)],
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
  ];

  it.each(unsafeResponses)(
    'marks a %s response indeterminate and never retries its callback',
    (name, createResponse) => {
      const repos = createTestRepositories();
      disposers.push(repos.dispose);
      const idempotencyKey = `unsafe-${name}`;
      let executions = 0;

      expect(() =>
        repos.commands.executeOnce(idempotencyKey, () => {
          executions += 1;
          return createResponse();
        }),
      ).toThrow('JSON-safe');
      expect(
        repos.database
          .prepare(
            'SELECT state FROM processed_commands WHERE idempotency_key = ?',
          )
          .get(idempotencyKey),
      ).toEqual({ state: 'indeterminate' });
      expect(() =>
        repos.commands.executeOnce(idempotencyKey, () => {
          executions += 1;
          return { retry: true };
        }),
      ).toThrow(CommandReconciliationRequiredError);
      expect(executions).toBe(1);
    },
  );

  it('allocates unique consecutive sequences for concurrent connections', async () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);
    const bundleDirectory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-event-worker-'),
    );
    disposers.push(() =>
      rmSync(bundleDirectory, { force: true, recursive: true }),
    );
    const modulePath = join(bundleDirectory, 'event-repository.cjs');
    buildSync({
      bundle: true,
      entryPoints: [join(__dirname, 'event-repository.ts')],
      external: ['better-sqlite3'],
      format: 'cjs',
      outfile: modulePath,
      platform: 'node',
      tsconfig: join(__dirname, '..', '..', '..', '..', 'tsconfig.base.json'),
    });
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const { EventRepository } = require(workerData.modulePath);
      const database = new Database(workerData.path);
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      const repository = new EventRepository(database);
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try {
        const event = repository.append('s1', workerData.draft, workerData.diagnostic);
        parentPort.postMessage({ type: 'result', event });
      } catch (error) {
        parentPort.postMessage({ type: 'error', message: error.message });
      } finally {
        database.close();
      }
    `;
    const start = (
      draft: ReturnType<typeof userMessage>,
      raw: ReturnType<typeof diagnostic>,
    ) =>
      new Worker(workerSource, {
        eval: true,
        workerData: {
          barrier,
          diagnostic: raw,
          draft,
          modulePath,
          path: repos.path,
        },
      });
    const workers: Worker[] = [];

    try {
      workers.push(start(userMessage('one'), diagnostic('d1', 'user')));
      workers.push(start(userMessage('two'), diagnostic('d2', 'user')));
      await Promise.all(workers.map((worker) => waitForWorkerMessage(worker)));
      const resultsPromise = Promise.all(
        workers.map((worker) =>
          waitForWorkerMessage<{
            type: string;
            event?: { sequence: number };
            message?: string;
          }>(worker),
        ),
      );
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      const results = await resultsPromise;

      expect(results).toEqual([
        expect.objectContaining({ type: 'result' }),
        expect.objectContaining({ type: 'result' }),
      ]);
      expect(results.map((result) => result.event?.sequence).sort()).toEqual([
        1, 2,
      ]);
      expect(repos.diagnostics.list('s1')).toMatchObject([
        { id: 'd1', normalizedEventId: 'event-one' },
        { id: 'd2', normalizedEventId: 'event-two' },
      ]);
    } finally {
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
    }
  }, 15_000);
});
