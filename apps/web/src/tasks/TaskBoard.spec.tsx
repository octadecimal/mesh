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
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  type MutatingCommand,
  type ProjectSnapshot,
  type Task,
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

  it('exposes card selection without owning the task drawer', async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    renderBoard({ onSelectTask });

    await user.click(screen.getByRole('button', { name: 'Open First task' }));

    expect(onSelectTask).toHaveBeenCalledWith('first');
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

  it('settles a move on any newer authoritative revision and reports a conflict', async () => {
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
            lifecycleState: 'in_progress',
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
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Task changed before the requested move was applied.',
    );
    expect(
      within(
        screen.getByRole('region', { name: 'In progress tasks' }),
      ).getByText('First task'),
    ).toBeDefined();

    await act(async () => command.resolve({}));
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

const boardProjection = (taskOverrides: Task[] = []) => {
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
}: {
  archived?: boolean;
  onCommand?: (command: MutatingCommand) => Promise<unknown> | void;
  onSelectTask?: (taskId: string) => void;
} = {}) =>
  render(
    <TaskBoard
      project={archived ? { ...project, archivedAt: timestamp } : project}
      projection={boardProjection()}
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
