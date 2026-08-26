import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRepositoryIdentity } from './repository-identity.js';

const exec = promisify(execFile);

const runGit = async (cwd: string, ...args: string[]) => {
  await exec('git', args, { cwd, windowsHide: true });
};

describe('resolveRepositoryIdentity', () => {
  const temporaryDirectories: string[] = [];

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
    const first = await resolveRepositoryIdentity(repositoryPath, {
      baseDirectory: directory,
    });
    const second = await resolveRepositoryIdentity(
      join(repositoryPath, '..', basename(repositoryPath)),
      { baseDirectory: directory },
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

    const repository = await resolveRepositoryIdentity(repositoryPath, {
      baseDirectory: directory,
    });
    const worktree = await resolveRepositoryIdentity(worktreePath, {
      baseDirectory: directory,
    });

    expect(worktree.canonicalPath).toBe(await realpath(worktreePath));
    expect(worktree.commonDirectory).toBe(repository.commonDirectory);
    expect(worktree.repositoryIdentity).toBe(repository.repositoryIdentity);
  });

  it('rejects a directory that is not a Git repository', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mesh-repository-identity-'),
    );
    temporaryDirectories.push(directory);

    await expect(
      resolveRepositoryIdentity(directory, { baseDirectory: directory }),
    ).rejects.toMatchObject({ code: 'repository_invalid' });
  });

  it('rejects a repository outside the configured workspace boundary', async () => {
    const { repositoryPath } = await createRepository();
    const allowedDirectory = await mkdtemp(
      join(tmpdir(), 'mesh-allowed-base-'),
    );
    temporaryDirectories.push(allowedDirectory);

    await expect(
      resolveRepositoryIdentity(repositoryPath, {
        baseDirectory: allowedDirectory,
      }),
    ).rejects.toMatchObject({ code: 'repository_invalid' });
  });
});
