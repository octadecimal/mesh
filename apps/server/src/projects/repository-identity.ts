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
  associatedWorktreePaths: readonly AbsolutePath[];
  headCommit: string | null;
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

const parseAssociatedWorktreePaths = async (
  output: string,
  pathOptions: ResolveWorkspacePathOptions,
): Promise<readonly AbsolutePath[]> => {
  if (output.length === 0 || !output.endsWith('\0\0')) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git returned incomplete associated-worktree topology',
    );
  }
  const records = output.slice(0, -2).split('\0\0');
  if (records.length === 0 || records.some((record) => record.length === 0)) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git returned malformed associated-worktree topology',
    );
  }

  const worktreePaths: AbsolutePath[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const fields = record.split('\0');
    const worktreeField = fields[0];
    const attributes = fields.slice(1);
    const headFields = attributes.filter((field) => field.startsWith('HEAD '));
    const branchFields = attributes.filter((field) =>
      field.startsWith('branch '),
    );
    const detachedFields = attributes.filter((field) => field === 'detached');
    const bareFields = attributes.filter((field) => field === 'bare');
    const auxiliaryFields = attributes.filter(
      (field) =>
        field === 'locked' ||
        field.startsWith('locked ') ||
        field === 'prunable' ||
        field.startsWith('prunable '),
    );
    const isBareRecord =
      bareFields.length === 1 &&
      headFields.length === 0 &&
      branchFields.length === 0 &&
      detachedFields.length === 0;
    const isWorkingTreeRecord =
      bareFields.length === 0 &&
      headFields.length === 1 &&
      /^[0-9a-f]+$/i.test(headFields[0].slice('HEAD '.length)) &&
      branchFields.length + detachedFields.length === 1;
    if (
      !worktreeField?.startsWith('worktree ') ||
      worktreeField.length === 'worktree '.length ||
      attributes.some((field) => field.startsWith('worktree ')) ||
      attributes.length !==
        headFields.length +
          branchFields.length +
          detachedFields.length +
          bareFields.length +
          auxiliaryFields.length ||
      (!isBareRecord && !isWorkingTreeRecord)
    ) {
      throw new RepositoryIdentityError(
        'repository_ambiguous',
        'Git returned malformed associated-worktree topology',
      );
    }
    const worktreePath = await resolveGitPath(
      worktreeField.slice('worktree '.length),
      pathOptions,
    );
    const comparisonPath = normalizeForComparison(worktreePath);
    if (seen.has(comparisonPath)) {
      throw new RepositoryIdentityError(
        'repository_ambiguous',
        'Git returned duplicate associated-worktree topology',
      );
    }
    seen.add(comparisonPath);
    worktreePaths.push(worktreePath);
  }
  return worktreePaths;
};

const parseHeadCommit = (exitCode: number, output: string): string | null => {
  if (exitCode !== 0) return null;
  const values = output.split(/\r?\n/).filter((value) => value.length > 0);
  if (values.length !== 1 || !/^[0-9a-f]+$/i.test(values[0])) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git returned an ambiguous HEAD commit',
    );
  }
  return values[0];
};

export const resolveRepositoryIdentity = async (
  repositoryPath: string,
  pathOptions: ResolveWorkspacePathOptions,
  processRunner: ProcessRunner = new NodeProcessRunner(),
): Promise<RepositoryIdentity> => {
  let canonicalPath: AbsolutePath;
  try {
    canonicalPath = await resolveWorkspacePath(repositoryPath, pathOptions);
  } catch (error) {
    throw new RepositoryIdentityError(
      'repository_invalid',
      `Repository path could not be resolved: ${
        error instanceof Error ? error.message : 'unknown path error'
      }`,
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
    normalizeForComparison(topLevel) !== normalizeForComparison(canonicalPath)
  ) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Repository identity does not resolve to the selected working tree',
    );
  }

  const [worktreeResult, headResult] = await Promise.all([
    processRunner.run(
      'git',
      [
        '-c',
        'credential.interactive=false',
        '-C',
        canonicalPath,
        'worktree',
        'list',
        '--porcelain',
        '-z',
      ],
      { cwd: canonicalPath },
    ),
    processRunner.run(
      'git',
      [
        '-c',
        'credential.interactive=false',
        '-C',
        canonicalPath,
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ],
      { cwd: canonicalPath },
    ),
  ]);
  if (worktreeResult.exitCode !== 0) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git could not enumerate associated worktrees',
    );
  }
  let associatedWorktreePaths: readonly AbsolutePath[];
  try {
    associatedWorktreePaths = await parseAssociatedWorktreePaths(
      worktreeResult.stdout,
      pathOptions,
    );
  } catch (error) {
    if (error instanceof RepositoryIdentityError) throw error;
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git returned an unreadable associated-worktree topology',
    );
  }
  if (
    !associatedWorktreePaths.some(
      (worktreePath) =>
        normalizeForComparison(worktreePath) ===
        normalizeForComparison(canonicalPath),
    )
  ) {
    throw new RepositoryIdentityError(
      'repository_ambiguous',
      'Git associated-worktree topology does not contain the imported working tree',
    );
  }

  return {
    canonicalPath,
    commonDirectory,
    repositoryIdentity: normalizeForComparison(commonDirectory),
    associatedWorktreePaths,
    headCommit: parseHeadCommit(headResult.exitCode, headResult.stdout),
  };
};
