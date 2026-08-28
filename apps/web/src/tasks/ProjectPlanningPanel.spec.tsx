import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  projectPlanDetailsSchema,
  projectPlanSchema,
  projectPlanSummarySchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskSchema,
  type MutatingCommand,
  type ProjectPlan,
  type ProjectPlanDetails,
  type ProjectPlanHistoryPage,
  type ProjectPlanSummary,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { createProjection, type MeshProjection } from '../state/reducer';
import { ProjectPlanningPanel } from './ProjectPlanningPanel';

describe('ProjectPlanningPanel', () => {
  it('starts read-only planning with explicit subscription consent and waits for authoritative state', async () => {
    const user = userEvent.setup();
    const request = deferred<unknown>();
    const onCommand = vi.fn(() => request.promise);
    const rendered = renderPanel({ onCommand });

    expect(
      screen.getByText(
        'The PM can read this repository but cannot edit files, change tasks, approve plans, or launch work.',
      ),
    ).toBeVisible();
    const start = screen.getByRole('button', { name: 'Start planning' });
    expect(start).toBeDisabled();

    await user.type(screen.getByLabelText('Project goal'), 'Plan milestone 7');
    await user.type(
      screen.getByLabelText('Planning constraints'),
      'Preserve audit order\nStay read-only',
    );
    await user.type(
      screen.getByLabelText('Planning non-goals'),
      'Do not launch work',
    );
    await user.click(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    );
    await user.click(start);

    expect(onCommand).toHaveBeenCalledWith({
      type: 'project.plan.start',
      payload: {
        projectId: project.id,
        expectedProjectRevision: project.revision,
        goal: 'Plan milestone 7',
        constraints: ['Preserve audit order', 'Stay read-only'],
        nonGoals: ['Do not launch work'],
        actor,
      },
    });
    expect(
      screen.getByRole('button', { name: 'Starting planning…' }),
    ).toBeDisabled();
    expect(screen.queryByText('Planning in progress')).toBeNull();

    await act(async () => request.resolve(undefined));
    expect(
      screen.getByRole('button', { name: 'Starting planning…' }),
    ).toBeDisabled();

    rendered.rerender(panel({ activePlan: plan() }));
    expect(screen.getByText('Planning in progress')).toBeVisible();
  });

  it('gates start controls when disconnected or archived and reports command errors', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockRejectedValue(new Error('Planning refused.'));
    const rendered = renderPanel({ connected: false, onCommand });

    expect(
      screen.getByText(/planning controls are disconnected or stale/i),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Start planning' }),
    ).toBeDisabled();

    rendered.rerender(
      panel({
        projectValue: { ...project, archivedAt: timestamp },
        connected: true,
        onCommand,
      }),
    );
    expect(
      screen.getByText(/archived projects cannot start or control planning/i),
    ).toBeVisible();

    rendered.rerender(panel({ onCommand }));
    await user.type(screen.getByLabelText('Project goal'), 'Plan safely');
    await user.click(
      screen.getByRole('checkbox', { name: /subscription capacity/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Start planning' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Planning refused.',
    );
  });

  it('shows authoritative lifecycle, associated session, attention evidence, and recovery actions', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    const rendered = renderPanel({
      activePlan: plan(),
      onOpenSession,
    });

    expect(screen.getByText('Planning in progress')).toBeVisible();
    expect(screen.getByText('Preserve current APIs')).toBeVisible();
    expect(screen.getByText('Do not deploy')).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Open PM planning session' }),
    );
    expect(onOpenSession).toHaveBeenCalledWith(pmSession.id);
    expect(
      screen.getByRole('button', { name: 'Cancel planning' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull();

    rendered.rerender(
      panel({ activePlan: plan({ status: 'revising', revision: 5 }) }),
    );
    expect(screen.getByText('Revision in progress')).toBeVisible();

    rendered.rerender(
      panel({
        activePlan: plan({
          status: 'attention_required',
          revision: 6,
          attention: {
            type: 'runtime_failure',
            message: 'The PM runtime stopped before submitting.',
          },
        }),
      }),
    );
    expect(screen.getByText('Planning needs attention')).toBeVisible();
    expect(
      screen.getByText('The PM runtime stopped before submitting.'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Resume planning' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Retry planning' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reject plan' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Cancel planning' }),
    ).toBeVisible();
  });

  it('loads proposal details on demand and renders ordered contracts and accessible dependency evidence', async () => {
    const user = userEvent.setup();
    const request = deferred<ProjectPlanDetails>();
    const loadDetails = vi.fn(() => request.promise);
    renderPanel({
      activePlan: plan({ status: 'awaiting_review' }),
      loadDetails,
    });

    expect(loadDetails).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Review proposal' }));
    expect(loadDetails).toHaveBeenCalledWith(project.id, 'plan-1');
    expect(screen.getByText('Loading proposal…')).toBeVisible();

    await act(async () => request.resolve(details));
    const proposed = screen.getByRole('list', { name: 'Proposed tasks' });
    expect(
      within(proposed)
        .getAllByRole('button', { name: /Expand proposed task/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Expand proposed task Foundation',
      'Expand proposed task Delivery',
    ]);

    await user.click(
      screen.getByRole('button', { name: 'Expand proposed task Foundation' }),
    );
    expect(screen.getByText('Create the durable boundary.')).toBeVisible();
    expect(screen.getByText('Enables safe delivery.')).toBeVisible();
    expect(
      screen.getByRole('list', { name: 'Foundation prerequisites' }),
    ).toHaveTextContent('Existing backlog');
    expect(
      screen.getByRole('list', { name: 'Foundation dependents' }),
    ).toHaveTextContent('Delivery');
    expect(
      screen.getByRole('list', { name: 'Delivery prerequisites' }),
    ).toHaveTextContent('Foundation');
    expect(
      screen.getByRole('list', { name: 'Plan assumptions' }),
    ).toHaveTextContent('Contracts remain stable.');
    expect(screen.getByRole('list', { name: 'Plan risks' })).toHaveTextContent(
      'Board state may change.',
    );
    expect(
      screen.getByRole('list', { name: 'Plan exclusions' }),
    ).toHaveTextContent('No deployment.');
    expect(
      screen.getByRole('list', { name: 'Proposal revisions' }),
    ).toHaveTextContent('Revision 2');
    expect(
      screen.getByRole('list', { name: 'Operator feedback' }),
    ).toHaveTextContent('Split foundation from delivery.');
  });

  it('uses the authoritative proposal and plan revisions for approve, revise, reject, cancel, resume, and retry', async () => {
    const user = userEvent.setup();
    const onCommand = vi
      .fn()
      .mockRejectedValue(new Error('Keep controls available.'));
    const rendered = renderPanel({
      activePlan: plan({ status: 'awaiting_review', revision: 7 }),
      loadDetails: vi.fn().mockResolvedValue(details),
      onCommand,
    });
    await user.click(screen.getByRole('button', { name: 'Review proposal' }));
    await screen.findByRole('button', {
      name: 'Expand proposed task Foundation',
    });

    await user.click(screen.getByRole('button', { name: 'Approve plan' }));
    await screen.findByRole('alert');
    expect(onCommand).toHaveBeenNthCalledWith(1, {
      type: 'project.plan.approve',
      payload: {
        projectId: project.id,
        planId: 'plan-1',
        proposalId: 'proposal-2',
        expectedPlanRevision: 7,
        actor,
      },
    });

    await user.type(
      screen.getByLabelText('Revision feedback'),
      'Separate the transport work.',
    );
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(onCommand).toHaveBeenNthCalledWith(2, {
      type: 'project.plan.request_revision',
      payload: {
        projectId: project.id,
        planId: 'plan-1',
        expectedPlanRevision: 7,
        feedback: 'Separate the transport work.',
        actor,
      },
    });

    await user.type(screen.getByLabelText('Rejection reason'), 'Wrong scope.');
    await user.click(screen.getByRole('button', { name: 'Reject plan' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(3));
    expect(onCommand).toHaveBeenNthCalledWith(3, {
      type: 'project.plan.reject',
      payload: {
        projectId: project.id,
        planId: 'plan-1',
        expectedPlanRevision: 7,
        reason: 'Wrong scope.',
        actor,
      },
    });

    rendered.rerender(
      panel({
        activePlan: plan({ status: 'attention_required', revision: 9 }),
        onCommand,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Resume planning' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(4));
    expect(onCommand).toHaveBeenNthCalledWith(4, controlCommand('resume', 9));
    await user.click(screen.getByRole('button', { name: 'Retry planning' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(5));
    expect(onCommand).toHaveBeenNthCalledWith(5, controlCommand('retry', 9));

    await user.type(
      screen.getByLabelText('Cancellation reason'),
      'Operator changed direction.',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel planning' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(6));
    expect(onCommand).toHaveBeenNthCalledWith(6, {
      type: 'project.plan.cancel',
      payload: {
        projectId: project.id,
        planId: 'plan-1',
        expectedPlanRevision: 9,
        reason: 'Operator changed direction.',
        actor,
      },
    });
  });

  it('shows bounded stale evidence with exact totals and truncation', () => {
    renderPanel({
      activePlan: plan({
        status: 'attention_required',
        attention: {
          type: 'stale_board',
          addedTaskIds: Array.from(
            { length: 50 },
            (_, index) => `added-${index}`,
          ),
          addedTaskTotal: 60,
          addedTaskIdsTruncated: true,
          removedTaskIds: ['removed-1'],
          removedTaskTotal: 1,
          removedTaskIdsTruncated: false,
          changedTaskIds: ['changed-1'],
          changedTaskTotal: 1,
          changedTaskIdsTruncated: false,
          dependenciesChanged: true,
          policyChanged: true,
        },
      }),
    });

    expect(
      screen.getByText('Added tasks: 60 total; showing 50.'),
    ).toBeVisible();
    expect(screen.getByText('Removed tasks: 1 total.')).toBeVisible();
    expect(screen.getByText('Changed tasks: 1 total.')).toBeVisible();
    expect(screen.getByText('Dependencies changed.')).toBeVisible();
    expect(screen.getByText('Project policy changed.')).toBeVisible();
  });

  it('supports detail error, empty, refresh, and 20-summary paginated history states', async () => {
    const user = userEvent.setup();
    const summaries = Array.from({ length: 20 }, (_, index) =>
      summary(`history-${index}`, index),
    );
    const loadDetails = vi
      .fn<(_: string, __: string) => Promise<ProjectPlanDetails>>()
      .mockRejectedValueOnce(new Error('Details unavailable.'))
      .mockResolvedValueOnce({ ...details, proposals: [] })
      .mockResolvedValue(details);
    const loadHistory = vi
      .fn<(_: string, __?: string) => Promise<ProjectPlanHistoryPage>>()
      .mockResolvedValue({
        plans: [summary('history-20', 20), summary('history-21', 21)],
      });
    renderPanel({ summaries, loadDetails, loadHistory });

    expect(
      screen.getAllByRole('button', { name: /View plan history/i }),
    ).toHaveLength(20);
    await user.click(
      screen.getByRole('button', { name: 'View Plan history 0' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Details unavailable.',
    );
    await user.click(
      screen.getByRole('button', { name: 'Retry loading plan' }),
    );
    expect(
      await screen.findByText('No proposal revisions were recorded.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Refresh proposal' }));
    expect(
      await screen.findByRole('button', {
        name: 'Expand proposed task Foundation',
      }),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Load older plans' }));
    expect(loadHistory).toHaveBeenCalledWith(project.id, 'history-19');
    expect(
      screen.getAllByRole('button', { name: /View plan history/i }),
    ).toHaveLength(22);
  });

  it('retains the displaced 20th summary across an authoritative window refresh', async () => {
    const user = userEvent.setup();
    const initialSummaries = Array.from({ length: 20 }, (_, index) =>
      summary(`history-${index}`, index),
    );
    const refreshedSummaries = [
      summary('history-new', 23),
      ...initialSummaries.slice(0, 19),
    ];
    const loadHistory = vi
      .fn<(_: string, __?: string) => Promise<ProjectPlanHistoryPage>>()
      .mockResolvedValue({ plans: [summary('history-20', 20)] });
    const rendered = renderPanel({
      summaries: initialSummaries,
      loadHistory,
    });

    rendered.rerender(panel({ summaries: refreshedSummaries, loadHistory }));

    expect(
      await screen.findByRole('button', { name: 'View Plan history 19' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Load older plans' }));
    expect(loadHistory).toHaveBeenCalledWith(project.id, 'history-19');
    expect(
      await screen.findByRole('button', { name: 'View Plan history 20' }),
    ).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: /View Plan history/i }),
    ).toHaveLength(22);
  });

  it('bridges a non-overlapping authoritative history window before continuing older pages', async () => {
    const user = userEvent.setup();
    const terminalSummary = (
      id: string,
      index: number,
      minutesAfterNewest: number,
    ) => {
      const terminalAt = new Date(
        Date.parse('2026-08-28T00:00:00.000Z') - minutesAfterNewest * 60_000,
      ).toISOString();
      return projectPlanSummarySchema.parse({
        ...summary(id, index),
        updatedAt: terminalAt,
        terminalAt,
      });
    };
    const oldWindow = Array.from({ length: 20 }, (_, index) =>
      terminalSummary(`old-${index}`, 100 + index, 59 + index),
    );
    const newWindow = Array.from({ length: 20 }, (_, index) =>
      terminalSummary(`new-${index}`, index, index),
    );
    const firstBridgePage = Array.from({ length: 20 }, (_, index) =>
      terminalSummary(`gap-a-${index}`, 20 + index, 20 + index),
    );
    const secondBridgePage = [
      ...Array.from({ length: 19 }, (_, index) =>
        terminalSummary(`gap-b-${index}`, 40 + index, 40 + index),
      ),
      oldWindow[0],
    ];
    const firstPage = deferred<ProjectPlanHistoryPage>();
    const loadHistory = vi
      .fn<(_: string, __?: string) => Promise<ProjectPlanHistoryPage>>()
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce({
        plans: secondBridgePage,
        nextAfter: secondBridgePage.at(-1)?.id,
      })
      .mockResolvedValueOnce({
        plans: [terminalSummary('older-0', 120, 79)],
      });
    const rendered = renderPanel({ summaries: oldWindow, loadHistory });

    rendered.rerender(panel({ summaries: newWindow, loadHistory }));
    await user.click(screen.getByRole('button', { name: 'Load older plans' }));

    expect(loadHistory).toHaveBeenNthCalledWith(1, project.id, 'new-19');
    expect(
      screen.getByRole('button', { name: 'Loading older plans…' }),
    ).toBeDisabled();

    await act(async () => {
      firstPage.resolve({
        plans: firstBridgePage,
        nextAfter: firstBridgePage.at(-1)?.id,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Load older plans' }));
    expect(loadHistory).toHaveBeenNthCalledWith(2, project.id, 'gap-a-19');
    expect(
      await screen.findByRole('button', { name: 'View Plan history 58' }),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Load older plans' }));
    expect(loadHistory).toHaveBeenNthCalledWith(3, project.id, 'old-19');
    expect(
      await screen.findByRole('button', { name: 'View Plan history 120' }),
    ).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: /View Plan history/i }),
    ).toHaveLength(80);
    expect(
      screen
        .getByRole('button', { name: 'View Plan history 20' })
        .compareDocumentPosition(
          screen.getByRole('button', { name: 'View Plan history 100' }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Load older plans' }),
    ).toBeNull();

    const otherProject = projectSchema.parse({
      ...project,
      id: 'project-2',
      displayName: 'Other project',
      repositoryPath: 'C:\\other',
      repositoryIdentity: 'other',
    });
    rendered.rerender(panel({ projectValue: otherProject, loadHistory }));
    expect(screen.getByText('No completed plans yet.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /View Plan history/i }),
    ).toBeNull();
  });

  it('opens the proposal session from historical plan details', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    renderPanel({
      summaries: [summary('history-1', 1)],
      loadDetails: vi.fn().mockResolvedValue(details),
      onOpenSession,
    });

    await user.click(
      screen.getByRole('button', { name: 'View Plan history 1' }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Open proposal session' }),
    );

    expect(onOpenSession).toHaveBeenCalledWith(pmSession.id);
  });

  it('shows an explicit empty history state', () => {
    renderPanel();
    expect(screen.getByText('No completed plans yet.')).toBeVisible();
  });
});

const timestamp = '2026-08-27T12:00:00.000Z';
const later = '2026-08-27T13:00:00.000Z';
const actor = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
});
const project = projectSchema.parse({
  id: 'project-1',
  displayName: 'Mesh',
  repositoryPath: 'C:\\mesh',
  repositoryIdentity: 'mesh',
  discoveredAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const pmSession = sessionSchema.parse({
  id: 'pm-session-1',
  projectId: project.id,
  workspaceId: 'workspace-1',
  title: 'PM planning session',
  permissionMode: 'interactive',
  lifecycleState: 'running',
  createdAt: timestamp,
  updatedAt: timestamp,
});
const existingTask = taskSchema.parse({
  id: 'existing-task',
  projectId: project.id,
  title: 'Existing backlog',
  description: 'Existing work.',
  acceptanceCriteria: ['Existing work remains visible.'],
  priority: 'normal',
  rank: 'a',
  lifecycleState: 'backlog',
  labels: [],
  notes: '',
  blocked: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const plan = (overrides: Partial<ProjectPlan> = {}) =>
  projectPlanSchema.parse({
    id: 'plan-1',
    projectId: project.id,
    goal: 'Plan milestone 7',
    constraints: ['Preserve current APIs'],
    nonGoals: ['Do not deploy'],
    policyVersion: 'pm-v1',
    status: 'planning',
    revision: 4,
    currentBaseId: 'base-2',
    currentSessionId: pmSession.id,
    latestProposalOrdinal: 2,
    feedback: [],
    attention: null,
    createdBy: actor,
    createdAt: timestamp,
    updatedAt: later,
    terminalAt: null,
    terminalBy: null,
    terminalReason: null,
    ...overrides,
  });

const details = projectPlanDetailsSchema.parse({
  plan: plan({ status: 'awaiting_review' }),
  bases: [
    {
      id: 'base-2',
      planId: 'plan-1',
      ordinal: 2,
      repositoryIdentity: 'mesh',
      tasks: [
        {
          id: existingTask.id,
          revision: existingTask.revision,
          lifecycleState: existingTask.lifecycleState,
          blocked: null,
        },
      ],
      dependencies: [],
      projectArchivedAt: null,
      projectRevision: project.revision,
      policyRevision: 1,
      createdAt: timestamp,
    },
  ],
  proposals: [
    {
      id: 'proposal-1',
      planId: 'plan-1',
      baseId: 'base-2',
      ordinal: 1,
      planRevision: 3,
      capabilityGeneration: 1,
      sessionId: pmSession.id,
      tasks: [
        {
          key: 'foundation',
          title: 'Foundation',
          description: 'Create the first boundary.',
          acceptanceCriteria: ['Boundary exists.'],
          priority: 'high',
          labels: ['planning'],
          rationale: 'Establishes the base.',
          goalMapping: 'Starts delivery.',
        },
      ],
      dependencies: [],
      assumptions: [],
      risks: [],
      exclusions: [],
      submittedAt: timestamp,
    },
    {
      id: 'proposal-2',
      planId: 'plan-1',
      baseId: 'base-2',
      ordinal: 2,
      planRevision: 4,
      capabilityGeneration: 2,
      sessionId: pmSession.id,
      tasks: [
        {
          key: 'foundation',
          title: 'Foundation',
          description: 'Create the durable boundary.',
          acceptanceCriteria: ['Contracts parse.', 'Audit order is preserved.'],
          priority: 'high',
          labels: ['planning'],
          rationale: 'Makes later work safe.',
          goalMapping: 'Enables safe delivery.',
        },
        {
          key: 'delivery',
          title: 'Delivery',
          description: 'Wire the operator flow.',
          acceptanceCriteria: ['The workflow is accessible.'],
          priority: 'normal',
          labels: ['web'],
          rationale: 'Lets the operator approve work.',
          goalMapping: 'Completes milestone 7.',
        },
      ],
      dependencies: [
        {
          dependentTaskKey: 'foundation',
          prerequisite: { type: 'existing_task', taskId: existingTask.id },
        },
        {
          dependentTaskKey: 'delivery',
          prerequisite: { type: 'proposal_task', taskKey: 'foundation' },
        },
      ],
      assumptions: ['Contracts remain stable.'],
      risks: ['Board state may change.'],
      exclusions: ['No deployment.'],
      submittedAt: later,
    },
  ],
  feedback: [
    {
      id: 'feedback-1',
      planId: 'plan-1',
      proposalId: 'proposal-1',
      content: 'Split foundation from delivery.',
      actor,
      createdAt: later,
    },
  ],
});

const summary = (id: string, index: number): ProjectPlanSummary =>
  projectPlanSummarySchema.parse({
    id,
    projectId: project.id,
    goal: `Plan history ${index}`,
    status: index % 2 === 0 ? 'approved' : 'rejected',
    revision: 2,
    latestProposalOrdinal: 1,
    createdAt: timestamp,
    updatedAt: later,
    terminalAt: `2026-08-27T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
  });

const projection = (
  activePlan?: ProjectPlan,
  summaries: ProjectPlanSummary[] = [],
): MeshProjection => ({
  ...createProjection({
    protocolVersion: 1,
    projects: [project],
    workspaces: [],
    sessions: [pmSession],
    events: [],
    pendingApprovals: [],
    lastSequenceBySession: {},
    layouts: [],
  }),
  tasksById: { [existingTask.id]: existingTask },
  activePlanByProjectId: activePlan ? { [project.id]: activePlan } : {},
  planSummariesByProjectId: { [project.id]: summaries },
});

const defaultLoadDetails = vi.fn().mockResolvedValue(details);

const panel = ({
  projectValue = project,
  activePlan,
  summaries = [],
  connected = true,
  loadDetails = defaultLoadDetails,
  loadHistory,
  onCommand = vi.fn().mockResolvedValue(undefined),
  onOpenSession,
}: {
  projectValue?: typeof project;
  activePlan?: ProjectPlan;
  summaries?: ProjectPlanSummary[];
  connected?: boolean;
  loadDetails?: (
    projectId: string,
    planId: string,
  ) => Promise<ProjectPlanDetails>;
  loadHistory?: (
    projectId: string,
    before?: string,
  ) => Promise<ProjectPlanHistoryPage>;
  onCommand?: (command: MutatingCommand) => Promise<unknown> | void;
  onOpenSession?: (sessionId: string) => void;
} = {}) => (
  <ProjectPlanningPanel
    project={projectValue}
    projection={projection(activePlan, summaries)}
    connected={connected}
    loadDetails={loadDetails}
    loadHistory={loadHistory}
    onCommand={onCommand}
    onOpenSession={onOpenSession}
  />
);

const renderPanel = (options: Parameters<typeof panel>[0] = {}) =>
  render(panel(options));

const controlCommand = (kind: 'resume' | 'retry', revision: number) => ({
  type: `project.plan.${kind}`,
  payload: {
    projectId: project.id,
    planId: 'plan-1',
    expectedPlanRevision: revision,
    actor,
  },
});

const deferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
