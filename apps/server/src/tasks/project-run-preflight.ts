import type { Project } from '@mesh-session-platform/contracts';

import {
  resolveWorkspacePath,
  type ResolveWorkspacePathOptions,
} from '../platform/paths.js';
import type { RepositoryIdentityResolver } from '../projects/repository-identity.js';

export type ProjectRunPreflightReason =
  | 'billing_conflict'
  | 'repository_unsafe';

export class ProjectRunPreflightError extends Error {
  readonly code: 'billing_configuration_conflict' | 'repository_invalid';

  constructor(
    readonly reason: ProjectRunPreflightReason,
    readonly cause?: unknown,
  ) {
    super(
      reason === 'billing_conflict'
        ? 'API billing environment variables must be removed before starting a project run'
        : 'The project repository is missing, unreadable, or no longer matches its imported identity',
    );
    this.code =
      reason === 'billing_conflict'
        ? 'billing_configuration_conflict'
        : 'repository_invalid';
    this.name = 'ProjectRunPreflightError';
  }
}

export type ProjectRunPreflight = (project: Project) => Promise<void>;

const normalizeForComparison = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  const withoutTrailingSeparator = normalized.replace(/\/+$/, '');
  const comparison = withoutTrailingSeparator || '/';
  return process.platform === 'win32' ? comparison.toLowerCase() : comparison;
};

const isWithin = (candidate: string, root: string): boolean => {
  const candidatePath = normalizeForComparison(candidate);
  const rootPath = normalizeForComparison(root);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
};

export const createProjectRunPreflight =
  (dependencies: {
    billingConflicts: readonly { variable: string }[];
    resolveIdentity: RepositoryIdentityResolver;
    pathOptions: ResolveWorkspacePathOptions;
    workspaceRoot: string;
    ensureWorkspaceRoot: (path: string) => void;
  }): ProjectRunPreflight =>
  async (project) => {
    if (dependencies.billingConflicts.length > 0) {
      throw new ProjectRunPreflightError('billing_conflict');
    }
    try {
      const identity = await dependencies.resolveIdentity(
        project.repositoryPath,
        dependencies.pathOptions,
      );
      if (identity.repositoryIdentity !== project.repositoryIdentity) {
        throw new Error('Repository identity changed');
      }
      if (identity.headCommit === null) {
        throw new Error('Project run requires a resolvable HEAD commit');
      }
      if (
        identity.associatedWorktreePaths.length === 0 ||
        !identity.associatedWorktreePaths.some(
          (worktreePath) =>
            normalizeForComparison(worktreePath) ===
            normalizeForComparison(identity.canonicalPath),
        )
      ) {
        throw new Error('Repository worktree topology is incomplete');
      }
      const workspaceRoot = await resolveWorkspacePath(
        dependencies.workspaceRoot,
        {
          ...dependencies.pathOptions,
          allowMissingLeaf: true,
        },
      );
      if (
        identity.associatedWorktreePaths.some((worktreePath) =>
          isWithin(workspaceRoot, worktreePath),
        )
      ) {
        throw new Error(
          'Project run workspace root is inside an associated worktree',
        );
      }
      dependencies.ensureWorkspaceRoot(workspaceRoot);
    } catch (error) {
      if (error instanceof ProjectRunPreflightError) throw error;
      throw new ProjectRunPreflightError('repository_unsafe', error);
    }
  };
