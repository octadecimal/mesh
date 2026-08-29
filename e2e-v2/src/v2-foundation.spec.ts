import { access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { V2ProcessFixture } from './fixtures/v2-process.js';

const contiguousAfter = (before: number, after: number) =>
  Array.from({ length: after - before }, (_, index) => before + index + 1);

type CleanupProbe = {
  pid: number;
  origin?: string;
  elapsedMs: number;
  namedListenerCount: number;
};

const pathExists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const expectProcessAndListenerGone = async ({
  pid,
  origin,
  elapsedMs,
  namedListenerCount,
}: CleanupProbe) => {
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  if (origin) {
    await expect
      .poll(async () => {
        try {
          await fetch(`${origin}/api/v2/snapshot`);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  }
  expect(elapsedMs).toBeLessThan(8_000);
  expect(namedListenerCount).toBe(0);
};

test('repository setup failure removes only its owned fixture root', async () => {
  const originalPath = process.env.PATH;
  const originalPathAlias = process.env.Path;
  let root: string | undefined;
  try {
    process.env.PATH = '';
    process.env.Path = '';
    await expect(
      V2ProcessFixture.createTodo({
        onRoot: (createdRoot) => {
          root = createdRoot;
        },
      }),
    ).rejects.toThrow();
    if (!root) throw new Error('Repository setup did not create a root');
    expect(await pathExists(root)).toBe(false);
  } finally {
    process.env.PATH = originalPath;
    process.env.Path = originalPathAlias;
    if (root && (await pathExists(root))) {
      const relation = relative(resolve(tmpdir()), root);
      if (
        relation.startsWith('mesh-v2-e2e-') &&
        !relation.includes('/') &&
        !relation.includes('\\') &&
        resolve(tmpdir(), relation) === root
      ) {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

for (const mode of [
  'invalid-origin',
  'timeout',
  'blocked-sigterm',
  'duplicate-ready',
] as const) {
  test(`rejected ${mode} readiness cleans its exact server and listener`, async () => {
    const fixture = await V2ProcessFixture.createTodo();
    try {
      const evidence = await fixture.probeRejectedReadinessCleanup(mode);
      await expectProcessAndListenerGone(evidence);
    } finally {
      await fixture.dispose();
    }
  });
}

test('early startup exit clears exact child ownership within its deadline', async () => {
  const fixture = await V2ProcessFixture.createTodo();
  try {
    const evidence = await fixture.probeEarlyExitCleanup();
    await expectProcessAndListenerGone(evidence);
  } finally {
    await fixture.dispose();
  }
});

test('mismatch probe cleans an unexpectedly ready server and listener', async () => {
  const fixture = await V2ProcessFixture.createTodo();
  try {
    const evidence = await fixture.probeUnexpectedMismatchReadyCleanup(true);
    await expectProcessAndListenerGone(evidence);
  } finally {
    await fixture.dispose();
  }
});

test('Todo foundation survives restart without V1 state', async ({ page }) => {
  const fixture = await V2ProcessFixture.createTodo();
  try {
    const firstOrigin = await fixture.start({ holdAfterAdapterCursor: 2 });
    await page.goto(fixture.origin);
    await page.getByLabel('Repository path').fill(fixture.todoRepository);
    await page.getByRole('button', { name: 'Add and select project' }).click();
    await fixture.waitForBrowserRegistration();
    await expect(
      page.getByRole('heading', { name: 'todo-repository' }),
    ).toBeVisible();

    const held = await fixture.approveProfilesAndStartExecution();
    await expect(
      page.getByText('Todo foundation worker · revision 1'),
    ).toBeVisible();
    const activity = page.getByRole('region', {
      name: 'Runtime activity for Todo foundation check',
    });
    await expect(
      activity.getByText('child.started', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Preferred skill fallback')).toBeVisible();
    await expect(page.getByText('Skill resolved')).toBeVisible();

    const firstServerPid = fixture.serverPid;
    const restartOrigin = await fixture.restartWithFreshFake();
    expect(fixture.serverPid).not.toBe(firstServerPid);
    await page.goto(`${restartOrigin}/projects/${fixture.projectId}`);
    await page.reload();
    const execution = page.getByRole('article', {
      name: 'Todo foundation check',
    });
    await expect(execution.getByRole('status')).toHaveText('completed');
    await expect(
      execution
        .getByRole('region', {
          name: 'Runtime activity for Todo foundation check',
        })
        .getByText('child.started', { exact: true }),
    ).toBeVisible();
    await expect(
      execution
        .getByRole('region', {
          name: 'Child activity for Todo foundation check',
        })
        .getByText('Todo check completed', { exact: true }),
    ).toBeVisible();
    const completed =
      await fixture.expectContinuousStreamsAndStableSnapshots(page);
    expect(completed.project).toEqual(held.project);

    const beforeFailure = await fixture.projectSnapshot();
    await expect(fixture.startRequiredUnavailable()).resolves.toMatchObject({
      ok: false,
      error: { code: 'required_skill_unavailable' },
    });
    const afterFailure = await fixture.projectSnapshot();
    const failed = afterFailure.executions.find(
      (candidate) => candidate.failure?.code === 'required_skill_unavailable',
    );
    expect(failed).toMatchObject({ lifecycle: 'failed', nativeHandle: null });

    const domain = await fixture.domainEventsAfter(
      beforeFailure.cursors.domain,
    );
    const runtime = await fixture.runtimeEventsAfter(
      beforeFailure.cursors.runtime,
    );
    expect(
      domain.events.flatMap((event) =>
        event.type === 'worker_execution.lifecycle_changed' &&
        event.payload.execution.id === failed?.id
          ? [event.payload.execution.lifecycle]
          : [],
      ),
    ).not.toContain('starting');
    expect(
      runtime.events.filter((event) => event.executionId === failed?.id),
    ).toEqual([]);
    expect(afterFailure.cursors.runtime).toBe(beforeFailure.cursors.runtime);
    expect(domain.events.map((event) => event.sequence)).toEqual(
      contiguousAfter(
        beforeFailure.cursors.domain,
        afterFailure.cursors.domain,
      ),
    );

    const mismatch = await fixture.expectDatabaseMismatchIsNonMutating();
    expect(mismatch.hash).toMatch(/^[a-f0-9]{64}$/u);
    // T06 directly proves this public failure stores zero operations and calls start zero times.
    console.log(
      JSON.stringify({
        type: 'mesh.v2.e2e.evidence',
        firstServerPid,
        firstOrigin,
        restartedServerPid: fixture.serverPid,
        restartOrigin,
        mismatchHash: mismatch.hash,
        mismatchPid: mismatch.pid,
        mismatchExitCode: mismatch.exit.code,
      }),
    );
  } finally {
    await fixture.dispose();
  }
});
