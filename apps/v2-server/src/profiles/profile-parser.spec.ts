import type { WorkerProfileRevision } from '@mesh/v2-contracts';

import {
  canonicalProfileDigest,
  parseWorkerProfileYaml,
  resolveWorkerProfileSnapshot,
} from './profile-parser.js';

const fullSpec = `
  assignmentKinds:
    - foundation-check
  preferredRuntime:
    harness: fake
    model: deterministic
  alternatives: []
  requiredCapabilities:
    - execution.stream
  skills:
    preferred:
      - test-driven-development
    required:
      - verification-before-completion
  instructions: Base instruction.
  outputSchema: mesh.dev/foundation-report/v1`;

const globalYaml = `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: foundation-worker
  displayName: Foundation worker
  scope: global
spec:${fullSpec}`;

const revision = (
  overrides: Partial<WorkerProfileRevision> = {},
): WorkerProfileRevision => ({
  profileId: '11111111-1111-4111-8111-111111111111',
  scope: 'global',
  projectId: null,
  name: 'foundation-worker',
  displayName: 'Foundation worker',
  revision: 1,
  sourceYaml: globalYaml,
  document: parseWorkerProfileYaml(globalYaml),
  baseProfileId: null,
  baseRevision: null,
  approvedBy: { kind: 'human' },
  approvedAt: '2026-08-28T00:00:00.000Z',
  digest: 'a'.repeat(64),
  ...overrides,
});

describe('parseWorkerProfileYaml', () => {
  it('normalizes shorthand logical skills through the T01 schema', () => {
    const parsed = parseWorkerProfileYaml(globalYaml);

    expect(parsed.spec.skills).toEqual({
      preferred: [{ id: 'test-driven-development' }],
      required: [{ id: 'verification-before-completion' }],
    });
  });

  it('rejects a document larger than 64 KiB before YAML parsing', () => {
    const oversizedInvalidYaml = `[${'x'.repeat(64 * 1024)}\u{1f600}`;

    expect(() => parseWorkerProfileYaml(oversizedInvalidYaml)).toThrow(
      /64 KiB/,
    );
  });

  it('rejects YAML aliases', () => {
    expect(() =>
      parseWorkerProfileYaml(
        globalYaml
          .replace(
            'alternatives: []',
            'alternatives: &choices []\n  requiredCapabilities: *choices',
          )
          .replace('  requiredCapabilities:\n    - execution.stream\n', ''),
      ),
    ).toThrow(/alias/i);
  });

  it('rejects unknown keys using only the strict T01 schema', () => {
    expect(() =>
      parseWorkerProfileYaml(`${globalYaml}\ncredentials: forbidden`),
    ).toThrow();
  });

  it('rejects instructions longer than 32 KiB', () => {
    const source = globalYaml.replace(
      'instructions: Base instruction.',
      `instructions: ${'x'.repeat(32 * 1024 + 1)}`,
    );

    expect(() => parseWorkerProfileYaml(source)).toThrow();
  });

  it('rejects duplicate logical skill IDs across both modes', () => {
    const source = globalYaml.replace(
      'verification-before-completion',
      'test-driven-development',
    );

    expect(() => parseWorkerProfileYaml(source)).toThrow(
      /Duplicate logical skill request/,
    );
  });
});

describe('resolveWorkerProfileSnapshot', () => {
  const projectYaml = `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: todo-worker
  displayName: Todo worker
  scope: project
extends:
  profile: global/foundation-worker
  revision: 1
spec:
  requiredCapabilities:
    - execution.resume
  instructions: Project instruction.`;

  const projectRevision = (): WorkerProfileRevision =>
    revision({
      profileId: '22222222-2222-4222-8222-222222222222',
      scope: 'project',
      projectId: '33333333-3333-4333-8333-333333333333',
      name: 'todo-worker',
      displayName: 'Todo worker',
      sourceYaml: projectYaml,
      document: parseWorkerProfileYaml(projectYaml),
      baseProfileId: '11111111-1111-4111-8111-111111111111',
      baseRevision: 1,
    });

  it('replaces arrays and appends specialization instructions', () => {
    const snapshot = resolveWorkerProfileSnapshot(
      projectRevision(),
      revision(),
    );

    expect(snapshot.document.spec.requiredCapabilities).toEqual([
      'execution.resume',
    ]);
    expect(snapshot.document.spec.instructions).toBe(
      'Base instruction.\n\nProject specialization:\nProject instruction.',
    );
    expect(snapshot.baseProfileId).toBe('11111111-1111-4111-8111-111111111111');
    expect(snapshot.baseRevision).toBe(1);
    expect(snapshot.document.spec.skills).toEqual(
      revision().document.spec.skills,
    );
  });

  it('produces a canonical digest independent of object key insertion order', () => {
    const parsed = parseWorkerProfileYaml(globalYaml);
    const reordered = {
      kind: parsed.kind,
      apiVersion: parsed.apiVersion,
      spec: parsed.spec,
      metadata: parsed.metadata,
    };

    expect(canonicalProfileDigest(parsed)).toBe(
      canonicalProfileDigest(reordered),
    );
    expect(resolveWorkerProfileSnapshot(revision()).digest).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('rejects a project extension without its pinned base', () => {
    expect(() => resolveWorkerProfileSnapshot(projectRevision())).toThrow(
      /base/i,
    );
  });

  it('rejects a project profile as an extension base', () => {
    const corruptBase = revision({
      scope: 'project',
      projectId: '33333333-3333-4333-8333-333333333333',
      document: {
        ...revision().document,
        metadata: {
          ...revision().document.metadata,
          scope: 'project',
        },
      },
    });

    expect(() =>
      resolveWorkerProfileSnapshot(projectRevision(), corruptBase),
    ).toThrow(/global/i);
  });

  it('rejects a corrupt base that itself extends another profile', () => {
    const corruptBase = {
      ...revision(),
      document: {
        ...revision().document,
        extends: { profile: 'global/other-worker', revision: 1 },
      },
    } as WorkerProfileRevision;

    expect(() =>
      resolveWorkerProfileSnapshot(projectRevision(), corruptBase),
    ).toThrow(/extend/i);
  });

  it('rejects a base whose stable identity differs from the pinned base', () => {
    expect(() =>
      resolveWorkerProfileSnapshot(
        projectRevision(),
        revision({ profileId: '44444444-4444-4444-8444-444444444444' }),
      ),
    ).toThrow(/pinned/i);
  });
});
