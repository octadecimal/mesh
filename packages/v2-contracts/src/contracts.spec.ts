import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  V2_PROTOCOL_VERSION,
  WORKER_PROFILE_API_VERSION,
  clientRealtimeMessageSchema,
  domainEventDraftSchema,
  domainEventSchema,
  executionFailureSchema,
  foundationCheckAssignmentSchema,
  harnessCapabilitiesSchema,
  harnessEventEnvelopeSchema,
  harnessOperationResultSchema,
  harnessProbeResultSchema,
  harnessResumeRequestSchema,
  harnessSkillDescriptorSchema,
  harnessStartRequestSchema,
  interruptExecutionEnvelopeSchema,
  logicalSkillRequestSchema,
  parseWorkerProfileYaml,
  profileApprovalEnvelopeSchema,
  projectEventCursorsSchema,
  projectRegisterEnvelopeSchema,
  projectSchema,
  rawDiagnosticDraftSchema,
  rawDiagnosticSchema,
  resolvedWorkerProfileSnapshotSchema,
  resolvedSkillSnapshotSchema,
  retainedDomainWindowSchema,
  retainedRuntimeWindowSchema,
  runtimeEventDraftSchema,
  runtimeEventSchema,
  serverRealtimeMessageSchema,
  startExecutionEnvelopeSchema,
  v2AttentionItemSchema,
  v2CommandSchema,
  v2CommandEnvelopeSchema,
  v2CommandResultSchema,
  v2ErrorCodeSchema,
  v2HealthSchema,
  v2ProjectSnapshotSchema,
  v2SystemSnapshotSchema,
  workerExecutionSchema,
  workerProfileDocumentSchema,
  workerProfileRevisionSchema,
  workerProfileSummarySchema,
} from './index';

const now = '2026-08-28T12:00:00.000Z';
const projectId = randomUUID();
const otherProjectId = randomUUID();
const profileId = randomUUID();
const projectProfileId = randomUUID();
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

const resolvedProfileDocument = {
  ...profileDocument,
  spec: {
    ...profileDocument.spec,
    skills: {
      preferred: [{ id: 'test-driven-development' }],
      required: [{ id: 'verification-before-completion' }],
    },
  },
};

const resolvedProfile = {
  profileId,
  projectId: null,
  profileRevision: 1,
  baseProfileId: null,
  baseRevision: null,
  document: resolvedProfileDocument,
  digest: 'b'.repeat(64),
};

const resolvedProjectProfile = {
  profileId: projectProfileId,
  projectId,
  profileRevision: 1,
  baseProfileId: profileId,
  baseRevision: 1,
  document: {
    ...resolvedProfileDocument,
    metadata: {
      name: 'todo-foundation-worker',
      displayName: 'Todo foundation worker',
      scope: 'project' as const,
    },
  },
  digest: 'd'.repeat(64),
};

const projectProfileDocument = {
  apiVersion: WORKER_PROFILE_API_VERSION,
  kind: 'WorkerProfile' as const,
  metadata: {
    name: 'todo-foundation-worker',
    displayName: 'Todo foundation worker',
    scope: 'project' as const,
  },
  extends: { profile: 'global/foundation-worker', revision: 1 },
  spec: { instructions: 'Check Todo-specific foundation constraints.' },
};

const profileRevision = {
  profileId: projectProfileId,
  scope: 'project' as const,
  projectId,
  name: 'todo-foundation-worker',
  displayName: 'Todo foundation worker',
  revision: 1,
  sourceYaml: 'apiVersion: mesh.dev/v1alpha1',
  document: projectProfileDocument,
  baseProfileId: profileId,
  baseRevision: 1,
  approvedBy: { kind: 'human' as const },
  approvedAt: now,
  digest: 'd'.repeat(64),
};

const globalProfileRevision = {
  profileId,
  scope: 'global' as const,
  projectId: null,
  name: 'foundation-worker',
  displayName: 'Foundation worker',
  revision: 1,
  sourceYaml: 'apiVersion: mesh.dev/v1alpha1',
  document: profileDocument,
  baseProfileId: null,
  baseRevision: null,
  approvedBy: { kind: 'human' as const },
  approvedAt: now,
  digest: 'b'.repeat(64),
};

const globalProfileSummary = {
  profileId,
  projectId: null,
  scope: 'global' as const,
  name: 'foundation-worker',
  displayName: 'Foundation worker',
  approvedRevision: 1,
};

const projectProfileSummary = {
  ...globalProfileSummary,
  profileId: projectProfileId,
  projectId,
  scope: 'project' as const,
  name: 'todo-foundation-worker',
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
      globalProfiles: [globalProfileSummary],
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
    expect(() =>
      v2SystemSnapshotSchema.parse({
        ...system,
        globalProfiles: [projectProfileSummary],
      }),
    ).toThrow(/global/i);
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

  it('round-trips every command schema and envelope variant', () => {
    const register = {
      type: 'project.register' as const,
      repositoryPath: 'C:/code/todo',
      displayName: 'Todo',
    };
    const approve = {
      type: 'worker_profile.approve_revision' as const,
      scope: 'project' as const,
      projectId,
      sourceYaml: 'apiVersion: mesh.dev/v1alpha1',
      expectedLatestRevision: 0,
    };
    const start = {
      type: 'worker_execution.start' as const,
      projectId,
      profileId,
      profileRevision: 1,
      assignment: execution.assignment,
    };
    const interrupt = {
      type: 'worker_execution.interrupt' as const,
      projectId,
      executionId,
      expectedRevision: 0,
    };
    const baseEnvelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' as const },
    };

    expect(v2CommandSchema.parse(register)).toEqual(register);
    expect(v2CommandSchema.parse(approve)).toEqual(approve);
    expect(v2CommandSchema.parse(start)).toEqual(start);
    expect(v2CommandSchema.parse(interrupt)).toEqual(interrupt);
    expect(
      projectRegisterEnvelopeSchema.parse({
        ...baseEnvelope,
        command: register,
      }).command.type,
    ).toBe('project.register');
    expect(
      profileApprovalEnvelopeSchema.parse({
        ...baseEnvelope,
        command: approve,
      }).command.type,
    ).toBe('worker_profile.approve_revision');
    expect(
      startExecutionEnvelopeSchema.parse({ ...baseEnvelope, command: start })
        .command.type,
    ).toBe('worker_execution.start');
    expect(
      interruptExecutionEnvelopeSchema.parse({
        ...baseEnvelope,
        command: interrupt,
      }).command.type,
    ).toBe('worker_execution.interrupt');
    expect(() =>
      v2CommandSchema.parse({ ...register, unexpected: true }),
    ).toThrow();
  });

  it('round-trips the project, assignment, skill, lifecycle, and health primitives', () => {
    expect(projectSchema.parse(project)).toEqual(project);
    expect(foundationCheckAssignmentSchema.parse(execution.assignment)).toEqual(
      execution.assignment,
    );
    expect(
      logicalSkillRequestSchema.parse({ id: 'test-driven-development' }),
    ).toEqual({ id: 'test-driven-development' });
    expect(harnessSkillDescriptorSchema.parse(capabilities.skills[0])).toEqual(
      capabilities.skills[0],
    );
    expect(v2HealthSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(
      v2HealthSchema.parse({
        status: 'audit_barrier_tripped',
        error: {
          code: 'audit_barrier_tripped',
          message: 'audit write failed',
        },
      }).status,
    ).toBe('audit_barrier_tripped');
  });

  it('accepts only the settled preferred and required skill resolution combinations', () => {
    const native = {
      kind: 'native' as const,
      nativeId: 'fake/test-driven-development',
      version: '1.0.0',
      digest: 'c'.repeat(64),
    };
    expect(
      resolvedSkillSnapshotSchema.parse({
        requested: { id: 'test-driven-development' },
        mode: 'preferred',
        resolution: native,
      }).resolution.kind,
    ).toBe('native');
    expect(
      resolvedSkillSnapshotSchema.parse({
        requested: { id: 'verification-before-completion' },
        mode: 'required',
        resolution: native,
      }).resolution.kind,
    ).toBe('native');
    expect(() =>
      resolvedSkillSnapshotSchema.parse({
        requested: { id: 'test-driven-development' },
        mode: 'preferred',
        resolution: { kind: 'unavailable', reason: 'not installed' },
      }),
    ).toThrow(/preferred/i);
    expect(() =>
      resolvedSkillSnapshotSchema.parse({
        requested: { id: 'verification-before-completion' },
        mode: 'required',
        resolution: {
          kind: 'mesh-native-fallback',
          workflow: 'mesh.foundation-check/v1',
        },
      }),
    ).toThrow(/required/i);
  });

  it('requires a harness envelope cursor to equal its normalized event cursor', () => {
    const normalized = {
      projectId,
      executionId,
      adapterCursor: 4,
      occurredAt: now,
      type: 'worker_execution.output' as const,
      payload: { text: 'checking repository' },
    };

    expect(
      harnessEventEnvelopeSchema.parse({
        adapterCursor: 4,
        raw: { line: 'checking repository' },
        normalized,
      }).adapterCursor,
    ).toBe(4);
    expect(() =>
      harnessEventEnvelopeSchema.parse({
        adapterCursor: 5,
        raw: { line: 'checking repository' },
        normalized,
      }),
    ).toThrow(/cursor/i);
  });

  it('enforces project coherence for every authoritative domain event variant', () => {
    const registered = {
      projectId,
      occurredAt: now,
      type: 'project.registered' as const,
      payload: { project },
    };
    const approved = {
      projectId,
      occurredAt: now,
      type: 'worker_profile.revision_approved' as const,
      payload: { profileRevision },
    };
    const lifecycle = {
      projectId,
      occurredAt: now,
      type: 'worker_execution.lifecycle_changed' as const,
      payload: { execution },
    };

    expect(domainEventDraftSchema.parse(registered)).toEqual(registered);
    expect(domainEventDraftSchema.parse(approved)).toEqual(approved);
    expect(domainEventDraftSchema.parse(lifecycle)).toEqual(lifecycle);
    expect(
      domainEventSchema.parse({
        ...approved,
        id: randomUUID(),
        sequence: 2,
      }).type,
    ).toBe('worker_profile.revision_approved');
    expect(
      domainEventSchema.parse({
        ...lifecycle,
        id: randomUUID(),
        sequence: 3,
      }).type,
    ).toBe('worker_execution.lifecycle_changed');
    expect(() =>
      domainEventDraftSchema.parse({
        ...registered,
        projectId: otherProjectId,
      }),
    ).toThrow(/project/i);
    expect(() =>
      domainEventDraftSchema.parse({ ...approved, projectId: otherProjectId }),
    ).toThrow(/project/i);
    expect(() =>
      domainEventDraftSchema.parse({ ...lifecycle, projectId: otherProjectId }),
    ).toThrow(/project/i);
  });

  it('parses normalized completion and bounded missing evidence', () => {
    const completion = {
      projectId,
      executionId,
      adapterCursor: 6,
      occurredAt: now,
      type: 'worker_execution.completed' as const,
      payload: { outcome: 'completed' as const },
    };

    expect(runtimeEventDraftSchema.parse(completion)).toEqual(completion);
    expect(
      runtimeEventSchema.parse({
        ...completion,
        id: randomUUID(),
        diagnosticId: randomUUID(),
        sequence: 6,
      }).type,
    ).toBe('worker_execution.completed');
    expect(
      executionFailureSchema.parse({
        code: 'required_capability_unavailable',
        message: 'Required capabilities are unavailable',
        missing: ['execution.stream'],
      }).missing,
    ).toEqual(['execution.stream']);
    expect(
      executionFailureSchema.parse({
        code: 'required_skill_unavailable',
        message: 'Required skills are unavailable',
      }),
    ).toEqual({
      code: 'required_skill_unavailable',
      message: 'Required skills are unavailable',
    });
  });

  it('keeps completion strict and bounds missing evidence', () => {
    const completion = {
      projectId,
      executionId,
      adapterCursor: 6,
      occurredAt: now,
      type: 'worker_execution.completed' as const,
      payload: { outcome: 'completed' as const },
    };

    expect(() =>
      runtimeEventDraftSchema.parse({
        ...completion,
        payload: { outcome: 'completed', providerSessionId: 'native-1' },
      }),
    ).toThrow();
    expect(() =>
      runtimeEventDraftSchema.parse({
        ...completion,
        sessionId: executionId,
      }),
    ).toThrow();
    expect(() =>
      executionFailureSchema.parse({
        code: 'required_skill_unavailable',
        message: 'Unavailable',
        missing: [],
      }),
    ).toThrow();
    expect(() =>
      executionFailureSchema.parse({
        code: 'required_skill_unavailable',
        message: 'Unavailable',
        missing: Array.from({ length: 65 }, (_, index) => `skill-${index}`),
      }),
    ).toThrow();
    expect(() =>
      executionFailureSchema.parse({
        code: 'required_skill_unavailable',
        message: 'Unavailable',
        missing: ['x'.repeat(257)],
      }),
    ).toThrow();
    expect(() =>
      domainEventDraftSchema.parse({
        projectId,
        occurredAt: now,
        type: 'worker_execution.failed',
        payload: { execution },
      }),
    ).toThrow();
  });

  it('round-trips every runtime event and raw diagnostic variant', () => {
    const runtimeBase = {
      projectId,
      executionId,
      adapterCursor: 1,
      occurredAt: now,
    };
    const output = {
      ...runtimeBase,
      type: 'worker_execution.output' as const,
      payload: { text: 'checking' },
    };
    const childStarted = {
      ...runtimeBase,
      type: 'worker_execution.child_started' as const,
      payload: { childId: 'child-1', title: 'Inspect files' },
    };
    const childFinished = {
      ...runtimeBase,
      type: 'worker_execution.child_finished' as const,
      payload: { childId: 'child-1', outcome: 'completed' as const },
    };
    const adapterFailed = {
      ...runtimeBase,
      type: 'worker_execution.adapter_failed' as const,
      payload: { code: 'fake_failure', message: 'fixture failed' },
    };
    expect(runtimeEventDraftSchema.parse(output)).toEqual(output);
    expect(runtimeEventDraftSchema.parse(childStarted)).toEqual(childStarted);
    expect(runtimeEventDraftSchema.parse(childFinished)).toEqual(childFinished);
    expect(runtimeEventDraftSchema.parse(adapterFailed)).toEqual(adapterFailed);

    expect(
      runtimeEventSchema.parse({
        ...output,
        id: randomUUID(),
        diagnosticId: randomUUID(),
        sequence: 1,
      }).type,
    ).toBe('worker_execution.output');
    expect(
      runtimeEventSchema.parse({
        ...childStarted,
        id: randomUUID(),
        diagnosticId: randomUUID(),
        sequence: 2,
      }).type,
    ).toBe('worker_execution.child_started');
    expect(
      runtimeEventSchema.parse({
        ...childFinished,
        id: randomUUID(),
        diagnosticId: randomUUID(),
        sequence: 3,
      }).type,
    ).toBe('worker_execution.child_finished');
    expect(
      runtimeEventSchema.parse({
        ...adapterFailed,
        id: randomUUID(),
        diagnosticId: randomUUID(),
        sequence: 4,
      }).type,
    ).toBe('worker_execution.adapter_failed');
    const raw = {
      projectId,
      executionId,
      adapterId: 'fake',
      adapterCursor: 1,
      receivedAt: now,
      payload: { line: 'checking' },
    };
    expect(rawDiagnosticDraftSchema.parse(raw)).toEqual(raw);
    expect(
      rawDiagnosticSchema.parse({ ...raw, id: randomUUID() }).adapterId,
    ).toBe('fake');
  });

  it('enforces project coherence in realtime event messages', () => {
    const domainEvent = {
      id: randomUUID(),
      projectId,
      sequence: 1,
      occurredAt: now,
      type: 'project.registered' as const,
      payload: { project },
    };
    const runtimeEvent = {
      id: randomUUID(),
      diagnosticId: randomUUID(),
      projectId,
      executionId,
      sequence: 1,
      adapterCursor: 1,
      occurredAt: now,
      type: 'worker_execution.output' as const,
      payload: { text: 'checking' },
    };
    const common = { protocolVersion: V2_PROTOCOL_VERSION, projectId };

    expect(
      serverRealtimeMessageSchema.parse({
        ...common,
        type: 'v2.subscribed',
        cursors: { domain: 1, runtime: 1 },
      }).type,
    ).toBe('v2.subscribed');
    expect(
      serverRealtimeMessageSchema.parse({
        ...common,
        type: 'v2.domain_event',
        event: domainEvent,
      }).type,
    ).toBe('v2.domain_event');
    expect(
      serverRealtimeMessageSchema.parse({
        ...common,
        type: 'v2.runtime_event',
        event: runtimeEvent,
      }).type,
    ).toBe('v2.runtime_event');
    expect(() =>
      serverRealtimeMessageSchema.parse({
        ...common,
        projectId: otherProjectId,
        type: 'v2.domain_event',
        event: domainEvent,
      }),
    ).toThrow(/project/i);
    expect(() =>
      serverRealtimeMessageSchema.parse({
        ...common,
        projectId: otherProjectId,
        type: 'v2.runtime_event',
        event: runtimeEvent,
      }),
    ).toThrow(/project/i);
  });

  it('enforces global and project revision identity and one-level bases', () => {
    expect(
      workerProfileRevisionSchema.parse(globalProfileRevision).document.spec
        .skills?.preferred,
    ).toEqual([{ id: 'test-driven-development' }]);
    expect(workerProfileRevisionSchema.parse(profileRevision)).toEqual(
      profileRevision,
    );
    expect(() =>
      workerProfileRevisionSchema.parse({
        ...globalProfileRevision,
        baseProfileId: projectProfileId,
        baseRevision: 1,
      }),
    ).toThrow(/global|base/i);
    expect(() =>
      workerProfileRevisionSchema.parse({
        ...profileRevision,
        projectId: null,
      }),
    ).toThrow(/project/i);
    expect(() =>
      workerProfileRevisionSchema.parse({
        ...profileRevision,
        baseProfileId: null,
        baseRevision: null,
      }),
    ).toThrow(/base|extends/i);
    expect(() =>
      workerProfileRevisionSchema.parse({
        ...profileRevision,
        baseRevision: 2,
      }),
    ).toThrow(/revision|extends/i);
    expect(() =>
      workerProfileRevisionSchema.parse({
        ...profileRevision,
        document: {
          ...projectProfileDocument,
          extends: undefined,
          spec: profileDocument.spec,
        },
      }),
    ).toThrow(/base|extends/i);
  });

  it('enforces global and project identity in summaries and resolved snapshots', () => {
    expect(workerProfileSummarySchema.parse(globalProfileSummary)).toEqual(
      globalProfileSummary,
    );
    expect(workerProfileSummarySchema.parse(projectProfileSummary)).toEqual(
      projectProfileSummary,
    );
    expect(() =>
      workerProfileSummarySchema.parse({ ...globalProfileSummary, projectId }),
    ).toThrow(/project/i);
    expect(() =>
      workerProfileSummarySchema.parse({
        ...projectProfileSummary,
        projectId: null,
      }),
    ).toThrow(/project/i);
    expect(resolvedWorkerProfileSnapshotSchema.parse(resolvedProfile)).toEqual(
      resolvedProfile,
    );
    expect(
      resolvedWorkerProfileSnapshotSchema.parse(resolvedProjectProfile),
    ).toEqual(resolvedProjectProfile);
    expect(() =>
      resolvedWorkerProfileSnapshotSchema.parse({
        ...resolvedProfile,
        baseProfileId: projectProfileId,
        baseRevision: 1,
      }),
    ).toThrow(/global|base/i);
  });

  it('requires harness start and resume request project coherence', () => {
    const start = {
      executionId,
      project,
      assignment: execution.assignment,
      profile: resolvedProfile,
      resolvedSkills: execution.resolvedSkills,
    };
    expect(harnessStartRequestSchema.parse(start)).toEqual(start);
    expect(
      harnessResumeRequestSchema.parse({
        ...start,
        nativeHandle: 'fake-handle-1',
        afterAdapterCursor: 2,
      }).afterAdapterCursor,
    ).toBe(2);
    expect(() =>
      harnessStartRequestSchema.parse({
        ...start,
        assignment: { ...start.assignment, projectId: otherProjectId },
      }),
    ).toThrow(/project/i);
    expect(() =>
      harnessResumeRequestSchema.parse({
        ...start,
        assignment: { ...start.assignment, projectId: otherProjectId },
        nativeHandle: 'fake-handle-1',
        afterAdapterCursor: 2,
      }),
    ).toThrow(/project/i);
  });

  it('accepts global and matching-project profiles for harness start and resume', () => {
    const globalStart = {
      executionId,
      project,
      assignment: execution.assignment,
      profile: resolvedProfile,
      resolvedSkills: execution.resolvedSkills,
    };
    const projectStart = {
      ...globalStart,
      profile: resolvedProjectProfile,
    };

    expect(harnessStartRequestSchema.parse(globalStart).profile.projectId).toBe(
      null,
    );
    expect(
      harnessStartRequestSchema.parse(projectStart).profile.projectId,
    ).toBe(projectId);
    expect(
      harnessResumeRequestSchema.parse({
        ...globalStart,
        nativeHandle: 'fake-handle-global',
        afterAdapterCursor: 1,
      }).profile.projectId,
    ).toBe(null);
    expect(
      harnessResumeRequestSchema.parse({
        ...projectStart,
        nativeHandle: 'fake-handle-project',
        afterAdapterCursor: 1,
      }).profile.projectId,
    ).toBe(projectId);
  });

  it('rejects a cross-project profile snapshot from a harness start request', () => {
    expect(() =>
      harnessStartRequestSchema.parse({
        executionId,
        project,
        assignment: execution.assignment,
        profile: {
          ...resolvedProjectProfile,
          projectId: otherProjectId,
        },
        resolvedSkills: execution.resolvedSkills,
      }),
    ).toThrow(/project/i);
  });

  it('rejects a cross-project profile snapshot from a harness resume request', () => {
    expect(() =>
      harnessResumeRequestSchema.parse({
        executionId,
        project,
        assignment: execution.assignment,
        profile: {
          ...resolvedProjectProfile,
          projectId: otherProjectId,
        },
        resolvedSkills: execution.resolvedSkills,
        nativeHandle: 'fake-handle-project',
        afterAdapterCursor: 1,
      }),
    ).toThrow(/project/i);
  });

  it('requires a project-scoped execution profile snapshot to match the execution project', () => {
    const projectExecution = {
      ...execution,
      profileId: projectProfileId,
      profileSnapshot: resolvedProjectProfile,
    };

    expect(workerExecutionSchema.parse(projectExecution).projectId).toBe(
      projectId,
    );
    expect(() =>
      workerExecutionSchema.parse({
        ...projectExecution,
        profileSnapshot: {
          ...resolvedProjectProfile,
          projectId: otherProjectId,
        },
      }),
    ).toThrow(/project/i);
  });

  it('enforces project snapshot coherence for executions and profile snapshots', () => {
    const snapshot = {
      protocolVersion: V2_PROTOCOL_VERSION,
      project,
      profiles: [resolvedProfile, resolvedProjectProfile],
      executions: [execution],
      attentionItems: [],
      cursors: { domain: 0, runtime: 0 },
    };
    expect(v2ProjectSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() =>
      v2ProjectSnapshotSchema.parse({
        ...snapshot,
        executions: [
          {
            ...execution,
            projectId: otherProjectId,
            assignment: { ...execution.assignment, projectId: otherProjectId },
          },
        ],
      }),
    ).toThrow(/project/i);
    expect(() =>
      v2ProjectSnapshotSchema.parse({
        ...snapshot,
        profiles: [
          resolvedProfile,
          { ...resolvedProjectProfile, projectId: otherProjectId },
        ],
      }),
    ).toThrow(/project/i);
  });

  it('round-trips retained windows, cursors, attention, and every probe result', () => {
    const cursors = { domain: 2, runtime: 3 };
    expect(projectEventCursorsSchema.parse(cursors)).toEqual(cursors);
    expect(
      retainedDomainWindowSchema.parse({
        lowWater: 0,
        highWater: 0,
        events: [],
      }),
    ).toEqual({ lowWater: 0, highWater: 0, events: [] });
    expect(
      retainedRuntimeWindowSchema.parse({
        lowWater: 0,
        highWater: 0,
        events: [],
      }),
    ).toEqual({ lowWater: 0, highWater: 0, events: [] });
    expect(
      v2AttentionItemSchema.parse({
        executionId,
        code: 'audit_barrier_tripped',
        message: 'operator attention required',
      }).code,
    ).toBe('audit_barrier_tripped');
    expect(
      harnessProbeResultSchema.parse({
        status: 'resumable',
        afterAdapterCursor: 3,
      }).status,
    ).toBe('resumable');
    expect(
      harnessProbeResultSchema.parse({
        status: 'terminal',
        outcome: 'completed',
      }).status,
    ).toBe('terminal');
    expect(
      harnessProbeResultSchema.parse({ status: 'missing', reason: 'gone' })
        .status,
    ).toBe('missing');
    expect(
      harnessProbeResultSchema.parse({ status: 'unknown', reason: 'offline' })
        .status,
    ).toBe('unknown');
    expect(harnessOperationResultSchema.parse({ status: 'succeeded' })).toEqual(
      { status: 'succeeded' },
    );
    expect(
      harnessOperationResultSchema.parse({
        status: 'already_terminal',
        reason: 'complete',
      }).status,
    ).toBe('already_terminal');
    expect(
      harnessOperationResultSchema.parse({
        status: 'unknown',
        reason: 'offline',
      }).status,
    ).toBe('unknown');
  });

  it('parses YAML profiles and round-trips every command result success variant', () => {
    const parsed = parseWorkerProfileYaml(
      `apiVersion: mesh.dev/v1alpha1\nkind: WorkerProfile\nmetadata:\n  name: foundation-worker\n  displayName: Foundation worker\n  scope: global\nspec:\n  assignmentKinds: [foundation-check]\n  preferredRuntime: { harness: fake, model: deterministic }\n  alternatives: []\n  requiredCapabilities: [execution.stream]\n  skills:\n    preferred: [test-driven-development]\n    required: [verification-before-completion]\n  instructions: Inspect safely.\n  outputSchema: mesh.dev/foundation-report/v1\n`,
    );
    expect(parsed.metadata.name).toBe('foundation-worker');
    expect(
      v2CommandResultSchema.parse({
        ok: true,
        commandType: 'project.register',
        project,
      }).commandType,
    ).toBe('project.register');
    expect(
      v2CommandResultSchema.parse({
        ok: true,
        commandType: 'worker_profile.approve_revision',
        profileRevision,
      }).commandType,
    ).toBe('worker_profile.approve_revision');
    expect(
      v2CommandResultSchema.parse({
        ok: true,
        commandType: 'worker_execution.start',
        execution,
      }).commandType,
    ).toBe('worker_execution.start');
    expect(
      v2CommandResultSchema.parse({
        ok: true,
        commandType: 'worker_execution.interrupt',
        execution,
      }).commandType,
    ).toBe('worker_execution.interrupt');
  });
});
