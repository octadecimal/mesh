import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from './database.js';
import { migrate } from './migrate.js';
import { CommandRepository } from '../repositories/command-repository.js';

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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .all(),
    ).toEqual([{ name: 'sessions' }]);
    expect(database.prepare('SELECT id FROM schema_migrations ORDER BY id').all()).toEqual([
      { id: '001-initial' },
      { id: '002-command-state' },
    ]);
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

    expect(second.prepare('SELECT id FROM schema_migrations ORDER BY id').all()).toEqual([
      { id: '001-initial' },
      { id: '002-command-state' },
    ]);
  });

  it('serializes simultaneous startup migration attempts from two worker connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-migrate-worker-'));
    directories.push(directory);
    const modulePath = join(directory, 'migrate.cjs');
    mkdirSync(join(directory, 'migrations'));
    copyFileSync(join(__dirname, 'migrations', '001-initial.sql'), join(directory, 'migrations', '001-initial.sql'));
    copyFileSync(join(__dirname, 'migrations', '002-command-state.sql'), join(directory, 'migrations', '002-command-state.sql'));
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
    const start = () => new Worker(workerSource, { eval: true, workerData: { barrier, databasePath, modulePath } });
    const first = start();
    const second = start();
    const message = (worker: Worker) => new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });

    try {
      await Promise.all([message(first), message(second)]);
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      expect(await Promise.all([message(first), message(second)])).toEqual(['done', 'done']);

      const database = openDatabase(databasePath);
      databases.push(database);
      expect(database.prepare('SELECT id FROM schema_migrations ORDER BY id').all()).toEqual([
        { id: '001-initial' },
        { id: '002-command-state' },
      ]);
    } finally {
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      await Promise.all([first.terminate(), second.terminate()]);
    }
  }, 15_000);

  it('upgrades completed responses from the exact 001 table without re-executing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-upgrade-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'upgrade.sqlite'));
    databases.push(database);
    database.exec(readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'));
    database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('001-initial', '2026-08-24T00:00:00.000Z');
    database.prepare(`INSERT INTO processed_commands (id, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)`).run('old', 'old-key', '{"accepted":true}', '2026-08-24T00:00:00.000Z');

    migrate(database);
    const commands = new CommandRepository(database);
    let calls = 0;
    expect(commands.executeOnce('old-key', () => { calls += 1; return { accepted: false }; })).toEqual({ accepted: true });
    expect(calls).toBe(0);
    expect(database.prepare('SELECT state, updated_at FROM processed_commands WHERE id = ?').get('old')).toEqual({ state: 'completed', updated_at: '2026-08-24T00:00:00.000Z' });
    migrate(database);
    expect(database.prepare('SELECT id FROM schema_migrations ORDER BY id').all()).toEqual([{ id: '001-initial' }, { id: '002-command-state' }]);
  });

  it('rolls a failed 002 upgrade back to the intact 001 table and data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-upgrade-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'rollback.sqlite'));
    databases.push(database);
    database.exec(readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'));
    database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('001-initial', '2026-08-24T00:00:00.000Z');
    database.prepare(`INSERT INTO processed_commands (id, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)`).run('old', 'old-key', '{"accepted":true}', '2026-08-24T00:00:00.000Z');
    database.exec('CREATE TABLE processed_commands_next (id TEXT)');

    expect(() => migrate(database)).toThrow();
    expect(database.prepare('SELECT response_json FROM processed_commands WHERE id = ?').get('old')).toEqual({ response_json: '{"accepted":true}' });
    expect(database.prepare('SELECT id FROM schema_migrations').all()).toEqual([{ id: '001-initial' }]);
  });

  it('loads and applies the migration SQL from a fresh production build output', () => {
    const workspaceRoot = join(__dirname, '..', '..', '..', '..');
    const directory = mkdtempSync(join(workspaceRoot, '.mesh-session-platform-build-'));
    directories.push(directory);
    const outputPath = join(directory, 'server');
    writeFileSync(join(directory, 'pnpm.cmd'), '@echo off\r\ncorepack pnpm %*\r\n');

    execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        `corepack pnpm nx run server:build --outputPath="${outputPath}"`,
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, PATH: `${directory};${process.env.PATH ?? ''}` },
        stdio: 'pipe',
      },
    );

    const migrationSql = readFileSync(
      join(outputPath, 'db', 'migrations', '001-initial.sql'),
      'utf8',
    );
    expect(readFileSync(join(outputPath, 'db', 'migrations', '002-command-state.sql'), 'utf8')).toContain(
      'processed_commands_next',
    );
    const database = openDatabase(join(directory, 'output.sqlite'));
    databases.push(database);
    database.exec(migrationSql);

    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'processed_commands'")
        .all(),
    ).toEqual([{ name: 'processed_commands' }]);
  });
});
