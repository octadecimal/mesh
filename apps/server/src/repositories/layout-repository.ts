import { savedLayoutSchema, type SavedLayout } from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type LayoutRow = {
  id: string;
  project_id: string | null;
  session_id: string | null;
  workspace_id: string | null;
  dockview_json: string;
  sidebar_json: string | null;
  visible_panels_json: string;
  updated_at: string;
};

const toLayout = (row: LayoutRow): SavedLayout =>
  savedLayoutSchema.parse({
    id: row.id,
    projectId: row.project_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    dockview: JSON.parse(row.dockview_json),
    sidebar: row.sidebar_json ? JSON.parse(row.sidebar_json) : undefined,
    visiblePanels: JSON.parse(row.visible_panels_json),
    updatedAt: row.updated_at,
  });

export class LayoutRepository {
  private readonly upsert;
  private readonly selectById;

  constructor(private readonly database: Database) {
    this.upsert = database.prepare(`
      INSERT INTO saved_layouts (
        id, project_id, session_id, workspace_id, dockview_json, sidebar_json,
        visible_panels_json, updated_at
      ) VALUES (
        @id, @projectId, @sessionId, @workspaceId, @dockviewJson, @sidebarJson,
        @visiblePanelsJson, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        session_id = excluded.session_id,
        workspace_id = excluded.workspace_id,
        dockview_json = excluded.dockview_json,
        sidebar_json = excluded.sidebar_json,
        visible_panels_json = excluded.visible_panels_json,
        updated_at = excluded.updated_at
    `);
    this.selectById = database.prepare('SELECT * FROM saved_layouts WHERE id = ?');
  }

  save(layout: SavedLayout): SavedLayout {
    const value = savedLayoutSchema.parse(layout);
    this.upsert.run({
      ...value,
      projectId: value.projectId ?? null,
      sessionId: value.sessionId ?? null,
      workspaceId: value.workspaceId ?? null,
      dockviewJson: JSON.stringify(value.dockview),
      sidebarJson: value.sidebar === undefined ? null : JSON.stringify(value.sidebar),
      visiblePanelsJson: JSON.stringify(value.visiblePanels),
    });
    return value;
  }

  get(id: string): SavedLayout | undefined {
    const row = this.selectById.get(id) as LayoutRow | undefined;
    return row ? toLayout(row) : undefined;
  }
}
