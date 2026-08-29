import {
  V2_PROTOCOL_VERSION,
  type DomainEvent,
  type RetainedRuntimeWindow,
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

const independentProjectProfileApproved = {
  id: '00000000-0000-4000-8000-000000000008',
  projectId,
  sequence: 3,
  occurredAt: '2026-08-28T00:00:07.000Z',
  type: 'worker_profile.revision_approved',
  payload: {
    profileRevision: {
      profileId: '00000000-0000-4000-8000-000000000009',
      scope: 'project',
      projectId,
      name: 'project-foundation',
      displayName: 'Project Foundation',
      revision: 1,
      sourceYaml: 'apiVersion: mesh.dev/v1alpha1',
      document: {
        apiVersion: 'mesh.dev/v1alpha1',
        kind: 'WorkerProfile',
        metadata: {
          name: 'project-foundation',
          displayName: 'Project Foundation',
          scope: 'project',
        },
        spec: {
          assignmentKinds: ['foundation-check'],
          preferredRuntime: { harness: 'fake', model: 'fake-v1' },
          alternatives: [],
          requiredCapabilities: [],
          skills: { preferred: [], required: [] },
          instructions: 'Project instructions.',
          outputSchema: 'mesh.foundation/v1',
        },
      },
      baseProfileId: null,
      baseRevision: null,
      approvedBy: { kind: 'human' },
      approvedAt: '2026-08-28T00:00:07.000Z',
      digest: 'b'.repeat(64),
    },
  },
} satisfies DomainEvent;

describe('reduceProjectProjection', () => {
  it('atomically replaces old activity with the complete retained window', () => {
    const withOldActivity = reduceProjectProjection(ready(), {
      type: 'runtime.event',
      event: completion,
    });
    const retainedCompletion = {
      ...completion,
      id: '00000000-0000-4000-8000-000000000012',
      sequence: 7,
      adapterCursor: 7,
    } satisfies RuntimeEvent;

    const result = reduceProjectProjection(withOldActivity, {
      type: 'snapshot.runtime_replay_received',
      snapshot: {
        ...snapshot,
        executions: [completedLifecycle.payload.execution],
        cursors: { domain: 3, runtime: 7 },
      },
      runtimeWindow: {
        lowWater: 7,
        highWater: 7,
        events: [retainedCompletion],
      },
    });

    expect(result.activity).toEqual([retainedCompletion]);
    expect(result.domainCursor).toBe(3);
    expect(result.runtimeCursor).toBe(7);
    expect(result.executions[0]?.lifecycle).toBe('completed');
    expect(result.resyncRequested).toBe(false);
  });

  it('clears obsolete activity when the complete retained window is empty', () => {
    const withActivity = reduceProjectProjection(ready(), {
      type: 'runtime.event',
      event: completion,
    });

    const result = reduceProjectProjection(withActivity, {
      type: 'snapshot.runtime_replay_received',
      snapshot: { ...snapshot, cursors: { domain: 4, runtime: 6 } },
      runtimeWindow: { lowWater: 7, highWater: 6, events: [] },
    });

    expect(result.activity).toEqual([]);
    expect(result.domainCursor).toBe(4);
    expect(result.runtimeCursor).toBe(6);
  });

  it.each([
    {
      name: 'project mismatch',
      window: {
        lowWater: 6,
        highWater: 6,
        events: [{ ...completion, projectId: otherProjectId }],
      },
      reason: 'project_mismatch',
    },
    {
      name: 'noncontiguous window',
      window: { lowWater: 5, highWater: 6, events: [completion] },
      reason: 'runtime_window_non_contiguous',
    },
    {
      name: 'snapshot cursor before retained history',
      window: {
        lowWater: 7,
        highWater: 7,
        events: [{ ...completion, sequence: 7 }],
      },
      reason: 'runtime_window_cursor_incoherent',
    },
    {
      name: 'snapshot cursor after replay high-water',
      window: {
        lowWater: 3,
        highWater: 4,
        events: [
          { ...completion, sequence: 3 },
          { ...completion, sequence: 4 },
        ],
      },
      reason: 'runtime_window_cursor_incoherent',
    },
  ] satisfies ReadonlyArray<{
    name: string;
    window: RetainedRuntimeWindow;
    reason: string;
  }>)('fails closed for $name', ({ window, reason }) => {
    const state = ready();
    const result = reduceProjectProjection(state, {
      type: 'snapshot.runtime_replay_received',
      snapshot,
      runtimeWindow: window,
    });

    expect(result.project).toBe(state.project);
    expect(result.activity).toBe(state.activity);
    expect(result.domainCursor).toBe(2);
    expect(result.runtimeCursor).toBe(5);
    expect(result.connection).toEqual({ status: 'stale', reason });
    expect(result.resyncRequested).toBe(true);
  });

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

  it('marks direct domain gaps and stale events without advancing', () => {
    const gap = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event: { ...completedLifecycle, sequence: 5 },
    });
    expect(gap.domainCursor).toBe(2);
    expect(gap.connection).toEqual({ status: 'stale', reason: 'domain_gap' });

    const old = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event: { ...completedLifecycle, sequence: 1 },
    });
    expect(old.domainCursor).toBe(2);
    expect(old.connection).toEqual({
      status: 'stale',
      reason: 'domain_stale',
    });
  });

  it('projects an independent approved project profile from its event', () => {
    const result = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event: independentProjectProfileApproved,
    });

    expect(result.domainCursor).toBe(3);
    expect(result.profiles).toEqual([
      {
        profileId:
          independentProjectProfileApproved.payload.profileRevision.profileId,
        projectId,
        profileRevision: 1,
        baseProfileId: null,
        baseRevision: null,
        document: {
          apiVersion: 'mesh.dev/v1alpha1',
          kind: 'WorkerProfile',
          metadata: {
            name: 'project-foundation',
            displayName: 'Project Foundation',
            scope: 'project',
          },
          spec: independentProjectProfileApproved.payload.profileRevision
            .document.spec,
        },
        digest: 'b'.repeat(64),
      },
    ]);
  });

  it('requests resync without advancing for an unresolved extending profile', () => {
    const extending = {
      ...independentProjectProfileApproved,
      payload: {
        profileRevision: {
          ...independentProjectProfileApproved.payload.profileRevision,
          document: {
            ...independentProjectProfileApproved.payload.profileRevision
              .document,
            extends: { profile: 'global/foundation' as const, revision: 1 },
            spec: { instructions: 'Project override.' },
          },
          baseProfileId: profileId,
          baseRevision: 1,
        },
      },
    } satisfies DomainEvent;

    const result = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event: extending,
    });

    expect(result.domainCursor).toBe(2);
    expect(result.profiles).toEqual([]);
    expect(result.resyncRequested).toBe(true);
    expect(result.connection).toEqual({
      status: 'stale',
      reason: 'profile_projection_incomplete',
    });
  });

  it('keeps attention items derived from lifecycle execution failures', () => {
    const failed = {
      ...completedLifecycle,
      payload: {
        execution: {
          ...execution,
          lifecycle: 'attention_required' as const,
          revision: 3,
          failure: {
            code: 'required_skill_unavailable' as const,
            message: 'Required skill is unavailable.',
            missing: ['mesh/reviewer'],
          },
        },
      },
    } satisfies DomainEvent;
    const afterFailure = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event: failed,
    });
    expect(afterFailure.attentionItems).toEqual([
      {
        executionId,
        code: 'required_skill_unavailable',
        message: 'Required skill is unavailable.',
      },
    ]);

    const updated = reduceProjectProjection(afterFailure, {
      type: 'domain.event',
      event: {
        ...failed,
        id: '00000000-0000-4000-8000-000000000010',
        sequence: 4,
        payload: {
          execution: {
            ...failed.payload.execution,
            revision: 4,
            failure: {
              code: 'required_capability_unavailable',
              message: 'Required capability is unavailable.',
              missing: ['resume'],
            },
          },
        },
      },
    });
    expect(updated.attentionItems).toEqual([
      {
        executionId,
        code: 'required_capability_unavailable',
        message: 'Required capability is unavailable.',
      },
    ]);

    const cleared = reduceProjectProjection(updated, {
      type: 'domain.event',
      event: {
        ...completedLifecycle,
        id: '00000000-0000-4000-8000-000000000011',
        sequence: 5,
      },
    });
    expect(cleared.attentionItems).toEqual([]);
  });

  it('fails closed when an attention lifecycle lacks attention details', () => {
    const incomplete = {
      ...completedLifecycle,
      payload: {
        execution: {
          ...execution,
          lifecycle: 'attention_required' as const,
          revision: 3,
          failure: null,
        },
      },
    } satisfies DomainEvent;

    const result = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event: incomplete,
    });

    expect(result.domainCursor).toBe(2);
    expect(result.executions[0]?.lifecycle).toBe('running');
    expect(result.connection).toEqual({
      status: 'stale',
      reason: 'attention_projection_incomplete',
    });
    expect(result.resyncRequested).toBe(true);
  });

  it('keeps subscription transport state separate from snapshot readiness', () => {
    const initial = createInitialProjectProjection(projectId);
    const subscribedFirst = reduceProjectProjection(initial, {
      type: 'transport.subscribed',
    });
    expect(subscribedFirst.connection).toEqual({ status: 'loading' });
    expect(subscribedFirst.transport).toBe('subscribed');

    const snapshotAfter = reduceProjectProjection(subscribedFirst, {
      type: 'snapshot.received',
      snapshot,
    });
    expect(snapshotAfter.connection).toEqual({ status: 'ready' });
    expect(snapshotAfter.transport).toBe('subscribed');

    const snapshotFirst = ready();
    const subscribedAfter = reduceProjectProjection(snapshotFirst, {
      type: 'transport.subscribed',
    });
    expect(subscribedAfter.connection).toEqual({ status: 'ready' });
    expect(subscribedAfter.transport).toBe('subscribed');
  });

  it('restores ready on resubscribe only when a snapshot exists', () => {
    const beforeSnapshot = reduceProjectProjection(
      reduceProjectProjection(createInitialProjectProjection(projectId), {
        type: 'transport.disconnected',
      }),
      { type: 'transport.subscribed' },
    );
    expect(beforeSnapshot.transport).toBe('subscribed');
    expect(beforeSnapshot.connection).toEqual({ status: 'loading' });

    const afterSnapshot = reduceProjectProjection(
      reduceProjectProjection(ready(), { type: 'transport.disconnected' }),
      { type: 'transport.subscribed' },
    );
    expect(afterSnapshot.transport).toBe('subscribed');
    expect(afterSnapshot.connection).toEqual({ status: 'ready' });
  });

  it('keeps a disconnected snapshot disconnected until subscription succeeds', () => {
    const disconnected = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      { type: 'transport.disconnected' },
    );
    const withSnapshot = reduceProjectProjection(disconnected, {
      type: 'snapshot.received',
      snapshot,
    });
    expect(withSnapshot.transport).toBe('disconnected');
    expect(withSnapshot.connection).toEqual({ status: 'disconnected' });

    const subscribed = reduceProjectProjection(withSnapshot, {
      type: 'transport.subscribed',
    });
    expect(subscribed.transport).toBe('subscribed');
    expect(subscribed.connection).toEqual({ status: 'ready' });
  });

  it('preserves gap resync health across disconnect and resubscribe', () => {
    const afterGap = reduceProjectProjection(ready(), {
      type: 'runtime.event',
      event: { ...completion, sequence: 7 },
    });
    expect(afterGap.transport).toBe('connecting');
    expect(afterGap.connection).toEqual({
      status: 'stale',
      reason: 'runtime_gap',
    });
    expect(afterGap.runtimeCursor).toBe(5);
    expect(afterGap.resyncRequested).toBe(true);

    const afterDisconnect = reduceProjectProjection(afterGap, {
      type: 'transport.disconnected',
    });
    expect(afterDisconnect.transport).toBe('disconnected');
    expect(afterDisconnect.connection).toEqual({ status: 'disconnected' });
    expect(afterDisconnect.runtimeCursor).toBe(5);
    expect(afterDisconnect.resyncRequested).toBe(true);

    const afterSubscribe = reduceProjectProjection(afterDisconnect, {
      type: 'transport.subscribed',
    });
    expect(afterSubscribe.transport).toBe('subscribed');
    expect(afterSubscribe.connection).toEqual({
      status: 'stale',
      reason: 'runtime_gap',
    });
    expect(afterSubscribe.runtimeCursor).toBe(5);
    expect(afterSubscribe.resyncRequested).toBe(true);

    const replacement = reduceProjectProjection(afterSubscribe, {
      type: 'snapshot.received',
      snapshot: {
        ...snapshot,
        cursors: { domain: 3, runtime: 7 },
      },
    });
    expect(replacement.transport).toBe('subscribed');
    expect(replacement.connection).toEqual({ status: 'ready' });
    expect(replacement.domainCursor).toBe(3);
    expect(replacement.runtimeCursor).toBe(7);
    expect(replacement.resyncRequested).toBe(false);
  });
});

describe('createV2Store', () => {
  it('preserves route, draft, and tab state across replacement snapshots', () => {
    const store = createV2Store(projectId);
    store.dispatch({
      type: 'local.route_changed',
      route: `/projects/${projectId}`,
    });
    store.dispatch({
      type: 'local.repository_draft_changed',
      draft: 'C:\\repo',
    });
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
