import {
  attemptRepairSchema,
  rawDiagnosticSchema,
  type AttemptRepair,
  type Project,
  type ProjectEvent,
  type QaExecutionCycle,
  type QaReport,
  type RawDiagnostic,
  type Task,
  type TaskAttempt,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { QaExecutionRepository } from '../repositories/qa-execution-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import type { QaCapabilityRegistry } from './qa-capability-registry.js';

const liveSessionStates = new Set([
  'starting',
  'running',
  'waiting_for_approval',
  'interrupting',
]);

export type ReconciliationResult = {
  repairs: AttemptRepair[];
  events: ProjectEvent[];
};

type ReconciliationDependencies = {
  database: Database;
  projects: Pick<ProjectRepository, 'list'>;
  tasks: Pick<TaskRepository, 'get' | 'listByProject' | 'update'>;
  attempts: Pick<TaskAttemptRepository, 'listByTask'>;
  developerExecutions: Pick<DeveloperExecutionRepository, 'listByTask'>;
  qaExecutions?: Pick<
    QaExecutionRepository,
    'getReport' | 'listCyclesForAttempts' | 'listPendingAutomationActions'
  >;
  sessions: Pick<SessionRepository, 'get'>;
  workspaces?: Pick<WorkspaceRepository, 'get'>;
  qaCapabilities?: Pick<QaCapabilityRegistry, 'invalidateSession'>;
  diagnostics: Pick<DiagnosticRepository, 'insert' | 'list'>;
  projectEvents: Pick<ProjectEventRepository, 'after' | 'appendInTransaction'>;
  now?: () => string;
};

export const reconcileTaskAttemptLaunchReservations = (
  database: Database,
): number => {
  const result = database
    .prepare(
      `
        DELETE FROM task_attempt_launch_reservations
        WHERE session_id IS NULL
           OR session_id IN (
             SELECT id FROM sessions
             WHERE lifecycle_state NOT IN (
               'starting',
               'running',
               'waiting_for_approval',
               'interrupting'
             )
           )
      `,
    )
    .run();
  return result.changes;
};

const diagnosticPayload = (diagnostic: RawDiagnostic) =>
  typeof diagnostic.payload === 'object' && diagnostic.payload !== null
    ? (diagnostic.payload as Record<string, unknown>)
    : undefined;

const isRecoveryFromLiveState = (diagnostic: RawDiagnostic): boolean => {
  const payload = diagnosticPayload(diagnostic);
  return (
    payload?.kind === 'recovery' &&
    payload.reason === 'backend_restart' &&
    typeof payload.from === 'string' &&
    liveSessionStates.has(payload.from)
  );
};

const isRecordedRepair = (
  diagnostic: RawDiagnostic,
  repair: AttemptRepair,
): boolean => {
  const payload = diagnosticPayload(diagnostic);
  if (payload?.kind !== 'attempt_repair') return false;
  const recorded = payload.repair;
  return (
    typeof recorded === 'object' &&
    recorded !== null &&
    (recorded as Record<string, unknown>).taskId === repair.taskId &&
    (recorded as Record<string, unknown>).attemptId === repair.attemptId &&
    (recorded as Record<string, unknown>).sessionId === repair.sessionId &&
    (recorded as Record<string, unknown>).reason === repair.reason
  );
};

const isRecordedRepairEvent = (
  event: ProjectEvent,
  repair: AttemptRepair,
): boolean => {
  if (event.type !== 'task.attempt_repair_detected') return false;
  const recorded = event.payload.repair;
  return (
    recorded.taskId === repair.taskId &&
    recorded.attemptId === repair.attemptId &&
    recorded.sessionId === repair.sessionId &&
    recorded.reason === repair.reason
  );
};

const repairFor = (
  taskState: string,
  intentionallyDeveloperBlocked: boolean,
  attempts: Array<{
    attempt: TaskAttempt;
    sessionState: string;
    diagnostics: RawDiagnostic[];
  }>,
): AttemptRepair | undefined => {
  let candidate:
    | ((typeof attempts)[number] & { reason: AttemptRepair['reason'] })
    | undefined;

  if (
    taskState === 'in_progress' &&
    !intentionallyDeveloperBlocked &&
    attempts.length > 0 &&
    !attempts.some(({ sessionState }) => liveSessionStates.has(sessionState))
  ) {
    const latest = attempts.at(-1);
    if (latest) {
      candidate = {
        ...latest,
        reason: 'task_in_progress_without_live_session',
      };
    }
  } else if (taskState === 'ready') {
    const latest = attempts
      .filter(
        ({ attempt, sessionState, diagnostics }) =>
          attempt.source === 'launched' &&
          sessionState === 'interrupted' &&
          diagnostics.some(isRecoveryFromLiveState),
      )
      .at(-1);
    if (latest) candidate = { ...latest, reason: 'startup_outcome_unknown' };
  }

  return candidate
    ? attemptRepairSchema.parse({
        taskId: candidate.attempt.taskId,
        attemptId: candidate.attempt.id,
        sessionId: candidate.attempt.sessionId,
        reason: candidate.reason,
      })
    : undefined;
};

const developerRepairsFor = (
  dependencies: Pick<
    ReconciliationDependencies,
    'developerExecutions' | 'sessions'
  >,
  taskId: string,
  attempts: TaskAttempt[],
): AttemptRepair[] =>
  dependencies.developerExecutions.listByTask(taskId).flatMap((cycle) => {
    if (cycle.endedAt !== null) return [];
    const attempt = attempts.find(
      (candidate) => candidate.id === cycle.attemptId,
    );
    if (!attempt) return [];
    const session = dependencies.sessions.get(attempt.sessionId);
    if (session && liveSessionStates.has(session.lifecycleState)) return [];

    return [
      attemptRepairSchema.parse({
        taskId: attempt.taskId,
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        reason: 'developer_cycle_without_live_session',
      }),
    ];
  });

const hasTrustworthyTerminalReport = (
  cycle: QaExecutionCycle,
  report: QaReport | undefined,
): boolean =>
  cycle.terminalDisposition !== null &&
  cycle.endedAt !== null &&
  cycle.reportId !== null &&
  cycle.terminalCommandId !== null &&
  cycle.terminalEventId !== null &&
  report?.id === cycle.reportId &&
  report.cycleId === cycle.id &&
  report.disposition === cycle.terminalDisposition;

const qaRepairsFor = (
  dependencies: ReconciliationDependencies,
  task: Task,
  attempts: TaskAttempt[],
): AttemptRepair[] => {
  if (!dependencies.qaExecutions || !dependencies.workspaces) return [];

  const cycles = dependencies.qaExecutions.listCyclesForAttempts(
    attempts.map((attempt) => attempt.id),
  );
  const repairs: AttemptRepair[] = [];
  for (const cycle of cycles) {
    const session = dependencies.sessions.get(cycle.sessionId);
    const report = cycle.reportId
      ? dependencies.qaExecutions.getReport(cycle.reportId)
      : undefined;
    if (hasTrustworthyTerminalReport(cycle, report)) {
      dependencies.qaCapabilities?.invalidateSession(cycle.sessionId);
      continue;
    }

    const attempt = attempts.find(
      (candidate) => candidate.id === cycle.attemptId,
    );
    const developerSession = attempt
      ? dependencies.sessions.get(attempt.sessionId)
      : undefined;
    const workspace = dependencies.workspaces.get(cycle.workspaceId);
    const workspaceMismatch =
      !workspace ||
      workspace.projectId !== task.projectId ||
      (session !== undefined &&
        (session.workspaceId !== cycle.workspaceId ||
          session.projectId !== task.projectId)) ||
      (developerSession !== undefined &&
        (developerSession.workspaceId !== cycle.workspaceId ||
          developerSession.projectId !== task.projectId));

    if (
      cycle.terminalDisposition === null &&
      session !== undefined &&
      liveSessionStates.has(session.lifecycleState) &&
      !workspaceMismatch
    ) {
      continue;
    }

    dependencies.qaCapabilities?.invalidateSession(cycle.sessionId);
    repairs.push(
      attemptRepairSchema.parse({
        taskId: task.id,
        attemptId: cycle.attemptId,
        sessionId: cycle.sessionId,
        reason:
          cycle.terminalDisposition === null && workspaceMismatch
            ? 'qa_session_workspace_mismatch'
            : 'qa_cycle_without_trustworthy_outcome',
      }),
    );
  }

  for (const action of dependencies.qaExecutions
    .listPendingAutomationActions()
    .filter((candidate) => candidate.taskId === task.id)) {
    const attempt = attempts.find(
      (candidate) => candidate.id === action.attemptId,
    );
    if (!attempt) continue;
    const sourceCycle = cycles.find(
      (candidate) => candidate.id === action.sourceCycleId,
    );
    const sessionId = sourceCycle?.sessionId ?? attempt.sessionId;
    dependencies.qaCapabilities?.invalidateSession(sessionId);
    repairs.push(
      attemptRepairSchema.parse({
        taskId: task.id,
        attemptId: attempt.id,
        sessionId,
        reason: 'review_automation_action_incomplete',
      }),
    );
  }

  return repairs;
};

const qaRepairReasons = new Set<AttemptRepair['reason']>([
  'qa_cycle_without_trustworthy_outcome',
  'qa_session_workspace_mismatch',
  'review_automation_action_incomplete',
]);

const pauseReviewAutomation = (
  dependencies: ReconciliationDependencies,
  repair: AttemptRepair,
  occurredAt: string,
): ProjectEvent | undefined => {
  if (!qaRepairReasons.has(repair.reason)) return undefined;
  const task = dependencies.tasks.get(repair.taskId);
  if (!task || task.reviewAutomation.status !== 'enabled') return undefined;
  const updated = dependencies.tasks.update(
    {
      ...task,
      reviewAutomation: {
        ...task.reviewAutomation,
        status: 'paused',
        pauseReason:
          'Review automation paused because runtime reconciliation found an outcome that requires human repair.',
        updatedAt: occurredAt,
      },
      updatedAt: occurredAt,
    },
    task.revision,
  );
  if (!updated) {
    throw new Error('Task changed during QA runtime reconciliation');
  }
  return dependencies.projectEvents.appendInTransaction(updated.projectId, {
    protocolVersion: 1,
    id: `review-automation-repair-${repair.attemptId}-${repair.sessionId}-${repair.reason}-${updated.reviewAutomation.generation}`,
    projectId: updated.projectId,
    occurredAt,
    type: 'task.review_automation_changed',
    payload: {
      task: updated,
      automation: updated.reviewAutomation,
      action: null,
    },
  });
};

const persistRepair = (
  dependencies: ReconciliationDependencies,
  projectId: Project['id'],
  repair: AttemptRepair,
  occurredAt: string,
  diagnosticRecorded: boolean,
  recordDiagnostic: boolean,
): ProjectEvent[] => {
  const repairIdentity = `${repair.attemptId}-${repair.sessionId}-${repair.reason}`;
  const eventId = qaRepairReasons.has(repair.reason)
    ? `attempt-repair-event-v3-${repairIdentity}`
    : `attempt-repair-event-v2-${repair.attemptId}-${repair.reason}`;
  const diagnosticId = qaRepairReasons.has(repair.reason)
    ? `attempt-repair-diagnostic-v2-${repairIdentity}`
    : `attempt-repair-diagnostic-${repair.attemptId}-${repair.reason}`;
  dependencies.database.exec('BEGIN IMMEDIATE');
  try {
    if (recordDiagnostic && !diagnosticRecorded) {
      dependencies.diagnostics.insert(
        rawDiagnosticSchema.parse({
          id: diagnosticId,
          sessionId: repair.sessionId,
          capturedAt: occurredAt,
          payload: { kind: 'attempt_repair', repair },
        }),
      );
    }
    const event = dependencies.projectEvents.appendInTransaction(projectId, {
      protocolVersion: 1,
      id: eventId,
      projectId,
      occurredAt,
      type: 'task.attempt_repair_detected',
      payload: { repair },
    });
    const automationEvent = pauseReviewAutomation(
      dependencies,
      repair,
      occurredAt,
    );
    dependencies.database.exec('COMMIT');
    return automationEvent ? [event, automationEvent] : [event];
  } catch (error) {
    dependencies.database.exec('ROLLBACK');
    throw error;
  }
};

export const reconcileTaskAttempts = (
  dependencies: ReconciliationDependencies,
): ReconciliationResult => {
  const repairs: AttemptRepair[] = [];
  const events: ProjectEvent[] = [];
  const now = dependencies.now ?? (() => new Date().toISOString());

  for (const project of dependencies.projects.list()) {
    const recordedEvents = dependencies.projectEvents.after(project.id, 0);
    for (const task of dependencies.tasks.listByProject(project.id)) {
      const taskAttempts = dependencies.attempts.listByTask(task.id);
      const attempts = taskAttempts
        .filter((candidate) => candidate.unlinkedAt === null)
        .flatMap((attempt) => {
          const session = dependencies.sessions.get(attempt.sessionId);
          return session
            ? [
                {
                  attempt,
                  sessionState: session.lifecycleState,
                  diagnostics: dependencies.diagnostics.list(attempt.sessionId),
                },
              ]
            : [];
        });
      const developerRepairs = developerRepairsFor(
        dependencies,
        task.id,
        taskAttempts,
      );
      const qaRepairs = qaRepairsFor(dependencies, task, taskAttempts);
      const intentionallyDeveloperBlocked = Boolean(
        task.blocked &&
          dependencies.developerExecutions
            .listByTask(task.id)
            .some(
              (cycle) =>
                cycle.endedAt !== null &&
                cycle.terminalDisposition === 'blocked' &&
                cycle.blockerReportId !== null,
            ),
      );
      const taskRepair = repairFor(
        task.lifecycleState,
        intentionallyDeveloperBlocked,
        attempts,
      );
      const attemptRepairs =
        developerRepairs.length > 0
          ? developerRepairs
          : taskRepair
            ? [taskRepair]
            : [];
      const taskRepairs = [...attemptRepairs, ...qaRepairs].filter(
        (repair, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.taskId === repair.taskId &&
              candidate.attemptId === repair.attemptId &&
              candidate.sessionId === repair.sessionId &&
              candidate.reason === repair.reason,
          ) === index,
      );
      for (const repair of taskRepairs) {
        repairs.push(repair);
        const diagnostics = dependencies.diagnostics.list(repair.sessionId);
        if (
          recordedEvents.some((event) => isRecordedRepairEvent(event, repair))
        ) {
          continue;
        }
        const persistedEvents = persistRepair(
          dependencies,
          project.id,
          repair,
          now(),
          diagnostics.some((diagnostic) =>
            isRecordedRepair(diagnostic, repair),
          ),
          dependencies.sessions.get(repair.sessionId) !== undefined,
        );
        recordedEvents.push(...persistedEvents);
        events.push(...persistedEvents);
      }
    }
  }

  return { repairs, events };
};
