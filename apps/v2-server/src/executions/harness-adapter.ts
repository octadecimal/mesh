import type {
  HarnessCapabilities,
  HarnessSkillDescriptor,
  LogicalSkillRequest,
  ResolvedSkillSnapshot,
  WorkerExecutionLifecycle,
} from '@mesh/v2-contracts';

export type {
  HarnessAdapter,
  HarnessSession,
  HarnessStartRequest,
  HarnessResumeRequest,
  HarnessProbeResult,
  HarnessOperationResult,
} from '@mesh/v2-contracts';

export const legalExecutionTransitions = new Set<string>([
  'created:starting',
  'created:failed',
  'starting:running',
  'starting:failed',
  'starting:attention_required',
  'running:completed',
  'running:failed',
  'running:interrupting',
  'running:attention_required',
  'interrupting:interrupted',
  'interrupting:failed',
  'interrupting:attention_required',
]);

export const assertLegalExecutionTransition = (
  from: WorkerExecutionLifecycle,
  to: WorkerExecutionLifecycle,
): void => {
  if (!legalExecutionTransitions.has(`${from}:${to}`)) {
    throw new Error(`Illegal execution lifecycle transition ${from}:${to}`);
  }
};

type Semver = { major: number; minor: number; patch: number };

const parseStableSemver = (value: string): Semver | undefined => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};

export const satisfiesSkillVersion = (
  actual: string | undefined,
  constraint: string | undefined,
): boolean => {
  if (constraint === undefined) return true;
  if (actual === undefined) return false;
  const version = parseStableSemver(actual);
  if (!version) return false;
  if (!constraint.startsWith('^')) return constraint === actual;
  const minimum = parseStableSemver(constraint.slice(1));
  if (!minimum) return false;
  const actualTuple = [version.major, version.minor, version.patch] as const;
  const minimumTuple = [minimum.major, minimum.minor, minimum.patch] as const;
  const compare = (left: readonly number[], right: readonly number[]) => {
    for (let index = 0; index < left.length; index += 1) {
      const leftPart = left[index] ?? 0;
      const rightPart = right[index] ?? 0;
      if (leftPart !== rightPart) return leftPart - rightPart;
    }
    return 0;
  };
  if (compare(actualTuple, minimumTuple) < 0) return false;
  if (minimum.major > 0) return version.major === minimum.major;
  if (minimum.minor > 0) {
    return version.major === 0 && version.minor === minimum.minor;
  }
  return (
    version.major === 0 &&
    version.minor === 0 &&
    version.patch === minimum.patch
  );
};

export const matchingSkill = (
  request: LogicalSkillRequest,
  descriptors: readonly HarnessSkillDescriptor[],
): HarnessSkillDescriptor | undefined => {
  const compatible = descriptors.filter(
    (descriptor) =>
      descriptor.logicalId === request.id &&
      satisfiesSkillVersion(descriptor.version, request.constraint?.version) &&
      (request.constraint?.digest === undefined ||
        descriptor.digest === request.constraint.digest),
  );
  return compatible.length === 1 ? compatible[0] : undefined;
};

export const resolveSkillSnapshots = (
  capabilities: HarnessCapabilities,
  preferred: readonly LogicalSkillRequest[],
  required: readonly LogicalSkillRequest[],
): readonly ResolvedSkillSnapshot[] => [
  ...preferred.map((requested): ResolvedSkillSnapshot => {
    const descriptor = matchingSkill(requested, capabilities.skills);
    return {
      requested,
      mode: 'preferred',
      resolution: descriptor
        ? {
            kind: 'native',
            nativeId: descriptor.nativeId,
            version: descriptor.version,
            digest: descriptor.digest,
          }
        : {
            kind: 'mesh-native-fallback',
            workflow: 'mesh.foundation-check/v1',
          },
    };
  }),
  ...required.map((requested): ResolvedSkillSnapshot => {
    const descriptor = matchingSkill(requested, capabilities.skills);
    return {
      requested,
      mode: 'required',
      resolution: descriptor
        ? {
            kind: 'native',
            nativeId: descriptor.nativeId,
            version: descriptor.version,
            digest: descriptor.digest,
          }
        : {
            kind: 'unavailable',
            reason: `Required skill ${requested.id} is unavailable`,
          },
    };
  }),
];
