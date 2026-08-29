import { projectSchema, type Project } from '@mesh/v2-contracts';

import type { V2Database } from '../db/database.js';

type ProjectRow = {
  id: string;
  display_name: string;
  repository_identity: string;
  repository_path: string;
  git_common_directory: string;
  head_commit: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

const toProject = (row: ProjectRow): Project =>
  projectSchema.parse({
    id: row.id,
    displayName: row.display_name,
    repositoryIdentity: row.repository_identity,
    repositoryPath: row.repository_path,
    gitCommonDirectory: row.git_common_directory,
    headCommit: row.head_commit,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class ProjectRepository {
  private readonly selectAll;
  private readonly selectById;
  private readonly selectByRepositoryIdentity;
  private readonly insert;

  constructor(private readonly database: V2Database) {
    this.selectAll = database.prepare(
      'SELECT * FROM projects ORDER BY created_at, id',
    );
    this.selectById = database.prepare('SELECT * FROM projects WHERE id = ?');
    this.selectByRepositoryIdentity = database.prepare(
      'SELECT * FROM projects WHERE repository_identity = ?',
    );
    this.insert = database.prepare(`
      INSERT INTO projects (
        id, display_name, repository_identity, repository_path,
        git_common_directory, head_commit, revision, created_at, updated_at
      ) VALUES (
        @id, @displayName, @repositoryIdentity, @repositoryPath,
        @gitCommonDirectory, @headCommit, @revision, @createdAt, @updatedAt
      )
    `);
  }

  list(): Project[] {
    return (this.selectAll.all() as ProjectRow[]).map(toProject);
  }

  get(projectId: string): Project | undefined {
    const row = this.selectById.get(projectId) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  getByRepositoryIdentity(repositoryIdentity: string): Project | undefined {
    const row = this.selectByRepositoryIdentity.get(repositoryIdentity) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : undefined;
  }

  insertInTransaction(project: Project): void {
    if (!this.database.inTransaction) {
      throw new Error('Project insert transaction is not active');
    }
    this.insert.run(projectSchema.parse(project));
  }
}
