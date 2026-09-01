import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { DeveloperAttemptId, ManagedWorkspace } from '@mesh/v2-contracts';

import type {
  GitProcessResult,
  GitProcessRunner,
  ResolveRepositoryIdentity,
} from '../projects/repository-identity.js';
import { normalizeRepositoryIdentityPath } from '../projects/repository-identity.js';

const ownershipSchema = 'mesh.v2/developer-workspace-owner/v1' as const;
const timeoutMs = 10_000;

type PathApi = typeof import('node:path');

export type ManagedWorkspaceDependencies = {
  managedRoot: string;
  gitExecutable: string;
  processRunner: GitProcessRunner;
  resolveRepositoryIdentity: ResolveRepositoryIdentity;
  assertCreateReserved(attemptId: DeveloperAttemptId): void;
  platform?: NodeJS.Platform;
};

export type DeriveManagedWorkspaceInput = {
  managedRoot: string;
  projectId: string;
  taskId: string;
  attemptId: DeveloperAttemptId;
  repositoryPath: string;
  repositoryIdentity: string;
  baseCommit: string;
  createdAt: string;
  ownershipToken?: string;
  platform?: NodeJS.Platform;
};

const pathApi = (platform: NodeJS.Platform): PathApi =>
  platform === 'win32' ? win32 : awaitPath;
const awaitPath = { isAbsolute, relative, resolve } as PathApi;

const pathKey = (path: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? path.replace(/\//gu, '\\').toLowerCase() : path;

const isContained = (
  parent: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean => {
  const paths = pathApi(platform);
  const fromParent = paths.relative(parent, candidate);
  return (
    fromParent !== '' &&
    !fromParent.startsWith('..') &&
    !paths.isAbsolute(fromParent)
  );
};

const attention = (
  workspace: ManagedWorkspace,
  code: string,
  message: string,
  observed: Pick<ManagedWorkspace, 'observedHead' | 'observedDirty'> = {
    observedHead: null,
    observedDirty: null,
  },
): ManagedWorkspace => ({
  ...workspace,
  lifecycle: 'attention_required',
  ...observed,
  failure: { code, message },
});

const completed = (
  result: GitProcessResult,
): result is Extract<GitProcessResult, { outcome: 'completed' }> =>
  result.outcome === 'completed';

const resultError = (result: GitProcessResult): string =>
  completed(result)
    ? result.stderr.trim() ||
      result.stdout.trim() ||
      `Git exited ${result.exitCode}`
    : result.message;

const singleLine = (stdout: string): string | undefined => {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  return lines.length === 1 ? lines[0] : undefined;
};

const git = async (
  workspace: ManagedWorkspace,
  dependencies: ManagedWorkspaceDependencies,
  cwd: string,
  args: readonly string[],
): Promise<GitProcessResult> =>
  dependencies.processRunner.run({
    executable: dependencies.gitExecutable,
    args: ['-c', 'credential.interactive=false', '-C', cwd, ...args],
    cwd,
    timeoutMs,
  });

const derivedPath = (
  managedRoot: string,
  projectId: string,
  taskId: string,
  attemptId: string,
  platform: NodeJS.Platform,
): string =>
  pathApi(platform).resolve(managedRoot, projectId, taskId, attemptId);

const ownershipPath = (gitDirectory: string, workspacePath: string): string =>
  isAbsolute(gitDirectory)
    ? resolve(gitDirectory)
    : resolve(workspacePath, gitDirectory);

export const deriveManagedWorkspace = ({
  managedRoot,
  projectId,
  taskId,
  attemptId,
  repositoryPath,
  repositoryIdentity,
  baseCommit,
  createdAt,
  ownershipToken = randomUUID(),
  platform = process.platform,
}: DeriveManagedWorkspaceInput): ManagedWorkspace => ({
  attemptId,
  repositoryPath,
  repositoryIdentity,
  branch: `mesh/dev/${projectId}/${taskId}/${attemptId}`,
  path: derivedPath(managedRoot, projectId, taskId, attemptId, platform),
  baseCommit,
  lifecycle: 'creating',
  ownershipToken,
  observedHead: null,
  observedDirty: null,
  failure: null,
  revision: 0,
  createdAt,
  updatedAt: createdAt,
});

export const createManagedWorkspace = async (
  workspace: ManagedWorkspace,
  dependencies: ManagedWorkspaceDependencies,
): Promise<ManagedWorkspace> => {
  const platform = dependencies.platform ?? process.platform;
  const paths = pathApi(platform);
  const managedRoot = paths.resolve(dependencies.managedRoot);
  const workspacePath = paths.resolve(workspace.path);
  if (workspace.lifecycle !== 'creating') {
    return attention(
      workspace,
      'workspace_not_creating',
      'Workspace is not creating',
    );
  }
  if (!isContained(managedRoot, workspacePath, platform)) {
    return attention(
      workspace,
      'workspace_path_escape',
      'Workspace path escapes the managed root',
    );
  }
  let repository;
  try {
    repository = await dependencies.resolveRepositoryIdentity(
      workspace.repositoryPath,
    );
  } catch (error) {
    return attention(
      workspace,
      'workspace_repository_unreadable',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    pathKey(repository.repositoryIdentity, platform) !==
    pathKey(
      normalizeRepositoryIdentityPath(workspace.repositoryIdentity, platform),
      platform,
    )
  ) {
    return attention(
      workspace,
      'workspace_repository_identity_mismatch',
      'Workspace repository identity does not match the reservation',
    );
  }
  try {
    await mkdir(managedRoot, { recursive: true });
    await realpath(managedRoot);
  } catch (error) {
    return attention(
      workspace,
      'workspace_root_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
  dependencies.assertCreateReserved(workspace.attemptId);
  const creation = await git(
    workspace,
    dependencies,
    repository.canonicalPath,
    [
      'worktree',
      'add',
      '-b',
      workspace.branch,
      workspacePath,
      workspace.baseCommit,
    ],
  );
  if (!completed(creation) || creation.exitCode !== 0) {
    return attention(
      workspace,
      'workspace_create_failed',
      resultError(creation),
    );
  }
  const gitDirectory = await git(workspace, dependencies, workspacePath, [
    'rev-parse',
    '--git-dir',
  ]);
  const directory =
    completed(gitDirectory) && gitDirectory.exitCode === 0
      ? singleLine(gitDirectory.stdout)
      : undefined;
  if (!directory) {
    return attention(
      workspace,
      'workspace_ownership_directory_failed',
      gitDirectory
        ? resultError(gitDirectory)
        : 'Git did not return an ownership directory',
    );
  }
  try {
    await writeFile(
      resolve(ownershipPath(directory, workspacePath), 'mesh-owner.json'),
      `${JSON.stringify({
        schema: ownershipSchema,
        attemptId: workspace.attemptId,
        ownershipToken: workspace.ownershipToken,
        repositoryIdentity: workspace.repositoryIdentity,
        branch: workspace.branch,
        baseCommit: workspace.baseCommit,
      })}\n`,
      'utf8',
    );
  } catch (error) {
    return attention(
      workspace,
      'workspace_ownership_write_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  return observeManagedWorkspace(workspace, dependencies, {
    requireClean: true,
  });
};

export const observeManagedWorkspace = async (
  workspace: ManagedWorkspace,
  dependencies: ManagedWorkspaceDependencies,
  options: { requireClean: boolean },
): Promise<ManagedWorkspace> => {
  const platform = dependencies.platform ?? process.platform;
  const paths = pathApi(platform);
  const managedRoot = paths.resolve(dependencies.managedRoot);
  const workspacePath = paths.resolve(workspace.path);
  if (!isContained(managedRoot, workspacePath, platform)) {
    return attention(
      workspace,
      'workspace_path_escape',
      'Workspace path escapes the managed root',
    );
  }
  let identity;
  try {
    identity = await dependencies.resolveRepositoryIdentity(workspacePath);
  } catch (error) {
    return attention(
      workspace,
      'workspace_identity_unreadable',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    pathKey(identity.repositoryIdentity, platform) !==
    pathKey(
      normalizeRepositoryIdentityPath(workspace.repositoryIdentity, platform),
      platform,
    )
  ) {
    return attention(
      workspace,
      'workspace_repository_identity_mismatch',
      'Workspace repository identity does not match the reservation',
    );
  }
  const registered = await git(
    workspace,
    dependencies,
    identity.canonicalPath,
    ['worktree', 'list', '--porcelain'],
  );
  if (
    !completed(registered) ||
    registered.exitCode !== 0 ||
    !registered.stdout
      .split(/\r?\n/u)
      .some(
        (line) =>
          line.startsWith('worktree ') &&
          pathKey(line.slice(9), platform) === pathKey(workspacePath, platform),
      )
  ) {
    return attention(
      workspace,
      'workspace_not_registered',
      completed(registered)
        ? 'Workspace is not registered by Git'
        : resultError(registered),
    );
  }
  const topLevel = await git(workspace, dependencies, workspacePath, [
    'rev-parse',
    '--show-toplevel',
  ]);
  if (
    !completed(topLevel) ||
    topLevel.exitCode !== 0 ||
    !singleLine(topLevel.stdout) ||
    pathKey(singleLine(topLevel.stdout)!, platform) !==
      pathKey(workspacePath, platform)
  ) {
    return attention(
      workspace,
      'workspace_top_level_mismatch',
      completed(topLevel)
        ? 'Workspace top-level does not match the reservation'
        : resultError(topLevel),
    );
  }
  const head = await git(workspace, dependencies, workspacePath, [
    'rev-parse',
    'HEAD^{commit}',
  ]);
  const observedHead =
    completed(head) && head.exitCode === 0
      ? singleLine(head.stdout)
      : undefined;
  if (!observedHead || observedHead !== workspace.baseCommit) {
    return attention(
      workspace,
      'workspace_head_mismatch',
      completed(head)
        ? 'Workspace HEAD does not match the reserved base commit'
        : resultError(head),
      { observedHead: observedHead ?? null, observedDirty: null },
    );
  }
  const branch = await git(workspace, dependencies, workspacePath, [
    'symbolic-ref',
    '--short',
    'HEAD',
  ]);
  if (
    !completed(branch) ||
    branch.exitCode !== 0 ||
    singleLine(branch.stdout) !== workspace.branch
  ) {
    return attention(
      workspace,
      'workspace_branch_mismatch',
      completed(branch)
        ? 'Workspace branch does not match the reservation'
        : resultError(branch),
      { observedHead, observedDirty: null },
    );
  }
  const status = await git(workspace, dependencies, workspacePath, [
    'status',
    '--porcelain=v1',
    '-z',
  ]);
  if (!completed(status) || status.exitCode !== 0) {
    return attention(
      workspace,
      'workspace_status_failed',
      resultError(status),
      { observedHead, observedDirty: null },
    );
  }
  const observedDirty = status.stdout.length > 0;
  const gitDirectory = await git(workspace, dependencies, workspacePath, [
    'rev-parse',
    '--git-dir',
  ]);
  const directory =
    completed(gitDirectory) && gitDirectory.exitCode === 0
      ? singleLine(gitDirectory.stdout)
      : undefined;
  if (!directory) {
    return attention(
      workspace,
      'workspace_ownership_directory_failed',
      gitDirectory
        ? resultError(gitDirectory)
        : 'Git did not return an ownership directory',
      { observedHead, observedDirty },
    );
  }
  try {
    const ownership = JSON.parse(
      await readFile(
        resolve(ownershipPath(directory, workspacePath), 'mesh-owner.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    if (
      ownership.schema !== ownershipSchema ||
      ownership.attemptId !== workspace.attemptId ||
      ownership.ownershipToken !== workspace.ownershipToken ||
      ownership.repositoryIdentity !== workspace.repositoryIdentity ||
      ownership.branch !== workspace.branch ||
      ownership.baseCommit !== workspace.baseCommit
    ) {
      return attention(
        workspace,
        'workspace_ownership_mismatch',
        'Workspace ownership metadata does not match the reservation',
        { observedHead, observedDirty },
      );
    }
  } catch (error) {
    return attention(
      workspace,
      'workspace_ownership_missing',
      error instanceof Error ? error.message : String(error),
      { observedHead, observedDirty },
    );
  }
  return options.requireClean && observedDirty
    ? attention(
        workspace,
        'workspace_dirty',
        'Provisioned workspace is not clean',
        { observedHead, observedDirty },
      )
    : {
        ...workspace,
        lifecycle: 'ready',
        observedHead,
        observedDirty,
        failure: null,
      };
};
