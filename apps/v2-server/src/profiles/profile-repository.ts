import {
  workerProfileDocumentSchema,
  workerProfileRevisionSchema,
  type WorkerProfileRevision,
} from '@mesh/v2-contracts';

import type { V2Database } from '../db/database.js';
import { canonicalJson } from '../storage/canonical-json.js';

export type WorkerProfileIdentity = {
  id: string;
  scope: 'global' | 'project';
  projectId: string | null;
  name: string;
  displayName: string;
  approvedRevision: number | null;
  createdAt: string;
  updatedAt: string;
};

type ProfileRow = {
  id: string;
  scope: 'global' | 'project';
  project_id: string | null;
  name: string;
  display_name: string;
  approved_revision: number | null;
  created_at: string;
  updated_at: string;
};

type RevisionRow = ProfileRow & {
  revision: number;
  source_yaml: string;
  normalized_json: string;
  base_profile_id: string | null;
  base_revision: number | null;
  approved_by: string;
  approved_at: string;
  digest: string;
};

const toIdentity = (row: ProfileRow): WorkerProfileIdentity => ({
  id: row.id,
  scope: row.scope,
  projectId: row.project_id,
  name: row.name,
  displayName: row.display_name,
  approvedRevision: row.approved_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRevision = (row: RevisionRow): WorkerProfileRevision => {
  const document = workerProfileDocumentSchema.parse(
    JSON.parse(row.normalized_json),
  );
  if (
    document.metadata.scope !== row.scope ||
    document.metadata.name !== row.name
  ) {
    throw new Error('Stored profile identity does not match its revision');
  }
  return workerProfileRevisionSchema.parse({
    profileId: row.id,
    scope: row.scope,
    projectId: row.project_id,
    name: document.metadata.name,
    displayName: document.metadata.displayName,
    revision: row.revision,
    sourceYaml: row.source_yaml,
    document,
    baseProfileId: row.base_profile_id,
    baseRevision: row.base_revision,
    approvedBy: JSON.parse(row.approved_by),
    approvedAt: row.approved_at,
    digest: row.digest,
  });
};

const REVISION_SELECT = `
  SELECT p.*, r.revision, r.source_yaml, r.normalized_json,
    r.base_profile_id, r.base_revision, r.approved_by, r.approved_at, r.digest
  FROM worker_profiles p
  JOIN worker_profile_revisions r ON r.profile_id = p.id`;

export class WorkerProfileRepository {
  constructor(private readonly database: V2Database) {}

  findIdentity(
    scope: 'global' | 'project',
    projectId: string | null,
    name: string,
  ): WorkerProfileIdentity | undefined {
    const row =
      scope === 'global'
        ? (this.database
            .prepare(
              `SELECT * FROM worker_profiles
               WHERE scope = 'global' AND project_id IS NULL AND name = ?`,
            )
            .get(name) as ProfileRow | undefined)
        : (this.database
            .prepare(
              `SELECT * FROM worker_profiles
               WHERE scope = 'project' AND project_id = ? AND name = ?`,
            )
            .get(projectId, name) as ProfileRow | undefined);
    return row ? toIdentity(row) : undefined;
  }

  insertIdentityInTransaction(identity: WorkerProfileIdentity): void {
    this.assertTransaction();
    this.database
      .prepare(
        `INSERT INTO worker_profiles (
          id, scope, project_id, name, display_name, approved_revision,
          created_at, updated_at
        ) VALUES (
          @id, @scope, @projectId, @name, @displayName, @approvedRevision,
          @createdAt, @updatedAt
        )`,
      )
      .run(identity);
  }

  insertRevisionInTransaction(revision: WorkerProfileRevision): void {
    this.assertTransaction();
    const parsed = workerProfileRevisionSchema.parse(revision);
    this.database
      .prepare(
        `INSERT INTO worker_profile_revisions (
          profile_id, revision, source_yaml, normalized_json,
          base_profile_id, base_revision, approved_by, approved_at, digest
        ) VALUES (
          @profileId, @revision, @sourceYaml, @normalizedJson,
          @baseProfileId, @baseRevision, @approvedBy, @approvedAt, @digest
        )`,
      )
      .run({
        ...parsed,
        normalizedJson: canonicalJson(parsed.document),
        approvedBy: canonicalJson(parsed.approvedBy),
      });
  }

  approveRevisionInTransaction(
    profileId: string,
    expectedApprovedRevision: number | null,
    revision: WorkerProfileRevision,
  ): void {
    this.assertTransaction();
    const result = this.database
      .prepare(
        `UPDATE worker_profiles
         SET display_name = ?, approved_revision = ?, updated_at = ?
         WHERE id = ? AND approved_revision IS ?`,
      )
      .run(
        revision.displayName,
        revision.revision,
        revision.approvedAt,
        profileId,
        expectedApprovedRevision,
      );
    if (result.changes !== 1) {
      throw new Error('Worker profile approved revision changed concurrently');
    }
  }

  revision(
    profileId: string,
    revision: number,
  ): WorkerProfileRevision | undefined {
    const row = this.database
      .prepare(`${REVISION_SELECT} WHERE p.id = ? AND r.revision = ?`)
      .get(profileId, revision) as RevisionRow | undefined;
    return row ? toRevision(row) : undefined;
  }

  globalRevisionByName(
    name: string,
    revision: number,
  ): WorkerProfileRevision | undefined {
    const row = this.database
      .prepare(
        `${REVISION_SELECT}
         WHERE p.scope = 'global' AND p.project_id IS NULL
           AND p.name = ? AND r.revision = ?`,
      )
      .get(name, revision) as RevisionRow | undefined;
    return row ? toRevision(row) : undefined;
  }

  approvedGlobal(): WorkerProfileRevision[] {
    return (
      this.database
        .prepare(
          `${REVISION_SELECT}
           WHERE p.scope = 'global' AND p.project_id IS NULL
             AND r.revision = p.approved_revision
           ORDER BY p.name`,
        )
        .all() as RevisionRow[]
    ).map(toRevision);
  }

  approvedForProject(projectId: string): WorkerProfileRevision[] {
    return (
      this.database
        .prepare(
          `${REVISION_SELECT}
           WHERE p.scope = 'project' AND p.project_id = ?
             AND r.revision = p.approved_revision
           ORDER BY p.name`,
        )
        .all(projectId) as RevisionRow[]
    ).map(toRevision);
  }

  private assertTransaction(): void {
    if (!this.database.inTransaction) {
      throw new Error('Worker profile transaction is not active');
    }
  }
}
