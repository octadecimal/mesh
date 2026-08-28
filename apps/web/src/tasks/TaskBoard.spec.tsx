import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  projectSchema,
  projectRunItemSchema,
  projectRunSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskDependencySchema,
  taskSchema,
  type MutatingCommand,
  type ProjectSnapshot,
  type ProjectRun,
  type Task,
  type TaskDependency,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { createProjection, replaceProjectSnapshot } from '../state/reducer';
import { TaskBoard } from './TaskBoard';

describe('TaskBoard', () => {
  it('renders four manually ordered active columns with task summaries', () => {
    renderBoard();

    expect(screen.getByRole('region', { name: 'Backlog tasks' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Ready tasks' })).toBeDefined();
    expect(
      screen.getByRole('region', { name: 'In progress tasks' }),
    ).toBeDefined();
    expect(screen.getByRole('region', { name: 'Review tasks' })).toBeDefined();

    const backlog = screen.getByRole('region', { name: 'Backlog tasks' });
    expect(
      within(backlog)
        .getAllByRole('button', { name: /^Open / })
        .map((button) => button.textContent),
    ).toEqual(['First task', 'Second task']);
    const card = screen.getByRole('article', {
      name: 'First task task card',
    });
    expect(within(card).getByText('Urgent')).toBeDefined();
    expect(within(card).getByText('frontend')).toBeDefined();
    expect(within(card).getByText('2 attempts')).toBeDefined();
    expect(within(card).getByText('Blocked')).toBeDefined();
    expect(within(card).getByText('Waiting for design')).toBeDefined();
  });

  it('shows only unmet prerequisite counts and preserves task selection through dependency links', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    const dependencies = [
      dependency('second', 'ready'),
      dependency('second', 'done'),
      dependency('progress', 'second'),
    ];
    renderBoard({ dependencies, onSelectTask });

    const card = screen.getByRole('article', {
      name: 'Second task task card',
    });
    expect(within(card).getByText('1 unmet prerequisite')).toBeVisible();
    expect(within(card).queryByText('2 unmet prerequisites')).toBeNull();

    await user.click(
      within(card).getByRole('button', { name: 'Open Second task' }),
    );

    const evidence = screen.getByRole('region', { name: 'Task dependencies' });
    const prerequisites = within(evidence).getByRole('list', {
      name: 'Prerequisites',
    });
    expect(within(prerequisites).getByText('Ready task')).toBeVisible();
    expect(within(prerequisites).getByText('Finished task')).toBeVisible();
    const dependents = within(evidence).getByRole('list', {
      name: 'Dependents',
    });
    expect(within(dependents).getByText('Progress task')).toBeVisible();

    await user.click(
      within(prerequisites).getByRole('button', { name: 'Open Ready task' }),
    );
    expect(onSelectTask).toHaveBeenLastCalledWith('ready');
    expect(screen.getByRole('dialog', { name: 'Ready task' })).toBeVisible();
  });

  it('disables only dependency-blocked forward lifecycle options and guards select changes', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderBoard({
      dependencies: [
        dependency('second', 'progress'),
        dependency('ready', 'progress'),
        dependency('review', 'progress'),
      ],
      onCommand,
    });

    const backlogSelect = screen.getByRole('combobox', {
      name: 'Move Second task to',
    });
    expect(
      within(backlogSelect).getByRole('option', { name: 'Ready' }),
    ).toBeDisabled();
    expect(
      within(backlogSelect).getByRole('option', { name: 'Backlog' }),
    ).toBeEnabled();
    fireEvent.change(backlogSelect, { target: { value: 'ready' } });
    expect(onCommand).not.toHaveBeenCalled();

    const readySelect = screen.getByRole('combobox', {
      name: 'Move Ready task to',
    });
    expect(
      within(readySelect).getByRole('option', { name: 'In progress' }),
    ).toBeDisabled();
    expect(
      within(readySelect).getByRole('option', { name: 'Backlog' }),
    ).toBeEnabled();
    fireEvent.change(readySelect, { target: { value: 'in_progress' } });
    expect(onCommand).not.toHaveBeenCalled();

    const reviewSelect = screen.getByRole('combobox', {
      name: 'Move Review task to',
    });
    expect(
      within(reviewSelect).getByRole('option', { name: 'In progress' }),
    ).toBeDisabled();
    fireEvent.change(reviewSelect, { target: { value: 'in_progress' } });
    expect(onCommand).not.toHaveBeenCalled();

    await user.selectOptions(readySelect, 'backlog');
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.transition',
        payload: expect.objectContaining({
          taskId: 'ready',
          nextState: 'backlog',
        }),
      }),
    );
  });

  it('guards dependency-blocked forward drops while preserving reorder and backward drops', () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderBoard({
      dependencies: [
        dependency('second', 'progress'),
        dependency('ready', 'progress'),
      ],
      onCommand,
    });

    let transfer = dataTransfer();
    fireEvent.dragStart(
      screen.getByRole('article', { name: 'Second task task card' }),
      { dataTransfer: transfer },
    );
    fireEvent.drop(screen.getByRole('region', { name: 'Ready tasks' }), {
      dataTransfer: transfer,
    });
    expect(onCommand).not.toHaveBeenCalled();

    transfer = dataTransfer();
    fireEvent.dragStart(
      screen.getByRole('article', { name: 'Ready task task card' }),
      { dataTransfer: transfer },
    );
    fireEvent.drop(screen.getByRole('region', { name: 'In progress tasks' }), {
      dataTransfer: transfer,
    });
    expect(onCommand).not.toHaveBeenCalled();

    transfer = dataTransfer();
    fireEvent.dragStart(
      screen.getByRole('article', { name: 'Second task task card' }),
      { dataTransfer: transfer },
    );
    fireEvent.drop(
      screen.getByRole('article', { name: 'First task task card' }),
      { dataTransfer: transfer },
    );
    expect(onCommand).toHaveBeenNthCalledWith(1, {
      type: 'task.reorder',
      payload: {
        taskId: 'second',
        expectedRevision: 1,
        rank: 'a',
        actor: expect.objectContaining({ type: 'human', id: 'operator' }),
      },
    });

    transfer = dataTransfer();
    fireEvent.dragStart(
      screen.getByRole('article', { name: 'Ready task task card' }),
      { dataTransfer: transfer },
    );
    fireEvent.drop(screen.getByRole('region', { name: 'Backlog tasks' }), {
      dataTransfer: transfer,
    });
    expect(onCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'task.transition',
        payload: expect.objectContaining({
          taskId: 'ready',
          nextState: 'backlog',
        }),
      }),
    );
  });

  it('shows completed and cancelled tasks only in their filtered views', async () => {
    const user = userEvent.setup();
    renderBoard();

    expect(screen.queryByText('Finished task')).toBeNull();
    expect(screen.queryByText('Cancelled task')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Show active tasks' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await user.click(
      screen.getByRole('button', { name: 'Show completed tasks' }),
    );
    expect(
      screen.getByRole('region', { name: 'Completed tasks' }),
    ).toBeDefined();
    expect(screen.getByText('Finished task')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Backlog tasks' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Show completed tasks' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await user.click(
      screen.getByRole('button', { name: 'Show cancelled tasks' }),
    );
    expect(
      screen.getByRole('region', { name: 'Cancelled tasks' }),
    ).toBeDefined();
    expect(screen.getByText('Cancelled task')).toBeDefined();
    expect(screen.queryByText('Finished task')).toBeNull();
  });

  it('opens the selected task drawer and preserves the selection callback', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    renderBoard({ onSelectTask });

    await user.click(screen.getByRole('button', { name: 'Open First task' }));

    expect(onSelectTask).toHaveBeenCalledWith('first');
    expect(screen.getByRole('dialog', { name: 'First task' })).toBeDefined();
    expect(
      screen.getByRole('region', { name: 'Attempt timeline' }),
    ).toBeDefined();
  });

  it('mounts run controls above the board and opens attention evidence in the task drawer', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    const attentionItem = projectRunItemSchema.parse({
      id: 'run-item-ready',
      runId: 'run-1',
      projectId: project.id,
      taskId: 'ready',
      taskRevision: 1,
      policyRevision: 1,
      taskAutomationGeneration: 0,
      queuePosition: 0,
      status: 'attention_required',
      attemptId: null,
      sessionId: null,
      launchIdempotencyKey: 'launch-ready',
      claimedAt: timestamp,
      startedAt: null,
      finishedAt: timestamp,
      outcomeReason: 'manual_review_required',
    });
    const activeRun = projectRunSchema.parse({
      id: 'run-1',
      projectId: project.id,
      revision: 2,
      concurrency: 1,
      state: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
      completionReason: null,
      completedAt: null,
      items: [attentionItem],
    });
    renderBoard({ onSelectTask, runs: [activeRun] });

    const controls = screen.getByRole('region', { name: 'Project run' });
    const board = screen.getByRole('region', { name: 'Backlog tasks' });
    expect(
      controls.compareDocumentPosition(board) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(
      screen.getByRole('button', { name: 'Open Ready task evidence' }),
    );
    expect(onSelectTask).toHaveBeenCalledWith('ready');
    expect(screen.getByRole('dialog', { name: 'Ready task' })).toBeVisible();
  });

  it('mounts project planning above orchestration and the task board', () => {
    renderBoard();

    const planning = screen.getByRole('region', { name: 'Project planning' });
    const orchestration = screen.getByRole('region', { name: 'Project run' });
    const board = screen.getByRole('region', { name: 'Backlog tasks' });
    expect(
      planning.compareDocumentPosition(orchestration) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      orchestration.compareDocumentPosition(board) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('opens lightweight backlog creation from the board toolbar', async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.click(screen.getByRole('button', { name: 'Add task' }));

    expect(screen.getByRole('dialog', { name: 'Create task' })).toBeDefined();
  });

  it('closes an old project drawer before rendering controls for a new project', async () => {
    const user = userEvent.setup();
    const projection = boardProjection();
    const rendered = render(
      <TaskBoard
        project={project}
        projection={projection}
        onCommand={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Open First task' }));
    expect(screen.getByRole('dialog', { name: 'First task' })).toBeDefined();

    rendered.rerender(
      <TaskBoard
        project={otherProject}
        projection={projection}
        onCommand={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps archived project cards read-only', () => {
    renderBoard({ archived: true });

    expect(screen.getByText(/read-only task board/i)).toBeDefined();
    const card = screen.getByRole('article', {
      name: 'First task task card',
    });
    expect(card).toHaveAttribute('draggable', 'false');
    expect(
      within(card).getByRole('combobox', { name: 'Move First task to' }),
    ).toBeDisabled();
    expect(
      within(card).getByRole('button', { name: 'Move First task down' }),
    ).toBeDisabled();
  });

  it('sends task.reorder when a card is dropped on a sibling', () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderBoard({ onCommand });
    const transfer = dataTransfer();

    fireEvent.dragStart(
      screen.getByRole('article', { name: 'First task task card' }),
      { dataTransfer: transfer },
    );
    fireEvent.drop(
      screen.getByRole('article', { name: 'Second task task card' }),
      { dataTransfer: transfer },
    );

    expect(onCommand).toHaveBeenCalledWith({
      type: 'task.reorder',
      payload: {
        taskId: 'first',
        expectedRevision: 1,
        rank: 'b',
        actor: expect.objectContaining({ type: 'human', id: 'operator' }),
      },
    });
  });

  it('clears the native drag source when a drag is cancelled', () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderBoard({ onCommand });
    const card = screen.getByRole('article', {
      name: 'First task task card',
    });

    fireEvent.dragStart(card, { dataTransfer: dataTransfer() });
    fireEvent.dragEnd(card);
    fireEvent.drop(screen.getByRole('region', { name: 'Ready tasks' }), {
      dataTransfer: dataTransfer(),
    });

    expect(onCommand).not.toHaveBeenCalled();
  });

  it('keeps a cross-column move pending at its canonical location until projected', async () => {
    const command = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(command.promise);
    const initial = boardProjection();
    const rendered = render(
      <TaskBoard
        project={project}
        projection={initial}
        onCommand={onCommand}
      />,
    );
    const transfer = dataTransfer();

    fireEvent.dragStart(
      screen.getByRole('article', { name: 'First task task card' }),
      { dataTransfer: transfer },
    );
    fireEvent.drop(screen.getByRole('region', { name: 'Ready tasks' }), {
      dataTransfer: transfer,
    });

    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.transition',
        payload: expect.objectContaining({
          taskId: 'first',
          expectedRevision: 1,
          nextState: 'ready',
        }),
      }),
    );
    const pendingCard = screen.getByRole('article', {
      name: 'First task task card',
    });
    expect(pendingCard).toHaveAttribute('data-pending', 'true');
    expect(
      within(screen.getByRole('region', { name: 'Backlog tasks' })).getByText(
        'First task',
      ),
    ).toBeDefined();

    await act(async () => command.resolve({}));
    expect(pendingCard).toHaveAttribute('data-pending', 'true');

    rendered.rerender(
      <TaskBoard
        project={project}
        projection={boardProjection([
          task({
            id: 'first',
            title: 'First task',
            rank: 'a',
            lifecycleState: 'ready',
            revision: 2,
            blocked: {
              reason: 'Waiting for design',
              actor,
              blockedAt: timestamp,
            },
            labels: ['frontend'],
            priority: 'urgent',
          }),
        ])}
        onCommand={onCommand}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('article', { name: 'First task task card' }),
      ).not.toHaveAttribute('data-pending'),
    );
    expect(
      within(screen.getByRole('region', { name: 'Ready tasks' })).getByText(
        'First task',
      ),
    ).toBeDefined();
  });

  it('keeps a reorder pending through another rank change until its stale rejection arrives', async () => {
    const command = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(command.promise);
    const user = userEvent.setup();
    const rendered = render(
      <TaskBoard
        project={project}
        projection={boardProjection()}
        onCommand={onCommand}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Move First task down' }),
    );
    rendered.rerender(
      <TaskBoard
        project={project}
        projection={boardProjection([
          task({
            id: 'first',
            title: 'First task',
            rank: 'z',
            lifecycleState: 'backlog',
            revision: 2,
          }),
        ])}
        onCommand={onCommand}
      />,
    );

    expect(
      screen.getByRole('article', { name: 'First task task card' }),
    ).toHaveAttribute('data-pending', 'true');
    expect(
      within(screen.getByRole('region', { name: 'Backlog tasks' })).getByText(
        'First task',
      ),
    ).toBeDefined();

    await act(async () => command.reject(new Error('Task revision conflict')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Task revision conflict',
    );
    expect(
      screen.getByRole('article', { name: 'First task task card' }),
    ).not.toHaveAttribute('data-pending');
  });

  it('settles a reorder after its result when the projection arrived first', async () => {
    const command = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(command.promise);
    const user = userEvent.setup();
    const rendered = render(
      <TaskBoard
        project={project}
        projection={boardProjection()}
        onCommand={onCommand}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Move First task down' }),
    );
    rendered.rerender(
      <TaskBoard
        project={project}
        projection={boardProjection([
          task({ id: 'first', title: 'First task', rank: 'b', revision: 2 }),
        ])}
        onCommand={onCommand}
      />,
    );
    expect(
      screen.getByRole('article', { name: 'First task task card' }),
    ).toHaveAttribute('data-pending', 'true');

    await act(async () =>
      command.resolve(
        commandResult(
          task({ id: 'first', title: 'First task', rank: 'b', revision: 2 }),
        ),
      ),
    );

    await waitFor(() =>
      expect(
        screen.getByRole('article', { name: 'First task task card' }),
      ).not.toHaveAttribute('data-pending'),
    );
  });

  it('settles a reorder after its projection when the result arrived first', async () => {
    const command = deferred<unknown>();
    const onCommand = vi.fn().mockReturnValue(command.promise);
    const user = userEvent.setup();
    const rendered = render(
      <TaskBoard
        project={project}
        projection={boardProjection()}
        onCommand={onCommand}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Move First task down' }),
    );
    await act(async () =>
      command.resolve(
        commandResult(
          task({ id: 'first', title: 'First task', rank: 'b', revision: 2 }),
        ),
      ),
    );
    expect(
      screen.getByRole('article', { name: 'First task task card' }),
    ).toHaveAttribute('data-pending', 'true');

    rendered.rerender(
      <TaskBoard
        project={project}
        projection={boardProjection([
          task({ id: 'first', title: 'First task', rank: 'b', revision: 2 }),
        ])}
        onCommand={onCommand}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('article', { name: 'First task task card' }),
      ).not.toHaveAttribute('data-pending'),
    );
  });

  it('ignores a delayed rejection after a newer move starts', async () => {
    const firstCommand = deferred<unknown>();
    const secondCommand = deferred<unknown>();
    const onCommand = vi
      .fn()
      .mockReturnValueOnce(firstCommand.promise)
      .mockReturnValueOnce(secondCommand.promise);
    const user = userEvent.setup();
    const rendered = render(
      <TaskBoard
        project={project}
        projection={boardProjection()}
        onCommand={onCommand}
      />,
    );

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Move First task to' }),
      'ready',
    );
    rendered.rerender(
      <TaskBoard
        project={project}
        projection={boardProjection([
          task({
            id: 'first',
            title: 'First task',
            rank: 'a',
            lifecycleState: 'ready',
            revision: 2,
          }),
        ])}
        onCommand={onCommand}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('article', { name: 'First task task card' }),
      ).not.toHaveAttribute('data-pending'),
    );

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Move First task to' }),
      'in_progress',
    );
    expect(
      screen.getByRole('article', { name: 'First task task card' }),
    ).toHaveAttribute('data-pending', 'true');

    await act(async () => firstCommand.reject(new Error('Old move rejected')));

    expect(
      screen.getByRole('article', { name: 'First task task card' }),
    ).toHaveAttribute('data-pending', 'true');
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => secondCommand.resolve({}));
  });

  it('restores interaction at the unchanged canonical location after rejection', async () => {
    const onCommand = vi.fn().mockRejectedValue(new Error('Move rejected'));
    renderBoard({ onCommand });
    const user = userEvent.setup();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Move First task to' }),
      'ready',
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Move rejected');
    const card = screen.getByRole('article', {
      name: 'First task task card',
    });
    expect(card).not.toHaveAttribute('data-pending');
    expect(
      within(screen.getByRole('region', { name: 'Backlog tasks' })).getByText(
        'First task',
      ),
    ).toBeDefined();
  });

  it('surfaces missing readiness fields when backlog cannot move to ready', async () => {
    const onCommand = vi.fn().mockRejectedValue({
      code: 'task_not_ready',
      message: 'Task is not ready',
      details: { problems: ['description', 'acceptanceCriteria'] },
    });
    const user = userEvent.setup();
    renderBoard({ onCommand });

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Move First task to' }),
      'ready',
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Missing readiness fields: Description, Acceptance criteria.',
    );
  });

  it('offers keyboard-accessible rank controls', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderBoard({ onCommand });

    await user.click(
      screen.getByRole('button', { name: 'Move First task down' }),
    );

    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.reorder',
        payload: expect.objectContaining({ taskId: 'first', rank: 'b' }),
      }),
    );
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
const otherProject = projectSchema.parse({
  ...project,
  id: 'project-2',
  displayName: 'Other',
  repositoryPath: 'C:\\other',
  repositoryIdentity: 'other',
});

const task = (overrides: Record<string, unknown> = {}) =>
  taskSchema.parse({
    id: 'first',
    projectId: project.id,
    title: 'First task',
    description: 'Build the board.',
    acceptanceCriteria: ['The board is usable.'],
    priority: 'urgent',
    rank: 'a',
    lifecycleState: 'backlog',
    labels: ['frontend'],
    notes: '',
    blocked: {
      reason: 'Waiting for design',
      actor,
      blockedAt: timestamp,
    },
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });

const dependency = (
  taskId: string,
  prerequisiteTaskId: string,
): TaskDependency =>
  taskDependencySchema.parse({
    projectId: project.id,
    taskId,
    prerequisiteTaskId,
    createdBy: actor,
    createdAt: timestamp,
  });

const baseTasks = [
  task(),
  task({ id: 'second', title: 'Second task', rank: 'b', blocked: null }),
  task({
    id: 'ready',
    title: 'Ready task',
    rank: 'a',
    lifecycleState: 'ready',
  }),
  task({
    id: 'progress',
    title: 'Progress task',
    rank: 'a',
    lifecycleState: 'in_progress',
  }),
  task({
    id: 'review',
    title: 'Review task',
    rank: 'a',
    lifecycleState: 'review',
  }),
  task({
    id: 'done',
    title: 'Finished task',
    rank: 'a',
    lifecycleState: 'done',
  }),
  task({
    id: 'cancelled',
    title: 'Cancelled task',
    rank: 'a',
    lifecycleState: 'cancelled',
  }),
];

const boardProjection = (
  taskOverrides: Task[] = [],
  runs: ProjectRun[] = [],
  dependencies: TaskDependency[] = [],
) => {
  const byTaskId = new Map(
    baseTasks.map((candidate) => [candidate.id, candidate]),
  );
  for (const candidate of taskOverrides) byTaskId.set(candidate.id, candidate);
  const session = sessionSchema.parse({
    id: 'session-1',
    projectId: project.id,
    workspaceId: 'workspace-1',
    title: 'Run tests',
    permissionMode: 'interactive',
    lifecycleState: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const snapshot: ProjectSnapshot = {
    protocolVersion: 1,
    project,
    tasks: [...byTaskId.values()],
    attempts: [
      taskAttemptSchema.parse({
        id: 'attempt-1',
        taskId: 'first',
        sessionId: session.id,
        ordinal: 1,
        source: 'launched',
        actor,
        createdAt: timestamp,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
      taskAttemptSchema.parse({
        id: 'attempt-2',
        taskId: 'first',
        sessionId: 'session-2',
        ordinal: 2,
        source: 'linked',
        actor,
        createdAt: timestamp,
        unlinkedAt: timestamp,
        unlinkedBy: actor,
        unlinkReason: 'Superseded',
      }),
    ],
    transitions: [],
    repairs: [],
    runs,
    dependencies,
    projectRunLimits: { maxConcurrency: 4 },
    cursor: 1,
  };
  return replaceProjectSnapshot(
    createProjection({
      protocolVersion: 1,
      projects: [project],
      workspaces: [],
      sessions: [session],
      events: [],
      pendingApprovals: [],
      lastSequenceBySession: {},
      layouts: [],
    }),
    snapshot,
  );
};

const renderBoard = ({
  archived = false,
  onCommand = vi.fn().mockResolvedValue(undefined),
  onSelectTask,
  runs = [],
  dependencies = [],
}: {
  archived?: boolean;
  onCommand?: (command: MutatingCommand) => Promise<unknown> | void;
  onSelectTask?: (taskId: string) => void;
  runs?: ProjectRun[];
  dependencies?: TaskDependency[];
} = {}) =>
  render(
    <TaskBoard
      project={archived ? { ...project, archivedAt: timestamp } : project}
      projection={boardProjection([], runs, dependencies)}
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

const commandResult = (authoritativeTask: Task) => ({
  protocolVersion: 1,
  commandType: 'task.reorder',
  result: { task: authoritativeTask },
  warnings: [],
});

const dataTransfer = () => {
  const values = new Map<string, string>();
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    files: [],
    items: [],
    types: [],
    clearData: () => values.clear(),
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => values.set(type, value),
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
};
