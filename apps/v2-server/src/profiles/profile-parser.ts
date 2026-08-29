import { createHash } from 'node:crypto';

import {
  resolvedWorkerProfileSnapshotSchema,
  workerProfileDocumentSchema,
  workerProfileRevisionSchema,
  type ResolvedWorkerProfileDocument,
  type ResolvedWorkerProfileSnapshot,
  type WorkerProfileDocument,
  type WorkerProfileRevision,
} from '@mesh/v2-contracts';
import { parseDocument } from 'yaml';

import { canonicalJson } from '../storage/canonical-json.js';

const MAX_PROFILE_BYTES = 64 * 1024;
const SPECIALIZATION_SEPARATOR = '\n\nProject specialization:\n';

export const parseWorkerProfileYaml = (
  sourceYaml: string,
): WorkerProfileDocument => {
  if (Buffer.byteLength(sourceYaml, 'utf8') > MAX_PROFILE_BYTES) {
    throw new RangeError('Worker profile YAML must not exceed 64 KiB');
  }

  const yamlDocument = parseDocument(sourceYaml, {
    strict: true,
    uniqueKeys: true,
  });
  if (yamlDocument.errors.length > 0) {
    throw new Error(
      `Worker profile YAML is invalid: ${yamlDocument.errors
        .map((error) => error.message)
        .join('; ')}`,
    );
  }

  let input: unknown;
  try {
    input = yamlDocument.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Worker profile YAML aliases are not allowed: ${message}`);
  }
  return workerProfileDocumentSchema.parse(input);
};

export const canonicalProfileDigest = (
  document: WorkerProfileDocument,
): string => createHash('sha256').update(canonicalJson(document)).digest('hex');

const requirePinnedGlobalBase = (
  revision: WorkerProfileRevision,
  base: WorkerProfileRevision | undefined,
): WorkerProfileRevision => {
  if (!base) throw new Error('Project profile extension base is missing');
  if (base.scope !== 'global' || base.projectId !== null) {
    throw new Error('Project profile extension base must be global');
  }
  if (base.document.extends !== undefined) {
    throw new Error('Project profile extension base cannot itself extend');
  }
  if (
    revision.baseProfileId !== base.profileId ||
    revision.baseRevision !== base.revision
  ) {
    throw new Error('Project profile extension does not match its pinned base');
  }
  const requested = revision.document.extends;
  if (
    !requested ||
    requested.profile !== `global/${base.name}` ||
    requested.revision !== base.revision
  ) {
    throw new Error('Project profile extension does not match its pinned base');
  }
  return base;
};

export const resolveWorkerProfileSnapshot = (
  revision: WorkerProfileRevision,
  base?: WorkerProfileRevision,
): ResolvedWorkerProfileSnapshot => {
  const parsedRevision = workerProfileRevisionSchema.parse(revision);
  let document: ResolvedWorkerProfileDocument;

  if (parsedRevision.document.extends === undefined) {
    if (base !== undefined) {
      throw new Error('Independent profiles cannot be resolved with a base');
    }
    document = {
      apiVersion: parsedRevision.document.apiVersion,
      kind: parsedRevision.document.kind,
      metadata: parsedRevision.document.metadata,
      spec: parsedRevision.document.spec,
    } as ResolvedWorkerProfileDocument;
  } else {
    if (parsedRevision.scope !== 'project') {
      throw new Error('Only project profiles may resolve an extension');
    }
    const parsedBase = requirePinnedGlobalBase(parsedRevision, base);
    const childSpec = parsedRevision.document.spec;
    document = {
      apiVersion: parsedRevision.document.apiVersion,
      kind: parsedRevision.document.kind,
      metadata: parsedRevision.document.metadata,
      spec: {
        ...parsedBase.document.spec,
        ...childSpec,
        instructions:
          childSpec.instructions === undefined
            ? parsedBase.document.spec.instructions
            : `${parsedBase.document.spec.instructions}${SPECIALIZATION_SEPARATOR}${childSpec.instructions}`,
      },
    } as ResolvedWorkerProfileDocument;
  }

  const digest = canonicalProfileDigest(document);
  return resolvedWorkerProfileSnapshotSchema.parse({
    profileId: parsedRevision.profileId,
    projectId: parsedRevision.projectId,
    profileRevision: parsedRevision.revision,
    baseProfileId: parsedRevision.baseProfileId,
    baseRevision: parsedRevision.baseRevision,
    document,
    digest,
  });
};
