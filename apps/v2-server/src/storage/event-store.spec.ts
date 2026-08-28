import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  DomainEventDraft,
  Project,
  RuntimeEventDraft,
  V2Command,
  V2CommandResult,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { inImmediateTransaction } from '../db/database.js';
import {
  createV2TestDatabase,
  insertV2TestProject,
  type V2TestDatabase,
} from '../test/create-v2-test-database.js';
import {
  hashV2Command,
  V2CommandRepository,
  type StoredCommandResult,
} from './command-repository.js';

const fixtures: V2TestDatabase[] = [];
const setup = () => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  return fixture;
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const registeredDraft = (project: Project): DomainEventDraft => ({
  projectId: project.id,
  occurredAt: '2026-08-28T00:00:00.000Z',
  type: 'project.registered',
  payload: { project },
});

const outputDraft = (
  fixture: V2TestDatabase,
  adapterCursor: number,
): RuntimeEventDraft => ({
  projectId: fixture.project.id,
  executionId: fixture.execution.id,
  adapterCursor,
  occurredAt: '2026-08-28T00:00:00.000Z',
  type: 'worker_execution.output',
  payload: { text: `output ${adapterCursor}` },
});

const appendRuntime = (fixture: V2TestDatabase, adapterCursor: number) =>
  inImmediateTransaction(fixture.database, () =>
    fixture.events.appendRuntimeWithDiagnosticInTransaction(
      fixture.project.id,
      {
        projectId: fixture.project.id,
        executionId: fixture.execution.id,
        adapterId: 'fake',
        adapterCursor,
        receivedAt: '2026-08-28T00:00:00.000Z',
        payload: { exact: adapterCursor },
      },
      outputDraft(fixture, adapterCursor),
    ),
  );

describe('V2CommandRepository', () => {
  it('stores one canonical result for repeated use of the same request', () => {
    const fixture = setup();
    const command: V2Command = {
      type: 'project.register',
      repositoryPath: 'C:/todo',
    };
    const result: V2CommandResult = {
      ok: true,
      commandType: 'project.register',
      project: fixture.project,
    };
    const stored: StoredCommandResult = {
      idempotencyKey: 'same-request',
      commandType: command.type,
      requestHash: hashV2Command(command),
      result,
      createdAt: '2026-08-28T00:00:00.000Z',
    };

    inImmediateTransaction(fixture.database, () => {
      fixture.commands.storeInTransaction(stored);
      fixture.commands.storeInTransaction(stored);
    });

    expect(
      fixture.commands.find('same-request', hashV2Command(command)),
    ).toEqual(stored);
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM command_results WHERE idempotency_key = 'same-request'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it('rejects reuse of an idempotency key with a different canonical request hash', () => {
    const fixture = setup();
    const first: V2Command = {
      type: 'project.register',
      repositoryPath: 'C:/todo',
    };
    const second: V2Command = {
      type: 'project.register',
      repositoryPath: 'C:/different',
    };
    inImmediateTransaction(fixture.database, () =>
      fixture.commands.storeInTransaction({
        idempotencyKey: 'conflict',
        commandType: first.type,
        requestHash: hashV2Command(first),
        result: {
          ok: true,
          commandType: first.type,
          project: fixture.project,
        },
        createdAt: '2026-08-28T00:00:00.000Z',
      }),
    );

    expect(() =>
      fixture.commands.find('conflict', hashV2Command(second)),
    ).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }));
  });

  it('requires an active transaction for command result writes', () => {
    const fixture = setup();
    const repository = new V2CommandRepository(fixture.database);

    expect(() =>
      repository.storeInTransaction({
        idempotencyKey: 'outside',
        commandType: 'project.register',
        requestHash: '0'.repeat(64),
        result: {
          ok: true,
          commandType: 'project.register',
          project: fixture.project,
        },
        createdAt: '2026-08-28T00:00:00.000Z',
      }),
    ).toThrowError(/transaction/i);
  });
});

describe('V2EventStore', () => {
  it('atomically advances the referenced execution cursors with a runtime event', () => {
    const fixture = setup();

    const event = appendRuntime(fixture, 1);

    expect(
      fixture.database
        .prepare(
          `SELECT last_adapter_cursor, last_runtime_sequence
           FROM worker_executions WHERE id = ?`,
        )
        .get(fixture.execution.id),
    ).toEqual({
      last_adapter_cursor: 1,
      last_runtime_sequence: event.sequence,
    });
  });

  it('rejects a runtime event whose execution belongs to another project without writes', () => {
    const fixture = setup();
    const otherProject = insertV2TestProject(fixture.database, {
      id: randomUUID(),
      displayName: 'Other',
      repositoryIdentity: 'cross-project-identity',
    });

    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        fixture.events.appendRuntimeWithDiagnosticInTransaction(
          otherProject.id,
          {
            projectId: otherProject.id,
            executionId: fixture.execution.id,
            adapterId: 'fake',
            adapterCursor: 1,
            receivedAt: '2026-08-28T00:00:00.000Z',
            payload: { rejected: true },
          },
          {
            ...outputDraft(fixture, 1),
            projectId: otherProject.id,
          },
        ),
      ),
    ).toThrowError(/execution project/i);
    expect(fixture.events.cursors(otherProject.id)).toEqual({
      domain: 0,
      runtime: 0,
    });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM raw_diagnostics')
        .get(),
    ).toEqual({ count: 0 });
  });

  it('rejects a runtime diagnostic from another adapter without writes', () => {
    const fixture = setup();

    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        fixture.events.appendRuntimeWithDiagnosticInTransaction(
          fixture.project.id,
          {
            projectId: fixture.project.id,
            executionId: fixture.execution.id,
            adapterId: 'other-adapter',
            adapterCursor: 1,
            receivedAt: '2026-08-28T00:00:00.000Z',
            payload: { rejected: true },
          },
          outputDraft(fixture, 1),
        ),
      ),
    ).toThrowError(/execution adapter/i);
    expect(fixture.events.cursors(fixture.project.id)).toEqual({
      domain: 0,
      runtime: 0,
    });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM raw_diagnostics')
        .get(),
    ).toEqual({ count: 0 });
  });

  it('rolls back diagnostic, event, and sequence when execution cursor update fails', () => {
    const fixture = setup();
    fixture.database.exec(`
      CREATE TRIGGER fail_execution_cursor
      BEFORE UPDATE OF last_adapter_cursor ON worker_executions
      BEGIN
        SELECT RAISE(ABORT, 'cursor update failed');
      END
    `);

    expect(() => appendRuntime(fixture, 1)).toThrowError(
      /cursor update failed/,
    );
    expect(fixture.events.cursors(fixture.project.id)).toEqual({
      domain: 0,
      runtime: 0,
    });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM raw_diagnostics')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM runtime_events')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare(
          `SELECT last_adapter_cursor, last_runtime_sequence
           FROM worker_executions WHERE id = ?`,
        )
        .get(fixture.execution.id),
    ).toEqual({ last_adapter_cursor: 0, last_runtime_sequence: 0 });
  });

  it('allocates gap-free domain and runtime sequences independently per project', () => {
    const fixture = setup();
    const secondProject = insertV2TestProject(fixture.database, {
      id: randomUUID(),
      displayName: 'Other',
      repositoryIdentity: 'other-identity',
    });

    const firstDomain = inImmediateTransaction(fixture.database, () =>
      fixture.events.appendDomainInTransaction(
        fixture.project.id,
        registeredDraft(fixture.project),
      ),
    );
    const firstRuntime = appendRuntime(fixture, 1);
    const secondDomain = inImmediateTransaction(fixture.database, () =>
      fixture.events.appendDomainInTransaction(
        fixture.project.id,
        registeredDraft(fixture.project),
      ),
    );
    const otherDomain = inImmediateTransaction(fixture.database, () =>
      fixture.events.appendDomainInTransaction(
        secondProject.id,
        registeredDraft(secondProject),
      ),
    );

    expect([
      firstDomain.sequence,
      firstRuntime.sequence,
      secondDomain.sequence,
      otherDomain.sequence,
    ]).toEqual([1, 1, 2, 1]);
    expect(fixture.events.cursors(fixture.project.id)).toEqual({
      domain: 2,
      runtime: 1,
    });
    expect(fixture.events.cursors(secondProject.id)).toEqual({
      domain: 1,
      runtime: 0,
    });
  });

  it('returns retained windows with durable low and high water marks', () => {
    const fixture = setup();
    for (let index = 0; index < 3; index += 1) {
      inImmediateTransaction(fixture.database, () =>
        fixture.events.appendDomainInTransaction(
          fixture.project.id,
          registeredDraft(fixture.project),
        ),
      );
    }
    appendRuntime(fixture, 1);
    appendRuntime(fixture, 2);
    fixture.database
      .prepare(
        'DELETE FROM domain_events WHERE project_id = ? AND sequence = 1',
      )
      .run(fixture.project.id);

    expect(fixture.events.domainAfter(fixture.project.id, 1)).toMatchObject({
      lowWater: 2,
      highWater: 3,
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
    expect(fixture.events.runtimeAfter(fixture.project.id, 0)).toMatchObject({
      lowWater: 1,
      highWater: 2,
      events: [{ sequence: 1 }, { sequence: 2 }],
    });
    const empty = insertV2TestProject(fixture.database, {
      id: randomUUID(),
      displayName: 'Empty',
      repositoryIdentity: 'empty-identity',
    });
    expect(fixture.events.domainAfter(empty.id, 0)).toEqual({
      lowWater: 1,
      highWater: 0,
      events: [],
    });
  });

  it('rolls back the stream counter when raw diagnostic persistence fails', () => {
    const fixture = setup();
    fixture.database.exec(`
      CREATE TRIGGER fail_raw_diagnostic
      BEFORE INSERT ON raw_diagnostics
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic failed');
      END
    `);

    expect(() => appendRuntime(fixture, 1)).toThrowError(/diagnostic failed/);
    expect(fixture.events.cursors(fixture.project.id)).toEqual({
      domain: 0,
      runtime: 0,
    });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM raw_diagnostics')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM runtime_events')
        .get(),
    ).toEqual({ count: 0 });
  });

  it('rolls back the raw diagnostic and stream counter when runtime insertion fails', () => {
    const fixture = setup();
    fixture.database.exec(`
      CREATE TRIGGER fail_runtime_event
      BEFORE INSERT ON runtime_events
      BEGIN
        SELECT RAISE(ABORT, 'runtime failed');
      END
    `);

    expect(() => appendRuntime(fixture, 1)).toThrowError(/runtime failed/);
    expect(fixture.events.cursors(fixture.project.id)).toEqual({
      domain: 0,
      runtime: 0,
    });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM raw_diagnostics')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM runtime_events')
        .get(),
    ).toEqual({ count: 0 });
  });

  it('requires an active transaction for both event append operations', () => {
    const fixture = setup();

    expect(() =>
      fixture.events.appendDomainInTransaction(
        fixture.project.id,
        registeredDraft(fixture.project),
      ),
    ).toThrowError(/transaction/i);
    expect(() =>
      fixture.events.appendRuntimeWithDiagnosticInTransaction(
        fixture.project.id,
        {
          projectId: fixture.project.id,
          executionId: fixture.execution.id,
          adapterId: 'fake',
          adapterCursor: 1,
          receivedAt: '2026-08-28T00:00:00.000Z',
          payload: {},
        },
        outputDraft(fixture, 1),
      ),
    ).toThrowError(/transaction/i);
  });
});

describe('createV2TestDatabase', () => {
  it('closes the database and removes its verified directory when construction fails', () => {
    let openedDatabase: V2TestDatabase['database'] | undefined;
    let createdDirectory: string | undefined;

    expect(() =>
      createV2TestDatabase({
        afterOpen(database) {
          openedDatabase = database;
          createdDirectory = dirname(database.name);
          throw new Error('fixture construction failed');
        },
      }),
    ).toThrowError('fixture construction failed');

    expect(openedDatabase?.open).toBe(false);
    if (!createdDirectory) throw new Error('Fixture directory was not observed');
    expect(existsSync(createdDirectory)).toBe(false);
  });
});
