import type { V2ProjectSnapshot } from '@mesh/v2-contracts';
import { describe, expect, it } from 'vitest';

import {
  projectSnapshotFixture,
  runningExecutionFixture,
} from '../test/project-snapshot-fixture';
import { attentionFromSnapshots, runsFromSnapshots } from './global-projection';

const decision = {
  purpose: { kind: 'intent' },
  cycle: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    lifecycle: 'awaiting_approval',
    revision: 7,
    updatedAt: '2026-08-28T00:00:07.000Z',
  },
  proposals: [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      lifecycle: 'awaiting_approval',
      revision: 1,
      summary: 'Old proposal',
    },
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      lifecycle: 'awaiting_approval',
      revision: 2,
      summary: 'Review this proposal',
    },
  ],
} as V2ProjectSnapshot['planningCycles'][number];

const deliveryPlanDecision = {
  purpose: { kind: 'delivery_plan' },
  cycle: {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    lifecycle: 'awaiting_approval',
    revision: 8,
    updatedAt: '2026-08-28T00:00:08.000Z',
  },
  proposals: [],
  deliveryPlanProposals: [
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      lifecycle: 'awaiting_approval',
      revision: 1,
    },
  ],
} as V2ProjectSnapshot['planningCycles'][number];

const actionableCard = {
  taskId: 'T-21',
  taskCurrentRevision: 8,
  title: 'Ship inbox',
  readiness: { state: 'actionable' },
} as V2ProjectSnapshot['board']['cards'][number];

const inactiveCard = {
  ...actionableCard,
  taskId: 'T-22',
  readiness: { state: 'inactive' },
} as V2ProjectSnapshot['board']['cards'][number];

const snapshot = {
  ...projectSnapshotFixture,
  attentionItems: [
    {
      executionId: runningExecutionFixture.id,
      code: 'internal_error',
      message: 'Execution needs recovery.',
    },
  ],
  planningCycles: [decision],
  board: {
    ...projectSnapshotFixture.board,
    stale: true,
    cards: [actionableCard, inactiveCard],
  },
} as V2ProjectSnapshot;

describe('global projections', () => {
  it('derives ordered attention with canonical destinations', () => {
    expect(attentionFromSnapshots([snapshot])).toMatchObject([
      {
        projectId: snapshot.project.id,
        kind: 'runtime',
        href: `/projects/${snapshot.project.id}/runs?run=${runningExecutionFixture.id}`,
      },
      {
        projectId: snapshot.project.id,
        kind: 'failure',
        href: `/projects/${snapshot.project.id}/runs?run=${runningExecutionFixture.id}`,
      },
      {
        projectId: snapshot.project.id,
        kind: 'decision',
        href: `/projects/${snapshot.project.id}/plans`,
      },
      {
        projectId: snapshot.project.id,
        kind: 'stale',
        href: `/projects/${snapshot.project.id}/board`,
      },
      {
        projectId: snapshot.project.id,
        kind: 'ready',
        href: `/projects/${snapshot.project.id}/board?task=T-21`,
      },
    ]);
  });

  it('breaks same-severity ties by revision, project name, then identity', () => {
    const projects = ['Zulu', 'Alpha', 'Alpha'].map((displayName, index) => ({
      ...projectSnapshotFixture,
      project: {
        ...projectSnapshotFixture.project,
        id: `project-${index}`,
        displayName,
      },
      attentionItems: [],
      executions: [
        {
          ...runningExecutionFixture,
          id: `execution-${2 - index}`,
          projectId: `project-${index}`,
          revision: index === 0 ? 3 : 4,
        },
      ],
    })) as V2ProjectSnapshot[];

    expect(
      attentionFromSnapshots(projects).map(({ projectId }) => projectId),
    ).toEqual(['project-1', 'project-2', 'project-0']);
  });

  it('derives a decision from a delivery-plan proposal', () => {
    expect(
      attentionFromSnapshots([
        {
          ...projectSnapshotFixture,
          attentionItems: [],
          planningCycles: [deliveryPlanDecision],
        } as V2ProjectSnapshot,
      ]),
    ).toContainEqual(expect.objectContaining({ kind: 'decision' }));
  });

  it('uses the latest nonterminal planning cycle for decisions', () => {
    const older = {
      ...decision,
      cycle: {
        ...decision.cycle,
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddddd',
        revision: 6,
      },
    } as V2ProjectSnapshot['planningCycles'][number];
    const latest = {
      ...decision,
      cycle: {
        ...decision.cycle,
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        revision: 8,
      },
      proposals: [
        {
          ...decision.proposals[1],
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          summary: 'Current proposal',
        },
      ],
    } as V2ProjectSnapshot['planningCycles'][number];

    expect(
      attentionFromSnapshots([
        {
          ...projectSnapshotFixture,
          attentionItems: [],
          planningCycles: [older, latest],
        } as V2ProjectSnapshot,
      ]).find(({ kind }) => kind === 'decision'),
    ).toMatchObject({ id: expect.stringContaining('ffffffff') });
  });

  it('deduplicates an attempt controlled by its execution and orders completed history newest first', () => {
    const old = {
      ...runningExecutionFixture,
      id: 'old-run',
      lifecycle: 'completed' as const,
      revision: 2,
      updatedAt: '2026-08-28T00:00:02.000Z',
      endedAt: '2026-08-28T00:00:02.000Z',
    };
    const newest = {
      ...old,
      id: 'new-run',
      updatedAt: '2026-08-28T00:00:04.000Z',
      endedAt: '2026-08-28T00:00:04.000Z',
    };
    const withHistory = {
      ...snapshot,
      executions: [runningExecutionFixture, old, newest],
      developerAttempts: [
        { controllingExecutionId: runningExecutionFixture.id },
      ] as V2ProjectSnapshot['developerAttempts'],
    } as V2ProjectSnapshot;

    expect(
      runsFromSnapshots([withHistory]).filter(({ active }) => active),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: withHistory.project.id,
          executionId: runningExecutionFixture.id,
          active: true,
        }),
      ]),
    );
    expect(
      runsFromSnapshots([withHistory])
        .filter(({ active }) => !active)
        .map(({ executionId }) => executionId),
    ).toEqual(['new-run', 'old-run']);
    expect(
      runsFromSnapshots([withHistory]).filter(
        ({ executionId }) => executionId === runningExecutionFixture.id,
      ),
    ).toHaveLength(1);
  });

  it('excludes inactive Board cards from ready attention', () => {
    expect(
      attentionFromSnapshots([snapshot]).filter(({ kind }) => kind === 'ready'),
    ).toEqual([
      expect.objectContaining({ id: expect.stringContaining('T-21') }),
    ]);
  });
});
