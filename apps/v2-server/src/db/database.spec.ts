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
import { V2CommandRepository } from '../storage/command-repository.js';
import {
  createV2TestDatabase,
  insertV2TestProject,
} from '../test/create-v2-test-database.js';

const openDatabases: V2Database[] = [];
const testDatabases: ReturnType<typeof createV2TestDatabase>[] = [];
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

const migrationPath = join(__dirname, 'migrations', '001_foundation.sql');

const createMigration1Database = (path: string) => {
  const database = new BetterSqlite3(path);
  database.pragma(`application_id = ${V2_APPLICATION_ID}`);
  database.exec(`
    CREATE TABLE v2_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version >= 0),
      name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
      applied_at TEXT NOT NULL CHECK (length(applied_at) > 0)
    );
    ${readFileSync(migrationPath, 'utf8')}
    INSERT INTO v2_schema_migrations (version, name, applied_at)
    VALUES (1, '001_foundation', '2026-08-28T00:00:00.000Z');
  `);
  return database;
};

const legacyStartOperationRequest = (input: {
  projectId: string;
  profileId: string;
  idempotencyKey: string;
  requestHash: string;
}) => ({
  version: 'mesh.v2.execution-start/v1',
  idempotencyKey: input.idempotencyKey,
  requestHash: input.requestHash,
  request: {
    type: 'worker_execution.start',
    projectId: input.projectId,
    profileId: input.profileId,
    profileRevision: 1,
    assignment: {
      kind: 'foundation-check',
      projectId: input.projectId,
      title: 'Check',
      instructions: 'Check',
      fakeScenario: 'todo-foundation-v1',
    },
  },
});

const schemaRows = (database: V2Database) =>
  database
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();

afterEach(async () => {
  for (const fixture of testDatabases.splice(0)) fixture.close();
  for (const database of openDatabases.splice(0)) database.close();
  const { rm } = await import('node:fs/promises');
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe('V2 database identity and migration', () => {
  it('claims a fresh database, applies both migrations, and configures every connection', () => {
    const path = join(temporaryDirectory(), 'fresh.sqlite');

    const database = openV2Database(path);
    openDatabases.push(database);

    expect(database.pragma('application_id', { simple: true })).toBe(
      V2_APPLICATION_ID,
    );
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000);
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(
      database
        .prepare(
          'SELECT version, name FROM v2_schema_migrations ORDER BY version',
        )
        .all(),
    ).toEqual([
      { version: 1, name: '001_foundation' },
      { version: 2, name: '002_intent_ledger' },
    ]);
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
    ).toEqual({ count: 2 });
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
    ).toEqual([{ version: 1 }, { version: 2 }]);
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

  it('rejects duplicate known migration ledger rows before mutation', () => {
    const path = join(temporaryDirectory(), 'duplicate-ledger.sqlite');
    const database = new BetterSqlite3(path);
    database.pragma(`application_id = ${V2_APPLICATION_ID}`);
    database.exec(`
      CREATE TABLE v2_schema_migrations (
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO v2_schema_migrations (version, name, applied_at)
      VALUES
        (1, '001_foundation', '2026-08-28T00:00:00.000Z'),
        (1, '001_foundation', '2026-08-28T00:00:01.000Z');
    `);
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
  });

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

  it('creates the planning tables and exact partial/expression indexes', () => {
    const database = openV2Database(
      join(temporaryDirectory(), 'schema.sqlite'),
    );
    openDatabases.push(database);

    expect(tableNames(database)).toEqual(
      expect.arrayContaining([
        'planning_cycles',
        'planning_turns',
        'planning_questions',
        'planning_proposals',
        'planning_proposal_records',
        'pm_output_receipts',
        'project_intent_revisions',
        'project_intent_provenance',
        'ledger_records',
        'ledger_record_revisions',
        'ledger_record_revision_provenance',
        'ledger_revisions',
        'ledger_revision_members',
        'ledger_revision_relationships',
      ]),
    );
    expect(
      (
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
          )
          .all() as { name: string }[]
      ).map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        'execution_operations_pending',
        'execution_operations_start_request',
        'planning_cycles_one_nonterminal',
        'planning_turns_one_pending',
        'runtime_events_project_execution_identity',
        'worker_profiles_global_name',
        'worker_profiles_project_name',
      ]),
    );

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

  it('rejects a receipt whose runtime event belongs to another project and execution', () => {
    const fixture = createV2TestDatabase();
    testDatabases.push(fixture);
    const database = fixture.database;
    const at = '2026-08-29T00:00:00.000Z';
    const cycleId = randomUUID();
    const turnId = randomUUID();
    database
      .prepare(
        `INSERT INTO planning_cycles (
          id, project_id, lifecycle, revision, profile_id, profile_revision,
          base_project_intent_revision, base_ledger_revision,
          latest_proposal_revision, active_execution_id, created_at, updated_at,
          ended_at
        ) VALUES (?, ?, 'execution_active', 1, ?, 1, NULL, NULL, 0, ?, ?, ?, NULL)`,
      )
      .run(
        cycleId,
        fixture.project.id,
        fixture.pmProfileRevision.profileId,
        fixture.execution.id,
        at,
        at,
      );
    database
      .prepare(
        `INSERT INTO planning_turns VALUES (
          ?, ?, ?, 1, 'human', 'Plan Todo.', 'execution_bound', ?, ?
        )`,
      )
      .run(turnId, fixture.project.id, cycleId, fixture.execution.id, at);

    const otherProject = insertV2TestProject(database, {
      id: randomUUID(),
      displayName: 'Other',
      repositoryIdentity: 'other-repository',
    });
    const otherExecutionId = randomUUID();
    database
      .prepare(
        `INSERT INTO worker_executions (
          id, project_id, profile_id, profile_revision, assignment_json,
          profile_snapshot_json, skill_requests_json, resolved_skills_json,
          capability_snapshot_json, adapter_id, model, native_handle, lifecycle,
          revision, last_adapter_cursor, last_runtime_sequence,
          replacement_for_execution_id, failure_json, created_at, updated_at,
          ended_at
        ) SELECT ?, ?, profile_id, profile_revision, ?, profile_snapshot_json,
          skill_requests_json, resolved_skills_json, capability_snapshot_json,
          adapter_id, model, native_handle, lifecycle, revision,
          last_adapter_cursor, last_runtime_sequence, NULL, failure_json,
          created_at, updated_at, ended_at
        FROM worker_executions WHERE id = ?`,
      )
      .run(
        otherExecutionId,
        otherProject.id,
        JSON.stringify({
          kind: 'foundation-check',
          projectId: otherProject.id,
          title: 'Other check',
          instructions: 'Check the other repository.',
          fakeScenario: 'todo-foundation-v1',
        }),
        fixture.execution.id,
      );
    const diagnosticId = randomUUID();
    const runtimeEventId = randomUUID();
    database
      .prepare(
        `INSERT INTO raw_diagnostics VALUES (?, ?, ?, 'fake', 1, ?, '{}')`,
      )
      .run(diagnosticId, otherProject.id, otherExecutionId, at);
    database
      .prepare(
        `INSERT INTO runtime_events VALUES (
          ?, ?, ?, ?, 1, 1, ?, 'worker_execution.structured_output', '{}'
        )`,
      )
      .run(runtimeEventId, otherProject.id, otherExecutionId, diagnosticId, at);

    expect(() =>
      database
        .prepare(
          `INSERT INTO pm_output_receipts VALUES (
            ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?
          )`,
        )
        .run(
          fixture.execution.id,
          fixture.project.id,
          cycleId,
          turnId,
          runtimeEventId,
          'a'.repeat(64),
          at,
        ),
    ).toThrow();
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });

  it('upgrades migration 1 without changing its source or M1 rows and replays all eight command types', () => {
    const path = join(temporaryDirectory(), 'upgrade.sqlite');
    const migrationHash = fileHash(migrationPath);
    const database = createMigration1Database(path);
    const projectId = randomUUID();
    database
      .prepare(
        `INSERT INTO projects (
          id, display_name, repository_identity, repository_path,
          git_common_directory, head_commit, revision, created_at, updated_at
        ) VALUES (?, 'Todo', 'upgrade-repo', 'C:/todo', 'C:/todo/.git', ?, 1, ?, ?)`,
      )
      .run(
        projectId,
        'a'.repeat(40),
        '2026-08-28T00:00:00.000Z',
        '2026-08-28T00:00:00.000Z',
      );
    const m1Types = [
      'project.register',
      'worker_profile.approve_revision',
      'worker_execution.start',
      'worker_execution.interrupt',
    ] as const;
    for (const [index, commandType] of m1Types.entries()) {
      database
        .prepare(
          `INSERT INTO command_results (
            idempotency_key, command_type, request_hash, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          `m1-${index}`,
          commandType,
          String(index).repeat(64),
          JSON.stringify({
            ok: false,
            commandType,
            error: { code: 'invalid_request', message: `m1-${index}` },
          }),
          '2026-08-28T00:00:00.000Z',
        );
    }
    const beforeRows = database
      .prepare('SELECT * FROM command_results ORDER BY idempotency_key')
      .all();
    const beforeM1Schema = schemaRows(database).filter(
      (row) => (row as { name: string }).name !== 'command_results',
    );

    migrateV2Database(database);
    openDatabases.push(database);

    expect(fileHash(migrationPath)).toBe(migrationHash);
    expect(
      database
        .prepare('SELECT * FROM command_results ORDER BY idempotency_key')
        .all(),
    ).toEqual(beforeRows);
    expect(
      schemaRows(database).filter((row) => {
        const name = (row as { name: string }).name;
        return (
          name !== 'command_results' &&
          !name.startsWith('planning_') &&
          !name.startsWith('pm_output_') &&
          !name.startsWith('project_intent_') &&
          !name.startsWith('ledger_') &&
          name !== 'execution_operations_start_request' &&
          name !== 'runtime_events_project_execution_identity' &&
          name !== 'worker_executions_project_identity'
        );
      }),
    ).toEqual(beforeM1Schema);
    const commands = new V2CommandRepository(database);
    for (const [index, commandType] of m1Types.entries()) {
      expect(commands.find(`m1-${index}`)?.result).toMatchObject({
        ok: false,
        commandType,
      });
    }
    const m2Types = [
      'planning_cycle.submit_turn',
      'planning_proposal.approve',
      'planning_proposal.reject',
      'planning_cycle.abandon',
    ] as const;
    inImmediateTransaction(database, () => {
      for (const [index, commandType] of m2Types.entries()) {
        commands.storeInTransaction({
          idempotencyKey: `m2-${index}`,
          commandType,
          requestHash: 'f'.repeat(64 - String(index).length) + index,
          result: {
            ok: false,
            commandType,
            error: { code: 'invalid_request', message: `m2-${index}` },
          },
          createdAt: '2026-08-29T00:00:00.000Z',
        });
      }
    });
    for (const [index, commandType] of m2Types.entries()) {
      expect(commands.find(`m2-${index}`)?.result).toMatchObject({
        ok: false,
        commandType,
      });
    }
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });

  it('indexes valid start-operation links and rejects malformed or duplicate legacy links', () => {
    const validPath = join(temporaryDirectory(), 'valid-link.sqlite');
    const valid = createMigration1Database(validPath);
    const projectId = randomUUID();
    const profileId = randomUUID();
    const executionId = randomUUID();
    const at = '2026-08-28T00:00:00.000Z';
    valid.exec(`
      INSERT INTO projects VALUES (
        '${projectId}', 'Todo', 'link-repo', 'C:/todo', 'C:/todo/.git',
        '${'a'.repeat(40)}', 1, '${at}', '${at}'
      );
      INSERT INTO worker_profiles VALUES (
        '${profileId}', 'global', NULL, 'worker', 'Worker', 1, '${at}', '${at}'
      );
      INSERT INTO worker_profile_revisions VALUES (
        '${profileId}', 1, 'profile', '{"apiVersion":"mesh.dev/v1alpha1"}',
        NULL, NULL, '{"kind":"human"}', '${at}', '${'b'.repeat(64)}'
      );
    `);
    valid
      .prepare(
        `INSERT INTO worker_executions VALUES (
          ?, ?, ?, 1, ?, ?, '{}', '[]', ?, 'fake', 'deterministic', NULL,
          'starting', 0, 0, 0, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        executionId,
        projectId,
        profileId,
        JSON.stringify({
          kind: 'foundation-check',
          projectId,
          title: 'Check',
          instructions: 'Check',
          fakeScenario: 'todo-foundation-v1',
        }),
        JSON.stringify({}),
        JSON.stringify({ adapterId: 'fake' }),
        at,
        at,
      );
    valid
      .prepare(
        `INSERT INTO execution_operations VALUES (?, ?, 'start', 'pending', ?, NULL, ?, ?)`,
      )
      .run(
        randomUUID(),
        executionId,
        JSON.stringify(
          legacyStartOperationRequest({
            projectId,
            profileId,
            idempotencyKey: 'start-key',
            requestHash: 'c'.repeat(64),
          }),
        ),
        at,
        at,
      );
    migrateV2Database(valid);
    openDatabases.push(valid);
    expect(
      valid
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'index' AND name = 'execution_operations_start_request'`,
        )
        .get(),
    ).toEqual({ name: 'execution_operations_start_request' });

    for (const mode of [
      'malformed',
      'duplicate',
      'extra',
      'wrong-type',
      'nested',
    ] as const) {
      const path = join(temporaryDirectory(), `${mode}-link.sqlite`);
      const database = createMigration1Database(path);
      openDatabases.push(database);
      database.exec(`
        INSERT INTO projects VALUES (
          '${randomUUID()}', 'Todo', '${mode}', 'C:/${mode}', 'C:/${mode}/.git',
          '${'d'.repeat(40)}', 1, '${at}', '${at}'
        );
      `);
      const project = (
        database.prepare('SELECT id FROM projects').get() as { id: string }
      ).id;
      const p = randomUUID();
      database
        .prepare(
          `INSERT INTO worker_profiles VALUES (?, 'global', NULL, ?, 'Worker', NULL, ?, ?)`,
        )
        .run(p, `worker-${mode}`, at, at);
      database
        .prepare(
          `INSERT INTO worker_profile_revisions VALUES (
            ?, 0, 'profile', '{}', NULL, NULL, '{"kind":"human"}', ?, ?
          )`,
        )
        .run(p, at, 'f'.repeat(64));
      const insertExecution = database.prepare(
        `INSERT INTO worker_executions VALUES (
          ?, ?, ?, 0, ?, '{}', '{}', '[]', '{}', 'fake', 'deterministic', NULL,
          'starting', 0, 0, 0, NULL, NULL, ?, ?, NULL)`,
      );
      const operationCount = mode === 'duplicate' ? 2 : 1;
      for (let index = 0; index < operationCount; index += 1) {
        const id = randomUUID();
        insertExecution.run(
          id,
          project,
          p,
          JSON.stringify({
            kind: 'foundation-check',
            projectId: project,
            title: 'Check',
            instructions: 'Check',
            fakeScenario: 'todo-foundation-v1',
          }),
          at,
          at,
        );
        database
          .prepare(
            `INSERT INTO execution_operations VALUES (?, ?, 'start', 'pending', ?, NULL, ?, ?)`,
          )
          .run(
            randomUUID(),
            id,
            JSON.stringify(
              (() => {
                const validRequest = legacyStartOperationRequest({
                  projectId: project,
                  profileId: p,
                  idempotencyKey:
                    mode === 'duplicate' ? 'duplicate-key' : `${mode}-key`,
                  requestHash: 'e'.repeat(64),
                });
                if (mode === 'malformed') {
                  return {
                    version: validRequest.version,
                    idempotencyKey: validRequest.idempotencyKey,
                    request: validRequest.request,
                  };
                }
                if (mode === 'extra') return { ...validRequest, extra: true };
                if (mode === 'wrong-type') {
                  return {
                    ...validRequest,
                    request: {
                      ...validRequest.request,
                      profileRevision: '1',
                    },
                  };
                }
                if (mode === 'nested') {
                  return {
                    ...validRequest,
                    request: {
                      ...validRequest.request,
                      assignment: {
                        ...validRequest.request.assignment,
                        extra: true,
                      },
                    },
                  };
                }
                return validRequest;
              })(),
            ),
            at,
            at,
          );
      }
      const beforeSchema = schemaRows(database);
      const beforeOperations = database
        .prepare('SELECT * FROM execution_operations ORDER BY id')
        .all();
      expect(() => migrateV2Database(database)).toThrow();
      expect(schemaRows(database)).toEqual(beforeSchema);
      expect(
        database
          .prepare('SELECT * FROM execution_operations ORDER BY id')
          .all(),
      ).toEqual(beforeOperations);
      expect(
        database.prepare('SELECT version FROM v2_schema_migrations').all(),
      ).toEqual([{ version: 1 }]);
    }
  });

  it('rolls a failed migration-2 table rebuild back to the exact migration-1 state', () => {
    const path = join(temporaryDirectory(), 'migration-2-rollback.sqlite');
    const database = createMigration1Database(path);
    database.exec('CREATE TABLE planning_cycles (sentinel TEXT NOT NULL)');
    database
      .prepare(
        `INSERT INTO command_results VALUES ('sentinel', 'project.register', ?, ?, ?)`,
      )
      .run(
        'a'.repeat(64),
        JSON.stringify({
          ok: false,
          commandType: 'project.register',
          error: { code: 'invalid_request', message: 'sentinel' },
        }),
        '2026-08-28T00:00:00.000Z',
      );
    const before = schemaRows(database);
    const rows = database.prepare('SELECT * FROM command_results').all();

    expect(() => migrateV2Database(database)).toThrow();

    expect(schemaRows(database)).toEqual(before);
    expect(database.prepare('SELECT * FROM command_results').all()).toEqual(
      rows,
    );
    expect(
      database.prepare('SELECT * FROM v2_schema_migrations').all(),
    ).toEqual([
      {
        version: 1,
        name: '001_foundation',
        applied_at: '2026-08-28T00:00:00.000Z',
      },
    ]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });

  it('enforces project ownership for executions, proposals, and canonical bases', () => {
    const fixture = createV2TestDatabase();
    testDatabases.push(fixture);
    const database = fixture.database;
    const projectA = fixture.project.id;
    const projectB = insertV2TestProject(database, {
      id: randomUUID(),
      displayName: 'Second project',
      repositoryIdentity: 'second-project',
    }).id;
    const executionB = randomUUID();
    database
      .prepare(
        `INSERT INTO worker_executions
         SELECT ?, ?, profile_id, profile_revision, assignment_json,
           profile_snapshot_json, skill_requests_json, resolved_skills_json,
           capability_snapshot_json, adapter_id, model, native_handle,
           lifecycle, revision, last_adapter_cursor, last_runtime_sequence,
           replacement_for_execution_id, failure_json, created_at, updated_at,
           ended_at
         FROM worker_executions WHERE id = ?`,
      )
      .run(executionB, projectB, fixture.execution.id);
    const cycleA = randomUUID();
    const humanA = randomUUID();
    const pmA = randomUUID();
    const proposalA = randomUUID();
    const cycleB = randomUUID();
    const humanB = randomUUID();
    const pmB = randomUUID();
    const at = '2026-08-29T00:00:00.000Z';
    const insertCycle = database.prepare(
      `INSERT INTO planning_cycles VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    );
    const insertTurn = database.prepare(
      `INSERT INTO planning_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertProposal = database.prepare(
      `INSERT INTO planning_proposals VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    );
    insertCycle.run(
      cycleA,
      projectA,
      'awaiting_approval',
      1,
      fixture.pmProfileRevision.profileId,
      fixture.pmProfileRevision.revision,
      null,
      null,
      1,
      null,
      at,
      at,
      null,
    );
    insertTurn.run(
      humanA,
      projectA,
      cycleA,
      1,
      'human',
      'Build Todo.',
      'execution_bound',
      fixture.execution.id,
      at,
    );
    insertTurn.run(
      pmA,
      projectA,
      cycleA,
      2,
      'pm',
      'Review proposal.',
      null,
      fixture.execution.id,
      at,
    );
    insertProposal.run(
      proposalA,
      projectA,
      cycleA,
      1,
      'awaiting_approval',
      null,
      null,
      'Todo proposal',
      '{}',
      '[]',
      '[]',
      '{}',
      pmA,
      fixture.execution.id,
      null,
      at,
      null,
    );
    database
      .prepare(
        `INSERT INTO project_intent_revisions
         VALUES (?, ?, 1, '{}', ?, 'human', ?)`,
      )
      .run(randomUUID(), projectA, proposalA, at);
    database
      .prepare(
        `INSERT INTO ledger_revisions
         VALUES (?, ?, 1, ?, 'human', ?)`,
      )
      .run(randomUUID(), projectA, proposalA, at);
    insertCycle.run(
      cycleB,
      projectB,
      'discovering',
      0,
      fixture.pmProfileRevision.profileId,
      fixture.pmProfileRevision.revision,
      null,
      null,
      0,
      null,
      at,
      at,
      null,
    );
    insertTurn.run(
      humanB,
      projectB,
      cycleB,
      1,
      'human',
      'Build notes.',
      'execution_bound',
      executionB,
      at,
    );
    insertTurn.run(
      pmB,
      projectB,
      cycleB,
      2,
      'pm',
      'Review notes proposal.',
      null,
      executionB,
      at,
    );

    const expectOwnershipFailure = (operation: () => void) => {
      database.exec('SAVEPOINT ownership_check');
      let error: unknown;
      try {
        operation();
      } catch (caught) {
        error = caught;
      } finally {
        database.exec('ROLLBACK TO ownership_check');
        database.exec('RELEASE ownership_check');
      }
      expect(error).toBeDefined();
    };

    expectOwnershipFailure(() =>
      database
        .prepare(
          `UPDATE planning_cycles
           SET lifecycle = 'execution_active', active_execution_id = ?
           WHERE id = ?`,
        )
        .run(fixture.execution.id, cycleB),
    );
    expectOwnershipFailure(() =>
      insertTurn.run(
        randomUUID(),
        projectB,
        cycleB,
        3,
        'pm',
        'Wrong execution.',
        null,
        fixture.execution.id,
        at,
      ),
    );
    expectOwnershipFailure(() =>
      insertProposal.run(
        randomUUID(),
        projectB,
        cycleB,
        1,
        'awaiting_approval',
        null,
        null,
        'Wrong execution proposal',
        '{}',
        '[]',
        '[]',
        '{}',
        pmB,
        fixture.execution.id,
        null,
        at,
        null,
      ),
    );
    expectOwnershipFailure(() =>
      database
        .prepare(
          `INSERT INTO project_intent_revisions
           VALUES (?, ?, 1, '{}', ?, 'human', ?)`,
        )
        .run(randomUUID(), projectB, proposalA, at),
    );
    expectOwnershipFailure(() =>
      database
        .prepare(
          `INSERT INTO ledger_revisions
           VALUES (?, ?, 1, ?, 'human', ?)`,
        )
        .run(randomUUID(), projectB, proposalA, at),
    );
    expectOwnershipFailure(() =>
      database
        .prepare(
          `UPDATE planning_cycles
           SET base_project_intent_revision = 1, base_ledger_revision = 1
           WHERE id = ?`,
        )
        .run(cycleB),
    );
    expectOwnershipFailure(() =>
      insertProposal.run(
        randomUUID(),
        projectB,
        cycleB,
        1,
        'awaiting_approval',
        1,
        1,
        'Wrong canonical bases',
        '{}',
        '[]',
        '[]',
        '{}',
        pmB,
        executionB,
        null,
        at,
        null,
      ),
    );
    expect(database.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
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
