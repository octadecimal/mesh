import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Session, Workspace } from '@mesh-session-platform/contracts';

import { GitAdapter } from './git.js';
import { NodeProcessRunner, type ProcessRunner } from './process-runner.js';
import type { AbsolutePath, WorkspacePathFileSystem } from './paths.js';

const directoryFs: WorkspacePathFileSystem = {
  realpath: async (value) => value.replace(/\//g, '\\'),
  stat: async () => ({ isDirectory: () => true }),
};

const windowsPathOptions = {
  baseDirectory: 'C:\\repo',
  fs: directoryFs,
  path: win32,
};

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'workspace-1' as Workspace['id'],
  projectId: 'project-1' as Workspace['projectId'],
  type: 'worktree',
  path: 'C:\\repo worktree',
  gitWorktreePath: 'C:\\repo worktree',
  gitBranch: 'feature/test',
  owner: 'mesh',
  cleanupState: 'active',
  ...overrides,
});

const stoppedSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1' as Session['id'],
  projectId: 'project-1' as Session['projectId'],
  workspaceId: 'workspace-1' as Session['workspaceId'],
  title: 'Stopped',
  permissionMode: 'interactive',
  lifecycleState: 'completed',
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  ...overrides,
});

const temporaryDirectories: string[] = [];

const removeTemporaryDirectory = (directory: string): void => {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  const resolvedDirectory = resolve(directory);
  if (
    !resolvedDirectory.startsWith(temporaryRoot) ||
    !resolvedDirectory.startsWith(`${temporaryRoot}mesh-session-platform-git-`)
  ) {
    throw new Error(
      `Refusing to remove unexpected test directory: ${resolvedDirectory}`,
    );
  }
  rmSync(resolvedDirectory, { force: true, recursive: true });
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    removeTemporaryDirectory(temporaryDirectories.pop()!);
  }
});

describe('GitAdapter', () => {
  it('creates a worktree with argv arguments, preserving spaces in its path', async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      cwd: string;
    }> = [];
    const runner: ProcessRunner = {
      run: async (executable, args, options) => {
        calls.push({ executable, args, cwd: options.cwd });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const git = new GitAdapter(runner, windowsPathOptions);

    await expect(
      git.createWorktree({
        branch: 'feature/test',
        repositoryPath: 'C:\\repo' as AbsolutePath,
        startPoint: 'main',
        worktreePath: 'C:\\repo worktree' as AbsolutePath,
      }),
    ).resolves.toEqual({ created: true });
    expect(calls).toEqual([
      {
        executable: 'git',
        args: [
          '-C',
          'C:\\repo',
          'worktree',
          'add',
          '-b',
          'feature/test',
          'C:\\repo worktree',
          'main',
        ],
        cwd: 'C:\\repo',
      },
    ]);
  });

  it('preserves a dirty Mesh-owned worktree without requesting removal', async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      run: async (_executable, args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: ' M changes.txt\n', stderr: '' };
      },
    };
    const git = new GitAdapter(runner, windowsPathOptions);

    await expect(
      git.removeOwnedWorktree({
        confirmed: true,
        repositoryPath: 'C:\\repo' as AbsolutePath,
        sessions: [stoppedSession()],
        workspace: workspace(),
      }),
    ).resolves.toEqual({ removed: false, reason: 'dirty' });
    expect(calls).toEqual([
      ['-C', 'C:\\repo worktree', 'status', '--porcelain=v1'],
    ]);
  });

  it('preserves a shared folder without asking Git to inspect or remove it', async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error('Git must not run for a shared folder');
      },
    };
    const git = new GitAdapter(runner, windowsPathOptions);

    await expect(
      git.removeOwnedWorktree({
        confirmed: true,
        repositoryPath: 'C:\\repo' as AbsolutePath,
        sessions: [],
        workspace: workspace({ type: 'shared' }),
      }),
    ).resolves.toEqual({ removed: false, reason: 'not_owned' });
  });

  it('removes a clean Mesh-owned worktree only after confirmation', async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      run: async (_executable, args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const git = new GitAdapter(runner, windowsPathOptions);

    await expect(
      git.removeOwnedWorktree({
        confirmed: true,
        repositoryPath: 'C:\\repo' as AbsolutePath,
        sessions: [stoppedSession()],
        workspace: workspace(),
      }),
    ).resolves.toEqual({ removed: true });
    expect(calls).toEqual([
      ['-C', 'C:\\repo worktree', 'status', '--porcelain=v1'],
      ['-C', 'C:\\repo', 'worktree', 'remove', 'C:\\repo worktree'],
    ]);
  });

  it('preserves a worktree with an active session before inspecting Git', async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error(
          'Git must not run while the workspace has an active session',
        );
      },
    };
    const git = new GitAdapter(runner, windowsPathOptions);

    await expect(
      git.removeOwnedWorktree({
        confirmed: true,
        repositoryPath: 'C:\\repo' as AbsolutePath,
        sessions: [stoppedSession({ lifecycleState: 'running' })],
        workspace: workspace(),
      }),
    ).resolves.toEqual({ removed: false, reason: 'session_active' });
  });

  it('preserves mismatched canonical workspace paths', async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error('Git must not run for ambiguous paths');
      },
    };
    const git = new GitAdapter(runner, windowsPathOptions);

    await expect(
      git.removeOwnedWorktree({
        confirmed: true,
        repositoryPath: 'C:\\repo' as AbsolutePath,
        sessions: [],
        workspace: workspace({ gitWorktreePath: 'C:\\other worktree' }),
      }),
    ).resolves.toEqual({ removed: false, reason: 'ambiguous' });
  });

  it('creates and removes a clean owned worktree in a real temporary Git repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mesh-session-platform-git-'));
    temporaryDirectories.push(directory);
    const repositoryPath = join(directory, 'repository');
    const worktreePath = join(directory, 'worktree with spaces');
    mkdirSync(repositoryPath);
    execFileSync('git', ['init', repositoryPath]);
    execFileSync('git', [
      '-C',
      repositoryPath,
      'config',
      'user.email',
      'mesh@example.test',
    ]);
    execFileSync('git', [
      '-C',
      repositoryPath,
      'config',
      'user.name',
      'Mesh Test',
    ]);
    writeFileSync(join(repositoryPath, 'README.md'), 'seed\n');
    execFileSync('git', ['-C', repositoryPath, 'add', 'README.md']);
    execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'seed']);

    const git = new GitAdapter(new NodeProcessRunner(), {
      baseDirectory: directory,
    });
    await expect(
      git.createWorktree({
        branch: 'feature/real-test',
        repositoryPath: repositoryPath as AbsolutePath,
        startPoint: 'HEAD',
        worktreePath: worktreePath as AbsolutePath,
      }),
    ).resolves.toEqual({ created: true });
    expect(existsSync(worktreePath)).toBe(true);

    await expect(
      git.removeOwnedWorktree({
        confirmed: true,
        repositoryPath: repositoryPath as AbsolutePath,
        sessions: [],
        workspace: workspace({
          path: worktreePath,
          gitWorktreePath: worktreePath,
        }),
      }),
    ).resolves.toEqual({ removed: true });
    expect(existsSync(worktreePath)).toBe(false);
  });
});
