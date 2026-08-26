import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from './database.js';
import { migrate } from './migrate.js';
import { CommandRepository } from '../repositories/command-repository.js';
import { waitForWorkerMessage } from '../test/wait-for-worker-message.js';

const runProductionBuild = (
  workspaceRoot: string,
  outputPath: string,
): void => {
  const buildEnvironment = { ...process.env };
  delete buildEnvironment.NX_INVOCATION_ROOT_PID;
  delete buildEnvironment.NX_TASK_HASH;
  delete buildEnvironment.NX_TASK_TARGET_CONFIGURATION;
  delete buildEnvironment.NX_TASK_TARGET_PROJECT;
  delete buildEnvironment.NX_TASK_TARGET_TARGET;
  const pnpmArgs = [
    'nx',
    'build',
    'server',
    '--skip-nx-cache',
    `--outputPath=${relative(workspaceRoot, outputPath).replace(/\\/g, '/')}`,
  ];
  const options = {
    cwd: workspaceRoot,
    env: buildEnvironment,
    shell: false,
    stdio: 'pipe',
    timeout: 120_000,
  } as const;

  try {
    execFileSync(
      process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
      ['pnpm', ...pnpmArgs],
      options,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const details = error instanceof Error ? error.message : String(error);
    if (
      code !== 'EINVAL' &&
      code !== 'ENOENT' &&
      !/pnpm.+(?:not found|not recognized)/i.test(details)
    ) {
      throw error;
    }

    const corepackHome =
      process.env.COREPACK_HOME ??
      (process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? tmpdir(), 'node', 'corepack')
        : join(
            process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
            'node',
            'corepack',
          ));
    const cachedPnpm = globSync('v1/pnpm/*/bin/pnpm.cjs', {
      cwd: corepackHome,
    }).sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    )[0];
    const npmExecPath =
      process.env.npm_execpath ??
      (cachedPnpm && join(corepackHome, cachedPnpm));
    if (!npmExecPath) {
      throw new Error(
        'Corepack could not locate pnpm and npm_execpath is unavailable',
      );
    }
    execFileSync(process.execPath, [npmExecPath, ...pnpmArgs], {
      ...options,
      env: { ...options.env, npm_execpath: npmExecPath },
    });
  }
};

describe('migrate', () => {
  const databases: Database[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('applies the initial schema once and records it in the migration ledger', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'migration.sqlite'));
    databases.push(database);

    migrate(database);
    migrate(database);

    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
        )
        .all(),
    ).toEqual([{ name: 'sessions' }]);
    expect(
      database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
    ).toEqual([
      { id: '001-initial' },
      { id: '002-command-state' },
      { id: '003-task-board-storage' },
      { id: '004-project-event-streams' },
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'tasks',
        'task_attempts',
        'task_transitions',
        'project_events',
      ]),
    );
  });

  it('allows two connections to apply startup migrations without a duplicate ledger entry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-'));
    directories.push(directory);
    const path = join(directory, 'migration.sqlite');
    const first = openDatabase(path);
    const second = openDatabase(path);
    databases.push(first, second);

    migrate(first);
    migrate(second);

    expect(
      second.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
    ).toEqual([
      { id: '001-initial' },
      { id: '002-command-state' },
      { id: '003-task-board-storage' },
      { id: '004-project-event-streams' },
    ]);
  });

  it('serializes simultaneous startup migration attempts from two worker connections', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-migrate-worker-'),
    );
    directories.push(directory);
    const modulePath = join(directory, 'migrate.cjs');
    mkdirSync(join(directory, 'migrations'));
    copyFileSync(
      join(__dirname, 'migrations', '001-initial.sql'),
      join(directory, 'migrations', '001-initial.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '002-command-state.sql'),
      join(directory, 'migrations', '002-command-state.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '003-task-board-storage.sql'),
      join(directory, 'migrations', '003-task-board-storage.sql'),
    );
    copyFileSync(
      join(__dirname, 'migrations', '004-project-event-streams.sql'),
      join(directory, 'migrations', '004-project-event-streams.sql'),
    );
    buildSync({
      bundle: true,
      entryPoints: [join(__dirname, 'migrate.ts')],
      external: ['better-sqlite3'],
      format: 'cjs',
      outfile: modulePath,
      platform: 'node',
    });
    const databasePath = join(directory, 'concurrent.sqlite');
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const { migrate } = require(workerData.modulePath);
      const database = new Database(workerData.databasePath);
      database.pragma('busy_timeout = 5000');
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try { migrate(database); parentPort.postMessage('done'); }
      catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { database.close(); }
    `;
    const start = () =>
      new Worker(workerSource, {
        eval: true,
        workerData: { barrier, databasePath, modulePath },
      });
    const workers: Worker[] = [];

    try {
      workers.push(start());
      workers.push(start());
      await Promise.all(workers.map((worker) => waitForWorkerMessage(worker)));
      const results = Promise.all(
        workers.map((worker) => waitForWorkerMessage(worker)),
      );
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      expect(await results).toEqual(['done', 'done']);

      const database = openDatabase(databasePath);
      databases.push(database);
      expect(
        database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
      ).toEqual([
        { id: '001-initial' },
        { id: '002-command-state' },
        { id: '003-task-board-storage' },
        { id: '004-project-event-streams' },
      ]);
    } finally {
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
    }
  }, 15_000);

  it('rejects a silent worker wait within the requested bound and removes listeners', async () => {
    const workers: Worker[] = [];

    try {
      const worker = new Worker('setInterval(() => {}, 1_000)', { eval: true });
      workers.push(worker);

      await expect(waitForWorkerMessage(worker, 25)).rejects.toThrow(
        'Timed out waiting for worker message after 25ms',
      );
      expect(worker.listenerCount('message')).toBe(0);
      expect(worker.listenerCount('error')).toBe(0);
      expect(worker.listenerCount('exit')).toBe(0);
    } finally {
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
    }
  });

  it('upgrades completed responses from the exact 001 table without re-executing', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    database.exec(
      readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'),
    );
    database
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('001-initial', '2026-08-24T00:00:00.000Z');
    database
      .prepare(
        `INSERT INTO processed_commands (id, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run('old', 'old-key', '{"accepted":true}', '2026-08-24T00:00:00.000Z');

    migrate(database);
    const commands = new CommandRepository(database);
    let calls = 0;
    expect(
      commands.executeOnce('old-key', () => {
        calls += 1;
        return { accepted: false };
      }),
    ).toEqual({ accepted: true });
    expect(calls).toBe(0);
    expect(
      database
        .prepare(
          'SELECT state, updated_at FROM processed_commands WHERE id = ?',
        )
        .get('old'),
    ).toEqual({ state: 'completed', updated_at: '2026-08-24T00:00:00.000Z' });
    migrate(database);
    expect(
      database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
    ).toEqual([
      { id: '001-initial' },
      { id: '002-command-state' },
      { id: '003-task-board-storage' },
      { id: '004-project-event-streams' },
    ]);
  });

  it('upgrades discovered projects in place while preserving related records', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-task-board-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    const repositoryPath = 'C:/code/existing-project';
    const discoveredAt = '2026-08-24T00:00:00.000Z';

    database.exec(
      readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'),
    );
    database.exec(
      readFileSync(
        join(__dirname, 'migrations', '002-command-state.sql'),
        'utf8',
      ),
    );
    database
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('001-initial', discoveredAt);
    database
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('002-command-state', discoveredAt);
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at, discovery_metadata_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'project-existing',
        'Existing project',
        repositoryPath,
        discoveredAt,
        '{"source":"discovery"}',
      );
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at, discovery_metadata_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'project-same-path',
        'Same path project',
        repositoryPath,
        discoveredAt,
        '{"source":"discovery"}',
      );
    database
      .prepare(
        `INSERT INTO workspaces (
          id, project_id, type, path, git_branch, git_worktree_path, owner, cleanup_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'workspace-existing',
        'project-existing',
        'shared',
        repositoryPath,
        null,
        null,
        null,
        'active',
      );
    database
      .prepare(
        `INSERT INTO sessions (
          id, claude_resume_id, project_id, workspace_id, title, permission_mode,
          lifecycle_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-existing',
        null,
        'project-existing',
        'workspace-existing',
        'Existing session',
        'interactive',
        'running',
        discoveredAt,
        discoveredAt,
      );
    database
      .prepare(
        `INSERT INTO saved_layouts (
          id, project_id, session_id, workspace_id, dockview_json, sidebar_json,
          visible_panels_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'layout-existing',
        'project-existing',
        'session-existing',
        'workspace-existing',
        '{}',
        null,
        '[]',
        discoveredAt,
      );

    migrate(database);

    expect(
      database
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get('project-existing'),
    ).toMatchObject({
      id: 'project-existing',
      repository_path: repositoryPath,
      repository_identity: repositoryPath,
      revision: 1,
      created_at: discoveredAt,
      updated_at: discoveredAt,
      archived_at: null,
    });
    expect(
      database
        .prepare(
          'SELECT id, repository_identity FROM projects WHERE repository_path = ? ORDER BY id',
        )
        .all(repositoryPath),
    ).toEqual([
      { id: 'project-existing', repository_identity: repositoryPath },
      { id: 'project-same-path', repository_identity: repositoryPath },
    ]);
    expect(
      database
        .prepare('SELECT id, project_id FROM workspaces WHERE id = ?')
        .get('workspace-existing'),
    ).toEqual({ id: 'workspace-existing', project_id: 'project-existing' });
    expect(
      database
        .prepare(
          'SELECT id, project_id, workspace_id FROM sessions WHERE id = ?',
        )
        .get('session-existing'),
    ).toEqual({
      id: 'session-existing',
      project_id: 'project-existing',
      workspace_id: 'workspace-existing',
    });
    expect(
      database
        .prepare(
          'SELECT id, project_id, session_id, workspace_id FROM saved_layouts WHERE id = ?',
        )
        .get('layout-existing'),
    ).toEqual({
      id: 'layout-existing',
      project_id: 'project-existing',
      session_id: 'session-existing',
      workspace_id: 'workspace-existing',
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'tasks',
        'task_attempts',
        'task_transitions',
        'project_events',
      ]),
    );
  });

  it('rolls a failed 002 upgrade back to the intact 001 table and data', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'rollback.sqlite'));
    databases.push(database);
    database.exec(
      readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'),
    );
    database
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('001-initial', '2026-08-24T00:00:00.000Z');
    database
      .prepare(
        `INSERT INTO processed_commands (id, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run('old', 'old-key', '{"accepted":true}', '2026-08-24T00:00:00.000Z');
    database.exec('CREATE TABLE processed_commands_next (id TEXT)');

    expect(() => migrate(database)).toThrow();
    expect(
      database
        .prepare('SELECT response_json FROM processed_commands WHERE id = ?')
        .get('old'),
    ).toEqual({ response_json: '{"accepted":true}' });
    expect(database.prepare('SELECT id FROM schema_migrations').all()).toEqual([
      { id: '001-initial' },
    ]);
  });

  it('backfills durable project event high-water marks on upgrade', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'mesh-session-platform-project-stream-upgrade-'),
    );
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    for (const [id, file] of [
      ['001-initial', '001-initial.sql'],
      ['002-command-state', '002-command-state.sql'],
      ['003-task-board-storage', '003-task-board-storage.sql'],
    ] as const) {
      database.exec(readFileSync(join(__dirname, 'migrations', file), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(id, '2026-08-24T00:00:00.000Z');
    }
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_path, discovered_at,
          discovery_metadata_json, repository_identity, revision, created_at,
          updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'p1',
        'Mesh',
        'C:/code/mesh',
        '2026-08-24T00:00:00.000Z',
        '{}',
        'C:/code/mesh',
        1,
        '2026-08-24T00:00:00.000Z',
        '2026-08-24T00:00:00.000Z',
        null,
      );
    const insert = database.prepare(
      `INSERT INTO project_events (
        id, project_id, sequence, occurred_at, type, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('event-1', 'p1', 1, '2026-08-24T00:00:00.000Z', 'x', '{}');
    insert.run('event-2', 'p1', 2, '2026-08-24T00:00:00.000Z', 'x', '{}');

    migrate(database);

    expect(
      database
        .prepare(
          'SELECT project_id, high_water FROM project_event_streams WHERE project_id = ?',
        )
        .get('p1'),
    ).toEqual({ project_id: 'p1', high_water: 2 });
  });

  it('loads the built migration registry and applies every migration from a fresh production output', () => {
    const workspaceRoot = join(__dirname, '..', '..', '..', '..');
    const directory = mkdtempSync(
      join(workspaceRoot, '.mesh-session-platform-build-'),
    );
    const outputPath = join(directory, 'server');
    let database: Database | undefined;

    try {
      runProductionBuild(workspaceRoot, outputPath);
      const builtModule = createRequire(__filename)(
        join(outputPath, 'apps', 'server', 'src', 'db', 'migrate.js'),
      ) as { migrate: typeof migrate };
      database = openDatabase(join(directory, 'output.sqlite'));

      builtModule.migrate(database);

      expect(
        database.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
      ).toEqual([
        { id: '001-initial' },
        { id: '002-command-state' },
        { id: '003-task-board-storage' },
        { id: '004-project-event-streams' },
      ]);
      expect(
        database
          .prepare(
            "SELECT name FROM pragma_table_info('processed_commands') ORDER BY cid",
          )
          .all(),
      ).toEqual([
        { name: 'id' },
        { name: 'idempotency_key' },
        { name: 'state' },
        { name: 'response_json' },
        { name: 'failure_json' },
        { name: 'created_at' },
        { name: 'updated_at' },
      ]);
    } finally {
      database?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  }, 180_000);
});
