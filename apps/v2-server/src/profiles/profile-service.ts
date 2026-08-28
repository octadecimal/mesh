import { randomUUID } from 'node:crypto';

import {
  profileApprovalEnvelopeSchema,
  v2CommandResultSchema,
  workerProfileRevisionSchema,
  type DomainEvent,
  type ProfileApprovalEnvelope,
  type ResolvedWorkerProfileSnapshot,
  type V2CommandResult,
  type V2ErrorCode,
  type WorkerProfileDocument,
  type WorkerProfileRevision,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import {
  hashV2Command,
  V2CommandRepository,
  V2IdempotencyConflictError,
} from '../storage/command-repository.js';
import { V2EventStore } from '../storage/event-store.js';
import {
  canonicalProfileDigest,
  parseWorkerProfileYaml,
  resolveWorkerProfileSnapshot,
} from './profile-parser.js';
import {
  WorkerProfileRepository,
  type WorkerProfileIdentity,
} from './profile-repository.js';

export type ProfileProjectReader = {
  exists(projectId: string): boolean;
};

type Dependencies = {
  database: V2Database;
  commands: V2CommandRepository;
  events: V2EventStore;
  projects: ProfileProjectReader;
  publishDomain: (event: DomainEvent) => void;
  now: () => string;
};

type ApprovalTransactionResult = {
  result: V2CommandResult;
  event?: DomainEvent;
};

const failure = (code: V2ErrorCode, message: string): V2CommandResult =>
  v2CommandResultSchema.parse({
    ok: false,
    commandType: 'worker_profile.approve_revision',
    error: { code, message },
  });

export class WorkerProfileService {
  private readonly profiles: WorkerProfileRepository;

  constructor(private readonly dependencies: Dependencies) {
    this.profiles = new WorkerProfileRepository(dependencies.database);
  }

  approveRevision(envelope: ProfileApprovalEnvelope): V2CommandResult {
    let parsedEnvelope: ProfileApprovalEnvelope;
    try {
      parsedEnvelope = profileApprovalEnvelopeSchema.parse(envelope);
    } catch (error) {
      return failure('invalid_request', this.errorMessage(error));
    }

    const requestHash = hashV2Command(parsedEnvelope.command);
    let transactionResult: ApprovalTransactionResult;
    try {
      transactionResult = inImmediateTransaction(
        this.dependencies.database,
        () => {
          const stored = this.dependencies.commands.find(
            parsedEnvelope.idempotencyKey,
            requestHash,
          );
          if (stored) return { result: stored.result };

          let document: WorkerProfileDocument;
          try {
            document = parseWorkerProfileYaml(
              parsedEnvelope.command.sourceYaml,
            );
          } catch (error) {
            return this.storeFailure(
              parsedEnvelope,
              requestHash,
              'invalid_request',
              this.errorMessage(error),
            );
          }

          return this.approveInTransaction(
            parsedEnvelope,
            requestHash,
            document,
          );
        },
      );
    } catch (error) {
      if (error instanceof V2IdempotencyConflictError) {
        return failure(error.code, error.message);
      }
      throw error;
    }

    if (transactionResult.event) {
      this.dependencies.publishDomain(transactionResult.event);
    }
    return transactionResult.result;
  }

  approvedGlobal(): WorkerProfileRevision[] {
    return this.profiles.approvedGlobal();
  }

  approvedForProject(projectId: string): WorkerProfileRevision[] {
    return this.profiles.approvedForProject(projectId);
  }

  resolveApproved(
    profileId: string,
    revision: number,
  ): ResolvedWorkerProfileSnapshot {
    const profileRevision = this.profiles.revision(profileId, revision);
    if (!profileRevision) {
      throw new Error(
        `Worker profile revision ${profileId}@${revision} was not found`,
      );
    }
    const base =
      profileRevision.baseProfileId === null ||
      profileRevision.baseRevision === null
        ? undefined
        : this.profiles.revision(
            profileRevision.baseProfileId,
            profileRevision.baseRevision,
          );
    return resolveWorkerProfileSnapshot(profileRevision, base);
  }

  private approveInTransaction(
    envelope: ProfileApprovalEnvelope,
    requestHash: string,
    document: WorkerProfileDocument,
  ): ApprovalTransactionResult {
    const { command } = envelope;
    const projectId = command.projectId ?? null;
    if (command.scope === 'project') {
      if (projectId === null || !this.dependencies.projects.exists(projectId)) {
        return this.storeFailure(
          envelope,
          requestHash,
          'project_not_found',
          `Project ${projectId ?? '(missing)'} was not found`,
        );
      }
    }
    if (document.metadata.scope !== command.scope) {
      return this.storeFailure(
        envelope,
        requestHash,
        'profile_scope_invalid',
        'Profile document scope must match the approval command scope',
      );
    }

    const existing = this.profiles.findIdentity(
      command.scope,
      projectId,
      document.metadata.name,
    );
    const latest = existing?.approvedRevision ?? 0;
    if (latest !== command.expectedLatestRevision) {
      return this.storeFailure(
        envelope,
        requestHash,
        'profile_revision_conflict',
        `Expected latest profile revision ${command.expectedLatestRevision}, found ${latest}`,
      );
    }

    let base: WorkerProfileRevision | undefined;
    if (document.extends !== undefined) {
      if (command.scope !== 'project') {
        return this.storeFailure(
          envelope,
          requestHash,
          'profile_scope_invalid',
          'Only project profiles may extend a global profile',
        );
      }
      const baseName = document.extends.profile.slice('global/'.length);
      try {
        base = this.profiles.globalRevisionByName(
          baseName,
          document.extends.revision,
        );
      } catch (error) {
        return this.storeFailure(
          envelope,
          requestHash,
          'profile_scope_invalid',
          `Pinned base profile is corrupt: ${this.errorMessage(error)}`,
        );
      }
      if (!base) {
        return this.storeFailure(
          envelope,
          requestHash,
          'profile_not_found',
          `Pinned global profile ${document.extends.profile}@${document.extends.revision} was not found`,
        );
      }
      if (base.scope !== 'global' || base.document.extends !== undefined) {
        return this.storeFailure(
          envelope,
          requestHash,
          'profile_scope_invalid',
          'Pinned base must be a non-extending global profile',
        );
      }
    }

    const approvedAt = this.dependencies.now();
    const identity: WorkerProfileIdentity = existing ?? {
      id: randomUUID(),
      scope: command.scope,
      projectId,
      name: document.metadata.name,
      displayName: document.metadata.displayName,
      approvedRevision: null,
      createdAt: approvedAt,
      updatedAt: approvedAt,
    };
    const profileRevision = workerProfileRevisionSchema.parse({
      profileId: identity.id,
      scope: command.scope,
      projectId,
      name: document.metadata.name,
      displayName: document.metadata.displayName,
      revision: latest + 1,
      sourceYaml: command.sourceYaml,
      document,
      baseProfileId: base?.profileId ?? null,
      baseRevision: base?.revision ?? null,
      approvedBy: envelope.actor,
      approvedAt,
      digest: canonicalProfileDigest(document),
    });

    try {
      resolveWorkerProfileSnapshot(profileRevision, base);
    } catch (error) {
      return this.storeFailure(
        envelope,
        requestHash,
        'profile_scope_invalid',
        this.errorMessage(error),
      );
    }

    if (!existing) this.profiles.insertIdentityInTransaction(identity);
    this.profiles.insertRevisionInTransaction(profileRevision);
    this.profiles.approveRevisionInTransaction(
      identity.id,
      existing?.approvedRevision ?? null,
      profileRevision,
    );

    const event =
      projectId === null
        ? undefined
        : this.dependencies.events.appendDomainInTransaction(projectId, {
            projectId,
            occurredAt: approvedAt,
            type: 'worker_profile.revision_approved',
            payload: { profileRevision },
          });
    const result = v2CommandResultSchema.parse({
      ok: true,
      commandType: 'worker_profile.approve_revision',
      profileRevision,
    });
    this.dependencies.commands.storeInTransaction({
      idempotencyKey: envelope.idempotencyKey,
      commandType: command.type,
      requestHash,
      result,
      createdAt: approvedAt,
    });
    return { result, event };
  }

  private storeFailure(
    envelope: ProfileApprovalEnvelope,
    requestHash: string,
    code: V2ErrorCode,
    message: string,
  ): ApprovalTransactionResult {
    const result = failure(code, message);
    this.dependencies.commands.storeInTransaction({
      idempotencyKey: envelope.idempotencyKey,
      commandType: envelope.command.type,
      requestHash,
      result,
      createdAt: this.dependencies.now(),
    });
    return { result };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
