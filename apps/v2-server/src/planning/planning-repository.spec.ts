import { randomUUID } from 'node:crypto';

import {
  approvedIntentLedgerSchema,
  planningCycleViewSchema,
  type LedgerRelationship,
  type PlanningCycle,
  type PlanningProposal,
  type PlanningTurn,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { inImmediateTransaction, openV2Database } from '../db/database.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { PlanningRepository } from './planning-repository.js';

const fixtures: ReturnType<typeof createV2TestDatabase>[] = [];
const at = '2026-08-29T00:00:00.000Z';

const setup = () => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  return { fixture, repository: new PlanningRepository(fixture.database) };
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const cycle = (
  fixture: ReturnType<typeof createV2TestDatabase>,
): PlanningCycle => ({
  id: randomUUID(),
  projectId: fixture.project.id,
  lifecycle: 'launch_pending',
  revision: 1,
  profileId: fixture.profileRevision.profileId,
  profileRevision: fixture.profileRevision.revision,
  baseProjectIntentRevision: null,
  baseLedgerRevision: null,
  latestProposalRevision: 0,
  activeExecutionId: null,
  createdAt: at,
  updatedAt: at,
  endedAt: null,
});

const humanTurn = (value: PlanningCycle): PlanningTurn => ({
  id: randomUUID(),
  projectId: value.projectId,
  planningCycleId: value.id,
  ordinal: 1,
  actor: 'human',
  message: 'Build a Todo application.',
  launchState: 'launch_pending',
  executionId: null,
  createdAt: at,
});

describe('PlanningRepository', () => {
  it('persists immutable cycles and ordered turns across reopen', () => {
    const { fixture, repository } = setup();
    const value = cycle(fixture);
    const turn = humanTurn(value);

    inImmediateTransaction(fixture.database, () => {
      repository.insertCycleInTransaction(value);
      repository.insertTurnInTransaction(turn);
    });

    expect(repository.cycleView(value.id)).toEqual(
      planningCycleViewSchema.parse({
        cycle: value,
        turns: [turn],
        questions: [],
        proposals: [],
      }),
    );
    expect(repository.pendingLaunchTurns()).toEqual([turn]);
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.insertTurnInTransaction({ ...turn, id: randomUUID() }),
      ),
    ).toThrow();

    fixture.database.close();
    const reopened = openV2Database(fixture.path);
    expect(new PlanningRepository(reopened).cycleView(value.id)).toEqual(
      planningCycleViewSchema.parse({
        cycle: value,
        turns: [turn],
        questions: [],
        proposals: [],
      }),
    );
    reopened.close();
  });

  it('enforces one nonterminal cycle per project and conversation-turn provenance ownership', () => {
    const { fixture, repository } = setup();
    const first = cycle(fixture);
    const turn = humanTurn(first);
    inImmediateTransaction(fixture.database, () => {
      repository.insertCycleInTransaction(first);
      repository.insertTurnInTransaction(turn);
    });
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.insertCycleInTransaction({ ...first, id: randomUUID() }),
      ),
    ).toThrow();

    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.insertProjectIntentRevisionInTransaction({
          id: randomUUID(),
          projectId: fixture.project.id,
          revision: 1,
          content: {
            goal: 'Ship Todo.',
            targetUsers: ['People'],
            desiredCapabilities: ['Add items'],
            constraints: [],
            nonGoals: [],
            successConditions: ['Items persist'],
            rationale: 'Requested by the operator.',
            provenance: [
              {
                kind: 'conversation_turn',
                turnId: randomUUID(),
                rationale: 'Wrong turn.',
              },
            ],
          },
          proposalId: randomUUID(),
          approvedBy: 'human',
          approvedAt: at,
        }),
      ),
    ).toThrow();
  });

  it('reserves server record IDs without creating canonical records and normalizes symmetric edges', () => {
    const { fixture, repository } = setup();
    const value = cycle(fixture);
    const human = humanTurn(value);
    const executionId = fixture.execution.id;
    const boundHuman = {
      ...human,
      launchState: 'execution_bound' as const,
      executionId,
    };
    const pmTurn: PlanningTurn = {
      id: randomUUID(),
      projectId: value.projectId,
      planningCycleId: value.id,
      ordinal: 2,
      actor: 'pm',
      message: 'Review this proposal.',
      launchState: null,
      executionId,
      createdAt: at,
    };
    const firstRecord = randomUUID();
    const secondRecord = randomUUID();
    const proposal: PlanningProposal = {
      id: randomUUID(),
      projectId: value.projectId,
      planningCycleId: value.id,
      revision: 1,
      lifecycle: 'awaiting_approval',
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      summary: 'Todo intent',
      projectIntent: {
        goal: 'Ship Todo.',
        targetUsers: ['People'],
        desiredCapabilities: ['Add items'],
        constraints: [],
        nonGoals: [],
        successConditions: ['Items persist'],
        rationale: 'Requested by the operator.',
        provenance: [
          {
            kind: 'conversation_turn',
            turnId: human.id,
            rationale: 'Initial request.',
          },
        ],
      },
      records: [
        {
          operation: 'create',
          key: 'first',
          recordId: firstRecord,
          content: {
            type: 'requirement',
            kind: 'functional',
            status: 'proposed',
            priority: 'must',
            statement: 'Users can add items.',
            rationale: 'Core workflow.',
          },
          provenance: [
            {
              kind: 'conversation_turn',
              turnId: human.id,
              rationale: 'Initial request.',
            },
          ],
        },
        {
          operation: 'create',
          key: 'second',
          recordId: secondRecord,
          content: {
            type: 'requirement',
            kind: 'operational',
            status: 'proposed',
            priority: 'must',
            statement: 'Items persist.',
            rationale: 'Durability.',
          },
          provenance: [
            {
              kind: 'conversation_turn',
              turnId: human.id,
              rationale: 'Initial request.',
            },
          ],
        },
      ],
      relationships: [
        {
          kind: 'duplicates',
          from: { proposalKey: 'second' },
          to: { proposalKey: 'first' },
        },
      ],
      diff: {
        intentChanges: [
          'goal',
          'targetUsers',
          'desiredCapabilities',
          'successConditions',
          'rationale',
          'provenance',
        ],
        recordChanges: { create: 2, revise: 0, reuse: 0 },
        relationshipChanges: {
          added: [
            {
              kind: 'duplicates',
              from: { proposalKey: 'second' },
              to: { proposalKey: 'first' },
            },
          ],
          removed: [],
        },
      },
      createdByTurnId: pmTurn.id,
      createdByExecutionId: executionId,
      rejectionFeedback: null,
      createdAt: at,
      decidedAt: null,
    };

    inImmediateTransaction(fixture.database, () => {
      repository.insertCycleInTransaction({
        ...value,
        lifecycle: 'awaiting_approval',
        revision: 2,
        latestProposalRevision: 1,
      });
      repository.insertTurnInTransaction(boundHuman);
      repository.insertTurnInTransaction(pmTurn);
      repository.insertProposalInTransaction(proposal);
    });

    expect(repository.proposalRecordReservations(proposal.id)).toEqual([
      { key: 'first', recordId: firstRecord },
      { key: 'second', recordId: secondRecord },
    ]);
    expect(
      fixture.database.prepare('SELECT * FROM ledger_records').all(),
    ).toEqual([]);

    const normalized: LedgerRelationship = {
      kind: 'duplicates',
      fromRecordId: [firstRecord, secondRecord].sort()[0],
      toRecordId: [firstRecord, secondRecord].sort()[1],
    };
    inImmediateTransaction(fixture.database, () => {
      repository.applyApprovedProposalInTransaction(proposal, at);
    });
    const approved = repository.approvedIntentLedger(fixture.project.id);
    expect(approvedIntentLedgerSchema.parse(approved)).toEqual(approved);
    expect(approved?.relationships).toEqual([normalized]);
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM ledger_records')
        .get(),
    ).toEqual({ count: 2 });
  });
});
