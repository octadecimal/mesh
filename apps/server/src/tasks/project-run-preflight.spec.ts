import { posix } from 'node:path';

import { projectSchema } from '@mesh-session-platform/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createProjectRunPreflight } from './project-run-preflight.js';

const project = projectSchema.parse({
  id: 'project-1',
  displayName: 'Project one',
  repositoryPath: '/repos/project-one',
  repositoryIdentity: 'identity-1',
  discoveredAt: '2026-08-27T00:00:00.000Z',
  discoveryMetadata: {},
});

const pathOptions = {
  baseDirectory: '/repos',
  path: posix,
  fs: {
    realpath: async (path: string) => path,
    stat: async () => ({ isDirectory: () => true }),
  },
};
const workspaceRoot = '/repos/.mesh-project-runs';

const identity = (
  repositoryIdentity: string,
  overrides: {
    canonicalPath?: string;
    associatedWorktreePaths?: readonly string[];
    headCommit?: string | null;
  } = {},
) => ({
  canonicalPath: (overrides.canonicalPath ?? project.repositoryPath) as never,
  commonDirectory: project.repositoryPath as never,
  repositoryIdentity,
  associatedWorktreePaths: (overrides.associatedWorktreePaths ?? [
    project.repositoryPath,
  ]) as never,
  headCommit:
    overrides.headCommit === undefined ? 'a'.repeat(40) : overrides.headCommit,
});

describe('project run preflight', () => {
  it('rejects shared API billing conflicts without resolving the repository', async () => {
    const resolveIdentity = vi.fn(async () => identity('identity-1'));
    const ensureWorkspaceRoot = vi.fn();
    const preflight = createProjectRunPreflight({
      billingConflicts: [{ variable: 'ANTHROPIC_API_KEY' }],
      resolveIdentity,
      pathOptions,
      workspaceRoot,
      ensureWorkspaceRoot,
    });

    await expect(preflight(project)).rejects.toMatchObject({
      code: 'billing_configuration_conflict',
      reason: 'billing_conflict',
    });
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(ensureWorkspaceRoot).not.toHaveBeenCalled();
  });

  it('accepts only the authoritative imported repository identity', async () => {
    const resolveIdentity = vi.fn(async () => identity('identity-1'));
    const ensureWorkspaceRoot = vi.fn();
    const preflight = createProjectRunPreflight({
      billingConflicts: [],
      resolveIdentity,
      pathOptions,
      workspaceRoot,
      ensureWorkspaceRoot,
    });

    await expect(preflight(project)).resolves.toBeUndefined();
    expect(resolveIdentity).toHaveBeenCalledWith(
      project.repositoryPath,
      pathOptions,
    );
    expect(ensureWorkspaceRoot).toHaveBeenCalledWith(workspaceRoot);
  });

  it.each([
    ['changed identity', async () => identity('identity-2')],
    ['resolver failure', async () => Promise.reject(new Error('missing repo'))],
  ] as const)('rejects repository unsafe on %s', async (_label, resolver) => {
    const preflight = createProjectRunPreflight({
      billingConflicts: [],
      resolveIdentity: resolver,
      pathOptions,
      workspaceRoot,
      ensureWorkspaceRoot: vi.fn(),
    });

    await expect(preflight(project)).rejects.toEqual(
      expect.objectContaining({
        code: 'repository_invalid',
        reason: 'repository_unsafe',
      }),
    );
  });

  it('rejects a worktree root nested inside the imported repository', async () => {
    const ensureWorkspaceRoot = vi.fn();
    const preflight = createProjectRunPreflight({
      billingConflicts: [],
      resolveIdentity: async () => identity('identity-1'),
      pathOptions,
      workspaceRoot: '/repos/project-one/.mesh-project-runs',
      ensureWorkspaceRoot,
    });

    await expect(preflight(project)).rejects.toMatchObject({
      code: 'repository_invalid',
      reason: 'repository_unsafe',
    });
    expect(ensureWorkspaceRoot).not.toHaveBeenCalled();
  });

  it('rejects a root inside any worktree associated with the repository', async () => {
    const ensureWorkspaceRoot = vi.fn();
    const preflight = createProjectRunPreflight({
      billingConflicts: [],
      resolveIdentity: async () =>
        identity('identity-1', {
          canonicalPath: '/repos/project-one/.worktrees/feature',
          associatedWorktreePaths: [
            '/repos/project-one',
            '/repos/project-one/.worktrees/feature',
          ],
        }),
      pathOptions,
      workspaceRoot: '/repos/project-one/.mesh-project-runs',
      ensureWorkspaceRoot,
    });

    await expect(preflight(project)).rejects.toMatchObject({
      code: 'repository_invalid',
      reason: 'repository_unsafe',
    });
    expect(ensureWorkspaceRoot).not.toHaveBeenCalled();
  });

  it('rejects an unborn repository before creating the workspace root', async () => {
    const ensureWorkspaceRoot = vi.fn();
    const preflight = createProjectRunPreflight({
      billingConflicts: [],
      resolveIdentity: async () => identity('identity-1', { headCommit: null }),
      pathOptions,
      workspaceRoot,
      ensureWorkspaceRoot,
    });

    await expect(preflight(project)).rejects.toMatchObject({
      code: 'repository_invalid',
      reason: 'repository_unsafe',
    });
    expect(ensureWorkspaceRoot).not.toHaveBeenCalled();
  });
});
