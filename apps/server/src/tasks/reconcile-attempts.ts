import {
  attemptRepairSchema,
  rawDiagnosticSchema,
  type AttemptRepair,
  type Project,
  type ProjectEvent,
  type RawDiagnostic,
  type TaskAttempt,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { DeveloperExecutionRepository } from '../repositories/developer-execution-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';

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
  tasks: Pick<TaskRepository, 'listByProject'>;
  attempts: Pick<TaskAttemptRepository, 'listByTask'>;
  developerExecutions: Pick<DeveloperExecutionRepository, 'listByTask'>;
  sessions: Pick<SessionRepository, 'get'>;
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

const persistRepair = (
  dependencies: ReconciliationDependencies,
  projectId: Project['id'],
  repair: AttemptRepair,
  occurredAt: string,
  diagnosticRecorded: boolean,
): ProjectEvent => {
  const eventId = `attempt-repair-event-v2-${repair.attemptId}-${repair.reason}`;
  const diagnosticId = `attempt-repair-diagnostic-${repair.attemptId}-${repair.reason}`;
  dependencies.database.exec('BEGIN IMMEDIATE');
  try {
    if (!diagnosticRecorded) {
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
    dependencies.database.exec('COMMIT');
    return event;
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
      const taskRepairs =
        developerRepairs.length > 0
          ? developerRepairs
          : taskRepair
            ? [taskRepair]
            : [];
      for (const repair of taskRepairs) {
        repairs.push(repair);
        const diagnostics =
          attempts.find(({ attempt }) => attempt.id === repair.attemptId)
            ?.diagnostics ?? [];
        if (
          recordedEvents.some((event) => isRecordedRepairEvent(event, repair))
        ) {
          continue;
        }
        const event = persistRepair(
          dependencies,
          project.id,
          repair,
          now(),
          diagnostics.some((diagnostic) =>
            isRecordedRepair(diagnostic, repair),
          ),
        );
        recordedEvents.push(event);
        events.push(event);
      }
    }
  }

  return { repairs, events };
};
