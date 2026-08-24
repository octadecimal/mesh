import { sessionSchema, type Session } from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type SessionRow = {
  id: string;
  claude_resume_id: string | null;
  project_id: string;
  workspace_id: string;
  title: string;
  permission_mode: string;
  lifecycle_state: string;
  created_at: string;
  updated_at: string;
};

const toSession = (row: SessionRow): Session =>
  sessionSchema.parse({
    id: row.id,
    claudeResumeId: row.claude_resume_id ?? undefined,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    title: row.title,
    permissionMode: row.permission_mode,
    lifecycleState: row.lifecycle_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class SessionRepository {
  private readonly insert;
  private readonly selectById;
  private readonly selectActiveByProject;
  private readonly selectAllByProject;
  private readonly archiveById;

  constructor(private readonly database: Database) {
    this.insert = database.prepare(`
      INSERT INTO sessions (
        id, claude_resume_id, project_id, workspace_id, title, permission_mode,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        @id, @claudeResumeId, @projectId, @workspaceId, @title, @permissionMode,
        @lifecycleState, @createdAt, @updatedAt
      )
    `);
    this.selectById = database.prepare('SELECT * FROM sessions WHERE id = ?');
    this.selectActiveByProject = database.prepare(
      "SELECT * FROM sessions WHERE project_id = ? AND lifecycle_state != 'archived' ORDER BY updated_at DESC, id",
    );
    this.selectAllByProject = database.prepare(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC, id',
    );
    this.archiveById = database.prepare(
      "UPDATE sessions SET lifecycle_state = 'archived', updated_at = ? WHERE id = ?",
    );
  }

  create(session: Session): Session {
    const value = sessionSchema.parse(session);
    this.insert.run({ ...value, claudeResumeId: value.claudeResumeId ?? null });
    return value;
  }

  get(id: string): Session | undefined {
    const row = this.selectById.get(id) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  listByProject(projectId: string, options?: { includeArchived?: boolean }): Session[] {
    const statement = options?.includeArchived
      ? this.selectAllByProject
      : this.selectActiveByProject;
    return (statement.all(projectId) as SessionRow[]).map(toSession);
  }

  archive(id: string): Session | undefined {
    this.archiveById.run(new Date().toISOString(), id);
    return this.get(id);
  }
}
