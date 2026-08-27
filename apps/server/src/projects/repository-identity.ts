import * as nodePath from 'node:path';

import {
  resolveWorkspacePath,
  type AbsolutePath,
  type ResolveWorkspacePathOptions,
} from '../platform/paths.js';
import {
  NodeProcessRunner,
  type ProcessRunner,
} from '../platform/process-runner.js';

export interface RepositoryIdentity {
  canonicalPath: AbsolutePath;
  commonDirectory: AbsolutePath;
  repositoryIdentity: string;
}

export type RepositoryIdentityResolver = (
  repositoryPath: string,
  pathOptions: ResolveWorkspacePathOptions,
) => Promise<RepositoryIdentity>;

export class RepositoryIdentityError extends Error {
  constructor(
    readonly code: 'repository_invalid' | 'repository_ambiguous',
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryIdentityError';
  }
}

const normalizeForComparison = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  const withoutTrailingSeparator = normalized.replace(/\/+$/, '');
  const comparison = withoutTrailingSeparator || '/';
  return process.platform === 'win32' ? comparison.toLowerCase() : comparison;
};

const isWithin = (candidate: string, baseDirectory: string): boolean => {
  const candidatePath = normalizeForComparison(candidate);
  const basePath = normalizeForComparison(baseDirectory);
  return candidatePath === basePath || candidatePath.startsWith(`${basePath}/`);
};

const resolveGitPath = async (
  value: string,
  pathOptions: ResolveWorkspacePathOptions,
): Promise<AbsolutePath> => {
  const path = pathOptions.path ?? nodePath;
  if (!path.isAbsolute(value)) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git did not return an absolute repository path',
    );
  }
  return resolveWorkspacePath(value, pathOptions);
};

export const resolveRepositoryIdentity = async (
  repositoryPath: string,
  pathOptions: ResolveWorkspacePathOptions,
  processRunner: ProcessRunner = new NodeProcessRunner(),
): Promise<RepositoryIdentity> => {
  let canonicalPath: AbsolutePath;
  let canonicalBaseDirectory: AbsolutePath;
  try {
    [canonicalPath, canonicalBaseDirectory] = await Promise.all([
      resolveWorkspacePath(repositoryPath, pathOptions),
      resolveWorkspacePath(pathOptions.baseDirectory, pathOptions),
    ]);
  } catch (error) {
    throw new RepositoryIdentityError(
      'repository_invalid',
      `Repository path could not be resolved: ${
        error instanceof Error ? error.message : 'unknown path error'
      }`,
    );
  }
  if (!isWithin(canonicalPath, canonicalBaseDirectory)) {
    throw new RepositoryIdentityError(
      'repository_invalid',
      'Repository path is outside the configured workspace boundary',
    );
  }

  const result = await processRunner.run(
    'git',
    [
      '-c',
      'credential.interactive=false',
      '-C',
      canonicalPath,
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ],
    { cwd: canonicalPath },
  );
  if (result.exitCode !== 0) {
    throw new RepositoryIdentityError(
      'repository_invalid',
      'Repository path is not a readable Git working tree',
    );
  }

  const output = result.stdout
    .split(/\r?\n/)
    .filter((value) => value.length > 0);
  if (output.length !== 2) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git returned an ambiguous repository identity',
    );
  }

  let topLevel: AbsolutePath;
  let commonDirectory: AbsolutePath;
  try {
    [topLevel, commonDirectory] = await Promise.all([
      resolveGitPath(output[0], pathOptions),
      resolveGitPath(output[1], pathOptions),
    ]);
  } catch (error) {
    if (error instanceof RepositoryIdentityError) throw error;
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git returned an unreadable repository identity',
    );
  }

  if (
    normalizeForComparison(topLevel) !==
      normalizeForComparison(canonicalPath) ||
    !isWithin(topLevel, canonicalBaseDirectory) ||
    !isWithin(commonDirectory, canonicalBaseDirectory)
  ) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Repository identity does not resolve to one workspace-safe working tree',
    );
  }

  return {
    canonicalPath,
    commonDirectory,
    repositoryIdentity: normalizeForComparison(commonDirectory),
  };
};
