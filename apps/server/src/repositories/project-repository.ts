import {
  developerInstructionsSchema,
  idSchema,
  isoTimestampSchema,
  projectSchema,
  type Project,
  type DeveloperInstructions,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type ProjectRow = {
  id: string;
  display_name: string;
  repository_path: string;
  discovered_at: string;
  discovery_metadata_json: string;
  repository_identity: string;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  developer_instructions_content: string;
  developer_instructions_revision: number;
  developer_instructions_updated_at: string;
  developer_instructions_updated_by_json: string | null;
};

const toProject = (row: ProjectRow): Project =>
  projectSchema.parse({
    id: row.id,
    displayName: row.display_name,
    repositoryPath: row.repository_path,
    discoveredAt: row.discovered_at,
    discoveryMetadata: JSON.parse(row.discovery_metadata_json),
    repositoryIdentity: row.repository_identity,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    developerInstructions: {
      content: row.developer_instructions_content,
      revision: row.developer_instructions_revision,
      updatedAt: row.developer_instructions_updated_at,
      updatedBy: row.developer_instructions_updated_by_json
        ? JSON.parse(row.developer_instructions_updated_by_json)
        : null,
    },
  });

export class ProjectRepository {
  private readonly insert;
  private readonly selectById;
  private readonly selectByRepositoryIdentity;
  private readonly selectAll;
  private readonly updateByRevision;
  private readonly updateDeveloperInstructionsByRevision;

  constructor(private readonly database: Database) {
    this.insert = database.prepare(`
      INSERT INTO projects (
        id, display_name, repository_path, discovered_at, discovery_metadata_json,
        repository_identity, revision, created_at, updated_at, archived_at,
        developer_instructions_content, developer_instructions_revision,
        developer_instructions_updated_at, developer_instructions_updated_by_json
      ) VALUES (
        @id, @displayName, @repositoryPath, @discoveredAt, @discoveryMetadataJson,
        @repositoryIdentity, @revision, @createdAt, @updatedAt, @archivedAt,
        @developerInstructionsContent, @developerInstructionsRevision,
        @developerInstructionsUpdatedAt, @developerInstructionsUpdatedByJson
      )
    `);
    this.selectById = database.prepare('SELECT * FROM projects WHERE id = ?');
    this.selectByRepositoryIdentity = database.prepare(
      'SELECT * FROM projects WHERE repository_identity = ? ORDER BY discovered_at, id LIMIT 1',
    );
    this.selectAll = database.prepare(
      'SELECT * FROM projects ORDER BY discovered_at, id',
    );
    this.updateByRevision = database.prepare(`
      UPDATE projects SET
        display_name = @displayName,
        repository_path = @repositoryPath,
        discovered_at = @discoveredAt,
        discovery_metadata_json = @discoveryMetadataJson,
        repository_identity = @repositoryIdentity,
        revision = @revision,
        created_at = @createdAt,
        updated_at = @updatedAt,
        archived_at = @archivedAt,
        developer_instructions_content = @developerInstructionsContent,
        developer_instructions_revision = @developerInstructionsRevision,
        developer_instructions_updated_at = @developerInstructionsUpdatedAt,
        developer_instructions_updated_by_json = @developerInstructionsUpdatedByJson
      WHERE id = @id AND revision = @expectedRevision
    `);
    this.updateDeveloperInstructionsByRevision = database.prepare(`
      UPDATE projects
      SET developer_instructions_content = @content,
          developer_instructions_revision = @revision,
          developer_instructions_updated_at = @updatedAt,
          developer_instructions_updated_by_json = @updatedByJson,
          revision = @revision,
          updated_at = @updatedAt
      WHERE id = @projectId AND revision = @expectedRevision
    `);
  }

  create(project: Project): Project {
    const value = projectSchema.parse(project);
    this.insert.run({
      ...value,
      discoveryMetadataJson: JSON.stringify(value.discoveryMetadata),
      archivedAt: value.archivedAt,
      developerInstructionsContent: value.developerInstructions.content,
      developerInstructionsRevision: value.developerInstructions.revision,
      developerInstructionsUpdatedAt: value.developerInstructions.updatedAt,
      developerInstructionsUpdatedByJson: value.developerInstructions.updatedBy
        ? JSON.stringify(value.developerInstructions.updatedBy)
        : null,
    });
    return value;
  }

  get(id: string): Project | undefined {
    const row = this.selectById.get(idSchema.parse(id)) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : undefined;
  }

  getByRepositoryIdentity(repositoryIdentity: string): Project | undefined {
    const row = this.selectByRepositoryIdentity.get(
      idSchema.parse(repositoryIdentity),
    ) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  list(): Project[] {
    return (this.selectAll.all() as ProjectRow[]).map(toProject);
  }

  update(project: Project, expectedRevision: number): Project | undefined {
    const value = projectSchema.parse(project);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new TypeError(
        'Expected project revision must be a positive integer',
      );
    }
    const next = projectSchema.parse({
      ...value,
      revision: expectedRevision + 1,
    });
    const result = this.updateByRevision.run({
      ...next,
      discoveryMetadataJson: JSON.stringify(next.discoveryMetadata),
      archivedAt: next.archivedAt,
      developerInstructionsContent: next.developerInstructions.content,
      developerInstructionsRevision: next.developerInstructions.revision,
      developerInstructionsUpdatedAt: next.developerInstructions.updatedAt,
      developerInstructionsUpdatedByJson: next.developerInstructions.updatedBy
        ? JSON.stringify(next.developerInstructions.updatedBy)
        : null,
      expectedRevision,
    });
    return result.changes === 1 ? next : undefined;
  }

  updateDeveloperInstructions(
    projectId: string,
    expectedRevision: number,
    value: Omit<DeveloperInstructions, 'revision'>,
  ): Project | undefined {
    const parsedProjectId = idSchema.parse(projectId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new TypeError(
        'Expected project revision must be a positive integer',
      );
    }
    const instructions = developerInstructionsSchema.parse({
      ...value,
      revision: expectedRevision + 1,
    });
    const result = this.updateDeveloperInstructionsByRevision.run({
      projectId: parsedProjectId,
      expectedRevision,
      content: instructions.content,
      revision: instructions.revision,
      updatedAt: instructions.updatedAt,
      updatedByJson: instructions.updatedBy
        ? JSON.stringify(instructions.updatedBy)
        : null,
    });
    return result.changes === 1 ? this.get(parsedProjectId) : undefined;
  }

  archive(id: string, at = new Date().toISOString()): Project | undefined {
    const project = this.get(id);
    if (!project) return undefined;
    const timestamp = isoTimestampSchema.parse(at);
    return this.update(
      { ...project, archivedAt: timestamp, updatedAt: timestamp },
      project.revision,
    );
  }

  restore(id: string, at = new Date().toISOString()): Project | undefined {
    const project = this.get(id);
    if (!project) return undefined;
    const timestamp = isoTimestampSchema.parse(at);
    return this.update(
      { ...project, archivedAt: null, updatedAt: timestamp },
      project.revision,
    );
  }
}
