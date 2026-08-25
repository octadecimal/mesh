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
    ).toEqual([{ id: '001-initial' }, { id: '002-command-state' }]);
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
    ).toEqual([{ id: '001-initial' }, { id: '002-command-state' }]);
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
      ).toEqual([{ id: '001-initial' }, { id: '002-command-state' }]);
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
    ).toEqual([{ id: '001-initial' }, { id: '002-command-state' }]);
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
      ).toEqual([{ id: '001-initial' }, { id: '002-command-state' }]);
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
