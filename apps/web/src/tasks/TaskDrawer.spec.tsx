import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  taskTransitionSchema,
  type MutatingCommand,
  type DeveloperCompletionReport,
  type DeveloperExecutionCycle,
  type Project,
  type Session,
  type Task,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { TaskDrawer } from './TaskDrawer';

describe('TaskDrawer', () => {
  it('composes the QA workflow into task detail', () => {
    renderDrawer();

    expect(screen.getByRole('region', { name: 'QA workflow' })).toBeVisible();
  });

  it('creates a lightweight backlog task from its title', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderDrawer({ task: undefined, onCommand });

    await user.type(screen.getByLabelText('Task title'), 'Investigate race');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.create',
      payload: {
        projectId: project.id,
        title: 'Investigate race',
        actor,
      },
    });
  });

  it('edits execution-readiness fields', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderDrawer({ onCommand });

    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), 'Ship the drawer.');
    await user.clear(screen.getByLabelText('Acceptance criteria'));
    await user.type(
      screen.getByLabelText('Acceptance criteria'),
      'Edits persist{enter}Attempts are visible',
    );
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.clear(screen.getByLabelText('Labels'));
    await user.type(screen.getByLabelText('Labels'), 'frontend, ux');
    await user.click(screen.getByRole('button', { name: 'Save task' }));

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.edit',
      payload: {
        taskId: task.id,
        expectedRevision: 1,
        patch: {
          title: 'Drawer task',
          description: 'Ship the drawer.',
          acceptanceCriteria: ['Edits persist', 'Attempts are visible'],
          priority: 'high',
          labels: ['frontend', 'ux'],
        },
        actor,
      },
    });
  });

  it('preserves a draft and requires an explicit retry against the server revision', async () => {
    const user = userEvent.setup();
    const serverTask = taskSchema.parse({
      ...task,
      title: 'Server title',
      description: 'Server description',
      acceptanceCriteria: ['Server criterion'],
      priority: 'urgent',
      labels: ['server'],
      revision: 2,
      updatedAt: '2026-08-25T01:00:00.000Z',
    });
    const onCommand = vi
      .fn()
      .mockRejectedValueOnce({
        code: 'task_revision_conflict',
        message: 'Task changed',
        details: { task: serverTask },
      })
      .mockResolvedValueOnce(undefined);
    renderDrawer({ onCommand });

    await user.clear(screen.getByLabelText('Task title'));
    await user.type(screen.getByLabelText('Task title'), 'Local title');
    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), 'My local draft');
    await user.clear(screen.getByLabelText('Acceptance criteria'));
    await user.type(
      screen.getByLabelText('Acceptance criteria'),
      'Local criterion',
    );
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.clear(screen.getByLabelText('Labels'));
    await user.type(screen.getByLabelText('Labels'), 'local');
    await user.click(screen.getByRole('button', { name: 'Save task' }));

    const conflict = await screen.findByRole('alert');
    expect(conflict).toHaveTextContent('Server version');
    expect(conflict).toHaveTextContent('Draft');
    expect(conflict).toHaveTextContent('Local title');
    expect(conflict).toHaveTextContent('Server title');
    expect(conflict).toHaveTextContent('Server description');
    expect(conflict).toHaveTextContent('Server criterion');
    expect(conflict).toHaveTextContent('Urgent');
    expect(conflict).toHaveTextContent('server');
    expect(screen.getByLabelText('Description')).toHaveValue('My local draft');
    expect(onCommand).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole('button', { name: 'Retry with server revision' }),
    );

    expect(onCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'task.edit',
        payload: expect.objectContaining({ expectedRevision: 2 }),
      }),
    );
  });

  it('does not turn a non-edit revision conflict into an edit retry', async () => {
    const user = userEvent.setup();
    const serverTask = taskSchema.parse({ ...task, revision: 2 });
    const onCommand = vi.fn().mockRejectedValue({
      code: 'task_revision_conflict',
      message: 'Task changed',
      details: { task: serverTask },
    });
    renderDrawer({ onCommand });

    await user.click(screen.getByRole('button', { name: 'Block task' }));
    await user.type(screen.getByLabelText('Action reason'), 'Waiting');
    await user.click(screen.getByRole('button', { name: 'Confirm block' }));

    const conflict = await screen.findByRole('alert');
    expect(conflict).toHaveTextContent('Block task conflicted');
    expect(conflict).toHaveTextContent('re-invoke the action after resync');
    expect(
      screen.queryByRole('button', { name: 'Retry with server revision' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm block' })).toBeNull();
  });

  it('explains missing readiness fields and requires reasons for audited actions', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderDrawer({
      task: taskSchema.parse({
        ...task,
        description: '',
        acceptanceCriteria: [],
        blocked: null,
      }),
      onCommand,
    });

    expect(screen.getByText(/missing readiness fields/i)).toHaveTextContent(
      'Description, Acceptance criteria',
    );
    expect(
      screen.getByRole('button', { name: 'Move to ready' }),
    ).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Block task' }));
    expect(
      screen.getByRole('button', { name: 'Confirm block' }),
    ).toBeDisabled();
    await user.type(screen.getByLabelText('Action reason'), 'Waiting for API');
    await user.click(screen.getByRole('button', { name: 'Confirm block' }));

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.block',
      payload: {
        taskId: task.id,
        expectedRevision: 1,
        reason: 'Waiting for API',
        actor,
      },
    });
  });

  it('shows complete dependency evidence and explains cancelled and reopened prerequisites', async () => {
    const user = userEvent.setup();
    const readyTask = dependencyTask({ lifecycleState: 'ready' });
    const reopened = dependencyTask({
      id: 'prerequisite-reopened',
      title: 'Reopened prerequisite',
      lifecycleState: 'review',
    });
    const complete = dependencyTask({
      id: 'prerequisite-complete',
      title: 'Completed prerequisite',
      lifecycleState: 'done',
    });
    const cancelled = dependencyTask({
      id: 'prerequisite-cancelled',
      title: 'Cancelled prerequisite',
      lifecycleState: 'cancelled',
    });
    const dependent = dependencyTask({
      id: 'dependent-task',
      title: 'Dependent task',
    });
    const onSelectTask = vi.fn();
    renderDrawer({
      task: readyTask,
      attemptRows: [],
      taskRows: [readyTask, reopened, complete, cancelled, dependent],
      prerequisiteTaskIds: [reopened.id, complete.id, cancelled.id],
      unmetPrerequisiteTaskIds: [reopened.id, cancelled.id],
      dependentTaskIds: [dependent.id],
      onSelectTask,
    });

    const evidence = screen.getByRole('region', { name: 'Task dependencies' });
    const prerequisites = within(evidence).getByRole('list', {
      name: 'Prerequisites',
    });
    expect(
      within(prerequisites).getByText('Reopened prerequisite'),
    ).toBeVisible();
    expect(
      within(prerequisites).getByText('Completed prerequisite'),
    ).toBeVisible();
    expect(
      within(prerequisites).getByText('Cancelled prerequisite'),
    ).toBeVisible();
    expect(within(prerequisites).getByText(/restore it before/i)).toBeVisible();
    expect(
      within(evidence).getByText(/remains ready.*reopened.*not done/i),
    ).toBeVisible();
    expect(
      within(evidence).getByRole('list', { name: 'Dependents' }),
    ).toHaveTextContent('Dependent task');

    await user.selectOptions(
      screen.getByLabelText('Permission mode'),
      'safe_auto',
    );
    expect(
      screen.getByRole('button', { name: 'Launch attempt' }),
    ).toBeDisabled();

    await user.click(
      within(prerequisites).getByRole('button', {
        name: 'Open Reopened prerequisite',
      }),
    );
    expect(onSelectTask).toHaveBeenCalledWith(reopened.id);
  });

  it('keeps dependency commands pending until the authoritative edge projection advances', async () => {
    const user = userEvent.setup();
    const existing = dependencyTask({
      id: 'existing-prerequisite',
      title: 'Existing prerequisite',
    });
    const candidate = dependencyTask({
      id: 'candidate-prerequisite',
      title: 'Candidate prerequisite',
    });
    const cancelled = dependencyTask({
      id: 'cancelled-candidate',
      title: 'Cancelled candidate',
      lifecycleState: 'cancelled',
    });
    const otherProjectTask = dependencyTask({
      id: 'other-project-task',
      projectId: 'project-2',
      title: 'Other project task',
    });
    const pendingAdd = deferred<unknown>();
    const onCommand = vi
      .fn()
      .mockReturnValueOnce(pendingAdd.promise)
      .mockResolvedValueOnce(undefined);
    const rendered = renderDrawer({
      attemptRows: [],
      taskRows: [task, existing, candidate, cancelled, otherProjectTask],
      prerequisiteTaskIds: [existing.id],
      unmetPrerequisiteTaskIds: [existing.id],
      onCommand,
    });

    const choices = screen.getByLabelText('Add prerequisite');
    expect(
      within(choices).getByRole('option', { name: 'Candidate prerequisite' }),
    ).toBeVisible();
    expect(
      within(choices).queryByRole('option', { name: 'Drawer task' }),
    ).toBeNull();
    expect(
      within(choices).queryByRole('option', { name: 'Existing prerequisite' }),
    ).toBeNull();
    expect(
      within(choices).queryByRole('option', { name: 'Cancelled candidate' }),
    ).toBeNull();
    expect(
      within(choices).queryByRole('option', { name: 'Other project task' }),
    ).toBeNull();

    await user.selectOptions(choices, candidate.id);
    await user.click(screen.getByRole('button', { name: 'Add prerequisite' }));
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'task.dependency.add',
      payload: {
        taskId: task.id,
        prerequisiteTaskId: candidate.id,
        expectedRevision: task.revision,
        actor,
      },
    });
    expect(
      screen.getByRole('button', { name: 'Adding prerequisite…' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save task' })).toBeEnabled();

    await act(async () => pendingAdd.resolve(undefined));
    expect(
      screen.getByRole('button', { name: 'Adding prerequisite…' }),
    ).toBeDisabled();
    expect(
      screen.queryByText('Candidate prerequisite', { selector: 'li *' }),
    ).toBeNull();

    const afterAdd = dependencyTask({ revision: 2 });
    rendered.rerender(
      drawerElement({
        task: afterAdd,
        attemptRows: [],
        taskRows: [afterAdd, existing, candidate, cancelled, otherProjectTask],
        prerequisiteTaskIds: [existing.id, candidate.id],
        unmetPrerequisiteTaskIds: [existing.id, candidate.id],
        onCommand,
      }),
    );
    expect(screen.getByText('Candidate prerequisite')).toBeVisible();
    await user.click(
      screen.getByRole('button', {
        name: 'Remove Existing prerequisite prerequisite',
      }),
    );
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'task.dependency.remove',
      payload: {
        taskId: task.id,
        prerequisiteTaskId: existing.id,
        expectedRevision: 2,
        actor,
      },
    });
    expect(
      screen.getByRole('button', {
        name: 'Removing Existing prerequisite prerequisite…',
      }),
    ).toBeDisabled();

    const afterRemove = dependencyTask({ revision: 3 });
    rendered.rerender(
      drawerElement({
        task: afterRemove,
        attemptRows: [],
        taskRows: [
          afterRemove,
          existing,
          candidate,
          cancelled,
          otherProjectTask,
        ],
        prerequisiteTaskIds: [candidate.id],
        unmetPrerequisiteTaskIds: [candidate.id],
        onCommand,
      }),
    );
    expect(
      screen.queryByRole('button', {
        name: 'Remove Existing prerequisite prerequisite',
      }),
    ).toBeNull();
    expect(screen.getByLabelText('Add prerequisite')).toBeEnabled();
  });

  it('reports an authoritative dependency mismatch and re-enables editing', async () => {
    const user = userEvent.setup();
    const candidate = dependencyTask({
      id: 'candidate-prerequisite',
      title: 'Candidate prerequisite',
    });
    const pendingAdd = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(pendingAdd.promise);
    const rendered = renderDrawer({
      attemptRows: [],
      taskRows: [task, candidate],
      onCommand,
    });

    await user.selectOptions(
      screen.getByLabelText('Add prerequisite'),
      candidate.id,
    );
    await user.click(screen.getByRole('button', { name: 'Add prerequisite' }));
    await act(async () => pendingAdd.resolve(undefined));

    const resyncedTask = dependencyTask({ revision: 2 });
    rendered.rerender(
      drawerElement({
        task: resyncedTask,
        attemptRows: [],
        taskRows: [resyncedTask, candidate],
        onCommand,
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dependency conflict: The task changed without applying the requested dependency.',
    );
    expect(screen.getByLabelText('Add prerequisite')).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Add prerequisite' }),
    ).toBeEnabled();
  });

  it('discards dependency request state when the project changes with the same task id', async () => {
    const user = userEvent.setup();
    const firstCandidate = dependencyTask({
      id: 'first-candidate',
      title: 'First candidate',
    });
    const pendingAdd = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(pendingAdd.promise);
    const rendered = renderDrawer({
      attemptRows: [],
      taskRows: [task, firstCandidate],
      onCommand,
    });

    await user.selectOptions(
      screen.getByLabelText('Add prerequisite'),
      firstCandidate.id,
    );
    await user.click(screen.getByRole('button', { name: 'Add prerequisite' }));

    const nextProject = projectSchema.parse({
      ...project,
      id: 'project-2',
      displayName: 'Second project',
      repositoryIdentity: 'second-project',
    });
    const nextTask = dependencyTask({ projectId: nextProject.id, revision: 4 });
    const nextCandidate = dependencyTask({
      id: 'next-candidate',
      projectId: nextProject.id,
      title: 'Next candidate',
    });
    rendered.rerender(
      drawerElement({
        project: nextProject,
        task: nextTask,
        attemptRows: [],
        taskRows: [nextTask, nextCandidate],
        onCommand,
      }),
    );

    expect(screen.getByLabelText('Add prerequisite')).toBeEnabled();
    await user.selectOptions(
      screen.getByLabelText('Add prerequisite'),
      nextCandidate.id,
    );
    expect(
      screen.getByRole('button', { name: 'Add prerequisite' }),
    ).toBeEnabled();

    await act(async () => pendingAdd.resolve(undefined));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Add prerequisite' }),
    ).toBeEnabled();
  });

  it('does not reconcile a settled dependency command against a new project context', async () => {
    const user = userEvent.setup();
    const firstCandidate = dependencyTask({
      id: 'first-candidate',
      title: 'First candidate',
    });
    const pendingAdd = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(pendingAdd.promise);
    const rendered = renderDrawer({
      attemptRows: [],
      taskRows: [task, firstCandidate],
      onCommand,
    });

    await user.selectOptions(
      screen.getByLabelText('Add prerequisite'),
      firstCandidate.id,
    );
    await user.click(screen.getByRole('button', { name: 'Add prerequisite' }));
    await act(async () => pendingAdd.resolve(undefined));

    const nextProject = projectSchema.parse({
      ...project,
      id: 'project-2',
      displayName: 'Second project',
      repositoryIdentity: 'second-project',
    });
    const nextTask = dependencyTask({ projectId: nextProject.id, revision: 4 });
    const nextCandidate = dependencyTask({
      id: 'next-candidate',
      projectId: nextProject.id,
      title: 'Next candidate',
    });
    rendered.rerender(
      drawerElement({
        project: nextProject,
        task: nextTask,
        attemptRows: [],
        taskRows: [nextTask, nextCandidate],
        onCommand,
      }),
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Add prerequisite')).toBeEnabled();
  });

  it('shows dependency cycle and conflict failures without optimistic changes', async () => {
    const user = userEvent.setup();
    const existing = dependencyTask({
      id: 'existing-prerequisite',
      title: 'Existing prerequisite',
    });
    const candidate = dependencyTask({
      id: 'cycle-candidate',
      title: 'Cycle candidate',
    });
    const onCommand = vi
      .fn()
      .mockRejectedValueOnce({
        code: 'task_dependency_cycle',
        message: 'This edge would create a dependency cycle.',
      })
      .mockRejectedValueOnce({
        code: 'task_dependency_conflict',
        message: 'The dependency changed before removal.',
      });
    renderDrawer({
      attemptRows: [],
      taskRows: [task, existing, candidate],
      prerequisiteTaskIds: [existing.id],
      unmetPrerequisiteTaskIds: [existing.id],
      onCommand,
    });

    await user.selectOptions(
      screen.getByLabelText('Add prerequisite'),
      candidate.id,
    );
    await user.click(screen.getByRole('button', { name: 'Add prerequisite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dependency cycle: This edge would create a dependency cycle.',
    );
    expect(screen.getByText('Existing prerequisite')).toBeVisible();
    expect(
      screen.queryByText('Cycle candidate', { selector: 'li *' }),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', {
        name: 'Remove Existing prerequisite prerequisite',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dependency conflict: The dependency changed before removal.',
    );
    expect(screen.getByText('Existing prerequisite')).toBeVisible();
  });

  it.each([
    ['disconnected', { connected: false, attemptRows: [] }],
    [
      'archived',
      { project: { ...project, archivedAt: timestamp }, attemptRows: [] },
    ],
    ['active attempt', { attemptRows: timelineAttempts() }],
    [
      'task lifecycle',
      {
        task: dependencyTask({ lifecycleState: 'in_progress' }),
        attemptRows: [],
      },
    ],
  ] as const)(
    'keeps dependency editing read-only when gated by %s',
    (_, options) => {
      const existing = dependencyTask({
        id: 'existing-prerequisite',
        title: 'Existing prerequisite',
      });
      const candidate = dependencyTask({
        id: 'candidate-prerequisite',
        title: 'Candidate prerequisite',
      });
      const selectedTask =
        'task' in options && options.task ? options.task : task;
      renderDrawer({
        ...options,
        task: selectedTask,
        taskRows: [selectedTask, existing, candidate],
        prerequisiteTaskIds: [existing.id],
        unmetPrerequisiteTaskIds: [existing.id],
      });

      expect(screen.getByLabelText('Add prerequisite')).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Add prerequisite' }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', {
          name: 'Remove Existing prerequisite prerequisite',
        }),
      ).toBeDisabled();
    },
  );

  it.each([
    ['ready', 'backlog', 'Move back to backlog'],
    ['review', 'done', 'Mark done'],
    ['done', 'review', 'Restore to review'],
    ['cancelled', 'backlog', 'Restore to backlog'],
  ] as const)(
    'sends the %s to %s human lifecycle action with its required audit reason',
    async (current, next, buttonName) => {
      const user = userEvent.setup();
      const onCommand = vi.fn().mockResolvedValue(undefined);
      renderDrawer({
        task: taskSchema.parse({ ...task, lifecycleState: current }),
        onCommand,
      });

      await user.click(screen.getByRole('button', { name: buttonName }));
      const needsReason = current !== 'review';
      if (needsReason) {
        expect(
          screen.getByRole('button', { name: 'Confirm transition' }),
        ).toBeDisabled();
        await user.type(
          screen.getByLabelText('Action reason'),
          'Human decision',
        );
        await user.click(
          screen.getByRole('button', { name: 'Confirm transition' }),
        );
      }

      expect(onCommand).toHaveBeenCalledWith({
        type: 'task.transition',
        payload: {
          taskId: task.id,
          expectedRevision: 1,
          nextState: next,
          ...(needsReason ? { reason: 'Human decision' } : {}),
          actor,
        },
      });
    },
  );

  it('keeps launch canonical, exposes safe controls, and disables launch while blocked', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderDrawer({
      task: taskSchema.parse({
        ...task,
        lifecycleState: 'ready',
        blocked: null,
      }),
      onCommand,
    });

    await user.selectOptions(
      screen.getByLabelText('Permission mode'),
      'safe_auto',
    );
    await user.click(screen.getByRole('button', { name: 'Launch attempt' }));

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.attempt.launch',
      payload: {
        taskId: task.id,
        expectedRevision: 1,
        title: 'Drawer task',
        permissionMode: 'safe_auto',
        workspace: { type: 'shared', path: project.repositoryPath },
        actor,
      },
    });
    expect(screen.getByText('Ready')).toBeDefined();
  });

  it('keeps launch pending through HTTP success until an authoritative attempt arrives', async () => {
    const user = userEvent.setup();
    const command = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(command.promise);
    const readyTask = taskSchema.parse({
      ...task,
      lifecycleState: 'ready',
      blocked: null,
    });
    const rendered = renderDrawer({ task: readyTask, onCommand });

    await user.selectOptions(
      screen.getByLabelText('Permission mode'),
      'interactive',
    );
    await user.click(screen.getByRole('button', { name: 'Launch attempt' }));
    expect(
      screen.getByRole('button', { name: 'Launch attempt' }),
    ).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'waiting for project update',
    );

    await act(async () => command.resolve(undefined));

    expect(
      screen.getByRole('button', { name: 'Launch attempt' }),
    ).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'waiting for project update',
    );

    const authoritativeAttempt = taskAttemptSchema.parse({
      id: 'attempt-3',
      taskId: task.id,
      sessionId: 'session-new',
      ordinal: 3,
      source: 'launched',
      actor,
      createdAt: timestamp,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
    });
    rendered.rerender(
      drawerElement({
        task: readyTask,
        onCommand,
        attemptRows: [
          ...timelineAttempts(),
          { attempt: authoritativeAttempt, session: undefined },
        ],
      }),
    );

    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Launch attempt' }),
    ).toBeEnabled();
  });

  it('shows a launch rejection after the retained attempt arrives', async () => {
    const user = userEvent.setup();
    const command = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(command.promise);
    const readyTask = taskSchema.parse({
      ...task,
      lifecycleState: 'ready',
      blocked: null,
    });
    const rendered = renderDrawer({ task: readyTask, onCommand });

    await user.selectOptions(
      screen.getByLabelText('Permission mode'),
      'interactive',
    );
    await user.click(screen.getByRole('button', { name: 'Launch attempt' }));

    const retainedAttempt = taskAttemptSchema.parse({
      id: 'attempt-retained',
      taskId: task.id,
      sessionId: 'session-retained',
      ordinal: 3,
      source: 'launched',
      actor,
      createdAt: timestamp,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
    });
    rendered.rerender(
      drawerElement({
        task: readyTask,
        onCommand,
        attemptRows: [
          ...timelineAttempts(),
          { attempt: retainedAttempt, session: undefined },
        ],
      }),
    );

    await act(async () =>
      command.reject(new Error('Attempt startup remained failed')),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Attempt startup remained failed',
    );
  });

  it('keeps launch pending through a pre-start attempt event until command settlement', async () => {
    const user = userEvent.setup();
    const first = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(first.promise);
    const readyTask = taskSchema.parse({
      ...task,
      lifecycleState: 'ready',
      blocked: null,
    });
    const rendered = renderDrawer({ task: readyTask, onCommand });
    await user.selectOptions(
      screen.getByLabelText('Permission mode'),
      'interactive',
    );

    await user.click(screen.getByRole('button', { name: 'Launch attempt' }));
    const authoritativeAttempt = taskAttemptSchema.parse({
      id: 'attempt-3',
      taskId: task.id,
      sessionId: 'session-new',
      ordinal: 3,
      source: 'launched',
      actor,
      createdAt: timestamp,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
    });
    rendered.rerender(
      drawerElement({
        task: readyTask,
        onCommand,
        attemptRows: [
          ...timelineAttempts(),
          { attempt: authoritativeAttempt, session: undefined },
        ],
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'waiting for project update',
    );
    expect(
      screen.getByRole('button', { name: 'Launch attempt' }),
    ).toBeDisabled();
    await act(async () => first.reject(new Error('Launch failed')));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('links only same-project sessions and confirms unlink with a reason', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const linkedAttempt = taskAttemptSchema.parse({
      ...attempts[0],
      id: 'attempt-linked-current',
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
    });
    renderDrawer({
      onCommand,
      attemptRows: [
        ...timelineAttempts(),
        { attempt: linkedAttempt, session: sessions[1] },
      ],
      sessionRows: [
        ...sessions,
        sessionSchema.parse({
          ...failedSession,
          id: 'session-linkable',
          title: 'Linkable run',
          lifecycleState: 'completed',
        }),
      ],
    });

    const choices = screen.getByLabelText('Existing session');
    expect(
      within(choices).getByRole('option', { name: 'Linkable run' }),
    ).toBeDefined();
    expect(
      within(choices).queryByRole('option', { name: 'Other project' }),
    ).toBeNull();
    await user.selectOptions(choices, 'session-linkable');
    await user.click(screen.getByRole('button', { name: 'Link session' }));
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.attempt.link',
        payload: expect.objectContaining({ sessionId: 'session-linkable' }),
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Unlink attempt 2' }));
    expect(
      screen.getByRole('button', { name: 'Confirm unlink' }),
    ).toBeDisabled();
    await user.type(screen.getByLabelText('Unlink reason'), 'Wrong task');
    await user.click(screen.getByLabelText('Confirm unlink attempt'));
    await user.click(screen.getByRole('button', { name: 'Confirm unlink' }));
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.attempt.unlink',
        payload: expect.objectContaining({
          attemptId: 'attempt-linked-current',
          reason: 'Wrong task',
        }),
      }),
    );
  });

  it('shows ordinal attempt history, failures, unlinks, repairs, and opens sessions', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    renderDrawer({ onOpenSession, withRepair: true });

    const timeline = screen.getByRole('region', { name: 'Attempt timeline' });
    const attempts = within(timeline).getAllByRole('article');
    expect(attempts.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Attempt 1'),
      expect.stringContaining('Attempt 2'),
    ]);
    expect(attempts[0]).toHaveTextContent('Failed');
    expect(attempts[1]).toHaveTextContent('Unlinked');
    expect(attempts[1]).toHaveTextContent('Superseded');
    expect(screen.getByRole('alert')).toHaveTextContent('repair');

    await user.click(screen.getByRole('button', { name: 'Open Failed run' }));
    expect(onOpenSession).toHaveBeenCalledWith(failedSession.id);
    expect(
      within(attempts[0]).queryByRole('button', { name: 'Unlink attempt 1' }),
    ).toBeNull();
  });

  it('composes projected Developer execution history in the focused panel', () => {
    renderDrawer({
      task: taskSchema.parse({
        ...task,
        lifecycleState: 'review',
        revision: 2,
      }),
      developerCycles: [developerCycle],
      developerCompletionReports: [developerCompletionReport],
    });

    const developer = screen.getByRole('region', {
      name: 'Developer workflow',
    });
    expect(
      within(developer).getByText('Developer report in drawer.'),
    ).toBeDefined();
    expect(within(developer).getByText('Not met')).toBeDefined();
    expect(
      within(developer).getByRole('button', { name: 'Accept as done' }),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Return to progress' }),
    ).toBeNull();
  });
});

const timestamp = '2026-08-25T00:00:00.000Z';
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
const task = taskSchema.parse({
  id: 'task-1',
  projectId: project.id,
  title: 'Drawer task',
  description: 'Build the drawer.',
  acceptanceCriteria: ['The drawer works.'],
  priority: 'normal',
  rank: 'a',
  lifecycleState: 'backlog',
  labels: ['frontend'],
  notes: '',
  blocked: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const dependencyTask = (overrides: Partial<Task> = {}) =>
  taskSchema.parse({ ...task, blocked: null, ...overrides });
const failedSession = sessionSchema.parse({
  id: 'session-failed',
  projectId: project.id,
  workspaceId: 'workspace-1',
  title: 'Failed run',
  permissionMode: 'interactive',
  lifecycleState: 'failed',
  createdAt: timestamp,
  updatedAt: timestamp,
});
const sessions: Session[] = [
  failedSession,
  sessionSchema.parse({
    ...failedSession,
    id: 'session-unlinked',
    title: 'Old run',
    lifecycleState: 'completed',
  }),
  sessionSchema.parse({
    ...failedSession,
    id: 'session-other',
    projectId: 'project-2',
    title: 'Other project',
  }),
];
const attempts = [
  taskAttemptSchema.parse({
    id: 'attempt-2',
    taskId: task.id,
    sessionId: 'session-unlinked',
    ordinal: 2,
    source: 'linked',
    actor,
    createdAt: timestamp,
    unlinkedAt: timestamp,
    unlinkedBy: actor,
    unlinkReason: 'Superseded',
  }),
  taskAttemptSchema.parse({
    id: 'attempt-1',
    taskId: task.id,
    sessionId: failedSession.id,
    ordinal: 1,
    source: 'launched',
    actor,
    createdAt: timestamp,
    unlinkedAt: null,
    unlinkedBy: null,
    unlinkReason: null,
  }),
];
const transitions = [
  taskTransitionSchema.parse({
    id: 'transition-1',
    taskId: task.id,
    commandId: 'command-1',
    previousState: 'backlog',
    nextState: 'ready',
    actor,
    reason: null,
    occurredAt: timestamp,
  }),
];
const developerCycle: DeveloperExecutionCycle =
  developerExecutionCycleSchema.parse({
    id: 'developer-cycle-1',
    attemptId: 'attempt-1',
    ordinal: 1,
    mode: 'new',
    authorizedBy: actor,
    authorizationCommandId: 'developer-launch-1',
    policyVersion: 'developer-policy-v1',
    projectInstructions: { content: '', revision: 1 },
    taskSnapshot: {
      revision: 1,
      title: task.title,
      description: task.description,
      acceptanceCriteria: [
        { id: 'criterion-1', text: task.acceptanceCriteria[0] },
      ],
    },
    workspaceId: 'workspace-1',
    permissionMode: 'interactive',
    startedAt: timestamp,
    endedAt: timestamp,
    terminalDisposition: 'submitted_for_review',
    completionReportId: 'developer-report-1',
    blockerReportId: null,
    terminalCommandId: 'developer-submit-1',
    terminalEventId: 'developer-event-1',
  });
const developerCompletionReport: DeveloperCompletionReport =
  developerCompletionReportSchema.parse({
    id: 'developer-report-1',
    cycleId: developerCycle.id,
    summary: 'Developer report in drawer.',
    criterionResults: [
      {
        criterionId: 'criterion-1',
        status: 'not_met',
        evidence: 'Needs an integrated check.',
      },
    ],
    verification: [],
    limitations: '',
    workspaceState: {
      summary: 'Clean workspace.',
      hasUncommittedChanges: false,
      commitsCreated: true,
    },
    reviewerNotes: null,
    createdAt: timestamp,
  });

const timelineAttempts = () =>
  attempts.map((attempt) => ({
    attempt,
    session: sessions.find(({ id }) => id === attempt.sessionId),
  }));

type DrawerOptions = {
  project?: Project;
  task?: Task;
  onCommand?: (command: MutatingCommand) => Promise<unknown> | void;
  onOpenSession?: (sessionId: string) => void;
  withRepair?: boolean;
  attemptRows?: ReturnType<typeof timelineAttempts>;
  sessionRows?: Session[];
  developerCycles?: DeveloperExecutionCycle[];
  developerCompletionReports?: DeveloperCompletionReport[];
  connected?: boolean;
  taskRows?: Task[];
  prerequisiteTaskIds?: string[];
  unmetPrerequisiteTaskIds?: string[];
  dependentTaskIds?: string[];
  onSelectTask?: (taskId: string) => void;
};

const drawerElement = (options: DrawerOptions = {}) => {
  const selectedTask = 'task' in options ? options.task : task;
  const onCommand = options.onCommand ?? vi.fn().mockResolvedValue(undefined);
  const onOpenSession = options.onOpenSession ?? vi.fn();
  return (
    <TaskDrawer
      open
      project={options.project ?? project}
      task={selectedTask}
      attempts={selectedTask ? (options.attemptRows ?? timelineAttempts()) : []}
      transitions={selectedTask ? transitions : []}
      repairs={
        selectedTask && options.withRepair
          ? [
              {
                taskId: task.id,
                attemptId: 'attempt-1',
                sessionId: failedSession.id,
                reason: 'startup_outcome_unknown' as const,
              },
            ]
          : []
      }
      sessions={options.sessionRows ?? sessions}
      developerCycles={options.developerCycles ?? []}
      developerCompletionReports={options.developerCompletionReports ?? []}
      developerBlockerReports={[]}
      developerReviewFeedback={[]}
      qaCycles={[]}
      qaReports={[]}
      reviewAutomation={undefined}
      connected={options.connected ?? true}
      projectTasks={options.taskRows ?? (selectedTask ? [selectedTask] : [])}
      prerequisiteTaskIds={options.prerequisiteTaskIds ?? []}
      unmetPrerequisiteTaskIds={options.unmetPrerequisiteTaskIds ?? []}
      dependentTaskIds={options.dependentTaskIds ?? []}
      onOpenChange={() => undefined}
      onCommand={onCommand}
      onSelectTask={options.onSelectTask ?? vi.fn()}
      onOpenSession={onOpenSession}
    />
  );
};

const renderDrawer = (options: DrawerOptions = {}) =>
  render(drawerElement(options));

const deferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
