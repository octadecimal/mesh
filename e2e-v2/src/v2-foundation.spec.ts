import { access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

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

const registerTodo = async (page: Page, fixture: V2ProcessFixture) => {
  await fixture.start();
  await page.goto(fixture.origin);
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

  const planning = page.getByRole('complementary', { name: 'PM Chat' });
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
    planning.getByRole('heading', {
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

  await planning.getByRole('button', { name: 'Request revision' }).click();
  await planning
    .getByRole('textbox', { name: 'Message to project manager' })
    .last()
    .fill(
      'Make keyboard acceptance explicit and persistence verification isolated.',
    );
  await planning.getByRole('button', { name: 'Send revision request' }).click();
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
    planning.getByRole('heading', {
      name: 'Proposal revision 2 · awaiting approval',
    }),
  ).toBeVisible();
  const proposalRevision = planning.getByLabel('Proposal revision', {
    exact: true,
  });
  await proposalRevision.selectOption('1');
  await expect(
    planning.getByRole('heading', { name: 'Proposal revision 1 · superseded' }),
  ).toBeVisible();
  await expect(
    planning.getByText(
      'A keyboard user can add and complete a Todo item without a pointer.',
    ),
  ).toHaveCount(0);
  await proposalRevision.selectOption('2');
  await expect(
    planning.getByText(
      'A keyboard user can add and complete a Todo item without a pointer.',
    ),
  ).toBeVisible();

  const beforeApproval = await fixture.projectSnapshot();
  expect(beforeApproval.deliveryPlan).toBeNull();
  expect(beforeApproval.board.cards).toEqual([]);
  const approvalResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v2/commands') &&
      response.request().postData()?.includes('plan_proposal.approve') === true,
  );
  await planning.getByRole('button', { name: 'Approve full plan' }).click();
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

test('conversation becomes an approved intent ledger', async ({ page }) => {
  const fixture = await V2ProcessFixture.createTodo({ fakePmScenario: 'todo' });
  try {
    await fixture.start();
    await page.goto(fixture.origin);
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
    await expect(page.getByLabel('Project manager profile')).toContainText(
      'Project manager · revision 1',
    );
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
        'Requirements',
        'Decisions',
        'Assumptions',
        'Questions',
        'Risks',
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

    const resynced = await fixture.forceProjectResync(page);
    const resyncedConversation = page.getByRole('list', {
      name: 'Planning conversation',
    });
    for (const message of [
      firstDescription,
      'I need two details before proposing Todo intent.',
      answer,
    ]) {
      await expect(resyncedConversation).toContainText(message);
    }
    const resyncedQuestions = page.getByRole('region', {
      name: 'Planning questions',
    });
    for (const prompt of [
      'How should Todo items persist?',
      'Should all Todo controls be keyboard operable?',
    ]) {
      await expect(
        resyncedQuestions.getByRole('heading', { name: prompt }),
      ).toBeVisible();
    }
    await page.getByRole('tab', { name: 'Requirements' }).click();
    await expectRequirementsProjection();
    expect(resynced.intentLedger).toEqual(approved.intentLedger);
    expect(resynced.planningCycles[0]?.turns).toEqual(
      approved.planningCycles[0]?.turns,
    );

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
      .getByRole('button', { name: 'View Integrate Todo workflow details' })
      .click();
    const details = board.getByRole('region', { name: 'Task details' });
    await expect(
      details.getByRole('heading', { name: 'Task details' }),
    ).toBeFocused();
    await expect(details).toContainText(
      'Acceptance: Adding, reloading, and completing a Todo item works end to end.',
    );
    await expect(details).toContainText(
      'Verification: Run the integrated Todo acceptance journey.',
    );
    await expect(details).toContainText('Owned surfaces: Todo integration');
    await expect(details).toContainText(
      'Milestone stop condition: The integrated Todo flow passes its acceptance and verification criteria.',
    );
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
    await page.goto(`${origin}/projects/${fixture.projectId}`);
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
