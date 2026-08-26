import type { Page } from '@playwright/test';
import {
  idSchema,
  projectSnapshotSchema,
  type DeveloperBlockerReportInput,
  type DeveloperCompletionReportInput,
  type DeveloperExecutionCycle,
  type MutatingCommand,
  type ProjectSnapshot,
} from '@mesh-session-platform/contracts';

import {
  expect,
  test,
  type FakeClaudeHarness,
} from '../fixtures/fake-claude.js';

const visualSnapshotsSupported = process.platform === 'win32';

const ensureImportedProject = async (
  harness: FakeClaudeHarness,
  displayName = 'Mesh E2E',
) => {
  const existing = (await harness.snapshot()).projects[0];
  if (existing) return existing.id;
  const result = await harness.command({
    type: 'project.import',
    payload: {
      repositoryPath: harness.repositoryPath,
      displayName,
      actor: {
        type: 'human',
        id: 'e2e-operator',
        displayName: 'E2E operator',
      },
    },
  } as unknown as MutatingCommand);
  expect(result.status).toBe(200);
  return (result.body.result as { id: string }).id;
};

const openSessionsView = async (page: Page) => {
  await page
    .getByRole('navigation', { name: 'Project destinations' })
    .getByRole('button', { name: 'Sessions', exact: true })
    .click();
};

const createThroughUi = async (
  page: Page,
  harness: FakeClaudeHarness,
  title: string,
  workspace: 'shared' | 'worktree' = 'shared',
) => {
  const projectId = await ensureImportedProject(harness);
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
  const projectId = await ensureImportedProject(harness);
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

const importTemporaryRepository = async (
  page: Page,
  harness: FakeClaudeHarness,
  displayName: string,
) => {
  await page.goto(harness.origin);
  await page.getByRole('button', { name: 'Import repository' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import repository' });
  await dialog.getByLabel('Repository path').fill(harness.repositoryPath);
  await dialog.getByLabel('Project name (optional)').fill(displayName);
  await dialog.getByRole('button', { name: 'Import project' }).click();
  await expect(
    page.getByRole('region', { name: `${displayName} board` }),
  ).toBeVisible();
};

const createReadyTask = async (
  page: Page,
  input: {
    title: string;
    description: string;
    acceptanceCriteria: readonly string[];
  },
) => {
  await page.getByRole('button', { name: 'Add task' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create task' });
  await createDialog.getByLabel('Task title').fill(input.title);
  await createDialog.getByRole('button', { name: 'Create task' }).click();

  const projectId = await page.getByLabel('Selected project').inputValue();
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ id, title }) => {
          const response = await fetch(`/api/projects/${id}/snapshot`);
          const snapshot = (await response.json()) as {
            tasks?: Array<{ title: string }>;
          };
          return snapshot.tasks?.some((task) => task.title === title);
        },
        { id: projectId, title: input.title },
      ),
    )
    .toBe(true);

  const backlog = page.getByRole('region', { name: 'Backlog tasks' });
  await expect(
    backlog.getByRole('article', { name: `${input.title} task card` }),
  ).toBeVisible();
  await backlog.getByRole('button', { name: `Open ${input.title}` }).click();

  const taskDialog = page.getByRole('dialog', { name: input.title });
  await taskDialog.getByLabel('Description').fill(input.description);
  await taskDialog
    .getByLabel('Acceptance criteria')
    .fill(input.acceptanceCriteria.join('\n'));
  await taskDialog.getByRole('button', { name: 'Save task' }).click();
  const moveToReady = taskDialog.getByRole('button', {
    name: 'Move to ready',
  });
  await expect(moveToReady).toBeEnabled();
  await moveToReady.click();

  await expect(
    taskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('ready');
  await taskDialog.getByRole('button', { name: 'Close' }).click();

  await expect(
    page
      .getByRole('region', { name: 'Ready tasks' })
      .getByRole('article', { name: `${input.title} task card` }),
  ).toBeVisible();
  await page.getByRole('button', { name: `Open ${input.title}` }).click();
  return taskDialog;
};

const launchIsolatedFakeAttempt = async (
  taskDialog: ReturnType<Page['getByRole']>,
  harness: FakeClaudeHarness,
  waitForStart = true,
) => {
  const launch = taskDialog.getByRole('region', { name: 'Launch attempt' });
  await launch.getByLabel('Workspace type').selectOption('worktree');
  await launch.getByLabel('Repository').fill(harness.repositoryPath);
  await launch.getByLabel('Branch').fill('mesh-task-attempt');
  await launch.getByLabel('Start point').fill('HEAD');
  await launch.getByLabel('Worktree path').fill(harness.worktreePath);
  await launch.getByLabel('Permission mode').selectOption('interactive');
  await launch.getByRole('button', { name: 'Launch attempt' }).click();
  if (waitForStart) await harness.waitForCreated();
};

const readProjectSnapshot = async (
  harness: FakeClaudeHarness,
  projectId: string,
): Promise<ProjectSnapshot> => {
  const response = await fetch(
    `${harness.origin}/api/projects/${projectId}/snapshot`,
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return projectSnapshotSchema.parse(body);
};

const waitForProjectSnapshot = async (
  harness: FakeClaudeHarness,
  projectId: string,
  predicate: (snapshot: ProjectSnapshot) => boolean,
  message: string,
) => {
  await expect
    .poll(
      async () => predicate(await readProjectSnapshot(harness, projectId)),
      {
        message,
      },
    )
    .toBe(true);
  return readProjectSnapshot(harness, projectId);
};

const saveDeveloperInstructions = async (
  page: Page,
  harness: FakeClaudeHarness,
  content: string,
) => {
  await page
    .getByRole('textbox', { name: 'Developer instructions' })
    .fill(content);
  await page.getByRole('button', { name: 'Save instructions' }).click();
  const projectId = await page.getByLabel('Selected project').inputValue();
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.project.developerInstructions.content === content,
    `Developer instructions were not persisted for project ${projectId}`,
  );
  return projectId;
};

const launchDeveloper = async (
  taskDialog: ReturnType<Page['getByRole']>,
  harness: FakeClaudeHarness,
  expectedCreatedCount: number,
) => {
  const workflow = taskDialog.getByRole('region', {
    name: 'Developer workflow',
  });
  await workflow
    .getByLabel('Developer permission mode')
    .selectOption('interactive');
  await workflow.getByRole('button', { name: 'Start Developer' }).click();
  await harness.waitForCreated(expectedCreatedCount);
  await expect(
    taskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('in progress');
  return workflow;
};

const completionReport = (
  cycle: DeveloperExecutionCycle,
  input: {
    id: string;
    summary: string;
    evidence: string;
    command: string;
    output: string;
    createdAt: string;
  },
): DeveloperCompletionReportInput => ({
  idempotencyKey: idSchema.parse(input.id),
  summary: input.summary,
  criterionResults: cycle.taskSnapshot.acceptanceCriteria.map((criterion) => ({
    criterionId: criterion.id,
    status: 'met',
    evidence: input.evidence,
  })),
  verification: [
    {
      command: input.command,
      outcome: 'passed',
      output: input.output,
    },
  ],
  limitations: 'No known limitations.',
  workspaceState: {
    summary: 'Changes committed in the temporary repository.',
    hasUncommittedChanges: false,
    commitsCreated: true,
  },
  reviewerNotes: null,
});

const blockerReport = (
  cycle: DeveloperExecutionCycle,
): DeveloperBlockerReportInput => ({
  idempotencyKey: idSchema.parse('developer-blocker-report-1'),
  reason: 'Required fixture is unavailable',
  evidence: 'The deterministic dependency probe returned no fixture.',
  attemptedWork: 'Checked the repository and reran the focused probe.',
  suggestedHumanAction: 'Provide the missing fixture before retrying.',
  preserveWorkspace: true,
});

test('keeps the empty cockpit usable at a narrow viewport', async ({
  page,
  harness,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ensureImportedProject(harness, 'repository');
  await harness.snapshot();
  await page.goto(harness.origin);
  await page.addStyleTag({
    content: `
      .project-navigation { display: none !important; }
      .app-shell { grid-template-rows: auto minmax(0, 1fr) !important; }
    `,
  });

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

test('gives the project kanban the remaining board height', async ({
  page,
  harness,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await ensureImportedProject(harness, 'repository');
  await harness.snapshot();
  await page.goto(harness.origin);
  await page.getByRole('button', { name: 'Board' }).click();

  const instructions = page.getByRole('region', {
    name: 'Developer instructions editor',
  });
  const columns = page.locator('.task-board-columns');
  await expect(instructions).toBeVisible();
  await expect(columns).toBeVisible();

  const layout = await page.evaluate(() => ({
    instructionsHeight: document
      .querySelector('.developer-instructions')!
      .getBoundingClientRect().height,
    columnsHeight: document
      .querySelector('.task-board-columns')!
      .getBoundingClientRect().height,
  }));
  expect(layout.columnsHeight).toBeGreaterThan(layout.instructionsHeight);
  expect(layout.columnsHeight).toBeGreaterThan(350);
});

test('creates shared and worktree sessions with the production-built server', async ({
  page,
  harness,
}) => {
  await page.setViewportSize({ width: 1488, height: 720 });
  const socketFrames: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) =>
      socketFrames.push(`sent:${String(payload)}`),
    );
    socket.on('framereceived', ({ payload }) =>
      socketFrames.push(`received:${String(payload)}`),
    );
  });
  await ensureImportedProject(harness);
  await harness.snapshot();
  await page.goto(harness.origin);
  await openSessionsView(page);
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
  await openSessionsView(page);
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
  await openSessionsView(page);
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
  await openSessionsView(page);
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
  await openSessionsView(page);
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
  await openSessionsView(page);
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
  await openSessionsView(reconnected);
  await reconnected.getByRole('button', { name: /Approval session/ }).click();
  await expect(reconnected.getByLabel('Permission Write')).toContainText(
    'Status: pending',
  );
  await reconnected.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => driverSession.permissionDecisions.length).toBe(1);
  await reconnected.reload();
  await openSessionsView(reconnected);
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

test('Developer review rework persists both completion cycles and human feedback after reload', async ({
  page,
  harness,
}) => {
  const title = 'Ship deterministic review flow';
  const instructions =
    'Run focused verification and report literal evidence for every criterion.';
  const rejectionFeedback =
    'Cover the reconnect case and rerun the focused acceptance test.';
  await importTemporaryRepository(page, harness, 'Developer review acceptance');
  const projectId = await saveDeveloperInstructions(
    page,
    harness,
    instructions,
  );
  const taskDialog = await createReadyTask(page, {
    title,
    description: 'Prove a rejected Developer submission can resume safely.',
    acceptanceCriteria: [
      'Both completion reports and review feedback survive a reload.',
    ],
  });
  const workflow = await launchDeveloper(taskDialog, harness, 1);

  const firstSnapshot = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.developerCycles.length === 1 &&
      snapshot.developerCycles[0]?.terminalDisposition === null,
    'The initial Developer cycle did not become active',
  );
  const firstCycle = firstSnapshot.developerCycles[0];
  if (!firstCycle) throw new Error('Expected the initial Developer cycle');
  await harness.driver.submitForReview(
    0,
    completionReport(firstCycle, {
      id: 'developer-completion-report-1',
      summary: 'Initial implementation is ready for review.',
      evidence:
        'The focused review-flow test passed before reconnect coverage.',
      command: 'corepack pnpm nx test web',
      output: 'Initial focused verification passed.',
      createdAt: '2026-08-26T01:00:00.000Z',
    }),
  );
  await expect
    .poll(() => harness.driver.createdSessions[0]?.interrupted, {
      message: 'The submitted Developer runtime was not interrupted',
    })
    .toBe(true);

  await expect(
    taskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('review');
  await expect(
    workflow.getByRole('region', { name: 'Completion report' }),
  ).toContainText('Initial implementation is ready for review.');
  await workflow.getByLabel('Rejection feedback').fill(rejectionFeedback);
  await workflow.getByLabel('Resume the same Developer attempt').check();
  await workflow.getByRole('button', { name: 'Reject submission' }).click();
  await harness.waitForResumed();

  const resumedSnapshot = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.developerCycles.length === 2 &&
      snapshot.developerReviewFeedback.some(
        (entry) => entry.feedback === rejectionFeedback,
      ),
    'The resumed Developer cycle and rejection feedback were not persisted',
  );
  const resumedCycle = resumedSnapshot.developerCycles.find(
    (cycle) => cycle.ordinal === 2,
  );
  if (!resumedCycle) throw new Error('Expected the resumed Developer cycle');
  expect(resumedCycle.attemptId).toBe(firstCycle.attemptId);
  await harness.driver.submitForReview(
    1,
    completionReport(resumedCycle, {
      id: 'developer-completion-report-2',
      summary: 'Reconnect coverage is complete and ready for review.',
      evidence: 'The reconnect acceptance path now passes after rework.',
      command: 'corepack pnpm nx e2e e2e --project=chromium --grep Developer',
      output: 'Reworked Developer acceptance path passed.',
      createdAt: '2026-08-26T01:30:00.000Z',
    }),
  );

  await expect(
    workflow.getByText('Reconnect coverage is complete and ready for review.'),
  ).toBeVisible();
  await workflow.getByRole('button', { name: 'Accept as done' }).click();
  await expect(
    taskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('done');

  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  await page.getByRole('button', { name: 'Show completed tasks' }).click();
  const completedCard = page
    .getByRole('region', { name: 'Completed tasks' })
    .getByRole('article', { name: `${title} task card` });
  await expect(completedCard).toBeVisible();
  await completedCard.getByRole('button', { name: `Open ${title}` }).click();

  const reloadedDialog = page.getByRole('dialog', { name: title });
  const history = reloadedDialog.getByRole('region', {
    name: 'Developer execution history',
  });
  await expect(history.getByRole('article')).toHaveCount(2);
  const firstHistoryCycle = history.getByRole('article', {
    name: 'Developer attempt 1 cycle 1',
  });
  await expect(firstHistoryCycle).toContainText(
    'Initial implementation is ready for review.',
  );
  await expect(firstHistoryCycle).toContainText(rejectionFeedback);
  await expect(
    history.getByRole('article', { name: 'Developer attempt 1 cycle 2' }),
  ).toContainText('Reconnect coverage is complete and ready for review.');
  expect(
    (await readProjectSnapshot(harness, projectId)).project
      .developerInstructions.content,
  ).toBe(instructions);
});

test('Developer blocker stops its runtime and fresh recovery retains blocked history after reload', async ({
  page,
  harness,
}) => {
  const title = 'Recover a blocked Developer';
  const unblockFeedback =
    'The missing fixture is now available; restart in a fresh attempt.';
  await importTemporaryRepository(
    page,
    harness,
    'Developer blocker acceptance',
  );
  const projectId = await page.getByLabel('Selected project').inputValue();
  const taskDialog = await createReadyTask(page, {
    title,
    description: 'Keep blocker evidence while a human starts fresh recovery.',
    acceptanceCriteria: [
      'The prior blocker and fresh completion remain in Developer history.',
    ],
  });
  const workflow = await launchDeveloper(taskDialog, harness, 1);

  const activeSnapshot = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.developerCycles.length === 1,
    'The blocked-path Developer cycle did not become active',
  );
  const blockedCycle = activeSnapshot.developerCycles[0];
  if (!blockedCycle) throw new Error('Expected the blocked Developer cycle');
  await harness.driver.markBlocked(0, blockerReport(blockedCycle));

  await expect
    .poll(() => harness.driver.createdSessions[0]?.interrupted, {
      message: 'The blocked Developer runtime was not interrupted',
    })
    .toBe(true);
  await expect(
    taskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('in progress');
  await expect(
    taskDialog.getByText('Blocked — Required fixture is unavailable'),
  ).toBeVisible();
  const blocker = workflow.getByRole('region', { name: 'Blocker report' });
  await expect(blocker).toContainText(
    'The deterministic dependency probe returned no fixture.',
  );
  await expect(blocker.getByText('Yes', { exact: true })).toBeVisible();

  await workflow.getByLabel('Unblock reason').fill(unblockFeedback);
  await workflow.getByLabel('Start a new attempt after unblock').check();
  await workflow
    .getByLabel('Developer permission mode')
    .selectOption('interactive');
  await workflow.getByRole('button', { name: 'Unblock Developer' }).click();
  await harness.waitForCreated(2);

  const freshSnapshot = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.attempts.length === 2 &&
      snapshot.developerCycles.length === 2 &&
      snapshot.developerReviewFeedback.some(
        (entry) => entry.feedback === unblockFeedback,
      ),
    'The fresh unblock attempt did not preserve blocker feedback and history',
  );
  const freshCycle = freshSnapshot.developerCycles.find(
    (cycle) => cycle.attemptId !== blockedCycle.attemptId,
  );
  if (!freshCycle) throw new Error('Expected a fresh Developer attempt cycle');
  await harness.driver.submitForReview(
    1,
    completionReport(freshCycle, {
      id: 'developer-completion-after-blocker',
      summary: 'Fresh recovery completed with the fixture available.',
      evidence: 'The recovered acceptance path passed in a new attempt.',
      command: 'corepack pnpm nx e2e e2e --project=chromium --grep Developer',
      output: 'Fresh recovery verification passed.',
      createdAt: '2026-08-26T02:30:00.000Z',
    }),
  );
  await expect(
    taskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('review');
  await expect(
    workflow.getByText('Fresh recovery completed with the fixture available.'),
  ).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  const reviewCard = page
    .getByRole('region', { name: 'Review tasks' })
    .getByRole('article', { name: `${title} task card` });
  await expect(reviewCard).toBeVisible();
  await reviewCard.getByRole('button', { name: `Open ${title}` }).click();

  const history = page
    .getByRole('dialog', { name: title })
    .getByRole('region', { name: 'Developer execution history' });
  await expect(history.getByRole('article')).toHaveCount(2);
  const blockedHistory = history.getByRole('article', {
    name: 'Developer attempt 1 cycle 1',
  });
  await expect(blockedHistory).toContainText('Required fixture is unavailable');
  await expect(blockedHistory).toContainText(unblockFeedback);
  await expect(
    history.getByRole('article', { name: 'Developer attempt 2 cycle 1' }),
  ).toContainText('Fresh recovery completed with the fixture available.');
});

test('imports a project and preserves an attempted task across refresh', async ({
  page,
  harness,
}) => {
  const title = 'Add retry controls';
  await importTemporaryRepository(page, harness, 'Task board acceptance');
  const taskDialog = await createReadyTask(page, {
    title,
    description: 'Expose a safe retry action.',
    acceptanceCriteria: ['A failed session can be retried explicitly.'],
  });

  await launchIsolatedFakeAttempt(taskDialog, harness);
  await expect(
    taskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('in progress');
  await expect(
    taskDialog.getByRole('article', { name: 'Attempt 1' }),
  ).toContainText('Running');
  harness.driver.createdSessions[0].enqueue({
    kind: 'text_completed',
    text: 'Live after task launch',
  });
  const launchedSessionId = (await harness.snapshot()).sessions.at(-1)?.id;
  if (!launchedSessionId) throw new Error('Expected launched task session');
  await waitForHistory(harness, launchedSessionId, (events) =>
    events.some(
      ({ type, payload }) =>
        type === 'message.assistant' &&
        'text' in payload &&
        payload.text === 'Live after task launch',
    ),
  );
  await taskDialog.getByRole('button', { name: 'Close' }).click();
  await expect(
    page
      .getByRole('region', { name: 'In progress tasks' })
      .getByRole('article', { name: `${title} task card` }),
  ).toBeVisible();
  await page.getByRole('button', { name: `Open ${title}` }).click();

  await taskDialog.getByRole('button', { name: `Open ${title}` }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await expect(page.getByText('Live after task launch')).toBeVisible();
  await page.getByRole('button', { name: 'Board' }).click();
  await page.getByRole('button', { name: `Open ${title}` }).click();

  const refreshedTaskDialog = page.getByRole('dialog', { name: title });
  await refreshedTaskDialog
    .getByRole('button', { name: 'Mark for review' })
    .click();
  await expect(
    refreshedTaskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('review');
  await refreshedTaskDialog.getByRole('button', { name: 'Close' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Review tasks' })
      .getByRole('article', { name: `${title} task card` }),
  ).toBeVisible();
  await page.getByRole('button', { name: `Open ${title}` }).click();
  await refreshedTaskDialog.getByRole('button', { name: 'Mark done' }).click();
  await expect(
    refreshedTaskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('done');
  await refreshedTaskDialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Show completed tasks' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Completed tasks' })
      .getByRole('article', { name: `${title} task card` }),
  ).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  await page.getByRole('button', { name: 'Show completed tasks' }).click();
  const doneCard = page
    .getByRole('region', { name: 'Completed tasks' })
    .getByRole('article', { name: `${title} task card` });
  await expect(doneCard).toBeVisible();
  await doneCard.getByRole('button', { name: `Open ${title}` }).click();
  await expect(
    page.getByRole('dialog', { name: title }).getByRole('article', {
      name: 'Attempt 1',
    }),
  ).toBeVisible();
});

test('imports a project and retains a failed startup attempt', async ({
  page,
  harness,
}) => {
  const title = 'Recover failed startup';
  await importTemporaryRepository(page, harness, 'Failed start acceptance');
  const taskDialog = await createReadyTask(page, {
    title,
    description: 'Keep failed startup history visible.',
    acceptanceCriteria: ['The task remains ready after startup fails.'],
  });
  const driver = harness.driver as FakeClaudeHarness['driver'] & {
    create(request: unknown): Promise<never>;
  };
  driver.create = async () => {
    throw new Error('Simulated fake-driver startup failure');
  };

  await launchIsolatedFakeAttempt(taskDialog, harness, false);

  await expect(taskDialog.getByRole('alert')).toContainText(/did not start/i);
  await expect(
    taskDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('ready');
  await expect(
    taskDialog.getByRole('article', { name: 'Attempt 1' }),
  ).toContainText('Launched');
  await taskDialog.getByRole('button', { name: 'Close' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Ready tasks' })
      .getByRole('article', { name: `${title} task card` }),
  ).toBeVisible();
});

test('refuses API-billing conflicts without invoking Claude', async ({
  harness,
}) => {
  const projectId = await ensureImportedProject(harness);
  await harness.restart({ billingConflict: true });
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
