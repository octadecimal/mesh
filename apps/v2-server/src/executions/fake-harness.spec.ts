import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import type {
  HarnessResumeRequest,
  HarnessStartRequest,
} from '@mesh/v2-contracts';
import {
  PM_DISCOVERY_REPORT_SCHEMA,
  pmDiscoveryReportSchema,
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

const rawHandle = (payload: unknown, encoding: BufferEncoding = 'base64url') =>
  `fake:v1:${Buffer.from(JSON.stringify(payload)).toString(encoding)}`;

describe('FakeHarnessAdapter', () => {
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
