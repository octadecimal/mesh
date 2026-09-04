import { access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';

import {
  expect,
  test,
  type Locator,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';

import { V2ProcessFixture } from './fixtures/v2-process.js';

const contiguousAfter = (before: number, after: number) =>
  Array.from({ length: after - before }, (_, index) => before + index + 1);

const pmProfileYaml = `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: project-manager
  displayName: Project manager
  scope: global
spec:
  assignmentKinds:
    - pm_discovery
  preferredRuntime:
    harness: fake
    model: deterministic
  alternatives: []
  requiredCapabilities:
    - execution.stream
  skills:
    preferred: []
    required: []
  instructions: |
    Clarify intent and propose the complete approved ledger.
  outputSchema: mesh.dev/pm-discovery-report/v1
`;

const pmPlanProfileYaml = `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: todo-plan-manager
  displayName: Todo plan manager
  scope: project
spec:
  assignmentKinds:
    - pm_plan
  preferredRuntime:
    harness: fake
    model: deterministic
  alternatives: []
  requiredCapabilities:
    - execution.stream
  skills:
    preferred: []
    required: []
  instructions: |
    Propose the complete Todo delivery plan for explicit human approval.
  outputSchema: mesh.dev/pm-plan-report/v1
`;

const developerProfileYaml = `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: todo-developer
  displayName: Todo developer
  scope: project
spec:
  assignmentKinds:
    - developer_task
  preferredRuntime:
    harness: fake
    model: deterministic
  alternatives: []
  requiredCapabilities:
    - execution.stream
  skills:
    preferred: []
    required: []
  instructions: |
    Implement the exact frozen task and return structured evidence.
  outputSchema: mesh.dev/developer-report/v1
`;

const sendCommand = (page: Page, command: unknown) =>
  page.evaluate(async (commandBody) => {
    const response = await fetch('/api/v2/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        actor: { kind: 'human' },
        command: commandBody,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, command);

const controlAppSubscription = async (page: Page) => {
  let pending = false;
  let projectId: string | undefined;
  let held: { upstream: WebSocketRoute; message: string | Buffer } | undefined;
  let resync: unknown;

  const parsedMessage = (message: string | Buffer) => {
    try {
      return JSON.parse(String(message)) as {
        type?: string;
        projectId?: string;
        reason?: string;
      };
    } catch {
      return undefined;
    }
  };

  await page.routeWebSocket(/\/api\/v2\/realtime$/u, (route) => {
    const upstream = route.connectToServer();
    route.onMessage((message) => {
      const parsed = parsedMessage(message);
      if (
        pending &&
        parsed?.type === 'v2.subscribe' &&
        parsed.projectId === projectId
      ) {
        pending = false;
        held = { upstream, message };
        return;
      }
      upstream.send(message);
    });
    upstream.onMessage((message) => {
      const parsed = parsedMessage(message);
      if (
        parsed?.type === 'v2.resync_required' &&
        parsed.projectId === projectId
      ) {
        resync = parsed;
      }
      route.send(message);
    });
    route.onClose(() => upstream.close());
    upstream.onClose(() => route.close());
  });

  return {
    holdNext(targetProjectId: string) {
      projectId = targetProjectId;
      pending = true;
    },
    async waitUntilHeld() {
      await expect.poll(() => held !== undefined).toBe(true);
    },
    release() {
      if (!held) throw new Error('The App subscription was not held');
      held.upstream.send(held.message);
    },
    async waitForResync() {
      await expect
        .poll(() => resync)
        .toMatchObject({
          type: 'v2.resync_required',
          projectId,
          reason: 'retained_gap',
        });
      return resync;
    },
  };
};

const registerTodo = async (
  page: Page,
  fixture: V2ProcessFixture,
  start: { holdAfterAdapterCursor?: number } = {},
) => {
  await fixture.start(start);
  await page.goto(`${fixture.origin}/projects`);
  await page.getByLabel('Repository path').fill(fixture.todoRepository);
  await page.getByRole('button', { name: 'Add and select project' }).click();
  await fixture.waitForBrowserRegistration();
};

const approveTodoIntent = async (page: Page, fixture: V2ProcessFixture) => {
  const profile = await sendCommand(page, {
    type: 'worker_profile.approve_revision',
    scope: 'global',
    expectedLatestRevision: 0,
    sourceYaml: pmProfileYaml,
  });
  expect(profile).toMatchObject({ status: 200, body: { ok: true } });
  await page.reload();

  await page.getByRole('button', { name: 'Project manager' }).click();
  await page
    .getByRole('textbox', { name: 'Message to project manager' })
    .fill('Build a Todo app where people can add and complete items.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect
    .poll(
      async () =>
        (await fixture.projectSnapshot()).planningCycles.find(
          ({ purpose }) => purpose.kind === 'intent',
        )?.questions.length,
    )
    .toBe(2);
  await page.reload();
  await page.getByRole('button', { name: 'Project manager' }).click();
  await expect(
    page.getByRole('heading', { name: 'How should Todo items persist?' }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Message to project manager' })
    .fill(
      'Use local browser storage, and yes, every control must be keyboard operable.',
    );
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect
    .poll(
      async () =>
        (await fixture.projectSnapshot()).planningCycles.find(
          ({ purpose }) => purpose.kind === 'intent',
        )?.proposals.length,
    )
    .toBe(1);
  await page.reload();
  await page.getByRole('tab', { name: 'Plans' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Proposal revision 1 · awaiting_approval',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Approve proposal' }).click();
  await expect
    .poll(
      async () =>
        (await fixture.projectSnapshot()).intentLedger?.ledger.revision,
    )
    .toBe(1);
  return fixture.projectSnapshot();
};

const approveTodoDeliveryPlan = async (
  page: Page,
  fixture: V2ProcessFixture,
  approve = true,
) => {
  const intent = await fixture.projectSnapshot();
  const profile = await sendCommand(page, {
    type: 'worker_profile.approve_revision',
    scope: 'project',
    projectId: fixture.projectId,
    expectedLatestRevision: 0,
    sourceYaml: pmPlanProfileYaml,
  });
  expect(profile).toMatchObject({
    status: 200,
    body: {
      ok: true,
      commandType: 'worker_profile.approve_revision',
      profileRevision: { revision: 1, scope: 'project' },
    },
  });
  await page.reload();

  await page.getByRole('button', { name: 'Project manager' }).click();
  const planning = page.getByRole('dialog', {
    name: /Project manager ·/u,
  });
  await planning.getByRole('tab', { name: 'Delivery Plan' }).click();
  await planning.getByRole('button', { name: 'Plan delivery' }).click();
  const profileSelector = planning.getByLabel('Project manager profile').last();
  await expect(profileSelector).toContainText('Todo plan manager · revision 1');
  await expect(profileSelector).not.toContainText(
    'Project manager · revision 1',
  );
  await planning
    .getByRole('textbox', { name: 'Message to project manager' })
    .last()
    .fill(
      'Propose a delivery plan for the approved intent and requirement ledger.',
    );
  await planning.getByRole('button', { name: 'Send message' }).last().click();

  await expect
    .poll(
      async () =>
        (await fixture.projectSnapshot()).planningCycles.find(
          ({ purpose }) => purpose.kind === 'delivery_plan',
        )?.deliveryPlanProposals.length,
    )
    .toBe(1);
  await page.reload();

  await expect(
    page.getByRole('heading', {
      name: 'Proposal revision 1 · awaiting approval',
    }),
  ).toBeVisible();
  const proposed = await fixture.projectSnapshot();
  const planCycle = proposed.planningCycles.find(
    ({ purpose }) => purpose.kind === 'delivery_plan',
  );
  expect(planCycle?.purpose).toMatchObject({
    kind: 'delivery_plan',
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  });
  expect(planCycle?.cycle).toMatchObject({
    baseProjectIntentRevision: 1,
    baseLedgerRevision: 1,
  });
  const planningExecution = proposed.executions.find(
    ({ id }) => id === planCycle?.turns.at(-1)?.executionId,
  );
  expect(planningExecution?.assignment).toMatchObject({
    kind: 'pm_plan',
    baseProjectIntentId: intent.intentLedger?.projectIntent.id,
    baseProjectIntentRevision: 1,
    baseLedgerId: intent.intentLedger?.ledger.id,
    baseLedgerRevision: 1,
    baseDeliveryPlanId: null,
    baseDeliveryPlanRevision: null,
  });
  expect(proposed.deliveryPlan).toBeNull();
  expect(proposed.board.cards).toEqual([]);

  await page.getByRole('button', { name: 'Request revision' }).click();
  const revisionPlanning = page.getByRole('dialog', {
    name: /Project manager ·/u,
  });
  await revisionPlanning
    .getByRole('textbox', { name: 'Message to project manager' })
    .last()
    .fill(
      'Make keyboard acceptance explicit and persistence verification isolated.',
    );
  await revisionPlanning.getByRole('button', { name: 'Send message' }).click();
  await expect
    .poll(
      async () =>
        (await fixture.projectSnapshot()).planningCycles.find(
          ({ purpose }) => purpose.kind === 'delivery_plan',
        )?.deliveryPlanProposals.length,
    )
    .toBe(2);
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'Proposal revision 2 · awaiting approval',
    }),
  ).toBeVisible();
  const proposalRevision = page.getByLabel('Proposal revision', {
    exact: true,
  });
  await proposalRevision.selectOption('1');
  await expect(
    page.getByRole('heading', { name: 'Proposal revision 1 · superseded' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'A keyboard user can add and complete a Todo item without a pointer.',
    ),
  ).toHaveCount(0);
  await proposalRevision.selectOption('2');
  await expect(
    page.getByText(
      'A keyboard user can add and complete a Todo item without a pointer.',
    ),
  ).toBeVisible();

  const beforeApproval = await fixture.projectSnapshot();
  expect(beforeApproval.deliveryPlan).toBeNull();
  expect(beforeApproval.board.cards).toEqual([]);
  if (!approve) return beforeApproval;
  const approvalResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v2/commands') &&
      response.request().postData()?.includes('plan_proposal.approve') === true,
  );
  await page.getByRole('button', { name: 'Approve full plan' }).click();
  const approval = await (await approvalResponse).json();
  expect(approval).toMatchObject({
    ok: true,
    schemaVersion: 2,
    commandType: 'plan_proposal.approve',
    deliveryPlan: { plan: { revision: 1 } },
    board: { totalTaskCount: 3, matchedTaskCount: 3 },
  });
  await expect
    .poll(
      async () => (await fixture.projectSnapshot()).deliveryPlan?.plan.revision,
    )
    .toBe(1);
  return fixture.projectSnapshot();
};

const approveDeveloperProfile = async (
  page: Page,
  fixture: V2ProcessFixture,
) => {
  const response = await sendCommand(page, {
    type: 'worker_profile.approve_revision',
    scope: 'project',
    projectId: fixture.projectId,
    expectedLatestRevision: 0,
    sourceYaml: developerProfileYaml,
  });
  expect(response).toMatchObject({
    status: 200,
    body: {
      ok: true,
      commandType: 'worker_profile.approve_revision',
      profileRevision: { revision: 1, scope: 'project' },
    },
  });
  await page.reload();
};

const startTodoRun = async (
  page: Page,
  fixture: V2ProcessFixture,
  titles: readonly string[],
  concurrencyLimit: number,
) => {
  const snapshot = await fixture.projectSnapshot();
  const plan = snapshot.deliveryPlan?.plan;
  const filter = snapshot.board.filter;
  const profile = snapshot.profiles.find(({ document }) =>
    document.spec.assignmentKinds.some((kind) => kind === 'developer_task'),
  );
  const cards = titles.map((title) =>
    snapshot.board.cards.find((card) => card.title === title),
  );
  if (!plan || !filter || !profile || cards.some((card) => !card)) {
    throw new Error('Finite Todo run authority is unavailable');
  }
  const response = await sendCommand(page, {
    type: 'execution_run.start',
    projectId: fixture.projectId,
    expectedDeliveryPlanId: plan.id,
    expectedDeliveryPlanRevision: plan.revision,
    expectedBoardFilterRevision: filter.revision,
    selections: cards.map((card) => ({
      taskId: card!.taskId,
      expectedTaskRevision: card!.taskCurrentRevision,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
    })),
    concurrencyLimit,
    subscriptionCapacityConfirmed: true,
  });
  expect(response).toMatchObject({
    status: 200,
    body: { ok: true, commandType: 'execution_run.start' },
  });
  return { snapshot, cards: cards.map((card) => card!), response };
};

const controlTodoRun = async (
  page: Page,
  fixture: V2ProcessFixture,
  type: 'execution_run.pause' | 'execution_run.resume' | 'execution_run.stop',
) => {
  const snapshot = await fixture.projectSnapshot();
  const current = snapshot.executionRuns?.find(
    ({ run }) => run.lifecycle !== 'completed',
  );
  if (!current) throw new Error('Current finite Todo run was not found');
  const response = await sendCommand(page, {
    type,
    projectId: fixture.projectId,
    runId: current.run.id,
    expectedRunRevision: current.run.revision,
  });
  expect(response).toMatchObject({ status: 200, body: { ok: true } });
  return response;
};

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

test('attention-first UI routes Inbox decisions to canonical Plans approval', async ({
  page,
}) => {
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
  });
  const approvalCommands: string[] = [];
  const recordApprovalCommand = (request: { postData(): string | null }) => {
    const body = request.postData();
    if (body?.includes('plan_proposal.approve')) approvalCommands.push(body);
  };
  page.on('request', recordApprovalCommand);
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture, false);

    await page.goto(`${fixture.origin}/`);
    await expect(
      page.getByRole('heading', { name: 'Needs attention' }),
    ).toBeVisible();
    await expect(approvalCommands).toHaveLength(0);

    await page.getByRole('link', { name: 'Review in project' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${fixture.projectId}/plans$`, 'u'),
    );
    const approve = page.getByRole('button', { name: 'Approve full plan' });
    await expect(approve).toBeVisible();
    await expect(approvalCommands).toHaveLength(0);

    const approvalResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v2/commands') &&
        response.request().postData()?.includes('plan_proposal.approve') ===
          true,
    );
    await approve.click();
    await expect(await (await approvalResponse).json()).toMatchObject({
      ok: true,
      commandType: 'plan_proposal.approve',
    });
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).deliveryPlan?.plan.revision,
      )
      .toBe(1);
    expect(approvalCommands).toHaveLength(1);
  } finally {
    page.off('request', recordApprovalCommand);
    await fixture.dispose();
  }
});

test('attention-first UI opens active runs with replay and live completion', async ({
  page,
}) => {
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
    fakeDeveloperScenario: 'completed',
    fakeDeveloperHolds: true,
  });
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await approveDeveloperProfile(page, fixture);
    const { cards } = await startTodoRun(
      page,
      fixture,
      ['Build Todo controls'],
      1,
    );
    const [card] = cards;
    await expect
      .poll(async () => {
        const snapshot = await fixture.projectSnapshot();
        return snapshot.executions.find(
          ({ assignment }) =>
            assignment.kind === 'developer_task' &&
            assignment.taskId === card.taskId,
        )?.lifecycle;
      })
      .toBe('running');
    const active = await fixture.projectSnapshot();
    const execution = active.executions.find(
      ({ assignment }) =>
        assignment.kind === 'developer_task' &&
        assignment.taskId === card.taskId,
    );
    if (!execution) throw new Error('Active Todo execution was not found');

    await page.goto(`${fixture.origin}/runs`);
    const activeRuns = page.getByRole('list', { name: 'Active runs' });
    const run = activeRuns.getByRole('link').filter({
      hasText: 'Build Todo controls',
    });
    await expect(run).toContainText('todo-repository');
    await expect(run).toContainText('Build Todo controls');
    await run.click();
    const details = page.getByRole('region', { name: 'Run details' });
    await details.getByRole('link', { name: 'Open run in project' }).click();

    await expect(page).toHaveURL(
      new RegExp(
        `/projects/${fixture.projectId}/runs\\?run=${execution.id}$`,
        'u',
      ),
    );
    await expect(
      page.getByRole('list', {
        name: 'Runtime activity for Build Todo controls',
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        `Domain cursor ${active.cursors.domain}; runtime cursor ${active.cursors.runtime}`,
      ),
    ).toBeVisible();

    await fixture.releaseDeveloperTask(card.taskId);
    await expect
      .poll(async () => {
        const current = page.getByRole('region', { name: 'Run details' });
        return current.getByText('Completed', { exact: true }).isVisible();
      })
      .toBe(true);
  } finally {
    await fixture.dispose();
  }
});

test('attention-first UI preserves project PM drafts and the chosen theme', async ({
  page,
}) => {
  const fixture = await V2ProcessFixture.createTodo();
  try {
    await registerTodo(page, fixture);
    const profile = await sendCommand(page, {
      type: 'worker_profile.approve_revision',
      scope: 'global',
      expectedLatestRevision: 0,
      sourceYaml: pmProfileYaml,
    });
    expect(profile).toMatchObject({ status: 200, body: { ok: true } });
    await page.reload();

    await page.getByRole('link', { name: 'Projects' }).focus();
    await page.keyboard.press('Shift+Tab');
    const focusedRailLink = page.locator('.v2-global-nav a:focus-visible');
    await expect(focusedRailLink).toHaveCount(1);
    const lightThemeContrast = await focusedRailLink.evaluate((link) => {
      const parseColor = (color: string): [number, number, number] => {
        const value = color.trim();
        if (/^#[0-9a-f]{3}$/iu.test(value)) {
          return [1, 2, 3].map((index) =>
            Number.parseInt(value[index] + value[index], 16),
          ) as [number, number, number];
        }
        if (/^#[0-9a-f]{6}$/iu.test(value)) {
          return [1, 3, 5].map((start) =>
            Number.parseInt(value.slice(start, start + 2), 16),
          ) as [number, number, number];
        }
        const values = value
          .match(/[\d.]+/gu)
          ?.slice(0, 3)
          .map(Number);
        if (values?.length === 3) {
          return values as [number, number, number];
        }
        throw new Error(`Unsupported color value: ${JSON.stringify(color)}`);
      };
      const luminance = (color: string) => {
        const [red, green, blue] = parseColor(color).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return red * 0.2126 + green * 0.7152 + blue * 0.0722;
      };
      const contrast = (first: string, second: string) => {
        const [lighter, darker] = [luminance(first), luminance(second)].sort(
          (left, right) => right - left,
        );
        return (lighter + 0.05) / (darker + 0.05);
      };
      const root = getComputedStyle(document.documentElement);
      const rail = link.closest<HTMLElement>('.v2-global-nav');
      if (!rail)
        throw new Error('Focused link is outside the navigation rail.');

      return {
        warning: contrast(
          root.getPropertyValue('--warning'),
          root.getPropertyValue('--surface'),
        ),
        railFocus: contrast(
          getComputedStyle(link).outlineColor,
          getComputedStyle(rail).backgroundColor,
        ),
      };
    });
    expect(lightThemeContrast.railFocus).toBeGreaterThanOrEqual(3);
    expect(lightThemeContrast.warning).toBeGreaterThanOrEqual(4.5);

    await page.getByRole('button', { name: 'Project manager' }).click();
    const dialog = page.getByRole('dialog', {
      name: /Project manager · todo-repository/u,
    });
    await dialog.getByRole('button', { name: 'Pin project manager' }).click();
    const drawer = page.getByRole('complementary', {
      name: /Project manager · todo-repository/u,
    });
    const projectContent = page.locator('.v2-project-content');
    const openDrawerBox = await drawer.boundingBox();
    const openContentBox = await projectContent.boundingBox();
    expect(openDrawerBox).not.toBeNull();
    expect(openContentBox).not.toBeNull();
    expect(openDrawerBox?.x).toBeGreaterThan(openContentBox?.x ?? 0);

    await drawer.getByRole('button', { name: 'Close project manager' }).click();
    const closedContentBox = await projectContent.boundingBox();
    expect(closedContentBox).not.toBeNull();
    expect(closedContentBox?.width ?? 0).toBeGreaterThan(
      (openContentBox?.width ?? 0) + 100,
    );
    await page.getByRole('button', { name: 'Project manager' }).click();

    const draft = 'Keep this unsent Intent draft with the project.';
    await drawer
      .getByRole('textbox', { name: 'Message to project manager' })
      .fill(draft);

    await page.getByRole('tab', { name: 'Board' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${fixture.projectId}/board$`, 'u'),
    );
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole('textbox', { name: 'Message to project manager' }),
    ).toHaveValue(draft);

    await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
    await page.getByRole('link', { name: 'Inbox' }).click();
    await expect(
      page.getByRole('heading', { name: 'Needs attention' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Project manager' }),
    ).toHaveCount(0);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('dark');
  } finally {
    await fixture.dispose();
  }
});

test('attention-first UI keeps project controls keyboard reachable at 320px and separately proves 200% visual page scale', async ({
  page,
}) => {
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
  });
  const zoomSession = await page.context().newCDPSession(page);
  try {
    await page.setViewportSize({ width: 320, height: 720 });
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture, false);
    await page.reload();
    // Stress platform font-metric differences without changing the viewport.
    await page.addStyleTag({
      content: '.v2-global-nav { letter-spacing: 0.08em; }',
    });

    const reachByTab = async ({
      from,
      to,
      key = 'Tab',
    }: {
      from: Locator;
      to: Locator;
      key?: 'Tab' | 'Shift+Tab';
    }) => {
      await expect(from).toBeFocused();
      for (let press = 0; press < 32; press += 1) {
        await page.keyboard.press(key);
        if (await to.evaluate((element) => element === document.activeElement))
          return;
      }
      throw new Error(`Control was not reachable with ${key}`);
    };

    expect(await page.evaluate(() => window.innerWidth)).toBe(320);
    const keyboardOrigin = page.locator('body');
    await expect(keyboardOrigin).toBeFocused();
    const repositoryPath = page.getByText(fixture.todoRepository, {
      exact: true,
    });
    const connectionState = page
      .locator('.v2-project-metadata')
      .locator('[role="status"]');
    await expect(repositoryPath).toBeVisible();
    await expect(connectionState).toHaveText('Connected');
    const pathBounds = await repositoryPath.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    const connectionBounds = await connectionState.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
      };
    });
    expect(pathBounds.left).toBeGreaterThanOrEqual(0);
    expect(pathBounds.right).toBeLessThanOrEqual(pathBounds.viewportWidth);
    expect(
      pathBounds.right <= connectionBounds.left ||
        connectionBounds.right <= pathBounds.left ||
        pathBounds.bottom <= connectionBounds.top ||
        connectionBounds.bottom <= pathBounds.top,
    ).toBe(true);
    expect(
      await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    ).toEqual({ clientWidth: 320, scrollWidth: 320 });

    const projectTabs = page.getByRole('tablist', {
      name: 'Project artifacts',
    });
    const overviewTab = projectTabs.getByRole('tab', { name: 'Overview' });
    const plansTab = projectTabs.getByRole('tab', { name: 'Plans' });
    const runsTab = projectTabs.getByRole('tab', { name: 'Runs' });
    await reachByTab({ from: keyboardOrigin, to: plansTab });
    await page.keyboard.press('End');
    await expect(runsTab).toBeFocused();
    const focusedTabBounds = await projectTabs.evaluate((tablist) => {
      const listBounds = tablist.getBoundingClientRect();
      const selected = tablist.querySelector<HTMLElement>(
        '[aria-selected=true]',
      );
      const selectedBounds = selected?.getBoundingClientRect();
      return {
        listLeft: listBounds.left,
        listRight: listBounds.right,
        selectedLeft: selectedBounds?.left,
        selectedRight: selectedBounds?.right,
        scrollable: tablist.scrollWidth > tablist.clientWidth,
      };
    });
    expect(focusedTabBounds.scrollable).toBe(true);
    expect(focusedTabBounds.selectedLeft).toBeGreaterThanOrEqual(
      focusedTabBounds.listLeft,
    );
    expect(focusedTabBounds.selectedRight).toBeLessThanOrEqual(
      focusedTabBounds.listRight,
    );
    await expect(page).toHaveURL(
      new RegExp(`/projects/${fixture.projectId}/runs$`, 'u'),
    );
    await page.keyboard.press('Home');
    await expect(overviewTab).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(plansTab).toBeFocused();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${fixture.projectId}/plans$`, 'u'),
    );
    await expect(repositoryPath).toBeVisible();

    const projectManager = page.getByRole('button', {
      name: 'Project manager',
    });
    await page.keyboard.press('Shift+Tab');
    await expect(projectManager).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('dialog', {
        name: /Project manager · todo-repository/u,
      }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(projectManager).toBeFocused();

    const approve = page.getByRole('button', { name: 'Approve full plan' });
    await reachByTab({ from: projectManager, to: approve });
    await page.keyboard.press('Enter');
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).deliveryPlan?.plan.revision,
      )
      .toBe(1);

    await page.reload();
    expect(await page.evaluate(() => window.innerWidth)).toBe(320);
    await reachByTab({ from: page.locator('body'), to: plansTab });
    await page.keyboard.press('ArrowRight');
    const boardTab = projectTabs.getByRole('tab', { name: 'Board' });
    await expect(boardTab).toBeFocused();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${fixture.projectId}/board$`, 'u'),
    );
    const openTask = page.getByRole('button', {
      name: 'Open Build Todo controls',
    });
    await reachByTab({ from: boardTab, to: openTask });
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('region', { name: 'Task details' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Build Todo controls',
        level: 3,
      }),
    ).toBeFocused();

    expect(await page.evaluate(() => window.innerWidth)).toBe(320);
    await page.setViewportSize({ width: 640, height: 720 });
    expect(await page.evaluate(() => window.innerWidth)).toBe(640);
    await zoomSession.send('Emulation.setPageScaleFactor', {
      pageScaleFactor: 2,
    });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          scale: window.visualViewport?.scale,
          width: window.visualViewport?.width,
        })),
      )
      .toEqual({ scale: 2, width: 320 });
  } finally {
    await zoomSession.send('Emulation.setPageScaleFactor', {
      pageScaleFactor: 1,
    });
    await zoomSession.detach();
    await fixture.dispose();
  }
});

test('attention-first UI keeps healthy Inbox attention beside a named partial failure', async ({
  page,
}) => {
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
  });
  const unavailableProjectId = '00000000-0000-4000-8000-000000000503';
  const unavailableProjectName = 'Unavailable checkout';
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture, false);

    await page.route(`${fixture.origin}/api/v2/snapshot`, async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as {
        projects: Array<Record<string, unknown>>;
      };
      const healthyProject = snapshot.projects[0];
      if (!healthyProject)
        throw new Error('Registered project is missing from system snapshot');
      await route.fulfill({
        response,
        json: {
          ...snapshot,
          projects: [
            healthyProject,
            {
              ...healthyProject,
              id: unavailableProjectId,
              displayName: unavailableProjectName,
            },
          ],
        },
      });
    });
    await page.route(
      `${fixture.origin}/api/v2/projects/${unavailableProjectId}/snapshot`,
      async (route) => {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            schemaVersion: 2,
            error: {
              code: 'internal_error',
              message: 'The project snapshot is deliberately unavailable.',
            },
          }),
        });
      },
    );

    await page.goto(`${fixture.origin}/`);
    await expect(
      page.getByRole('heading', { name: 'Needs attention' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Review in project' }),
    ).toBeVisible();
    const alert = page.getByRole('alert').filter({
      hasText: 'Some projects could not be refreshed.',
    });
    await expect(alert).toContainText(unavailableProjectName);
  } finally {
    await fixture.dispose();
  }
});

test('attention-first UI retains durable project truth while resync disables commands', async ({
  page,
}) => {
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
    fakeDeveloperScenario: 'completed',
  });
  const appSocket = await controlAppSubscription(page);
  let releaseResyncSnapshot: () => void = () => undefined;
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await approveDeveloperProfile(page, fixture);
    const prepared = await fixture.projectSnapshot();
    const build = prepared.board.cards.find(
      ({ title }) => title === 'Build Todo controls',
    );
    if (!build) throw new Error('Build Todo controls task was not found');

    await page.getByRole('link', { name: 'Inbox' }).click();
    appSocket.holdNext(fixture.projectId);
    await page.goto(
      `${fixture.origin}/projects/${fixture.projectId}/board?task=${build.taskId}`,
    );
    await appSocket.waitUntilHeld();
    const staleSnapshot = await fixture.projectSnapshot();
    await expect(
      page.getByText(
        `Domain cursor ${staleSnapshot.cursors.domain}; runtime cursor ${staleSnapshot.cursors.runtime}`,
      ),
    ).toBeVisible();
    const staleBoard = page.getByRole('region', { name: 'Board' });
    const buildCard = staleBoard.getByRole('article', {
      name: 'Build Todo controls',
      exact: true,
    });
    await expect(buildCard.getByText(/^pending ·/u)).toBeVisible();
    await expect(
      staleBoard.getByRole('button', { name: 'Start Developer attempt' }),
    ).toBeDisabled();

    const actorPage = await page.context().newPage();
    try {
      await actorPage.goto(
        `${fixture.origin}/projects/${fixture.projectId}/board?task=${build.taskId}`,
      );
      const actorBoard = actorPage.getByRole('region', { name: 'Board' });
      await actorBoard
        .getByRole('button', { name: 'Start Developer attempt' })
        .click();
      await expect
        .poll(
          async () =>
            (await fixture.projectSnapshot()).board.cards.find(
              ({ taskId }) => taskId === build.taskId,
            )?.lifecycle,
        )
        .toBe('completed');
    } finally {
      await actorPage.close();
    }

    const currentSnapshot = await fixture.projectSnapshot();
    expect(currentSnapshot.cursors.domain).toBeGreaterThan(
      staleSnapshot.cursors.domain,
    );
    await fixture.expireRetainedEventsThrough(staleSnapshot.cursors);
    let resyncSnapshotRequested = false;
    const snapshotGate = new Promise<void>((resolveGate) => {
      releaseResyncSnapshot = () => resolveGate();
    });
    await page.route(
      `${fixture.origin}/api/v2/projects/${fixture.projectId}/snapshot`,
      async (route) => {
        resyncSnapshotRequested = true;
        await snapshotGate;
        await route.continue();
      },
      { times: 1 },
    );

    appSocket.release();
    await appSocket.waitForResync();
    await expect.poll(() => resyncSnapshotRequested).toBe(true);
    await expect(page.getByText('Resyncing project.').first()).toBeVisible();
    await expect(
      page.getByText(
        `Domain cursor ${staleSnapshot.cursors.domain}; runtime cursor ${staleSnapshot.cursors.runtime}`,
      ),
    ).toBeVisible();
    await expect(buildCard.getByText(/^pending ·/u)).toBeVisible();
    await expect(
      staleBoard.getByRole('button', { name: 'Start Developer attempt' }),
    ).toBeDisabled();

    releaseResyncSnapshot();
    releaseResyncSnapshot = () => undefined;
    await expect(
      page.getByText(
        `Domain cursor ${currentSnapshot.cursors.domain}; runtime cursor ${currentSnapshot.cursors.runtime}`,
      ),
    ).toBeVisible();
    await expect(buildCard.getByText(/^completed ·/u)).toBeVisible();
  } finally {
    releaseResyncSnapshot();
    await fixture.dispose();
  }
});

test('attention-first UI keeps the audit barrier banner and mutations disabled', async ({
  page,
}) => {
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
  });
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await approveDeveloperProfile(page, fixture);
    const snapshot = await fixture.projectSnapshot();
    const build = snapshot.board.cards.find(
      ({ title }) => title === 'Build Todo controls',
    );
    if (!build) throw new Error('Build Todo controls task was not found');

    await page.route(`${fixture.origin}/api/v2/snapshot`, async (route) => {
      const response = await route.fetch();
      const system = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...system,
          health: {
            status: 'audit_barrier_tripped',
            error: {
              code: 'audit_barrier_tripped',
              message: 'Audit persistence is unavailable.',
            },
          },
        },
      });
    });
    await page.goto(
      `${fixture.origin}/projects/${fixture.projectId}/board?task=${build.taskId}`,
    );

    const banner = page.getByRole('banner');
    await expect(banner.getByRole('status')).toHaveText(
      'Audit persistence is unavailable.',
    );
    const board = page.getByRole('region', { name: 'Board' });
    await expect(
      board.getByRole('button', { name: 'Apply filters' }),
    ).toBeDisabled();
    await expect(
      board.getByRole('button', { name: 'Start Developer attempt' }),
    ).toBeDisabled();

    await page.getByRole('button', { name: 'Project manager' }).click();
    const projectManager = page.getByRole('dialog', {
      name: /Project manager · todo-repository/u,
    });
    await expect(
      projectManager.getByRole('textbox', {
        name: 'Message to project manager',
      }),
    ).toBeDisabled();
  } finally {
    await fixture.dispose();
  }
});

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

test('finite Todo run pauses across restart and resumes its dependent once', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
    fakeDeveloperScenario: 'completed',
    fakeDeveloperHolds: true,
  });
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await approveDeveloperProfile(page, fixture);
    const { cards } = await startTodoRun(
      page,
      fixture,
      ['Build Todo controls', 'Persist Todo items', 'Integrate Todo workflow'],
      2,
    );
    const [ui, persistence, integration] = cards;

    await expect
      .poll(async () => {
        const current = (await fixture.projectSnapshot()).executionRuns?.[0];
        return current?.items.map(({ lifecycle }) => lifecycle);
      })
      .toEqual(['active', 'active', 'waiting']);

    await fixture.releaseDeveloperTask(ui.taskId);
    await expect
      .poll(async () => {
        const current = (await fixture.projectSnapshot()).executionRuns?.[0];
        return current?.items.map(({ lifecycle }) => lifecycle);
      })
      .toEqual(['completed', 'active', 'waiting']);

    await controlTodoRun(page, fixture, 'execution_run.pause');
    await fixture.releaseDeveloperTask(persistence.taskId);
    await expect
      .poll(async () => {
        const current = (await fixture.projectSnapshot()).executionRuns?.[0];
        return {
          lifecycle: current?.run.lifecycle,
          items: current?.items.map(({ lifecycle }) => lifecycle),
        };
      })
      .toEqual({
        lifecycle: 'paused',
        items: ['completed', 'completed', 'waiting'],
      });

    const beforeRestart = await fixture.projectSnapshot();
    const priorPid = fixture.serverPid;
    const origin = await fixture.restartWithFreshFake();
    expect(fixture.serverPid).not.toBe(priorPid);
    await page.goto(`${origin}/projects/${fixture.projectId}`);
    const restarted = await fixture.projectSnapshot();
    expect(restarted.executionRuns?.[0]).toMatchObject({
      run: { lifecycle: 'paused' },
      items: [
        { lifecycle: 'completed' },
        { lifecycle: 'completed' },
        { lifecycle: 'waiting' },
      ],
    });
    expect(restarted.developerAttempts).toHaveLength(2);
    expect(restarted.cursors.domain).toBeGreaterThanOrEqual(
      beforeRestart.cursors.domain,
    );

    await controlTodoRun(page, fixture, 'execution_run.resume');
    await expect
      .poll(async () => {
        const snapshot = await fixture.projectSnapshot();
        return {
          items: snapshot.executionRuns?.[0]?.items.map(
            ({ lifecycle }) => lifecycle,
          ),
          attempts: snapshot.developerAttempts.filter(
            ({ taskId }) => taskId === integration.taskId,
          ).length,
        };
      })
      .toEqual({ items: ['completed', 'completed', 'active'], attempts: 1 });
    await fixture.releaseDeveloperTask(integration.taskId);
    await expect
      .poll(async () => {
        const snapshot = await fixture.projectSnapshot();
        const current = snapshot.executionRuns?.[0];
        return {
          lifecycle: current?.run.lifecycle,
          reason: current?.run.completionReason,
          completed: current?.run.counts.completed,
          integrationAttempts: snapshot.developerAttempts.filter(
            ({ taskId }) => taskId === integration.taskId,
          ).length,
        };
      })
      .toEqual({
        lifecycle: 'completed',
        reason: 'finished',
        completed: 3,
        integrationAttempts: 1,
      });
  } finally {
    await fixture.dispose();
  }
});

test('stopping a finite Todo run prevents waiting work and drains active work', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
    fakeDeveloperScenario: 'completed',
    fakeDeveloperHolds: true,
  });
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await approveDeveloperProfile(page, fixture);
    const { cards } = await startTodoRun(
      page,
      fixture,
      ['Build Todo controls', 'Persist Todo items'],
      1,
    );
    const [active, waiting] = cards;
    await expect
      .poll(async () =>
        (await fixture.projectSnapshot()).executionRuns?.[0]?.items.map(
          ({ lifecycle }) => lifecycle,
        ),
      )
      .toEqual(['active', 'waiting']);

    await controlTodoRun(page, fixture, 'execution_run.stop');
    await expect
      .poll(async () => {
        const current = (await fixture.projectSnapshot()).executionRuns?.[0];
        return {
          lifecycle: current?.run.lifecycle,
          items: current?.items.map(({ lifecycle }) => lifecycle),
        };
      })
      .toEqual({ lifecycle: 'stopping', items: ['active', 'not_started'] });
    await fixture.releaseDeveloperTask(active.taskId);
    await expect
      .poll(async () => {
        const snapshot = await fixture.projectSnapshot();
        const current = snapshot.executionRuns?.[0];
        return {
          lifecycle: current?.run.lifecycle,
          reason: current?.run.completionReason,
          items: current?.items.map(({ lifecycle }) => lifecycle),
          waitingAttempts: snapshot.developerAttempts.filter(
            ({ taskId }) => taskId === waiting.taskId,
          ).length,
        };
      })
      .toEqual({
        lifecycle: 'completed',
        reason: 'stopped',
        items: ['completed', 'not_started'],
        waitingAttempts: 0,
      });
  } finally {
    await fixture.dispose();
  }
});

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

test('partial spawn and concurrent close failures release exact ownership', async () => {
  const fixture = await V2ProcessFixture.createTodo();
  try {
    const evidence = await fixture.probeCloseControlCleanup();
    expect(evidence.partialStartup).toMatchObject({
      pid: null,
      signals: [],
      ownershipReleased: true,
      namedListenerCount: 0,
    });
    expect(evidence.partialStartup.elapsedMs).toBeLessThan(3_000);
    expect(evidence.terminalDeadline).toMatchObject({
      signals: ['SIGTERM', 'SIGKILL'],
      closeWasShared: true,
      deadlineRejected: true,
      ownershipReleased: true,
      namedListenerCount: 0,
    });
    await expectProcessAndListenerGone(evidence.terminalDeadline);
  } finally {
    await fixture.dispose();
  }
});

test('delayed second ready closes only the running exact child', async () => {
  const fixture = await V2ProcessFixture.createTodo();
  try {
    const evidence = await fixture.probeDelayedDuplicateReadyCleanup();
    await expectProcessAndListenerGone(evidence);
  } finally {
    await fixture.dispose();
  }
});

test('Todo foundation survives restart without V1 state', async ({ page }) => {
  const fixture = await V2ProcessFixture.createTodo();
  try {
    const firstOrigin = await fixture.start({ holdAfterAdapterCursor: 2 });
    await page.goto(`${fixture.origin}/projects`);
    await page.getByLabel('Repository path').fill(fixture.todoRepository);
    await page.getByRole('button', { name: 'Add and select project' }).click();
    await fixture.waitForBrowserRegistration();
    await expect(
      page.getByRole('heading', { name: 'todo-repository', level: 1 }),
    ).toBeVisible();

    const held = await fixture.approveProfilesAndStartExecution();
    await expect(
      page.getByText('Todo foundation worker · revision 1'),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Runs' }).click();
    await page.getByRole('link', { name: 'Open run in project' }).click();
    const activity = page.getByRole('list', {
      name: 'Runtime activity for Todo foundation check',
    });
    await expect(
      activity.getByText('child.started Todo check', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Preferred skill fallback')).toBeVisible();
    await expect(page.getByText('Skill resolved')).toBeVisible();

    const firstServerPid = fixture.serverPid;
    const restartOrigin = await fixture.restartWithFreshFake();
    expect(fixture.serverPid).not.toBe(firstServerPid);
    await page.goto(
      `${restartOrigin}/projects/${fixture.projectId}/runs?run=${fixture.executionId}`,
    );
    await page.reload();
    const execution = page.getByRole('article', {
      name: 'Todo foundation check',
    });
    await expect(execution.getByRole('status')).toHaveText('completed');
    await expect(
      execution
        .getByRole('list', {
          name: 'Runtime activity for Todo foundation check',
        })
        .getByText('child.started Todo check', { exact: true }),
    ).toBeVisible();
    await expect(
      execution
        .getByRole('list', {
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

test('conversation becomes an approved intent ledger', async ({ page }) => {
  const fixture = await V2ProcessFixture.createTodo({ fakePmScenario: 'todo' });
  try {
    await fixture.start();
    await page.goto(`${fixture.origin}/projects`);
    await page.getByLabel('Repository path').fill(fixture.todoRepository);
    await page.getByRole('button', { name: 'Add and select project' }).click();
    await fixture.waitForBrowserRegistration();

    const profileApproval = await page.evaluate(async (sourceYaml) => {
      const response = await fetch('/api/v2/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          actor: { kind: 'human' },
          command: {
            type: 'worker_profile.approve_revision',
            scope: 'global',
            expectedLatestRevision: 0,
            sourceYaml,
          },
        }),
      });
      return { status: response.status, body: await response.json() };
    }, pmProfileYaml);
    expect(profileApproval).toMatchObject({
      status: 200,
      body: {
        ok: true,
        commandType: 'worker_profile.approve_revision',
        profileRevision: { revision: 1, scope: 'global' },
      },
    });

    await page.reload();
    await page.getByRole('button', { name: 'Project manager' }).click();
    const projectManager = page.getByRole('dialog', {
      name: /Project manager ·/u,
    });
    await expect(
      projectManager.getByLabel('Project manager profile'),
    ).toContainText('Project manager · revision 1');
    const firstDescription =
      'Build a Todo app where people can add and complete items.';
    await page
      .getByRole('textbox', { name: 'Message to project manager' })
      .fill(firstDescription);
    await page.getByRole('button', { name: 'Send message' }).click();

    const questions = page.getByRole('region', { name: 'Planning questions' });
    await expect(
      questions.getByRole('heading', {
        name: 'How should Todo items persist?',
      }),
    ).toBeVisible();
    await expect(
      questions.getByRole('heading', {
        name: 'Should all Todo controls be keyboard operable?',
      }),
    ).toBeVisible();
    await expect(questions.getByRole('checkbox')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).planningCycles[0]?.questions.length,
      )
      .toBe(2);
    const firstQuestionSnapshot = await fixture.projectSnapshot();
    const firstCycle = firstQuestionSnapshot.planningCycles[0];
    expect(firstCycle?.turns.map(({ message }) => message)).toEqual([
      firstDescription,
      'I need two details before proposing Todo intent.',
    ]);

    const questionRestartOrigin = await fixture.restartWithFreshFake();
    await page.goto(`${questionRestartOrigin}/projects/${fixture.projectId}`);
    await page.getByRole('button', { name: 'Project manager' }).click();
    await expect(
      page.getByRole('list', { name: 'Planning conversation' }),
    ).toContainText(firstDescription);
    await expect(questions).toContainText('How should Todo items persist?');
    const restartedQuestions = await fixture.projectSnapshot();
    expect(restartedQuestions.planningCycles[0]?.turns).toEqual(
      firstCycle?.turns,
    );
    expect(restartedQuestions.planningCycles[0]?.questions).toEqual(
      firstCycle?.questions,
    );

    const answer =
      'Use local browser storage, and yes, every control must be keyboard operable.';
    await page
      .getByRole('textbox', { name: 'Message to project manager' })
      .fill(answer);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).planningCycles[0]?.proposals.length,
      )
      .toBe(1);
    await page.getByRole('button', { name: 'Close project manager' }).click();
    await page.getByRole('tab', { name: 'Plans' }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Proposal revision 1 · awaiting_approval',
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Define a small persistent, keyboard-operable Todo product.',
      ),
    ).toBeVisible();
    const proposedRecords = page.getByRole('region', {
      name: 'Proposed records for revision 1',
    });
    const recordStatements = [
      'Users can add and complete Todo items.',
      'Every Todo control is keyboard operable.',
      'Todo items persist across application reloads.',
      'One person uses the Todo list on one device.',
      'Store Todo items locally in the application.',
      'How long should completed Todo items remain visible?',
      'Local browser data can be cleared by the user.',
    ];
    for (const statement of recordStatements) {
      await expect(proposedRecords.getByText(statement)).toBeVisible();
    }

    await page.getByRole('button', { name: 'Approve proposal' }).click();
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).intentLedger?.ledger.revision,
      )
      .toBe(1);
    const approved = await fixture.projectSnapshot();
    expect(approved.intentLedger).toMatchObject({
      projectIntent: { revision: 1 },
      ledger: { revision: 1 },
    });
    expect(approved.planningCycles[0]?.cycle.lifecycle).toBe('approved');
    const humanTurnIds =
      approved.planningCycles[0]?.turns
        .filter(({ actor }) => actor === 'human')
        .map(({ id }) => id) ?? [];
    expect(humanTurnIds).toHaveLength(2);
    expect(
      approved.intentLedger?.projectIntent.content.provenance.map(
        ({ turnId }) => turnId,
      ),
    ).toEqual(humanTurnIds);
    for (const record of approved.intentLedger?.records ?? []) {
      expect(record.provenance.map(({ turnId }) => turnId)).toEqual(
        humanTurnIds,
      );
    }
    expect(
      approved.intentLedger?.relationships.map(({ kind }) => kind),
    ).toEqual(['depends_on', 'constrains']);

    const expectRequirementsProjection = async () => {
      const requirements = page.getByRole('tabpanel', {
        name: 'Requirements',
      });
      await expect(
        requirements.getByRole('heading', {
          name: 'Approved intent · revision 1',
        }),
      ).toBeVisible();
      await expect(requirements.getByText('Ledger revision 1')).toBeVisible();
      for (const heading of [
        'Requirements · 3',
        'Decisions · 1',
        'Assumptions · 1',
        'Questions · 1',
        'Risks · 1',
      ]) {
        await expect(
          requirements.getByRole('heading', {
            name: heading,
            exact: true,
            level: 3,
          }),
        ).toBeVisible();
      }
      await expect(
        requirements.getByText('Requirement · Functional · Approved · Must'),
      ).toBeVisible();
      await expect(
        requirements.getByText('Requirement · Ux · Approved · Must'),
      ).toBeVisible();
      await expect(
        requirements.getByText('Requirement · Operational · Approved · Must'),
      ).toBeVisible();
      await expect(
        requirements.getByText(
          /Users can add and complete Todo items.*depends on.*Todo items persist across application reloads/u,
        ),
      ).toBeVisible();
      await expect(
        requirements.getByText(
          /Store Todo items locally in the application.*constrains.*Todo items persist across application reloads/u,
        ),
      ).toBeVisible();
      const intentProvenance = requirements.getByRole('list', {
        name: 'Approved intent provenance',
      });
      await requirements.getByText('Approval history', { exact: true }).click();
      for (const statement of recordStatements) {
        await requirements
          .getByRole('article', { name: statement })
          .getByText('Revision and provenance', { exact: true })
          .click();
      }
      for (const turnId of humanTurnIds) {
        await expect(intentProvenance).toContainText(turnId);
        for (const statement of recordStatements) {
          await expect(
            requirements.getByRole('list', {
              name: `Provenance for ${statement}`,
            }),
          ).toContainText(turnId);
        }
      }
    };

    await page.getByRole('tab', { name: 'Requirements' }).click();
    await expectRequirementsProjection();

    const approvalRestartOrigin = await fixture.restartWithFreshFake();
    await page.goto(`${approvalRestartOrigin}/projects/${fixture.projectId}`);
    await page.getByRole('tab', { name: 'Requirements' }).click();
    await expect(page.getByText('Ledger revision 1')).toBeVisible();
    const restartedApproval = await fixture.projectSnapshot();
    expect(restartedApproval.intentLedger).toEqual(approved.intentLedger);
    expect(restartedApproval.planningCycles[0]?.turns).toEqual(
      approved.planningCycles[0]?.turns,
    );
    expect(
      restartedApproval.intentLedger?.projectIntent.content.provenance,
    ).toEqual(approved.intentLedger?.projectIntent.content.provenance);
    expect(restartedApproval.intentLedger?.relationships).toEqual(
      approved.intentLedger?.relationships,
    );
  } finally {
    await fixture.dispose();
  }
});

test('approved delivery plan becomes a deterministic Board', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await V2ProcessFixture.createTodo({ fakePmScenario: 'todo' });
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    const approved = await approveTodoDeliveryPlan(page, fixture);
    const deliveryPlan = approved.deliveryPlan;
    if (!deliveryPlan) throw new Error('Delivery plan was not approved');

    expect(deliveryPlan.plan).toMatchObject({ revision: 1 });
    expect(deliveryPlan.milestones).toHaveLength(2);
    expect(deliveryPlan.taskContracts).toHaveLength(3);
    expect(deliveryPlan.dependencies).toHaveLength(2);
    expect(deliveryPlan.traces).toHaveLength(6);
    expect(
      deliveryPlan.taskContracts.map(({ lifecycle }) => lifecycle),
    ).toEqual(['pending', 'pending', 'pending']);
    const latestCycle = approved.planningCycles.find(
      ({ purpose }) => purpose.kind === 'delivery_plan',
    );
    expect(latestCycle?.cycle.lifecycle).toBe('approved');
    expect(latestCycle?.deliveryPlanProposals).toHaveLength(2);
    expect(
      latestCycle?.deliveryPlanProposals.map(({ revision, lifecycle }) => ({
        revision,
        lifecycle,
      })),
    ).toEqual([
      { revision: 1, lifecycle: 'superseded' },
      { revision: 2, lifecycle: 'approved' },
    ]);

    expect(approved.board).toMatchObject({
      deliveryPlanRevision: 1,
      stale: false,
      emptyReason: null,
      totalTaskCount: 3,
      matchedTaskCount: 3,
      filter: {
        revision: 1,
        milestoneIds: [],
        taskLifecycles: ['pending', 'completed'],
        readiness: [],
        priorities: [],
        labels: [],
        requirementRecordIds: [],
      },
    });
    const cards = Object.fromEntries(
      approved.board.cards.map((card) => [card.title, card]),
    );
    expect(cards['Build Todo controls']?.readiness).toEqual({
      state: 'actionable',
      blockers: [],
    });
    expect(cards['Persist Todo items']?.readiness).toEqual({
      state: 'actionable',
      blockers: [],
    });
    const integrated = cards['Integrate Todo workflow'];
    expect(integrated?.readiness.state).toBe('blocked');
    if (integrated?.readiness.state !== 'blocked')
      throw new Error('Integrated Todo task was not blocked');
    expect(
      integrated.readiness.blockers
        .map((blocker) =>
          blocker.kind === 'dependency_incomplete'
            ? blocker.prerequisiteTaskId
            : blocker.kind,
        )
        .sort(),
    ).toEqual(
      deliveryPlan.taskContracts
        .filter(({ title }) =>
          ['Build Todo controls', 'Persist Todo items'].includes(title),
        )
        .map(({ id }) => id)
        .sort(),
    );
    expect(
      approved.executions.every(({ assignment }) =>
        assignment.kind.startsWith('pm_'),
      ),
    ).toBe(true);
    expect(JSON.stringify(approved)).not.toMatch(
      /DeveloperAttempt|ExecutionRun|workspaceId|workerAssignment/u,
    );

    await page.getByRole('tab', { name: 'Board' }).click();
    const board = page.getByRole('tabpanel', { name: 'Board' });
    await expect(
      board.getByText('Showing 3 of 3 tasks · plan 1'),
    ).toBeVisible();
    await expect(
      board.getByRole('heading', { name: 'Todo foundations' }),
    ).toBeVisible();
    await expect(
      board.getByRole('heading', { name: 'Todo integration' }),
    ).toBeVisible();
    await expect(board.getByText('Actionable', { exact: true })).toHaveCount(2);
    await expect(
      board.getByRole('list', {
        name: 'Readiness for Integrate Todo workflow',
      }),
    ).toContainText('Build Todo controls');
    await expect(
      board.getByRole('list', {
        name: 'Readiness for Integrate Todo workflow',
      }),
    ).toContainText('Persist Todo items');

    await board.getByLabel(/^actionable · 2 tasks$/u).check();
    await board.getByRole('button', { name: 'Apply filters' }).click();
    await expect(
      board.getByText('Showing 2 of 3 tasks · plan 1'),
    ).toBeVisible();
    await board.getByLabel(/^blocked · 1 task$/u).check();
    await board.getByRole('button', { name: 'Apply filters' }).click();
    await expect(
      board.getByText('Showing 3 of 3 tasks · plan 1'),
    ).toBeVisible();
    await page.reload();
    await expect(board.getByLabel(/^actionable · 2 tasks$/u)).toBeChecked();
    await expect(board.getByLabel(/^blocked · 1 task$/u)).toBeChecked();
    const filtered = await fixture.projectSnapshot();
    expect(filtered.board.filter?.readiness).toEqual(['actionable', 'blocked']);

    await board
      .getByRole('button', { name: 'Open Integrate Todo workflow' })
      .click();
    const details = board.getByRole('region', { name: 'Task details' });
    await expect(
      details.getByRole('heading', {
        name: 'Integrate Todo workflow',
        level: 3,
      }),
    ).toBeFocused();
    await expect(
      details.getByText(
        'Adding, reloading, and completing a Todo item works end to end.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      details.getByText('Run the integrated Todo acceptance journey.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      details.getByText('Todo integration', { exact: true }),
    ).toBeVisible();
    await expect(
      details.getByText(
        'The integrated Todo flow passes its acceptance and verification criteria.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(details).toContainText('revision 1');
    await expect(
      board.getByRole('list', {
        name: 'Dependencies for Integrate Todo workflow',
      }),
    ).toContainText('prerequisite: Build Todo controls · pending');

    const domain = await fixture.domainEventsAfter(0);
    expect(domain.events).toContainEqual(
      expect.objectContaining({
        type: 'delivery_plan.approved',
        payload: expect.objectContaining({ schemaVersion: 1 }),
      }),
    );
  } finally {
    await fixture.dispose();
  }
});

test('approved planning state survives a built server restart', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await V2ProcessFixture.createTodo({ fakePmScenario: 'todo' });
  try {
    await registerTodo(page, fixture);
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await page.getByRole('tab', { name: 'Board' }).click();
    const board = page.getByRole('tabpanel', { name: 'Board' });
    await board.getByLabel(/^actionable · 2 tasks$/u).check();
    await board.getByRole('button', { name: 'Apply filters' }).click();
    await expect(
      board.getByText('Showing 2 of 3 tasks · plan 1'),
    ).toBeVisible();
    const before = await fixture.projectSnapshot();
    const oldPid = fixture.serverPid;
    const origin = await fixture.restartWithFreshFake();
    expect(fixture.serverPid).not.toBe(oldPid);
    await page.goto(`${origin}/projects/${fixture.projectId}/board`);
    await expect(
      page
        .getByRole('tabpanel', { name: 'Board' })
        .getByText('Showing 2 of 3 tasks · plan 1'),
    ).toBeVisible();
    await expect(board.getByLabel(/^actionable · 2 tasks$/u)).toBeChecked();
    const after = await fixture.projectSnapshot();
    expect(after.planningCycles).toEqual(before.planningCycles);
    expect(after.deliveryPlan).toEqual(before.deliveryPlan);
    expect(after.board).toEqual(before.board);
  } finally {
    await fixture.dispose();
  }
});

test('one Todo task completes with durable workspace evidence across restart', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await V2ProcessFixture.createTodo({
    fakePmScenario: 'todo',
    fakeDeveloperScenario: 'completed',
    gitBarrier: true,
  });
  const appSocket = await controlAppSubscription(page);
  try {
    await registerTodo(page, fixture, { holdAfterAdapterCursor: 2 });
    await approveTodoIntent(page, fixture);
    await approveTodoDeliveryPlan(page, fixture);
    await approveDeveloperProfile(page, fixture);
    await page.getByRole('tab', { name: 'Board' }).click();

    const beforeStart = await fixture.projectSnapshot();
    expect(beforeStart.developerAttempts).toEqual([]);
    expect(beforeStart.developerReports).toEqual([]);
    const startingCard = beforeStart.board.cards.find(
      ({ title }) => title === 'Persist Todo items',
    );
    const deliveryPlan = beforeStart.deliveryPlan;
    const developerProfile = beforeStart.profiles.find(
      (profile) =>
        profile.document.spec.outputSchema === 'mesh.dev/developer-report/v1',
    );
    if (!startingCard || !deliveryPlan || !developerProfile) {
      throw new Error('Frozen Developer authority was not available');
    }
    const board = page.getByRole('tabpanel', { name: 'Board' });
    await board
      .getByRole('button', { name: 'Open Persist Todo items' })
      .click();
    await board
      .getByRole('button', { name: 'Start Developer attempt' })
      .click();

    await fixture.waitForGitWorktreeAdd();
    await expect
      .poll(async () => {
        const snapshot = await fixture.projectSnapshot();
        const reservedAttempt = snapshot.developerAttempts[0];
        return reservedAttempt
          ? {
              attempt: reservedAttempt,
              executions: snapshot.executions.filter(
                ({ assignment }) => assignment.kind === 'developer_task',
              ).length,
            }
          : undefined;
      })
      .toMatchObject({
        attempt: {
          lifecycle: 'reserved',
          executionIds: [],
          workspace: { lifecycle: 'creating' },
        },
        executions: 0,
      });
    const beforeGit = await fixture.projectSnapshot();
    const reservedAttempt = beforeGit.developerAttempts[0];
    if (!reservedAttempt) throw new Error('Developer attempt was not reserved');
    expect(
      await fixture.managedWorkspacePresence(reservedAttempt.workspace.path),
    ).toEqual({ workspace: false, artifact: false });
    expect(await fixture.gitWorktreeAddCount()).toBe(1);
    const reservationEvents = await fixture.domainEventsAfter(
      beforeStart.cursors.domain,
    );
    expect(reservationEvents.events).toContainEqual(
      expect.objectContaining({
        type: 'developer_attempt.changed',
        payload: expect.objectContaining({
          attempt: expect.objectContaining({
            id: reservedAttempt.id,
            lifecycle: 'reserved',
          }),
        }),
      }),
    );
    expect(
      reservationEvents.events.some(
        (event) =>
          event.type === 'developer_attempt.changed' &&
          event.payload.attempt.id === reservedAttempt.id &&
          event.payload.attempt.lifecycle === 'active',
      ),
    ).toBe(false);
    await fixture.releaseGitWorktreeAdd();

    await expect
      .poll(
        async () => {
          const snapshot = await fixture.projectSnapshot();
          const attempt = snapshot.developerAttempts[0];
          const execution = snapshot.executions.find(
            ({ id }) => id === attempt?.controllingExecutionId,
          );
          return attempt && execution
            ? { snapshot, attempt, execution }
            : undefined;
        },
        { timeout: 10_000 },
      )
      .toMatchObject({
        attempt: { lifecycle: 'active' },
        execution: { lifecycle: 'running', lastAdapterCursor: 2 },
      });
    const held = await fixture.projectSnapshot();
    const attempt = held.developerAttempts[0];
    if (!attempt) throw new Error('Developer attempt was not held');
    const firstExecution = held.executions.find(
      ({ id }) => id === attempt.controllingExecutionId,
    );
    if (!firstExecution) throw new Error('Developer execution was not held');
    expect(attempt).toMatchObject({
      projectId: fixture.projectId,
      taskId: startingCard.taskId,
      taskContractRevision: startingCard.taskContractRevision,
      taskCurrentRevision: startingCard.taskCurrentRevision,
      deliveryPlanId: deliveryPlan.plan.id,
      deliveryPlanRevision: deliveryPlan.plan.revision,
      profileId: developerProfile.profileId,
      profileRevision: developerProfile.profileRevision,
      assignment: {
        projectId: fixture.projectId,
        attemptId: attempt.id,
        taskId: startingCard.taskId,
        taskContractRevision: startingCard.taskContractRevision,
        taskCurrentRevision: startingCard.taskCurrentRevision,
        deliveryPlanId: deliveryPlan.plan.id,
        deliveryPlanRevision: deliveryPlan.plan.revision,
        requirementRevisions: startingCard.detail.requirementTraces.map(
          ({ recordId, recordRevision }) => ({ recordId, recordRevision }),
        ),
        baseCommit: beforeStart.project.headCommit,
        title: startingCard.title,
        outcome: startingCard.outcome,
        acceptanceCriteria: startingCard.detail.acceptanceCriteria,
        verification: startingCard.detail.verificationCriteria,
        expectedArtifacts: startingCard.detail.expectedArtifacts,
        outputSchema: 'mesh.dev/developer-report/v1',
      },
    });

    const startEvents = await fixture.domainEventsAfter(
      beforeStart.cursors.domain,
    );
    const reservedIndex = startEvents.events.findIndex(
      (event) =>
        event.type === 'developer_attempt.changed' &&
        event.payload.attempt.lifecycle === 'reserved',
    );
    const workspaceIndex = startEvents.events.findIndex(
      (event) => event.type === 'developer_workspace.changed',
    );
    const activeIndex = startEvents.events.findIndex(
      (event) =>
        event.type === 'developer_attempt.changed' &&
        event.payload.attempt.lifecycle === 'active',
    );
    expect(reservedIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceIndex).toBeGreaterThan(reservedIndex);
    expect(activeIndex).toBeGreaterThan(workspaceIndex);
    expect(startEvents.events[workspaceIndex]).toMatchObject({
      payload: {
        attempt: {
          id: attempt.id,
          workspace: { lifecycle: 'ready' },
        },
      },
    });

    const managedPath = resolve(attempt.workspace.path);
    const managedRelation = relative(resolve(fixture.fixtureRoot), managedPath);
    expect(attempt.workspace.path).toBe(managedPath);
    expect(managedRelation).not.toBe('');
    expect(managedRelation).not.toBe('..');
    expect(
      managedRelation.startsWith(
        `..${process.platform === 'win32' ? '\\' : '/'}`,
      ),
    ).toBe(false);
    expect(attempt.assignment.workspacePath).toBe(managedPath);
    expect(await fixture.managedTodoArtifact(attempt.id)).toBe('persisted\n');
    await expect(
      page.getByText('Persisted deterministic Todo evidence.').first(),
    ).toBeVisible();
    await expect(page.getByText('Persist Todo evidence').first()).toBeVisible();
    await expect(
      page.getByText('A project command is in progress.'),
    ).toHaveCount(0);

    const firstPid = fixture.serverPid;
    await fixture.crashServer();
    await fixture.start({ holdAfterAdapterCursor: 3 });
    expect(fixture.serverPid).not.toBe(firstPid);
    await page.goto(`${fixture.origin}/projects/${fixture.projectId}/board`);
    const recoveryReplay = await fixture.subscribe(page, held.cursors);
    expect(recoveryReplay.at(-1)).toMatchObject({ type: 'v2.subscribed' });
    const recoveryDomainIndex = recoveryReplay.findIndex(
      (message) =>
        message.type === 'v2.domain_event' &&
        message.event.type === 'developer_attempt.changed' &&
        message.event.payload.attempt.id === attempt.id &&
        message.event.payload.attempt.workspace.observedDirty === true,
    );
    const recoveryRuntimeIndex = recoveryReplay.findIndex(
      (message) =>
        message.type === 'v2.runtime_event' &&
        message.event.adapterCursor === 3,
    );
    expect(recoveryDomainIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryRuntimeIndex).toBeGreaterThan(recoveryDomainIndex);
    expect(recoveryReplay.at(-1)?.type).toBe('v2.subscribed');
    expect(
      recoveryReplay
        .filter(({ type }) => type === 'v2.runtime_event')
        .map((message) =>
          message.type === 'v2.runtime_event'
            ? message.event.adapterCursor
            : undefined,
        ),
    ).toEqual([3]);

    await expect
      .poll(async () => {
        const snapshot = await fixture.projectSnapshot();
        const recoveredAttempt = snapshot.developerAttempts.find(
          ({ id }) => id === attempt.id,
        );
        const execution = snapshot.executions.find(
          ({ id }) => id === firstExecution.id,
        );
        return {
          attempt: recoveredAttempt?.lifecycle,
          execution: execution?.lifecycle,
          cursor: execution?.lastAdapterCursor,
        };
      })
      .toEqual({ attempt: 'active', execution: 'running', cursor: 3 });

    const recovered = await fixture.projectSnapshot();
    const recoveredBoard = page.getByRole('tabpanel', { name: 'Board' });
    await recoveredBoard
      .getByRole('button', { name: 'Open Persist Todo items' })
      .click();
    await expect(
      recoveredBoard.getByRole('button', { name: 'Start Developer attempt' }),
    ).toBeDisabled();
    const interrupt = recoveredBoard.getByRole('button', {
      name: 'Interrupt attempt 1',
    });
    await expect(interrupt).toBeEnabled();
    await interrupt.click();
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).developerAttempts.find(
            ({ id }) => id === attempt.id,
          )?.lifecycle,
      )
      .toBe('interrupted');

    const interrupted = await fixture.projectSnapshot();
    const interruptEvents = await fixture.domainEventsAfter(
      recovered.cursors.domain,
    );
    const executionInterruptedIndex = interruptEvents.events.findIndex(
      (event) =>
        event.type === 'worker_execution.lifecycle_changed' &&
        event.payload.execution.id === firstExecution.id &&
        event.payload.execution.lifecycle === 'interrupted',
    );
    const attemptInterruptedIndex = interruptEvents.events.findIndex(
      (event) =>
        event.type === 'developer_attempt.changed' &&
        event.payload.attempt.id === attempt.id &&
        event.payload.attempt.lifecycle === 'interrupted',
    );
    expect(attemptInterruptedIndex).toBeGreaterThanOrEqual(0);
    expect(executionInterruptedIndex).toBeGreaterThanOrEqual(0);
    expect(executionInterruptedIndex).toBeGreaterThan(attemptInterruptedIndex);

    const replace = recoveredBoard.getByRole('button', {
      name: 'Replace attempt 1 execution',
    });
    await expect(replace).toBeEnabled();
    await replace.click();
    await expect
      .poll(async () => {
        const current = (
          await fixture.projectSnapshot()
        ).developerAttempts.find(({ id }) => id === attempt.id);
        return (
          current && {
            lifecycle: current.lifecycle,
            executionCount: current.executionIds.length,
            workspacePath: current.workspace.path,
          }
        );
      })
      .toEqual({
        lifecycle: 'active',
        executionCount: 2,
        workspacePath: managedPath,
      });

    const replacementHeld = await fixture.projectSnapshot();
    const replacementAttempt = replacementHeld.developerAttempts.find(
      ({ id }) => id === attempt.id,
    );
    if (!replacementAttempt?.controllingExecutionId)
      throw new Error('Replacement execution was not linked');
    const replacementExecution = replacementHeld.executions.find(
      ({ id }) => id === replacementAttempt.controllingExecutionId,
    );
    expect(replacementExecution).toMatchObject({
      lifecycle: 'running',
      lastAdapterCursor: 3,
      replacementForExecutionId: firstExecution.id,
      assignment: attempt.assignment,
    });
    if (!replacementExecution)
      throw new Error('Replacement execution was not preserved');
    const replacementEvents = await fixture.domainEventsAfter(
      interrupted.cursors.domain,
    );
    const replacementReservedIndex = replacementEvents.events.findIndex(
      (event) =>
        event.type === 'worker_execution.lifecycle_changed' &&
        event.payload.execution.id === replacementExecution.id &&
        event.payload.execution.lifecycle === 'starting',
    );
    const replacementLinkedIndex = replacementEvents.events.findIndex(
      (event) =>
        event.type === 'developer_attempt.changed' &&
        event.payload.attempt.id === attempt.id &&
        event.payload.attempt.lifecycle === 'active' &&
        event.payload.attempt.controllingExecutionId ===
          replacementExecution.id,
    );
    expect(replacementReservedIndex).toBeGreaterThanOrEqual(0);
    expect(replacementLinkedIndex).toBeGreaterThan(replacementReservedIndex);
    expect(await fixture.managedTodoArtifact(attempt.id)).toBe('persisted\n');

    const secondPid = fixture.serverPid;
    await fixture.crashServer();
    await fixture.start();
    expect(fixture.serverPid).not.toBe(secondPid);
    await page.goto(`${fixture.origin}/projects/${fixture.projectId}/board`);
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).developerAttempts.find(
            ({ id }) => id === attempt.id,
          )?.lifecycle,
      )
      .toBe('completed');

    const completed = await fixture.projectSnapshot();
    const completedAttempt = completed.developerAttempts.find(
      ({ id }) => id === attempt.id,
    );
    if (!completedAttempt)
      throw new Error('Developer attempt did not complete');
    const reportRecord = completed.developerReports.find(
      ({ id }) => id === completedAttempt.reportIds[0],
    );
    if (!reportRecord || reportRecord.report.disposition !== 'completed')
      throw new Error('Developer completion report was not recorded');
    const report = reportRecord.report;
    expect(completedAttempt).toMatchObject({
      lifecycle: 'completed',
      executionIds: [firstExecution.id, replacementExecution.id],
      reportIds: [reportRecord.id],
      workspace: {
        path: managedPath,
        lifecycle: 'ready',
        observedHead: attempt.baseCommit,
        observedDirty: true,
      },
    });
    expect(report).toMatchObject({
      attemptId: attempt.id,
      executionId: replacementExecution.id,
      taskId: attempt.taskId,
      taskContractRevision: attempt.taskContractRevision,
      changedArtifacts: [
        { path: 'todo-m4.txt', summary: 'Persisted Todo evidence.' },
      ],
      unresolvedConcerns: [],
      workspace: { headCommit: attempt.baseCommit, dirty: true },
    });
    expect(report.requirementCoverage).toEqual(
      attempt.assignment.requirementRevisions.map((requirement) => ({
        ...requirement,
        passed: true,
        evidence: [{ summary: 'Todo persistence requirement satisfied.' }],
      })),
    );
    expect(report.criterionCoverage).toEqual(
      attempt.assignment.acceptanceCriteria.map((text, index) => ({
        index,
        text,
        passed: true,
        evidence: [{ summary: 'Todo persistence acceptance passed.' }],
      })),
    );
    expect(report.verification).toEqual(
      attempt.assignment.verification.map((command) => ({
        command,
        passed: true,
        evidence: [
          { summary: 'todo-m4.txt contains persisted Todo evidence.' },
        ],
      })),
    );
    const persistedCard = completed.board.cards.find(
      ({ taskId }) => taskId === attempt.taskId,
    );
    expect(persistedCard).toMatchObject({
      lifecycle: 'completed',
      taskCurrentRevision: attempt.taskCurrentRevision + 1,
    });

    const completionDomain = await fixture.domainEventsAfter(
      replacementHeld.cursors.domain,
    );
    const completionTypes = completionDomain.events.map(({ type }) => type);
    expect(
      completionTypes.indexOf('developer_report.recorded'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      completionTypes.indexOf('developer_attempt.changed'),
    ).toBeGreaterThan(completionTypes.indexOf('developer_report.recorded'));
    expect(completionTypes.indexOf('task.lifecycle_changed')).toBeGreaterThan(
      completionTypes.indexOf('developer_attempt.changed'),
    );
    const completionRuntime = await fixture.runtimeEventsAfter(
      replacementHeld.cursors.runtime,
    );
    expect(
      completionRuntime.events.map(({ adapterCursor, type }) => ({
        adapterCursor,
        type,
      })),
    ).toEqual([
      { adapterCursor: 4, type: 'worker_execution.structured_output' },
      { adapterCursor: 5, type: 'worker_execution.completed' },
    ]);

    const completedBoard = page.getByRole('tabpanel', { name: 'Board' });
    await completedBoard
      .getByRole('button', { name: 'Open Persist Todo items' })
      .click();
    await expect(
      page.getByText('Todo persistence acceptance passed.').first(),
    ).toBeVisible();
    await expect(page.getByText('todo-m4.txt').first()).toBeVisible();

    expect(await fixture.gitWorktreeAddCount()).toBe(1);

    appSocket.holdNext(fixture.projectId);
    await page.goto(`${fixture.origin}/projects`);
    await page.goto(`${fixture.origin}/projects/${fixture.projectId}/board`);
    await appSocket.waitUntilHeld();

    const staleSnapshot = await fixture.projectSnapshot();
    await expect(
      page.getByText(
        `Domain cursor ${staleSnapshot.cursors.domain}; runtime cursor ${staleSnapshot.cursors.runtime}`,
      ),
    ).toBeVisible();

    const staleBoard = page.getByRole('tabpanel', { name: 'Board' });
    await staleBoard
      .getByRole('button', { name: 'Open Build Todo controls' })
      .click();
    await expect(
      staleBoard.getByRole('button', { name: 'Start Developer attempt' }),
    ).toBeDisabled();

    const actorPage = await page.context().newPage();
    await actorPage.goto(
      `${fixture.origin}/projects/${fixture.projectId}/board`,
    );
    const actorBoard = actorPage.getByRole('tabpanel', { name: 'Board' });
    await actorBoard
      .getByRole('button', { name: 'Open Build Todo controls' })
      .click();
    await actorBoard
      .getByRole('button', { name: 'Start Developer attempt' })
      .click();
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).board.cards.find(
            ({ title }) => title === 'Build Todo controls',
          )?.lifecycle,
      )
      .toBe('completed');
    await expect
      .poll(
        async () =>
          (await fixture.projectSnapshot()).board.cards.find(
            ({ title }) => title === 'Integrate Todo workflow',
          )?.readiness.state,
      )
      .toBe('actionable');
    await actorPage.close();

    const beforeResync = await fixture.projectSnapshot();
    expect(beforeResync.cursors.domain).toBeGreaterThan(
      staleSnapshot.cursors.domain + 1,
    );
    expect(beforeResync.cursors.runtime).toBeGreaterThan(
      staleSnapshot.cursors.runtime + 1,
    );
    const buildCard = staleBoard.locator('article.planning-board-card').filter({
      has: page.getByRole('heading', {
        name: 'Build Todo controls',
        exact: true,
      }),
    });
    await expect(buildCard.getByText(/^pending ·/u)).toBeVisible();
    const staleDeveloper = staleBoard.getByRole('region', {
      name: 'Developer for Build Todo controls',
    });
    await expect(
      staleDeveloper.getByText('No Developer attempts yet.'),
    ).toBeVisible();

    const retainedWindows = await fixture.expireRetainedEventsThrough(
      staleSnapshot.cursors,
    );
    let navigations = 0;
    const countNavigation = () => {
      navigations += 1;
    };
    page.on('framenavigated', countNavigation);
    appSocket.release();
    await appSocket.waitForResync();
    await expect(
      page.getByText(
        `Domain cursor ${beforeResync.cursors.domain}; runtime cursor ${beforeResync.cursors.runtime}`,
      ),
    ).toBeVisible();
    page.off('framenavigated', countNavigation);
    expect(navigations).toBe(0);
    await expect(buildCard).toHaveCount(1);
    await expect(buildCard.getByText(/^completed ·/u)).toBeVisible();
    await expect(buildCard.getByText(/^pending ·/u)).toHaveCount(0);
    await expect(
      buildCard.getByText('Inactive because the task is completed.'),
    ).toBeVisible();
    await expect(
      staleBoard.getByRole('list', {
        name: 'Readiness for Integrate Todo workflow',
      }),
    ).toHaveCount(0);

    const buildDeveloper = staleBoard.getByRole('region', {
      name: 'Developer for Build Todo controls',
    });
    await expect(buildDeveloper).toHaveCount(1);
    await expect(
      buildDeveloper.getByText('No Developer attempts yet.'),
    ).toHaveCount(0);
    await expect(
      buildDeveloper.getByRole('heading', { name: 'Attempt 1', exact: true }),
    ).toHaveCount(1);
    await expect(
      buildDeveloper.getByRole('group', {
        name: 'Developer completion report',
      }),
    ).toHaveCount(1);
    await expect(
      buildDeveloper.getByRole('heading', {
        name: 'Build Todo controls',
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      buildDeveloper.getByRole('list', {
        name: 'Runtime activity for Build Todo controls',
      }),
    ).toHaveCount(1);

    const persistCard = staleBoard
      .locator('article.planning-board-card')
      .filter({
        has: page.getByRole('heading', {
          name: 'Persist Todo items',
          exact: true,
        }),
      });
    await expect(persistCard).toHaveCount(1);
    await persistCard
      .getByRole('button', { name: 'Open Persist Todo items' })
      .click();
    const persistDeveloper = staleBoard.getByRole('region', {
      name: 'Developer for Persist Todo items',
    });
    await expect(persistDeveloper).toHaveCount(1);
    await expect(
      persistDeveloper.getByRole('heading', {
        name: 'Attempt 1',
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      persistDeveloper.getByRole('group', {
        name: 'Developer completion report',
      }),
    ).toHaveCount(1);
    await expect(
      persistDeveloper.getByRole('heading', {
        name: 'Persist Todo items',
        exact: true,
      }),
    ).toHaveCount(2);
    await expect(
      persistDeveloper.getByText('Runtime activity · 0', { exact: true }),
    ).toHaveCount(2);

    expect(retainedWindows.domain.lowWater).toBeGreaterThan(
      staleSnapshot.cursors.domain + 1,
    );
    expect(retainedWindows.runtime.lowWater).toBeGreaterThan(
      staleSnapshot.cursors.runtime + 1,
    );
    const resynced = await fixture.projectSnapshot();
    expect(resynced.developerAttempts).toEqual(beforeResync.developerAttempts);
    expect(resynced.developerReports).toEqual(beforeResync.developerReports);
    expect(resynced.board).toEqual(beforeResync.board);
    expect(resynced.developerAttempts).toHaveLength(2);
    expect(resynced.developerReports).toHaveLength(2);
    expect(new Set(resynced.developerAttempts.map(({ id }) => id)).size).toBe(
      2,
    );
    expect(new Set(resynced.developerReports.map(({ id }) => id)).size).toBe(2);
    const allDomain = await fixture.domainEventsAfter(
      retainedWindows.domain.lowWater - 1,
    );
    expect(allDomain.events.map(({ sequence }) => sequence)).toEqual(
      contiguousAfter(allDomain.lowWater - 1, allDomain.highWater),
    );
    expect(new Set(allDomain.events.map(({ id }) => id)).size).toBe(
      allDomain.events.length,
    );
    const allRuntime = await fixture.runtimeEventsAfter(
      retainedWindows.runtime.lowWater - 1,
    );
    expect(allRuntime.events.map(({ sequence }) => sequence)).toEqual(
      contiguousAfter(allRuntime.lowWater - 1, allRuntime.highWater),
    );
    expect(new Set(allRuntime.events.map(({ id }) => id)).size).toBe(
      allRuntime.events.length,
    );
    for (const ownedPath of [
      fixture.databasePath,
      fixture.todoRepository,
      ...resynced.developerAttempts.map(({ workspace }) => workspace.path),
    ]) {
      const relation = relative(
        resolve(fixture.fixtureRoot),
        resolve(ownedPath),
      );
      expect(relation).not.toBe('');
      expect(relation).not.toBe('..');
      expect(
        relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
      ).toBe(false);
    }
  } finally {
    await fixture.dispose();
  }
});

for (const scenario of ['blocked', 'malformed', 'duplicate'] as const) {
  test(`isolates the ${scenario} Developer report outcome`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const fixture = await V2ProcessFixture.createTodo({
      fakePmScenario: 'todo',
      fakeDeveloperScenario: scenario,
    });
    try {
      await registerTodo(page, fixture);
      await approveTodoIntent(page, fixture);
      await approveTodoDeliveryPlan(page, fixture);
      await approveDeveloperProfile(page, fixture);
      await page.getByRole('tab', { name: 'Board' }).click();

      const beforeStart = await fixture.projectSnapshot();
      const cardBefore = beforeStart.board.cards.find(
        ({ title }) => title === 'Persist Todo items',
      );
      if (!cardBefore) throw new Error('Persist Todo task was not found');
      const board = page.getByRole('tabpanel', { name: 'Board' });
      await board
        .getByRole('button', { name: 'Open Persist Todo items' })
        .click();
      await board
        .getByRole('button', { name: 'Start Developer attempt' })
        .click();

      const expectedLifecycle =
        scenario === 'blocked' ? 'blocked' : 'interrupted';
      await expect
        .poll(
          async () =>
            (await fixture.projectSnapshot()).developerAttempts[0]?.lifecycle,
        )
        .toBe(expectedLifecycle);

      const settled = await fixture.projectSnapshot();
      expect(settled.developerAttempts).toHaveLength(1);
      const attempt = settled.developerAttempts[0];
      if (!attempt) throw new Error('Developer attempt was not recorded');
      expect(attempt).toMatchObject({
        lifecycle: expectedLifecycle,
        ordinal: 1,
        taskId: cardBefore.taskId,
        taskCurrentRevision: cardBefore.taskCurrentRevision,
      });
      expect(attempt.executionIds).toHaveLength(1);
      expect(await fixture.managedTodoArtifact(attempt.id)).toBe('persisted\n');
      expect(
        settled.board.cards.find(({ taskId }) => taskId === cardBefore.taskId),
      ).toMatchObject({
        lifecycle: cardBefore.lifecycle,
        taskCurrentRevision: cardBefore.taskCurrentRevision,
        readiness: { state: 'actionable' },
      });

      const events = await fixture.domainEventsAfter(
        beforeStart.cursors.domain,
      );
      const reports = events.events.filter(
        ({ type }) => type === 'developer_report.recorded',
      );
      if (scenario === 'blocked') {
        expect(settled.developerReports).toHaveLength(1);
        expect(settled.developerReports[0]).toMatchObject({
          report: {
            disposition: 'blocked',
            attemptId: attempt.id,
            executionId: attempt.controllingExecutionId,
            taskId: attempt.taskId,
            taskContractRevision: attempt.taskContractRevision,
            blocker: 'The deterministic fake Developer is blocked.',
            evidence: [
              { summary: 'todo-m4.txt was written before the blocker.' },
            ],
            suggestedNextAction:
              'Resolve the deterministic blocker and replace the execution.',
            preserveWorkspace: true,
            workspace: { headCommit: attempt.baseCommit, dirty: true },
          },
        });
        expect(reports).toHaveLength(1);
        await expect(
          page.getByRole('group', { name: 'Developer blocker report' }),
        ).toContainText('The deterministic fake Developer is blocked.');
        await expect(page.getByLabel('Developer attempt state')).toHaveText(
          'Blocked',
        );
      } else {
        expect(settled.developerReports).toEqual([]);
        expect(attempt.reportIds).toEqual([]);
        expect(reports).toEqual([]);
        await expect(page.getByLabel('Developer attempt state')).toHaveText(
          'Interrupted',
        );
      }
    } finally {
      await fixture.dispose();
    }
  });
}
