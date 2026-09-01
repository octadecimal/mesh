import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  HarnessResumeRequest,
  HarnessStartRequest,
} from '@mesh/v2-contracts';
import {
  DEVELOPER_REPORT_SCHEMA,
  approvedIntentLedgerSchema,
  developerReportSchema,
  harnessStartRequestSchema,
  PM_DISCOVERY_REPORT_SCHEMA,
  PM_PLAN_REPORT_SCHEMA,
  pmDiscoveryReportSchema,
  pmPlanReportSchema,
} from '@mesh/v2-contracts';

import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { FakeHarnessAdapter } from './fake-harness.js';
import { satisfiesSkillVersion } from './harness-adapter.js';

const withRequest = <T>(
  run: (request: HarnessStartRequest) => Promise<T>,
): Promise<T> => {
  const fixture = createV2TestDatabase();
  const request: HarnessStartRequest = {
    executionId: randomUUID(),
    project: fixture.project,
    assignment: {
      kind: 'foundation-check',
      projectId: fixture.project.id,
      title: 'Inspect Todo',
      instructions: 'Inspect the deterministic Todo fixture.',
      fakeScenario: 'todo-foundation-v1',
    },
    profile: {
      profileId: fixture.profileRevision.profileId,
      projectId: fixture.profileRevision.projectId,
      profileRevision: fixture.profileRevision.revision,
      baseProfileId: fixture.profileRevision.baseProfileId,
      baseRevision: fixture.profileRevision.baseRevision,
      document: fixture.profileRevision.document,
      digest: fixture.profileRevision.digest,
    },
    resolvedSkills: [],
  };
  return run(request).finally(fixture.close);
};

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const developerRequest = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  workspacePath: string,
): HarnessStartRequest => {
  const attemptId = randomUUID();
  const taskId = randomUUID();
  const executionId = randomUUID();
  const requirementId = randomUUID();
  return harnessStartRequestSchema.parse({
    executionId,
    project: fixture.project,
    assignment: {
      kind: 'developer_task',
      projectId: fixture.project.id,
      attemptId,
      taskId,
      taskContractRevision: 1,
      taskCurrentRevision: 1,
      deliveryPlanId: randomUUID(),
      deliveryPlanRevision: 1,
      requirementRevisions: [{ recordId: requirementId, recordRevision: 1 }],
      baseCommit: 'a'.repeat(40),
      workspacePath,
      title: 'Persist Todo items',
      outcome: 'Todo items survive application reload.',
      acceptanceCriteria: ['Todo items survive application reload.'],
      verification: ['Read todo-m4.txt.'],
      expectedArtifacts: ['todo-m4.txt'],
      outputSchema: DEVELOPER_REPORT_SCHEMA,
    },
    profile: {
      profileId: fixture.profileRevision.profileId,
      projectId: fixture.profileRevision.projectId,
      profileRevision: fixture.profileRevision.revision,
      baseProfileId: fixture.profileRevision.baseProfileId,
      baseRevision: fixture.profileRevision.baseRevision,
      document: {
        ...fixture.profileRevision.document,
        spec: {
          ...fixture.profileRevision.document.spec,
          assignmentKinds: ['developer_task'],
          outputSchema: DEVELOPER_REPORT_SCHEMA,
        },
      },
      digest: fixture.profileRevision.digest,
    },
    resolvedSkills: [],
  });
};

const pmRequest = (
  fixture: ReturnType<typeof createV2TestDatabase>,
  turn: 1 | 2,
): HarnessStartRequest => {
  const firstHumanTurnId = randomUUID();
  const pmTurnId = randomUUID();
  const humanTurnId = turn === 1 ? firstHumanTurnId : randomUUID();
  return {
    executionId: randomUUID(),
    project: fixture.project,
    assignment: {
      kind: 'pm_discovery',
      projectId: fixture.project.id,
      outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
      planningCycleId: randomUUID(),
      humanTurnId,
      expectedCycleRevision: turn,
      expectedProposalRevision: 1,
      baseProjectIntentRevision: null,
      baseLedgerRevision: null,
      input: {
        conversation:
          turn === 1
            ? [
                {
                  turnId: firstHumanTurnId,
                  actor: 'human',
                  message: 'Build a Todo application.',
                },
              ]
            : [
                {
                  turnId: firstHumanTurnId,
                  actor: 'human',
                  message: 'Build a Todo application.',
                },
                {
                  turnId: pmTurnId,
                  actor: 'pm',
                  message: 'Which persistence and keyboard behavior?',
                },
                {
                  turnId: humanTurnId,
                  actor: 'human',
                  message: 'Persist locally and support keyboard controls.',
                },
              ],
        latestProposal: null,
        approvedIntentLedger: null,
      },
    },
    profile: {
      profileId: fixture.profileRevision.profileId,
      projectId: fixture.profileRevision.projectId,
      profileRevision: fixture.profileRevision.revision,
      baseProfileId: fixture.profileRevision.baseProfileId,
      baseRevision: fixture.profileRevision.baseRevision,
      document: {
        ...fixture.profileRevision.document,
        spec: {
          ...fixture.profileRevision.document.spec,
          assignmentKinds: ['pm_discovery'],
          outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
        },
      },
      digest: fixture.profileRevision.digest,
    },
    resolvedSkills: [],
  };
};

const planRequest = async (
  fixture: ReturnType<typeof createV2TestDatabase>,
  revision: 1 | 2,
): Promise<HarnessStartRequest> => {
  const planningCycleId = randomUUID();
  const firstHumanTurnId = randomUUID();
  const pmTurnId = randomUUID();
  const humanTurnId = revision === 1 ? firstHumanTurnId : randomUUID();
  const intentId = randomUUID();
  const ledgerId = randomUUID();
  const proposalId = randomUUID();
  const requirementIds = {
    todo: randomUUID(),
    keyboard: randomUUID(),
    persistence: randomUUID(),
  };
  const provenance = [
    {
      kind: 'conversation_turn' as const,
      turnId: firstHumanTurnId,
      rationale: 'The operator approved the Todo requirement.',
    },
  ];
  const approvedIntentLedger = approvedIntentLedgerSchema.parse({
    projectIntent: {
      id: intentId,
      projectId: fixture.project.id,
      revision: 1,
      content: {
        goal: 'Track Todo items.',
        targetUsers: ['Individuals'],
        desiredCapabilities: ['Add and complete Todo items'],
        constraints: ['Every control is keyboard operable.'],
        nonGoals: ['Team collaboration'],
        successConditions: ['Todo items persist after reload.'],
        rationale: 'Deliver the accepted Todo scope.',
        provenance,
      },
      proposalId,
      approvedBy: 'human',
      approvedAt: '2026-08-30T00:00:00.000Z',
    },
    ledger: {
      id: ledgerId,
      projectId: fixture.project.id,
      revision: 1,
      proposalId,
      approvedBy: 'human',
      approvedAt: '2026-08-30T00:00:00.000Z',
    },
    records: [
      {
        recordId: requirementIds.todo,
        projectId: fixture.project.id,
        revision: 1,
        content: {
          type: 'requirement',
          kind: 'functional',
          status: 'approved',
          priority: 'must',
          statement: 'Users can add and complete Todo items.',
          rationale: 'This is the core Todo workflow.',
        },
        provenance,
        proposalId,
        approvedBy: 'human',
        approvedAt: '2026-08-30T00:00:00.000Z',
      },
      {
        recordId: requirementIds.keyboard,
        projectId: fixture.project.id,
        revision: 1,
        content: {
          type: 'requirement',
          kind: 'ux',
          status: 'approved',
          priority: 'must',
          statement: 'Every Todo control is keyboard operable.',
          rationale: 'Keyboard operation is required.',
        },
        provenance,
        proposalId,
        approvedBy: 'human',
        approvedAt: '2026-08-30T00:00:00.000Z',
      },
      {
        recordId: requirementIds.persistence,
        projectId: fixture.project.id,
        revision: 1,
        content: {
          type: 'requirement',
          kind: 'operational',
          status: 'approved',
          priority: 'must',
          statement: 'Todo items persist across application reloads.',
          rationale: 'Reloading must preserve the list.',
        },
        provenance,
        proposalId,
        approvedBy: 'human',
        approvedAt: '2026-08-30T00:00:00.000Z',
      },
    ],
    relationships: [],
  });
  const firstAssignment = {
    kind: 'pm_plan' as const,
    projectId: fixture.project.id,
    outputSchema: PM_PLAN_REPORT_SCHEMA,
    planningCycleId,
    humanTurnId: firstHumanTurnId,
    expectedCycleRevision: 1,
    expectedProposalRevision: 1,
    baseProjectIntentId: intentId,
    baseProjectIntentRevision: 1,
    baseLedgerId: ledgerId,
    baseLedgerRevision: 1,
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
    input: {
      conversation: [
        {
          turnId: firstHumanTurnId,
          actor: 'human' as const,
          message: 'Propose a delivery plan for the approved Todo intent.',
        },
      ],
      approvedIntentLedger,
      latestProposal: null,
      approvedDeliveryPlan: null,
    },
  };
  const profile = {
    profileId: fixture.profileRevision.profileId,
    projectId: fixture.profileRevision.projectId,
    profileRevision: fixture.profileRevision.revision,
    baseProfileId: fixture.profileRevision.baseProfileId,
    baseRevision: fixture.profileRevision.baseRevision,
    document: {
      ...fixture.profileRevision.document,
      spec: {
        ...fixture.profileRevision.document.spec,
        assignmentKinds: ['pm_plan'] as const,
        outputSchema: PM_PLAN_REPORT_SCHEMA,
      },
    },
    digest: fixture.profileRevision.digest,
  };
  let assignment = firstAssignment;
  if (revision === 2) {
    const firstSession = await new FakeHarnessAdapter({
      pmScenario: 'todo',
    }).start({
      executionId: randomUUID(),
      project: fixture.project,
      assignment: firstAssignment,
      profile,
      resolvedSkills: [],
    });
    const firstOutput = (await collect(firstSession.events(0)))[0]?.normalized;
    if (firstOutput?.type !== 'worker_execution.structured_output') {
      throw new Error('Expected initial Todo plan output');
    }
    const firstReport = pmPlanReportSchema.parse(firstOutput.payload.value);
    if (firstReport.result.kind !== 'plan_proposal') {
      throw new Error('Expected initial Todo plan proposal');
    }
    assignment = {
      ...firstAssignment,
      humanTurnId,
      expectedCycleRevision: 3,
      expectedProposalRevision: 2,
      input: {
        ...firstAssignment.input,
        conversation: [
          ...firstAssignment.input.conversation,
          {
            turnId: pmTurnId,
            actor: 'pm' as const,
            message: firstReport.assistantMessage,
          },
          {
            turnId: humanTurnId,
            actor: 'human' as const,
            message:
              'Make keyboard acceptance explicit and persistence verification isolated.',
          },
        ],
        latestProposal: {
          id: randomUUID(),
          projectId: fixture.project.id,
          planningCycleId,
          revision: 1,
          lifecycle: 'awaiting_approval' as const,
          base: {
            projectIntentId: intentId,
            projectIntentRevision: 1,
            ledgerId,
            ledgerRevision: 1,
            deliveryPlan: { id: null, revision: null },
          },
          proposedPlan: firstReport.result.proposal,
          reservations: {
            milestones: [
              { key: 'todo-foundations', id: randomUUID() },
              { key: 'todo-integration', id: randomUUID() },
            ],
            tasks: [
              { key: 'todo-ui', id: randomUUID() },
              { key: 'todo-persistence', id: randomUUID() },
              { key: 'todo-integrated', id: randomUUID() },
            ],
            dependencies: [
              { key: 'ui-before-integrated', id: randomUUID() },
              { key: 'persistence-before-integrated', id: randomUUID() },
            ],
          },
          diff: {
            milestones: {
              create: 2,
              reuse: 0,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            tasks: {
              create: 3,
              reuse: 0,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            dependencies: {
              create: 2,
              reuse: 0,
              revise: 0,
              retire: 0,
              reactivate: 0,
            },
            traceCreateCount: 6,
            traceRemoveCount: 0,
          },
          createdByTurnId: pmTurnId,
          createdByExecutionId: randomUUID(),
          createdAt: '2026-08-30T00:00:01.000Z',
          decision: { kind: 'pending' as const },
        },
      },
    };
  }
  return {
    executionId: randomUUID(),
    project: fixture.project,
    assignment,
    profile,
    resolvedSkills: [],
  };
};

const rawHandle = (payload: unknown, encoding: BufferEncoding = 'base64url') =>
  `fake:v1:${Buffer.from(JSON.stringify(payload)).toString(encoding)}`;

describe('FakeHarnessAdapter', () => {
  it('emits deterministic complete Todo plan revisions', async () => {
    const fixture = createV2TestDatabase();
    const fake = new FakeHarnessAdapter({ pmScenario: 'todo' });
    try {
      const firstRequest = await planRequest(fixture, 1);
      const first = await collect((await fake.start(firstRequest)).events(0));
      const firstOutput = first[0]?.normalized;
      if (firstOutput?.type !== 'worker_execution.structured_output') {
        throw new Error('Expected initial Todo plan output');
      }
      const firstReport = pmPlanReportSchema.parse(firstOutput.payload.value);
      expect(firstReport.result.kind).toBe('plan_proposal');
      if (firstReport.result.kind !== 'plan_proposal') {
        throw new Error('Expected initial Todo plan proposal');
      }
      expect({
        milestones: firstReport.result.proposal.milestones.length,
        tasks: firstReport.result.proposal.tasks.length,
        dependencies: firstReport.result.proposal.dependencies.length,
        traces: firstReport.result.proposal.traces.length,
      }).toEqual({ milestones: 2, tasks: 3, dependencies: 2, traces: 6 });
      const repeated = await collect(
        (
          await new FakeHarnessAdapter({ pmScenario: 'todo' }).start(
            firstRequest,
          )
        ).events(0),
      );
      expect(repeated[0]?.normalized).toEqual(firstOutput);

      const revisedRequest = await planRequest(fixture, 2);
      const revised = await collect(
        (await fake.start(revisedRequest)).events(0),
      );
      const revisedOutput = revised[0]?.normalized;
      if (revisedOutput?.type !== 'worker_execution.structured_output') {
        throw new Error('Expected revised Todo plan output');
      }
      const revisedReport = pmPlanReportSchema.parse(
        revisedOutput.payload.value,
      );
      expect(revisedReport).toMatchObject({
        schema: PM_PLAN_REPORT_SCHEMA,
        expectedProposalRevision: 2,
        result: { kind: 'plan_proposal' },
      });
      if (revisedReport.result.kind !== 'plan_proposal') {
        throw new Error('Expected revised Todo plan proposal');
      }
      expect({
        milestones: revisedReport.result.proposal.milestones.length,
        tasks: revisedReport.result.proposal.tasks.length,
        dependencies: revisedReport.result.proposal.dependencies.length,
        traces: revisedReport.result.proposal.traces.length,
      }).toEqual({ milestones: 2, tasks: 3, dependencies: 2, traces: 6 });
      expect(revisedReport.result.proposal.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'todo-ui',
            content: expect.objectContaining({
              acceptanceCriteria: expect.arrayContaining([
                'A keyboard user can add and complete a Todo item without a pointer.',
              ]),
            }),
          }),
          expect.objectContaining({
            key: 'todo-persistence',
            content: expect.objectContaining({
              verificationCriteria: [
                'Run the isolated Todo persistence verification.',
              ],
            }),
          }),
        ]),
      );
    } finally {
      fixture.close();
    }
  });

  it('keeps plan executions finite and refuses native resume', async () => {
    const fixture = createV2TestDatabase();
    try {
      const request = await planRequest(fixture, 1);
      const fake = new FakeHarnessAdapter({
        pmScenario: 'todo',
        holdAfterAdapterCursor: 1,
      });
      const session = await fake.start(request);
      await collect(session.events(0));
      await expect(fake.probe(session.nativeHandle)).resolves.toMatchObject({
        status: 'unknown',
      });
      await expect(
        fake.resume({
          ...request,
          nativeHandle: session.nativeHandle,
          afterAdapterCursor: 1,
        }),
      ).rejects.toThrow('finite');
      expect(fake.resumeCount).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it.each([
    [
      'malformed' as const,
      ['worker_execution.structured_output', 'worker_execution.completed'],
    ],
    ['missing_output' as const, ['worker_execution.completed']],
  ])(
    'emits the finite plan failure variant %s',
    async (pmScenario, expectedTypes) => {
      const fixture = createV2TestDatabase();
      try {
        const session = await new FakeHarnessAdapter({ pmScenario }).start(
          await planRequest(fixture, 1),
        );
        const events = await collect(session.events(0));
        expect(events.map(({ normalized }) => normalized.type)).toEqual(
          expectedTypes,
        );
        if (pmScenario === 'malformed') {
          const output = events[0]?.normalized;
          if (output?.type !== 'worker_execution.structured_output') {
            throw new Error('Expected malformed plan output');
          }
          expect(
            pmPlanReportSchema.safeParse(output.payload.value).success,
          ).toBe(false);
        }
      } finally {
        fixture.close();
      }
    },
  );

  it('emits finite assignment-bound Todo questions and proposal reports', async () => {
    const fixture = createV2TestDatabase();
    const fake = new FakeHarnessAdapter({ pmScenario: 'todo' });
    try {
      const questionRequest = pmRequest(fixture, 1);
      const questionSession = await fake.start(questionRequest);
      const questionEvents = await collect(questionSession.events(0));
      expect(questionEvents.map((event) => event.normalized.type)).toEqual([
        'worker_execution.structured_output',
        'worker_execution.completed',
      ]);
      const questionOutput = questionEvents[0]?.normalized;
      expect(questionOutput).toMatchObject({
        type: 'worker_execution.structured_output',
        payload: { schema: PM_DISCOVERY_REPORT_SCHEMA },
      });
      if (questionOutput?.type !== 'worker_execution.structured_output') {
        throw new Error('Expected structured question output');
      }
      expect(
        pmDiscoveryReportSchema.parse(questionOutput.payload.value),
      ).toMatchObject({
        planningCycleId:
          questionRequest.assignment.kind === 'pm_discovery'
            ? questionRequest.assignment.planningCycleId
            : '',
        humanTurnId:
          questionRequest.assignment.kind === 'pm_discovery'
            ? questionRequest.assignment.humanTurnId
            : '',
        result: { kind: 'questions' },
      });

      const proposalRequest = pmRequest(fixture, 2);
      const proposalSession = await fake.start(proposalRequest);
      const proposalEvents = await collect(proposalSession.events(0));
      expect(proposalEvents.map((event) => event.normalized.type)).toEqual([
        'worker_execution.structured_output',
        'worker_execution.completed',
      ]);
      const proposalOutput = proposalEvents[0]?.normalized;
      if (proposalOutput?.type !== 'worker_execution.structured_output') {
        throw new Error('Expected structured proposal output');
      }
      const report = pmDiscoveryReportSchema.parse(
        proposalOutput.payload.value,
      );
      expect(report.result).toMatchObject({ kind: 'proposal' });
      if (report.result.kind !== 'proposal') {
        throw new Error('Expected proposal report');
      }
      expect(report.result.records.map(({ content }) => content.type)).toEqual([
        'requirement',
        'requirement',
        'requirement',
        'assumption',
        'decision',
        'question',
        'risk',
      ]);
      expect(report.result.relationships.map(({ kind }) => kind)).toEqual([
        'depends_on',
        'constrains',
      ]);
      const expectedTurnIds = new Set(
        proposalRequest.assignment.kind === 'pm_discovery'
          ? proposalRequest.assignment.input.conversation
              .filter(({ actor }) => actor === 'human')
              .map(({ turnId }) => turnId)
          : [],
      );
      expect(
        new Set(
          report.result.records.flatMap((member) =>
            member.operation === 'reuse'
              ? []
              : member.provenance.map(({ turnId }) => turnId),
          ),
        ),
      ).toEqual(expectedTurnIds);
      expect(proposalSession.nativeHandle).not.toBe(
        questionSession.nativeHandle,
      );
      expect(fake.startCount).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it.each([
    [undefined, ['worker_execution.completed']],
    ['missing_output' as const, ['worker_execution.completed']],
    [
      'duplicate' as const,
      [
        'worker_execution.structured_output',
        'worker_execution.structured_output',
        'worker_execution.completed',
      ],
    ],
  ])('keeps PM scenario %s finite', async (pmScenario, expectedTypes) => {
    const fixture = createV2TestDatabase();
    try {
      const fake = new FakeHarnessAdapter({ pmScenario });
      const session = await fake.start(pmRequest(fixture, 1));
      const events = await collect(session.events(0));
      expect(events.map((event) => event.normalized.type)).toEqual(
        expectedTypes,
      );
    } finally {
      fixture.close();
    }
  });

  it('emits a strict runtime envelope containing malformed PM report data', async () => {
    const fixture = createV2TestDatabase();
    try {
      const session = await new FakeHarnessAdapter({
        pmScenario: 'malformed',
      }).start(pmRequest(fixture, 1));
      const events = await collect(session.events(0));
      expect(events.map((event) => event.normalized.type)).toEqual([
        'worker_execution.structured_output',
        'worker_execution.completed',
      ]);
      const output = events[0]?.normalized;
      if (output?.type !== 'worker_execution.structured_output') {
        throw new Error('Expected malformed structured output');
      }
      expect(
        pmDiscoveryReportSchema.safeParse(output.payload.value).success,
      ).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it.each([
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.3-beta.1', '^1.2.3', false],
    ['1.2.3', '^not-semver', false],
  ])('matches stable semver %s against %s', (actual, constraint, expected) => {
    expect(satisfiesSkillVersion(actual, constraint)).toBe(expected);
  });

  it('advertises deterministic streaming and skill capabilities', async () => {
    const fake = new FakeHarnessAdapter();
    await expect(fake.capabilities()).resolves.toMatchObject({
      adapterId: 'fake',
      capabilities: ['execution.stream', 'execution.interrupt'],
      exactResume: true,
    });
    await expect(
      fake.resolveSkills([
        { id: 'mesh.foundation-check', constraint: { version: '^1.2.3' } },
      ]),
    ).resolves.toEqual([
      {
        logicalId: 'mesh.foundation-check',
        nativeId: 'fake.foundation-check',
        version: '1.9.0',
        digest: 'f'.repeat(64),
      },
    ]);
  });

  it('treats duplicate compatible skill descriptors as unavailable', async () => {
    const fake = new FakeHarnessAdapter();
    fake.capabilitiesValue = {
      ...fake.capabilitiesValue,
      skills: [
        {
          logicalId: 'mesh.foundation-check',
          nativeId: 'fake.foundation-check-a',
          version: '1.3.0',
          digest: 'a'.repeat(64),
        },
        {
          logicalId: 'mesh.foundation-check',
          nativeId: 'fake.foundation-check-b',
          version: '1.9.0',
          digest: 'b'.repeat(64),
        },
      ],
    };

    await expect(
      fake.resolveSkills([
        { id: 'mesh.foundation-check', constraint: { version: '^1.2.3' } },
      ]),
    ).resolves.toEqual([]);
  });

  it.each([
    ['^1.2.3', true],
    ['^2.0.0', false],
    ['^0.2.3', false],
    ['^0.0.3', false],
    ['1.9.0', true],
    ['1.9.0-beta.1', false],
    ['not-semver', false],
  ])(
    'applies exact and caret constraints for the native 1.9.0 skill (%s)',
    async (version, available) => {
      const resolved = await new FakeHarnessAdapter().resolveSkills([
        { id: 'mesh.foundation-check', constraint: { version } },
      ]);
      expect(resolved.length > 0).toBe(available);
    },
  );

  it('emits the fixed script with strict normalized completion', async () => {
    await withRequest(async (request) => {
      const session = await new FakeHarnessAdapter().start(request);
      const events = await collect(session.events(0));
      expect(events.map((event) => event.adapterCursor)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(events.map((event) => event.normalized.type)).toEqual([
        'worker_execution.output',
        'worker_execution.child_started',
        'worker_execution.output',
        'worker_execution.child_finished',
        'worker_execution.output',
        'worker_execution.completed',
      ]);
      expect(events.at(-1)?.normalized).toMatchObject({
        type: 'worker_execution.completed',
        payload: { outcome: 'completed' },
      });
    });
  });

  it('resumes from a parsed handle in a fresh adapter at the exact checkpoint', async () => {
    await withRequest(async (request) => {
      const first = new FakeHarnessAdapter({ holdAfterAdapterCursor: 2 });
      const session = await first.start(request);
      expect(
        (await collect(session.events(0))).map((event) => event.adapterCursor),
      ).toEqual([1, 2]);

      const restarted = new FakeHarnessAdapter();
      await expect(restarted.probe(session.nativeHandle)).resolves.toEqual({
        status: 'resumable',
        afterAdapterCursor: 2,
      });
      const resumeRequest: HarnessResumeRequest = {
        ...request,
        nativeHandle: session.nativeHandle,
        afterAdapterCursor: 2,
      };
      const resumed = await restarted.resume(resumeRequest);
      expect((await collect(resumed.events(2)))[0]?.adapterCursor).toBe(3);
      await expect(
        restarted.resume({ ...resumeRequest, afterAdapterCursor: 1 }),
      ).rejects.toThrow('checkpoint');
    });
  });

  it.each([
    ['todo', 3],
    ['malformed', 3],
    ['duplicate', 4],
    ['missing_output', 2],
  ] as const)(
    'rejects a %s PM handle beyond its scenario terminal cursor',
    async (pmScenario, checkpointCursor) => {
      const fixture = createV2TestDatabase();
      try {
        const request = pmRequest(fixture, 1);
        const nativeHandle = rawHandle({
          checkpointCursor,
          executionId: request.executionId,
          pmScenario,
          scenario: 'pm-discovery-v1',
        });
        const fake = new FakeHarnessAdapter({ pmScenario });

        await expect(fake.probe(nativeHandle)).resolves.toMatchObject({
          status: 'missing',
        });
        await expect(
          fake.resume({
            ...request,
            nativeHandle,
            afterAdapterCursor: checkpointCursor,
          }),
        ).rejects.toThrow('invalid');
        expect(fake.resumeCount).toBe(0);
      } finally {
        fixture.close();
      }
    },
  );

  it('rejects malformed, oversized, mismatched, and unknown-version handles', async () => {
    const fake = new FakeHarnessAdapter();
    await expect(fake.probe('not-a-handle')).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(
      fake.probe(`fake:v1:${'a'.repeat(5000)}`),
    ).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(fake.probe('fake:v99:e30')).resolves.toMatchObject({
      status: 'unknown',
    });

    await withRequest(async (request) => {
      const held = await new FakeHarnessAdapter({
        holdAfterAdapterCursor: 1,
      }).start(request);
      await collect(held.events(0));
      const resumeRequest: HarnessResumeRequest = {
        ...request,
        executionId: randomUUID(),
        nativeHandle: held.nativeHandle,
        afterAdapterCursor: 1,
      };
      await expect(fake.resume(resumeRequest)).rejects.toThrow('execution');
    });
  });

  it.each([
    [
      'extra field',
      rawHandle({
        checkpointCursor: 2,
        executionId: randomUUID(),
        extra: true,
        scenario: 'todo-foundation-v1',
      }),
    ],
    [
      'invalid execution ID',
      rawHandle({
        checkpointCursor: 2,
        executionId: 'not-an-execution-id',
        scenario: 'todo-foundation-v1',
      }),
    ],
    [
      'missing checkpoint',
      rawHandle({
        executionId: randomUUID(),
        scenario: 'todo-foundation-v1',
      }),
    ],
    [
      'noncanonical field order',
      rawHandle({
        executionId: randomUUID(),
        scenario: 'todo-foundation-v1',
        checkpointCursor: 2,
      }),
    ],
    [
      'noncanonical base64 encoding',
      rawHandle(
        {
          checkpointCursor: 2,
          executionId: randomUUID(),
          scenario: 'todo-foundation-v1',
        },
        'base64',
      ),
    ],
  ])('rejects %s in a fake handle', async (_case, nativeHandle) => {
    await expect(
      new FakeHarnessAdapter().probe(nativeHandle),
    ).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('stops requesting envelopes after close and keeps interrupt idempotent', async () => {
    await withRequest(async (request) => {
      const fake = new FakeHarnessAdapter();
      const session = await fake.start(request);
      const iterator = session.events(0)[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.adapterCursor).toBe(1);
      await session.close();
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      await expect(fake.interrupt(session.nativeHandle)).resolves.toEqual({
        status: 'succeeded',
      });
      await expect(fake.interrupt(session.nativeHandle)).resolves.toEqual({
        status: 'already_terminal',
      });
    });
  });

  it('writes frozen completed Developer evidence in its test-owned workspace', async () => {
    const fixture = createV2TestDatabase();
    const workspacePath = mkdtempSync(join(tmpdir(), 'mesh-v2-developer-'));
    try {
      const request = developerRequest(fixture, workspacePath);
      const session = await new FakeHarnessAdapter({
        developerScenario: 'completed',
      }).start(request);
      const events = await collect(session.events(0));

      expect(events.map(({ normalized }) => normalized.type)).toEqual([
        'worker_execution.output',
        'worker_execution.child_started',
        'worker_execution.child_finished',
        'worker_execution.structured_output',
        'worker_execution.completed',
      ]);
      expect(readFileSync(join(workspacePath, 'todo-m4.txt'), 'utf8')).toBe(
        'persisted\n',
      );
      const output = events[3]?.normalized;
      expect(output).toMatchObject({
        type: 'worker_execution.structured_output',
        payload: {
          schema: DEVELOPER_REPORT_SCHEMA,
          value: {
            schema: DEVELOPER_REPORT_SCHEMA,
            disposition: 'completed',
            attemptId: request.assignment.attemptId,
            executionId: request.executionId,
            taskId: request.assignment.taskId,
            taskContractRevision: request.assignment.taskContractRevision,
            requirementCoverage: [
              {
                recordId: request.assignment.requirementRevisions[0]?.recordId,
                recordRevision: 1,
                passed: true,
                evidence: [
                  { summary: 'Todo persistence requirement satisfied.' },
                ],
              },
            ],
            criterionCoverage: [
              {
                index: 0,
                text: 'Todo items survive application reload.',
                passed: true,
                evidence: [{ summary: 'Todo persistence acceptance passed.' }],
              },
            ],
            changedArtifacts: [
              { path: 'todo-m4.txt', summary: 'Persisted Todo evidence.' },
            ],
            verification: [
              {
                command: 'Read todo-m4.txt.',
                passed: true,
                evidence: [
                  { summary: 'todo-m4.txt contains persisted Todo evidence.' },
                ],
              },
            ],
            unresolvedConcerns: [],
            workspace: { headCommit: 'a'.repeat(40), dirty: false },
          },
        },
      });
    } finally {
      fixture.close();
      rmSync(workspacePath, { force: true, recursive: true });
    }
  });

  it('refuses Developer work without an explicit test scenario', async () => {
    const fixture = createV2TestDatabase();
    const workspacePath = mkdtempSync(join(tmpdir(), 'mesh-v2-developer-'));
    try {
      await expect(
        new FakeHarnessAdapter().start(
          developerRequest(fixture, workspacePath),
        ),
      ).rejects.toThrow('Fake Developer scenario is test-only');
      expect(existsSync(join(workspacePath, 'todo-m4.txt'))).toBe(false);
    } finally {
      rmSync(workspacePath, { force: true, recursive: true });
      fixture.close();
    }
  });

  it.each([
    ['blocked', true, true],
    ['malformed', true, false],
    ['duplicate', true, false],
    ['missing_output', false, false],
  ] as const)(
    'keeps the %s Developer scenario deterministic and terminal',
    async (developerScenario, emitsOutput, validReport) => {
      const fixture = createV2TestDatabase();
      const workspacePath = mkdtempSync(join(tmpdir(), 'mesh-v2-developer-'));
      try {
        const session = await new FakeHarnessAdapter({
          developerScenario,
        }).start(developerRequest(fixture, workspacePath));
        const events = await collect(session.events(0));
        const output = events.find(
          ({ normalized }) =>
            normalized.type === 'worker_execution.structured_output',
        )?.normalized;
        expect(output === undefined).toBe(!emitsOutput);
        if (output?.type === 'worker_execution.structured_output') {
          expect(
            developerReportSchema.safeParse(output.payload.value).success,
          ).toBe(validReport);
        }
        expect(events.at(-1)?.normalized).toMatchObject({
          type: 'worker_execution.completed',
          payload: { outcome: 'completed' },
        });
        expect(readFileSync(join(workspacePath, 'todo-m4.txt'), 'utf8')).toBe(
          'persisted\n',
        );
      } finally {
        fixture.close();
        rmSync(workspacePath, { force: true, recursive: true });
      }
    },
  );

  it('injects malformed and failed envelopes without cursor duplication', async () => {
    await withRequest(async (request) => {
      const malformed = await new FakeHarnessAdapter({
        malformedAtAdapterCursor: 3,
      }).start(request);
      const malformedEvents = await collect(malformed.events(0));
      expect(malformedEvents.map((event) => event.adapterCursor)).toEqual([
        1, 2, 3,
      ]);
      expect(malformedEvents.at(-1)?.normalized.adapterCursor).toBe(4);

      const failed = await new FakeHarnessAdapter({
        failAtAdapterCursor: 3,
      }).start(request);
      await expect(collect(failed.events(0))).rejects.toThrow(
        'fake adapter failure',
      );
      expect(failed.consumedAdapterCursors).toEqual([1, 2, 3]);
    });
  });
});
