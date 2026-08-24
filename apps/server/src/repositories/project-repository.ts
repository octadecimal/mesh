import { projectSchema, type Project } from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type ProjectRow = {
  id: string;
  display_name: string;
  repository_path: string;
  discovered_at: string;
  discovery_metadata_json: string;
};

const toProject = (row: ProjectRow): Project =>
  projectSchema.parse({
    id: row.id,
    displayName: row.display_name,
    repositoryPath: row.repository_path,
    discoveredAt: row.discovered_at,
    discoveryMetadata: JSON.parse(row.discovery_metadata_json),
  });

export class ProjectRepository {
  private readonly insert;
  private readonly selectById;
  private readonly selectAll;
  private readonly deleteById;

  constructor(private readonly database: Database) {
    this.insert = database.prepare(`
      INSERT INTO projects (id, display_name, repository_path, discovered_at, discovery_metadata_json)
      VALUES (@id, @displayName, @repositoryPath, @discoveredAt, @discoveryMetadataJson)
    `);
    this.selectById = database.prepare('SELECT * FROM projects WHERE id = ?');
    this.selectAll = database.prepare('SELECT * FROM projects ORDER BY discovered_at, id');
    this.deleteById = database.prepare('DELETE FROM projects WHERE id = ?');
  }

  create(project: Project): Project {
    const value = projectSchema.parse(project);
    this.insert.run({
      ...value,
      discoveryMetadataJson: JSON.stringify(value.discoveryMetadata),
    });
    return value;
  }

  get(id: string): Project | undefined {
    const row = this.selectById.get(id) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  list(): Project[] {
    return (this.selectAll.all() as ProjectRow[]).map(toProject);
  }

  remove(id: string): void {
    this.deleteById.run(id);
  }
}
