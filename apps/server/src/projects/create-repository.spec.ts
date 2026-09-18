import { mkdtemp, mkdir, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GitAdapter } from '../platform/git.js';
import { createRepository } from './create-repository.js';

describe('createRepository', () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  const createRoot = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mesh-create-repository-'));
    cleanups.push(directory);
    return directory;
  };

  it('preserves the created folder when Git initialization fails', async () => {
    const directory = await createRoot();
    const repositoryPath = join(directory, 'new-project');
    const git = {
      initializeRepository: async () => {
        throw new Error('Git unavailable');
      },
    } satisfies Pick<GitAdapter, 'initializeRepository'>;

    await expect(
      createRepository({
        parentDirectory: directory,
        name: 'new-project',
        pathOptions: { baseDirectory: directory },
        git,
      }),
    ).rejects.toMatchObject({ repositoryPath });
    expect((await stat(repositoryPath)).isDirectory()).toBe(true);
  });

  it('rejects a parent junction that escapes the workspace before creating', async () => {
    const directory = await createRoot();
    const workspace = join(directory, 'workspace');
    const outside = join(directory, 'outside');
    const junction = join(workspace, 'escape');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await symlink(outside, junction, 'junction');
    const git = {
      initializeRepository: async () => ({ created: true as const }),
    } satisfies Pick<GitAdapter, 'initializeRepository'>;

    await expect(
      createRepository({
        parentDirectory: junction,
        name: 'new-project',
        pathOptions: { baseDirectory: workspace },
        git,
      }),
    ).rejects.toThrow('outside the configured workspace boundary');
    await expect(stat(join(outside, 'new-project'))).rejects.toThrow();
  });

  it('rejects relative parents before creating a folder', async () => {
    const directory = await createRoot();
    const git = {
      initializeRepository: async () => ({ created: true as const }),
    } satisfies Pick<GitAdapter, 'initializeRepository'>;

    await expect(
      createRepository({
        parentDirectory: '.',
        name: 'new-project',
        pathOptions: { baseDirectory: directory },
        git,
      }),
    ).rejects.toThrow('absolute');
    await expect(stat(join(directory, 'new-project'))).rejects.toThrow();
  });

  it('rejects inherited Git path overrides before creating a folder', async () => {
    const directory = await createRoot();
    const outside = join(directory, 'outside-git-dir');
    await mkdir(outside);
    const git = {
      initializeRepository: async () => {
        throw new Error('Git must not run with a repository path override');
      },
    } satisfies Pick<GitAdapter, 'initializeRepository'>;

    await expect(
      createRepository({
        parentDirectory: directory,
        name: 'new-project',
        pathOptions: { baseDirectory: directory },
        git,
        environment: { GIT_DIR: outside },
      }),
    ).rejects.toThrow('Git repository path overrides');
    await expect(stat(join(directory, 'new-project'))).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects an inherited Git object directory before creating a folder', async () => {
    const directory = await createRoot();
    const outside = join(directory, 'outside-object-directory');
    await mkdir(outside);
    const git = {
      initializeRepository: async () => {
        throw new Error('Git must not run with an object directory override');
      },
    } satisfies Pick<GitAdapter, 'initializeRepository'>;

    await expect(
      createRepository({
        parentDirectory: directory,
        name: 'new-project',
        pathOptions: { baseDirectory: directory },
        git,
        environment: { GIT_OBJECT_DIRECTORY: outside },
      }),
    ).rejects.toThrow('Git repository path overrides');
    await expect(stat(join(directory, 'new-project'))).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});
