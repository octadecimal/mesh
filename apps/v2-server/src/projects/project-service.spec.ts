import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import type {
  DomainEvent,
  ProjectRegisterEnvelope,
  V2CommandResult,
} from '@mesh/v2-contracts';
import { projectSchema } from '@mesh/v2-contracts';

import { inImmediateTransaction, openV2Database } from '../db/database.js';
import { V2CommandRepository } from '../storage/command-repository.js';
import { V2EventStore } from '../storage/event-store.js';
import {
  createRepositoryIdentityResolver,
  type ResolveRepositoryIdentity,
} from './repository-identity.js';
import { ProjectRepository } from './project-repository.js';
import { ProjectService } from './project-service.js';

const git = (args: readonly string[], cwd?: string): string =>
  execFileSync(
    'git',
    [
      '-c',
      'credential.interactive=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim();

const removeVerifiedDirectory = (directory: string): void => {
  const resolved = resolve(directory);
  const relativeToTemp = relative(resolve(tmpdir()), resolved);
  if (
    relativeToTemp.startsWith('..') ||
    relativeToTemp === '' ||
    !basename(resolved).startsWith('mesh-v2-project-service-test-')
  ) {
    throw new Error('Refusing to remove an unverified service test directory');
  }
  rmSync(resolved, { recursive: true, force: true });
};

const createRepository = (parent: string, name: string): string => {
  const repository = join(parent, name);
  git(['init', '--quiet', repository]);
  writeFileSync(join(repository, 'README.md'), '# Todo\n');
  git(['add', 'README.md'], repository);
  git(
    [
      '-c',
      'user.name=Mesh Tests',
      '-c',
      'user.email=mesh-tests@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'initial',
    ],
    repository,
  );
  return repository;
};

const registerCommand = (
  repositoryPath: string,
  idempotencyKey: string,
  displayName?: string,
): ProjectRegisterEnvelope => ({
  idempotencyKey,
  actor: { kind: 'human' },
  command: {
    type: 'project.register',
    repositoryPath,
    ...(displayName ? { displayName } : {}),
  },
});

describe('ProjectService', () => {
  let directory: string;
  let database: ReturnType<typeof openV2Database>;
  let projects: ProjectRepository;
  let events: V2EventStore;
  let commands: V2CommandRepository;
  let published: DomainEvent[];
  let resolveIdentity: ResolveRepositoryIdentity;
  let service: ProjectService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mesh-v2-project-service-test-'));
    database = openV2Database(join(directory, 'mesh-v2.sqlite'));
    projects = new ProjectRepository(database);
    events = new V2EventStore(database);
    commands = new V2CommandRepository(database);
    published = [];
    resolveIdentity = createRepositoryIdentityResolver({
      workspaceRoot: directory,
    });
    service = new ProjectService({
      database,
      projects,
      commands,
      events,
      resolveRepositoryIdentity: (path) => resolveIdentity(path),
      now: () => '2026-08-28T12:00:00.000Z',
      projectId: () => '8dd9c686-df63-49e3-85eb-cd5250ba40de',
      publish: (event) => {
        expect(database.inTransaction).toBe(false);
        expect(projects.get(event.projectId)).toBeDefined();
        published.push(event);
      },
    });
  });

  afterEach(() => {
    if (database.open) database.close();
    removeVerifiedDirectory(directory);
  });

  it('registers revision one with one command result and ordered domain event before publishing', async () => {
    const repository = createRepository(directory, 'todo');

    const result = await service.register(
      registerCommand(repository, 'register-todo', 'Todo application'),
    );

    expect(result).toMatchObject({
      ok: true,
      commandType: 'project.register',
      project: {
        displayName: 'Todo application',
        repositoryPath: resolve(repository),
        revision: 1,
      },
    });
    expect(projects.list()).toEqual([
      (
        result as Extract<
          V2CommandResult,
          { ok: true; commandType: 'project.register' }
        >
      ).project,
    ]);
    expect(commands.find('register-todo')?.result).toEqual(result);
    expect(
      events.domainAfter(
        (
          result as Extract<
            V2CommandResult,
            { ok: true; commandType: 'project.register' }
          >
        ).project.id,
        0,
      ),
    ).toMatchObject({
      lowWater: 1,
      highWater: 1,
      events: [
        {
          sequence: 1,
          type: 'project.registered',
          payload: {
            project: (
              result as Extract<
                V2CommandResult,
                { ok: true; commandType: 'project.register' }
              >
            ).project,
          },
        },
      ],
    });
    expect(published).toEqual(
      events.domainAfter(
        (
          result as Extract<
            V2CommandResult,
            { ok: true; commandType: 'project.register' }
          >
        ).project.id,
        0,
      ).events,
    );
  });

  it('registers a committed in-root repository whose basename begins with two dots', async () => {
    const repository = createRepository(directory, '..repo');

    const result = await service.register(
      registerCommand(repository, 'register-dot-prefixed'),
    );

    expect(result).toMatchObject({
      ok: true,
      commandType: 'project.register',
      project: {
        displayName: '..repo',
        repositoryPath: resolve(repository),
        revision: 1,
      },
    });
    expect(projects.list()).toHaveLength(1);
    expect(commands.find('register-dot-prefixed')?.result).toEqual(result);
  });

  it('replays an idempotent command without resolving Git or writing again', async () => {
    const repository = createRepository(directory, 'todo');
    const first = await service.register(
      registerCommand(repository, 'register-todo'),
    );
    const calls: string[] = [];
    const replayService = new ProjectService({
      database,
      projects,
      commands,
      events,
      resolveRepositoryIdentity: async (path) => {
        calls.push(path);
        return resolveIdentity(path);
      },
    });

    const replay = await replayService.register(
      registerCommand(repository, 'register-todo'),
    );

    expect(replay).toEqual(first);
    expect(calls).toEqual([]);
    expect(projects.list()).toHaveLength(1);
    expect(
      events.domainAfter(
        (
          first as Extract<
            V2CommandResult,
            { ok: true; commandType: 'project.register' }
          >
        ).project.id,
        0,
      ).events,
    ).toHaveLength(1);
  });

  it('stores a second command result without duplicating the project or event for the same identity and path', async () => {
    const repository = createRepository(directory, 'todo');
    const first = await service.register(
      registerCommand(repository, 'register-todo-1'),
    );
    const second = await service.register(
      registerCommand(repository, 'register-todo-2'),
    );

    expect(second).toEqual(first);
    expect(commands.find('register-todo-2')?.result).toEqual(first);
    expect(projects.list()).toHaveLength(1);
    expect(
      events.domainAfter(
        (
          first as Extract<
            V2CommandResult,
            { ok: true; commandType: 'project.register' }
          >
        ).project.id,
        0,
      ).events,
    ).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it('rejects a conflicting request hash without resolving Git or writing', async () => {
    const repository = createRepository(directory, 'todo');
    const first = await service.register(
      registerCommand(repository, 'register-todo', 'Todo'),
    );
    const before = {
      projectCount: projects.list().length,
      commandCount: database
        .prepare('SELECT COUNT(*) AS count FROM command_results')
        .get(),
      eventCount: events.domainAfter(
        (
          first as Extract<
            V2CommandResult,
            { ok: true; commandType: 'project.register' }
          >
        ).project.id,
        0,
      ).events.length,
    };
    const calls: string[] = [];
    const conflictingService = new ProjectService({
      database,
      projects,
      commands,
      events,
      resolveRepositoryIdentity: async (path) => {
        calls.push(path);
        return resolveIdentity(path);
      },
    });

    await expect(
      conflictingService.register(
        registerCommand(repository, 'register-todo', 'Different'),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict' },
    });
    expect(calls).toEqual([]);
    expect(projects.list()).toHaveLength(before.projectCount);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM command_results').get(),
    ).toEqual(before.commandCount);
    expect(
      events.domainAfter(
        (
          first as Extract<
            V2CommandResult,
            { ok: true; commandType: 'project.register' }
          >
        ).project.id,
        0,
      ).events,
    ).toHaveLength(before.eventCount);
  });

  it('does not silently rebind an existing repository identity', async () => {
    const source = createRepository(directory, 'source');
    const linked = join(directory, 'linked');
    git(
      ['worktree', 'add', '--quiet', '-b', 'service-linked', linked, 'HEAD'],
      source,
    );
    const first = await service.register(registerCommand(source, 'source'));

    await expect(
      service.register(registerCommand(linked, 'linked')),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'repository_identity_conflict' },
    });
    const project = (
      first as Extract<
        V2CommandResult,
        { ok: true; commandType: 'project.register' }
      >
    ).project;
    expect(projects.get(project.id)?.repositoryPath).toBe(resolve(source));
    expect(projects.list()).toHaveLength(1);
    expect(commands.find('linked')).toBeUndefined();
    expect(events.domainAfter(project.id, 0).events).toHaveLength(1);
  });

  it('rejects a path already claimed by a different repository identity without writes', async () => {
    const repository = createRepository(directory, 'claimed');
    const project = projectSchema.parse({
      id: '39b68399-5a49-438b-a20f-49cfc5508ac8',
      displayName: 'Previously claimed',
      repositoryIdentity: 'different-identity',
      repositoryPath: resolve(repository),
      gitCommonDirectory: join(repository, '.git'),
      headCommit: git(['rev-parse', 'HEAD'], repository),
      revision: 1,
      createdAt: '2026-08-28T11:00:00.000Z',
      updatedAt: '2026-08-28T11:00:00.000Z',
    });
    inImmediateTransaction(database, () =>
      projects.insertInTransaction(project),
    );

    await expect(
      service.register(registerCommand(repository, 'different-identity')),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'repository_identity_conflict' },
    });
    expect(commands.find('different-identity')).toBeUndefined();
    expect(projects.list()).toEqual([project]);
  });

  it('writes nothing when repository identity resolution fails', async () => {
    const plainDirectory = join(directory, 'plain');
    writeFileSync(plainDirectory, 'not a repository');

    await expect(
      service.register(registerCommand(plainDirectory, 'invalid')),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'repository_invalid' },
    });
    expect(projects.list()).toEqual([]);
    expect(commands.find('invalid')).toBeUndefined();
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM domain_events').get(),
    ).toEqual({ count: 0 });
  });

  it('rolls back project, event, and command together and never publishes when registration fails', async () => {
    const repository = createRepository(directory, 'todo');
    database.exec(`
      CREATE TRIGGER fail_project_event
      BEFORE INSERT ON domain_events
      BEGIN
        SELECT RAISE(FAIL, 'project event write failed');
      END;
    `);

    await expect(
      service.register(registerCommand(repository, 'register-todo')),
    ).rejects.toThrow('project event write failed');
    expect(projects.list()).toEqual([]);
    expect(commands.find('register-todo')).toBeUndefined();
    expect(published).toEqual([]);
  });

  it('rolls back the project and already-appended event when command-result storage fails', async () => {
    const repository = createRepository(directory, 'todo');
    database.exec(`
      CREATE TRIGGER fail_project_command
      BEFORE INSERT ON command_results
      BEGIN
        SELECT RAISE(FAIL, 'project command write failed');
      END;
    `);

    await expect(
      service.register(registerCommand(repository, 'register-todo')),
    ).rejects.toThrow('project command write failed');
    expect(projects.list()).toEqual([]);
    expect(commands.find('register-todo')).toBeUndefined();
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM domain_events').get(),
    ).toEqual({ count: 0 });
    expect(published).toEqual([]);
  });
});
