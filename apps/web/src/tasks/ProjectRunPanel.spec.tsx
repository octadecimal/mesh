import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  projectRunItemSchema,
  projectRunSchema,
  projectSchema,
  taskActorSchema,
  taskSchema,
  type MutatingCommand,
  type ProjectRun,
  type ProjectRunItem,
  type Task,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { createProjection, type MeshProjection } from '../state/reducer';
import { ProjectRunPanel } from './ProjectRunPanel';

describe('ProjectRunPanel', () => {
  it('previews exact eligible order and effective review modes before authorization', async () => {
    const user = userEvent.setup();
    renderPanel({
      tasks: [
        task({ id: 'task-b', title: 'Ready task B', rank: 'b' }),
        task({
          id: 'task-a',
          title: 'Ready task A',
          rank: 'a',
          reviewAutomation: {
            status: 'enabled',
            generation: 2,
            rejectionCount: 0,
            pauseReason: null,
            updatedAt: timestamp,
          },
        }),
        task({
          id: 'blocked',
          title: 'Blocked task',
          rank: '0',
          blocked: { reason: 'Waiting', actor: operator, blockedAt: timestamp },
        }),
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Start run' }));

    expect(screen.getByLabelText('Concurrency')).toHaveValue(1);
    expect(screen.getByLabelText('Concurrency')).toHaveAttribute('max', '3');
    const preview = screen.getByRole('list', { name: 'Eligible run order' });
    expect(
      within(preview)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/Ready task A.*Autonomous review/),
      expect.stringMatching(/Ready task B.*Manual review/),
    ]);
    expect(screen.queryByText('Blocked task')).toBeNull();
    expect(
      screen.getByText(
        /Concurrent launches consume Claude subscription capacity/i,
      ),
    ).toBeVisible();
    expect(screen.getByText(/QA policy revision 3/i)).toBeVisible();
    expect(screen.getByText(/Mesh-owned isolated Git worktree/i)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Authorize run' }),
    ).toBeDisabled();
  });

  it('requires confirmation again when the ordered preview fingerprint changes', async () => {
    const user = userEvent.setup();
    const rendered = renderPanel({ tasks: [task()] });
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    const confirmation = screen.getByRole('checkbox', {
      name: /subscription capacity/i,
    });
    await user.click(confirmation);
    expect(confirmation).toBeChecked();

    rendered.rerender(
      <ProjectRunPanel
        project={project}
        projection={projection({ tasks: [task({ revision: 2 })] })}
        connected
        maxConcurrency={3}
        onCommand={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    ).not.toBeChecked();
  });

  it.each([
    [
      'project QA policy revision',
      projectSchema.parse({
        ...project,
        qaConfiguration: { ...project.qaConfiguration, revision: 4 },
      }),
      task(),
    ],
    [
      'task automation status',
      project,
      task({
        reviewAutomation: {
          status: 'enabled',
          generation: 0,
          rejectionCount: 0,
          pauseReason: null,
          updatedAt: timestamp,
        },
      }),
    ],
    [
      'task automation generation',
      project,
      task({
        reviewAutomation: {
          status: 'disabled',
          generation: 1,
          rejectionCount: 0,
          pauseReason: null,
          updatedAt: timestamp,
        },
      }),
    ],
  ])(
    'invalidates consent when the %s changes',
    async (_label, nextProject, nextTask) => {
      const user = userEvent.setup();
      const rendered = renderPanel({ tasks: [task()] });
      await user.click(screen.getByRole('button', { name: 'Start run' }));
      await user.click(
        screen.getByRole('checkbox', { name: /subscription capacity/i }),
      );

      rendered.rerender(
        <ProjectRunPanel
          project={nextProject}
          projection={projection({ tasks: [nextTask] })}
          connected
          maxConcurrency={3}
          onCommand={vi.fn()}
          onSelectTask={vi.fn()}
        />,
      );

      expect(
        screen.getByRole('checkbox', { name: /subscription capacity/i }),
      ).not.toBeChecked();
    },
  );

  it('invalidates consent when delimiter-shaped task ids change the preview', async () => {
    const user = userEvent.setup();
    const rendered = renderPanel({
      tasks: [task({ id: 'a:1:disabled:0|b' })],
    });
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await user.click(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    );

    rendered.rerender(
      <ProjectRunPanel
        project={project}
        projection={projection({
          tasks: [task({ id: 'a' }), task({ id: 'b', rank: 'b' })],
        })}
        connected
        maxConcurrency={3}
        onCommand={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    ).not.toBeChecked();
  });

  it('ignores a previous project command settlement after the project changes', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const secondProject = projectSchema.parse({
      ...project,
      id: 'project-2',
      displayName: 'Second project',
    });
    const first = renderPanel({
      tasks: [task()],
      onCommand: vi.fn().mockReturnValue(pending.promise),
    });
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await user.click(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Authorize run' }));

    first.rerender(
      <ProjectRunPanel
        project={secondProject}
        projection={projection({
          tasks: [task({ id: 'task-2', projectId: secondProject.id })],
        })}
        connected
        maxConcurrency={3}
        onCommand={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );
    pending.reject(new Error('First project failed'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('requires explicit subscription confirmation and sends the bounded command without optimistic state', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(pending.promise);
    renderPanel({ tasks: [task()], onCommand });

    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await user.click(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Authorize run' }));

    expect(onCommand).toHaveBeenCalledWith({
      type: 'project.run.start',
      payload: {
        projectId: project.id,
        concurrency: 1,
        expectedPolicyRevision: 3,
        expectedTasks: [
          {
            taskId: 'task-a',
            revision: 1,
            automationStatus: 'disabled',
            automationGeneration: 0,
          },
        ],
        actor: operator,
      },
    });
    expect(
      screen.getByRole('button', { name: 'Authorizing run…' }),
    ).toBeDisabled();
    expect(screen.getByText('Ready task A')).toBeVisible();
    expect(screen.queryByText(/Occupied capacity/i)).toBeNull();

    pending.resolve(undefined);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Authorizing run…' }),
      ).toBeDisabled(),
    );
  });

  it('omits dependency-blocked tasks from the preview and expected task payload', async () => {
    const user = userEvent.setup();
    const prerequisite = task({
      id: 'prerequisite',
      title: 'Incomplete prerequisite',
      rank: '0',
      lifecycleState: 'in_progress',
    });
    const dependent = task({ id: 'dependent', title: 'Dependent', rank: 'b' });
    const actionable = task({ id: 'actionable', title: 'Actionable' });
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderPanel({
      tasks: [prerequisite, dependent, actionable],
      projectionOverrides: {
        dependenciesByTaskId: {
          [dependent.id]: [
            {
              projectId: project.id,
              taskId: dependent.id,
              prerequisiteTaskId: prerequisite.id,
              createdBy: operator,
              createdAt: timestamp,
            },
          ],
        },
      },
      onCommand,
    });

    expect(
      screen.getByText('1 ready task waiting on prerequisites.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    expect(screen.queryByText('Dependent')).toBeNull();
    await user.click(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Authorize run' }));

    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'project.run.start',
        payload: expect.objectContaining({
          expectedTasks: [expect.objectContaining({ taskId: actionable.id })],
        }),
      }),
    );
  });

  it('clears start pending when the first projected run is already completed', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const rendered = renderPanel({
      tasks: [task()],
      onCommand: vi.fn().mockReturnValue(pending.promise),
    });
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await user.click(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Authorize run' }));

    pending.resolve(undefined);
    rendered.rerender(
      <ProjectRunPanel
        project={project}
        projection={projection({
          tasks: [task()],
          runs: [
            run({
              id: 'run-direct-completed',
              revision: 2,
              state: 'completed',
              completionReason: 'queue_finished',
              completedAt: timestamp,
            }),
          ],
        })}
        connected
        maxConcurrency={3}
        onCommand={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Authorize run' }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText('Authorizing run…')).toBeNull();
    expect(screen.getByText('Queue finished')).toBeVisible();
  });

  it('explains empty, disconnected, and archived authorization states', async () => {
    const user = userEvent.setup();
    const rendered = renderPanel({ tasks: [] });
    expect(screen.getByText(/No eligible ready tasks/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();

    rendered.rerender(
      <ProjectRunPanel
        project={project}
        projection={projection({ tasks: [task()] })}
        connected={false}
        maxConcurrency={3}
        onCommand={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );
    expect(screen.getByText(/Run controls are disconnected/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();

    rendered.rerender(
      <ProjectRunPanel
        project={{ ...project, archivedAt: timestamp }}
        projection={projection({ tasks: [task()] })}
        connected
        maxConcurrency={3}
        onCommand={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Archived projects cannot start runs/i),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Start run' }));
    expect(screen.queryByLabelText('Concurrency')).toBeNull();
  });

  it('reports start failures and preserves the authorization form', async () => {
    const user = userEvent.setup();
    const onCommand = vi
      .fn()
      .mockRejectedValue(new Error('The command connection closed.'));
    renderPanel({ tasks: [task()], onCommand });

    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await user.click(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Authorize run' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The command connection closed.',
    );
    expect(screen.getByLabelText('Concurrency')).toHaveValue(1);
  });

  it('shows authoritative capacity, frozen item states, role evidence, and repair messages', () => {
    const activeRun = run({
      concurrency: 3,
      items: [
        item({ id: 'queued-item', taskId: 'queued', queuePosition: 0 }),
        item({
          id: 'launch-item',
          taskId: 'launch',
          queuePosition: 1,
          status: 'launch_pending',
        }),
        item({
          id: 'active-item',
          taskId: 'active',
          queuePosition: 2,
          status: 'active',
          attemptId: 'attempt-active',
          sessionId: 'session-active',
        }),
        item({
          id: 'completed-item',
          taskId: 'completed',
          queuePosition: 3,
          status: 'completed',
          outcomeReason: 'task_done',
        }),
        item({
          id: 'attention-item',
          taskId: 'attention',
          queuePosition: 4,
          status: 'attention_required',
          outcomeReason: 'manual_review_required',
        }),
        item({
          id: 'stopped-item',
          taskId: 'stopped',
          queuePosition: 5,
          status: 'not_started',
          outcomeReason: 'run_stopped',
        }),
      ],
    });
    renderPanel({
      tasks: [
        task({ id: 'queued', title: 'Queued task' }),
        task({ id: 'launch', title: 'Launching task' }),
        task({ id: 'active', title: 'Active task' }),
        task({ id: 'completed', title: 'Completed task' }),
        task({ id: 'attention', title: 'Attention task' }),
        task({ id: 'stopped', title: 'Stopped task' }),
      ],
      runs: [activeRun],
      projectionOverrides: {
        attemptsById: {
          'attempt-active': {
            id: 'attempt-active',
            taskId: 'active',
            sessionId: 'session-active',
            ordinal: 1,
            source: {
              type: 'project_run',
              runId: activeRun.id,
              runItemId: 'active-item',
            },
            actor: { type: 'system', id: 'project-run-orchestrator' },
            createdAt: timestamp,
            unlinkedAt: null,
            unlinkedBy: null,
            unlinkReason: null,
            role: 'developer',
            qaCycles: [],
          },
        },
        developerCyclesByAttemptId: {
          'attempt-active': [developerCycle],
        },
        repairsByProjectId: {
          [project.id]: [
            {
              taskId: 'active',
              attemptId: 'attempt-active',
              sessionId: 'session-active',
              reason: 'startup_outcome_unknown',
            },
          ],
        },
      },
    });

    expect(screen.getByText('2 of 3 occupied')).toBeVisible();
    expect(screen.getByText(/Developer cycle 2/i)).toBeVisible();
    expect(screen.getByText(/Queued task/)).toBeVisible();
    expect(screen.getByText(/Completed task/)).toBeVisible();
    expect(screen.getByText(/Stopped task/)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Active task.*startup outcome is unknown/i,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Task repair/i);
    expect(screen.queryByText(/Run repair/i)).toBeNull();
  });

  it('sends revision-safe pause, resume, and stop commands and explains draining', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const rendered = renderPanel({ runs: [run()], onCommand });

    await user.click(
      screen.getByRole('button', { name: 'Pause new launches' }),
    );
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'project.run.pause',
      payload: { runId: 'run-1', expectedRevision: 4, actor: operator },
    });

    expect(screen.getByRole('button', { name: 'Stop run' })).toBeDisabled();

    rendered.rerender(
      <ProjectRunPanel
        project={project}
        projection={projection({
          runs: [run({ state: 'paused', revision: 5 })],
        })}
        connected
        maxConcurrency={3}
        onCommand={onCommand}
        onSelectTask={vi.fn()}
      />,
    );
    expect(screen.getByText(/operator paused/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(
      screen.getByText(/Active work drains and is not interrupted/i),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm stop run' }));
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'project.run.stop',
      payload: { runId: 'run-1', expectedRevision: 5, actor: operator },
    });

    rendered.rerender(
      <ProjectRunPanel
        project={project}
        projection={projection({
          runs: [run({ state: 'paused', revision: 6 })],
        })}
        connected
        maxConcurrency={3}
        onCommand={onCommand}
        onSelectTask={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Resume run' }));
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'project.run.resume',
      payload: { runId: 'run-1', expectedRevision: 6, actor: operator },
    });
  });

  it('shows stale control errors without changing the projected lifecycle', async () => {
    const user = userEvent.setup();
    renderPanel({
      runs: [run()],
      onCommand: vi.fn().mockRejectedValue({
        code: 'project_run_stale',
        message: 'Run revision 4 is stale.',
      }),
    });

    await user.click(
      screen.getByRole('button', { name: 'Pause new launches' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Run revision 4 is stale.',
    );
    expect(screen.getByText('Running')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Pause new launches' }),
    ).toBeEnabled();
  });

  it('opens attention evidence and preserves completed history in frozen order', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    const completedRun = run({
      id: 'run-history',
      state: 'completed',
      completionReason: 'stopped',
      completedAt: timestamp,
      items: [
        item({
          id: 'history-second',
          runId: 'run-history',
          taskId: 'history-b',
          queuePosition: 1,
          status: 'not_started',
          outcomeReason: 'run_stopped',
        }),
        item({
          id: 'history-first',
          runId: 'run-history',
          taskId: 'history-a',
          queuePosition: 0,
          status: 'attention_required',
          outcomeReason: 'developer_blocked',
        }),
      ],
    });
    renderPanel({
      tasks: [
        task({ id: 'history-a', title: 'History first' }),
        task({ id: 'history-b', title: 'History second' }),
      ],
      runs: [completedRun],
      onSelectTask,
    });

    const history = screen.getByRole('region', { name: 'Run history' });
    expect(within(history).getByText(/Started /)).toBeVisible();
    expect(within(history).queryByText(/Authorized /)).toBeNull();
    expect(within(history).getByText(/Stopped/)).toBeVisible();
    expect(
      within(history).getByText(/0 completed, 1 attention, 1 not started/i),
    ).toBeVisible();
    expect(
      within(history)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/History first.*Attention required/),
      expect.stringMatching(/History second.*Not started/),
    ]);

    await user.click(
      within(history).getByRole('button', {
        name: /Open History first evidence/i,
      }),
    );
    expect(onSelectTask).toHaveBeenCalledWith('history-a');
  });
});

const timestamp = '2026-08-27T00:00:00.000Z';
const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
});
const project = projectSchema.parse({
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:\\mesh',
  discoveredAt: timestamp,
  qaConfiguration: {
    instructions: {
      content: '',
      revision: 1,
      updatedAt: timestamp,
      updatedBy: null,
    },
    reviewPolicy: 'autonomous_review',
    revision: 3,
    updatedAt: timestamp,
    updatedBy: operator,
  },
});

const task = (overrides: Partial<Task> = {}) =>
  taskSchema.parse({
    id: 'task-a',
    projectId: project.id,
    title: 'Ready task A',
    description: 'Run the task.',
    acceptanceCriteria: ['The task finishes.'],
    priority: 'normal',
    rank: 'a',
    lifecycleState: 'ready',
    labels: [],
    notes: '',
    blocked: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });

const item = (
  overrides: Partial<ProjectRunItem> & Pick<ProjectRunItem, 'id' | 'taskId'>,
) => {
  const status = overrides.status ?? 'queued';
  const lifecycle =
    status === 'launch_pending'
      ? { claimedAt: timestamp }
      : status === 'active' || status === 'completed'
        ? {
            claimedAt: timestamp,
            startedAt: timestamp,
            ...(status === 'completed' ? { finishedAt: timestamp } : {}),
            attemptId: overrides.attemptId ?? `attempt-${overrides.id}`,
            sessionId: overrides.sessionId ?? `session-${overrides.id}`,
          }
        : status === 'attention_required'
          ? { claimedAt: timestamp, finishedAt: timestamp }
          : status === 'not_started'
            ? { finishedAt: timestamp }
            : {};
  return projectRunItemSchema.parse({
    id: overrides.id,
    runId: 'run-1',
    projectId: project.id,
    taskId: overrides.taskId,
    taskRevision: 1,
    policyRevision: 3,
    taskAutomationStatus: 'disabled',
    taskAutomationGeneration: 0,
    queuePosition: 0,
    status: 'queued',
    attemptId: null,
    sessionId: null,
    launchIdempotencyKey: `launch-${overrides.id}`,
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    outcomeReason: null,
    ...lifecycle,
    ...overrides,
  });
};

const run = (overrides: Partial<ProjectRun> = {}) =>
  projectRunSchema.parse({
    id: 'run-1',
    projectId: project.id,
    revision: 4,
    concurrency: 2,
    state: 'running',
    pauseReason: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    completionReason: null,
    completedAt: null,
    items: [],
    ...overrides,
    pauseReason:
      overrides.state === 'paused'
        ? (overrides.pauseReason ?? 'operator_paused')
        : null,
  });

const developerCycle: MeshProjection['developerCyclesByAttemptId'][string][number] =
  {
    id: 'developer-cycle',
    attemptId: 'attempt-active',
    ordinal: 2,
    mode: 'new',
    authorizedBy: operator,
    authorizationCommandId: 'command-1',
    policyVersion: 'developer-v1',
    projectInstructions: { content: '', revision: 1 },
    taskSnapshot: {
      revision: 1,
      title: 'Active task',
      description: 'Run the task.',
      acceptanceCriteria: [{ id: 'criterion-1', text: 'It works.' }],
    },
    workspaceId: 'workspace-1',
    permissionMode: 'interactive',
    startedAt: timestamp,
    endedAt: null,
    terminalDisposition: null,
    completionReportId: null,
    blockerReportId: null,
    terminalCommandId: null,
    terminalEventId: null,
  };

const projection = ({
  tasks = [],
  runs = [],
  overrides = {},
}: {
  tasks?: Task[];
  runs?: ProjectRun[];
  overrides?: Partial<MeshProjection>;
} = {}): MeshProjection => ({
  ...createProjection({
    protocolVersion: 1,
    projects: [project],
    workspaces: [],
    sessions: [],
    events: [],
    pendingApprovals: [],
    lastSequenceBySession: {},
    layouts: [],
  }),
  tasksById: Object.fromEntries(
    tasks.map((candidate) => [candidate.id, candidate]),
  ),
  projectRunsById: Object.fromEntries(
    runs.map((candidate) => [candidate.id, candidate]),
  ),
  projectRunIdsByProjectId: { [project.id]: runs.map(({ id }) => id) },
  projectRunMaxConcurrencyByProjectId: { [project.id]: 3 },
  ...overrides,
});

const renderPanel = ({
  tasks = [],
  runs = [],
  connected = true,
  onCommand = vi.fn().mockResolvedValue(undefined),
  onSelectTask = vi.fn(),
  projectionOverrides = {},
}: {
  tasks?: Task[];
  runs?: ProjectRun[];
  connected?: boolean;
  onCommand?: (command: MutatingCommand) => Promise<unknown> | void;
  onSelectTask?: (taskId: string) => void;
  projectionOverrides?: Partial<MeshProjection>;
} = {}) =>
  render(
    <ProjectRunPanel
      project={project}
      projection={projection({
        tasks,
        runs,
        overrides: projectionOverrides,
      })}
      connected={connected}
      maxConcurrency={3}
      onCommand={onCommand}
      onSelectTask={onSelectTask}
    />,
  );

const deferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
