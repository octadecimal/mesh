import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  projectSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskSchema,
  taskTransitionSchema,
  type MutatingCommand,
  type Session,
  type Task,
} from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import { TaskDrawer } from './TaskDrawer';

describe('TaskDrawer', () => {
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
      description: 'Server description',
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

    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), 'My local draft');
    await user.click(screen.getByRole('button', { name: 'Save task' }));

    const conflict = await screen.findByRole('alert');
    expect(conflict).toHaveTextContent('Server version');
    expect(conflict).toHaveTextContent('Server description');
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

  it('links only same-project sessions and confirms unlink with a reason', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue(undefined);
    renderDrawer({ onCommand });

    const choices = screen.getByLabelText('Existing session');
    expect(
      within(choices).getByRole('option', { name: 'Old run' }),
    ).toBeDefined();
    expect(
      within(choices).queryByRole('option', { name: 'Other project' }),
    ).toBeNull();
    await user.selectOptions(choices, 'session-unlinked');
    await user.click(screen.getByRole('button', { name: 'Link session' }));
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.attempt.link',
        payload: expect.objectContaining({ sessionId: 'session-unlinked' }),
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Unlink attempt 1' }));
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
          attemptId: 'attempt-1',
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

const renderDrawer = (
  options: {
    task?: Task;
    onCommand?: (command: MutatingCommand) => Promise<unknown> | void;
    onOpenSession?: (sessionId: string) => void;
    withRepair?: boolean;
  } = {},
) => {
  const selectedTask = 'task' in options ? options.task : task;
  const onCommand = options.onCommand ?? vi.fn().mockResolvedValue(undefined);
  const onOpenSession = options.onOpenSession ?? vi.fn();
  return render(
    <TaskDrawer
      open
      project={project}
      task={selectedTask}
      attempts={
        selectedTask
          ? attempts.map((attempt) => ({
              attempt,
              session: sessions.find(({ id }) => id === attempt.sessionId),
            }))
          : []
      }
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
      sessions={sessions}
      onOpenChange={() => undefined}
      onCommand={onCommand}
      onOpenSession={onOpenSession}
    />,
  );
};
