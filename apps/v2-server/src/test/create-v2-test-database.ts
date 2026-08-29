import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import {
  projectSchema,
  workerExecutionSchema,
  workerProfileRevisionSchema,
  type Project,
  type WorkerExecution,
  type WorkerProfileRevision,
} from '@mesh/v2-contracts';

import { openV2Database, type V2Database } from '../db/database.js';
import { canonicalJson } from '../storage/canonical-json.js';
import { V2CommandRepository } from '../storage/command-repository.js';
import { V2EventStore } from '../storage/event-store.js';

const now = '2026-08-28T00:00:00.000Z';

export const insertV2TestProject = (
  database: V2Database,
  overrides: Pick<Project, 'id' | 'displayName' | 'repositoryIdentity'> &
    Partial<Project>,
): Project => {
  const project = projectSchema.parse({
    repositoryPath: `C:/repositories/${overrides.id}`,
    gitCommonDirectory: `C:/repositories/${overrides.id}/.git`,
    headCommit: 'a'.repeat(40),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  database
    .prepare(
      `INSERT INTO projects (
        id, display_name, repository_identity, repository_path,
        git_common_directory, head_commit, revision, created_at, updated_at
      ) VALUES (
        @id, @displayName, @repositoryIdentity, @repositoryPath,
        @gitCommonDirectory, @headCommit, @revision, @createdAt, @updatedAt
      )`,
    )
    .run(project);
  return project;
};

export type V2TestDatabase = {
  directory: string;
  path: string;
  database: V2Database;
  commands: V2CommandRepository;
  events: V2EventStore;
  project: Project;
  profileRevision: WorkerProfileRevision;
  execution: WorkerExecution;
  close(): void;
};

export type CreateV2TestDatabaseOptions = {
  afterOpen?(database: V2Database): void;
};

const removeVerifiedTestDirectory = (directory: string): void => {
  const resolvedDirectory = resolve(directory);
  const relativeToTemp = relative(resolve(tmpdir()), resolvedDirectory);
  if (
    relativeToTemp.startsWith('..') ||
    relativeToTemp === '' ||
    !resolvedDirectory.includes('mesh-v2-database-test-')
  ) {
    throw new Error('Refusing to remove an unverified V2 test directory');
  }
  rmSync(resolvedDirectory, { force: true, recursive: true });
};

const closeAndRemove = (database: V2Database, directory: string): void => {
  try {
    if (database.open) database.close();
  } finally {
    removeVerifiedTestDirectory(directory);
  }
};

export const createV2TestDatabase = (
  options: CreateV2TestDatabaseOptions = {},
): V2TestDatabase => {
  const directory = mkdtempSync(join(tmpdir(), 'mesh-v2-database-test-'));
  const path = join(directory, 'mesh-v2.sqlite');
  let database: V2Database | undefined;
  try {
    database = openV2Database(path);
    options.afterOpen?.(database);
    const project = insertV2TestProject(database, {
      id: randomUUID(),
      displayName: 'Todo',
      repositoryIdentity: 'todo-repository',
    });
    const profileId = randomUUID();
    const profileDocument = {
      apiVersion: 'mesh.dev/v1alpha1' as const,
      kind: 'WorkerProfile' as const,
      metadata: {
        name: 'foundation-worker',
        displayName: 'Foundation worker',
        scope: 'global' as const,
      },
      spec: {
        assignmentKinds: ['foundation-check'] as const,
        preferredRuntime: { harness: 'fake', model: 'deterministic' },
        alternatives: [],
        requiredCapabilities: ['execution.stream'],
        skills: { preferred: [], required: [] },
        instructions: 'Run the deterministic foundation check.',
        outputSchema: 'mesh.dev/foundation-report/v1',
      },
    };
    const profileRevision = workerProfileRevisionSchema.parse({
      profileId,
      scope: 'global',
      projectId: null,
      name: profileDocument.metadata.name,
      displayName: profileDocument.metadata.displayName,
      revision: 1,
      sourceYaml: 'apiVersion: mesh.dev/v1alpha1',
      document: profileDocument,
      baseProfileId: null,
      baseRevision: null,
      approvedBy: { kind: 'human' },
      approvedAt: now,
      digest: 'b'.repeat(64),
    });
    database
      .prepare(
        `INSERT INTO worker_profiles (
        id, scope, project_id, name, display_name, approved_revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profileId,
        'global',
        null,
        profileRevision.name,
        profileRevision.displayName,
        1,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO worker_profile_revisions (
        profile_id, revision, source_yaml, normalized_json,
        base_profile_id, base_revision, approved_by, approved_at, digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profileId,
        1,
        profileRevision.sourceYaml,
        canonicalJson(profileRevision.document),
        null,
        null,
        canonicalJson(profileRevision.approvedBy),
        now,
        profileRevision.digest,
      );

    const execution = workerExecutionSchema.parse({
      id: randomUUID(),
      projectId: project.id,
      profileId,
      profileRevision: 1,
      assignment: {
        kind: 'foundation-check',
        projectId: project.id,
        title: 'Foundation check',
        instructions: 'Check the Todo repository.',
        fakeScenario: 'todo-foundation-v1',
      },
      profileSnapshot: {
        profileId,
        projectId: null,
        profileRevision: 1,
        baseProfileId: null,
        baseRevision: null,
        document: profileDocument,
        digest: profileRevision.digest,
      },
      skillRequests: { preferred: [], required: [] },
      resolvedSkills: [],
      capabilitySnapshot: {
        adapterId: 'fake',
        capabilities: ['execution.stream'],
        skills: [],
        exactResume: true,
      },
      adapterId: 'fake',
      model: 'deterministic',
      nativeHandle: null,
      lifecycle: 'created',
      revision: 0,
      lastAdapterCursor: 0,
      lastRuntimeSequence: 0,
      replacementForExecutionId: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });
    database
      .prepare(
        `INSERT INTO worker_executions (
        id, project_id, profile_id, profile_revision, assignment_json,
        profile_snapshot_json, skill_requests_json, resolved_skills_json,
        capability_snapshot_json, adapter_id, model, native_handle, lifecycle,
        revision, last_adapter_cursor, last_runtime_sequence,
        replacement_for_execution_id, failure_json, created_at, updated_at,
        ended_at
      ) VALUES (
        @id, @projectId, @profileId, @profileRevision, @assignmentJson,
        @profileSnapshotJson, @skillRequestsJson, @resolvedSkillsJson,
        @capabilitySnapshotJson, @adapterId, @model, @nativeHandle, @lifecycle,
        @revision, @lastAdapterCursor, @lastRuntimeSequence,
        @replacementForExecutionId, @failureJson, @createdAt, @updatedAt,
        @endedAt
      )`,
      )
      .run({
        ...execution,
        assignmentJson: canonicalJson(execution.assignment),
        profileSnapshotJson: canonicalJson(execution.profileSnapshot),
        skillRequestsJson: canonicalJson(execution.skillRequests),
        resolvedSkillsJson: canonicalJson(execution.resolvedSkills),
        capabilitySnapshotJson: canonicalJson(execution.capabilitySnapshot),
        failureJson: null,
      });

    const initializedDatabase = database;
    let closed = false;
    return {
      directory,
      path,
      database: initializedDatabase,
      commands: new V2CommandRepository(initializedDatabase),
      events: new V2EventStore(initializedDatabase),
      project,
      profileRevision,
      execution,
      close() {
        if (closed) return;
        closed = true;
        closeAndRemove(initializedDatabase, directory);
      },
    };
  } catch (error) {
    try {
      if (database) closeAndRemove(database, directory);
      else removeVerifiedTestDirectory(directory);
    } catch (cleanupError) {
      const constructionMessage =
        error instanceof Error ? error.message : String(error);
      const cleanupMessage =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      throw new Error(
        `V2 test database construction failed (${constructionMessage}) and cleanup failed (${cleanupMessage})`,
      );
    }
    throw error;
  }
};
