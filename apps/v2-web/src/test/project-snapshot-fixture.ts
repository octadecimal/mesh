import {
  V2_PROTOCOL_VERSION,
  v2ProjectSnapshotSchema,
  workerExecutionSchema,
} from '@mesh/v2-contracts';

const projectId = '11111111-1111-4111-8111-111111111111';
const executionId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';

export const projectFixture = {
  id: projectId,
  displayName: 'Todo',
  repositoryIdentity: 'todo-identity',
  repositoryPath: 'C:\\repos\\todo',
  gitCommonDirectory: 'C:\\repos\\todo\\.git',
  headCommit: 'a'.repeat(40),
  revision: 1,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

export const runningExecutionFixture = workerExecutionSchema.parse({
  id: executionId,
  projectId,
  profileId,
  profileRevision: 1,
  assignment: {
    kind: 'foundation-check',
    projectId,
    title: 'Todo foundation worker',
    instructions: 'Inspect the Todo repository.',
    fakeScenario: 'todo-foundation-v1',
  },
  profileSnapshot: {
    profileId,
    projectId: null,
    profileRevision: 1,
    baseProfileId: null,
    baseRevision: null,
    document: {
      apiVersion: 'mesh.dev/v1alpha1',
      kind: 'WorkerProfile',
      metadata: {
        name: 'todo-worker',
        displayName: 'Todo worker',
        scope: 'global',
      },
      spec: {
        assignmentKinds: ['foundation-check'],
        preferredRuntime: { harness: 'fake', model: 'deterministic' },
        alternatives: [],
        requiredCapabilities: ['execution.stream'],
        skills: {
          preferred: [{ id: 'test-driven-development' }],
          required: [{ id: 'verification-before-completion' }],
        },
        instructions: 'Inspect.',
        outputSchema: 'mesh.dev/foundation-report/v1',
      },
    },
    digest: 'b'.repeat(64),
  },
  skillRequests: {
    preferred: [{ id: 'test-driven-development' }],
    required: [{ id: 'verification-before-completion' }],
  },
  resolvedSkills: [
    {
      requested: { id: 'test-driven-development' },
      mode: 'preferred',
      resolution: {
        kind: 'mesh-native-fallback',
        workflow: 'mesh.foundation-check/v1',
      },
    },
    {
      requested: { id: 'verification-before-completion' },
      mode: 'required',
      resolution: { kind: 'unavailable', reason: 'Not installed' },
    },
  ],
  capabilitySnapshot: {
    adapterId: 'fake',
    capabilities: ['execution.stream'],
    skills: [],
    exactResume: true,
  },
  adapterId: 'fake',
  model: 'deterministic',
  nativeHandle: 'opaque-handle',
  lifecycle: 'running',
  revision: 4,
  lastAdapterCursor: 5,
  lastRuntimeSequence: 5,
  replacementForExecutionId: null,
  failure: null,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:05.000Z',
  endedAt: null,
});

export const projectSnapshotFixture = v2ProjectSnapshotSchema.parse({
  protocolVersion: V2_PROTOCOL_VERSION,
  project: projectFixture,
  profiles: [runningExecutionFixture.profileSnapshot],
  executions: [runningExecutionFixture],
  attentionItems: [
    {
      executionId,
      code: 'required_skill_unavailable',
      message: 'Required verification skill is unavailable.',
    },
  ],
  planningCycles: [],
  planningHistoryTruncated: false,
  intentLedger: null,
  deliveryPlan: null,
  board: {
    projectId,
    deliveryPlanRevision: null,
    stale: false,
    emptyReason: 'intent_required',
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
  },
  cursors: { domain: 3, runtime: 5 },
});
