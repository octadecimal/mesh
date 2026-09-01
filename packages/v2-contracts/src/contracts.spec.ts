import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  PM_DISCOVERY_REPORT_SCHEMA,
  DEVELOPER_REPORT_SCHEMA,
  V2_PROTOCOL_VERSION,
  WORKER_PROFILE_API_VERSION,
  abandonPlanningCycleEnvelopeSchema,
  approvePlanningProposalEnvelopeSchema,
  approvedIntentLedgerSchema,
  clientRealtimeMessageSchema,
  decisionRecordContentSchema,
  domainEventDraftSchema,
  domainEventSchema,
  developerAttemptSchema,
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerReportSchema,
  developerTaskAssignmentSchema,
  interruptDeveloperAttemptEnvelopeSchema,
  managedWorkspaceSchema,
  replaceDeveloperAttemptExecutionEnvelopeSchema,
  startDeveloperAttemptEnvelopeSchema,
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
  ledgerRecordContentSchema,
  ledgerRelationshipSchema,
  logicalSkillRequestSchema,
  normalizeIntentLedgerApprovedPayload,
  normalizePlanningCommandSuccess,
  parseWorkerProfileYaml,
  planningCycleLifecycleSchema,
  legacyM2PlanningCycleViewSchema as planningCycleViewSchema,
  planningProposalDiffSchema,
  planningProposalSchema,
  planningTurnSchema,
  planningTurnLaunchStateSchema,
  pmDiscoveryAssignmentSchema,
  pmProposalResultSchema,
  pmDiscoveryReportSchema,
  projectIntentContentSchema,
  profileApprovalEnvelopeSchema,
  projectEventCursorsSchema,
  projectRegisterEnvelopeSchema,
  projectSchema,
  rawDiagnosticDraftSchema,
  rawDiagnosticSchema,
  rejectPlanningProposalEnvelopeSchema,
  requirementRecordContentSchema,
  riskRecordContentSchema,
  resolvedWorkerProfileSnapshotSchema,
  resolvedSkillSnapshotSchema,
  retainedDomainWindowSchema,
  retainedRuntimeWindowSchema,
  runtimeEventDraftSchema,
  runtimeEventSchema,
  serverRealtimeMessageSchema,
  startExecutionEnvelopeSchema,
  submitPlanningTurnEnvelopeSchema,
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
const attemptId = randomUUID();
const requirementId = randomUUID();

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

const boardWithoutPlan = (
  emptyReason: 'intent_required' | 'planning_required',
) => ({
  projectId,
  deliveryPlanRevision: null,
  stale: false,
  emptyReason,
  filter: null,
  totalTaskCount: 0,
  matchedTaskCount: 0,
  facets: {
    milestones: [],
    taskLifecycles: [],
    readiness: [],
    priorities: [],
    labels: [],
    requirements: [],
  },
  cards: [],
});

describe('V2 Developer attempt contracts', () => {
  const assignment = {
    kind: 'developer_task' as const,
    projectId,
    attemptId,
    taskId: randomUUID(),
    taskContractRevision: 1,
    taskCurrentRevision: 1,
    deliveryPlanId: randomUUID(),
    deliveryPlanRevision: 1,
    requirementRevisions: [{ recordId: requirementId, recordRevision: 1 }],
    baseCommit: 'a'.repeat(40),
    workspacePath: 'C:\\mesh-data\\worktrees\\attempt',
    title: 'Persist Todo items',
    outcome: 'Todo items survive reload.',
    acceptanceCriteria: ['Reload restores one Todo item.'],
    verification: ['Run the Todo persistence test.'],
    expectedArtifacts: ['src/todos.ts'],
    outputSchema: DEVELOPER_REPORT_SCHEMA,
  };
  const workspace = {
    attemptId,
    repositoryPath: 'C:\\code\\todo',
    repositoryIdentity: 'C:/code/todo/.git',
    branch: 'mesh/developer/attempt',
    path: assignment.workspacePath,
    baseCommit: assignment.baseCommit,
    lifecycle: 'ready' as const,
    ownershipToken: 'mesh-owned-attempt',
    observedHead: assignment.baseCommit,
    observedDirty: false,
    failure: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const completion = {
    schema: DEVELOPER_REPORT_SCHEMA,
    disposition: 'completed' as const,
    attemptId,
    executionId,
    taskId: assignment.taskId,
    taskContractRevision: assignment.taskContractRevision,
    requirementCoverage: [
      {
        recordId: requirementId,
        recordRevision: 1,
        passed: true,
        evidence: [],
      },
    ],
    criterionCoverage: [
      {
        index: 0,
        text: assignment.acceptanceCriteria[0],
        passed: true,
        evidence: [],
      },
    ],
    changedArtifacts: [{ path: 'src/todos.ts', summary: 'Persisted Todo items.' }],
    verification: [
      { command: 'pnpm test todos', passed: true, evidence: [] },
    ],
    unresolvedConcerns: [],
    workspace: { headCommit: assignment.baseCommit, dirty: false },
  };

  it('parses strict Developer assignments, workspace, reports, and commands', () => {
    expect(DEVELOPER_REPORT_SCHEMA).toBe('mesh.dev/developer-report/v1');
    expect(developerTaskAssignmentSchema.parse(assignment)).toEqual(assignment);
    expect(managedWorkspaceSchema.parse(workspace)).toEqual(workspace);
    expect(developerCompletionReportSchema.parse(completion)).toEqual(completion);
    expect(
      developerBlockerReportSchema.parse({
        schema: DEVELOPER_REPORT_SCHEMA,
        disposition: 'blocked',
        attemptId,
        executionId,
        taskId: assignment.taskId,
        taskContractRevision: 1,
        blocker: 'The test database is unavailable.',
        evidence: [],
        suggestedNextAction: 'Restore the test database.',
        preserveWorkspace: true,
        workspace: { headCommit: assignment.baseCommit, dirty: false },
      }),
    ).toMatchObject({ disposition: 'blocked' });
    expect(
      [
        startDeveloperAttemptEnvelopeSchema.parse({
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'developer_attempt.start',
            projectId,
            taskId: assignment.taskId,
            expectedTaskRevision: 1,
            expectedDeliveryPlanId: assignment.deliveryPlanId,
            expectedDeliveryPlanRevision: 1,
            profileId,
            profileRevision: 1,
          },
        }),
        interruptDeveloperAttemptEnvelopeSchema.parse({
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'developer_attempt.interrupt',
            projectId,
            attemptId,
            expectedAttemptRevision: 1,
          },
        }),
        replaceDeveloperAttemptExecutionEnvelopeSchema.parse({
          idempotencyKey: randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'developer_attempt.replace_execution',
            projectId,
            attemptId,
            expectedAttemptRevision: 1,
          },
        }),
      ].map(({ command }) => command.type),
    ).toEqual([
      'developer_attempt.start',
      'developer_attempt.interrupt',
      'developer_attempt.replace_execution',
    ]);
  });

  it.each([
    ['unknown report key', { ...completion, unexpected: true }],
    [
      'mismatched report disposition',
      {
        ...completion,
        disposition: 'blocked',
      },
    ],
    [
      'duplicate criterion indexes',
      {
        ...completion,
        criterionCoverage: [...completion.criterionCoverage, completion.criterionCoverage[0]],
      },
    ],
    [
      'duplicate requirement IDs',
      {
        ...completion,
        requirementCoverage: [...completion.requirementCoverage, completion.requirementCoverage[0]],
      },
    ],
  ])('rejects Developer report with %s', (_reason, report) => {
    expect(developerReportSchema.safeParse(report).success).toBe(false);
  });

  it('rejects a profile that pairs developer output with another assignment', () => {
    expect(
      workerProfileDocumentSchema.safeParse({
        apiVersion: WORKER_PROFILE_API_VERSION,
        kind: 'WorkerProfile',
        metadata: { name: 'wrong-developer', displayName: 'Wrong Developer', scope: 'global' },
        spec: {
          assignmentKinds: ['pm_discovery'],
          preferredRuntime: { harness: 'fake', model: 'fake' },
          alternatives: [],
          requiredCapabilities: [],
          skills: { preferred: [], required: [] },
          instructions: 'Do one task.',
          outputSchema: DEVELOPER_REPORT_SCHEMA,
        },
      }).success,
    ).toBe(false);
    expect(
      workerProfileDocumentSchema.safeParse({
        apiVersion: WORKER_PROFILE_API_VERSION,
        kind: 'WorkerProfile',
        metadata: {
          name: 'foundation-developer-output',
          displayName: 'Foundation Developer Output',
          scope: 'global',
        },
        spec: {
          assignmentKinds: ['foundation-check'],
          preferredRuntime: { harness: 'fake', model: 'fake' },
          alternatives: [],
          requiredCapabilities: [],
          skills: { preferred: [], required: [] },
          instructions: 'Run the foundation check.',
          outputSchema: DEVELOPER_REPORT_SCHEMA,
        },
      }).success,
    ).toBe(false);
  });

  it('parses a Developer attempt with immutable assignment and workspace snapshots', () => {
    expect(
      developerAttemptSchema.parse({
        id: attemptId,
        projectId,
        taskId: assignment.taskId,
        ordinal: 1,
        lifecycle: 'active',
        revision: 1,
        deliveryPlanId: assignment.deliveryPlanId,
        deliveryPlanRevision: 1,
        intentRevision: 1,
        ledgerRevision: 1,
        taskContractRevision: 1,
        taskCurrentRevision: 1,
        requirementRevisions: assignment.requirementRevisions,
        baseCommit: assignment.baseCommit,
        profileId,
        profileRevision: 1,
        assignment,
        workspace,
        controllingExecutionId: executionId,
        executionIds: [executionId],
        reportIds: [],
        attention: null,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      }),
    ).toMatchObject({ id: attemptId, workspace });
  });
});

const asIntentCycleView = <T extends object>(view: T) => ({
  ...view,
  purpose: {
    kind: 'intent' as const,
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
  deliveryPlanProposals: [] as const,
});

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
      planningCycles: [],
      planningHistoryTruncated: false,
      intentLedger: null,
      deliveryPlan: null,
      board: boardWithoutPlan('intent_required'),
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
      planningCycles: [],
      planningHistoryTruncated: false,
      intentLedger: null,
      deliveryPlan: null,
      board: boardWithoutPlan('intent_required'),
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

describe('V2 intent ledger contracts', () => {
  const planningCycleId = randomUUID();
  const humanTurnId = randomUUID();
  const pmTurnId = randomUUID();
  const proposalId = randomUUID();
  const intentId = randomUUID();
  const ledgerId = randomUUID();
  const requirementId = randomUUID();
  const decisionId = randomUUID();
  const provenance = [
    {
      kind: 'conversation_turn' as const,
      turnId: humanTurnId,
      rationale: 'The operator explicitly requested Todo completion.',
    },
  ];
  const projectIntent = {
    goal: 'Let people track and complete Todos.',
    targetUsers: ['People managing a short task list'],
    desiredCapabilities: ['Create, complete, and inspect Todos'],
    constraints: ['Use the deterministic local fixture'],
    nonGoals: ['Team collaboration'],
    successConditions: ['A Todo remains complete after restart'],
    rationale: 'The requested product is a durable Todo application.',
    provenance,
  };
  const requirementContent = {
    type: 'requirement' as const,
    statement: 'Users can complete a Todo item.',
    rationale: 'Completion is core to the product.',
    kind: 'functional' as const,
    status: 'proposed' as const,
    priority: 'must' as const,
  };
  const decisionContent = {
    type: 'decision' as const,
    statement: 'Persist Todo completion locally.',
    rationale: 'Restart recovery is part of acceptance.',
    status: 'active' as const,
  };
  const proposalResult = {
    kind: 'proposal' as const,
    summary: 'Define the complete Todo intent and requirement ledger.',
    projectIntent,
    records: [
      {
        operation: 'create' as const,
        key: 'complete-todo',
        content: requirementContent,
        provenance,
      },
      {
        operation: 'create' as const,
        key: 'persist-locally',
        content: decisionContent,
        provenance,
      },
    ],
    relationships: [
      {
        kind: 'constrains' as const,
        from: { proposalKey: 'persist-locally' },
        to: { proposalKey: 'complete-todo' },
      },
    ],
  };
  const proposalDiff = {
    intentChanges: ['goal', 'desiredCapabilities'] as const,
    recordChanges: { create: 2, revise: 0, reuse: 0 },
    relationshipChanges: {
      added: proposalResult.relationships,
      removed: [],
    },
  };
  const proposal = {
    id: proposalId,
    projectId,
    planningCycleId,
    revision: 1,
    lifecycle: 'awaiting_approval' as const,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    summary: proposalResult.summary,
    projectIntent,
    records: [
      { ...proposalResult.records[0], recordId: requirementId },
      { ...proposalResult.records[1], recordId: decisionId },
    ],
    relationships: proposalResult.relationships,
    diff: proposalDiff,
    createdByTurnId: pmTurnId,
    createdByExecutionId: executionId,
    rejectionFeedback: null,
    createdAt: now,
    decidedAt: null,
  };
  const cycleView = {
    cycle: {
      id: planningCycleId,
      projectId,
      lifecycle: 'awaiting_approval' as const,
      revision: 2,
      profileId,
      profileRevision: 1,
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      latestProposalRevision: 1,
      activeExecutionId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    },
    turns: [
      {
        id: humanTurnId,
        projectId,
        planningCycleId,
        ordinal: 1,
        actor: 'human' as const,
        message: 'Build a Todo app.',
        launchState: 'execution_bound' as const,
        executionId,
        createdAt: now,
      },
      {
        id: pmTurnId,
        projectId,
        planningCycleId,
        ordinal: 2,
        actor: 'pm' as const,
        message: 'Here is the proposed intent and ledger.',
        launchState: null,
        executionId,
        createdAt: now,
      },
    ],
    questions: [],
    proposals: [proposal],
  };
  const approvedIntentLedger = {
    projectIntent: {
      id: intentId,
      projectId,
      revision: 1,
      content: projectIntent,
      proposalId,
      approvedBy: 'human' as const,
      approvedAt: now,
    },
    ledger: {
      id: ledgerId,
      projectId,
      revision: 1,
      proposalId,
      approvedBy: 'human' as const,
      approvedAt: now,
    },
    records: [
      {
        recordId: requirementId,
        projectId,
        revision: 1,
        content: { ...requirementContent, status: 'approved' as const },
        provenance,
        proposalId,
        approvedBy: 'human' as const,
        approvedAt: now,
      },
      {
        recordId: decisionId,
        projectId,
        revision: 1,
        content: decisionContent,
        provenance,
        proposalId,
        approvedBy: 'human' as const,
        approvedAt: now,
      },
    ],
    relationships: [
      {
        kind: 'constrains' as const,
        fromRecordId: decisionId,
        toRecordId: requirementId,
      },
    ],
  };

  const approvedCycleView = {
    ...cycleView,
    cycle: {
      ...cycleView.cycle,
      lifecycle: 'approved' as const,
      endedAt: now,
    },
    proposals: [
      { ...proposal, lifecycle: 'approved' as const, decidedAt: now },
    ],
  };

  const laterPlanningCycleId = randomUUID();
  const laterHumanTurnId = randomUUID();
  const laterPmTurnId = randomUUID();
  const laterProposalId = randomUUID();
  const laterExecutionId = randomUUID();
  const laterProjectIntent = {
    ...projectIntent,
    goal: 'Let people reliably track and complete Todos.',
  };
  const laterProposal = {
    ...proposal,
    id: laterProposalId,
    planningCycleId: laterPlanningCycleId,
    lifecycle: 'approved' as const,
    baseProjectIntentRevision: 1,
    baseLedgerRevision: 1,
    projectIntent: laterProjectIntent,
    records: [
      {
        operation: 'reuse' as const,
        recordId: requirementId,
        expectedRevision: 1,
      },
      {
        operation: 'reuse' as const,
        recordId: decisionId,
        expectedRevision: 1,
      },
    ],
    relationships: [
      {
        kind: 'constrains' as const,
        from: { recordId: decisionId },
        to: { recordId: requirementId },
      },
    ],
    diff: {
      intentChanges: ['goal'] as const,
      recordChanges: { create: 0, revise: 0, reuse: 2 },
      relationshipChanges: { added: [], removed: [] },
    },
    createdByTurnId: laterPmTurnId,
    createdByExecutionId: laterExecutionId,
    decidedAt: now,
  };
  const laterApprovedCycleView = {
    cycle: {
      ...cycleView.cycle,
      id: laterPlanningCycleId,
      lifecycle: 'approved' as const,
      baseProjectIntentRevision: 1,
      baseLedgerRevision: 1,
      endedAt: now,
    },
    turns: [
      {
        ...cycleView.turns[0],
        id: laterHumanTurnId,
        planningCycleId: laterPlanningCycleId,
        executionId: laterExecutionId,
      },
      {
        ...cycleView.turns[1],
        id: laterPmTurnId,
        planningCycleId: laterPlanningCycleId,
        executionId: laterExecutionId,
      },
    ],
    questions: [],
    proposals: [laterProposal],
  };
  const laterApprovedIntentLedger = {
    projectIntent: {
      ...approvedIntentLedger.projectIntent,
      revision: 2,
      content: laterProjectIntent,
      proposalId: laterProposalId,
    },
    ledger: {
      ...approvedIntentLedger.ledger,
      revision: 2,
      proposalId: laterProposalId,
    },
    records: approvedIntentLedger.records,
    relationships: approvedIntentLedger.relationships,
  };
  const revisedRequirementContent = {
    ...requirementContent,
    statement: 'Users can reliably complete a Todo item.',
  };
  const revisedProposal = {
    ...laterProposal,
    records: [
      {
        operation: 'revise' as const,
        recordId: requirementId,
        expectedRevision: 1,
        content: revisedRequirementContent,
        provenance,
      },
      laterProposal.records[1],
    ],
    diff: {
      ...laterProposal.diff,
      recordChanges: { create: 0, revise: 1, reuse: 1 },
    },
  };
  const revisedApprovedCycleView = {
    ...laterApprovedCycleView,
    proposals: [revisedProposal],
  };
  const revisedApprovedIntentLedger = {
    ...laterApprovedIntentLedger,
    records: [
      {
        ...approvedIntentLedger.records[0],
        revision: 2,
        content: {
          ...revisedRequirementContent,
          status: 'approved' as const,
        },
        proposalId: laterProposalId,
      },
      approvedIntentLedger.records[1],
    ],
    relationships: laterApprovedIntentLedger.relationships,
  };

  const issueText = (result: {
    success: boolean;
    error?: { issues: unknown[] };
  }) => (result.success ? '' : JSON.stringify(result.error?.issues));
  const planningQuestion = {
    id: randomUUID(),
    projectId,
    planningCycleId,
    turnId: pmTurnId,
    key: 'storage-choice',
    prompt: 'Which storage should the Todo app use?',
    rationale: 'Storage determines restart behavior.',
  };
  const emptyBoardWithPlan = (stale: boolean) => ({
    projectId,
    deliveryPlanRevision: 1,
    stale,
    emptyReason: 'plan_empty' as const,
    filter: {
      projectId,
      revision: 1,
      milestoneIds: [],
      taskLifecycles: [],
      readiness: [],
      priorities: [],
      labels: [],
      requirementRecordIds: [],
      updatedAt: now,
    },
    totalTaskCount: 0,
    matchedTaskCount: 0,
    facets: {
      milestones: [],
      taskLifecycles: [
        {
          value: 'pending' as const,
          label: 'Pending',
          selected: false,
          matchingTaskCount: 0,
        },
        {
          value: 'completed' as const,
          label: 'Completed',
          selected: false,
          matchingTaskCount: 0,
        },
        {
          value: 'retired' as const,
          label: 'Retired',
          selected: false,
          matchingTaskCount: 0,
        },
      ],
      readiness: [
        {
          value: 'actionable' as const,
          label: 'Actionable',
          selected: false,
          matchingTaskCount: 0,
        },
        {
          value: 'blocked' as const,
          label: 'Blocked',
          selected: false,
          matchingTaskCount: 0,
        },
        {
          value: 'inactive' as const,
          label: 'Inactive',
          selected: false,
          matchingTaskCount: 0,
        },
      ],
      priorities: [
        {
          value: 'must' as const,
          label: 'Must',
          selected: false,
          matchingTaskCount: 0,
        },
        {
          value: 'should' as const,
          label: 'Should',
          selected: false,
          matchingTaskCount: 0,
        },
        {
          value: 'could' as const,
          label: 'Could',
          selected: false,
          matchingTaskCount: 0,
        },
      ],
      labels: [],
      requirements: [],
    },
    cards: [],
  });

  it('requires coherent approved terminal outcomes in events and command results', () => {
    const approvedEvent = {
      projectId,
      occurredAt: now,
      type: 'intent_ledger.approved' as const,
      payload: {
        planningCycle: approvedCycleView,
        intentLedger: approvedIntentLedger,
      },
    };
    const approvedResult = {
      ok: true,
      commandType: 'planning_proposal.approve' as const,
      planningCycle: approvedCycleView,
      intentLedger: approvedIntentLedger,
    };
    const wrongProposalId = randomUUID();

    expect(domainEventDraftSchema.parse(approvedEvent)).toEqual(approvedEvent);
    expect(v2CommandResultSchema.parse(approvedResult)).toEqual(approvedResult);

    const crossProjectCycle = {
      ...approvedCycleView,
      cycle: { ...approvedCycleView.cycle, projectId: otherProjectId },
      turns: approvedCycleView.turns.map((turn) => ({
        ...turn,
        projectId: otherProjectId,
      })),
      proposals: approvedCycleView.proposals.map((item) => ({
        ...item,
        projectId: otherProjectId,
      })),
    };
    expect(
      issueText(
        v2CommandResultSchema.safeParse({
          ...approvedResult,
          planningCycle: crossProjectCycle,
        }),
      ),
    ).toMatch(/approval outcome projects must match/i);

    for (const [label, planningCycle, intentLedger, expected] of [
      [
        'non-approved cycle',
        cycleView,
        approvedIntentLedger,
        /approved terminal cycle/i,
      ],
      [
        'non-approved latest proposal',
        {
          ...approvedCycleView,
          proposals: [proposal],
        },
        approvedIntentLedger,
        /approved latest proposal/i,
      ],
      [
        'wrong proposal id',
        approvedCycleView,
        {
          ...approvedIntentLedger,
          projectIntent: {
            ...approvedIntentLedger.projectIntent,
            proposalId: wrongProposalId,
          },
          ledger: {
            ...approvedIntentLedger.ledger,
            proposalId: wrongProposalId,
          },
        },
        /proposal ids must match/i,
      ],
      [
        'wrong proposal revision',
        {
          ...approvedCycleView,
          cycle: {
            ...approvedCycleView.cycle,
            latestProposalRevision: 2,
          },
        },
        approvedIntentLedger,
        /latest proposal revision must match/i,
      ],
      [
        'mutated canonical intent',
        approvedCycleView,
        {
          ...approvedIntentLedger,
          projectIntent: {
            ...approvedIntentLedger.projectIntent,
            content: {
              ...approvedIntentLedger.projectIntent.content,
              goal: 'Different from the approved proposal.',
            },
          },
        },
        /canonical intent content must match/i,
      ],
      [
        'invalid intent revision progression',
        approvedCycleView,
        {
          ...approvedIntentLedger,
          projectIntent: {
            ...approvedIntentLedger.projectIntent,
            revision: 2,
          },
        },
        /intent revision must advance from the proposal base/i,
      ],
      [
        'invalid ledger revision progression',
        approvedCycleView,
        {
          ...approvedIntentLedger,
          ledger: { ...approvedIntentLedger.ledger, revision: 2 },
        },
        /ledger revision must advance from the proposal base/i,
      ],
      [
        'proposal base differs from cycle base',
        {
          ...laterApprovedCycleView,
          proposals: [
            {
              ...laterProposal,
              baseProjectIntentRevision: 2,
            },
          ],
        },
        laterApprovedIntentLedger,
        /proposal base must match the cycle base/i,
      ],
    ] as const) {
      const eventIssues = issueText(
        domainEventDraftSchema.safeParse({
          ...approvedEvent,
          payload: { planningCycle, intentLedger },
        }),
      );
      const resultIssues = issueText(
        v2CommandResultSchema.safeParse({
          ...approvedResult,
          planningCycle,
          intentLedger,
        }),
      );
      expect(eventIssues, label).toMatch(expected);
      expect(resultIssues, label).toMatch(expected);
    }
  });

  it('requires the exact Board transition on versioned intent approval', () => {
    const planningCycle = asIntentCycleView(approvedCycleView);
    const event = {
      projectId,
      occurredAt: now,
      type: 'intent_ledger.approved' as const,
      payload: {
        schemaVersion: 2 as const,
        planningCycle,
        intentLedger: approvedIntentLedger,
        board: boardWithoutPlan('planning_required'),
      },
    };
    const result = {
      ok: true as const,
      schemaVersion: 2 as const,
      commandType: 'planning_proposal.approve' as const,
      planningCycle,
      intentLedger: approvedIntentLedger,
      board: boardWithoutPlan('planning_required'),
    };
    expect(domainEventDraftSchema.parse(event)).toEqual(event);
    expect(v2CommandResultSchema.parse(result)).toEqual(result);

    for (const schemaResult of [
      domainEventDraftSchema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          board: boardWithoutPlan('intent_required'),
        },
      }),
      v2CommandResultSchema.safeParse({
        ...result,
        board: boardWithoutPlan('intent_required'),
      }),
    ]) {
      expect(schemaResult.success).toBe(false);
    }

    const stalePlanBoard = emptyBoardWithPlan(true);
    expect(
      domainEventDraftSchema.parse({
        ...event,
        payload: { ...event.payload, board: stalePlanBoard },
      }).payload.board,
    ).toEqual(stalePlanBoard);
    expect(
      v2CommandResultSchema.parse({ ...result, board: stalePlanBoard }).board,
    ).toEqual(stalePlanBoard);

    const freshPlanBoard = emptyBoardWithPlan(false);
    for (const schemaResult of [
      domainEventDraftSchema.safeParse({
        ...event,
        payload: { ...event.payload, board: freshPlanBoard },
      }),
      v2CommandResultSchema.safeParse({ ...result, board: freshPlanBoard }),
    ]) {
      expect(schemaResult.success).toBe(false);
    }
  });

  it('preserves reused immutable record revisions through every approved projection', () => {
    const nextPlanningCycleId = randomUUID();
    const nextHumanTurnId = randomUUID();
    const assignment = {
      kind: 'pm_discovery' as const,
      projectId,
      outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
      planningCycleId: nextPlanningCycleId,
      humanTurnId: nextHumanTurnId,
      expectedCycleRevision: 1,
      expectedProposalRevision: 1,
      baseProjectIntentRevision: 2,
      baseLedgerRevision: 2,
      input: {
        conversation: [
          {
            turnId: nextHumanTurnId,
            actor: 'human' as const,
            message: 'Plan the next revision.',
          },
        ],
        latestProposal: null,
        approvedIntentLedger: laterApprovedIntentLedger,
      },
    };
    const approvedEvent = {
      projectId,
      occurredAt: now,
      type: 'intent_ledger.approved' as const,
      payload: {
        planningCycle: laterApprovedCycleView,
        intentLedger: laterApprovedIntentLedger,
      },
    };
    const approvedResult = {
      ok: true,
      commandType: 'planning_proposal.approve' as const,
      planningCycle: laterApprovedCycleView,
      intentLedger: laterApprovedIntentLedger,
    };
    const snapshot = {
      protocolVersion: V2_PROTOCOL_VERSION,
      project,
      profiles: [],
      executions: [],
      attentionItems: [],
      planningCycles: [asIntentCycleView(laterApprovedCycleView)],
      planningHistoryTruncated: false,
      intentLedger: laterApprovedIntentLedger,
      deliveryPlan: null,
      board: boardWithoutPlan('planning_required'),
      cursors: { domain: 2, runtime: 2 },
    };

    expect(approvedIntentLedgerSchema.parse(laterApprovedIntentLedger)).toEqual(
      laterApprovedIntentLedger,
    );
    expect(pmDiscoveryAssignmentSchema.parse(assignment)).toEqual(assignment);
    expect(v2ProjectSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(domainEventDraftSchema.parse(approvedEvent)).toEqual(approvedEvent);
    expect(v2CommandResultSchema.parse(approvedResult)).toEqual(approvedResult);
  });

  it('binds snapshot canonical state to its newest included approval', () => {
    const approvedHistory = {
      protocolVersion: V2_PROTOCOL_VERSION,
      project,
      profiles: [],
      executions: [],
      attentionItems: [],
      planningCycles: [
        asIntentCycleView(approvedCycleView),
        asIntentCycleView(laterApprovedCycleView),
      ],
      planningHistoryTruncated: false,
      intentLedger: laterApprovedIntentLedger,
      deliveryPlan: null,
      board: boardWithoutPlan('planning_required'),
      cursors: { domain: 2, runtime: 2 },
    };
    expect(v2ProjectSnapshotSchema.parse(approvedHistory)).toEqual(
      approvedHistory,
    );
    expect(
      issueText(
        v2ProjectSnapshotSchema.safeParse({
          ...approvedHistory,
          intentLedger: approvedIntentLedger,
        }),
      ),
    ).toMatch(/snapshot intent ledger must match the newest approved cycle/i);
    expect(
      issueText(
        v2ProjectSnapshotSchema.safeParse({
          ...approvedHistory,
          intentLedger: null,
        }),
      ),
    ).toMatch(/approved snapshot history requires an intent ledger/i);

    const abandonedHistory = {
      ...approvedHistory,
      planningCycles: [
        asIntentCycleView({
          ...cycleView,
          cycle: {
            ...cycleView.cycle,
            lifecycle: 'abandoned' as const,
            endedAt: now,
          },
          proposals: [
            {
              ...proposal,
              lifecycle: 'superseded' as const,
              decidedAt: now,
            },
          ],
        }),
      ],
      intentLedger: null,
      board: boardWithoutPlan('intent_required'),
    };
    expect(v2ProjectSnapshotSchema.parse(abandonedHistory)).toEqual(
      abandonedHistory,
    );
    expect(
      issueText(
        v2ProjectSnapshotSchema.safeParse({
          ...abandonedHistory,
          intentLedger: approvedIntentLedger,
        }),
      ),
    ).toMatch(
      /untruncated snapshot without approval cannot have an intent ledger/i,
    );
    expect(
      v2ProjectSnapshotSchema.safeParse({
        ...abandonedHistory,
        planningHistoryTruncated: true,
        intentLedger: approvedIntentLedger,
        board: boardWithoutPlan('planning_required'),
      }).success,
    ).toBe(true);

    const planCycleId = randomUUID();
    const planHumanTurnId = randomUUID();
    const planPmTurnId = randomUUID();
    const planExecutionId = randomUUID();
    const planProposalId = randomUUID();
    const planId = randomUUID();
    const historicalMilestoneId = randomUUID();
    const historicalTaskId = randomUUID();
    const approvedPlanCycle = {
      cycle: {
        id: planCycleId,
        projectId,
        lifecycle: 'approved' as const,
        revision: 2,
        profileId,
        profileRevision: 1,
        baseProjectIntentRevision: 2,
        baseLedgerRevision: 2,
        latestProposalRevision: 1,
        activeExecutionId: null,
        createdAt: now,
        updatedAt: now,
        endedAt: now,
      },
      purpose: {
        kind: 'delivery_plan' as const,
        baseDeliveryPlanId: null,
        baseDeliveryPlanRevision: null,
      },
      turns: [
        {
          id: planHumanTurnId,
          projectId,
          planningCycleId: planCycleId,
          ordinal: 1,
          actor: 'human' as const,
          message: 'Approve an empty completed plan.',
          launchState: 'execution_bound' as const,
          executionId: planExecutionId,
          createdAt: now,
        },
        {
          id: planPmTurnId,
          projectId,
          planningCycleId: planCycleId,
          ordinal: 2,
          actor: 'pm' as const,
          message: 'No actionable work remains.',
          launchState: null,
          executionId: planExecutionId,
          createdAt: now,
        },
      ],
      questions: [],
      proposals: [],
      deliveryPlanProposals: [
        {
          id: planProposalId,
          projectId,
          planningCycleId: planCycleId,
          revision: 1,
          lifecycle: 'approved' as const,
          base: {
            projectIntentId: laterApprovedIntentLedger.projectIntent.id,
            projectIntentRevision: 2,
            ledgerId: laterApprovedIntentLedger.ledger.id,
            ledgerRevision: 2,
            deliveryPlan: { id: null, revision: null },
          },
          proposedPlan: {
            summary: 'Deliver Todo in one milestone.',
            milestones: [
              {
                operation: 'create' as const,
                key: 'todo-milestone',
                content: {
                  title: 'Todo milestone',
                  outcome: 'Todo works.',
                  stopCondition: 'Todo persists.',
                  exclusions: [],
                  ordinal: 1,
                },
              },
            ],
            tasks: [
              {
                operation: 'create' as const,
                key: 'persist-todo',
                content: {
                  milestone: {
                    kind: 'proposal' as const,
                    key: 'todo-milestone',
                  },
                  title: 'Persist Todo',
                  outcome: 'Todo survives refresh.',
                  acceptanceCriteria: ['Todo is restored.'],
                  verificationCriteria: ['Run the Todo test.'],
                  priority: 'must' as const,
                  labels: ['persistence'],
                  ownedSurfaces: ['Todo storage'],
                  prohibitedSurfaces: [],
                  expectedArtifacts: ['Storage implementation'],
                  ordinal: 1,
                },
              },
            ],
            dependencies: [],
            traces: [
              {
                kind: 'milestone_covers' as const,
                milestone: {
                  kind: 'proposal' as const,
                  key: 'todo-milestone',
                },
                requirement: { recordId: requirementId, recordRevision: 1 },
              },
              {
                kind: 'task_satisfies' as const,
                task: { kind: 'proposal' as const, key: 'persist-todo' },
                requirement: { recordId: requirementId, recordRevision: 1 },
              },
            ],
          },
          reservations: {
            milestones: [{ key: 'todo-milestone', id: historicalMilestoneId }],
            tasks: [{ key: 'persist-todo', id: historicalTaskId }],
            dependencies: [],
          },
          diff: {
            milestones: {
              create: 1,
              reuse: 0,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            tasks: {
              create: 1,
              reuse: 0,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            dependencies: {
              create: 0,
              reuse: 0,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            traceCreateCount: 2,
            traceRemoveCount: 0,
          },
          createdByTurnId: planPmTurnId,
          createdByExecutionId: planExecutionId,
          createdAt: now,
          decision: {
            kind: 'approved' as const,
            decidedBy: 'human' as const,
            decidedAt: now,
          },
        },
      ],
    };
    const approvedDeliveryPlan = {
      plan: {
        id: planId,
        projectId,
        revision: 1,
        projectIntentId: laterApprovedIntentLedger.projectIntent.id,
        projectIntentRevision: 2,
        ledgerId: laterApprovedIntentLedger.ledger.id,
        ledgerRevision: 2,
        baseDeliveryPlanRevision: null,
        proposalId: planProposalId,
        summary: 'Deliver Todo in one milestone.',
        approvedBy: 'human' as const,
        approvedAt: now,
      },
      milestones: [
        {
          id: historicalMilestoneId,
          projectId,
          revision: 1,
          lifecycle: 'active' as const,
          title: 'Todo milestone',
          outcome: 'Todo works.',
          stopCondition: 'Todo persists.',
          exclusions: [],
          ordinal: 1,
          proposalId: planProposalId,
          deliveryPlanRevision: 1,
          approvedAt: now,
        },
      ],
      taskContracts: [
        {
          id: historicalTaskId,
          projectId,
          revision: 1,
          contractRevision: 1,
          revisionKind: 'plan_contract' as const,
          lifecycle: 'pending' as const,
          milestoneId: historicalMilestoneId,
          title: 'Persist Todo',
          outcome: 'Todo survives refresh.',
          acceptanceCriteria: ['Todo is restored.'],
          verificationCriteria: ['Run the Todo test.'],
          priority: 'must' as const,
          labels: ['persistence'],
          ownedSurfaces: ['Todo storage'],
          prohibitedSurfaces: [],
          expectedArtifacts: ['Storage implementation'],
          ordinal: 1,
          source: {
            kind: 'plan' as const,
            proposalId: planProposalId,
            deliveryPlanRevision: 1,
          },
          createdAt: now,
        },
      ],
      dependencies: [],
      traces: [
        {
          kind: 'milestone_covers' as const,
          milestoneId: historicalMilestoneId,
          milestoneRevision: 1,
          requirement: { recordId: requirementId, recordRevision: 1 },
        },
        {
          kind: 'task_satisfies' as const,
          taskId: historicalTaskId,
          taskContractRevision: 1,
          requirement: { recordId: requirementId, recordRevision: 1 },
        },
      ],
      milestoneDependencies: [],
    };
    const emptyApprovedBoard = emptyBoardWithPlan(false);
    const approvedPlanHistory = {
      ...approvedHistory,
      planningCycles: [...approvedHistory.planningCycles, approvedPlanCycle],
      deliveryPlan: approvedDeliveryPlan,
      board: emptyApprovedBoard,
    };
    expect(v2ProjectSnapshotSchema.parse(approvedPlanHistory)).toEqual(
      approvedPlanHistory,
    );
    expect(
      v2ProjectSnapshotSchema.safeParse({
        ...approvedPlanHistory,
        baseDeliveryPlan: null,
      }).success,
    ).toBe(false);

    const replacementCycleId = randomUUID();
    const replacementHumanTurnId = randomUUID();
    const replacementPmTurnId = randomUUID();
    const replacementExecutionId = randomUUID();
    const replacementProposalId = randomUUID();
    const replacementProposal = {
      ...approvedPlanCycle.deliveryPlanProposals[0],
      id: replacementProposalId,
      planningCycleId: replacementCycleId,
      base: {
        ...approvedPlanCycle.deliveryPlanProposals[0].base,
        deliveryPlan: { id: planId, revision: 1 },
      },
      proposedPlan: {
        summary: 'Retain the approved Todo plan.',
        milestones: [
          {
            operation: 'reuse' as const,
            milestoneId: historicalMilestoneId,
            expectedRevision: 1,
          },
        ],
        tasks: [
          {
            operation: 'reuse' as const,
            taskId: historicalTaskId,
            expectedContractRevision: 1,
            expectedCurrentRevision: 1,
          },
        ],
        dependencies: [],
        traces: [
          {
            kind: 'milestone_covers' as const,
            milestone: {
              kind: 'canonical' as const,
              milestoneId: historicalMilestoneId,
            },
            requirement:
              approvedPlanCycle.deliveryPlanProposals[0].proposedPlan.traces[0]
                .requirement,
          },
          {
            kind: 'task_satisfies' as const,
            task: {
              kind: 'canonical' as const,
              taskId: historicalTaskId,
            },
            requirement:
              approvedPlanCycle.deliveryPlanProposals[0].proposedPlan.traces[1]
                .requirement,
          },
        ],
      },
      reservations: { milestones: [], tasks: [], dependencies: [] },
      diff: {
        milestones: {
          create: 0,
          reuse: 1,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        tasks: {
          create: 0,
          reuse: 1,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        dependencies: {
          create: 0,
          reuse: 0,
          revise: 0,
          retire: 0,
          reactivate: 0,
        },
        traceCreateCount: 0,
        traceRemoveCount: 0,
      },
      createdByTurnId: replacementPmTurnId,
      createdByExecutionId: replacementExecutionId,
    };
    const replacementCycle = {
      ...approvedPlanCycle,
      cycle: {
        ...approvedPlanCycle.cycle,
        id: replacementCycleId,
      },
      purpose: {
        kind: 'delivery_plan' as const,
        baseDeliveryPlanId: planId,
        baseDeliveryPlanRevision: 1,
      },
      turns: [
        {
          ...approvedPlanCycle.turns[0],
          id: replacementHumanTurnId,
          planningCycleId: replacementCycleId,
          executionId: replacementExecutionId,
        },
        {
          ...approvedPlanCycle.turns[1],
          id: replacementPmTurnId,
          planningCycleId: replacementCycleId,
          executionId: replacementExecutionId,
        },
      ],
      deliveryPlanProposals: [replacementProposal],
    };
    const replacementDeliveryPlan = {
      ...approvedDeliveryPlan,
      plan: {
        ...approvedDeliveryPlan.plan,
        revision: 2,
        baseDeliveryPlanRevision: 1,
        proposalId: replacementProposalId,
        summary: replacementProposal.proposedPlan.summary,
      },
    };
    const replacementSnapshot = {
      ...approvedPlanHistory,
      planningCycles: [...approvedPlanHistory.planningCycles, replacementCycle],
      deliveryPlan: replacementDeliveryPlan,
      board: { ...emptyApprovedBoard, deliveryPlanRevision: 2 },
    };
    expect(v2ProjectSnapshotSchema.parse(replacementSnapshot)).toEqual(
      replacementSnapshot,
    );
    expect(
      v2ProjectSnapshotSchema.safeParse({
        ...replacementSnapshot,
        baseDeliveryPlan: approvedDeliveryPlan,
      }).success,
    ).toBe(false);
    expect(
      v2ProjectSnapshotSchema.safeParse({
        ...approvedPlanHistory,
        deliveryPlan: null,
        board: boardWithoutPlan('planning_required'),
      }).success,
    ).toBe(false);
    expect(
      v2ProjectSnapshotSchema.safeParse({
        ...approvedPlanHistory,
        deliveryPlan: {
          ...approvedDeliveryPlan,
          plan: { ...approvedDeliveryPlan.plan, proposalId: randomUUID() },
        },
      }).success,
    ).toBe(false);
    const omittedPlanApproval = {
      ...approvedPlanHistory,
      planningCycles: approvedHistory.planningCycles,
    };
    expect(v2ProjectSnapshotSchema.safeParse(omittedPlanApproval).success).toBe(
      false,
    );
    expect(
      v2ProjectSnapshotSchema.safeParse({
        ...omittedPlanApproval,
        planningHistoryTruncated: true,
      }).success,
    ).toBe(true);
  });

  it('accepts revised members and server-resolved create identities', () => {
    const revisedResult = {
      ok: true,
      commandType: 'planning_proposal.approve' as const,
      planningCycle: revisedApprovedCycleView,
      intentLedger: revisedApprovedIntentLedger,
    };

    expect(v2CommandResultSchema.parse(revisedResult)).toEqual(revisedResult);
    expect(
      v2CommandResultSchema.safeParse({
        ok: true,
        commandType: 'planning_proposal.approve',
        planningCycle: approvedCycleView,
        intentLedger: approvedIntentLedger,
      }).success,
    ).toBe(true);
    expect(
      pmProposalResultSchema.safeParse({
        ...proposalResult,
        records: proposal.records,
      }).success,
    ).toBe(false);
    expect(
      planningProposalSchema.safeParse({
        ...proposal,
        records: proposalResult.records,
      }).success,
    ).toBe(false);
    expect(
      issueText(
        planningProposalSchema.safeParse({
          ...proposal,
          records: [
            proposal.records[0],
            {
              ...proposal.records[1],
              recordId: requirementId,
            },
          ],
        }),
      ),
    ).toMatch(/projected record ids must be unique/i);
    expect(
      issueText(
        v2CommandResultSchema.safeParse({
          ok: true,
          commandType: 'planning_proposal.approve',
          planningCycle: {
            ...approvedCycleView,
            proposals: [
              {
                ...approvedCycleView.proposals[0],
                records: [
                  {
                    ...approvedCycleView.proposals[0].records[0],
                    recordId: randomUUID(),
                  },
                  approvedCycleView.proposals[0].records[1],
                ],
              },
            ],
          },
          intentLedger: approvedIntentLedger,
        }),
      ),
    ).toMatch(/proposal operations must match canonical ledger members/i);
  });

  it('requires exact normalized relationships in an approval outcome', () => {
    const approvedWithRelationships = (
      relationships: typeof proposal.relationships,
    ) => ({
      ...approvedCycleView,
      proposals: [
        {
          ...approvedCycleView.proposals[0],
          relationships,
          diff: {
            ...approvedCycleView.proposals[0].diff,
            relationshipChanges: { added: relationships, removed: [] },
          },
        },
      ],
    });

    expect(
      v2CommandResultSchema.safeParse({
        ok: true,
        commandType: 'planning_proposal.approve',
        planningCycle: approvedCycleView,
        intentLedger: approvedIntentLedger,
      }).success,
    ).toBe(true);
    expect(
      v2CommandResultSchema.safeParse({
        ok: true,
        commandType: 'planning_proposal.approve',
        planningCycle: laterApprovedCycleView,
        intentLedger: laterApprovedIntentLedger,
      }).success,
    ).toBe(true);

    for (const [label, planningCycle, intentLedger] of [
      [
        'dropped canonical edge',
        approvedCycleView,
        { ...approvedIntentLedger, relationships: [] },
      ],
      [
        'extra canonical edge',
        approvedWithRelationships([]),
        approvedIntentLedger,
      ],
      [
        'mutated edge',
        approvedWithRelationships([
          {
            ...proposal.relationships[0],
            kind: 'depends_on' as const,
          },
        ]),
        approvedIntentLedger,
      ],
      [
        'reversed directed edge',
        approvedWithRelationships([
          {
            ...proposal.relationships[0],
            from: proposal.relationships[0].to,
            to: proposal.relationships[0].from,
          },
        ]),
        approvedIntentLedger,
      ],
    ] as const) {
      expect(
        issueText(
          v2CommandResultSchema.safeParse({
            ok: true,
            commandType: 'planning_proposal.approve',
            planningCycle,
            intentLedger,
          }),
        ),
        label,
      ).toMatch(/proposal relationships must match canonical ledger edges/i);
    }

    const secondRequirementContent = {
      ...requirementContent,
      statement: 'Users can inspect completed Todo items.',
    };
    const symmetricRelationship = {
      kind: 'conflicts_with' as const,
      from: proposal.relationships[0].from,
      to: proposal.relationships[0].to,
    };
    const symmetricBase = approvedWithRelationships([symmetricRelationship]);
    const symmetricCycle = {
      ...symmetricBase,
      proposals: [
        {
          ...symmetricBase.proposals[0],
          records: [
            proposal.records[0],
            {
              ...proposal.records[1],
              content: secondRequirementContent,
            },
          ],
        },
      ],
    };
    const symmetricLedger = {
      ...approvedIntentLedger,
      records: [
        approvedIntentLedger.records[0],
        {
          ...approvedIntentLedger.records[1],
          content: {
            ...secondRequirementContent,
            status: 'approved' as const,
          },
        },
      ],
      relationships: [
        {
          kind: 'conflicts_with' as const,
          fromRecordId: requirementId,
          toRecordId: decisionId,
        },
      ],
    };
    expect(
      v2CommandResultSchema.safeParse({
        ok: true,
        commandType: 'planning_proposal.approve',
        planningCycle: symmetricCycle,
        intentLedger: symmetricLedger,
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'cardinality mismatch',
      {
        ...revisedApprovedIntentLedger,
        records: [revisedApprovedIntentLedger.records[1]],
      },
    ],
    [
      'revised identity mismatch',
      {
        ...revisedApprovedIntentLedger,
        records: [
          {
            ...revisedApprovedIntentLedger.records[0],
            recordId: randomUUID(),
          },
          revisedApprovedIntentLedger.records[1],
        ],
      },
    ],
    [
      'revised revision mismatch',
      {
        ...revisedApprovedIntentLedger,
        records: [
          { ...revisedApprovedIntentLedger.records[0], revision: 1 },
          revisedApprovedIntentLedger.records[1],
        ],
      },
    ],
    [
      'revised content mismatch',
      {
        ...revisedApprovedIntentLedger,
        records: [
          {
            ...revisedApprovedIntentLedger.records[0],
            content: {
              ...revisedApprovedIntentLedger.records[0].content,
              statement: 'Different canonical content.',
            },
          },
          revisedApprovedIntentLedger.records[1],
        ],
      },
    ],
    [
      'revised type mismatch',
      {
        ...revisedApprovedIntentLedger,
        records: [
          {
            ...revisedApprovedIntentLedger.records[0],
            content: decisionContent,
          },
          revisedApprovedIntentLedger.records[1],
        ],
      },
    ],
    [
      'revised provenance mismatch',
      {
        ...revisedApprovedIntentLedger,
        records: [
          {
            ...revisedApprovedIntentLedger.records[0],
            provenance: [
              {
                ...provenance[0],
                rationale: 'Different canonical provenance.',
              },
            ],
          },
          revisedApprovedIntentLedger.records[1],
        ],
      },
    ],
  ])('rejects approval member %s', (_label, intentLedger) => {
    expect(
      issueText(
        v2CommandResultSchema.safeParse({
          ok: true,
          commandType: 'planning_proposal.approve',
          planningCycle: revisedApprovedCycleView,
          intentLedger,
        }),
      ),
    ).toMatch(/proposal operations must match canonical ledger members/i);
  });

  it('rejects created canonical content unrelated to its proposal entry', () => {
    expect(
      issueText(
        v2CommandResultSchema.safeParse({
          ok: true,
          commandType: 'planning_proposal.approve',
          planningCycle: approvedCycleView,
          intentLedger: {
            ...approvedIntentLedger,
            records: [
              {
                ...approvedIntentLedger.records[0],
                content: {
                  ...approvedIntentLedger.records[0].content,
                  statement: 'Unrelated created content.',
                },
              },
              approvedIntentLedger.records[1],
            ],
          },
        }),
      ),
    ).toMatch(/proposal operations must match canonical ledger members/i);
  });

  it('rejects non-canonical approved ledger memberships and relationships', () => {
    const duplicateRecord = {
      ...approvedIntentLedger,
      records: [
        approvedIntentLedger.records[0],
        {
          ...approvedIntentLedger.records[1],
          recordId: requirementId,
        },
      ],
      relationships: [],
    };
    expect(
      issueText(approvedIntentLedgerSchema.safeParse(duplicateRecord)),
    ).toMatch(/record ids must be unique/i);

    const duplicateSymmetricEdge = {
      ...approvedIntentLedger,
      relationships: [
        {
          kind: 'conflicts_with' as const,
          fromRecordId: requirementId,
          toRecordId: decisionId,
        },
        {
          kind: 'conflicts_with' as const,
          fromRecordId: decisionId,
          toRecordId: requirementId,
        },
      ],
    };
    expect(
      issueText(approvedIntentLedgerSchema.safeParse(duplicateSymmetricEdge)),
    ).toMatch(/relationships must be unique/i);

    const proposedRequirement = {
      ...approvedIntentLedger,
      records: [
        {
          ...approvedIntentLedger.records[0],
          content: requirementContent,
        },
        approvedIntentLedger.records[1],
      ],
    };
    expect(
      issueText(approvedIntentLedgerSchema.safeParse(proposedRequirement)),
    ).toMatch(/proposed requirements/i);
  });

  it('enforces the human and PM launch-state matrix', () => {
    const human = cycleView.turns[0];
    const pm = cycleView.turns[1];
    for (const [label, turn, expected] of [
      [
        'human missing launch state',
        { ...human, launchState: null },
        /human turns require a launch state/i,
      ],
      [
        'pending human with execution',
        { ...human, launchState: 'launch_pending', executionId },
        /launch-pending human turns cannot have an execution id/i,
      ],
      [
        'bound human without execution',
        { ...human, executionId: null },
        /execution-bound human turns require an execution id/i,
      ],
      [
        'PM with launch state',
        { ...pm, launchState: 'execution_bound' },
        /pm turns do not own an execution launch state/i,
      ],
      [
        'PM without execution',
        { ...pm, executionId: null },
        /pm turns require an execution id/i,
      ],
    ] as const) {
      expect(issueText(planningTurnSchema.safeParse(turn)), label).toMatch(
        expected,
      );
    }
  });

  it('accepts PM-authored question and proposal provenance', () => {
    const view = { ...cycleView, questions: [planningQuestion] };
    expect(planningCycleViewSchema.parse(view)).toEqual(view);
  });

  it('rejects a question attributed to a human turn', () => {
    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...cycleView,
          questions: [{ ...planningQuestion, turnId: humanTurnId }],
        }),
      ),
    ).toMatch(/questions must reference a PM-authored turn/i);
  });

  it('rejects a proposal attributed to a human turn', () => {
    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...cycleView,
          proposals: [{ ...proposal, createdByTurnId: humanTurnId }],
        }),
      ),
    ).toMatch(/proposals must reference a PM-authored turn/i);
  });

  it('rejects a proposal execution unrelated to its PM turn', () => {
    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...cycleView,
          proposals: [{ ...proposal, createdByExecutionId: randomUUID() }],
        }),
      ),
    ).toMatch(/proposal execution must match its PM turn/i);
  });

  it.each([
    [
      'without an immediately preceding bound human',
      [
        cycleView.turns[0],
        cycleView.turns[1],
        {
          ...cycleView.turns[1],
          id: randomUUID(),
          ordinal: 3,
        },
      ],
      /pm turns must immediately follow an execution-bound human/i,
    ],
    [
      'with a different execution from its human turn',
      [
        cycleView.turns[0],
        {
          ...cycleView.turns[1],
          executionId: randomUUID(),
        },
      ],
      /paired human and PM turns must share an execution/i,
    ],
  ])('rejects a PM turn %s', (_label, turns, expected) => {
    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...cycleView,
          cycle: {
            ...cycleView.cycle,
            lifecycle: 'awaiting_human',
            latestProposalRevision: 0,
          },
          turns,
          proposals: [],
        }),
      ),
    ).toMatch(expected);
  });

  it('requires proposal bases to be complete and match their cycle base', () => {
    expect(planningCycleViewSchema.parse(laterApprovedCycleView)).toEqual(
      laterApprovedCycleView,
    );

    expect(
      issueText(
        planningProposalSchema.safeParse({
          ...proposal,
          baseProjectIntentRevision: 1,
        }),
      ),
    ).toMatch(/proposal base revisions must be jointly null or non-null/i);

    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...laterApprovedCycleView,
          cycle: {
            ...laterApprovedCycleView.cycle,
            baseLedgerRevision: null,
          },
          proposals: [
            {
              ...laterProposal,
              baseLedgerRevision: null,
            },
          ],
        }),
      ),
    ).toMatch(/cycle base revisions must be jointly null or non-null/i);

    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...laterApprovedCycleView,
          proposals: [
            {
              ...laterProposal,
              baseProjectIntentRevision: 2,
              baseLedgerRevision: 2,
            },
          ],
        }),
      ),
    ).toMatch(/proposal base must match the cycle base/i);
  });

  it('enforces proposal decision fields and cycle/latest-proposal coherence', () => {
    const activeExecutionId = randomUUID();
    const activeHumanTurn = {
      ...cycleView.turns[0],
      id: randomUUID(),
      ordinal: 3,
      message: 'Revise the proposal.',
      executionId: activeExecutionId,
    };
    const activeCycleView = {
      ...cycleView,
      cycle: {
        ...cycleView.cycle,
        lifecycle: 'execution_active' as const,
        activeExecutionId,
      },
      turns: [...cycleView.turns, activeHumanTurn],
      proposals: [
        { ...proposal, lifecycle: 'superseded' as const, decidedAt: now },
      ],
    };
    expect(planningCycleViewSchema.parse(activeCycleView)).toEqual(
      activeCycleView,
    );

    for (const [label, candidate, expected] of [
      [
        'awaiting proposal with decision time',
        { ...proposal, decidedAt: now },
        /awaiting proposals cannot have decision fields/i,
      ],
      [
        'approved proposal without decision time',
        { ...proposal, lifecycle: 'approved' },
        /decided proposals require a decision time/i,
      ],
      [
        'rejected proposal without feedback',
        { ...proposal, lifecycle: 'rejected', decidedAt: now },
        /rejected proposals require feedback/i,
      ],
      [
        'approved proposal with rejection feedback',
        {
          ...proposal,
          lifecycle: 'approved',
          rejectionFeedback: 'No',
          decidedAt: now,
        },
        /only rejected proposals can have rejection feedback/i,
      ],
    ] as const) {
      expect(
        issueText(planningProposalSchema.safeParse(candidate)),
        label,
      ).toMatch(expected);
    }

    for (const [label, candidate, expected] of [
      [
        'awaiting approval without proposal',
        {
          ...cycleView,
          cycle: { ...cycleView.cycle, latestProposalRevision: 0 },
          proposals: [],
        },
        /awaiting-approval cycles require a latest proposal/i,
      ],
      [
        'wrong latest proposal revision',
        {
          ...cycleView,
          cycle: { ...cycleView.cycle, latestProposalRevision: 2 },
        },
        /latest proposal revision must match/i,
      ],
      [
        'terminal cycle without end time',
        {
          ...approvedCycleView,
          cycle: { ...approvedCycleView.cycle, endedAt: null },
        },
        /terminal cycles require an end time/i,
      ],
      [
        'nonterminal cycle with end time',
        { ...cycleView, cycle: { ...cycleView.cycle, endedAt: now } },
        /nonterminal cycles cannot have an end time/i,
      ],
      [
        'active cycle without execution',
        {
          ...cycleView,
          cycle: {
            ...cycleView.cycle,
            lifecycle: 'execution_active',
            activeExecutionId: null,
          },
        },
        /active cycles require an execution id/i,
      ],
      [
        'active cycle with unrelated execution',
        {
          ...activeCycleView,
          cycle: {
            ...activeCycleView.cycle,
            activeExecutionId: randomUUID(),
          },
        },
        /active execution must match the latest bound human turn/i,
      ],
      [
        'active cycle after a PM response',
        {
          ...activeCycleView,
          cycle: {
            ...activeCycleView.cycle,
            activeExecutionId: executionId,
          },
          turns: cycleView.turns,
        },
        /execution-active cycles require the latest turn to be the active bound human/i,
      ],
    ] as const) {
      expect(
        issueText(planningCycleViewSchema.safeParse(candidate)),
        label,
      ).toMatch(expected);
    }

    const twoOpenCycles = {
      protocolVersion: V2_PROTOCOL_VERSION,
      project,
      profiles: [],
      executions: [],
      attentionItems: [],
      planningCycles: [
        asIntentCycleView(cycleView),
        asIntentCycleView({
          ...cycleView,
          cycle: { ...cycleView.cycle, id: randomUUID() },
          turns: [],
          proposals: [],
        }),
      ],
      planningHistoryTruncated: false,
      intentLedger: null,
      deliveryPlan: null,
      board: boardWithoutPlan('intent_required'),
      cursors: { domain: 0, runtime: 0 },
    };
    expect(issueText(v2ProjectSnapshotSchema.safeParse(twoOpenCycles))).toMatch(
      /at most one nonterminal planning cycle/i,
    );
  });

  it.each([
    ['launch_pending', 'launch_pending', null],
    ['execution_active', 'execution_bound', randomUUID()],
    ['attention_required', 'launch_pending', null],
    ['attention_required', 'execution_bound', randomUUID()],
  ] as const)(
    'preserves an awaiting proposal during a %s revision request',
    (lifecycle, launchState, revisionExecutionId) => {
      const revisionTurn = {
        ...cycleView.turns[0],
        id: randomUUID(),
        ordinal: 3,
        message: 'Revise the current proposal.',
        launchState,
        executionId: revisionExecutionId,
      };
      const view = {
        ...cycleView,
        cycle: {
          ...cycleView.cycle,
          lifecycle,
          activeExecutionId:
            lifecycle === 'execution_active' ? revisionExecutionId : null,
        },
        turns: [...cycleView.turns, revisionTurn],
      };

      expect(planningCycleViewSchema.parse(view)).toEqual(view);
    },
  );

  it('preserves an awaiting proposal when a revision PM asks current questions', () => {
    const revisionExecutionId = randomUUID();
    const revisionHumanTurn = {
      ...cycleView.turns[0],
      id: randomUUID(),
      ordinal: 3,
      message: 'Revise the current proposal.',
      executionId: revisionExecutionId,
    };
    const revisionPmTurn = {
      ...cycleView.turns[1],
      id: randomUUID(),
      ordinal: 4,
      message: 'I need one more answer.',
      executionId: revisionExecutionId,
    };
    const view = {
      ...cycleView,
      cycle: {
        ...cycleView.cycle,
        lifecycle: 'awaiting_human' as const,
      },
      turns: [...cycleView.turns, revisionHumanTurn, revisionPmTurn],
      questions: [
        {
          ...planningQuestion,
          id: randomUUID(),
          turnId: revisionPmTurn.id,
        },
      ],
    };

    expect(planningCycleViewSchema.parse(view)).toEqual(view);
  });

  it.each([
    [
      'the same PM turn produced the proposal and question',
      {
        ...cycleView,
        cycle: {
          ...cycleView.cycle,
          lifecycle: 'awaiting_human' as const,
        },
        questions: [planningQuestion],
      },
    ],
    [
      'the question PM lacks a bound post-proposal human turn',
      (() => {
        const questionPmTurn = {
          ...cycleView.turns[1],
          id: randomUUID(),
          ordinal: 3,
          message: 'Unrelated question output.',
        };
        return {
          ...cycleView,
          cycle: {
            ...cycleView.cycle,
            lifecycle: 'awaiting_human' as const,
          },
          turns: [...cycleView.turns, questionPmTurn],
          questions: [
            {
              ...planningQuestion,
              id: randomUUID(),
              turnId: questionPmTurn.id,
            },
          ],
        };
      })(),
    ],
  ] as const)('rejects awaiting-human when %s', (_label, view) => {
    expect(planningCycleViewSchema.safeParse(view).success).toBe(false);
  });

  it('rejects unrelated recovery state for an awaiting proposal', () => {
    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...cycleView,
          cycle: {
            ...cycleView.cycle,
            lifecycle: 'attention_required',
          },
        }),
      ),
    ).toMatch(/awaiting proposal recovery requires a trailing human turn/i);
  });

  it.each([
    ['awaiting approval', cycleView],
    ['approved', approvedCycleView],
    [
      'proposal rejected',
      {
        ...cycleView,
        cycle: {
          ...cycleView.cycle,
          lifecycle: 'proposal_rejected' as const,
          endedAt: now,
        },
        proposals: [
          {
            ...proposal,
            lifecycle: 'rejected' as const,
            rejectionFeedback: 'Needs revision.',
            decidedAt: now,
          },
        ],
      },
    ],
  ] as const)(
    'requires the %s cycle to end at its proposal-producing PM turn',
    (_label, view) => {
      const trailingHuman = {
        ...cycleView.turns[0],
        id: randomUUID(),
        ordinal: 3,
        message: 'A stale trailing request.',
        launchState: 'launch_pending' as const,
        executionId: null,
      };

      expect(
        issueText(
          planningCycleViewSchema.safeParse({
            ...view,
            turns: [...view.turns, trailingHuman],
          }),
        ),
      ).toMatch(/cycle must end at the proposal-producing PM turn/i);
    },
  );

  it('rejects another PM response after the proposal-producing PM turn', () => {
    const laterExecutionId = randomUUID();
    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...cycleView,
          turns: [
            ...cycleView.turns,
            {
              ...cycleView.turns[0],
              id: randomUUID(),
              ordinal: 3,
              message: 'A later request.',
              executionId: laterExecutionId,
            },
            {
              ...cycleView.turns[1],
              id: randomUUID(),
              ordinal: 4,
              message: 'A later response.',
              executionId: laterExecutionId,
            },
          ],
        }),
      ),
    ).toMatch(/cycle must end at the proposal-producing PM turn/i);
  });

  it('requires current PM question output for awaiting-human cycles', () => {
    const awaitingHumanView = {
      ...cycleView,
      cycle: {
        ...cycleView.cycle,
        lifecycle: 'awaiting_human' as const,
        latestProposalRevision: 0,
      },
      questions: [planningQuestion],
      proposals: [],
    };
    expect(planningCycleViewSchema.parse(awaitingHumanView)).toEqual(
      awaitingHumanView,
    );

    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...awaitingHumanView,
          turns: [cycleView.turns[0]],
          questions: [],
        }),
      ),
    ).toMatch(
      /awaiting-human cycles require the latest turn to be PM-authored/i,
    );
    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...awaitingHumanView,
          questions: [],
        }),
      ),
    ).toMatch(
      /awaiting-human cycles require questions from the latest PM turn/i,
    );

    const earlierPmTurnId = randomUUID();
    expect(
      issueText(
        planningCycleViewSchema.safeParse({
          ...awaitingHumanView,
          questions: [
            {
              ...planningQuestion,
              id: randomUUID(),
              turnId: earlierPmTurnId,
            },
          ],
          turns: [
            {
              ...cycleView.turns[0],
              id: randomUUID(),
            },
            {
              ...cycleView.turns[1],
              id: earlierPmTurnId,
            },
            {
              ...cycleView.turns[0],
              id: randomUUID(),
              ordinal: 3,
            },
            {
              ...cycleView.turns[1],
              id: randomUUID(),
              ordinal: 4,
            },
          ],
        }),
      ),
    ).toMatch(
      /awaiting-human cycles require questions from the latest PM turn/i,
    );
  });

  it('enforces pending-turn, proposal-awaiting, and contiguous-order lifecycle rules', () => {
    const pendingTurn = {
      ...cycleView.turns[0],
      id: randomUUID(),
      ordinal: 3,
      message: 'Revise the proposal.',
      launchState: 'launch_pending' as const,
      executionId: null,
    };
    const pendingView = {
      ...cycleView,
      cycle: { ...cycleView.cycle, lifecycle: 'launch_pending' as const },
      turns: [...cycleView.turns, pendingTurn],
      proposals: [
        { ...proposal, lifecycle: 'superseded' as const, decidedAt: now },
      ],
    };
    expect(planningCycleViewSchema.parse(pendingView)).toEqual(pendingView);

    const laterSupersededProposal = {
      ...proposal,
      id: randomUUID(),
      revision: 2,
      lifecycle: 'superseded' as const,
      decidedAt: now,
    };
    const firstSupersededProposal = {
      ...proposal,
      lifecycle: 'superseded' as const,
      decidedAt: now,
    };
    const secondAwaitingProposal = {
      ...proposal,
      id: randomUUID(),
      revision: 2,
    };
    const contiguousHistory = {
      ...cycleView,
      cycle: { ...cycleView.cycle, latestProposalRevision: 2 },
      proposals: [firstSupersededProposal, secondAwaitingProposal],
    };
    expect(planningCycleViewSchema.parse(contiguousHistory)).toEqual(
      contiguousHistory,
    );

    const nonLatestApproved = {
      ...contiguousHistory,
      proposals: [
        {
          ...firstSupersededProposal,
          lifecycle: 'approved' as const,
        },
        secondAwaitingProposal,
      ],
    };

    for (const [label, candidate, expected] of [
      [
        'launch pending without pending human turn',
        {
          ...cycleView,
          cycle: { ...cycleView.cycle, lifecycle: 'launch_pending' },
        },
        /launch-pending cycles require the latest turn/i,
      ],
      [
        'pending human turn is not latest',
        {
          ...pendingView,
          turns: [pendingTurn, ...cycleView.turns].map((turn, index) => ({
            ...turn,
            ordinal: index + 1,
          })),
        },
        /launch-pending cycles require the latest turn/i,
      ],
      [
        'turn ordinals out of order',
        { ...cycleView, turns: [...cycleView.turns].reverse() },
        /turn ordinals must be ordered and contiguous/i,
      ],
      [
        'turn ordinal gap',
        {
          ...cycleView,
          turns: [cycleView.turns[0], { ...cycleView.turns[1], ordinal: 3 }],
        },
        /turn ordinals must be ordered and contiguous/i,
      ],
      [
        'multiple awaiting proposals',
        {
          ...cycleView,
          cycle: { ...cycleView.cycle, latestProposalRevision: 2 },
          proposals: [proposal, { ...proposal, id: randomUUID(), revision: 2 }],
        },
        /at most one proposal can await approval/i,
      ],
      [
        'awaiting proposal is not latest',
        {
          ...pendingView,
          cycle: { ...pendingView.cycle, latestProposalRevision: 2 },
          proposals: [proposal, laterSupersededProposal],
        },
        /awaiting proposal must be latest/i,
      ],
      [
        'proposal revision gap',
        {
          ...contiguousHistory,
          cycle: { ...contiguousHistory.cycle, latestProposalRevision: 3 },
          proposals: [
            firstSupersededProposal,
            { ...secondAwaitingProposal, revision: 3 },
          ],
        },
        /proposal revisions must be ordered and contiguous/i,
      ],
      [
        'proposal revisions reordered',
        {
          ...contiguousHistory,
          proposals: [secondAwaitingProposal, firstSupersededProposal],
        },
        /proposal revisions must be ordered and contiguous/i,
      ],
      [
        'non-latest proposal is not superseded',
        nonLatestApproved,
        /non-latest proposals must be superseded/i,
      ],
      [
        'awaiting proposal outside an awaiting-approval cycle',
        {
          ...cycleView,
          cycle: { ...cycleView.cycle, lifecycle: 'awaiting_human' },
        },
        /latest proposal lifecycle must match the cycle/i,
      ],
      [
        'approved proposal outside an approved cycle',
        {
          ...approvedCycleView,
          cycle: {
            ...approvedCycleView.cycle,
            lifecycle: 'awaiting_human',
            endedAt: null,
          },
        },
        /latest proposal lifecycle must match the cycle/i,
      ],
      [
        'rejected proposal outside a rejected cycle',
        {
          ...cycleView,
          cycle: { ...cycleView.cycle, lifecycle: 'awaiting_human' },
          proposals: [
            {
              ...proposal,
              lifecycle: 'rejected',
              rejectionFeedback: 'Needs revision.',
              decidedAt: now,
            },
          ],
        },
        /latest proposal lifecycle must match the cycle/i,
      ],
    ] as const) {
      expect(
        issueText(planningCycleViewSchema.safeParse(candidate)),
        label,
      ).toMatch(expected);
    }
  });

  it('requires planning cycle and turn ids to be globally unique in snapshots', () => {
    const historicalCycleId = randomUUID();
    const historicalHumanTurnId = randomUUID();
    const historicalPmTurnId = randomUUID();
    const historicalCycle = {
      ...cycleView,
      cycle: {
        ...cycleView.cycle,
        id: historicalCycleId,
        lifecycle: 'abandoned' as const,
        latestProposalRevision: 0,
        endedAt: now,
      },
      turns: [
        {
          ...cycleView.turns[0],
          id: historicalHumanTurnId,
          planningCycleId: historicalCycleId,
        },
        {
          ...cycleView.turns[1],
          id: historicalPmTurnId,
          planningCycleId: historicalCycleId,
        },
      ],
      proposals: [],
    };
    const distinctCycleId = randomUUID();
    const distinctCycle = {
      ...historicalCycle,
      cycle: { ...historicalCycle.cycle, id: distinctCycleId },
      turns: historicalCycle.turns.map((turn) => ({
        ...turn,
        id: randomUUID(),
        planningCycleId: distinctCycleId,
      })),
    };
    const snapshot = {
      protocolVersion: V2_PROTOCOL_VERSION,
      project,
      profiles: [],
      executions: [],
      attentionItems: [],
      planningCycles: [
        asIntentCycleView(historicalCycle),
        asIntentCycleView(distinctCycle),
      ],
      planningHistoryTruncated: false,
      intentLedger: null,
      deliveryPlan: null,
      board: boardWithoutPlan('intent_required'),
      cursors: { domain: 0, runtime: 0 },
    };

    expect(v2ProjectSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      issueText(
        v2ProjectSnapshotSchema.safeParse({
          ...snapshot,
          planningCycles: [
            asIntentCycleView(historicalCycle),
            asIntentCycleView({
              ...distinctCycle,
              turns: distinctCycle.turns.map((turn, index) => ({
                ...turn,
                id: index === 0 ? historicalHumanTurnId : historicalPmTurnId,
              })),
            }),
          ],
        }),
      ),
    ).toMatch(/planning turn ids must be unique across cycles/i);

    const duplicateCycleId = {
      ...distinctCycle,
      cycle: { ...distinctCycle.cycle, id: historicalCycleId },
      turns: distinctCycle.turns.map((turn) => ({
        ...turn,
        planningCycleId: historicalCycleId,
      })),
    };
    expect(
      issueText(
        v2ProjectSnapshotSchema.safeParse({
          ...snapshot,
          planningCycles: [
            asIntentCycleView(historicalCycle),
            asIntentCycleView(duplicateCycleId),
          ],
        }),
      ),
    ).toMatch(/planning cycle ids must be unique/i);
  });

  it('requires exact projected lifecycles in planning command successes', () => {
    for (const [commandType, expected] of [
      [
        'planning_cycle.submit_turn',
        /submit-turn success must be launch-pending/i,
      ],
      ['planning_proposal.reject', /reject success must be proposal-rejected/i],
      ['planning_cycle.abandon', /abandon success must be abandoned/i],
    ] as const) {
      expect(
        issueText(
          v2CommandResultSchema.safeParse({
            ok: true,
            commandType,
            planningCycle: cycleView,
          }),
        ),
        commandType,
      ).toMatch(expected);
    }
  });

  it('separates ordered legacy event fallback from receipt-only command normalization', () => {
    const legacyApproval = {
      planningCycle: approvedCycleView,
      intentLedger: approvedIntentLedger,
    };
    const ordered = normalizeIntentLedgerApprovedPayload(legacyApproval);
    expect(ordered).toMatchObject({
      schemaVersion: 2,
      deliveryPlan: null,
      board: {
        projectId,
        deliveryPlanRevision: null,
        emptyReason: 'planning_required',
      },
    });
    const receipt = normalizePlanningCommandSuccess({
      ok: true,
      commandType: 'planning_proposal.approve',
      ...legacyApproval,
    });
    expect(receipt).toMatchObject({
      source: 'legacy_m2',
      projectionAuthority: 'receipt_only',
    });
  });

  it('requires assignment base and next-proposal revision coherence', () => {
    const assignment = {
      kind: 'pm_discovery' as const,
      projectId,
      outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
      planningCycleId,
      humanTurnId,
      expectedCycleRevision: 3,
      expectedProposalRevision: 2,
      baseProjectIntentRevision: 1,
      baseLedgerRevision: 1,
      input: {
        conversation: [
          {
            turnId: humanTurnId,
            actor: 'human' as const,
            message: 'Revise it.',
          },
        ],
        latestProposal: {
          ...proposal,
          baseProjectIntentRevision: 1,
          baseLedgerRevision: 1,
        },
        approvedIntentLedger,
      },
    };
    expect(pmDiscoveryAssignmentSchema.parse(assignment)).toEqual(assignment);

    for (const [label, candidate, expected] of [
      [
        'intent base mismatch',
        { ...assignment, baseProjectIntentRevision: 2 },
        /base project intent revision must match/i,
      ],
      [
        'ledger base mismatch',
        { ...assignment, baseLedgerRevision: 2 },
        /base ledger revision must match/i,
      ],
      [
        'wrong next proposal revision',
        { ...assignment, expectedProposalRevision: 1 },
        /expected proposal revision must follow/i,
      ],
      [
        'latest proposal base mismatch',
        {
          ...assignment,
          input: {
            ...assignment.input,
            latestProposal: {
              ...assignment.input.latestProposal,
              baseLedgerRevision: null,
            },
          },
        },
        /latest proposal must match the assignment canonical base/i,
      ],
      [
        'first proposal starts after one',
        {
          ...assignment,
          expectedProposalRevision: 2,
          input: { ...assignment.input, latestProposal: null },
        },
        /expected proposal revision must be one/i,
      ],
      [
        'duplicate conversation turn across actors',
        {
          ...assignment,
          input: {
            ...assignment.input,
            conversation: [
              assignment.input.conversation[0],
              {
                turnId: humanTurnId,
                actor: 'pm',
                message: 'Duplicate turn ID.',
              },
            ],
          },
        },
        /conversation turn IDs must be unique/i,
      ],
    ] as const) {
      expect(
        issueText(pmDiscoveryAssignmentSchema.safeParse(candidate)),
        label,
      ).toMatch(expected);
    }
  });

  it('requires an assignment to identify its latest human conversation turn', () => {
    const latestHumanTurnId = randomUUID();
    const assignment = {
      kind: 'pm_discovery' as const,
      projectId,
      outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
      planningCycleId,
      humanTurnId,
      expectedCycleRevision: 1,
      expectedProposalRevision: 1,
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      input: {
        conversation: [
          {
            turnId: humanTurnId,
            actor: 'human' as const,
            message: 'First request.',
          },
          {
            turnId: randomUUID(),
            actor: 'pm' as const,
            message: 'First response.',
          },
          {
            turnId: latestHumanTurnId,
            actor: 'human' as const,
            message: 'Latest request.',
          },
        ],
        latestProposal: null,
        approvedIntentLedger: null,
      },
    };

    expect(
      issueText(pmDiscoveryAssignmentSchema.safeParse(assignment)),
    ).toMatch(
      /assignment human turn must be the latest human conversation turn/i,
    );
    expect(
      pmDiscoveryAssignmentSchema.safeParse({
        ...assignment,
        humanTurnId: latestHumanTurnId,
      }).success,
    ).toBe(true);

    expect(
      issueText(
        pmDiscoveryAssignmentSchema.safeParse({
          ...assignment,
          humanTurnId: latestHumanTurnId,
          input: {
            ...assignment.input,
            conversation: [
              ...assignment.input.conversation,
              {
                turnId: randomUUID(),
                actor: 'pm' as const,
                message: 'A stale trailing response.',
              },
            ],
          },
        }),
      ),
    ).toMatch(/assignment conversation must end at its target human turn/i);
  });

  it('bounds human and PM turns separately at 32 in assignments and cycle views', () => {
    const conversation = (humanCount: number, pmCount: number) => [
      ...Array.from({ length: humanCount }, (_, index) => ({
        turnId: index === humanCount - 1 ? humanTurnId : randomUUID(),
        actor: 'human' as const,
        message: `Human ${index}`,
      })),
      ...Array.from({ length: pmCount }, (_, index) => ({
        turnId: randomUUID(),
        actor: 'pm' as const,
        message: `PM ${index}`,
      })),
    ];
    const turns = (humanCount: number, pmCount: number) => {
      const grouped = conversation(humanCount, pmCount);
      const ordered = [];
      for (let index = 0; index < Math.max(humanCount, pmCount); index += 1) {
        if (index < humanCount) ordered.push(grouped[index]);
        if (index < pmCount) ordered.push(grouped[humanCount + index]);
      }
      return ordered.map(({ turnId, ...turn }, index) => ({
        ...turn,
        id: turnId,
        projectId,
        planningCycleId,
        ordinal: index + 1,
        launchState:
          turn.actor === 'human' ? ('execution_bound' as const) : null,
        executionId,
        createdAt: now,
      }));
    };
    const assignment = (humanCount: number, pmCount: number) => ({
      kind: 'pm_discovery' as const,
      projectId,
      outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
      planningCycleId,
      humanTurnId,
      expectedCycleRevision: 1,
      expectedProposalRevision: 1,
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      input: {
        conversation: (() => {
          const grouped = conversation(humanCount, pmCount);
          return humanCount === 0
            ? grouped
            : [
                ...grouped.slice(0, humanCount - 1),
                ...grouped.slice(humanCount),
                grouped[humanCount - 1],
              ];
        })(),
        latestProposal: null,
        approvedIntentLedger: null,
      },
    });
    const view = (humanCount: number, pmCount: number) => ({
      ...cycleView,
      cycle: {
        ...cycleView.cycle,
        lifecycle: 'attention_required' as const,
        latestProposalRevision: 0,
      },
      turns: turns(humanCount, pmCount),
      proposals: [],
    });

    expect(
      pmDiscoveryAssignmentSchema.safeParse(assignment(32, 32)).success,
    ).toBe(true);
    expect(
      pmDiscoveryAssignmentSchema.safeParse(assignment(33, 0)).success,
    ).toBe(false);
    expect(
      pmDiscoveryAssignmentSchema.safeParse(assignment(1, 33)).success,
    ).toBe(false);
    expect(issueText(planningCycleViewSchema.safeParse(view(32, 32)))).toBe('');
    expect(planningCycleViewSchema.safeParse(view(33, 0)).success).toBe(false);
    expect(planningCycleViewSchema.safeParse(view(1, 33)).success).toBe(false);
  });

  it('round-trips a strict bounded server-computed proposal diff', () => {
    expect(planningProposalSchema.parse(proposal).diff).toEqual(proposalDiff);
    expect(() =>
      planningProposalSchema.parse({
        ...proposal,
        diff: { ...proposalDiff, extra: true },
      }),
    ).toThrow();
    expect(() =>
      planningProposalSchema.parse({
        ...proposal,
        diff: {
          ...proposalDiff,
          intentChanges: [...proposalDiff.intentChanges, 'unknown'],
        },
      }),
    ).toThrow();
    expect(() =>
      planningProposalSchema.parse({
        ...proposal,
        diff: {
          ...proposalDiff,
          recordChanges: { ...proposalDiff.recordChanges, create: 1 },
        },
      }),
    ).toThrow(/record change counts must match/i);
    expect(() =>
      planningProposalSchema.parse({
        ...proposal,
        diff: {
          ...proposalDiff,
          relationshipChanges: {
            added: [],
            removed: proposalResult.relationships,
          },
        },
      }),
    ).toThrow(/removed relationships cannot remain/i);
    expect(() =>
      planningProposalSchema.parse({
        ...proposal,
        records: [
          ...proposal.records,
          {
            operation: 'create',
            key: 'archive-todo',
            recordId: randomUUID(),
            content: requirementContent,
            provenance,
          },
        ],
        diff: {
          ...proposalDiff,
          recordChanges: { create: 3, revise: 0, reuse: 0 },
          relationshipChanges: {
            added: [
              {
                kind: 'depends_on',
                from: { proposalKey: 'complete-todo' },
                to: { proposalKey: 'archive-todo' },
              },
            ],
            removed: [],
          },
        },
      }),
    ).toThrow(/added relationships must appear in the proposal/i);
    expect(() =>
      planningProposalDiffSchema.parse({
        ...proposalDiff,
        relationshipChanges: {
          added: [
            {
              kind: 'duplicates',
              from: { proposalKey: 'left' },
              to: { proposalKey: 'right' },
            },
            {
              kind: 'duplicates',
              from: { proposalKey: 'right' },
              to: { proposalKey: 'left' },
            },
          ],
          removed: [],
        },
      }),
    ).toThrow(/relationship changes must be unique/i);
  });

  it.each([
    [
      'an unresolved removed relationship',
      {
        kind: 'depends_on' as const,
        from: { proposalKey: 'missing-record' },
        to: { proposalKey: 'complete-todo' },
      },
      /relationship endpoint must resolve inside the proposal/i,
    ],
    [
      'a self-referential removed relationship',
      {
        kind: 'depends_on' as const,
        from: { proposalKey: 'complete-todo' },
        to: { proposalKey: 'complete-todo' },
      },
      /proposal relationships cannot be self-edges/i,
    ],
  ])('rejects %s for projected create records', (_label, removed, expected) => {
    expect(() =>
      planningProposalSchema.parse({
        ...proposal,
        diff: {
          ...proposalDiff,
          relationshipChanges: {
            ...proposalDiff.relationshipChanges,
            removed: [removed],
          },
        },
      }),
    ).toThrow(expected);
  });

  it('bounds added and removed relationship changes independently', () => {
    const records = Array.from({ length: 20 }, (_, index) => ({
      operation: 'create' as const,
      key: `bulk-record-${index}`,
      recordId: randomUUID(),
      content: requirementContent,
      provenance,
    }));
    const relationships = records.flatMap((from, fromIndex) =>
      records
        .filter((_, toIndex) => toIndex !== fromIndex)
        .map((to) => ({
          kind: 'depends_on' as const,
          from: { proposalKey: from.key },
          to: { proposalKey: to.key },
        })),
    );
    const added = relationships.slice(0, 101);
    const removed = relationships.slice(101, 201);
    const candidate = {
      ...proposal,
      records,
      relationships: added,
      diff: {
        ...proposalDiff,
        recordChanges: { create: records.length, revise: 0, reuse: 0 },
        relationshipChanges: { added, removed },
      },
    };

    expect(planningProposalSchema.parse(candidate)).toEqual(candidate);

    for (const relationshipChanges of [
      { added: relationships.slice(0, 201), removed: [] },
      { added: [], removed: relationships.slice(0, 201) },
    ]) {
      expect(
        planningProposalDiffSchema.safeParse({
          ...proposalDiff,
          relationshipChanges,
        }).success,
      ).toBe(false);
    }
  });

  it('preserves semantic relationship issue paths', () => {
    const unresolved = {
      kind: 'depends_on' as const,
      from: { proposalKey: 'missing-record' },
      to: { proposalKey: 'complete-todo' },
    };
    const finalResult = planningProposalSchema.safeParse({
      ...proposal,
      relationships: [unresolved],
      diff: {
        ...proposalDiff,
        relationshipChanges: { added: [unresolved], removed: [] },
      },
    });
    const removedResult = planningProposalSchema.safeParse({
      ...proposal,
      diff: {
        ...proposalDiff,
        relationshipChanges: {
          ...proposalDiff.relationshipChanges,
          removed: [unresolved],
        },
      },
    });

    expect(finalResult.success).toBe(false);
    expect(removedResult.success).toBe(false);
    if (!finalResult.success) {
      expect(
        finalResult.error.issues.map((issue) => issue.path),
      ).toContainEqual(['relationships', 0, 'from']);
      expect(
        finalResult.error.issues.map((issue) => issue.path),
      ).toContainEqual(['diff', 'relationshipChanges', 'added', 0, 'from']);
    }
    if (!removedResult.success) {
      expect(
        removedResult.error.issues.map((issue) => issue.path),
      ).toContainEqual(['diff', 'relationshipChanges', 'removed', 0, 'from']);
    }
  });

  it('enforces all planning collection boundaries at the limit plus one', () => {
    const proposalMembers = Array.from({ length: 101 }, (_, index) => ({
      operation: 'create' as const,
      key: `record-${index}`,
      content: requirementContent,
      provenance,
    }));
    const relationshipMembers = Array.from({ length: 21 }, (_, index) => ({
      ...proposalMembers[index],
      key: `edge-record-${index}`,
    }));
    const relationshipPairs = relationshipMembers.flatMap((from, fromIndex) =>
      relationshipMembers
        .filter((_, toIndex) => toIndex !== fromIndex)
        .map((to) => ({
          kind: 'depends_on' as const,
          from: { proposalKey: from.key },
          to: { proposalKey: to.key },
        })),
    );
    const questions = Array.from({ length: 21 }, (_, index) => ({
      key: `question-${index}`,
      prompt: `Question ${index}`,
      rationale: `Rationale ${index}`,
    }));
    const planningQuestions = Array.from({ length: 21 }, (_, index) => ({
      id: randomUUID(),
      projectId,
      planningCycleId,
      turnId: pmTurnId,
      key: `persisted-question-${index}`,
      prompt: `Question ${index}`,
      rationale: `Rationale ${index}`,
    }));
    const proposals = Array.from({ length: 17 }, (_, index) => ({
      ...proposal,
      id: randomUUID(),
      revision: index + 1,
      lifecycle:
        index === 16 ? ('awaiting_approval' as const) : ('superseded' as const),
      decidedAt: index === 16 ? null : now,
    }));
    const terminalCycles = Array.from({ length: 21 }, () => ({
      cycle: {
        ...cycleView.cycle,
        id: randomUUID(),
        lifecycle: 'abandoned' as const,
        latestProposalRevision: 0,
        endedAt: now,
      },
      turns: [],
      questions: [],
      proposals: [],
    }));
    const approvedRecords = Array.from({ length: 101 }, () => ({
      ...approvedIntentLedger.records[0],
      recordId: randomUUID(),
    }));
    const approvedRelationships = relationshipPairs
      .slice(0, 201)
      .map((edge) => ({
        kind: edge.kind,
        fromRecordId:
          approvedRecords[
            relationshipMembers.findIndex(
              (member) => member.key === edge.from.proposalKey,
            )
          ].recordId,
        toRecordId:
          approvedRecords[
            relationshipMembers.findIndex(
              (member) => member.key === edge.to.proposalKey,
            )
          ].recordId,
      }));

    const cases = [
      {
        name: 'intent narrative list',
        limit: 100,
        parse: (count: number) =>
          projectIntentContentSchema.safeParse({
            ...projectIntent,
            targetUsers: Array.from(
              { length: count },
              (_, index) => `User ${index}`,
            ),
          }).success,
      },
      {
        name: 'provenance references',
        limit: 20,
        parse: (count: number) =>
          pmProposalResultSchema.safeParse({
            ...proposalResult,
            records: [
              {
                ...proposalResult.records[0],
                provenance: Array.from({ length: count }, (_, index) => ({
                  ...provenance[0],
                  rationale: `Source ${index}`,
                })),
              },
            ],
            relationships: [],
          }).success,
      },
      {
        name: 'question choices',
        limit: 20,
        parse: (count: number) =>
          pmDiscoveryReportSchema.safeParse({
            schema: PM_DISCOVERY_REPORT_SCHEMA,
            planningCycleId,
            humanTurnId,
            expectedCycleRevision: 1,
            expectedProposalRevision: 1,
            assistantMessage: 'Choose.',
            result: {
              kind: 'questions',
              questions: [
                {
                  ...questions[0],
                  choices: Array.from(
                    { length: count },
                    (_, index) => `Choice ${index}`,
                  ),
                },
              ],
            },
          }).success,
      },
      {
        name: 'PM questions',
        limit: 20,
        parse: (count: number) =>
          pmDiscoveryReportSchema.safeParse({
            schema: PM_DISCOVERY_REPORT_SCHEMA,
            planningCycleId,
            humanTurnId,
            expectedCycleRevision: 1,
            expectedProposalRevision: 1,
            assistantMessage: 'Questions.',
            result: { kind: 'questions', questions: questions.slice(0, count) },
          }).success,
      },
      {
        name: 'proposal records',
        limit: 100,
        parse: (count: number) =>
          pmProposalResultSchema.safeParse({
            ...proposalResult,
            records: proposalMembers.slice(0, count),
            relationships: [],
          }).success,
      },
      {
        name: 'proposal relationships',
        limit: 200,
        parse: (count: number) =>
          pmProposalResultSchema.safeParse({
            ...proposalResult,
            records: relationshipMembers,
            relationships: relationshipPairs.slice(0, count),
          }).success,
      },
      {
        name: 'cycle questions',
        limit: 20,
        parse: (count: number) =>
          planningCycleViewSchema.safeParse({
            ...cycleView,
            cycle: {
              ...cycleView.cycle,
              lifecycle: 'awaiting_human',
              latestProposalRevision: 0,
            },
            questions: planningQuestions.slice(0, count),
            proposals: [],
          }).success,
      },
      {
        name: 'proposal history',
        limit: 16,
        parse: (count: number) =>
          planningCycleViewSchema.safeParse({
            ...cycleView,
            cycle: { ...cycleView.cycle, latestProposalRevision: count },
            proposals: proposals.slice(0, count).map((item, index) => ({
              ...item,
              lifecycle:
                index === count - 1
                  ? ('awaiting_approval' as const)
                  : ('superseded' as const),
              decidedAt: index === count - 1 ? null : now,
            })),
          }).success,
      },
      {
        name: 'proposal diff intent changes',
        limit: 8,
        parse: (count: number) =>
          planningProposalSchema.safeParse({
            ...proposal,
            diff: {
              ...proposalDiff,
              intentChanges: [
                'goal',
                'targetUsers',
                'desiredCapabilities',
                'constraints',
                'nonGoals',
                'successConditions',
                'rationale',
                'provenance',
                'goal',
              ].slice(0, count),
            },
          }).success,
      },
      {
        name: 'proposal diff record count',
        limit: 100,
        parse: (count: number) =>
          planningProposalDiffSchema.safeParse({
            ...proposalDiff,
            recordChanges: { ...proposalDiff.recordChanges, create: count },
          }).success,
      },
      {
        name: 'proposal diff relationship changes',
        limit: 200,
        parse: (count: number) =>
          planningProposalDiffSchema.safeParse({
            ...proposalDiff,
            relationshipChanges: {
              added: relationshipPairs.slice(0, count),
              removed: [],
            },
          }).success,
      },
      {
        name: 'approved records',
        limit: 100,
        parse: (count: number) =>
          approvedIntentLedgerSchema.safeParse({
            ...approvedIntentLedger,
            records: approvedRecords.slice(0, count),
            relationships: [],
          }).success,
      },
      {
        name: 'approved relationships',
        limit: 200,
        parse: (count: number) =>
          approvedIntentLedgerSchema.safeParse({
            ...approvedIntentLedger,
            records: approvedRecords.slice(0, 21),
            relationships: approvedRelationships.slice(0, count),
          }).success,
      },
      {
        name: 'snapshot planning cycles',
        limit: 20,
        parse: (count: number) =>
          v2ProjectSnapshotSchema.safeParse({
            protocolVersion: V2_PROTOCOL_VERSION,
            project,
            profiles: [],
            executions: [],
            attentionItems: [],
            planningCycles: terminalCycles
              .slice(0, count)
              .map(asIntentCycleView),
            planningHistoryTruncated: false,
            intentLedger: null,
            deliveryPlan: null,
            board: boardWithoutPlan('intent_required'),
            cursors: { domain: 0, runtime: 0 },
          }).success,
      },
    ];

    for (const boundary of cases) {
      expect(boundary.parse(boundary.limit), boundary.name).toBe(true);
      expect(boundary.parse(boundary.limit + 1), boundary.name).toBe(false);
    }
  });

  it('rejects duplicate proposal and question keys', () => {
    expect(
      issueText(
        pmProposalResultSchema.safeParse({
          ...proposalResult,
          records: [proposalResult.records[0], proposalResult.records[0]],
          relationships: [],
        }),
      ),
    ).toMatch(/proposal keys must be unique/i);
    expect(
      issueText(
        pmProposalResultSchema.safeParse({
          ...proposalResult,
          records: [
            {
              operation: 'reuse',
              recordId: requirementId,
              expectedRevision: 1,
            },
            {
              operation: 'reuse',
              recordId: requirementId,
              expectedRevision: 1,
            },
          ],
          relationships: [],
        }),
      ),
    ).toMatch(/record ids must be unique/i);
    expect(
      issueText(
        pmProposalResultSchema.safeParse({
          ...proposalResult,
          relationships: [
            {
              kind: 'duplicates',
              from: { proposalKey: 'persist-locally' },
              to: { proposalKey: 'complete-todo' },
            },
            {
              kind: 'duplicates',
              from: { proposalKey: 'complete-todo' },
              to: { proposalKey: 'persist-locally' },
            },
          ],
        }),
      ),
    ).toMatch(/relationships must be unique/i);
    expect(
      issueText(
        pmDiscoveryReportSchema.safeParse({
          schema: PM_DISCOVERY_REPORT_SCHEMA,
          planningCycleId,
          humanTurnId,
          expectedCycleRevision: 1,
          expectedProposalRevision: 1,
          assistantMessage: 'Duplicate questions.',
          result: {
            kind: 'questions',
            questions: [
              { key: 'same', prompt: 'One?', rationale: 'One.' },
              { key: 'same', prompt: 'Two?', rationale: 'Two.' },
            ],
          },
        }),
      ),
    ).toMatch(/question keys must be unique/i);
  });

  it.each([
    'functional',
    'quality',
    'ux',
    'safety',
    'operational',
    'constraint',
  ])('accepts requirement kind %s', (kind) => {
    expect(
      requirementRecordContentSchema.parse({
        ...requirementContent,
        kind,
      }).kind,
    ).toBe(kind);
  });

  it('accepts the exact record lifecycle vocabulary and constrains edge', () => {
    const recordCases = [
      [
        'requirement',
        ['proposed', 'approved', 'superseded', 'rejected', 'retired'],
      ],
      ['decision', ['active', 'superseded', 'retired']],
      ['assumption', ['active', 'confirmed', 'invalidated', 'retired']],
      ['question', ['open', 'answered', 'retired']],
      ['risk', ['open', 'mitigated', 'accepted', 'retired']],
    ] as const;

    for (const [type, statuses] of recordCases) {
      for (const status of statuses) {
        const base = {
          type,
          statement: `${type} statement`,
          rationale: `${type} rationale`,
          status,
        };
        const value =
          type === 'requirement'
            ? { ...base, kind: 'functional', priority: 'must' }
            : type === 'assumption'
              ? { ...base, confidence: 'medium' }
              : type === 'question' && status === 'answered'
                ? { ...base, resolution: 'Resolved by the operator.' }
                : type === 'risk'
                  ? { ...base, severity: 'medium', mitigation: 'Test restart.' }
                  : base;
        expect(ledgerRecordContentSchema.parse(value).status).toBe(status);
      }
    }

    expect(
      pmDiscoveryReportSchema.parse({
        schema: PM_DISCOVERY_REPORT_SCHEMA,
        planningCycleId,
        humanTurnId,
        expectedCycleRevision: 1,
        expectedProposalRevision: 1,
        assistantMessage: 'Review the proposal.',
        result: proposalResult,
      }).result,
    ).toEqual(proposalResult);
  });

  it('rejects invalid record shapes and all M3 vocabulary', () => {
    expect(() =>
      requirementRecordContentSchema.parse({
        ...requirementContent,
        kind: 'unknown',
      }),
    ).toThrow();
    expect(() =>
      riskRecordContentSchema.parse({
        type: 'risk',
        statement: 'Restart may lose data.',
        rationale: 'Persistence can fail.',
        status: 'open',
        severity: 'high',
      }),
    ).toThrow();
    expect(() =>
      pmDiscoveryReportSchema.parse({
        schema: PM_DISCOVERY_REPORT_SCHEMA,
        planningCycleId,
        humanTurnId,
        expectedCycleRevision: 1,
        expectedProposalRevision: 1,
        assistantMessage: 'Invalid question.',
        result: {
          ...proposalResult,
          records: [
            {
              operation: 'create',
              key: 'question',
              content: {
                type: 'question',
                statement: 'Which storage?',
                rationale: 'Storage affects recovery.',
                status: 'answered',
              },
              provenance,
            },
          ],
          relationships: [],
        },
      }),
    ).toThrow();
    expect(() =>
      pmDiscoveryReportSchema.parse({
        schema: 'mesh.dev/pm-discovery-report/v2',
        planningCycleId,
        humanTurnId,
        expectedCycleRevision: 1,
        expectedProposalRevision: 1,
        assistantMessage: 'Wrong schema.',
        result: proposalResult,
      }),
    ).toThrow();
    expect(() =>
      decisionRecordContentSchema.parse({
        ...decisionContent,
        priority: 'must',
      }),
    ).toThrow();
    expect(() =>
      requirementRecordContentSchema.parse({
        ...requirementContent,
        taskId: randomUUID(),
      }),
    ).toThrow();
  });

  it('normalizes symmetric edges, preserves directed order, and rejects bad endpoints', () => {
    const left = randomUUID();
    const right = randomUUID();
    const [first, second] = [left, right].sort();
    for (const kind of ['conflicts_with', 'duplicates'] as const) {
      expect(
        ledgerRelationshipSchema.parse({
          kind,
          fromRecordId: right,
          toRecordId: left,
        }),
      ).toEqual({ kind, fromRecordId: first, toRecordId: second });
    }
    expect(
      ledgerRelationshipSchema.parse({
        kind: 'depends_on',
        fromRecordId: right,
        toRecordId: left,
      }),
    ).toEqual({
      kind: 'depends_on',
      fromRecordId: right,
      toRecordId: left,
    });
    for (const kind of [
      'refines',
      'depends_on',
      'conflicts_with',
      'supersedes',
      'duplicates',
    ] as const) {
      expect(
        ledgerRelationshipSchema.parse({
          kind,
          fromRecordId: left,
          toRecordId: right,
        }).kind,
      ).toBe(kind);
    }
    expect(() =>
      ledgerRelationshipSchema.parse({
        kind: 'covers',
        fromRecordId: left,
        toRecordId: right,
      }),
    ).toThrow();
    expect(() =>
      ledgerRelationshipSchema.parse({
        kind: 'depends_on',
        fromRecordId: left,
        toRecordId: left,
      }),
    ).toThrow();
    expect(() =>
      pmDiscoveryReportSchema.parse({
        schema: PM_DISCOVERY_REPORT_SCHEMA,
        planningCycleId,
        humanTurnId,
        expectedCycleRevision: 1,
        expectedProposalRevision: 1,
        assistantMessage: 'Bad local key.',
        result: {
          ...proposalResult,
          relationships: [
            {
              kind: 'depends_on',
              from: { proposalKey: 'missing' },
              to: { proposalKey: 'complete-todo' },
            },
          ],
        },
      }),
    ).toThrow(/proposal|endpoint|key/i);
  });

  it('round-trips strict question and proposal reports and bounded lifecycle views', () => {
    expect(PM_DISCOVERY_REPORT_SCHEMA).toBe('mesh.dev/pm-discovery-report/v1');
    expect(
      pmDiscoveryReportSchema.parse({
        schema: PM_DISCOVERY_REPORT_SCHEMA,
        planningCycleId,
        humanTurnId,
        expectedCycleRevision: 1,
        expectedProposalRevision: 1,
        assistantMessage: 'Please clarify storage.',
        result: {
          kind: 'questions',
          questions: [
            {
              key: 'storage',
              prompt: 'Should Todos survive restart?',
              rationale: 'This determines persistence requirements.',
              choices: ['Yes', 'No'],
            },
          ],
        },
      }).result.kind,
    ).toBe('questions');
    expect(
      pmDiscoveryReportSchema.parse({
        schema: PM_DISCOVERY_REPORT_SCHEMA,
        planningCycleId,
        humanTurnId,
        expectedCycleRevision: 1,
        expectedProposalRevision: 1,
        assistantMessage: 'Review the proposal.',
        result: proposalResult,
      }).result,
    ).toEqual(proposalResult);
    expect(planningCycleViewSchema.parse(cycleView)).toEqual(cycleView);
    expect(planningCycleLifecycleSchema.parse('launch_pending')).toBe(
      'launch_pending',
    );
    expect(planningTurnLaunchStateSchema.parse('execution_bound')).toBe(
      'execution_bound',
    );
    expect(() =>
      pmDiscoveryReportSchema.parse({
        schema: PM_DISCOVERY_REPORT_SCHEMA,
        planningCycleId,
        humanTurnId,
        expectedCycleRevision: 1,
        expectedProposalRevision: 1,
        assistantMessage: 'No authority.',
        result: { kind: 'approve', proposalId },
      }),
    ).toThrow();
    expect(() =>
      pmDiscoveryReportSchema.parse({
        schema: PM_DISCOVERY_REPORT_SCHEMA,
        planningCycleId,
        humanTurnId,
        expectedCycleRevision: 1,
        expectedProposalRevision: 1,
        assistantMessage: 'Unknown field.',
        result: proposalResult,
        approved: true,
      }),
    ).toThrow();
  });

  it('extends commands, results, events, snapshots, assignments, and profiles coherently', () => {
    const pmProfile = {
      ...resolvedProfile,
      document: {
        ...resolvedProfile.document,
        metadata: {
          ...resolvedProfile.document.metadata,
          name: 'pm-discovery',
          displayName: 'PM discovery',
        },
        spec: {
          ...resolvedProfile.document.spec,
          assignmentKinds: ['pm_discovery'] as const,
          outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
        },
      },
    };
    const assignment = {
      kind: 'pm_discovery' as const,
      projectId,
      outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
      planningCycleId,
      humanTurnId,
      expectedCycleRevision: 1,
      expectedProposalRevision: 1,
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      input: {
        conversation: [
          { turnId: humanTurnId, actor: 'human' as const, message: 'Todo app' },
        ],
        latestProposal: null,
        approvedIntentLedger: null,
      },
    };
    expect(pmDiscoveryAssignmentSchema.parse(assignment)).toEqual(assignment);
    expect(
      workerExecutionSchema.parse({
        ...execution,
        assignment,
        profileSnapshot: pmProfile,
      }).assignment.kind,
    ).toBe('pm_discovery');
    expect(() =>
      workerExecutionSchema.parse({
        ...execution,
        assignment,
        profileSnapshot: resolvedProfile,
      }),
    ).toThrow(/assignment|profile/i);
    expect(() =>
      workerExecutionSchema.parse({
        ...execution,
        assignment,
        profileSnapshot: {
          ...pmProfile,
          document: {
            ...pmProfile.document,
            spec: {
              ...pmProfile.document.spec,
              outputSchema: 'mesh.dev/wrong/v1',
            },
          },
        },
      }),
    ).toThrow(/schema|profile/i);

    const envelopes = [
      submitPlanningTurnEnvelopeSchema.parse({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.submit_turn',
          projectId,
          expectedCycleRevision: null,
          profileId,
          profileRevision: 1,
          message: 'Build a Todo app.',
        },
      }),
      approvePlanningProposalEnvelopeSchema.parse({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'planning_proposal.approve',
          projectId,
          planningCycleId,
          proposalId,
          expectedCycleRevision: 2,
          expectedProposalRevision: 1,
          expectedProjectIntentRevision: null,
          expectedLedgerRevision: null,
        },
      }),
      rejectPlanningProposalEnvelopeSchema.parse({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'planning_proposal.reject',
          projectId,
          planningCycleId,
          proposalId,
          expectedCycleRevision: 2,
          expectedProposalRevision: 1,
          feedback: 'Keep the scope smaller.',
        },
      }),
      abandonPlanningCycleEnvelopeSchema.parse({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.abandon',
          projectId,
          planningCycleId,
          expectedCycleRevision: 2,
        },
      }),
    ];
    expect(envelopes.map(({ command }) => command.type)).toEqual([
      'planning_cycle.submit_turn',
      'planning_proposal.approve',
      'planning_proposal.reject',
      'planning_cycle.abandon',
    ]);
    expect(() =>
      approvePlanningProposalEnvelopeSchema.parse({
        ...envelopes[1],
        actor: { kind: 'pm' },
      }),
    ).toThrow();
    expect(() =>
      submitPlanningTurnEnvelopeSchema.parse({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'planning_cycle.submit_turn',
          projectId,
          planningCycleId,
          expectedCycleRevision: null,
          message: 'This existing cycle needs its current revision.',
        },
      }),
    ).toThrow();

    const successResults = [
      {
        ok: true,
        commandType: 'planning_cycle.submit_turn',
        planningCycle: {
          ...cycleView,
          cycle: { ...cycleView.cycle, lifecycle: 'launch_pending' },
          turns: [
            ...cycleView.turns,
            {
              ...cycleView.turns[0],
              id: randomUUID(),
              ordinal: 3,
              message: 'Revise the proposal.',
              launchState: 'launch_pending',
              executionId: null,
            },
          ],
          proposals: [{ ...proposal, lifecycle: 'superseded', decidedAt: now }],
        },
      },
      {
        ok: true,
        commandType: 'planning_proposal.approve',
        planningCycle: {
          ...cycleView,
          cycle: {
            ...cycleView.cycle,
            lifecycle: 'approved',
            endedAt: now,
          },
          proposals: [{ ...proposal, lifecycle: 'approved', decidedAt: now }],
        },
        intentLedger: approvedIntentLedger,
      },
      {
        ok: true,
        commandType: 'planning_proposal.reject',
        planningCycle: {
          ...cycleView,
          cycle: {
            ...cycleView.cycle,
            lifecycle: 'proposal_rejected',
            endedAt: now,
          },
          proposals: [
            {
              ...proposal,
              lifecycle: 'rejected',
              rejectionFeedback: 'Keep the scope smaller.',
              decidedAt: now,
            },
          ],
        },
      },
      {
        ok: true,
        commandType: 'planning_cycle.abandon',
        planningCycle: {
          ...cycleView,
          cycle: {
            ...cycleView.cycle,
            lifecycle: 'abandoned',
            endedAt: now,
          },
          proposals: [{ ...proposal, lifecycle: 'superseded', decidedAt: now }],
        },
      },
    ];
    for (const result of successResults) {
      expect(v2CommandResultSchema.parse(result).commandType).toBe(
        result.commandType,
      );
      const versioned = {
        ...result,
        schemaVersion: 2,
        planningCycle: asIntentCycleView(result.planningCycle),
        ...(result.commandType === 'planning_proposal.approve'
          ? { board: boardWithoutPlan('planning_required') }
          : {}),
      };
      expect(v2CommandResultSchema.parse(versioned).commandType).toBe(
        result.commandType,
      );
    }
    for (const code of [
      'planning_cycle_not_found',
      'planning_cycle_active_conflict',
      'planning_cycle_revision_conflict',
      'planning_cycle_history_limit',
      'planning_proposal_not_found',
      'planning_proposal_revision_conflict',
      'planning_canonical_base_conflict',
      'planning_profile_incompatible',
      'planning_proposal_invalid',
      'planning_intent_required',
      'planning_requirements_required',
      'plan_proposal_not_found',
      'plan_proposal_revision_conflict',
      'plan_canonical_base_conflict',
      'plan_proposal_invalid',
      'board_filter_not_found',
      'board_filter_revision_conflict',
      'board_filter_invalid',
    ]) {
      expect(v2ErrorCodeSchema.parse(code)).toBe(code);
      expect(
        v2CommandResultSchema.parse({
          ok: false,
          commandType: 'planning_cycle.submit_turn',
          error: { code, message: 'Planning command rejected.' },
        }).ok,
      ).toBe(false);
    }

    const changed = {
      projectId,
      occurredAt: now,
      type: 'planning_cycle.changed' as const,
      payload: { planningCycle: cycleView },
    };
    const approved = {
      projectId,
      occurredAt: now,
      type: 'intent_ledger.approved' as const,
      payload: {
        planningCycle: successResults[1].planningCycle,
        intentLedger: approvedIntentLedger,
      },
    };
    expect(domainEventDraftSchema.parse(changed)).toEqual(changed);
    expect(domainEventDraftSchema.parse(approved)).toEqual(approved);
    const secondProposal = {
      ...proposal,
      id: randomUUID(),
      revision: 2,
    };
    const supersededView = {
      ...cycleView,
      cycle: { ...cycleView.cycle, latestProposalRevision: 2 },
      proposals: [
        { ...proposal, lifecycle: 'superseded' as const, decidedAt: now },
        secondProposal,
      ],
    };
    expect(
      domainEventDraftSchema.parse({
        ...changed,
        payload: { planningCycle: supersededView },
      }).payload.planningCycle.proposals[0].lifecycle,
    ).toBe('superseded');
    const rejectedView = {
      ...supersededView,
      cycle: {
        ...supersededView.cycle,
        lifecycle: 'proposal_rejected' as const,
        endedAt: now,
      },
      proposals: [
        supersededView.proposals[0],
        {
          ...secondProposal,
          lifecycle: 'rejected' as const,
          rejectionFeedback: 'Keep the scope smaller.',
          decidedAt: now,
        },
      ],
    };
    expect(
      domainEventDraftSchema.parse({
        ...changed,
        payload: { planningCycle: rejectedView },
      }).payload.planningCycle.cycle.lifecycle,
    ).toBe('proposal_rejected');
    expect(
      runtimeEventDraftSchema.parse({
        projectId,
        executionId,
        adapterCursor: 1,
        occurredAt: now,
        type: 'worker_execution.structured_output',
        payload: { schema: PM_DISCOVERY_REPORT_SCHEMA, value: {} },
      }).type,
    ).toBe('worker_execution.structured_output');

    const snapshot = {
      protocolVersion: V2_PROTOCOL_VERSION,
      project,
      profiles: [resolvedProfile, pmProfile],
      executions: [execution],
      attentionItems: [],
      planningCycles: [asIntentCycleView(approvedCycleView)],
      planningHistoryTruncated: false,
      intentLedger: approvedIntentLedger,
      deliveryPlan: null,
      board: boardWithoutPlan('planning_required'),
      cursors: { domain: 1, runtime: 1 },
    };
    expect(v2ProjectSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() =>
      v2ProjectSnapshotSchema.parse({
        ...snapshot,
        planningCycles: [
          asIntentCycleView({
            ...approvedCycleView,
            cycle: { ...approvedCycleView.cycle, projectId: otherProjectId },
          }),
        ],
      }),
    ).toThrow(/project/i);
  });
});
