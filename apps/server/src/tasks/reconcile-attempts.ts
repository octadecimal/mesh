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
  attempt: TaskAttempt,
  sessionState: string,
  diagnostics: RawDiagnostic[],
): AttemptRepair | undefined => {
  const reason =
    taskState === 'in_progress' && !liveSessionStates.has(sessionState)
      ? 'task_in_progress_without_live_session'
      : taskState === 'ready' &&
          sessionState === 'interrupted' &&
          diagnostics.some(isRecoveryFromLiveState)
        ? 'startup_outcome_unknown'
        : undefined;
  return reason
    ? attemptRepairSchema.parse({
        taskId: attempt.taskId,
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        reason,
      })
    : undefined;
};

const persistRepair = (
  dependencies: ReconciliationDependencies,
  projectId: Project['id'],
  attempt: TaskAttempt,
  repair: AttemptRepair,
  occurredAt: string,
): ProjectEvent => {
  const eventId = `attempt-repair-event-${attempt.id}-${repair.reason}`;
  const diagnosticId = `attempt-repair-diagnostic-${attempt.id}-${repair.reason}`;
  dependencies.database.exec('BEGIN IMMEDIATE');
  try {
    dependencies.diagnostics.insert(
      rawDiagnosticSchema.parse({
        id: diagnosticId,
        sessionId: attempt.sessionId,
        capturedAt: occurredAt,
        payload: { kind: 'attempt_repair', repair },
      }),
    );
    const event = dependencies.projectEvents.appendInTransaction(projectId, {
      protocolVersion: 1,
      id: eventId,
      projectId,
      occurredAt,
      type: 'task.attempt_changed',
      payload: { attempt },
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
      for (const attempt of dependencies.attempts
        .listByTask(task.id)
        .filter((candidate) => candidate.unlinkedAt === null)) {
        const session = dependencies.sessions.get(attempt.sessionId);
        if (!session) continue;
        const diagnostics = dependencies.diagnostics.list(attempt.sessionId);
        const repair = repairFor(
          task.lifecycleState,
          attempt,
          session.lifecycleState,
          diagnostics,
        );
        if (!repair) continue;
        repairs.push(repair);
        if (
          diagnostics.some((diagnostic) => isRecordedRepair(diagnostic, repair))
        ) {
          continue;
        }
        events.push(
          persistRepair(dependencies, project.id, attempt, repair, now()),
        );
      }
    }
  }

  return { repairs, events };
};
