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
  sessions: Pick<SessionRepository, 'get'>;
  diagnostics: Pick<DiagnosticRepository, 'insert' | 'list'>;
  projectEvents: Pick<ProjectEventRepository, 'appendInTransaction'>;
  now?: () => string;
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

const repairFor = (
  taskState: string,
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

const persistRepair = (
  dependencies: ReconciliationDependencies,
  projectId: Project['id'],
  repair: AttemptRepair,
  occurredAt: string,
): ProjectEvent => {
  const eventId = `attempt-repair-event-${repair.attemptId}-${repair.reason}`;
  const diagnosticId = `attempt-repair-diagnostic-${repair.attemptId}-${repair.reason}`;
  dependencies.database.exec('BEGIN IMMEDIATE');
  try {
    dependencies.diagnostics.insert(
      rawDiagnosticSchema.parse({
        id: diagnosticId,
        sessionId: repair.sessionId,
        capturedAt: occurredAt,
        payload: { kind: 'attempt_repair', repair },
      }),
    );
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
    for (const task of dependencies.tasks.listByProject(project.id)) {
      const attempts = dependencies.attempts
        .listByTask(task.id)
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
      const repair = repairFor(task.lifecycleState, attempts);
      if (!repair) continue;
      repairs.push(repair);
      const diagnostics =
        attempts.find(({ attempt }) => attempt.id === repair.attemptId)
          ?.diagnostics ?? [];
      if (
        diagnostics.some((diagnostic) => isRecordedRepair(diagnostic, repair))
      ) {
        continue;
      }
      events.push(persistRepair(dependencies, project.id, repair, now()));
    }
  }

  return { repairs, events };
};
