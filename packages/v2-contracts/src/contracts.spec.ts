import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  V2_PROTOCOL_VERSION,
  WORKER_PROFILE_API_VERSION,
  clientRealtimeMessageSchema,
  domainEventSchema,
  harnessCapabilitiesSchema,
  resolvedSkillSnapshotSchema,
  runtimeEventSchema,
  serverRealtimeMessageSchema,
  v2CommandEnvelopeSchema,
  v2CommandResultSchema,
  v2ErrorCodeSchema,
  v2ProjectSnapshotSchema,
  v2SystemSnapshotSchema,
  workerExecutionSchema,
  workerProfileDocumentSchema,
} from './index';

const now = '2026-08-28T12:00:00.000Z';
const projectId = randomUUID();
const profileId = randomUUID();
const executionId = randomUUID();

const project = {
  id: projectId,
  displayName: 'Todo',
  repositoryIdentity: 'C:/code/todo/.git',
  repositoryPath: 'C:/code/todo',
  gitCommonDirectory: 'C:/code/todo/.git',
  headCommit: 'a'.repeat(40),
  revision: 0,
  createdAt: now,
  updatedAt: now,
};

const profileDocument = {
  apiVersion: WORKER_PROFILE_API_VERSION,
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
    skills: {
      preferred: ['test-driven-development'],
      required: ['verification-before-completion'],
    },
    instructions: 'Inspect the repository without writing it.',
    outputSchema: 'mesh.dev/foundation-report/v1',
  },
};

const resolvedProfile = {
  profileId,
  profileRevision: 1,
  baseProfileId: null,
  baseRevision: null,
  document: profileDocument,
  digest: 'b'.repeat(64),
};

const capabilities = {
  adapterId: 'fake',
  capabilities: ['execution.stream', 'execution.resume'],
  skills: [
    {
      logicalId: 'verification-before-completion',
      nativeId: 'fake/verification-before-completion',
      version: '1.0.0',
      digest: 'c'.repeat(64),
    },
  ],
  exactResume: true,
};

const execution = {
  id: executionId,
  projectId,
  profileId,
  profileRevision: 1,
  assignment: {
    kind: 'foundation-check' as const,
    projectId,
    title: 'Inspect Todo foundation',
    instructions: 'Read without modifying the repository.',
    fakeScenario: 'todo-foundation-v1' as const,
  },
  profileSnapshot: resolvedProfile,
  skillRequests: {
    preferred: [{ id: 'test-driven-development' }],
    required: [{ id: 'verification-before-completion' }],
  },
  resolvedSkills: [
    {
      requested: { id: 'test-driven-development' },
      mode: 'preferred' as const,
      resolution: {
        kind: 'mesh-native-fallback' as const,
        workflow: 'mesh.foundation-check/v1',
      },
    },
  ],
  capabilitySnapshot: capabilities,
  adapterId: 'fake',
  model: 'deterministic',
  nativeHandle: null,
  lifecycle: 'created' as const,
  revision: 0,
  lastAdapterCursor: 0,
  lastRuntimeSequence: 0,
  replacementForExecutionId: null,
  failure: null,
  createdAt: now,
  updatedAt: now,
  endedAt: null,
};

describe('V2 foundation contracts', () => {
  it('keeps protocol literals exact and schemas strict', () => {
    expect(V2_PROTOCOL_VERSION).toBe('mesh.v2/1');
    expect(WORKER_PROFILE_API_VERSION).toBe('mesh.dev/v1alpha1');
    expect(() =>
      harnessCapabilitiesSchema.parse({ ...capabilities, provider: 'claude' }),
    ).toThrow();
    expect(() =>
      workerExecutionSchema.parse({ ...execution, lifecycle: 'stopped' }),
    ).toThrow();
  });

  it('normalizes logical skill shorthand and rejects provider-native state', () => {
    const parsed = workerProfileDocumentSchema.parse(profileDocument);

    expect(parsed.spec.skills?.preferred).toEqual([
      { id: 'test-driven-development' },
    ]);
    expect(() =>
      workerExecutionSchema.parse({
        ...execution,
        providerSessionId: 'claude-session-1',
      }),
    ).toThrow();
  });

  it('rejects duplicate preferred and required logical skill requests', () => {
    expect(() =>
      workerProfileDocumentSchema.parse({
        ...profileDocument,
        spec: {
          ...profileDocument.spec,
          skills: {
            preferred: ['verification-before-completion'],
            required: ['verification-before-completion'],
          },
        },
      }),
    ).toThrow(/duplicate/i);
  });

  it('requires project scope for an extending profile', () => {
    expect(() =>
      workerProfileDocumentSchema.parse({
        ...profileDocument,
        extends: { profile: 'global/foundation-worker', revision: 1 },
      }),
    ).toThrow();
  });

  it('accepts each command discriminant and rejects mismatched assignment projects', () => {
    const commands = [
      { type: 'project.register', repositoryPath: 'C:/code/todo' },
      {
        type: 'worker_profile.approve_revision',
        scope: 'global',
        sourceYaml: 'apiVersion: mesh.dev/v1alpha1',
        expectedLatestRevision: 0,
      },
      {
        type: 'worker_execution.start',
        projectId,
        profileId,
        profileRevision: 1,
        assignment: execution.assignment,
      },
      {
        type: 'worker_execution.interrupt',
        projectId,
        executionId,
        expectedRevision: 1,
      },
    ];

    for (const command of commands) {
      expect(
        v2CommandEnvelopeSchema.parse({
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command,
        }).command.type,
      ).toBe(command.type);
    }

    expect(() =>
      v2CommandEnvelopeSchema.parse({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          ...commands[2],
          assignment: { ...execution.assignment, projectId: randomUUID() },
        },
      }),
    ).toThrow();
  });

  it('represents preferred fallback and required unavailability distinctly', () => {
    expect(
      resolvedSkillSnapshotSchema.parse(execution.resolvedSkills[0]).resolution
        .kind,
    ).toBe('mesh-native-fallback');
    expect(
      resolvedSkillSnapshotSchema.parse({
        requested: { id: 'verification-before-completion' },
        mode: 'required',
        resolution: { kind: 'unavailable', reason: 'not installed' },
      }).resolution.kind,
    ).toBe('unavailable');
  });

  it('keeps domain and runtime streams structurally distinct', () => {
    const domain = domainEventSchema.parse({
      id: randomUUID(),
      projectId,
      sequence: 1,
      occurredAt: now,
      type: 'project.registered',
      payload: { project },
    });
    const runtime = runtimeEventSchema.parse({
      id: randomUUID(),
      projectId,
      executionId,
      diagnosticId: randomUUID(),
      sequence: 1,
      adapterCursor: 1,
      occurredAt: now,
      type: 'worker_execution.output',
      payload: { text: 'inspecting Todo' },
    });

    expect(domain.type).toBe('project.registered');
    expect(runtime.type).toBe('worker_execution.output');
    expect(() => domainEventSchema.parse(runtime)).toThrow();
    expect(() => runtimeEventSchema.parse(domain)).toThrow();
  });

  it('round-trips system and project snapshots without provider fields', () => {
    const system = {
      protocolVersion: V2_PROTOCOL_VERSION,
      health: { status: 'ok' as const },
      projects: [project],
      globalProfiles: [],
    };
    const projectSnapshot = {
      protocolVersion: V2_PROTOCOL_VERSION,
      project,
      profiles: [resolvedProfile],
      executions: [execution],
      attentionItems: [],
      cursors: { domain: 0, runtime: 0 },
    };

    expect(v2SystemSnapshotSchema.parse(system)).toEqual(system);
    const parsedProjectSnapshot =
      v2ProjectSnapshotSchema.parse(projectSnapshot);
    expect(v2ProjectSnapshotSchema.parse(parsedProjectSnapshot)).toEqual(
      parsedProjectSnapshot,
    );
    expect(() =>
      v2ProjectSnapshotSchema.parse({
        ...projectSnapshot,
        providerSessions: [],
      }),
    ).toThrow();
  });

  it('keeps command failures and realtime resync messages closed', () => {
    expect(v2ErrorCodeSchema.parse('required_capability_unavailable')).toBe(
      'required_capability_unavailable',
    );
    for (const code of [
      'repository_head_unborn',
      'repository_head_failed',
      'repository_head_ambiguous',
    ]) {
      expect(v2ErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(
      v2CommandResultSchema.parse({
        ok: false,
        commandType: 'worker_execution.start',
        error: {
          code: 'required_capability_unavailable',
          message: 'execution.resume is unavailable',
        },
      }).ok,
    ).toBe(false);

    const client = clientRealtimeMessageSchema.parse({
      type: 'v2.subscribe',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      cursors: { domain: 0, runtime: 0 },
    });
    const server = serverRealtimeMessageSchema.parse({
      type: 'v2.resync_required',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId,
      reason: 'retained_gap',
    });

    expect(client.type).toBe('v2.subscribe');
    expect(server.type).toBe('v2.resync_required');
    expect(() =>
      serverRealtimeMessageSchema.parse({ ...server, cursor: 1 }),
    ).toThrow();
  });
});
