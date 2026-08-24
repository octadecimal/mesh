import { workspaceSchema, type Workspace } from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type WorkspaceRow = {
  id: string;
  project_id: string;
  type: string;
  path: string;
  git_branch: string | null;
  git_worktree_path: string | null;
  owner: string | null;
  cleanup_state: string;
};

const toWorkspace = (row: WorkspaceRow): Workspace =>
  workspaceSchema.parse({
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    path: row.path,
    gitBranch: row.git_branch ?? undefined,
    gitWorktreePath: row.git_worktree_path ?? undefined,
    owner: row.owner ?? undefined,
    cleanupState: row.cleanup_state,
  });

export class WorkspaceRepository {
  private readonly insert;
  private readonly selectByProject;
  private readonly selectById;

  constructor(private readonly database: Database) {
    this.insert = database.prepare(`
      INSERT INTO workspaces (
        id, project_id, type, path, git_branch, git_worktree_path, owner, cleanup_state
      ) VALUES (
        @id, @projectId, @type, @path, @gitBranch, @gitWorktreePath, @owner, @cleanupState
      )
    `);
    this.selectByProject = database.prepare(
      'SELECT * FROM workspaces WHERE project_id = ? ORDER BY id',
    );
    this.selectById = database.prepare('SELECT * FROM workspaces WHERE id = ?');
  }

  create(workspace: Workspace): Workspace {
    const value = workspaceSchema.parse(workspace);
    this.insert.run({
      ...value,
      gitBranch: value.gitBranch ?? null,
      gitWorktreePath: value.gitWorktreePath ?? null,
      owner: value.owner ?? null,
    });
    return value;
  }

  get(id: string): Workspace | undefined {
    const row = this.selectById.get(id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : undefined;
  }

  listByProject(projectId: string): Workspace[] {
    return (this.selectByProject.all(projectId) as WorkspaceRow[]).map(toWorkspace);
  }
}
