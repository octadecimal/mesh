import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  inImmediateTransaction,
  openV2Database,
  V2_APPLICATION_ID,
  type V2Database,
} from './database.js';
import { migrateV2Database } from './migrate.js';

const openDatabases: V2Database[] = [];
const directories: string[] = [];

const temporaryDirectory = () => {
  const directory = join(
    process.cwd(),
    `.mesh-v2-database-test-${randomUUID()}`,
  );
  mkdirSync(directory, { recursive: true });
  directories.push(directory);
  return directory;
};

const fileHash = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const tableNames = (database: V2Database) =>
  (
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(({ name }) => name);

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  const { rm } = await import('node:fs/promises');
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe('V2 database identity and migration', () => {
  it('claims a fresh database, applies migration 001, and configures every connection', () => {
    const path = join(temporaryDirectory(), 'fresh.sqlite');

    const database = openV2Database(path);
    openDatabases.push(database);

    expect(database.pragma('application_id', { simple: true })).toBe(
      V2_APPLICATION_ID,
    );
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000);
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(
      database
        .prepare(
          'SELECT version, name FROM v2_schema_migrations ORDER BY version',
        )
        .all(),
    ).toEqual([{ version: 1, name: '001_foundation' }]);
  });

  it('reopens an existing identified V2 database without replacing its data', () => {
    const path = join(temporaryDirectory(), 'reopen.sqlite');
    const first = openV2Database(path);
    first
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_identity, repository_path,
          git_common_directory, head_commit, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        'Todo',
        'repo-identity',
        'C:/todo',
        'C:/todo/.git',
        'a'.repeat(40),
        1,
        '2026-08-28T00:00:00.000Z',
        '2026-08-28T00:00:00.000Z',
      );
    first.close();

    const reopened = openV2Database(path);
    openDatabases.push(reopened);

    expect(reopened.prepare('SELECT display_name FROM projects').get()).toEqual(
      { display_name: 'Todo' },
    );
    expect(
      reopened
        .prepare('SELECT COUNT(*) AS count FROM v2_schema_migrations')
        .get(),
    ).toEqual({ count: 1 });
  });

  it('migrates an identified pre-foundation V2 database forward', () => {
    const path = join(temporaryDirectory(), 'forward.sqlite');
    const before = new BetterSqlite3(path);
    before.pragma(`application_id = ${V2_APPLICATION_ID}`);
    before.exec(`
      CREATE TABLE v2_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `);
    before.close();

    const migrated = openV2Database(path);
    openDatabases.push(migrated);

    expect(tableNames(migrated)).toContain('worker_executions');
    expect(
      migrated.prepare('SELECT version FROM v2_schema_migrations').all(),
    ).toEqual([{ version: 1 }]);
  });

  it.each([
    ['unmarked V1-like', 0],
    ['unknown application', 42],
  ])(
    'rejects a non-empty %s database without changing its bytes',
    (_name, id) => {
      const path = join(temporaryDirectory(), 'foreign.sqlite');
      const foreign = new BetterSqlite3(path);
      foreign.exec('CREATE TABLE v1_sessions (id TEXT PRIMARY KEY)');
      if (id !== 0) foreign.pragma(`application_id = ${id}`);
      foreign.close();
      const before = fileHash(path);

      expect(() => openV2Database(path)).toThrowError(
        expect.objectContaining({ code: 'database_identity_mismatch' }),
      );

      expect(fileHash(path)).toBe(before);
    },
  );

  it.each([
    ['unmarked V1-like', 0],
    ['foreign application', 42],
  ])(
    'rejects direct migration of a non-empty %s database without changing its bytes',
    (_name, id) => {
      const path = join(temporaryDirectory(), 'direct-foreign.sqlite');
      const foreign = new BetterSqlite3(path);
      foreign.exec('CREATE TABLE v1_sessions (id TEXT PRIMARY KEY)');
      if (id !== 0) foreign.pragma(`application_id = ${id}`);
      foreign.close();
      const before = fileHash(path);

      const direct = new BetterSqlite3(path);
      try {
        expect(() => migrateV2Database(direct)).toThrowError(
          expect.objectContaining({ code: 'database_identity_mismatch' }),
        );
      } finally {
        direct.close();
      }

      expect(fileHash(path)).toBe(before);
    },
  );

  it.each([
    [1, 'renamed_foundation'],
    [2, '002_future'],
  ])(
    'rejects migration ledger entry %s/%s before mutation',
    (version, name) => {
      const path = join(temporaryDirectory(), `ledger-${version}.sqlite`);
      const database = new BetterSqlite3(path);
      database.pragma(`application_id = ${V2_APPLICATION_ID}`);
      database.exec(`
        CREATE TABLE v2_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL
        )
      `);
      database
        .prepare(
          `INSERT INTO v2_schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(version, name, '2026-08-28T00:00:00.000Z');
      database.close();
      const before = fileHash(path);

      const direct = new BetterSqlite3(path);
      try {
        expect(() => migrateV2Database(direct)).toThrowError(
          expect.objectContaining({ code: 'migration_ledger_mismatch' }),
        );
      } finally {
        direct.close();
      }

      expect(fileHash(path)).toBe(before);
    },
  );

  it('rolls back every earlier migration statement when migration 001 fails', () => {
    const path = join(temporaryDirectory(), 'broken-forward.sqlite');
    const before = new BetterSqlite3(path);
    before.pragma(`application_id = ${V2_APPLICATION_ID}`);
    before.exec(`
      CREATE TABLE v2_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE runtime_events (sentinel TEXT NOT NULL);
    `);
    before.close();

    expect(() => openV2Database(path)).toThrow();

    const inspected = new BetterSqlite3(path);
    openDatabases.push(inspected);
    expect(tableNames(inspected)).toEqual([
      'runtime_events',
      'v2_schema_migrations',
    ]);
    expect(
      inspected.prepare('SELECT * FROM v2_schema_migrations').all(),
    ).toEqual([]);
  });

  it('creates the exact M1 tables, partial unique indexes, and enforced checks', () => {
    const database = openV2Database(
      join(temporaryDirectory(), 'schema.sqlite'),
    );
    openDatabases.push(database);

    expect(tableNames(database)).toEqual([
      'command_results',
      'domain_events',
      'event_streams',
      'execution_operations',
      'projects',
      'raw_diagnostics',
      'runtime_events',
      'v2_schema_migrations',
      'worker_executions',
      'worker_profile_revisions',
      'worker_profiles',
    ]);
    expect(
      (
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
          )
          .all() as { name: string }[]
      ).map(({ name }) => name),
    ).toEqual([
      'execution_operations_pending',
      'worker_profiles_global_name',
      'worker_profiles_project_name',
    ]);

    expect(() =>
      database
        .prepare(
          `INSERT INTO worker_profiles (
            id, scope, project_id, name, display_name, approved_revision,
            created_at, updated_at
          ) VALUES (?, 'project', NULL, 'bad', 'Bad', NULL, ?, ?)`,
        )
        .run(
          randomUUID(),
          '2026-08-28T00:00:00.000Z',
          '2026-08-28T00:00:00.000Z',
        ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO event_streams (project_id, stream_kind, high_water)
           VALUES (?, 'invalid', -1)`,
        )
        .run(randomUUID()),
    ).toThrow();

    const profileId = randomUUID();
    database
      .prepare(
        `INSERT INTO worker_profiles (
          id, scope, project_id, name, display_name, approved_revision,
          created_at, updated_at
        ) VALUES (?, 'global', NULL, 'json-check', 'JSON check', NULL, ?, ?)`,
      )
      .run(profileId, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z');
    expect(() =>
      database
        .prepare(
          `INSERT INTO worker_profile_revisions (
            profile_id, revision, source_yaml, normalized_json,
            base_profile_id, base_revision, approved_by, approved_at, digest
          ) VALUES (?, 1, 'profile', '{}', NULL, NULL, 'human', ?, ?)`,
        )
        .run(profileId, '2026-08-28T00:00:00.000Z', 'a'.repeat(64)),
    ).toThrow();
  });

  it('enforces foreign keys and rolls back immediate transactions completely', () => {
    const database = openV2Database(
      join(temporaryDirectory(), 'transactions.sqlite'),
    );
    openDatabases.push(database);

    expect(() =>
      database
        .prepare(
          `INSERT INTO domain_events (
            id, project_id, sequence, occurred_at, type, payload_json
          ) VALUES (?, ?, 1, ?, 'project.registered', '{}')`,
        )
        .run(randomUUID(), randomUUID(), '2026-08-28T00:00:00.000Z'),
    ).toThrow();

    expect(() =>
      inImmediateTransaction(database, () => {
        database
          .prepare(
            `INSERT INTO command_results (
              idempotency_key, command_type, request_hash, result_json, created_at
            ) VALUES ('rollback', 'project.register', ?, '{}', ?)`,
          )
          .run('0'.repeat(64), '2026-08-28T00:00:00.000Z');
        throw new Error('force rollback');
      }),
    ).toThrowError('force rollback');
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM command_results WHERE idempotency_key = 'rollback'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});
