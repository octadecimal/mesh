import type { Page } from '@playwright/test';
import type { MutatingCommand } from '@mesh-session-platform/contracts';

import {
  expect,
  test,
  type FakeClaudeHarness,
} from '../fixtures/fake-claude.js';

const visualSnapshotsSupported = process.platform === 'win32';

const createThroughUi = async (
  page: Page,
  harness: FakeClaudeHarness,
  title: string,
  workspace: 'shared' | 'worktree' = 'shared',
) => {
  const projectId = await harness.projectId();
  const createdBefore = harness.driver.createdSessions.length;
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Project', { exact: true }).selectOption(projectId);
  await page.getByLabel('Session title').fill(title);
  await page.getByLabel('Workspace type').selectOption(workspace);
  if (workspace === 'shared') {
    await page.getByLabel('Shared folder path').fill(harness.sharedPath);
  } else {
    await page
      .getByRole('textbox', { name: 'Repository' })
      .fill(harness.repositoryPath);
    await page.getByRole('textbox', { name: 'Branch' }).fill('mesh-acceptance');
    await page.getByRole('textbox', { name: 'Start point' }).fill('HEAD');
    await page
      .getByRole('textbox', { name: 'Worktree path' })
      .fill(harness.worktreePath);
  }
  await page.getByLabel('Permission mode').selectOption('interactive');
  await page.getByRole('button', { name: 'Create session' }).click();
  await harness.waitForCreated(createdBefore + 1);
};

const createThroughApi = async (harness: FakeClaudeHarness, title: string) => {
  const projectId = await harness.discoverProject();
  const result = await harness.command({
    type: 'session.create',
    payload: {
      projectId,
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

test('keeps the empty cockpit usable at a narrow viewport', async ({
  page,
  harness,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await harness.snapshot();
  await page.goto(harness.origin);

  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Start a Claude session' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create your first session' }),
  ).toBeVisible();
  if (visualSnapshotsSupported) {
    await expect(page).toHaveScreenshot('empty-cockpit-narrow.png', {
      animations: 'disabled',
      fullPage: true,
    });
  }
});

test('creates shared and worktree sessions with the production-built server', async ({
  page,
  harness,
}) => {
  const socketFrames: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) =>
      socketFrames.push(`sent:${String(payload)}`),
    );
    socket.on('framereceived', ({ payload }) =>
      socketFrames.push(`received:${String(payload)}`),
    );
  });
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
  await expect(
    page.getByRole('heading', { name: 'Start a Claude session' }),
  ).toBeVisible();
  const newSessionButton = page
    .getByRole('button', { name: 'New session' })
    .first();
  await expect(newSessionButton).toHaveCSS(
    'background-color',
    'rgb(37, 99, 235)',
  );
  await newSessionButton.click();
  const newSessionDialog = page.getByRole('dialog', { name: 'New session' });
  await expect(newSessionDialog).toBeVisible();
  await expect(newSessionDialog).toHaveCSS('position', 'fixed');
  if (visualSnapshotsSupported) {
    await expect(newSessionDialog).toHaveScreenshot('new-session-dialog.png', {
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect
    .poll(() =>
      socketFrames.some(
        (frame) => frame.startsWith('sent:') && frame.includes('subscribe'),
      ),
    )
    .toBe(true);

  await createThroughUi(page, harness, 'Shared acceptance');
  await expect(
    page.getByRole('button', { name: /Shared acceptance/ }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        socketFrames.filter(
          (frame) => frame.startsWith('sent:') && frame.includes('subscribe'),
        ).length,
    )
    .toBe(2);
  await page.getByRole('button', { name: /Shared acceptance/ }).click();

  harness.driver.createdSessions[0].enqueue({
    kind: 'text_completed',
    text: 'Created after the socket connected',
  });
  await expect
    .poll(() =>
      socketFrames.some((frame) =>
        frame.includes('Created after the socket connected'),
      ),
    )
    .toBe(true);
  await expect(
    page.getByText('Created after the socket connected'),
  ).toBeVisible();
  const activePanel = page.locator('.session-panel-content');
  await expect(activePanel).toBeVisible();
  if (visualSnapshotsSupported) {
    await expect(activePanel).toHaveScreenshot('active-session-panel.png', {
      animations: 'disabled',
      mask: [activePanel.locator('.session-header dd').first()],
    });
  }

  await createThroughUi(page, harness, 'Worktree acceptance', 'worktree');
  const snapshot = await harness.snapshot();
  expect(snapshot.workspaces.map(({ type }) => type)).toEqual(
    expect.arrayContaining(['shared', 'worktree']),
  );
});

test('streams one live assistant card before persisting the final reply', async ({
  page,
  harness,
}) => {
  const sessionId = await createThroughApi(harness, 'Streaming session');
  await harness.waitForCreated();
  await page.goto(harness.origin);
  await page.getByRole('button', { name: /Streaming session/ }).click();
  const driverSession = harness.driver.createdSessions[0];
  const liveMessage = page.getByLabel('Streaming assistant message');

  driverSession.enqueue({ kind: 'text_delta', text: 'Streaming ' });
  await expect(liveMessage).toHaveText('AssistantStreaming');
  driverSession.enqueue({ kind: 'text_delta', text: 'works' });
  await expect(liveMessage).toHaveText('AssistantStreaming works');
  expect(
    (await harness.snapshot()).events.some(
      (event) =>
        event.sessionId === sessionId && event.type === 'message.assistant',
    ),
  ).toBe(false);

  driverSession.enqueue({
    kind: 'text_completed',
    text: 'Streaming works',
  });
  await expect(liveMessage).toHaveCount(0);
  await expect(
    page.getByLabel('Assistant message', { exact: true }),
  ).toHaveText('AssistantStreaming works');
});

test('blocks prompting when the subscription limit is reached', async ({
  page,
  harness,
}) => {
  const sessionId = await createThroughApi(harness, 'Limited session');
  await harness.waitForCreated();
  const socketFrames: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) =>
      socketFrames.push(`sent:${String(payload)}`),
    );
    socket.on('framereceived', ({ payload }) =>
      socketFrames.push(`received:${String(payload)}`),
    );
    socket.on('socketerror', (error) => socketFrames.push(`error:${error}`));
  });
  await page.goto(harness.origin);
  await page.getByRole('button', { name: /Limited session/ }).click();
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Must not be sent after the limit');
  const sendPrompt = page.getByRole('button', { name: 'Send prompt' });
  await expect
    .poll(() => socketFrames)
    .toEqual(
      expect.arrayContaining([expect.stringContaining('connection.health')]),
    );
  await expect(sendPrompt).toBeEnabled();

  harness.driver.createdSessions[0].enqueue({
    kind: 'limit',
    capability: 'five_hour',
    message: 'Claude subscription limit reached',
    resetAt: '2026-08-25T08:00:00.000Z',
  });

  await expect
    .poll(
      async () =>
        (await harness.snapshot()).sessions.find(({ id }) => id === sessionId)
          ?.lifecycleState,
    )
    .toBe('failed');
  await expect
    .poll(
      () =>
        socketFrames.some(
          (frame) =>
            frame.includes('session.status') && frame.includes('failed'),
        ),
      { message: socketFrames.join('\n') },
    )
    .toBe(true);
  await expect(sendPrompt).toBeDisabled();
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
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
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
  await page.getByLabel('Resume permission mode').selectOption('safe_auto');
  await page
    .getByRole('button', { name: 'Resume session', exact: true })
    .last()
    .click();
  await harness.waitForResumed();
  expect(harness.driver.resumedRequests[0].claudeResumeId).toBe(
    'discovered-resume-id',
  );
  expect(harness.driver.resumedRequests[0]).toMatchObject({
    workspacePath: harness.sharedPath,
    permissionMode: 'safe_auto',
  });

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
  const projectId = await harness.discoverProject();
  const before = harness.driver.createdRequests.length;
  const response = await harness.command({
    type: 'session.create',
    payload: {
      projectId,
      title: 'Must be refused',
      permissionMode: 'interactive',
      workspace: { type: 'shared', path: harness.sharedPath },
    },
  } as unknown as MutatingCommand);
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('billing_configuration_conflict');
  expect(harness.driver.createdRequests).toHaveLength(before);
});
