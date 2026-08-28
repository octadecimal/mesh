import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';

import {
  idSchema,
  projectPlanProposalSchema,
  taskActorSchema,
  taskDependencySchema,
  taskSchema,
  type Project,
  type ProjectEvent,
  type ProjectPlan,
  type ProjectPlanBase,
  type ProjectPlanProposal,
  type ProjectPlanStaleDetails,
  type Task,
  type TaskActor,
  type TaskDependency,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';
import { validateDependencyGraph } from '../domain/task-dependencies.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { PlanningRepository } from '../repositories/planning-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { TaskDependencyRepository } from '../repositories/task-dependency-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import {
  PlanningExecutionError,
  type PlanningMutationResult,
} from './planning-execution-service.js';

export type ApproveProjectPlanInput = {
  projectId: string;
  planId: string;
  proposalId: string;
  expectedPlanRevision: number;
  actor: TaskActor;
  commandId: string;
};

export type RejectProjectPlanInput = Omit<
  ApproveProjectPlanInput,
  'proposalId'
> & { reason: string };

export type PlanApprovalResult = PlanningMutationResult & {
  createdTasks: Task[];
  dependencies: TaskDependency[];
  taskMappings: Array<{ taskKey: string; taskId: Task['id'] }>;
};

type PlanApprovalDependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  dependencies: TaskDependencyRepository;
  plans: PlanningRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  publisher: Pick<EventPublisher, 'publishProject'>;
  onAuditFailure?: (error: unknown) => void;
  now?: () => string;
  createId?: () => string;
};

type CommandExecution<Result> = {
  executed: boolean;
  result: Result;
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const comparableTask = ({ id, revision, lifecycleState, blocked }: Task) => ({
  id,
  revision,
  lifecycleState,
  blocked,
});

const sortedDependencies = (
  dependencies: readonly TaskDependency[],
): TaskDependency[] =>
  [...dependencies].sort(
    (left, right) =>
      compareText(left.taskId, right.taskId) ||
      compareText(left.prerequisiteTaskId, right.prerequisiteTaskId),
  );

const boundedIds = <IdValue extends string>(ids: readonly IdValue[]) => ({
  ids: ids.slice(0, 50),
  total: ids.length,
  truncated: ids.length > 50,
});

export class PlanApprovalService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: PlanApprovalDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async approve(input: ApproveProjectPlanInput): Promise<PlanApprovalResult> {
    const actor = this.requireHuman(input.actor);
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<PlanApprovalResult>(commandId);
    if (existing.found) return existing.response;

    const execution = this.executeCommand(commandId, () =>
      this.approveInTransaction(input, actor),
    );
    if (execution.executed) this.publish(execution.result.events);
    return execution.result;
  }

  async reject(input: RejectProjectPlanInput): Promise<PlanningMutationResult> {
    const actor = this.requireHuman(input.actor);
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<PlanningMutationResult>(commandId);
    if (existing.found) return existing.response;
    const reason = input.reason.trim();
    if (!reason) {
      throw new PlanningExecutionError(
        'project_plan_lifecycle_invalid',
        'Planning rejection reason must not be empty',
      );
    }

    const execution = this.executeCommand(commandId, () => {
      const plan = this.requireReviewPlan(input);
      this.requireProject(plan.projectId);
      const occurredAt = this.now();
      const rejected = this.dependencies.plans.update(plan.id, plan.revision, {
        status: 'rejected',
        attention: null,
        updatedAt: occurredAt,
        terminalAt: occurredAt,
        terminalBy: actor,
        terminalReason: reason,
      });
      if (!rejected) this.throwRevisionConflict(plan.id);
      const event = this.appendEvent(rejected.projectId, {
        protocolVersion: 1,
        id: this.createId(),
        projectId: rejected.projectId,
        occurredAt,
        type: 'project.plan_changed',
        payload: { plan: rejected },
      });
      return { plan: rejected, events: [event] };
    });
    if (execution.executed) this.publish(execution.result.events);
    return execution.result;
  }

  private approveInTransaction(
    input: ApproveProjectPlanInput,
    actor: TaskActor & { type: 'human' },
  ): PlanApprovalResult {
    const plan = this.requireReviewPlan(input);
    const project = this.requireProject(plan.projectId);
    const { base, proposal } = this.requireLatestProposal(
      plan,
      input.proposalId,
    );
    const stale = this.staleDetails(project, base);
    if (
      stale.addedTaskTotal > 0 ||
      stale.removedTaskTotal > 0 ||
      stale.changedTaskTotal > 0 ||
      stale.dependenciesChanged ||
      stale.policyChanged
    ) {
      throw new PlanningExecutionError(
        'project_plan_stale',
        'The project task or policy base changed while the proposal was reviewed',
        stale,
      );
    }
    if (project.archivedAt !== null) {
      throw new PlanningExecutionError(
        'project_archived',
        `Project '${project.id}' is archived`,
      );
    }

    const occurredAt = this.now();
    const currentTasks = this.dependencies.tasks.listByProject(project.id);
    const currentDependencies = this.dependencies.dependencies.listByProject(
      project.id,
    );
    const { createdTasks, taskMappings } = this.buildTasks(
      project,
      proposal,
      currentTasks,
      occurredAt,
    );
    const createdDependencies = this.buildDependencies(
      project,
      proposal,
      taskMappings,
      currentTasks,
      actor,
      occurredAt,
    );
    validateDependencyGraph({
      tasks: [...currentTasks, ...createdTasks],
      dependencies: [...currentDependencies, ...createdDependencies],
    });

    for (const task of createdTasks) this.dependencies.tasks.create(task);
    for (const dependency of createdDependencies) {
      this.dependencies.dependencies.create(dependency);
    }
    this.dependencies.plans.recordApprovalMappings(
      plan.id,
      proposal.id,
      taskMappings.map(({ taskKey, taskId }) => ({
        proposalTaskKey: taskKey,
        taskId,
        createdAt: occurredAt,
      })),
    );
    const approved = this.dependencies.plans.update(plan.id, plan.revision, {
      status: 'approved',
      attention: null,
      updatedAt: occurredAt,
      terminalAt: occurredAt,
      terminalBy: actor,
      terminalReason: null,
    });
    if (!approved) this.throwRevisionConflict(plan.id);

    const events: ProjectEvent[] = [
      this.appendEvent(project.id, {
        protocolVersion: 1,
        id: this.createId(),
        projectId: project.id,
        occurredAt,
        type: 'project.plan_changed',
        payload: { plan: approved },
      }),
    ];
    for (const task of createdTasks) {
      events.push(
        this.appendEvent(project.id, {
          protocolVersion: 1,
          id: this.createId(),
          projectId: project.id,
          occurredAt,
          type: 'task.changed',
          payload: { task },
        }),
      );
    }
    for (const task of createdTasks) {
      const dependencies = this.dependencies.dependencies.listPrerequisites(
        task.id,
      );
      if (dependencies.length === 0) continue;
      events.push(
        this.appendEvent(project.id, {
          protocolVersion: 1,
          id: this.createId(),
          projectId: project.id,
          occurredAt,
          type: 'task.dependencies_changed',
          payload: {
            taskId: task.id,
            taskRevision: task.revision,
            taskUpdatedAt: task.updatedAt,
            dependencies,
          },
        }),
      );
    }

    return {
      plan: approved,
      createdTasks,
      dependencies: createdDependencies,
      taskMappings,
      events,
    };
  }

  private buildTasks(
    project: Project,
    proposal: ProjectPlanProposal,
    currentTasks: readonly Task[],
    occurredAt: string,
  ): {
    createdTasks: Task[];
    taskMappings: Array<{ taskKey: string; taskId: Task['id'] }>;
  } {
    let rank = currentTasks
      .filter(({ lifecycleState }) => lifecycleState === 'backlog')
      .sort(
        (left, right) =>
          compareText(left.rank, right.rank) || compareText(left.id, right.id),
      )
      .at(-1)?.rank;
    const taskMappings: Array<{ taskKey: string; taskId: Task['id'] }> = [];
    const createdTasks = proposal.tasks.map((proposed) => {
      rank = rank ? `${rank}m` : 'm';
      const taskId = this.createId();
      const task = taskSchema.parse({
        id: taskId,
        projectId: project.id,
        title: proposed.title,
        description: proposed.description,
        acceptanceCriteria: proposed.acceptanceCriteria,
        priority: proposed.priority,
        rank,
        lifecycleState: 'backlog',
        labels: proposed.labels,
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      taskMappings.push({ taskKey: proposed.key, taskId: task.id });
      return task;
    });
    return { createdTasks, taskMappings };
  }

  private buildDependencies(
    project: Project,
    proposal: ProjectPlanProposal,
    taskMappings: readonly { taskKey: string; taskId: Task['id'] }[],
    currentTasks: readonly Task[],
    actor: TaskActor & { type: 'human' },
    occurredAt: string,
  ): TaskDependency[] {
    const taskIds = new Map(
      taskMappings.map(({ taskKey, taskId }) => [taskKey, taskId]),
    );
    const currentTasksById = new Map(
      currentTasks.map((task) => [task.id, task]),
    );
    return proposal.dependencies.map((proposed) => {
      const taskId = taskIds.get(proposed.dependentTaskKey);
      const prerequisiteTaskId =
        proposed.prerequisite.type === 'proposal_task'
          ? taskIds.get(proposed.prerequisite.taskKey)
          : proposed.prerequisite.taskId;
      if (!taskId || !prerequisiteTaskId) {
        throw new PlanningExecutionError(
          'project_plan_proposal_invalid',
          'The approved proposal contains an unresolved task reference',
        );
      }
      if (proposed.prerequisite.type === 'existing_task') {
        const prerequisite = currentTasksById.get(prerequisiteTaskId);
        if (
          !prerequisite ||
          prerequisite.projectId !== project.id ||
          prerequisite.lifecycleState === 'cancelled'
        ) {
          throw new PlanningExecutionError(
            'task_dependency_invalid',
            'A newly proposed existing prerequisite must be a non-cancelled task in the project',
          );
        }
      }
      return taskDependencySchema.parse({
        projectId: project.id,
        taskId,
        prerequisiteTaskId,
        createdBy: actor,
        createdAt: occurredAt,
      });
    });
  }

  private requireLatestProposal(
    plan: ProjectPlan,
    proposalId: string,
  ): { base: ProjectPlanBase; proposal: ProjectPlanProposal } {
    let details: ReturnType<PlanningRepository['getDetails']>;
    try {
      details = this.dependencies.plans.getDetails(plan.id);
    } catch (error) {
      if (error instanceof ZodError || error instanceof SyntaxError) {
        throw new PlanningExecutionError(
          'project_plan_proposal_invalid',
          'The stored planning proposal is invalid',
          { problems: error instanceof ZodError ? error.issues : undefined },
        );
      }
      throw error;
    }
    if (!details) {
      throw new PlanningExecutionError(
        'project_plan_repair_required',
        `Plan '${plan.id}' has no durable details`,
      );
    }
    const parsedProposalId = idSchema.parse(proposalId);
    const proposal = details.proposals.find(
      (candidate) => candidate.id === parsedProposalId,
    );
    if (
      !proposal ||
      proposal.ordinal !== plan.latestProposalOrdinal ||
      details.proposals.at(-1)?.id !== proposal.id ||
      proposal.tasks.length > 50 ||
      proposal.dependencies.length > 200
    ) {
      throw new PlanningExecutionError(
        'project_plan_proposal_invalid',
        'Approval must target the latest valid proposal',
      );
    }
    let validProposal: ProjectPlanProposal;
    try {
      validProposal = projectPlanProposalSchema.parse(proposal);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new PlanningExecutionError(
          'project_plan_proposal_invalid',
          'The stored planning proposal is invalid',
          { problems: error.issues },
        );
      }
      throw error;
    }
    const base = details.bases.find(
      (candidate) => candidate.id === validProposal.baseId,
    );
    if (!base || base.planId !== plan.id || plan.currentBaseId !== base.id) {
      throw new PlanningExecutionError(
        'project_plan_repair_required',
        'The latest proposal does not have its exact current planning base',
      );
    }
    return { base, proposal: validProposal };
  }

  private staleDetails(
    project: Project,
    base: ProjectPlanBase,
  ): ProjectPlanStaleDetails {
    const currentTasks = this.dependencies.tasks
      .listByProject(project.id)
      .map(comparableTask);
    const baseTasks = [...base.tasks];
    const currentById = new Map(currentTasks.map((task) => [task.id, task]));
    const baseById = new Map(baseTasks.map((task) => [task.id, task]));
    const added = currentTasks
      .filter((task) => !baseById.has(task.id))
      .map(({ id }) => id)
      .sort(compareText);
    const removed = baseTasks
      .filter((task) => !currentById.has(task.id))
      .map(({ id }) => id)
      .sort(compareText);
    const changedValues = baseTasks
      .filter((task) => {
        const current = currentById.get(task.id);
        return current && JSON.stringify(current) !== JSON.stringify(task);
      })
      .map(({ id }) => id);
    const currentCommonOrder = currentTasks
      .filter(({ id }) => baseById.has(id))
      .map(({ id }) => id);
    const baseCommonOrder = baseTasks
      .filter(({ id }) => currentById.has(id))
      .map(({ id }) => id);
    const reordered = baseCommonOrder.filter(
      (id, index) => currentCommonOrder[index] !== id,
    );
    const changed = [...new Set([...changedValues, ...reordered])].sort(
      compareText,
    );
    const addedEvidence = boundedIds(added);
    const removedEvidence = boundedIds(removed);
    const changedEvidence = boundedIds(changed);
    const currentDependencies = sortedDependencies(
      this.dependencies.dependencies.listByProject(project.id),
    );
    const baseDependencies = sortedDependencies(base.dependencies);

    return {
      addedTaskIds: addedEvidence.ids,
      addedTaskTotal: addedEvidence.total,
      addedTaskIdsTruncated: addedEvidence.truncated,
      removedTaskIds: removedEvidence.ids,
      removedTaskTotal: removedEvidence.total,
      removedTaskIdsTruncated: removedEvidence.truncated,
      changedTaskIds: changedEvidence.ids,
      changedTaskTotal: changedEvidence.total,
      changedTaskIdsTruncated: changedEvidence.truncated,
      dependenciesChanged:
        JSON.stringify(currentDependencies) !==
        JSON.stringify(baseDependencies),
      policyChanged:
        project.repositoryIdentity !== base.repositoryIdentity ||
        project.archivedAt !== base.projectArchivedAt ||
        project.revision !== base.projectRevision ||
        project.qaConfiguration.revision !== base.policyRevision,
    };
  }

  private requireReviewPlan(input: {
    projectId: string;
    planId: string;
    expectedPlanRevision: number;
  }): ProjectPlan {
    const projectId = idSchema.parse(input.projectId);
    const planId = idSchema.parse(input.planId);
    const plan = this.dependencies.plans.get(planId);
    if (!plan || plan.projectId !== projectId) {
      throw new PlanningExecutionError(
        'project_plan_not_found',
        `Plan '${planId}' was not found for project '${projectId}'`,
      );
    }
    if (plan.revision !== input.expectedPlanRevision) {
      this.throwRevisionConflict(plan.id);
    }
    if (plan.status !== 'awaiting_review') {
      throw new PlanningExecutionError(
        'project_plan_lifecycle_invalid',
        `Cannot review plan '${plan.id}' while it is ${plan.status}`,
      );
    }
    return plan;
  }

  private requireProject(projectId: string): Project {
    const project = this.dependencies.projects.get(projectId);
    if (!project) {
      throw new PlanningExecutionError(
        'project_not_found',
        `Project '${projectId}' was not found`,
      );
    }
    return project;
  }

  private requireHuman(actor: TaskActor): TaskActor & { type: 'human' } {
    const parsed = taskActorSchema.parse(actor);
    if (parsed.type !== 'human') {
      throw new PlanningExecutionError(
        'project_plan_unauthorized',
        'Only a human actor may approve or reject planning proposals',
      );
    }
    return parsed as TaskActor & { type: 'human' };
  }

  private executeCommand<Result>(
    commandId: string,
    execute: () => Result,
  ): CommandExecution<Result> {
    let executed = false;
    let resultPrepared = false;
    try {
      const result =
        this.dependencies.commands.executeOnceInImmediateTransaction(
          commandId,
          () => {
            executed = true;
            const value = execute();
            resultPrepared = true;
            return value;
          },
        );
      return { executed, result };
    } catch (error) {
      if (resultPrepared) this.reportAuditFailure(error);
      throw error;
    }
  }

  private appendEvent(
    projectId: string,
    draft: Parameters<ProjectEventRepository['appendInTransaction']>[1],
  ): ProjectEvent {
    try {
      return this.dependencies.projectEvents.appendInTransaction(
        projectId,
        draft,
      );
    } catch (error) {
      this.reportAuditFailure(error);
      throw error;
    }
  }

  private publish(events: readonly ProjectEvent[]): void {
    for (const event of events)
      this.dependencies.publisher.publishProject(event);
  }

  private reportAuditFailure(error: unknown): void {
    try {
      this.dependencies.onAuditFailure?.(error);
    } catch {
      // Preserve the durable audit error as the operation failure.
    }
  }

  private throwRevisionConflict(planId: string): never {
    throw new PlanningExecutionError(
      'project_plan_revision_conflict',
      `Plan '${planId}' changed concurrently`,
    );
  }
}
