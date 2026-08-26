import * as Dialog from '@radix-ui/react-dialog';
import {
  taskActorSchema,
  type AttemptRepair,
  type DeveloperBlockerReport,
  type DeveloperCompletionReport,
  type DeveloperExecutionCycle,
  type DeveloperReviewFeedback,
  type MutatingCommand,
  type PermissionMode,
  type Project,
  type Session,
  type Task,
  type TaskAttempt,
  type TaskLifecycleState,
  type TaskPriority,
  type TaskTransition,
} from '@mesh-session-platform/contracts';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  WorkspaceFields,
  type WorkspaceDraft,
} from '../sessions/WorkspaceFields';
import { AttemptTimeline } from './AttemptTimeline';
import { DeveloperExecutionPanel } from './DeveloperExecutionPanel';

type TimelineAttempt = { attempt: TaskAttempt; session?: Session };

type TaskDraft = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: TaskPriority;
  labels: string;
};

type AuditedAction =
  | { kind: 'block' }
  | { kind: 'unblock' }
  | { kind: 'transition'; nextState: TaskLifecycleState }
  | { kind: 'unlink'; attempt: TaskAttempt };

type CommandType = MutatingCommand['type'];

type ConflictState = {
  task: Task;
  operation: CommandType;
};

type LaunchPending = {
  id: number;
  taskRevision: number;
  lifecycleState: TaskLifecycleState;
  attemptProjection: string;
  commandSettled: boolean;
};

const operator = taskActorSchema.parse({
  type: 'human',
  id: 'operator',
  displayName: 'Operator',
});

const transitionLabels: Record<
  TaskLifecycleState,
  Partial<Record<TaskLifecycleState, string>>
> = {
  backlog: { ready: 'Move to ready', cancelled: 'Cancel task' },
  ready: {
    backlog: 'Move back to backlog',
    in_progress: 'Start progress',
    cancelled: 'Cancel task',
  },
  in_progress: {
    ready: 'Move back to ready',
    review: 'Mark for review',
    cancelled: 'Cancel task',
  },
  review: {
    in_progress: 'Return to progress',
    done: 'Mark done',
    cancelled: 'Cancel task',
  },
  done: { review: 'Restore to review' },
  cancelled: { backlog: 'Restore to backlog' },
};

const reasonRequired = (from: TaskLifecycleState, to: TaskLifecycleState) =>
  to === 'cancelled' ||
  from === 'cancelled' ||
  [
    'ready:backlog',
    'in_progress:ready',
    'review:in_progress',
    'done:review',
  ].includes(`${from}:${to}`);

const draftFor = (task?: Task): TaskDraft => ({
  title: task?.title ?? '',
  description: task?.description ?? '',
  acceptanceCriteria: task?.acceptanceCriteria.join('\n') ?? '',
  priority: task?.priority ?? 'normal',
  labels: task?.labels.join(', ') ?? '',
});

const listFromLines = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

const listFromCommas = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const isAbsolutePath = (path: string) =>
  /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());

const readinessProblems = (draft: TaskDraft) => {
  const problems: string[] = [];
  if (!draft.title.trim()) problems.push('Title');
  if (!draft.description.trim()) problems.push('Description');
  if (listFromLines(draft.acceptanceCriteria).length === 0)
    problems.push('Acceptance criteria');
  if (!draft.priority) problems.push('Priority');
  return problems;
};

const workspaceFor = (project: Project): WorkspaceDraft => ({
  type: 'shared',
  sharedPath: project.repositoryPath,
  repositoryPath: project.repositoryPath,
  worktreePath: '',
  branch: '',
  startPoint: 'HEAD',
});

const conflictOperationLabels: Partial<Record<CommandType, string>> = {
  'task.block': 'Block task',
  'task.unblock': 'Unblock task',
  'task.transition': 'Task transition',
  'task.attempt.link': 'Link session',
  'task.attempt.unlink': 'Unlink attempt',
  'task.attempt.launch': 'Launch attempt',
};

const displayValue = (value: string) => value || 'Empty';
const displayPriority = (priority: TaskPriority) =>
  `${priority.charAt(0).toUpperCase()}${priority.slice(1)}`;

const failureDetails = (caught: unknown) =>
  caught && typeof caught === 'object'
    ? (caught as {
        code?: string;
        message?: string;
        details?: { task?: Task };
      })
    : undefined;

export function TaskDrawer({
  open,
  onOpenChange,
  project,
  task,
  attempts,
  transitions,
  repairs,
  sessions,
  developerCycles,
  developerCompletionReports,
  developerBlockerReports,
  developerReviewFeedback,
  connected,
  onCommand,
  onOpenSession,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  project: Project;
  task?: Task;
  attempts: readonly TimelineAttempt[];
  transitions: readonly TaskTransition[];
  repairs: readonly AttemptRepair[];
  sessions: readonly Session[];
  developerCycles: readonly DeveloperExecutionCycle[];
  developerCompletionReports: readonly DeveloperCompletionReport[];
  developerBlockerReports: readonly DeveloperBlockerReport[];
  developerReviewFeedback: readonly DeveloperReviewFeedback[];
  connected: boolean;
  onCommand: (command: MutatingCommand) => Promise<unknown> | void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [draft, setDraft] = useState(() => draftFor(task));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<ConflictState>();
  const [launchPending, setLaunchPending] = useState<LaunchPending>();
  const launchRequestId = useRef(0);
  const activeLaunchRequestId = useRef<number | undefined>(undefined);
  const [action, setAction] = useState<AuditedAction>();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [workspace, setWorkspace] = useState<WorkspaceDraft>(() =>
    workspaceFor(project),
  );
  const [sessionId, setSessionId] = useState<Session['id'] | ''>('');
  const readOnly = Boolean(project.archivedAt);
  const missingReadiness = readinessProblems(draft);
  const canonicalMissingReadiness = task
    ? readinessProblems(draftFor(task))
    : missingReadiness;
  const taskRepairs = repairs.filter((repair) => repair.taskId === task?.id);
  const attemptOrdinals = new Map(
    attempts.map(({ attempt }) => [attempt.id, attempt.ordinal]),
  );
  const orderedDeveloperCycles = [...developerCycles].sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      (attemptOrdinals.get(left.attemptId) ?? Number.MAX_SAFE_INTEGER) -
        (attemptOrdinals.get(right.attemptId) ?? Number.MAX_SAFE_INTEGER) ||
      left.ordinal - right.ordinal,
  );
  const latestDeveloperCycle =
    orderedDeveloperCycles[orderedDeveloperCycles.length - 1];
  const hasDeveloperReview = Boolean(
    latestDeveloperCycle?.terminalDisposition === 'submitted_for_review' &&
      developerCompletionReports.some(
        (report) => report.cycleId === latestDeveloperCycle.id,
      ),
  );
  const hasDeveloperBlocker = Boolean(
    latestDeveloperCycle?.terminalDisposition === 'blocked' &&
      developerBlockerReports.some(
        (report) => report.cycleId === latestDeveloperCycle.id,
      ),
  );
  const attemptProjection = attempts
    .map(
      ({ attempt }) =>
        `${attempt.id}:${attempt.sessionId}:${attempt.unlinkedAt ?? ''}`,
    )
    .sort()
    .join('|');
  const linkChoices = useMemo(() => {
    const currentSessionIds = new Set(
      attempts
        .filter(({ attempt }) => !attempt.unlinkedAt)
        .map(({ attempt }) => attempt.sessionId),
    );
    return sessions.filter(
      (session) =>
        session.projectId === project.id && !currentSessionIds.has(session.id),
    );
  }, [attempts, project.id, sessions]);
  const sessionToLink = linkChoices.find((session) => session.id === sessionId);

  useEffect(() => {
    setDraft(draftFor(task));
    setConflict(undefined);
    setLaunchPending(undefined);
    launchRequestId.current += 1;
    activeLaunchRequestId.current = undefined;
    setAction(undefined);
    setReason('');
    setConfirmed(false);
    setError(undefined);
  }, [task?.id]);

  useEffect(() => {
    setWorkspace(workspaceFor(project));
  }, [project.id, project.repositoryPath]);

  useEffect(() => {
    if (
      !conflict ||
      conflict.operation === 'task.edit' ||
      !task ||
      task.revision < conflict.task.revision
    )
      return;
    setConflict(undefined);
  }, [conflict, task]);

  useEffect(() => {
    if (
      !launchPending ||
      !launchPending.commandSettled ||
      !task ||
      (task.revision <= launchPending.taskRevision &&
        task.lifecycleState === launchPending.lifecycleState &&
        attemptProjection === launchPending.attemptProjection)
    )
      return;
    if (activeLaunchRequestId.current === launchPending.id)
      activeLaunchRequestId.current = undefined;
    setLaunchPending((current) =>
      current?.id === launchPending.id ? undefined : current,
    );
  }, [attemptProjection, launchPending, task]);

  const handleCommandFailure = (caught: unknown, operation: CommandType) => {
    const failure = failureDetails(caught);
    if (failure?.code === 'task_revision_conflict' && failure.details?.task) {
      setConflict({ task: failure.details.task, operation });
      if (operation !== 'task.edit') {
        setAction(undefined);
        setReason('');
        setConfirmed(false);
      }
    } else {
      setError(failure?.message ?? 'The task command failed.');
    }
  };

  const execute = async (
    command: MutatingCommand,
    options: { close?: boolean; preserveAction?: boolean } = {},
  ) => {
    if (pending || readOnly) return false;
    setPending(true);
    setError(undefined);
    try {
      await onCommand(command);
      if (!options.preserveAction) {
        setAction(undefined);
        setReason('');
        setConfirmed(false);
      }
      if (options.close) onOpenChange?.(false);
      return true;
    } catch (caught) {
      handleCommandFailure(caught, command.type);
      return false;
    } finally {
      setPending(false);
    }
  };

  const submitTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.title.trim()) return;
    if (!task) {
      void execute(
        {
          type: 'task.create',
          payload: {
            projectId: project.id,
            title: draft.title.trim(),
            actor: operator,
          },
        },
        { close: true },
      );
      return;
    }
    void saveTask(
      conflict?.operation === 'task.edit'
        ? conflict.task.revision
        : task.revision,
    );
  };

  const saveTask = (expectedRevision: number) => {
    if (!task) return Promise.resolve(false);
    return execute({
      type: 'task.edit',
      payload: {
        taskId: task.id,
        expectedRevision,
        patch: {
          title: draft.title.trim(),
          description: draft.description,
          acceptanceCriteria: listFromLines(draft.acceptanceCriteria),
          priority: draft.priority,
          labels: listFromCommas(draft.labels),
        },
        actor: operator,
      },
    }).then((saved) => saved && setConflict(undefined));
  };

  const transition = (nextState: TaskLifecycleState) => {
    if (!task) return;
    if (reasonRequired(task.lifecycleState, nextState)) {
      setAction({ kind: 'transition', nextState });
      setReason('');
      return;
    }
    void execute({
      type: 'task.transition',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        nextState,
        actor: operator,
      },
    });
  };

  const submitAuditedAction = () => {
    if (!task || !action || !reason.trim()) return;
    if (action.kind === 'unlink') {
      if (!confirmed) return;
      void execute({
        type: 'task.attempt.unlink',
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          attemptId: action.attempt.id,
          reason: reason.trim(),
          actor: operator,
        },
      });
      return;
    }
    if (action.kind === 'block' || action.kind === 'unblock') {
      void execute({
        type: action.kind === 'block' ? 'task.block' : 'task.unblock',
        payload: {
          taskId: task.id,
          expectedRevision: task.revision,
          reason: reason.trim(),
          actor: operator,
        },
      });
      return;
    }
    void execute({
      type: 'task.transition',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        nextState: action.nextState,
        reason: reason.trim(),
        actor: operator,
      },
    });
  };

  const launch = () => {
    if (
      !task ||
      !permissionMode ||
      canonicalMissingReadiness.length > 0 ||
      launchPending
    )
      return;
    const launchWorkspace =
      workspace.type === 'shared'
        ? { type: 'shared' as const, path: workspace.sharedPath.trim() }
        : {
            type: 'worktree' as const,
            repositoryPath: workspace.repositoryPath.trim(),
            path: workspace.worktreePath.trim(),
            branch: workspace.branch.trim(),
            startPoint: workspace.startPoint.trim(),
          };
    const command: MutatingCommand = {
      type: 'task.attempt.launch',
      payload: {
        taskId: task.id,
        expectedRevision: task.revision,
        title: task.title,
        permissionMode,
        workspace: launchWorkspace,
        actor: operator,
      },
    };
    const id = ++launchRequestId.current;
    activeLaunchRequestId.current = id;
    setLaunchPending({
      id,
      taskRevision: task.revision,
      lifecycleState: task.lifecycleState,
      attemptProjection,
      commandSettled: false,
    });
    setError(undefined);
    Promise.resolve()
      .then(() => onCommand(command))
      .then(() => {
        if (launchRequestId.current !== id) return;
        setLaunchPending((current) =>
          current?.id === id ? { ...current, commandSettled: true } : current,
        );
      })
      .catch((caught) => {
        if (launchRequestId.current !== id) return;
        activeLaunchRequestId.current = undefined;
        setLaunchPending((current) =>
          current?.id === id ? undefined : current,
        );
        handleCommandFailure(caught, command.type);
      });
  };

  const awaitingConflictResync = Boolean(
    conflict &&
      conflict.operation !== 'task.edit' &&
      (!task || task.revision < conflict.task.revision),
  );

  const canLaunch =
    !readOnly &&
    task?.lifecycleState === 'ready' &&
    !task.blocked &&
    canonicalMissingReadiness.length === 0 &&
    Boolean(permissionMode) &&
    (workspace.type === 'shared'
      ? isAbsolutePath(workspace.sharedPath)
      : Boolean(
          isAbsolutePath(workspace.repositoryPath) &&
            isAbsolutePath(workspace.worktreePath) &&
            workspace.branch.trim() &&
            workspace.startPoint.trim(),
        ));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay task-drawer-overlay" />
        <Dialog.Content
          className="task-drawer"
          aria-describedby="task-drawer-description"
        >
          <header className="task-drawer-header">
            <div>
              <span className="eyebrow">
                {task ? 'Task detail' : 'Backlog'}
              </span>
              <Dialog.Title>{task?.title ?? 'Create task'}</Dialog.Title>
              <Dialog.Description id="task-drawer-description">
                {task
                  ? 'Edit readiness, manage lifecycle, and inspect immutable attempt history.'
                  : 'Capture a task now and refine its execution details later.'}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="button button-ghost" type="button">
                Close
              </button>
            </Dialog.Close>
          </header>

          <div className="task-drawer-body">
            {readOnly ? (
              <p className="notice notice-warning">
                Archived projects are read-only.
              </p>
            ) : null}
            {error ? (
              <p className="notice notice-error" role="alert">
                {error}
              </p>
            ) : null}
            {conflict?.operation === 'task.edit' ? (
              <div className="notice notice-warning task-conflict" role="alert">
                <strong>
                  Edit conflict — Server version (revision{' '}
                  {conflict.task.revision})
                </strong>
                <p>
                  Your draft is preserved. Compare every editable field before
                  retrying.
                </p>
                {[
                  ['Title', draft.title, conflict.task.title],
                  ['Description', draft.description, conflict.task.description],
                  [
                    'Acceptance criteria',
                    draft.acceptanceCriteria,
                    conflict.task.acceptanceCriteria.join('\n'),
                  ],
                  [
                    'Priority',
                    displayPriority(draft.priority),
                    displayPriority(conflict.task.priority),
                  ],
                  ['Labels', draft.labels, conflict.task.labels.join(', ')],
                ].map(([label, draftValue, serverValue]) => (
                  <div className="task-conflict-field" key={label}>
                    <strong>{label}</strong>
                    <p>
                      <span>Draft</span> {displayValue(draftValue)}
                    </p>
                    <p>
                      <span>Server</span> {displayValue(serverValue)}
                    </p>
                  </div>
                ))}
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={pending || readOnly}
                  onClick={() => void saveTask(conflict.task.revision)}
                >
                  Retry with server revision
                </button>
              </div>
            ) : null}
            {conflict && conflict.operation !== 'task.edit' ? (
              <div className="notice notice-warning task-conflict" role="alert">
                <strong>
                  {conflictOperationLabels[conflict.operation] ?? 'Task action'}{' '}
                  conflicted
                </strong>
                <p>
                  The server is at revision {conflict.task.revision}. Wait for
                  project resync, then re-invoke the action after resync.
                </p>
              </div>
            ) : null}

            <form className="task-edit-form" onSubmit={submitTask}>
              <label>
                Task title
                <input
                  aria-label="Task title"
                  required
                  disabled={readOnly || pending}
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                />
              </label>
              {task ? (
                <>
                  <label>
                    Description
                    <textarea
                      aria-label="Description"
                      disabled={readOnly || pending}
                      value={draft.description}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          description: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Acceptance criteria
                    <textarea
                      aria-label="Acceptance criteria"
                      disabled={readOnly || pending}
                      value={draft.acceptanceCriteria}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          acceptanceCriteria: event.target.value,
                        }))
                      }
                    />
                    <span>One criterion per line.</span>
                  </label>
                  <div className="task-edit-row">
                    <label>
                      Priority
                      <select
                        aria-label="Priority"
                        disabled={readOnly || pending}
                        value={draft.priority}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            priority: event.target.value as TaskPriority,
                          }))
                        }
                      >
                        <option value="low">Low</option>
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </label>
                    <label>
                      Labels
                      <input
                        aria-label="Labels"
                        disabled={readOnly || pending}
                        value={draft.labels}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            labels: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                </>
              ) : null}
              <button
                className="button button-primary"
                type="submit"
                disabled={readOnly || pending || !draft.title.trim()}
              >
                {task ? 'Save task' : 'Create task'}
              </button>
            </form>

            {task ? (
              <>
                <section
                  className="task-drawer-section"
                  aria-label="Task lifecycle"
                >
                  <div className="task-section-heading">
                    <h3>Lifecycle</h3>
                    <span className="task-state">
                      {task.lifecycleState.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {canonicalMissingReadiness.length > 0 ? (
                    <p className="notice notice-warning task-readiness">
                      Missing readiness fields:{' '}
                      {canonicalMissingReadiness.join(', ')}.
                    </p>
                  ) : null}
                  {task.blocked ? (
                    <p className="task-blocked-detail">
                      Blocked — {task.blocked.reason}
                    </p>
                  ) : null}
                  <div className="task-lifecycle-actions">
                    {Object.entries(transitionLabels[task.lifecycleState])
                      .filter(
                        ([nextState]) =>
                          !(
                            hasDeveloperReview &&
                            task.lifecycleState === 'review' &&
                            (nextState === 'done' ||
                              nextState === 'in_progress')
                          ),
                      )
                      .map(([nextState, label]) => (
                        <button
                          className="button button-secondary"
                          type="button"
                          key={nextState}
                          disabled={
                            readOnly ||
                            pending ||
                            awaitingConflictResync ||
                            (nextState === 'ready' &&
                              canonicalMissingReadiness.length > 0) ||
                            (nextState === 'in_progress' &&
                              (canonicalMissingReadiness.length > 0 ||
                                Boolean(task.blocked)))
                          }
                          onClick={() =>
                            transition(nextState as TaskLifecycleState)
                          }
                        >
                          {label}
                        </button>
                      ))}
                    {!(task.blocked && hasDeveloperBlocker) ? (
                      <button
                        className="button button-ghost"
                        type="button"
                        disabled={readOnly || pending || awaitingConflictResync}
                        onClick={() => {
                          setAction({
                            kind: task.blocked ? 'unblock' : 'block',
                          });
                          setReason('');
                        }}
                      >
                        {task.blocked ? 'Unblock task' : 'Block task'}
                      </button>
                    ) : null}
                  </div>
                </section>

                {action ? (
                  <section
                    className="task-audit-action"
                    aria-label="Confirm audited action"
                  >
                    <h3>
                      {action.kind === 'unlink'
                        ? `Unlink attempt ${action.attempt.ordinal}`
                        : action.kind === 'transition'
                          ? `Move task to ${action.nextState.replace(/_/g, ' ')}`
                          : `${action.kind === 'block' ? 'Block' : 'Unblock'} task`}
                    </h3>
                    <label>
                      {action.kind === 'unlink'
                        ? 'Unlink reason'
                        : 'Action reason'}
                      <textarea
                        aria-label={
                          action.kind === 'unlink'
                            ? 'Unlink reason'
                            : 'Action reason'
                        }
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                    {action.kind === 'unlink' ? (
                      <label className="task-confirm-checkbox">
                        <input
                          aria-label="Confirm unlink attempt"
                          type="checkbox"
                          checked={confirmed}
                          onChange={(event) =>
                            setConfirmed(event.target.checked)
                          }
                        />
                        Keep this attempt in immutable history and remove its
                        active link.
                      </label>
                    ) : null}
                    <div className="task-audit-actions">
                      <button
                        className="button button-ghost"
                        type="button"
                        onClick={() => setAction(undefined)}
                      >
                        Keep unchanged
                      </button>
                      <button
                        className="button button-primary"
                        type="button"
                        disabled={
                          pending ||
                          awaitingConflictResync ||
                          !reason.trim() ||
                          (action.kind === 'unlink' && !confirmed)
                        }
                        onClick={submitAuditedAction}
                      >
                        {action.kind === 'unlink'
                          ? 'Confirm unlink'
                          : action.kind === 'transition'
                            ? 'Confirm transition'
                            : action.kind === 'block'
                              ? 'Confirm block'
                              : 'Confirm unblock'}
                      </button>
                    </div>
                  </section>
                ) : null}

                <DeveloperExecutionPanel
                  project={project}
                  task={task}
                  attempts={attempts}
                  cycles={developerCycles}
                  completionReports={developerCompletionReports}
                  blockerReports={developerBlockerReports}
                  feedback={developerReviewFeedback}
                  repairs={taskRepairs}
                  connected={connected}
                  readOnly={readOnly}
                  onCommand={onCommand}
                  onOpenSession={onOpenSession}
                />

                <section
                  className="task-drawer-section"
                  aria-label="Launch attempt"
                >
                  <div className="task-section-heading">
                    <h3>Launch attempt</h3>
                    <span>
                      {task.lifecycleState === 'ready' ? 'Ready' : 'Not ready'}
                    </span>
                  </div>
                  {task.blocked ? (
                    <p className="notice notice-warning">
                      Unblock the task before launch.
                    </p>
                  ) : null}
                  <WorkspaceFields value={workspace} onChange={setWorkspace} />
                  <label>
                    Permission mode
                    <select
                      aria-label="Permission mode"
                      value={permissionMode}
                      onChange={(event) =>
                        setPermissionMode(
                          event.target.value as PermissionMode | '',
                        )
                      }
                    >
                      <option value="">Select permission mode</option>
                      <option value="interactive">Interactive approvals</option>
                      <option value="safe_auto">Safe automatic actions</option>
                      <option value="inherit">Inherit Claude settings</option>
                    </select>
                  </label>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={
                      !canLaunch ||
                      pending ||
                      Boolean(launchPending) ||
                      awaitingConflictResync
                    }
                    onClick={launch}
                  >
                    Launch attempt
                  </button>
                  {launchPending ? (
                    <p className="task-pending" role="status">
                      Launch pending — waiting for project update.
                    </p>
                  ) : null}
                </section>

                <section
                  className="task-drawer-section"
                  aria-label="Link existing session"
                >
                  <div className="task-section-heading">
                    <h3>Link existing session</h3>
                    <span>Same project only</span>
                  </div>
                  <div className="task-link-controls">
                    <label>
                      Existing session
                      <select
                        aria-label="Existing session"
                        value={sessionId}
                        onChange={(event) =>
                          setSessionId(event.target.value as Session['id'] | '')
                        }
                      >
                        <option value="">Select session</option>
                        {linkChoices.map((session) => (
                          <option key={session.id} value={session.id}>
                            {session.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={
                        readOnly ||
                        pending ||
                        awaitingConflictResync ||
                        !sessionToLink
                      }
                      onClick={() =>
                        sessionToLink &&
                        void execute({
                          type: 'task.attempt.link',
                          payload: {
                            taskId: task.id,
                            expectedRevision: task.revision,
                            sessionId: sessionToLink.id,
                            actor: operator,
                          },
                        })
                      }
                    >
                      Link session
                    </button>
                  </div>
                </section>

                <AttemptTimeline
                  attempts={attempts}
                  repairs={taskRepairs}
                  readOnly={readOnly}
                  onOpenSession={onOpenSession}
                  onRequestUnlink={(attempt) => {
                    setAction({ kind: 'unlink', attempt });
                    setReason('');
                    setConfirmed(false);
                  }}
                />

                <section
                  className="task-transitions"
                  aria-label="Task transition history"
                >
                  <div className="task-section-heading">
                    <h3>Transition history</h3>
                    <span>{transitions.length}</span>
                  </div>
                  {transitions.length === 0 ? (
                    <p className="task-empty-state">No transitions yet.</p>
                  ) : (
                    <ol>
                      {transitions.map((transition) => (
                        <li key={transition.id}>
                          {transition.previousState.replace(/_/g, ' ')} →{' '}
                          {transition.nextState.replace(/_/g, ' ')}
                          {transition.reason ? ` — ${transition.reason}` : ''}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
