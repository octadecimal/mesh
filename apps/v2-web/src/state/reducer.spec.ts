import {
  V2_PROTOCOL_VERSION,
  type DomainEvent,
  type RuntimeEvent,
  type V2ProjectSnapshot,
} from '@mesh/v2-contracts';

import {
  createInitialProjectProjection,
  reduceProjectProjection,
} from './reducer';
import { createV2Store } from './store';

const projectId = '00000000-0000-4000-8000-000000000001';
const otherProjectId = '00000000-0000-4000-8000-000000000002';
const profileId = '00000000-0000-4000-8000-000000000003';
const executionId = '00000000-0000-4000-8000-000000000004';

const execution = {
  id: executionId,
  projectId,
  profileId,
  profileRevision: 1,
  assignment: {
    kind: 'foundation-check' as const,
    projectId,
    title: 'Foundation',
    instructions: 'Verify foundation.',
    fakeScenario: 'todo-foundation-v1' as const,
  },
  profileSnapshot: {
    profileId,
    projectId: null,
    profileRevision: 1,
    baseProfileId: null,
    baseRevision: null,
    document: {
      apiVersion: 'mesh.dev/v1alpha1' as const,
      kind: 'WorkerProfile' as const,
      metadata: {
        name: 'foundation',
        displayName: 'Foundation',
        scope: 'global' as const,
      },
      spec: {
        assignmentKinds: ['foundation-check'] as const,
        preferredRuntime: { harness: 'fake', model: 'fake-v1' },
        alternatives: [],
        requiredCapabilities: [],
        skills: { preferred: [], required: [] },
        instructions: 'Verify foundation.',
        outputSchema: 'mesh.foundation/v1',
      },
    },
    digest: 'a'.repeat(64),
  },
  skillRequests: { preferred: [], required: [] },
  resolvedSkills: [],
  capabilitySnapshot: {
    adapterId: 'fake',
    capabilities: [],
    skills: [],
    exactResume: true,
  },
  adapterId: 'fake',
  model: 'fake-v1',
  nativeHandle: 'fake:v1:handle',
  lifecycle: 'running' as const,
  revision: 2,
  lastAdapterCursor: 5,
  lastRuntimeSequence: 5,
  replacementForExecutionId: null,
  failure: null,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:05.000Z',
  endedAt: null,
};

const snapshot = {
  protocolVersion: V2_PROTOCOL_VERSION,
  project: {
    id: projectId,
    displayName: 'Mesh',
    repositoryIdentity: 'repo-1',
    repositoryPath: 'C:\\code\\mesh',
    gitCommonDirectory: 'C:\\code\\mesh\\.git',
    headCommit: 'a'.repeat(40),
    revision: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  },
  profiles: [],
  executions: [execution],
  attentionItems: [],
  cursors: { domain: 2, runtime: 5 },
} satisfies V2ProjectSnapshot;

const completion = {
  id: '00000000-0000-4000-8000-000000000005',
  projectId,
  executionId,
  diagnosticId: '00000000-0000-4000-8000-000000000006',
  sequence: 6,
  adapterCursor: 6,
  occurredAt: '2026-08-28T00:00:06.000Z',
  type: 'worker_execution.completed',
  payload: { outcome: 'completed' },
} satisfies RuntimeEvent;

const completedLifecycle = {
  id: '00000000-0000-4000-8000-000000000007',
  projectId,
  sequence: 3,
  occurredAt: '2026-08-28T00:00:06.000Z',
  type: 'worker_execution.lifecycle_changed',
  payload: {
    execution: {
      ...execution,
      lifecycle: 'completed' as const,
      revision: 3,
      lastAdapterCursor: 6,
      lastRuntimeSequence: 6,
      updatedAt: '2026-08-28T00:00:06.000Z',
      endedAt: '2026-08-28T00:00:06.000Z',
    },
  },
} satisfies DomainEvent;

const ready = () =>
  reduceProjectProjection(createInitialProjectProjection(projectId), {
    type: 'snapshot.received',
    snapshot,
  });

describe('reduceProjectProjection', () => {
  it('requests resync on a runtime gap without changing either cursor', () => {
    const result = reduceProjectProjection(ready(), {
      type: 'runtime.event',
      event: { ...completion, sequence: 7 },
    });

    expect(result.runtimeCursor).toBe(5);
    expect(result.domainCursor).toBe(2);
    expect(result.connection).toEqual({
      status: 'stale',
      reason: 'runtime_gap',
    });
    expect(result.resyncRequested).toBe(true);
  });

  it('does not project more events after a gap until a snapshot arrives', () => {
    const afterGap = reduceProjectProjection(ready(), {
      type: 'runtime.event',
      event: { ...completion, sequence: 7 },
    });

    const lateMissingEvent = reduceProjectProjection(afterGap, {
      type: 'runtime.event',
      event: completion,
    });

    expect(lateMissingEvent).toBe(afterGap);
    expect(lateMissingEvent.runtimeCursor).toBe(5);
    expect(lateMissingEvent.activity).toEqual([]);
  });

  it('projects completion activity but waits for the lifecycle domain event', () => {
    const afterRuntime = reduceProjectProjection(ready(), {
      type: 'runtime.event',
      event: completion,
    });

    expect(afterRuntime.runtimeCursor).toBe(6);
    expect(afterRuntime.domainCursor).toBe(2);
    expect(afterRuntime.executions[0]?.lifecycle).toBe('running');
    expect(afterRuntime.activity.at(-1)?.type).toBe(
      'worker_execution.completed',
    );

    const afterDomain = reduceProjectProjection(afterRuntime, {
      type: 'domain.event',
      event: completedLifecycle,
    });
    expect(afterDomain.domainCursor).toBe(3);
    expect(afterDomain.executions[0]?.lifecycle).toBe('completed');
  });

  it('ignores exact duplicates and marks stale events and projects for resync', () => {
    const state = ready();
    expect(
      reduceProjectProjection(state, {
        type: 'runtime.event',
        event: { ...completion, sequence: 5 },
      }),
    ).toBe(state);

    const stale = reduceProjectProjection(state, {
      type: 'runtime.event',
      event: { ...completion, sequence: 4 },
    });
    expect(stale.runtimeCursor).toBe(5);
    expect(stale.connection).toEqual({
      status: 'stale',
      reason: 'runtime_stale',
    });

    const mismatch = reduceProjectProjection(state, {
      type: 'domain.event',
      event: { ...completedLifecycle, projectId: otherProjectId },
    });
    expect(mismatch.domainCursor).toBe(2);
    expect(mismatch.connection).toEqual({
      status: 'stale',
      reason: 'project_mismatch',
    });
  });
});

describe('createV2Store', () => {
  it('preserves route, draft, and tab state across replacement snapshots', () => {
    const store = createV2Store(projectId);
    store.dispatch({ type: 'local.route_changed', route: `/projects/${projectId}` });
    store.dispatch({ type: 'local.repository_draft_changed', draft: 'C:\\repo' });
    store.dispatch({ type: 'local.tab_changed', tab: 'requirements' });

    store.dispatch({ type: 'snapshot.received', snapshot });
    store.dispatch({
      type: 'snapshot.received',
      snapshot: {
        ...snapshot,
        cursors: { domain: 9, runtime: 12 },
        executions: [{ ...execution, lifecycle: 'completed' }],
      },
    });

    expect(store.getState().local).toEqual({
      route: `/projects/${projectId}`,
      repositoryDraft: 'C:\\repo',
      selectedTab: 'requirements',
    });
    expect(store.getState().domainCursor).toBe(9);
    expect(store.getState().runtimeCursor).toBe(12);
  });

  it('notifies subscribers with the reduced state', () => {
    const store = createV2Store(projectId);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.dispatch({ type: 'snapshot.received', snapshot });
    unsubscribe();
    store.dispatch({ type: 'runtime.event', event: completion });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].runtimeCursor).toBe(5);
  });
});
