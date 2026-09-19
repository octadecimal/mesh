import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  idSchema,
  projectSnapshotSchema,
  type DeveloperBlockerReportInput,
  type DeveloperCompletionReportInput,
  type DeveloperExecutionCycle,
  type MutatingCommand,
  type ProjectPlanProposalInput,
  type ProjectSnapshot,
  type QaReportInput,
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

const openProjectWorkspace = async (
  page: Page,
  name: 'Plan' | 'Board' | 'Project settings',
) => {
  await page
    .getByRole('navigation', { name: 'Project destinations' })
    .getByRole('button', { name, exact: true })
    .click();
};

const openPlanView = (page: Page) => openProjectWorkspace(page, 'Plan');
const openBoardView = (page: Page) => openProjectWorkspace(page, 'Board');
const openSettingsView = (page: Page) =>
  openProjectWorkspace(page, 'Project settings');

const openRunPanel = async (page: Page) => {
  await openBoardView(page);
  await page
    .getByRole('button', {
      name: /^(Start ready tasks|Manage running work|Run details)$/,
    })
    .click();
  return page.getByRole('region', { name: 'Project run', exact: true });
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
  await page.getByRole('button', { name: 'Import project' }).click();
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
  await openBoardView(page);
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
  await openSettingsView(page);
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

const saveQaSettings = async (
  page: Page,
  harness: FakeClaudeHarness,
  input: {
    content: string;
    reviewPolicy: 'manual' | 'autonomous_review';
  },
) => {
  await openSettingsView(page);
  const settings = page.getByRole('region', { name: 'QA settings' });
  await settings.getByLabel('QA instructions').fill(input.content);
  await settings.getByLabel('Review policy').selectOption(input.reviewPolicy);
  await settings.getByRole('button', { name: 'Save QA settings' }).click();
  if (input.reviewPolicy === 'autonomous_review') {
    await page
      .getByRole('dialog', { name: 'Enable autonomous review' })
      .getByRole('button', { name: 'Enable autonomous review' })
      .click();
  }
  const projectId = await page.getByLabel('Selected project').inputValue();
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.project.qaConfiguration.instructions.content === input.content &&
      snapshot.project.qaConfiguration.reviewPolicy === input.reviewPolicy,
    `QA settings were not persisted for project ${projectId}`,
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

const qaReport = (
  cycle: DeveloperExecutionCycle,
  disposition: 'verified' | 'rejected',
  marker: string,
): QaReportInput => ({
  disposition,
  criterionResults: cycle.taskSnapshot.acceptanceCriteria.map(
    (criterion, index) => ({
      criterionId: criterion.id,
      status:
        disposition === 'verified' || index > 0
          ? 'passed'
          : ('failed' as const),
      evidence: `${marker}: ${criterion.text}`,
    }),
  ),
  limitations: [],
  residualRisks: disposition === 'rejected' ? [`${marker} needs rework`] : [],
});

const currentDeveloperCycle = (snapshot: ProjectSnapshot) => {
  const cycle = snapshot.developerCycles.at(-1);
  if (!cycle) throw new Error('Expected a current Developer cycle');
  return cycle;
};

const enableTaskAutomation = async (
  taskDialog: ReturnType<Page['getByRole']>,
  harness: FakeClaudeHarness,
  projectId: string,
  title: string,
) => {
  await taskDialog.getByRole('button', { name: 'Enable automation' }).click();
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.tasks.some(
        (task) =>
          task.title === title && task.reviewAutomation.status === 'enabled',
      ),
    `Review automation was not enabled for ${title}`,
  );
};

const proposalTask = (
  key: string,
  title: string,
): ProjectPlanProposalInput['tasks'][number] => ({
  key: idSchema.parse(key),
  title,
  description: `Deliver the ${title.toLowerCase()} scope.`,
  acceptanceCriteria: [`${title} is complete and verified.`],
  priority: 'high',
  labels: ['pm-plan'],
  rationale: `${title} is required by the approved project goal.`,
  goalMapping: `Advances dependency-aware delivery through ${title}.`,
});

const proposalDependency = (
  dependentTaskKey: string,
  prerequisiteTaskKey: string,
): ProjectPlanProposalInput['dependencies'][number] => ({
  dependentTaskKey: idSchema.parse(dependentTaskKey),
  prerequisite: {
    type: 'proposal_task',
    taskKey: idSchema.parse(prerequisiteTaskKey),
  },
});

const planningProposal = (
  foundationTitle = 'Foundation contract',
): ProjectPlanProposalInput => ({
  tasks: [
    proposalTask('foundation', foundationTitle),
    proposalTask('feature', 'Feature delivery'),
  ],
  dependencies: [proposalDependency('feature', 'foundation')],
  assumptions: ['The imported repository is the planning authority.'],
  risks: ['Canonical task truth may change during review.'],
  exclusions: ['Continuous scheduling remains out of scope.'],
});

const startProjectPlanning = async (
  page: Page,
  harness: FakeClaudeHarness,
  goal: string,
  expectedRuntimeCount = 1,
) => {
  await openPlanView(page);
  const panel = page.getByRole('region', { name: 'Project planning' });
  await panel.getByLabel('Project goal').fill(goal);
  await panel
    .getByLabel('I understand planning consumes Claude subscription capacity.')
    .check();
  await panel.getByRole('button', { name: 'Start planning' }).click();
  await expect
    .poll(() => harness.pmRuntimeConfigurations().length)
    .toBe(expectedRuntimeCount);
  return panel;
};

const reviewCurrentProposal = async (page: Page) => {
  await openPlanView(page);
  const panel = page.getByRole('region', { name: 'Project planning' });
  const review = panel.getByRole('button', { name: 'Review proposal' });
  await expect(review).toBeVisible();
  await review.click();
  await expect(
    panel.getByRole('list', { name: 'Proposed tasks' }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Approve plan' }),
  ).toBeEnabled();
  return panel;
};

const fakeDriverRequestCounts = (harness: FakeClaudeHarness) => ({
  createRequests: harness.driver.createdRequests.length,
  resumeRequests: harness.driver.resumedRequests.length,
  pmConfigurations: harness.pmRuntimeConfigurations().length,
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

  await expect(
    page.getByRole('heading', { name: 'What would you like to build?' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start planning' }),
  ).toBeVisible();
  if (visualSnapshotsSupported) {
    await expect(page).toHaveScreenshot('empty-cockpit-narrow.png', {
      animations: 'disabled',
      fullPage: true,
    });
  }
});

test('creates a local Git project through the onboarding form', async ({
  page,
  harness,
}, testInfo) => {
  const name = `new-project-${Date.now()}`;
  await page.goto(harness.origin);
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Project name').fill(name);
  await dialog
    .getByLabel('Parent directory')
    .fill(dirname(harness.repositoryPath));
  const screenshotPath = testInfo.outputPath('new-project-dialog.png');
  await dialog.screenshot({ path: screenshotPath });
  await testInfo.attach('new-project-dialog', {
    path: screenshotPath,
    contentType: 'image/png',
  });
  await dialog.getByRole('button', { name: 'Create project' }).click();

  await expect(
    page.getByRole('region', { name: `${name} board` }),
  ).toBeVisible();
  expect(existsSync(join(dirname(harness.repositoryPath), name, '.git'))).toBe(
    true,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(
    page.getByRole('region', { name: `${name} board` }),
  ).toBeVisible();
});

test('separates the compact project workspaces at desktop and narrow widths', async ({
  page,
  harness,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureImportedProject(harness, 'repository');
  await harness.snapshot();
  await page.goto(harness.origin);
  await openPlanView(page);
  await expect(
    page.getByRole('region', { name: 'Project planning' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'What would you like to build?' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('region', { name: 'Backlog tasks' }),
  ).toBeHidden();

  await openBoardView(page);
  await expect(
    page.getByRole('region', { name: 'Backlog tasks' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Project planning' }),
  ).toBeHidden();
  await expect(page.getByRole('region', { name: 'Project run' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Run details' })).toBeVisible();
  const desktopBoard = await page.evaluate(() => {
    const toolbar = document.querySelector('.task-board-toolbar');
    const columns = document.querySelector('.task-board-columns');
    if (!toolbar || !columns)
      throw new Error('Expected board toolbar and columns');
    return {
      gap:
        columns.getBoundingClientRect().top -
        toolbar.getBoundingClientRect().bottom,
      overflows: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(desktopBoard.gap).toBeLessThan(80);
  expect(desktopBoard.overflows).toBe(false);

  await page.setViewportSize({ width: 700, height: 900 });
  await expect(
    page.getByRole('region', { name: 'Backlog tasks' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await openSessionsView(page);
  await expect(
    page.getByRole('complementary', { name: 'Sessions' }),
  ).toBeVisible();
  await expect(
    page.getByRole('main', { name: 'Session workspace' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Backlog tasks' }),
  ).toBeHidden();
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
    'rgb(193, 205, 253)',
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
    });
  }
  await activePanel.getByRole('button', { name: 'Details' }).click();
  const details = activePanel.getByLabel('Session details');
  await expect(details).toBeVisible();
  const desktopLayout = await activePanel.evaluate((panel) => {
    const conversation = panel.querySelector('.session-conversation');
    const detailsPanel = panel.querySelector('.session-details');
    if (!conversation || !detailsPanel)
      throw new Error('Expected session layout');
    return {
      conversation: conversation.getBoundingClientRect(),
      details: detailsPanel.getBoundingClientRect(),
    };
  });
  expect(desktopLayout.details.left).toBeGreaterThanOrEqual(
    desktopLayout.conversation.right,
  );

  await activePanel.evaluate((panel) => {
    const container = panel.closest<HTMLElement>('.session-panel');
    if (!container) throw new Error('Expected session panel container');
    container.style.width = '390px';
    container.style.height = '400px';
  });
  const narrowLayout = await activePanel.evaluate((panel) => {
    const conversation = panel.querySelector('.session-conversation');
    const detailsPanel = panel.querySelector('.session-details');
    const composer = panel.querySelector('.prompt-composer');
    const assistantText = panel.querySelector('.transcript-assistant p');
    if (!conversation || !detailsPanel || !composer || !assistantText)
      throw new Error('Expected narrow session layout');
    return {
      conversation: conversation.getBoundingClientRect(),
      details: detailsPanel.getBoundingClientRect(),
      composer: composer.getBoundingClientRect(),
      panel: panel.getBoundingClientRect(),
      assistantText: assistantText.getBoundingClientRect(),
      controls: [...panel.querySelectorAll('textarea, button')]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getBoundingClientRect()),
    };
  });
  expect(narrowLayout.details.top).toBeGreaterThanOrEqual(
    narrowLayout.conversation.bottom,
  );
  expect(narrowLayout.composer.bottom).toBeLessThanOrEqual(
    narrowLayout.panel.bottom,
  );
  expect(narrowLayout.assistantText.top).toBeGreaterThanOrEqual(
    narrowLayout.conversation.top,
  );
  expect(narrowLayout.assistantText.bottom).toBeLessThanOrEqual(
    narrowLayout.conversation.bottom,
  );
  for (const control of narrowLayout.controls) {
    expect(control.left).toBeGreaterThanOrEqual(narrowLayout.panel.left);
    expect(control.right).toBeLessThanOrEqual(narrowLayout.panel.right);
  }
  await activePanel.screenshot({
    path: 'tmp/playwright/session-focused-layout-narrow.png',
  });
  await activePanel.evaluate((panel) => {
    const container = panel.closest<HTMLElement>('.session-panel');
    if (!container) throw new Error('Expected session panel container');
    container.style.height = '600px';
  });
  await activePanel.screenshot({
    path: 'tmp/playwright/session-focused-layout-tall.png',
  });

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
    .getByRole('button', { name: 'Details' })
    .click();
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
  await reconnected
    .getByRole('complementary', { name: 'Sessions' })
    .getByRole('button', { name: /Approval session/ })
    .click();
  await expect(reconnected.getByLabel('Permission Write')).toContainText(
    'Status: pending',
  );
  await reconnected.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => driverSession.permissionDecisions.length).toBe(1);
  await reconnected.reload();
  await openSessionsView(reconnected);
  await reconnected
    .getByRole('complementary', { name: 'Sessions' })
    .getByRole('button', { name: /Approval session/ })
    .click();
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
  await openSessionsView(page);
  await page.getByRole('button', { name: 'Resume session' }).click();
  await page.getByRole('radio', { name: 'Discovered Claude session' }).check();
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

test('QA review autonomously rejects, resumes the same Developer, verifies, and restores one alternating history', async ({
  page,
  harness,
}) => {
  const title = 'Autonomously verify the reconnect fix';
  await importTemporaryRepository(page, harness, 'Autonomous QA acceptance');
  const projectId = await saveQaSettings(page, harness, {
    content: 'Read the implementation, run the fake verification, and report.',
    reviewPolicy: 'autonomous_review',
  });
  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  await saveDeveloperInstructions(
    page,
    harness,
    'Implement the task and submit literal verification evidence.',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  const taskDialog = await createReadyTask(page, {
    title,
    description: 'Exercise one autonomous rejection and successful re-review.',
    acceptanceCriteria: ['The reconnect behavior remains deterministic.'],
  });
  await enableTaskAutomation(taskDialog, harness, projectId, title);
  const workflow = await launchDeveloper(taskDialog, harness, 1);
  const firstSnapshot = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.developerCycles.length === 1,
    'The initial Developer cycle did not start',
  );
  const firstCycle = currentDeveloperCycle(firstSnapshot);
  harness.driver.queueQaStep({
    type: 'qa.rejected',
    report: qaReport(firstCycle, 'rejected', 'qa-rejection-one'),
  });
  await harness.driver.submitLatestDeveloperForReview(
    completionReport(firstCycle, {
      id: 'qa-e2e-autonomous-developer-report-1',
      summary: 'The initial reconnect implementation is ready.',
      evidence: 'The initial fake reconnect verification passed.',
      command: 'fake-developer verify reconnect-one',
      output: 'Initial scripted Developer verification passed.',
      createdAt: '2026-08-26T03:00:00.000Z',
    }),
  );

  const resumedSnapshot = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.qaCycles.length === 1 &&
      snapshot.qaCycles[0]?.terminalDisposition === 'rejected' &&
      snapshot.developerCycles.length === 2 &&
      snapshot.tasks.some(
        (task) => task.title === title && task.lifecycleState === 'in_progress',
      ),
    'Autonomous rejection did not resume the Developer cycle',
  );
  await harness.waitForResumed(1);
  expect(harness.driver.latestDeveloperResumeId()).toBe(
    harness.driver.initialDeveloperResumeId(),
  );
  await expect(workflow.getByText('QA rejected')).toBeVisible();

  const resumedCycle = currentDeveloperCycle(resumedSnapshot);
  harness.driver.queueQaStep({
    type: 'qa.verified',
    report: qaReport(resumedCycle, 'verified', 'qa-verification-two'),
  });
  await harness.driver.submitLatestDeveloperForReview(
    completionReport(resumedCycle, {
      id: 'qa-e2e-autonomous-developer-report-2',
      summary: 'The reconnect implementation is reworked and ready.',
      evidence: 'The reworked fake reconnect verification passed.',
      command: 'fake-developer verify reconnect-two',
      output: 'Reworked scripted Developer verification passed.',
      createdAt: '2026-08-26T03:30:00.000Z',
    }),
  );
  await harness.driver.drainQaSteps();
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.qaCycles.length === 2 &&
      snapshot.qaCycles[1]?.terminalDisposition === 'verified' &&
      snapshot.tasks.some(
        (task) => task.title === title && task.lifecycleState === 'done',
      ),
    'Autonomous verification did not complete the task',
  );

  await expect(workflow.getByText('QA verified')).toBeVisible();
  const automationHistory = taskDialog.getByRole('region', {
    name: 'Automation audit',
  });
  await expect(
    automationHistory.getByText('Resume developer', { exact: true }),
  ).toHaveCount(1);

  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  await page.getByRole('button', { name: 'Show completed tasks' }).click();
  const completedCard = page
    .getByRole('region', { name: 'Completed tasks' })
    .getByRole('article', { name: `${title} task card` });
  await expect(completedCard).toBeVisible();
  await completedCard.getByRole('button', { name: `Open ${title}` }).click();

  const restoredHistory = page
    .getByRole('dialog', { name: title })
    .getByRole('region', { name: 'Developer execution history' });
  expect(
    await restoredHistory
      .getByRole('article')
      .evaluateAll((articles) =>
        articles.map((article) => article.getAttribute('aria-label')),
      ),
  ).toEqual([
    'Developer attempt 1 cycle 1',
    'QA attempt 1 cycle 1',
    'Developer attempt 1 cycle 2',
    'QA attempt 1 cycle 2',
  ]);
});

test('QA review manual verification waits for human acceptance', async ({
  page,
  harness,
}) => {
  const title = 'Manually accept verified QA work';
  await importTemporaryRepository(page, harness, 'Manual QA verification');
  const projectId = await saveQaSettings(page, harness, {
    content: 'Verify every acceptance criterion without changing source.',
    reviewPolicy: 'manual',
  });
  const taskDialog = await createReadyTask(page, {
    title,
    description: 'Require a human click after a verified QA report.',
    acceptanceCriteria: ['Verified work remains in review until accepted.'],
  });
  await launchDeveloper(taskDialog, harness, 1);
  const active = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.developerCycles.length === 1,
    'The manual verification Developer cycle did not start',
  );
  const cycle = currentDeveloperCycle(active);
  await harness.driver.submitLatestDeveloperForReview(
    completionReport(cycle, {
      id: 'qa-e2e-manual-verified-developer-report',
      summary: 'Manual verification candidate is ready.',
      evidence: 'The fake Developer verification passed.',
      command: 'fake-developer verify manual-verified',
      output: 'Manual candidate verification passed.',
      createdAt: '2026-08-26T04:00:00.000Z',
    }),
  );
  harness.driver.queueQaStep({
    type: 'qa.verified',
    report: qaReport(cycle, 'verified', 'manual-qa-verified'),
  });
  await taskDialog.getByRole('button', { name: 'Start QA' }).click();
  await harness.driver.drainQaSteps();

  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.qaCycles.length === 1 &&
      snapshot.qaCycles[0]?.terminalDisposition === 'verified' &&
      snapshot.tasks.some(
        (task) => task.title === title && task.lifecycleState === 'review',
      ),
    'Manual verified work advanced without human acceptance',
  );
  await expect(
    taskDialog.getByRole('button', { name: 'Accept verified work' }),
  ).toBeVisible();
  expect(harness.driver.resumedRequests).toHaveLength(0);
});

test('QA review manual rejection waits for a human rework choice', async ({
  page,
  harness,
}) => {
  const title = 'Manually choose rejected QA rework';
  await importTemporaryRepository(page, harness, 'Manual QA rejection');
  const projectId = await saveQaSettings(page, harness, {
    content: 'Reject incomplete evidence and preserve the review state.',
    reviewPolicy: 'manual',
  });
  const taskDialog = await createReadyTask(page, {
    title,
    description: 'Require a human rework decision after rejection.',
    acceptanceCriteria: ['Rejected work remains in review without a resume.'],
  });
  await launchDeveloper(taskDialog, harness, 1);
  const active = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.developerCycles.length === 1,
    'The manual rejection Developer cycle did not start',
  );
  const cycle = currentDeveloperCycle(active);
  await harness.driver.submitLatestDeveloperForReview(
    completionReport(cycle, {
      id: 'qa-e2e-manual-rejected-developer-report',
      summary: 'Manual rejection candidate is ready.',
      evidence: 'The incomplete fake verification produced evidence.',
      command: 'fake-developer verify manual-rejected',
      output: 'The scripted verification exposed a gap.',
      createdAt: '2026-08-26T04:30:00.000Z',
    }),
  );
  harness.driver.queueQaStep({
    type: 'qa.rejected',
    report: qaReport(cycle, 'rejected', 'manual-qa-rejected'),
  });
  await taskDialog.getByRole('button', { name: 'Start QA' }).click();
  await harness.driver.drainQaSteps();

  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.qaCycles.length === 1 &&
      snapshot.qaCycles[0]?.terminalDisposition === 'rejected' &&
      snapshot.tasks.some(
        (task) => task.title === title && task.lifecycleState === 'review',
      ),
    'Manual rejected work resumed without a human decision',
  );
  await expect(
    taskDialog.getByRole('button', { name: 'Resume Developer rework' }),
  ).toBeVisible();
  expect(harness.driver.resumedRequests).toHaveLength(0);
});

test('QA review pauses after the third autonomous rejection without another Developer resume', async ({
  page,
  harness,
}) => {
  const title = 'Pause after three QA rejections';
  await importTemporaryRepository(page, harness, 'QA ceiling acceptance');
  const projectId = await saveQaSettings(page, harness, {
    content: 'Reject each scripted incomplete verification.',
    reviewPolicy: 'autonomous_review',
  });
  const taskDialog = await createReadyTask(page, {
    title,
    description: 'Bound autonomous review to three QA rejections.',
    acceptanceCriteria: ['The third rejection starts no Developer cycle.'],
  });
  await enableTaskAutomation(taskDialog, harness, projectId, title);
  await launchDeveloper(taskDialog, harness, 1);

  for (let rejection = 1; rejection <= 3; rejection += 1) {
    const before = await waitForProjectSnapshot(
      harness,
      projectId,
      (snapshot) => snapshot.developerCycles.length === rejection,
      `Developer cycle ${rejection} did not become available`,
    );
    const cycle = currentDeveloperCycle(before);
    harness.driver.queueQaStep({
      type: 'qa.rejected',
      report: qaReport(cycle, 'rejected', `qa-ceiling-${rejection}`),
    });
    await harness.driver.submitLatestDeveloperForReview(
      completionReport(cycle, {
        id: `qa-e2e-ceiling-developer-report-${rejection}`,
        summary: `Autonomous rejection candidate ${rejection} is ready.`,
        evidence: `Scripted Developer evidence ${rejection}.`,
        command: `fake-developer verify ceiling-${rejection}`,
        output: `Scripted ceiling verification ${rejection} completed.`,
        createdAt: `2026-08-26T0${4 + rejection}:00:00.000Z`,
      }),
    );
    await harness.driver.drainQaSteps();
    await waitForProjectSnapshot(
      harness,
      projectId,
      (snapshot) =>
        snapshot.qaCycles.length === rejection &&
        snapshot.qaCycles.at(-1)?.terminalDisposition === 'rejected' &&
        (rejection < 3
          ? snapshot.developerCycles.length === rejection + 1
          : snapshot.tasks.some(
              (task) =>
                task.title === title &&
                task.lifecycleState === 'review' &&
                task.reviewAutomation.status === 'paused' &&
                task.reviewAutomation.rejectionCount === 3,
            )),
      `Autonomous rejection ${rejection} did not reach its durable outcome`,
    );
  }

  expect(harness.driver.resumedRequests).toHaveLength(2);
  await expect(
    taskDialog.getByText(
      /Automation paused: Three autonomous QA rejections require a human decision/i,
    ),
  ).toBeVisible();
  await expect(
    taskDialog.getByText('0 autonomous rejections remaining'),
  ).toBeVisible();
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
  await page
    .getByRole('button', { name: `Open task: ${title}`, exact: true })
    .click();

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

test('finite project run preserves bounded progress and durable history', async ({
  page,
  harness,
}) => {
  const taskTitles = [
    'task-auto',
    'task-manual',
    'task-blocked',
    'task-later-auto',
    'task-later-manual',
    'task-not-started',
  ] as const;
  const itemStates = (snapshot: ProjectSnapshot) => {
    const run = snapshot.runs.at(-1);
    if (!run) throw new Error('Expected a finite project run');
    const titles = new Map(snapshot.tasks.map((task) => [task.id, task.title]));
    return run.items.map((item) => ({
      title: titles.get(item.taskId),
      position: item.queuePosition,
      status: item.status,
      reason: item.outcomeReason,
    }));
  };

  await importTemporaryRepository(page, harness, 'Finite project run');
  const projectId = await saveQaSettings(page, harness, {
    content: 'Verify the deterministic finite-run submission.',
    reviewPolicy: 'autonomous_review',
  });
  for (const title of taskTitles) {
    const dialog = await createReadyTask(page, {
      title,
      description: `Exercise the ${title} finite-run outcome.`,
      acceptanceCriteria: [`${title} reaches its authorized outcome.`],
    });
    if (title === 'task-auto' || title === 'task-later-auto') {
      await enableTaskAutomation(dialog, harness, projectId, title);
    }
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
  const createdTasks = (await readProjectSnapshot(harness, projectId)).tasks;
  for (const [index, title] of taskTitles.entries()) {
    const task = createdTasks.find((candidate) => candidate.title === title);
    if (!task) throw new Error(`Expected created task ${title}`);
    const reordered = await harness.command({
      type: 'task.reorder',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        rank: `finite-${index}`,
        actor: {
          type: 'human',
          id: 'e2e-operator',
          displayName: 'E2E operator',
        },
      },
    } as unknown as MutatingCommand);
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
  }

  harness.queueTaskOutcome('task-auto', {
    developer: 'complete',
    qa: 'verified',
    hold: true,
  });
  harness.queueTaskOutcome('task-manual', {
    developer: 'complete',
    hold: true,
  });
  harness.queueTaskOutcome('task-blocked', { developer: 'blocked' });
  harness.queueTaskOutcome('task-later-auto', {
    developer: 'complete',
    qa: 'verified',
    hold: true,
  });
  harness.queueTaskOutcome('task-later-manual', {
    developer: 'complete',
    hold: true,
  });

  const runPanel = await openRunPanel(page);
  await runPanel.getByRole('button', { name: 'Start run' }).click();
  const preview = runPanel.getByRole('list', { name: 'Eligible run order' });
  await expect(preview.getByRole('listitem')).toHaveCount(taskTitles.length);
  for (const title of taskTitles) await expect(preview).toContainText(title);
  await runPanel.getByLabel('Concurrency').fill('2');
  await runPanel
    .getByLabel('I confirm this run may consume Claude subscription capacity.')
    .check();
  await runPanel.getByRole('button', { name: 'Authorize run' }).click();

  await expect
    .poll(() => harness.startedTaskTitles())
    .toEqual(['task-auto', 'task-manual']);
  const boundedStart = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => {
      const states = itemStates(snapshot);
      return (
        states.filter(({ status }) => status === 'active').length === 2 &&
        states.filter(({ status }) => status === 'queued').length === 4
      );
    },
    'Concurrency two did not freeze the third task behind two active tasks',
  );
  expect(itemStates(boundedStart).map(({ title }) => title)).toEqual(
    taskTitles,
  );

  await runPanel.getByRole('button', { name: 'Pause new launches' }).click();
  const paused = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => {
      const run = snapshot.runs.at(-1);
      return run?.state === 'paused' && run.pauseReason === 'operator_paused';
    },
    'Pause did not become durable',
  );
  expect(paused.runs.at(-1)).toMatchObject({
    state: 'paused',
    pauseReason: 'operator_paused',
  });
  harness.releaseTaskOutcome('task-auto');
  await harness.waitForTaskOutcome('task-auto');
  const scriptedAutoOutcome = await readProjectSnapshot(harness, projectId);
  const scriptedAutoTask = scriptedAutoOutcome.tasks.find(
    ({ title }) => title === 'task-auto',
  );
  expect({
    item: itemStates(scriptedAutoOutcome).find(
      ({ title }) => title === 'task-auto',
    ),
    lifecycleState: scriptedAutoTask?.lifecycleState,
    automation: scriptedAutoTask?.reviewAutomation,
    qaDispositions: scriptedAutoOutcome.qaCycles.map(
      ({ terminalDisposition }) => terminalDisposition,
    ),
    qaReportCount: scriptedAutoOutcome.qaReports.length,
  }).toMatchObject({
    item: { status: 'completed' },
    lifecycleState: 'done',
    qaDispositions: ['verified'],
    qaReportCount: 1,
  });
  const pausedWithOneActive = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => {
      const states = itemStates(snapshot);
      return (
        snapshot.runs.at(-1)?.state === 'paused' &&
        states.find(({ title }) => title === 'task-auto')?.status ===
          'completed' &&
        states.filter(({ status }) => status === 'active').length === 1
      );
    },
    'The autonomous task did not finish while the paused queue stayed bounded',
  );
  expect(harness.startedTaskTitles()).toEqual(['task-auto', 'task-manual']);

  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  const refreshedRunPanel = await openRunPanel(page);
  await expect(refreshedRunPanel).toContainText('Paused');
  await expect(refreshedRunPanel).toContainText('1 of 2 occupied');
  const afterRefresh = await readProjectSnapshot(harness, projectId);
  expect(afterRefresh.runs.at(-1)).toMatchObject({
    state: 'paused',
    pauseReason: 'operator_paused',
  });
  expect(itemStates(afterRefresh)).toEqual(itemStates(pausedWithOneActive));
  expect(afterRefresh.qaReports).toHaveLength(
    pausedWithOneActive.qaReports.length,
  );

  harness.releaseTaskOutcome('task-manual');
  await harness.waitForTaskOutcome('task-manual');
  const scriptedManualOutcome = await readProjectSnapshot(harness, projectId);
  const scriptedManualTask = scriptedManualOutcome.tasks.find(
    ({ title }) => title === 'task-manual',
  );
  expect({
    item: itemStates(scriptedManualOutcome).find(
      ({ title }) => title === 'task-manual',
    ),
    lifecycleState: scriptedManualTask?.lifecycleState,
    automation: scriptedManualTask?.reviewAutomation.status,
    projectReviewPolicy:
      scriptedManualOutcome.project.qaConfiguration.reviewPolicy,
  }).toMatchObject({
    item: { status: 'attention_required', reason: 'manual_review' },
    lifecycleState: 'review',
    automation: 'disabled',
    projectReviewPolicy: 'autonomous_review',
  });
  const beforeRestart = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => {
      const states = itemStates(snapshot);
      return (
        snapshot.runs.at(-1)?.state === 'paused' &&
        states.find(({ title }) => title === 'task-manual')?.status ===
          'attention_required' &&
        states.filter(({ status }) => status === 'active').length === 0
      );
    },
    'Manual review did not release paused capacity as attention-required',
  );
  const runId = beforeRestart.runs.at(-1)?.id;
  await harness.restart();
  await page.goto(harness.origin);
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(
    page.getByRole('region', { name: 'Finite project run board' }),
  ).toBeVisible();
  const afterRestart = await readProjectSnapshot(harness, projectId);
  expect(afterRestart.runs.at(-1)?.id).toBe(runId);
  expect(afterRestart.runs.at(-1)).toMatchObject({
    state: 'paused',
    pauseReason: 'operator_paused',
  });
  expect(itemStates(afterRestart)).toEqual(itemStates(beforeRestart));
  expect(afterRestart.developerCycles).toHaveLength(
    beforeRestart.developerCycles.length,
  );
  expect(afterRestart.qaReports).toHaveLength(beforeRestart.qaReports.length);
  const restartedRunPanel = await openRunPanel(page);
  await expect(restartedRunPanel).toContainText('0 of 2 occupied');

  await restartedRunPanel.getByRole('button', { name: 'Resume run' }).click();
  const blockedAfterResume = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      itemStates(snapshot).find(({ title }) => title === 'task-blocked')
        ?.status === 'attention_required',
    'Developer blocker did not become attention-required after resume',
  );
  const resumedRun = blockedAfterResume.runs.at(-1);
  if (!resumedRun) throw new Error('Expected resumed run');
  expect(resumedRun).toMatchObject({ state: 'running', pauseReason: null });
  const blockedTask = blockedAfterResume.tasks.find(
    ({ title }) => title === 'task-blocked',
  );
  if (!blockedTask) throw new Error('Expected the blocked task');
  const blockedRunItem = resumedRun.items.find(
    ({ taskId }) => taskId === blockedTask.id,
  );
  if (!blockedRunItem?.attemptId) {
    throw new Error('Expected the blocked run item attempt');
  }
  const blockedCycle = blockedAfterResume.developerCycles.find(
    ({ attemptId }) => attemptId === blockedRunItem.attemptId,
  );
  if (!blockedCycle) throw new Error('Expected the blocked Developer cycle');
  const durableBlocker = blockedAfterResume.developerBlockerReports.find(
    ({ id }) => id === blockedCycle.blockerReportId,
  );
  expect({
    item: itemStates(blockedAfterResume).find(
      ({ title }) => title === 'task-blocked',
    ),
    taskBlocker: blockedTask.blocked,
    cycle: blockedCycle,
    blocker: durableBlocker,
  }).toMatchObject({
    item: { status: 'attention_required', reason: 'developer_blocked' },
    taskBlocker: {
      reason: 'task-blocked encountered a deterministic blocker.',
    },
    cycle: {
      terminalDisposition: 'blocked',
      blockerReportId: durableBlocker?.id,
      endedAt: expect.any(String),
    },
    blocker: {
      cycleId: blockedCycle.id,
      reason: 'task-blocked encountered a deterministic blocker.',
      evidence: 'The fake dependency probe reported the scripted blocker.',
      attemptedWork: 'Inspected the temporary repository and retried once.',
      suggestedHumanAction: 'Resolve the scripted dependency before retrying.',
      preserveWorkspace: true,
    },
  });
  await expect
    .poll(() => harness.startedTaskTitles())
    .toEqual([
      'task-auto',
      'task-manual',
      'task-blocked',
      'task-later-auto',
      'task-later-manual',
    ]);
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => {
      const states = itemStates(snapshot);
      return (
        states.find(({ title }) => title === 'task-blocked')?.status ===
          'attention_required' &&
        states.find(({ title }) => title === 'task-later-auto')?.status ===
          'active' &&
        states.find(({ title }) => title === 'task-later-manual')?.status ===
          'active' &&
        states.find(({ title }) => title === 'task-not-started')?.status ===
          'queued'
      );
    },
    'Later queued work did not continue after the blocked outcome',
  );

  await restartedRunPanel.getByRole('button', { name: 'Stop run' }).click();
  await restartedRunPanel
    .getByRole('group', { name: 'Confirm stop' })
    .getByRole('button', { name: 'Confirm stop run' })
    .click();
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => {
      const states = itemStates(snapshot);
      return (
        snapshot.runs.at(-1)?.state === 'draining' &&
        states.find(({ title }) => title === 'task-not-started')?.status ===
          'not_started' &&
        states.filter(({ status }) => status === 'active').length === 2
      );
    },
    'Stop did not preserve active work while marking queued work not started',
  );
  expect(harness.startedTaskTitles()).not.toContain('task-not-started');

  harness.releaseTaskOutcome('task-later-auto');
  harness.releaseTaskOutcome('task-later-manual');
  await harness.drainTaskOutcomes();
  const completed = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.runs.at(-1)?.state === 'completed',
    'The stopped run did not drain to durable completion',
  );
  expect(completed.runs.at(-1)?.completionReason).toBe('stopped');
  expect(itemStates(completed).map(({ status }) => status)).toEqual([
    'completed',
    'attention_required',
    'attention_required',
    'completed',
    'attention_required',
    'not_started',
  ]);
  await expect(
    restartedRunPanel.getByRole('region', { name: 'Run history' }),
  ).toContainText('2 completed, 3 attention, 1 not started');
  expect(harness.apiBillingEnvironmentValues()).toEqual([undefined, undefined]);
});

test('plans and approves dependency-aware work with fake pm planning', async ({
  page,
  harness,
}) => {
  await importTemporaryRepository(page, harness, 'Dependency planning');
  const projectId = await page.getByLabel('Selected project').inputValue();
  await openPlanView(page);
  const planning = page.getByRole('region', { name: 'Project planning' });
  await expect(planning).toContainText(
    'The PM can read this repository but cannot edit files, change tasks, approve plans, or launch work.',
  );
  await expect(
    planning.getByLabel(
      'I understand planning consumes Claude subscription capacity.',
    ),
  ).toBeVisible();

  await startProjectPlanning(page, harness, 'Plan dependency-aware delivery');
  expect(harness.pmRuntimeConfigurations()).toEqual([
    {
      source: 'create',
      role: 'pm',
      availableTools: [],
      allowedTools: [
        'mcp__mesh_pm__read_workspace_file',
        'mcp__mesh_pm__glob_workspace_files',
        'mcp__mesh_pm__search_workspace_text',
        'mcp__mesh_pm__submit_project_plan',
      ],
      request: {
        title: 'Planning: Dependency planning',
        workspacePath: harness.repositoryPath,
        permissionMode: 'safe_auto',
      },
    },
  ]);

  await harness.submitProjectPlan(planningProposal('Foundation draft'));
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.activePlan?.status === 'awaiting_review' &&
      snapshot.activePlan.latestProposalOrdinal === 1,
    'The first structured PM proposal did not become reviewable',
  );
  let review = await reviewCurrentProposal(page);
  await expect(
    review.getByRole('list', { name: 'Proposed tasks' }),
  ).toContainText('Foundation draft');
  await review
    .getByLabel('Revision feedback')
    .fill('Use the refreshed board base and clarify the foundation contract.');
  await review.getByRole('button', { name: 'Request changes' }).click();
  await harness.waitForResumed(1);
  await expect.poll(() => harness.pmRuntimeConfigurations().length).toBe(2);
  const revisedRuntime = harness.pmRuntimeConfigurations().at(-1);
  expect(revisedRuntime).toEqual({
    source: 'resume',
    role: 'pm',
    availableTools: [],
    allowedTools: [
      'mcp__mesh_pm__read_workspace_file',
      'mcp__mesh_pm__glob_workspace_files',
      'mcp__mesh_pm__search_workspace_text',
      'mcp__mesh_pm__submit_project_plan',
    ],
    request: {
      claudeResumeId: 'fake-resume-1',
      workspacePath: harness.repositoryPath,
      permissionMode: 'safe_auto',
    },
  });
  expect(revisedRuntime?.availableTools).not.toEqual(
    expect.arrayContaining(['Bash', 'Write', 'Edit', 'NotebookEdit']),
  );
  expect(revisedRuntime?.allowedTools).not.toEqual(
    expect.arrayContaining(['Bash', 'Write', 'Edit', 'NotebookEdit']),
  );

  await harness.submitProjectPlan(planningProposal());
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.activePlan?.status === 'awaiting_review' &&
      snapshot.activePlan.latestProposalOrdinal === 2,
    'The revised structured PM proposal did not become reviewable',
  );
  review = page.getByRole('region', { name: 'Project planning' });
  await review.getByRole('button', { name: 'Refresh proposal' }).click();
  await expect(
    review.getByRole('heading', { name: 'Revision 2' }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Approve plan' }).click();

  const approved = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.terminalPlanSummaries.some(
        ({ status }) => status === 'approved',
      ) &&
      snapshot.tasks.length === 2 &&
      snapshot.dependencies.length === 1,
    'Approved planning truth did not create two tasks and one dependency',
  );
  expect(approved.tasks.map(({ lifecycleState }) => lifecycleState)).toEqual([
    'backlog',
    'backlog',
  ]);
  const foundation = approved.tasks.find(
    ({ title }) => title === 'Foundation contract',
  );
  const feature = approved.tasks.find(
    ({ title }) => title === 'Feature delivery',
  );
  expect(approved.dependencies).toEqual([
    expect.objectContaining({
      taskId: feature?.id,
      prerequisiteTaskId: foundation?.id,
    }),
  ]);

  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  const backlog = page.getByRole('region', { name: 'Backlog tasks' });
  await expect(
    backlog.getByRole('article', { name: 'Foundation contract task card' }),
  ).toBeVisible();
  await expect(
    backlog.getByRole('article', { name: 'Feature delivery task card' }),
  ).toContainText('1 unmet prerequisite');
  let openFeature = page.getByRole('button', {
    name: 'Open Feature delivery',
  });
  await openFeature.focus();
  await openFeature.press('Enter');
  let featureDialog = page.getByRole('dialog', { name: 'Feature delivery' });
  await expect(
    featureDialog.getByRole('list', { name: 'Prerequisites' }),
  ).toContainText('Foundation contract');
  await expect(
    featureDialog.getByRole('button', { name: 'Move to ready' }),
  ).toBeDisabled();

  await featureDialog.getByRole('button', { name: 'Close' }).click();
  for (const lifecycleState of [
    'ready',
    'in_progress',
    'review',
    'done',
  ] as const) {
    await page
      .getByLabel('Move Foundation contract to')
      .selectOption(lifecycleState);
    await waitForProjectSnapshot(
      harness,
      projectId,
      (snapshot) =>
        snapshot.tasks.some(
          ({ title, lifecycleState: currentState }) =>
            title === 'Foundation contract' && currentState === lifecycleState,
        ),
      `The prerequisite task did not move to ${lifecycleState}`,
    );
  }
  await page.reload();
  await page.getByRole('button', { name: 'Board' }).click();
  openFeature = page.getByRole('button', { name: 'Open Feature delivery' });
  await openFeature.focus();
  await openFeature.press('Enter');
  featureDialog = page.getByRole('dialog', { name: 'Feature delivery' });
  const moveToReady = featureDialog.getByRole('button', {
    name: 'Move to ready',
  });
  await expect(moveToReady).toBeEnabled();
  await moveToReady.click();
  await expect(
    featureDialog.getByRole('region', { name: 'Task lifecycle' }),
  ).toContainText('ready');
  await featureDialog.getByRole('button', { name: 'Close' }).click();

  const runPanel = await openRunPanel(page);
  await runPanel.getByRole('button', { name: 'Start run' }).click();
  const preview = runPanel.getByRole('list', { name: 'Eligible run order' });
  await expect(preview.getByRole('listitem')).toHaveCount(1);
  await expect(preview).toContainText('Feature delivery');
  await expect(preview).not.toContainText('Foundation contract');
});

test('pm planning rejects stale approval without proposal rows', async ({
  page,
  harness,
}) => {
  await importTemporaryRepository(page, harness, 'Stale planning');
  const projectId = await page.getByLabel('Selected project').inputValue();
  await startProjectPlanning(page, harness, 'Plan against current board');
  await harness.submitProjectPlan(planningProposal());
  await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.activePlan?.status === 'awaiting_review',
    'The stale-test proposal did not become reviewable',
  );

  await openBoardView(page);
  const addTask = page.getByRole('button', { name: 'Add task' });
  await addTask.focus();
  await addTask.press('Enter');
  const createDialog = page.getByRole('dialog', { name: 'Create task' });
  await createDialog.getByLabel('Task title').fill('Canonical board edit');
  await createDialog.getByRole('button', { name: 'Create task' }).click();
  const edited = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.tasks.some(({ title }) => title === 'Canonical board edit'),
    'The canonical board edit was not persisted',
  );
  const addedTaskId = edited.tasks.find(
    ({ title }) => title === 'Canonical board edit',
  )?.id;
  if (!addedTaskId) throw new Error('The canonical board task ID was missing');

  const planning = await reviewCurrentProposal(page);
  await planning.getByRole('button', { name: 'Approve plan' }).click();
  await expect(
    planning
      .getByRole('alert')
      .filter({ hasText: /task or policy base changed/i }),
  ).toBeVisible();
  const evidence = planning
    .getByRole('alert')
    .filter({ hasText: /task board changed after this plan was prepared/i });
  await expect(evidence).toContainText('Added tasks: 1 total.');
  await expect(evidence).toContainText(addedTaskId);
  const stale = await readProjectSnapshot(harness, projectId);
  expect(stale.activePlan?.status).toBe('awaiting_review');
  expect(stale.tasks.map(({ title }) => title)).toEqual([
    'Canonical board edit',
  ]);
  expect(stale.dependencies).toEqual([]);
});

test('pm planning awaiting review survives restart without a live pm', async ({
  page,
  harness,
}) => {
  await importTemporaryRepository(page, harness, 'Review restart');
  const projectId = await page.getByLabel('Selected project').inputValue();
  await startProjectPlanning(page, harness, 'Preserve review across restart');
  await harness.submitProjectPlan(planningProposal());
  const beforeRestart = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.activePlan?.status === 'awaiting_review',
    'The review proposal was not durable before restart',
  );
  const sessionId = beforeRestart.activePlan?.currentSessionId;
  if (!sessionId) throw new Error('Expected the PM planning session');
  const driverCountsBeforeRestart = fakeDriverRequestCounts(harness);

  await harness.restart({ recoverSessionId: sessionId });
  await page.goto(harness.origin);
  await openPlanView(page);
  const afterRestart = await readProjectSnapshot(harness, projectId);
  expect(afterRestart.activePlan).toMatchObject({
    id: beforeRestart.activePlan?.id,
    status: 'awaiting_review',
    latestProposalOrdinal: 1,
  });
  await expect(
    page.getByRole('region', { name: 'Project planning' }),
  ).toContainText('Proposal ready for review');
  expect(fakeDriverRequestCounts(harness)).toEqual(driverCountsBeforeRestart);
});

test('pm planning marks a formerly live runtime for attention', async ({
  page,
  harness,
}) => {
  await importTemporaryRepository(page, harness, 'Planning recovery');
  const projectId = await page.getByLabel('Selected project').inputValue();
  await startProjectPlanning(page, harness, 'Recover interrupted planning');
  const planning = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) => snapshot.activePlan?.status === 'planning',
    'The live PM plan did not start',
  );
  const sessionId = planning.activePlan?.currentSessionId;
  if (!sessionId) throw new Error('Expected the live PM session');

  await harness.restart({ recoverSessionId: sessionId });
  await page.goto(harness.origin);
  await openPlanView(page);
  const recovered = await readProjectSnapshot(harness, projectId);
  expect(recovered.activePlan).toMatchObject({
    id: planning.activePlan?.id,
    status: 'attention_required',
  });
  const panel = page.getByRole('region', { name: 'Project planning' });
  await expect(panel).toContainText('Planning needs attention');
  await expect(
    panel.getByRole('button', { name: 'Resume planning' }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Retry planning' }),
  ).toBeVisible();
});

test('pm planning cancel revokes submission before interrupt', async ({
  page,
  harness,
}) => {
  await importTemporaryRepository(page, harness, 'Cancel planning');
  const projectId = await page.getByLabel('Selected project').inputValue();
  const panel = await startProjectPlanning(
    page,
    harness,
    'Cancel without preserving PM authority',
  );
  const submissionAtInterrupt =
    harness.submitProjectPlanOnInterrupt(planningProposal());
  await panel
    .getByLabel('Cancellation reason')
    .fill('The operator no longer wants this plan.');
  await panel.getByRole('button', { name: 'Cancel planning' }).click();

  await expect(submissionAtInterrupt).resolves.toEqual({
    accepted: false,
    code: 'planning_capability_invalid',
  });
  await expect.poll(() => harness.latestPmSessionInterrupted()).toBe(true);
  const cancelled = await waitForProjectSnapshot(
    harness,
    projectId,
    (snapshot) =>
      snapshot.activePlan === null &&
      snapshot.terminalPlanSummaries.some(
        ({ status }) => status === 'cancelled',
      ),
    'Cancellation did not become durable',
  );
  expect(cancelled.tasks).toEqual([]);
  expect(cancelled.dependencies).toEqual([]);
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
