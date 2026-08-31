import {
  V2_PROTOCOL_VERSION,
  approvedDeliveryPlanSchema,
  approvedPlanningOutcomeSchema,
  boardViewSchema,
  normalizeIntentLedgerApprovedPayload,
  persistedPlanningCommandSuccessSchema,
  planningCycleViewSchema,
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
const planningCycleId = '00000000-0000-4000-8000-000000000010';
const planningTurnId = '00000000-0000-4000-8000-000000000011';

const planningCycle = planningCycleViewSchema.parse({
  purpose: {
    kind: 'intent',
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  },
  cycle: {
    id: planningCycleId,
    projectId,
    lifecycle: 'execution_active',
    revision: 2,
    profileId,
    profileRevision: 1,
    baseProjectIntentRevision: null,
    baseLedgerRevision: null,
    latestProposalRevision: 0,
    activeExecutionId: executionId,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:01.000Z',
    endedAt: null,
  },
  turns: [
    {
      id: planningTurnId,
      projectId,
      planningCycleId,
      ordinal: 1,
      actor: 'human',
      message: 'Plan Todo.',
      launchState: 'execution_bound',
      executionId,
      createdAt: '2026-08-28T00:00:00.000Z',
    },
  ],
  questions: [],
  proposals: [],
  deliveryPlanProposals: [],
});

const approvedOutcome = approvedPlanningOutcomeSchema.parse({
  planningCycle: {
    cycle: {
      ...planningCycle.cycle,
      lifecycle: 'approved',
      revision: 4,
      latestProposalRevision: 1,
      activeExecutionId: null,
      updatedAt: '2026-08-28T00:00:03.000Z',
      endedAt: '2026-08-28T00:00:03.000Z',
    },
    turns: [
      ...planningCycle.turns,
      {
        id: '00000000-0000-4000-8000-000000000014',
        projectId,
        planningCycleId,
        ordinal: 2,
        actor: 'pm',
        message: 'Approve this Todo intent.',
        launchState: null,
        executionId,
        createdAt: '2026-08-28T00:00:02.000Z',
      },
    ],
    questions: [],
    proposals: [
      {
        id: '00000000-0000-4000-8000-000000000015',
        projectId,
        planningCycleId,
        revision: 1,
        lifecycle: 'approved',
        baseProjectIntentRevision: null,
        baseLedgerRevision: null,
        summary: 'A focused Todo product.',
        projectIntent: {
          goal: 'Track Todo items.',
          targetUsers: ['Individuals'],
          desiredCapabilities: ['Add Todo items'],
          constraints: [],
          nonGoals: [],
          successConditions: ['Todo items can be completed'],
          rationale: 'The operator requested Todo.',
          provenance: [
            {
              kind: 'conversation_turn',
              turnId: planningTurnId,
              rationale: 'Initial request.',
            },
          ],
        },
        records: [],
        relationships: [],
        diff: {
          intentChanges: [],
          recordChanges: { create: 0, revise: 0, reuse: 0 },
          relationshipChanges: { added: [], removed: [] },
        },
        createdByTurnId: '00000000-0000-4000-8000-000000000014',
        createdByExecutionId: executionId,
        rejectionFeedback: null,
        createdAt: '2026-08-28T00:00:02.000Z',
        decidedAt: '2026-08-28T00:00:03.000Z',
      },
    ],
  },
  intentLedger: {
    projectIntent: {
      id: '00000000-0000-4000-8000-000000000016',
      projectId,
      revision: 1,
      proposalId: '00000000-0000-4000-8000-000000000015',
      approvedBy: 'human',
      approvedAt: '2026-08-28T00:00:03.000Z',
      content: {
        goal: 'Track Todo items.',
        targetUsers: ['Individuals'],
        desiredCapabilities: ['Add Todo items'],
        constraints: [],
        nonGoals: [],
        successConditions: ['Todo items can be completed'],
        rationale: 'The operator requested Todo.',
        provenance: [
          {
            kind: 'conversation_turn',
            turnId: planningTurnId,
            rationale: 'Initial request.',
          },
        ],
      },
    },
    ledger: {
      id: '00000000-0000-4000-8000-000000000017',
      projectId,
      revision: 1,
      proposalId: '00000000-0000-4000-8000-000000000015',
      approvedBy: 'human',
      approvedAt: '2026-08-28T00:00:03.000Z',
    },
    records: [],
    relationships: [],
  },
});
const normalizedApprovedOutcome =
  normalizeIntentLedgerApprovedPayload(approvedOutcome);

const filteredBoard = boardViewSchema.parse({
  projectId,
  deliveryPlanRevision: 2,
  stale: false,
  emptyReason: 'filter_empty',
  filter: {
    projectId,
    revision: 3,
    milestoneIds: [],
    taskLifecycles: [],
    readiness: [],
    priorities: [],
    labels: ['web'],
    requirementRecordIds: [],
    updatedAt: '2026-08-28T00:00:04.000Z',
  },
  totalTaskCount: 1,
  matchedTaskCount: 0,
  facets: {
    milestones: [],
    taskLifecycles: [
      {
        value: 'pending',
        label: 'Pending',
        selected: false,
        matchingTaskCount: 0,
      },
      {
        value: 'completed',
        label: 'Completed',
        selected: false,
        matchingTaskCount: 0,
      },
      {
        value: 'retired',
        label: 'Retired',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    readiness: [
      {
        value: 'actionable',
        label: 'Actionable',
        selected: false,
        matchingTaskCount: 0,
      },
      {
        value: 'blocked',
        label: 'Blocked',
        selected: false,
        matchingTaskCount: 0,
      },
      {
        value: 'inactive',
        label: 'Inactive',
        selected: false,
        matchingTaskCount: 0,
      },
    ],
    priorities: [
      { value: 'must', label: 'Must', selected: false, matchingTaskCount: 0 },
      {
        value: 'should',
        label: 'Should',
        selected: false,
        matchingTaskCount: 0,
      },
      { value: 'could', label: 'Could', selected: false, matchingTaskCount: 0 },
    ],
    labels: [
      {
        value: 'web',
        label: 'web',
        selected: true,
        matchingTaskCount: 0,
        historical: false,
      },
    ],
    requirements: [],
  },
  cards: [],
});

const approvedDeliveryPlan = approvedDeliveryPlanSchema.parse({
  plan: {
    id: '00000000-0000-4000-8000-000000000140',
    projectId,
    revision: 2,
    projectIntentId: approvedOutcome.intentLedger.projectIntent.id,
    projectIntentRevision: approvedOutcome.intentLedger.projectIntent.revision,
    ledgerId: approvedOutcome.intentLedger.ledger.id,
    ledgerRevision: approvedOutcome.intentLedger.ledger.revision,
    baseDeliveryPlanRevision: 1,
    proposalId: '00000000-0000-4000-8000-000000000141',
    summary: 'Current filtered Todo plan.',
    approvedBy: 'human',
    approvedAt: '2026-08-28T00:00:04.000Z',
  },
  milestones: [
    {
      id: '00000000-0000-4000-8000-000000000142',
      projectId,
      revision: 1,
      lifecycle: 'active',
      title: 'Todo experience',
      outcome: 'Todo work is visible.',
      stopCondition: 'The Todo Board is visible.',
      exclusions: [],
      ordinal: 1,
      proposalId: '00000000-0000-4000-8000-000000000141',
      deliveryPlanRevision: 2,
      approvedAt: '2026-08-28T00:00:04.000Z',
    },
  ],
  taskContracts: [
    {
      id: '00000000-0000-4000-8000-000000000143',
      projectId,
      revision: 1,
      contractRevision: 1,
      revisionKind: 'plan_contract',
      lifecycle: 'pending',
      milestoneId: '00000000-0000-4000-8000-000000000142',
      title: 'Show Todo Board',
      outcome: 'Todo work is visible.',
      acceptanceCriteria: ['The Board renders.'],
      verificationCriteria: ['Render the Board.'],
      priority: 'must',
      labels: ['web'],
      ownedSurfaces: ['Todo Board'],
      prohibitedSurfaces: [],
      expectedArtifacts: ['Board tests'],
      ordinal: 1,
      source: {
        kind: 'plan',
        proposalId: '00000000-0000-4000-8000-000000000141',
        deliveryPlanRevision: 2,
      },
      createdAt: '2026-08-28T00:00:04.000Z',
    },
  ],
  dependencies: [],
  traces: [
    {
      kind: 'milestone_covers',
      milestoneId: '00000000-0000-4000-8000-000000000142',
      milestoneRevision: 1,
      requirement: {
        recordId: '00000000-0000-4000-8000-000000000144',
        recordRevision: 1,
      },
    },
    {
      kind: 'task_satisfies',
      taskId: '00000000-0000-4000-8000-000000000143',
      taskContractRevision: 1,
      requirement: {
        recordId: '00000000-0000-4000-8000-000000000144',
        recordRevision: 1,
      },
    },
  ],
  milestoneDependencies: [],
});

const terminalPlanningCycles = Array.from({ length: 20 }, (_, index) =>
  planningCycleViewSchema.parse({
    purpose: planningCycle.purpose,
    cycle: {
      ...planningCycle.cycle,
      id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
      lifecycle: 'abandoned',
      revision: 3,
      activeExecutionId: null,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      endedAt: '2026-08-28T00:00:00.000Z',
    },
    turns: [],
    questions: [],
    proposals: [],
    deliveryPlanProposals: [],
  }),
);

const descendingCodeUnits = (left: string, right: string) =>
  left === right ? 0 : left > right ? -1 : 1;

const authoritativeTerminalOrder = (
  cycles: readonly (typeof planningCycle)[],
) =>
  [...cycles].sort(
    (left, right) =>
      descendingCodeUnits(left.cycle.updatedAt, right.cycle.updatedAt) ||
      descendingCodeUnits(left.cycle.id, right.cycle.id),
  );

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
  it('applies complete versioned projections and ignores invalid authority pairs', () => {
    const hydrated = ready();
    const approved = persistedPlanningCommandSuccessSchema.parse({
      ok: true,
      schemaVersion: 2,
      commandType: 'planning_proposal.approve',
      planningCycle: normalizedApprovedOutcome.planningCycle,
      intentLedger: normalizedApprovedOutcome.intentLedger,
      board: normalizedApprovedOutcome.board,
    });
    const next = reduceProjectProjection(hydrated, {
      type: 'planning.command_result',
      result: approved,
    });

    expect(next.planningCycles).toEqual([
      normalizedApprovedOutcome.planningCycle,
    ]);
    expect(next.intentLedger).toEqual(normalizedApprovedOutcome.intentLedger);
    expect(next.board).toEqual(normalizedApprovedOutcome.board);

    const filtered = reduceProjectProjection(next, {
      type: 'planning.command_result',
      result: {
        ok: true,
        schemaVersion: 2,
        commandType: 'board_filter.set',
        board: filteredBoard,
      },
    });
    expect(filtered.board).toEqual(filteredBoard);

    const invalid = reduceProjectProjection(filtered, {
      type: 'planning.command_result',
      result: {
        ...approved,
        board: snapshot.board,
      } as unknown as typeof approved,
    });
    expect(invalid).toBe(filtered);
  });

  it('treats a legacy success as receipt-only when fresh and resyncs when freshness is unknown', () => {
    const legacy = {
      ok: true,
      commandType: 'planning_proposal.approve',
      ...approvedOutcome,
    } as const;
    const installed = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      {
        type: 'snapshot.received',
        snapshot: {
          ...snapshot,
          planningCycles: [normalizedApprovedOutcome.planningCycle],
          planningHistoryTruncated: true,
          intentLedger: normalizedApprovedOutcome.intentLedger,
          deliveryPlan: approvedDeliveryPlan,
          board: filteredBoard,
          cursors: { domain: 9, runtime: 11 },
        },
      },
    );
    const current = reduceProjectProjection(installed, {
      type: 'transport.subscribed',
    });
    const acknowledged = reduceProjectProjection(current, {
      type: 'planning.command_result',
      result: legacy,
    });

    expect(acknowledged).toBe(current);
    expect(acknowledged.planningCycles).toBe(current.planningCycles);
    expect(acknowledged.intentLedger).toBe(current.intentLedger);
    expect(acknowledged.deliveryPlan).toBe(approvedDeliveryPlan);
    expect(acknowledged.board).toBe(filteredBoard);
    expect(acknowledged.domainCursor).toBe(9);
    expect(acknowledged.runtimeCursor).toBe(11);
    expect(acknowledged.planningHistoryTruncated).toBe(true);

    const unknown = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      { type: 'planning.command_result', result: legacy },
    );
    expect(unknown.resyncRequested).toBe(true);
    expect(unknown.resyncReason).toBe('legacy_m2_freshness_unknown');
    expect(unknown.planningCycles).toEqual([]);

    const staleProjection = reduceProjectProjection(current, {
      type: 'resync.required',
      reason: 'manual_stale',
    });
    const gappedProjection = reduceProjectProjection(current, {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000145',
        projectId,
        sequence: 11,
        occurredAt: '2026-08-28T00:01:05.000Z',
        type: 'planning_cycle.changed',
        payload: { schemaVersion: 2, planningCycle },
      } as DomainEvent,
    });
    const mismatchedProjection = { ...current, projectId: otherProjectId };

    for (const projection of [
      staleProjection,
      gappedProjection,
      mismatchedProjection,
    ]) {
      const before = JSON.stringify({
        planningCycles: projection.planningCycles,
        intentLedger: projection.intentLedger,
        deliveryPlan: projection.deliveryPlan,
        board: projection.board,
        domainCursor: projection.domainCursor,
        runtimeCursor: projection.runtimeCursor,
        planningHistoryTruncated: projection.planningHistoryTruncated,
      });
      const resync = reduceProjectProjection(projection, {
        type: 'planning.command_result',
        result: legacy,
      });
      expect(resync.resyncRequested).toBe(true);
      expect(resync.resyncReason).toBe('legacy_m2_freshness_unknown');
      expect(
        JSON.stringify({
          planningCycles: resync.planningCycles,
          intentLedger: resync.intentLedger,
          deliveryPlan: resync.deliveryPlan,
          board: resync.board,
          domainCursor: resync.domainCursor,
          runtimeCursor: resync.runtimeCursor,
          planningHistoryTruncated: resync.planningHistoryTruncated,
        }),
      ).toBe(before);
    }
  });

  it('replays legacy and current planning events in order without merging Board history', () => {
    const legacyCycle = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000130',
        projectId,
        sequence: 3,
        occurredAt: '2026-08-28T00:01:03.000Z',
        type: 'planning_cycle.changed',
        payload: { planningCycle: approvedOutcome.planningCycle },
      } as DomainEvent,
    });
    const duplicate = reduceProjectProjection(legacyCycle, {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000130',
        projectId,
        sequence: 3,
        occurredAt: '2026-08-28T00:01:03.000Z',
        type: 'planning_cycle.changed',
        payload: { planningCycle: approvedOutcome.planningCycle },
      } as DomainEvent,
    });
    const currentBoard = reduceProjectProjection(duplicate, {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000131',
        projectId,
        sequence: 4,
        occurredAt: '2026-08-28T00:01:04.000Z',
        type: 'board.filter_changed',
        payload: { board: filteredBoard },
      } as DomainEvent,
    });

    expect(duplicate).toBe(legacyCycle);
    expect(currentBoard.domainCursor).toBe(4);
    expect(currentBoard.planningCycles).toEqual([
      normalizedApprovedOutcome.planningCycle,
    ]);
    expect(currentBoard.board).toEqual(filteredBoard);
  });

  it('hydrates planning truth, preserves the local draft, and applies a complete cycle event', () => {
    const withDraft = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      { type: 'local.repository_draft_changed', draft: 'human draft' },
    );
    const hydrated = reduceProjectProjection(withDraft, {
      type: 'snapshot.received',
      snapshot: {
        ...snapshot,
        planningCycles: [planningCycle],
        planningHistoryTruncated: true,
      },
    });
    const changed = {
      ...planningCycle,
      cycle: { ...planningCycle.cycle, revision: 3 },
    };
    const next = reduceProjectProjection(hydrated, {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000012',
        projectId,
        sequence: 3,
        occurredAt: '2026-08-28T00:00:02.000Z',
        type: 'planning_cycle.changed',
        payload: { planningCycle: changed },
      } as DomainEvent,
    });

    expect(next.planningCycles).toEqual([changed]);
    expect(next.planningHistoryTruncated).toBe(true);
    expect(next.local.repositoryDraft).toBe('human draft');
    expect(next.domainCursor).toBe(3);
    expect(next.resyncRequested).toBe(false);
  });

  it('converges an active cycle over exactly twenty terminal cycles with the authoritative bound', () => {
    const terminalAuthority = authoritativeTerminalOrder(
      terminalPlanningCycles,
    );
    const hydrated = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      {
        type: 'snapshot.received',
        snapshot: {
          ...snapshot,
          planningCycles: terminalPlanningCycles,
          planningHistoryTruncated: false,
        },
      },
    );
    const incremental = reduceProjectProjection(hydrated, {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000120',
        projectId,
        sequence: 3,
        occurredAt: '2026-08-28T00:01:00.000Z',
        type: 'planning_cycle.changed',
        payload: { planningCycle },
      } as DomainEvent,
    });
    const refreshed = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      {
        type: 'snapshot.received',
        snapshot: {
          ...snapshot,
          planningCycles: [planningCycle, ...terminalAuthority.slice(0, 19)],
          planningHistoryTruncated: true,
          cursors: { ...snapshot.cursors, domain: 3 },
        },
      },
    );

    expect(JSON.stringify(incremental)).toBe(JSON.stringify(refreshed));

    const abandoned = planningCycleViewSchema.parse({
      ...planningCycle,
      cycle: {
        ...planningCycle.cycle,
        lifecycle: 'abandoned',
        revision: 3,
        activeExecutionId: null,
        updatedAt: '2026-08-28T00:01:01.000Z',
        endedAt: '2026-08-28T00:01:01.000Z',
      },
    });
    const replaced = reduceProjectProjection(incremental, {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000121',
        projectId,
        sequence: 4,
        occurredAt: '2026-08-28T00:01:01.000Z',
        type: 'planning_cycle.changed',
        payload: { planningCycle: abandoned },
      } as DomainEvent,
    });

    expect(replaced.planningCycles).toEqual(
      authoritativeTerminalOrder([abandoned, ...terminalPlanningCycles]).slice(
        0,
        20,
      ),
    );
    expect(replaced.planningCycles).toHaveLength(20);
    expect(replaced.planningHistoryTruncated).toBe(true);
  });

  it('applies the same authoritative planning bound to ledger approval events', () => {
    const terminalAuthority = authoritativeTerminalOrder(
      terminalPlanningCycles,
    );
    const hydrated = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      {
        type: 'snapshot.received',
        snapshot: {
          ...snapshot,
          planningCycles: terminalPlanningCycles,
          planningHistoryTruncated: false,
        },
      },
    );
    const incremental = reduceProjectProjection(hydrated, {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000122',
        projectId,
        sequence: 3,
        occurredAt: '2026-08-28T00:01:02.000Z',
        type: 'intent_ledger.approved',
        payload: approvedOutcome,
      } as DomainEvent,
    });
    const refreshed = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      {
        type: 'snapshot.received',
        snapshot: {
          ...snapshot,
          planningCycles: [
            normalizedApprovedOutcome.planningCycle,
            ...terminalAuthority.slice(0, 19),
          ],
          planningHistoryTruncated: true,
          intentLedger: approvedOutcome.intentLedger,
          board: normalizedApprovedOutcome.board,
          cursors: { ...snapshot.cursors, domain: 3 },
        },
      },
    );

    expect(JSON.stringify(incremental)).toBe(JSON.stringify(refreshed));
  });

  it('requests resync for an incomplete planning projection', () => {
    const next = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event: {
        id: '00000000-0000-4000-8000-000000000013',
        projectId,
        sequence: 3,
        occurredAt: '2026-08-28T00:00:02.000Z',
        type: 'planning_cycle.changed',
        payload: { planningCycle: { cycle: planningCycle.cycle } },
      } as unknown as DomainEvent,
    });

    expect(next.resyncRequested).toBe(true);
    expect(next.domainCursor).toBe(2);
  });

  it('converges an approved ledger event with a fresh final snapshot', () => {
    const event = {
      id: '00000000-0000-4000-8000-000000000018',
      projectId,
      sequence: 3,
      occurredAt: '2026-08-28T00:00:03.000Z',
      type: 'intent_ledger.approved',
      payload: approvedOutcome,
    } as DomainEvent;
    const incremental = reduceProjectProjection(ready(), {
      type: 'domain.event',
      event,
    });
    const refreshed = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      {
        type: 'snapshot.received',
        snapshot: {
          ...snapshot,
          planningCycles: [normalizedApprovedOutcome.planningCycle],
          intentLedger: approvedOutcome.intentLedger,
          board: normalizedApprovedOutcome.board,
          cursors: { ...snapshot.cursors, domain: 3 },
        },
      },
    );

    expect(incremental).toEqual(refreshed);
    expect(incremental.intentLedger?.ledger.revision).toBe(1);
  });

  it('converges append, proposal supersede, reject, and abandon events with a fresh snapshot', () => {
    const firstProposal = {
      ...normalizedApprovedOutcome.planningCycle.proposals[0]!,
      lifecycle: 'superseded' as const,
      decidedAt: '2026-08-28T00:00:03.000Z',
    };
    const latestProposal = {
      ...firstProposal,
      id: '00000000-0000-4000-8000-000000000019',
      revision: 2,
      lifecycle: 'awaiting_approval' as const,
      decidedAt: null,
    };
    const superseded = planningCycleViewSchema.parse({
      ...normalizedApprovedOutcome.planningCycle,
      cycle: {
        ...normalizedApprovedOutcome.planningCycle.cycle,
        lifecycle: 'awaiting_approval',
        revision: 5,
        latestProposalRevision: 2,
        endedAt: null,
      },
      proposals: [firstProposal, latestProposal],
    });
    const rejected = planningCycleViewSchema.parse({
      ...superseded,
      cycle: {
        ...superseded.cycle,
        lifecycle: 'proposal_rejected',
        revision: 6,
        endedAt: '2026-08-28T00:00:05.000Z',
      },
      proposals: [
        firstProposal,
        {
          ...latestProposal,
          lifecycle: 'rejected',
          rejectionFeedback: 'Keep the scope smaller.',
          decidedAt: '2026-08-28T00:00:05.000Z',
        },
      ],
    });
    const abandoned = planningCycleViewSchema.parse({
      ...planningCycle,
      cycle: {
        ...planningCycle.cycle,
        lifecycle: 'abandoned',
        revision: 7,
        activeExecutionId: null,
        endedAt: '2026-08-28T00:00:06.000Z',
      },
    });
    const views = [planningCycle, superseded, rejected, abandoned];
    const incremental = views.reduce(
      (state, planningCycleView, index) =>
        reduceProjectProjection(state, {
          type: 'domain.event',
          event: {
            id: `00000000-0000-4000-8000-${String(20 + index).padStart(12, '0')}`,
            projectId,
            sequence: 3 + index,
            occurredAt: `2026-08-28T00:00:0${3 + index}.000Z`,
            type: 'planning_cycle.changed',
            payload: { planningCycle: planningCycleView },
          } as DomainEvent,
        }),
      ready(),
    );
    const refreshed = reduceProjectProjection(
      createInitialProjectProjection(projectId),
      {
        type: 'snapshot.received',
        snapshot: {
          ...snapshot,
          planningCycles: [abandoned],
          cursors: { ...snapshot.cursors, domain: 6 },
        },
      },
    );

    expect(incremental).toEqual(refreshed);
  });
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
