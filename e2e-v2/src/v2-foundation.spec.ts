import { expect, test } from '@playwright/test';

import { V2ProcessFixture } from './fixtures/v2-process.js';

const contiguousAfter = (before: number, after: number) =>
  Array.from({ length: after - before }, (_, index) => before + index + 1);

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
