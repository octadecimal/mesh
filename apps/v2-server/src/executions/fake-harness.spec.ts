import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  HarnessResumeRequest,
  HarnessStartRequest,
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

describe('FakeHarnessAdapter', () => {
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
