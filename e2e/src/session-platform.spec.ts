import type { Page } from '@playwright/test';
import type { MutatingCommand } from '@mesh-session-platform/contracts';

import {
  expect,
  test,
  type FakeClaudeHarness,
} from '../fixtures/fake-claude.js';

const createThroughUi = async (
  page: Page,
  harness: FakeClaudeHarness,
  title: string,
  workspace: 'shared' | 'worktree' = 'shared',
) => {
  const createdBefore = harness.driver.createdSessions.length;
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Project', { exact: true }).selectOption('project-e2e');
  await page.getByLabel('Session title').fill(title);
  await page.getByLabel('Workspace type').selectOption(workspace);
  if (workspace === 'shared') {
    await page.getByLabel('Shared folder path').fill(harness.sharedPath);
  } else {
    await page.getByLabel('Repository').fill(harness.repositoryPath);
    await page.getByLabel('Branch').fill('mesh-acceptance');
    await page.getByLabel('Start point').fill('HEAD');
    await page.getByLabel('Worktree path').fill(harness.worktreePath);
  }
  await page.getByLabel('Permission mode').selectOption('interactive');
  await page.getByRole('button', { name: 'Create session' }).click();
  await harness.waitForCreated(createdBefore + 1);
};

const createThroughApi = async (harness: FakeClaudeHarness, title: string) => {
  const result = await harness.command({
    type: 'session.create',
    payload: {
      projectId: 'project-e2e',
      title,
      permissionMode: 'interactive',
      workspace: { type: 'shared', path: harness.sharedPath },
    },
  } as unknown as MutatingCommand);
  expect(result.status).toBe(200);
  return (result.body.result as { id: string }).id;
};

const waitForHistory = async (
  harness: FakeClaudeHarness,
  sessionId: string,
  predicate: (events: any[]) => boolean,
) => {
  await expect
    .poll(async () => {
      const response = await fetch(
        `${harness.origin}/api/sessions/${sessionId}/events`,
      );
      const history = (await response.json()) as { events: any[] };
      return predicate(history.events);
    })
    .toBe(true);
};

const expectTwoGroupLayout = async (page: Page) => {
  const groups = page.locator('.dv-groupview');
  await expect(groups).toHaveCount(2);

  const firstSessionGroup = groups.filter({
    has: page.getByRole('tab', { name: 'First session' }),
  });
  const secondSessionGroup = groups.filter({
    has: page.getByRole('tab', { name: 'Second session' }),
  });
  await expect(firstSessionGroup).toBeVisible();
  await expect(secondSessionGroup).toBeVisible();
  await expect(
    secondSessionGroup.getByRole('tab', { name: 'Third session' }),
  ).toBeVisible();
};

test('creates shared and worktree sessions with the production-built server', async ({
  page,
  harness,
}) => {
  await harness.snapshot();
  await page.goto(harness.origin);
  const browserSnapshot = await page.evaluate(async () => {
    const response = await fetch('/api/snapshot');
    return { status: response.status, body: await response.json() };
  });
  expect(browserSnapshot.status, JSON.stringify(browserSnapshot.body)).toBe(
    200,
  );
  await expect(
    page.getByRole('complementary', { name: 'Sessions' }),
  ).toBeVisible();

  await createThroughUi(page, harness, 'Shared acceptance');
  await page.reload();
  await expect(
    page.getByRole('button', { name: /Shared acceptance/ }),
  ).toBeVisible();

  await createThroughUi(page, harness, 'Worktree acceptance', 'worktree');
  const snapshot = await harness.snapshot();
  expect(snapshot.workspaces.map(({ type }) => type)).toEqual(
    expect.arrayContaining(['shared', 'worktree']),
  );
});

test('restores tabs without duplicate events and renders tools plus raw diagnostics', async ({
  page,
  harness,
}) => {
  const firstId = await createThroughApi(harness, 'First session');
  const secondId = await createThroughApi(harness, 'Second session');
  const thirdId = await createThroughApi(harness, 'Third session');
  await harness.waitForCreated(3);

  const session = harness.driver.createdSessions[0];
  const assistant = { kind: 'text_completed' as const, text: 'Persisted once' };
  session.enqueue(assistant);
  session.enqueue(assistant);
  session.enqueue({
    kind: 'tool_requested',
    toolCallId: 'tool-1',
    name: 'Read',
    input: { path: 'README.md' },
  });
  session.enqueue({
    kind: 'tool_completed',
    toolCallId: 'tool-1',
    output: { text: 'fixture' },
    isError: false,
  });
  session.enqueue({
    kind: 'malformed',
    raw: { unexpected: 'diagnostic payload' },
  });
  await waitForHistory(harness, firstId, (events) =>
    events.some(({ type }) => type === 'tool.completed'),
  );

  await page.goto(harness.origin);
  const sessionSidebar = page.getByRole('complementary', { name: 'Sessions' });
  await sessionSidebar.getByRole('button', { name: /First session/ }).click();
  await sessionSidebar.getByRole('button', { name: /Second session/ }).click();
  const firstGroup = page.locator('.dv-groupview');
  const firstGroupBox = await firstGroup.boundingBox();
  if (!firstGroupBox) throw new Error('Dockview group is not visible');
  await page.getByRole('tab', { name: 'Second session' }).dragTo(firstGroup, {
    targetPosition: {
      x: firstGroupBox.width - 8,
      y: firstGroupBox.height / 2,
    },
  });
  await expect(page.locator('.dv-groupview')).toHaveCount(2);

  await sessionSidebar.getByRole('button', { name: /Third session/ }).click();
  await expectTwoGroupLayout(page);

  await expect
    .poll(async () => {
      const snapshot = await harness.snapshot();
      return snapshot.layouts.some((layout) =>
        [firstId, secondId, thirdId].every((id) =>
          layout.visiblePanels.includes(id),
        ),
      );
    })
    .toBe(true);

  await sessionSidebar.getByRole('button', { name: /First session/ }).click();
  await expect(
    page.getByLabel('Assistant message', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByLabel('Tool call Read')).toContainText('fixture');
  await page
    .getByLabel(`Session ${firstId}`)
    .getByRole('button', { name: 'Raw diagnostics' })
    .click();
  await expect(
    page
      .getByLabel(/Diagnostic diagnostic-/)
      .filter({ hasText: 'diagnostic payload' }),
  ).toBeVisible();

  const beforeRefresh = (await fetch(
    `${harness.origin}/api/sessions/${firstId}/events`,
  ).then((response) => response.json())) as { events: any[] };
  await page.reload();
  await expectTwoGroupLayout(page);
  const afterRefresh = (await fetch(
    `${harness.origin}/api/sessions/${firstId}/events`,
  ).then((response) => response.json())) as { events: any[] };
  expect(afterRefresh.events).toHaveLength(beforeRefresh.events.length);
  expect(
    afterRefresh.events.filter(
      ({ type, payload }) =>
        type === 'message.assistant' && payload.text === 'Persisted once',
    ),
  ).toHaveLength(1);

  await sessionSidebar.getByRole('button', { name: /First session/ }).click();
  await page.getByRole('button', { name: /Close First session panel/ }).click();
  expect(session.interrupted).toBe(false);
  expect(secondId).toBeTruthy();
});

test('persists interactive approval across browser reconnect while backend continues', async ({
  browser,
  page,
  harness,
}) => {
  const sessionId = await createThroughApi(harness, 'Approval session');
  await harness.waitForCreated();
  const driverSession = harness.driver.createdSessions[0];
  driverSession.enqueue({
    kind: 'permission_requested',
    permissionId: 'permission-1',
    toolCallId: 'tool-approval',
    name: 'Write',
    input: { path: 'notes.txt' },
  });
  await waitForHistory(harness, sessionId, (events) =>
    events.some(({ type }) => type === 'permission.requested'),
  );

  await page.goto(harness.origin);
  await page.getByRole('button', { name: /Approval session/ }).click();
  await expect(page.getByLabel('Permission Write')).toContainText(
    'Status: pending',
  );
  await page.close();

  driverSession.enqueue({
    kind: 'text_completed',
    text: 'Continued after browser close',
  });
  await waitForHistory(harness, sessionId, (events) =>
    events.some(
      ({ payload }) => payload.text === 'Continued after browser close',
    ),
  );

  const reconnected = await browser.newPage();
  await reconnected.goto(harness.origin);
  await reconnected.getByRole('button', { name: /Approval session/ }).click();
  await expect(reconnected.getByLabel('Permission Write')).toContainText(
    'Status: pending',
  );
  await reconnected.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => driverSession.permissionDecisions.length).toBe(1);
  await reconnected.reload();
  await reconnected.getByRole('button', { name: /Approval session/ }).click();
  await expect(reconnected.getByLabel('Permission Write')).toContainText(
    'Status: approved',
  );
  await reconnected.close();
});

test('discovers and resumes a Claude session and records restart interruption truth', async ({
  page,
  harness,
}) => {
  const originalId = await createThroughApi(harness, 'Discovery seed');
  expect((await harness.discovery()).status).toBe(200);
  await page.goto(harness.origin);
  await page.getByRole('button', { name: 'Resume session' }).click();
  await page.getByLabel(/Discovered Claude session/).check();
  await page
    .getByRole('button', { name: 'Resume session', exact: true })
    .last()
    .click();
  await harness.waitForResumed();
  expect(harness.driver.resumedRequests[0].claudeResumeId).toBe(
    'discovered-resume-id',
  );

  await harness.restart({ recoverSessionId: originalId });
  const snapshot = await harness.snapshot();
  expect(
    snapshot.sessions.find(({ id }) => id === originalId)?.lifecycleState,
  ).toBe('interrupted');
  const history = (await fetch(
    `${harness.origin}/api/sessions/${originalId}/events`,
  ).then((response) => response.json())) as { events: any[] };
  expect(
    history.events.some(
      ({ type, payload }) =>
        type === 'session.status' && payload.reason === 'backend_restart',
    ),
  ).toBe(true);
});

test('refuses API-billing conflicts without invoking Claude', async ({
  harness,
}) => {
  await harness.restart({ billingConflict: true });
  const before = harness.driver.createdRequests.length;
  const response = await harness.command({
    type: 'session.create',
    payload: {
      projectId: 'project-e2e',
      title: 'Must be refused',
      permissionMode: 'interactive',
      workspace: { type: 'shared', path: harness.sharedPath },
    },
  } as unknown as MutatingCommand);
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('billing_configuration_conflict');
  expect(harness.driver.createdRequests).toHaveLength(before);
});
