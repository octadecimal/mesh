import { mkdir } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { GitAdapter } from '../platform/git.js';
import {
  resolveWorkspacePath,
  type AbsolutePath,
  type ResolveWorkspacePathOptions,
} from '../platform/paths.js';

const reservedNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
// eslint-disable-next-line no-control-regex -- Portable folder names reject ASCII control characters.
const invalidNameCharacters = /[<>:"/\\|?*\u0000-\u001f]/;
const gitPathOverrides = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
]);

const isWithin = (candidate: string, root: string): boolean => {
  const relative = nodePath.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relative))
  );
};

export class RepositoryCreationError extends Error {
  constructor(
    message: string,
    readonly repositoryPath?: AbsolutePath,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RepositoryCreationError';
  }
}

const assertPortableFolderName = (name: string): void => {
  if (
    name === '.' ||
    name === '..' ||
    name.endsWith('.') ||
    name.endsWith(' ') ||
    invalidNameCharacters.test(name) ||
    reservedNames.test(name)
  ) {
    throw new RepositoryCreationError(
      'Project name must be one portable folder name',
    );
  }
};

export const createRepository = async ({
  parentDirectory,
  name,
  pathOptions,
  git,
  environment = process.env,
}: {
  parentDirectory: string;
  name: string;
  pathOptions: ResolveWorkspacePathOptions;
  git: Pick<GitAdapter, 'initializeRepository'>;
  environment?: NodeJS.ProcessEnv;
}): Promise<AbsolutePath> => {
  assertPortableFolderName(name);
  if (!nodePath.isAbsolute(parentDirectory)) {
    throw new RepositoryCreationError(
      'Project parent directory must be absolute',
    );
  }
  if (
    Object.entries(environment).some(
      ([key, value]) => gitPathOverrides.has(key.toUpperCase()) && value,
    )
  ) {
    throw new RepositoryCreationError(
      'Git repository path overrides must be unset before creating a project',
    );
  }

  let baseDirectory: AbsolutePath;
  let parentPath: AbsolutePath;
  let repositoryPath: AbsolutePath;
  try {
    [baseDirectory, parentPath] = await Promise.all([
      resolveWorkspacePath(pathOptions.baseDirectory, pathOptions),
      resolveWorkspacePath(parentDirectory, pathOptions),
    ]);
    repositoryPath = await resolveWorkspacePath(
      nodePath.join(parentPath, name),
      {
        ...pathOptions,
        allowMissingLeaf: true,
      },
    );
  } catch (error) {
    throw new RepositoryCreationError(
      `Project path could not be resolved: ${error instanceof Error ? error.message : 'unknown path error'}`,
      undefined,
      error,
    );
  }
  if (
    !isWithin(parentPath, baseDirectory) ||
    !isWithin(repositoryPath, baseDirectory) ||
    nodePath.dirname(repositoryPath) !== parentPath
  ) {
    throw new RepositoryCreationError(
      'Project path is outside the configured workspace boundary',
    );
  }

  try {
    await mkdir(repositoryPath);
  } catch (error) {
    throw new RepositoryCreationError(
      'Project folder already exists or could not be created',
      undefined,
      error,
    );
  }

  try {
    const revalidatedPath = await resolveWorkspacePath(
      repositoryPath,
      pathOptions,
    );
    if (
      revalidatedPath !== repositoryPath ||
      !isWithin(revalidatedPath, baseDirectory) ||
      nodePath.dirname(revalidatedPath) !== parentPath
    ) {
      throw new Error('Project path changed after folder creation');
    }
  } catch (error) {
    throw new RepositoryCreationError(
      `Project folder was created at ${repositoryPath}, but its workspace boundary changed. The folder was preserved for inspection.`,
      repositoryPath,
      error,
    );
  }

  try {
    await git.initializeRepository(repositoryPath);
  } catch (error) {
    throw new RepositoryCreationError(
      `Project folder was created at ${repositoryPath}, but Git initialization failed. The folder was preserved; fix or import it to recover.`,
      repositoryPath,
      error,
    );
  }
  return repositoryPath;
};
