import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import {
  projectRegisterEnvelopeSchema,
  projectSchema,
  type DomainEvent,
  type Project,
  type ProjectRegisterEnvelope,
  type V2CommandResult,
  type V2ErrorCode,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import {
  hashV2Command,
  V2CommandRepository,
  V2IdempotencyConflictError,
} from '../storage/command-repository.js';
import { V2EventStore } from '../storage/event-store.js';
import { ProjectRepository } from './project-repository.js';
import {
  normalizeRepositoryIdentityPath,
  RepositoryIdentityError,
  type ResolveRepositoryIdentity,
} from './repository-identity.js';

type ProjectRegistrationFailureCode = Extract<
  V2ErrorCode,
  | 'idempotency_conflict'
  | 'invalid_request'
  | 'repository_head_ambiguous'
  | 'repository_head_failed'
  | 'repository_head_unborn'
  | 'repository_identity_conflict'
  | 'repository_invalid'
  | 'repository_path_escape'
>;

const failure = (
  code: ProjectRegistrationFailureCode,
  message: string,
): V2CommandResult => ({
  ok: false,
  commandType: 'project.register',
  error: { code, message },
});

export type ProjectServiceDependencies = {
  database: V2Database;
  projects: ProjectRepository;
  commands: V2CommandRepository;
  events: V2EventStore;
  resolveRepositoryIdentity: ResolveRepositoryIdentity;
  now?: () => string;
  projectId?: () => string;
  publish?: (event: DomainEvent) => void;
};

export class ProjectService {
  private readonly now: () => string;
  private readonly projectId: () => string;
  private readonly publish: (event: DomainEvent) => void;

  constructor(private readonly dependencies: ProjectServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.projectId = dependencies.projectId ?? randomUUID;
    this.publish = dependencies.publish ?? (() => undefined);
  }

  async register(envelope: ProjectRegisterEnvelope): Promise<V2CommandResult> {
    const parsedEnvelope = projectRegisterEnvelopeSchema.safeParse(envelope);
    if (!parsedEnvelope.success) {
      return failure('invalid_request', 'Invalid project registration command');
    }
    const commandEnvelope = parsedEnvelope.data;
    const requestHash = hashV2Command(commandEnvelope.command);
    try {
      const stored = this.dependencies.commands.find(
        commandEnvelope.idempotencyKey,
        requestHash,
      );
      if (stored) return stored.result;
    } catch (error) {
      if (error instanceof V2IdempotencyConflictError) {
        return failure(error.code, error.message);
      }
      throw error;
    }

    let identity;
    try {
      identity = await this.dependencies.resolveRepositoryIdentity(
        commandEnvelope.command.repositoryPath,
      );
    } catch (error) {
      if (error instanceof RepositoryIdentityError) {
        return failure(error.code, error.message);
      }
      throw error;
    }

    const existingIdentity = this.dependencies.projects.getByRepositoryIdentity(
      identity.repositoryIdentity,
    );
    if (existingIdentity) {
      if (
        normalizeRepositoryIdentityPath(existingIdentity.repositoryPath) !==
        normalizeRepositoryIdentityPath(identity.canonicalPath)
      ) {
        return failure(
          'repository_identity_conflict',
          'Repository identity is already registered at a different path',
        );
      }
      const result: V2CommandResult = {
        ok: true,
        commandType: 'project.register',
        project: existingIdentity,
      };
      inImmediateTransaction(this.dependencies.database, () => {
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: commandEnvelope.idempotencyKey,
          commandType: 'project.register',
          requestHash,
          result,
          createdAt: this.now(),
        });
      });
      return result;
    }

    const pathClaim = this.dependencies.projects
      .list()
      .find(
        (project) =>
          normalizeRepositoryIdentityPath(project.repositoryPath) ===
          normalizeRepositoryIdentityPath(identity.canonicalPath),
      );
    if (pathClaim) {
      return failure(
        'repository_identity_conflict',
        'Repository path is already registered with a different identity',
      );
    }

    const occurredAt = this.now();
    const project = projectSchema.parse({
      id: this.projectId(),
      displayName:
        commandEnvelope.command.displayName ?? basename(identity.canonicalPath),
      repositoryIdentity: identity.repositoryIdentity,
      repositoryPath: identity.canonicalPath,
      gitCommonDirectory: identity.commonDirectory,
      headCommit: identity.headCommit,
      revision: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    const result: V2CommandResult = {
      ok: true,
      commandType: 'project.register',
      project,
    };
    const event = inImmediateTransaction(this.dependencies.database, () => {
      this.dependencies.projects.insertInTransaction(project);
      const storedEvent = this.dependencies.events.appendDomainInTransaction(
        project.id,
        {
          projectId: project.id,
          occurredAt,
          type: 'project.registered',
          payload: { project },
        },
      );
      this.dependencies.commands.storeInTransaction({
        idempotencyKey: commandEnvelope.idempotencyKey,
        commandType: 'project.register',
        requestHash,
        result,
        createdAt: occurredAt,
      });
      return storedEvent;
    });
    this.publish(event);
    return result;
  }

  list(): Project[] {
    return this.dependencies.projects.list();
  }

  get(projectId: string): Project | undefined {
    return this.dependencies.projects.get(projectId);
  }
}
