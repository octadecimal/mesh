import { randomUUID } from 'node:crypto';

import {
  idSchema,
  taskActorSchema,
  type Project,
  type ProjectEvent,
  type ProjectRun,
  type StableTaskErrorCode,
  type TaskActor,
} from '@mesh-session-platform/contracts';

import type { CommandRepository } from '../repositories/command-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { ProjectRunRepository } from '../repositories/project-run-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import { selectEligibleRunTasks } from './project-run-policy.js';

const DEFAULT_MAX_CONCURRENCY = 4;

export type ProjectRunCommandOutcome = {
  run: ProjectRun;
  events: ProjectEvent[];
};

export type StartProjectRunInput = {
  projectId: string;
  concurrency: number;
  actor: TaskActor;
  idempotencyKey: string;
};

export type ChangeProjectRunInput = {
  runId: string;
  expectedRevision: number;
  actor: TaskActor;
  idempotencyKey: string;
};

type ProjectRunServiceDependencies = {
  projects: ProjectRepository;
  tasks: TaskRepository;
  attempts: TaskAttemptRepository;
  projectRuns: ProjectRunRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  publisher: { publishProject(event: ProjectEvent): void };
  maxConcurrency?: number;
  now?: () => string;
  createId?: () => string;
};

export class ProjectRunServiceError extends Error {
  constructor(
    readonly code: StableTaskErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProjectRunServiceError';
  }
}

export class ProjectRunService {
  private readonly maxConcurrency: number;

  constructor(private readonly dependencies: ProjectRunServiceDependencies) {
    this.maxConcurrency =
      dependencies.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new TypeError('Project run maximum concurrency must be positive');
    }
  }

  startRun(input: StartProjectRunInput): ProjectRunCommandOutcome {
    return this.execute(input.idempotencyKey, () => {
      this.requireHuman(input.actor);
      const project = this.requireActiveProject(input.projectId);
      this.requireConcurrency(input.concurrency);
      const active = this.dependencies.projectRuns.getActiveByProject(
        project.id,
      );
      if (active) {
        throw new ProjectRunServiceError(
          'project_run_conflict',
          `Project '${project.id}' already has an active run`,
          { run: active },
        );
      }

      const tasks = this.dependencies.tasks.listByProject(project.id);
      const currentAttemptTaskIds = new Set(
        tasks
          .filter((task) =>
            this.dependencies.attempts
              .listByTask(task.id)
              .some(({ unlinkedAt }) => unlinkedAt === null),
          )
          .map(({ id }) => id),
      );
      const eligible = selectEligibleRunTasks({
        project,
        tasks,
        currentAttemptTaskIds,
      });
      if (eligible.length === 0) {
        throw new ProjectRunServiceError(
          'project_run_empty',
          `Project '${project.id}' has no eligible tasks`,
        );
      }

      const occurredAt = this.now();
      const runId = this.createId();
      const run = this.dependencies.projectRuns.create({
        id: runId,
        projectId: project.id,
        concurrency: input.concurrency,
        startedAt: occurredAt,
        items: eligible.map(
          (
            { task, policyRevision, taskAutomationGeneration },
            queuePosition,
          ) => ({
            id: this.createId(),
            taskId: task.id,
            taskRevision: task.revision,
            policyRevision,
            taskAutomationGeneration,
            queuePosition,
            launchIdempotencyKey: `${runId}:${task.id}:launch`,
          }),
        ),
      });
      return this.outcome(run, occurredAt);
    });
  }

  pauseRun(input: ChangeProjectRunInput): ProjectRunCommandOutcome {
    return this.execute(input.idempotencyKey, () => {
      this.requireHuman(input.actor);
      const run = this.requireCurrentRun(input);
      this.requireState(run, ['running']);
      const changed = this.dependencies.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: run.revision,
        state: 'paused',
        occurredAt: this.now(),
      });
      if (!changed) this.throwStale(run.id);
      return this.outcome(changed, changed.updatedAt);
    });
  }

  resumeRun(input: ChangeProjectRunInput): ProjectRunCommandOutcome {
    return this.execute(input.idempotencyKey, () => {
      this.requireHuman(input.actor);
      const run = this.requireCurrentRun(input);
      this.requireState(run, ['paused']);
      this.requireActiveProject(run.projectId);
      const changed = this.dependencies.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: run.revision,
        state: 'running',
        occurredAt: this.now(),
      });
      if (!changed) this.throwStale(run.id);
      return this.outcome(changed, changed.updatedAt);
    });
  }

  stopRun(input: ChangeProjectRunInput): ProjectRunCommandOutcome {
    return this.execute(input.idempotencyKey, () => {
      this.requireHuman(input.actor);
      let run = this.requireCurrentRun(input);
      this.requireState(run, ['running', 'paused']);
      const occurredAt = this.now();
      for (const item of run.items) {
        if (item.status !== 'queued') continue;
        run = this.dependencies.projectRuns.finishItem({
          runId: run.id,
          itemId: item.id,
          expectedRunRevision: run.revision,
          status: 'not_started',
          outcomeReason: 'stopped',
          occurredAt,
        });
      }
      const counts = this.dependencies.projectRuns.reconcileCounts(run.id);
      const occupied = counts.launchPending + counts.active;
      const changed = this.dependencies.projectRuns.changeState({
        runId: run.id,
        expectedRunRevision: run.revision,
        state: occupied === 0 ? 'completed' : 'draining',
        ...(occupied === 0 ? { completionReason: 'stopped' } : {}),
        occurredAt,
      });
      if (!changed) this.throwStale(run.id);
      return this.outcome(changed, occurredAt);
    });
  }

  private execute(
    idempotencyKey: string,
    mutate: () => ProjectRunCommandOutcome,
  ): ProjectRunCommandOutcome {
    const commandId = idSchema.parse(idempotencyKey);
    const existing =
      this.dependencies.commands.getExisting<ProjectRunCommandOutcome>(
        commandId,
      );
    if (existing.found) return existing.response;
    const outcome =
      this.dependencies.commands.executeOnceInImmediateTransaction(
        commandId,
        mutate,
      );
    for (const event of outcome.events) {
      this.dependencies.publisher.publishProject(event);
    }
    return outcome;
  }

  private requireHuman(actor: TaskActor): void {
    const parsed = taskActorSchema.parse(actor);
    if (parsed.type !== 'human') {
      throw new ProjectRunServiceError(
        'project_run_invalid',
        'Project runs require a human operator',
      );
    }
  }

  private requireConcurrency(concurrency: number): void {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new ProjectRunServiceError(
        'project_run_invalid',
        'Project run concurrency must be a positive integer',
      );
    }
    if (concurrency > this.maxConcurrency) {
      throw new ProjectRunServiceError(
        'project_run_concurrency_exceeded',
        `Project run concurrency cannot exceed ${this.maxConcurrency}`,
        { maxConcurrency: this.maxConcurrency },
      );
    }
  }

  private requireActiveProject(projectId: string): Project {
    const parsedId = idSchema.parse(projectId);
    const project = this.dependencies.projects.get(parsedId);
    if (!project) {
      throw new ProjectRunServiceError(
        'project_not_found',
        `Project '${parsedId}' was not found`,
      );
    }
    if (project.archivedAt) {
      throw new ProjectRunServiceError(
        'project_archived',
        `Project '${parsedId}' is archived`,
        { project },
      );
    }
    return project;
  }

  private requireCurrentRun(input: ChangeProjectRunInput): ProjectRun {
    const runId = idSchema.parse(input.runId);
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      throw new ProjectRunServiceError(
        'project_run_invalid',
        'Expected project run revision must be a positive integer',
      );
    }
    const run = this.dependencies.projectRuns.get(runId);
    if (!run) {
      throw new ProjectRunServiceError(
        'project_run_not_found',
        `Project run '${runId}' was not found`,
      );
    }
    if (run.revision !== input.expectedRevision) this.throwStale(runId, run);
    return run;
  }

  private requireState(
    run: ProjectRun,
    allowed: readonly ProjectRun['state'][],
  ): void {
    if (!allowed.includes(run.state)) {
      throw new ProjectRunServiceError(
        'project_run_transition_invalid',
        `Project run '${run.id}' cannot be controlled from '${run.state}'`,
        { run },
      );
    }
  }

  private throwStale(runId: string, run?: ProjectRun): never {
    throw new ProjectRunServiceError(
      'project_run_revision_conflict',
      `Project run '${runId}' has changed`,
      { run: run ?? this.dependencies.projectRuns.get(runId) },
    );
  }

  private outcome(
    run: ProjectRun,
    occurredAt: string,
  ): ProjectRunCommandOutcome {
    const event = this.dependencies.projectEvents.appendInTransaction(
      run.projectId,
      {
        protocolVersion: 1,
        id: this.createId(),
        projectId: run.projectId,
        occurredAt,
        type: 'project.run_changed',
        payload: { run },
      },
    );
    return { run, events: [event] };
  }

  private now(): string {
    return (this.dependencies.now ?? (() => new Date().toISOString()))();
  }

  private createId(): string {
    return idSchema.parse((this.dependencies.createId ?? randomUUID)());
  }
}
