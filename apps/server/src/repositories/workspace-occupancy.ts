import type { Database } from '../db/database.js';

export class WorkspaceOccupiedError extends Error {
  readonly code = 'project_run_conflict';

  constructor(readonly path: string) {
    super(`Workspace '${path}' is already occupied by a live session`);
    this.name = 'WorkspaceOccupiedError';
  }
}

export const assertWorkspaceAvailable = (
  database: Database,
  input: {
    path: string;
    excludingSessionId: string;
    policy: 'exclusive' | 'manual';
  },
): void => {
  if (!database.inTransaction) {
    throw new Error('Workspace occupancy requires an active transaction');
  }
  const occupied = database
    .prepare(
      `SELECT sessions.id
      FROM sessions
      JOIN workspaces occupied_workspace
        ON occupied_workspace.id = sessions.workspace_id
      WHERE occupied_workspace.path = ?
        AND sessions.id <> ?
        AND sessions.lifecycle_state IN (
          'idle', 'starting', 'running', 'waiting_for_approval', 'interrupting'
        )
        AND (
          ? = 'exclusive'
          OR EXISTS (
            SELECT 1
            FROM workspaces protected_workspace
            WHERE protected_workspace.path = occupied_workspace.path
              AND protected_workspace.type = 'worktree'
              AND protected_workspace.owner = 'mesh'
              AND protected_workspace.cleanup_state IN ('pending', 'active')
          )
        )
      LIMIT 1`,
    )
    .get(input.path, input.excludingSessionId, input.policy);
  if (occupied) throw new WorkspaceOccupiedError(input.path);
};
