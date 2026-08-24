import type { Session, Workspace } from '@mesh-session-platform/contracts';

import {
  resolveWorkspacePath,
  type AbsolutePath,
  type ResolveWorkspacePathOptions,
} from './paths.js';
import type { ProcessRunner } from './process-runner.js';

const meshOwner = 'mesh';
const stoppedLifecycleStates = new Set<Session['lifecycleState']>([
  'completed',
  'failed',
  'interrupted',
  'archived',
]);

export type WorktreePreservationReason =
  | 'dirty'
  | 'missing'
  | 'ambiguous'
  | 'not_owned'
  | 'session_active';

export type WorktreeRemovalResult =
  | { removed: true }
  | { removed: false; reason: WorktreePreservationReason };

export interface CreateWorktreeRequest {
  branch: string;
  repositoryPath: AbsolutePath;
  startPoint: string;
  worktreePath: AbsolutePath;
  signal?: AbortSignal;
}

export interface InspectWorktreeRequest {
  worktreePath: AbsolutePath;
  signal?: AbortSignal;
}

export type WorktreeInspection =
  | { clean: true }
  | { clean: false; reason: 'dirty' | 'missing' };

export interface RemoveOwnedWorktreeRequest {
  confirmed: boolean;
  repositoryPath: AbsolutePath;
  sessions: readonly Session[];
  workspace: Workspace;
  signal?: AbortSignal;
}

export class GitAdapter {
  constructor(
    private readonly processRunner: ProcessRunner,
    private readonly pathOptions: ResolveWorkspacePathOptions,
  ) {}

  async createWorktree(request: CreateWorktreeRequest): Promise<{ created: true }> {
    const repositoryPath = await this.resolve(request.repositoryPath);
    const worktreePath = await this.resolve(request.worktreePath, true);
    const result = await this.processRunner.run(
      'git',
      [
        '-C',
        repositoryPath,
        'worktree',
        'add',
        '-b',
        request.branch,
        worktreePath,
        request.startPoint,
      ],
      { cwd: repositoryPath, signal: request.signal },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Git worktree creation failed: ${result.stderr}`);
    }
    return { created: true };
  }

  async inspectWorktree(request: InspectWorktreeRequest): Promise<WorktreeInspection> {
    let worktreePath: AbsolutePath;
    try {
      worktreePath = await this.resolve(request.worktreePath);
    } catch {
      return { clean: false, reason: 'missing' };
    }
    const result = await this.processRunner.run(
      'git',
      ['-C', worktreePath, 'status', '--porcelain=v1'],
      { cwd: worktreePath, signal: request.signal },
    );
    if (result.exitCode !== 0) {
      return { clean: false, reason: 'missing' };
    }
    return result.stdout.length === 0 ? { clean: true } : { clean: false, reason: 'dirty' };
  }

  async removeOwnedWorktree(request: RemoveOwnedWorktreeRequest): Promise<WorktreeRemovalResult> {
    if (!request.confirmed) {
      return { removed: false, reason: 'ambiguous' };
    }
    if (request.workspace.type !== 'worktree' || request.workspace.owner !== meshOwner) {
      return { removed: false, reason: 'not_owned' };
    }
    if (
      request.sessions.some(
        (session) =>
          session.workspaceId === request.workspace.id &&
          !stoppedLifecycleStates.has(session.lifecycleState),
      )
    ) {
      return { removed: false, reason: 'session_active' };
    }
    if (!request.workspace.gitWorktreePath) {
      return { removed: false, reason: 'not_owned' };
    }

    let repositoryPath: AbsolutePath;
    let workspacePath: AbsolutePath;
    let gitWorktreePath: AbsolutePath;
    try {
      [repositoryPath, workspacePath, gitWorktreePath] = await Promise.all([
        this.resolve(request.repositoryPath),
        this.resolve(request.workspace.path),
        this.resolve(request.workspace.gitWorktreePath),
      ]);
    } catch {
      return { removed: false, reason: 'missing' };
    }
    if (workspacePath !== gitWorktreePath) {
      return { removed: false, reason: 'ambiguous' };
    }

    const inspection = await this.inspectWorktree({
      worktreePath: gitWorktreePath,
      signal: request.signal,
    });
    if (inspection.clean === false) {
      return { removed: false, reason: inspection.reason };
    }

    const result = await this.processRunner.run(
      'git',
      ['-C', repositoryPath, 'worktree', 'remove', gitWorktreePath],
      { cwd: repositoryPath, signal: request.signal },
    );
    return result.exitCode === 0
      ? { removed: true }
      : { removed: false, reason: 'ambiguous' };
  }

  private resolve(path: string, allowMissingLeaf = false): Promise<AbsolutePath> {
    return resolveWorkspacePath(path, { ...this.pathOptions, allowMissingLeaf });
  }
}
