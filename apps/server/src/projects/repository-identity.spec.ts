import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  NodeProcessRunner,
  resolveGitExecutableAtStartup,
  type ProcessRunner,
} from '../platform/process-runner.js';
import { resolveRepositoryIdentity } from './repository-identity.js';

const exec = promisify(execFile);

const runGit = async (cwd: string, ...args: string[]) => {
  await exec('git', args, { cwd, windowsHide: true });
};

describe('resolveRepositoryIdentity', () => {
  const temporaryDirectories: string[] = [];
  let processRunner: NodeProcessRunner;

  beforeAll(async () => {
    const trustedGitExecutable = await resolveGitExecutableAtStartup({
      pathValue: process.env.PATH,
      workspaceRoot: tmpdir(),
    });
    if (!trustedGitExecutable) {
      throw new Error('Expected an approved test Git executable');
    }
    processRunner = new NodeProcessRunner({ trustedGitExecutable });
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  const createRepository = async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mesh-repository-identity-'),
    );
    temporaryDirectories.push(directory);
    const repositoryPath = join(directory, 'repository');
    await runGit(directory, 'init', repositoryPath);
    await writeFile(join(repositoryPath, 'README.md'), 'repository\n');
    await runGit(repositoryPath, 'add', 'README.md');
    await runGit(
      repositoryPath,
      '-c',
      'user.name=Mesh Test',
      '-c',
      'user.email=mesh@example.test',
      'commit',
      '-m',
      'initial',
    );
    return { directory, repositoryPath };
  };

  it('resolves equivalent repository path spellings to one identity', async () => {
    const { directory, repositoryPath } = await createRepository();
    const first = await resolveRepositoryIdentity(
      repositoryPath,
      {
        baseDirectory: directory,
      },
      processRunner,
    );
    const second = await resolveRepositoryIdentity(
      join(repositoryPath, '..', basename(repositoryPath)),
      { baseDirectory: directory },
      processRunner,
    );

    expect(first).toMatchObject({
      canonicalPath: await realpath(repositoryPath),
      commonDirectory: expect.any(String),
    });
    expect(second.repositoryIdentity).toBe(first.repositoryIdentity);
  });

  it('uses one stable identity for a linked worktree', async () => {
    const { directory, repositoryPath } = await createRepository();
    const worktreePath = join(directory, 'linked-worktree');
    await runGit(
      repositoryPath,
      'worktree',
      'add',
      '--detach',
      worktreePath,
      'HEAD',
    );

    const repository = await resolveRepositoryIdentity(
      repositoryPath,
      {
        baseDirectory: directory,
      },
      processRunner,
    );
    const worktree = await resolveRepositoryIdentity(
      worktreePath,
      {
        baseDirectory: directory,
      },
      processRunner,
    );

    expect(worktree.canonicalPath).toBe(await realpath(worktreePath));
    expect(worktree.commonDirectory).toBe(repository.commonDirectory);
    expect(worktree.repositoryIdentity).toBe(repository.repositoryIdentity);
    expect(worktree.associatedWorktreePaths).toHaveLength(2);
    expect(worktree.associatedWorktreePaths).toEqual(
      expect.arrayContaining([
        await realpath(repositoryPath),
        await realpath(worktreePath),
      ]),
    );
  });

  it('reports the commit resolved by HEAD', async () => {
    const { directory, repositoryPath } = await createRepository();
    const { stdout } = await exec('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repositoryPath,
      windowsHide: true,
    });

    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      processRunner,
    );

    expect(identity.headCommit).toBe(stdout.trim());
  });

  it('reports a null HEAD for an unborn repository', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mesh-repository-identity-unborn-'),
    );
    temporaryDirectories.push(directory);
    const repositoryPath = join(directory, 'repository');
    await runGit(directory, 'init', repositoryPath);

    const identity = await resolveRepositoryIdentity(
      repositoryPath,
      { baseDirectory: directory },
      processRunner,
    );

    expect(identity.headCommit).toBeNull();
  });

  it('rejects malformed associated-worktree topology', async () => {
    const { directory, repositoryPath } = await createRepository();
    const malformedRunner: ProcessRunner = {
      run: async (executable, args, options) =>
        args.includes('worktree')
          ? {
              exitCode: 0,
              stdout: 'HEAD 0000000000000000000000000000000000000000\0\0',
              stderr: '',
            }
          : processRunner.run(executable, args, options),
    };

    await expect(
      resolveRepositoryIdentity(
        repositoryPath,
        { baseDirectory: directory },
        malformedRunner,
      ),
    ).rejects.toMatchObject({ code: 'repository_ambiguous' });
  });

  it('rejects incomplete associated-worktree records', async () => {
    const { directory, repositoryPath } = await createRepository();
    const canonicalPath = await realpath(repositoryPath);
    const incompleteRunner: ProcessRunner = {
      run: async (executable, args, options) =>
        args.includes('worktree')
          ? {
              exitCode: 0,
              stdout: `worktree ${canonicalPath}\0\0`,
              stderr: '',
            }
          : processRunner.run(executable, args, options),
    };

    await expect(
      resolveRepositoryIdentity(
        repositoryPath,
        { baseDirectory: directory },
        incompleteRunner,
      ),
    ).rejects.toMatchObject({ code: 'repository_ambiguous' });
  });

  it('rejects a failed associated-worktree enumeration', async () => {
    const { directory, repositoryPath } = await createRepository();
    const canonicalPath = await realpath(repositoryPath);
    const failedRunner: ProcessRunner = {
      run: async (executable, args, options) =>
        args.includes('worktree')
          ? {
              exitCode: 128,
              stdout: `worktree ${canonicalPath}\0HEAD 0000000000000000000000000000000000000000\0detached\0\0`,
              stderr: 'fatal: worktree list failed',
            }
          : processRunner.run(executable, args, options),
    };

    await expect(
      resolveRepositoryIdentity(
        repositoryPath,
        { baseDirectory: directory },
        failedRunner,
      ),
    ).rejects.toMatchObject({ code: 'repository_ambiguous' });
  });

  it('rejects an associated worktree path that cannot be canonicalized', async () => {
    const { directory, repositoryPath } = await createRepository();
    const canonicalPath = await realpath(repositoryPath);
    const unreadableRunner: ProcessRunner = {
      run: async (executable, args, options) =>
        args.includes('worktree')
          ? {
              exitCode: 0,
              stdout: [
                `worktree ${canonicalPath}\0HEAD 0000000000000000000000000000000000000000\0detached\0\0`,
                `worktree ${join(directory, 'missing-worktree')}\0HEAD 0000000000000000000000000000000000000000\0detached\0\0`,
              ].join(''),
              stderr: '',
            }
          : processRunner.run(executable, args, options),
    };

    await expect(
      resolveRepositoryIdentity(
        repositoryPath,
        { baseDirectory: directory },
        unreadableRunner,
      ),
    ).rejects.toMatchObject({ code: 'repository_ambiguous' });
  });

  it('rejects a directory that is not a Git repository', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mesh-repository-identity-'),
    );
    temporaryDirectories.push(directory);

    await expect(
      resolveRepositoryIdentity(
        directory,
        { baseDirectory: directory },
        processRunner,
      ),
    ).rejects.toMatchObject({ code: 'repository_invalid' });
  });

  it('rejects a repository outside the configured workspace boundary', async () => {
    const { repositoryPath } = await createRepository();
    const allowedDirectory = await mkdtemp(
      join(tmpdir(), 'mesh-allowed-base-'),
    );
    temporaryDirectories.push(allowedDirectory);

    await expect(
      resolveRepositoryIdentity(
        repositoryPath,
        {
          baseDirectory: allowedDirectory,
        },
        processRunner,
      ),
    ).rejects.toMatchObject({ code: 'repository_invalid' });
  });
});
