import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  idSchema,
  projectPlanBaseSchema,
  projectPlanSchema,
  rawDiagnosticSchema,
  sessionSchema,
  taskActorSchema,
  workspaceSchema,
  type Project,
  type ProjectEvent,
  type ProjectPlan,
  type ProjectPlanBase,
  type ProjectPlanProposal,
  type ProjectPlanProposalInput,
  type Session,
  type SessionEvent,
  type StableTaskErrorCode,
  type TaskActor,
  type Workspace,
} from '@mesh-session-platform/contracts';

import type { PmRuntimeConfiguration } from '../claude/driver.js';
import type { Database } from '../db/database.js';
import {
  buildPmPrompt,
  PM_AVAILABLE_TOOLS,
  PM_POLICY_VERSION,
} from '../domain/planning-policy.js';
import type { ResolveWorkspacePathOptions } from '../platform/paths.js';
import type {
  RepositoryIdentity,
  RepositoryIdentityResolver,
} from '../projects/repository-identity.js';
import {
  CommandReconciliationRequiredError,
  type CommandRepository,
} from '../repositories/command-repository.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { PlanningRepository } from '../repositories/planning-repository.js';
import type { ProjectEventRepository } from '../repositories/project-event-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskDependencyRepository } from '../repositories/task-dependency-repository.js';
import type { TaskRepository } from '../repositories/task-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import type { EventPublisher } from '../runtime/event-publisher.js';
import { transition } from '../runtime/lifecycle.js';
import { appendAuditedSessionEvent } from '../runtime/session-runtime.js';
import {
  PlanningCapabilityError,
  type PlanningCapabilityBinding,
  type PlanningCapabilityContext,
  type PlanningCapabilityRegistry,
  type PlanningCapabilityToken,
} from './planning-capability-registry.js';

export type StartPlanningInput = {
  projectId: string;
  goal: string;
  constraints: string;
  nonGoals: string;
  actor: TaskActor;
  commandId: string;
};

export type SubmitPlanningProposalInput = {
  capability: string;
  proposal: ProjectPlanProposalInput;
};

export type PlanControlInput = {
  projectId: string;
  planId: string;
  expectedPlanRevision: number;
  actor: TaskActor;
  commandId: string;
};

export type RequestPlanRevisionInput = PlanControlInput & {
  proposalId: string;
  feedback: string;
};

export type ResumePlanningInput = PlanControlInput;
export type RetryPlanningInput = PlanControlInput;
export type CancelPlanningInput = PlanControlInput & { reason: string };

export type PlanningMutationResult = {
  plan: ProjectPlan;
  base?: ProjectPlanBase;
  proposal?: ProjectPlanProposal;
  session?: Session;
  events: ProjectEvent[];
};

export type PlanningRuntimeConfiguration = PmRuntimeConfiguration & {
  capability: PlanningCapabilityToken;
  capabilityGeneration: number;
};

export class PlanningExecutionError extends Error {
  constructor(
    readonly code: StableTaskErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PlanningExecutionError';
  }
}

type PlanningRegistry = {
  readonly auditStatus?: 'available' | 'audit_unavailable';
  create(
    sessionId: string,
    configuration: PlanningRuntimeConfiguration,
  ): Promise<void>;
  resume(
    sessionId: string,
    configuration: {
      workspaceId: string;
      permissionMode: Session['permissionMode'];
    },
    runtimeConfiguration: PlanningRuntimeConfiguration,
  ): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  reportAuditFailure(error: unknown): void;
  publisher: Pick<EventPublisher, 'publish' | 'publishProject'>;
};

type PlanningExecutionServiceDependencies = {
  database: Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  dependencies: TaskDependencyRepository;
  plans: PlanningRepository;
  sessions: SessionRepository;
  workspaces: WorkspaceRepository;
  diagnostics: DiagnosticRepository;
  events: EventRepository;
  projectEvents: ProjectEventRepository;
  commands: CommandRepository;
  capabilities: PlanningCapabilityRegistry;
  registry: PlanningRegistry;
  billingConflicts?: readonly { variable: string }[];
  pathOptions: ResolveWorkspacePathOptions;
  resolveIdentity: RepositoryIdentityResolver;
  now?: () => string;
  createId?: () => string;
};

type RuntimePreparation = {
  result: PlanningMutationResult;
  base: ProjectPlanBase;
  session: Session;
  generation: number;
};

type LifecycleCommandExecution<Result> = {
  executed: boolean;
  result: Result;
};

const nonterminalStatuses = new Set<ProjectPlan['status']>([
  'planning',
  'awaiting_review',
  'revising',
  'attention_required',
]);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizedLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export class PlanningExecutionService {
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly capabilityContexts = new Map<
    PlanningCapabilityToken,
    PlanningCapabilityContext
  >();

  constructor(
    private readonly dependencies: PlanningExecutionServiceDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async start(input: StartPlanningInput): Promise<PlanningMutationResult> {
    const actor = this.requireHuman(input.actor);
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<PlanningMutationResult>(commandId);
    if (existing.found) return this.reconcileCommandReplay(existing.response);

    this.assertBillingSafe();
    const candidate = this.requireActiveProject(input.projectId);
    if (this.dependencies.plans.getActiveByProject(candidate.id)) {
      throw new PlanningExecutionError(
        'project_plan_lifecycle_invalid',
        `Project '${candidate.id}' already has a nonterminal plan`,
      );
    }
    const identity = await this.resolveProjectIdentity(candidate);

    const execution = this.executeCommand(commandId, () => {
      this.assertBillingSafe();
      const project = this.requireActiveProject(candidate.id);
      this.assertIdentityCurrent(project, candidate, identity);
      if (this.dependencies.plans.getActiveByProject(project.id)) {
        throw new PlanningExecutionError(
          'project_plan_lifecycle_invalid',
          `Project '${project.id}' already has a nonterminal plan`,
        );
      }

      const occurredAt = this.now();
      const workspace = this.requireSharedWorkspace(project, identity);
      const session = this.dependencies.sessions.create(
        sessionSchema.parse({
          id: this.createId(),
          projectId: project.id,
          workspaceId: workspace.id,
          title: `Planning: ${project.displayName}`,
          permissionMode: 'safe_auto',
          lifecycleState: 'idle',
          createdAt: occurredAt,
          updatedAt: occurredAt,
        }),
      );
      const planId = this.createId();
      const base = this.captureBase(project, planId, occurredAt);
      const plan = this.dependencies.plans.create({
        plan: projectPlanSchema.parse({
          id: planId,
          projectId: project.id,
          goal: input.goal,
          constraints: normalizedLines(input.constraints),
          nonGoals: normalizedLines(input.nonGoals),
          policyVersion: PM_POLICY_VERSION,
          status: 'planning',
          revision: 1,
          currentBaseId: base.id,
          currentSessionId: session.id,
          latestProposalOrdinal: 0,
          feedback: [],
          attention: null,
          createdBy: actor,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          terminalAt: null,
          terminalBy: null,
          terminalReason: null,
        }),
        base,
        sessionId: session.id,
      });
      const event = this.appendPlanEvent(plan, occurredAt);
      return { plan, base, session, events: [event] };
    });
    const { result } = execution;
    if (!execution.executed) return this.reconcileCommandReplay(result);

    return this.activate(this.prepareRuntime(result), 'create');
  }

  async submitProposal(
    input: SubmitPlanningProposalInput,
  ): Promise<PlanningMutationResult> {
    if (
      (Array.isArray(input.proposal?.tasks) &&
        input.proposal.tasks.length > 50) ||
      (Array.isArray(input.proposal?.dependencies) &&
        input.proposal.dependencies.length > 200)
    ) {
      throw new PlanningExecutionError(
        'project_plan_proposal_limit_exceeded',
        'Planning proposals may contain at most 50 tasks and 200 dependencies',
      );
    }

    const capability = input.capability as PlanningCapabilityToken;
    const context = this.capabilityContexts.get(capability);
    if (!context) {
      throw new PlanningCapabilityError(
        'planning_capability_invalid',
        'Planning capability is invalid.',
      );
    }

    const result = await this.dependencies.capabilities.submit({
      token: capability,
      context,
      proposal: input.proposal,
      accept: async (proposalInput, binding) =>
        this.persistProposal(proposalInput, binding),
    });
    this.capabilityContexts.delete(capability);
    result.events.forEach((event) =>
      this.dependencies.registry.publisher.publishProject(event),
    );
    return result;
  }

  async requestRevision(
    input: RequestPlanRevisionInput,
  ): Promise<PlanningMutationResult> {
    const actor = this.requireHuman(input.actor);
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<PlanningMutationResult>(commandId);
    if (existing.found) return this.reconcileCommandReplay(existing.response);

    this.assertBillingSafe();
    const candidate = this.requireControlPlan(input);
    if (candidate.status !== 'awaiting_review') {
      this.throwLifecycle(candidate, 'request revision');
    }
    const feedback = input.feedback.trim();
    if (!feedback) {
      throw new PlanningExecutionError(
        'project_plan_lifecycle_invalid',
        'Planning revision feedback must not be empty',
      );
    }
    const candidateProject = this.requireActiveProject(candidate.projectId);
    const identity = await this.resolveProjectIdentity(candidateProject);

    const execution = this.executeCommand(commandId, () => {
      const plan = this.requireControlPlan(input);
      if (plan.status !== 'awaiting_review') {
        this.throwLifecycle(plan, 'request revision');
      }
      const project = this.requireActiveProject(plan.projectId);
      this.assertIdentityCurrent(project, candidateProject, identity);
      const details = this.dependencies.plans.getDetails(plan.id);
      if (!details)
        this.throwRepairRequired('The planning details disappeared');
      const proposal = details.proposals.find(
        (item) => item.id === idSchema.parse(input.proposalId),
      );
      if (!proposal || proposal.ordinal !== plan.latestProposalOrdinal) {
        throw new PlanningExecutionError(
          'project_plan_proposal_invalid',
          'Revision feedback must target the latest proposal',
        );
      }
      const session = this.requireCurrentSession(plan);
      const occurredAt = this.now();
      this.dependencies.plans.appendFeedback({
        id: this.createId(),
        planId: plan.id,
        expectedRevision: plan.revision,
        proposalId: proposal.id,
        content: feedback,
        actor,
        createdAt: occurredAt,
      });
      const afterFeedback = this.dependencies.plans.get(plan.id);
      if (!afterFeedback) this.throwRepairRequired('The plan disappeared');
      const baseInput = this.captureBase(project, plan.id, occurredAt);
      const base = this.dependencies.plans.appendBase(
        plan.id,
        afterFeedback.revision,
        baseInput,
      );
      this.dependencies.plans.advanceSessionGeneration(
        plan.id,
        session.id,
        occurredAt,
      );
      const afterBase = this.dependencies.plans.get(plan.id);
      if (!afterBase) this.throwRepairRequired('The plan disappeared');
      const revised = this.dependencies.plans.update(
        plan.id,
        afterBase.revision,
        {
          status: 'revising',
          attention: null,
          updatedAt: occurredAt,
          terminalAt: null,
          terminalBy: null,
          terminalReason: null,
        },
      );
      if (!revised) this.throwRevisionConflict(plan.id);
      const event = this.appendPlanEvent(revised, occurredAt);
      return { plan: revised, base, session, events: [event] };
    });
    const { result } = execution;
    if (!execution.executed) return this.reconcileCommandReplay(result);

    this.dependencies.capabilities.invalidatePlan(result.plan.id);
    return this.activate(this.prepareRuntime(result), 'resume');
  }

  async resume(input: ResumePlanningInput): Promise<PlanningMutationResult> {
    return this.recover(input, 'resume');
  }

  async retry(input: RetryPlanningInput): Promise<PlanningMutationResult> {
    return this.recover(input, 'retry');
  }

  async cancel(input: CancelPlanningInput): Promise<PlanningMutationResult> {
    const actor = this.requireHuman(input.actor);
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<PlanningMutationResult>(commandId);
    if (existing.found) return this.reconcileCommandReplay(existing.response);
    const reason = input.reason.trim();
    if (!reason) {
      throw new PlanningExecutionError(
        'project_plan_lifecycle_invalid',
        'Planning cancellation reason must not be empty',
      );
    }

    const execution = this.executeCommand(commandId, () => {
      const plan = this.requireControlPlan(input);
      if (!nonterminalStatuses.has(plan.status)) {
        this.throwLifecycle(plan, 'cancel');
      }
      const occurredAt = this.now();
      const cancelled = this.dependencies.plans.update(plan.id, plan.revision, {
        status: 'cancelled',
        attention: null,
        updatedAt: occurredAt,
        terminalAt: occurredAt,
        terminalBy: actor,
        terminalReason: reason,
      });
      if (!cancelled) this.throwRevisionConflict(plan.id);
      const event = this.appendPlanEvent(cancelled, occurredAt);
      const session = plan.currentSessionId
        ? this.jsonSession(
            this.dependencies.sessions.get(plan.currentSessionId),
          )
        : undefined;
      return session
        ? { plan: cancelled, session, events: [event] }
        : { plan: cancelled, events: [event] };
    });
    const { result } = execution;
    if (!execution.executed) return this.reconcileCommandReplay(result);

    this.dependencies.capabilities.invalidatePlan(result.plan.id);
    result.events.forEach((event) =>
      this.dependencies.registry.publisher.publishProject(event),
    );
    if (result.session) {
      try {
        await this.dependencies.registry.interrupt(result.session.id);
      } catch (error) {
        this.recordInterruptionFailure(result.session.id, error);
      }
    }
    return result;
  }

  private async recover(
    input: ResumePlanningInput,
    mode: 'resume' | 'retry',
  ): Promise<PlanningMutationResult> {
    this.requireHuman(input.actor);
    const commandId = idSchema.parse(input.commandId);
    const existing =
      this.dependencies.commands.getExisting<PlanningMutationResult>(commandId);
    if (existing.found) return this.reconcileCommandReplay(existing.response);
    this.assertBillingSafe();
    const candidate = this.requireControlPlan(input);
    if (candidate.status !== 'attention_required') {
      this.throwLifecycle(candidate, mode);
    }
    const candidateProject = this.requireActiveProject(candidate.projectId);
    const identity = await this.resolveProjectIdentity(candidateProject);

    const execution = this.executeCommand(commandId, () => {
      const plan = this.requireControlPlan(input);
      if (plan.status !== 'attention_required') {
        this.throwLifecycle(plan, mode);
      }
      const project = this.requireActiveProject(plan.projectId);
      this.assertIdentityCurrent(project, candidateProject, identity);
      const base = this.requireCurrentBase(plan);
      this.assertBaseCurrent(project, base);
      const occurredAt = this.now();
      let session: Session;
      let current = plan;

      if (mode === 'resume') {
        session = this.requireCurrentSession(plan);
        if (!session.claudeResumeId) {
          throw new PlanningExecutionError(
            'project_plan_repair_required',
            'The PM session cannot be resumed; retry with a replacement session',
          );
        }
        this.dependencies.plans.advanceSessionGeneration(
          plan.id,
          session.id,
          occurredAt,
        );
      } else {
        const workspace = this.requireSharedWorkspace(project, identity);
        session = this.dependencies.sessions.create(
          sessionSchema.parse({
            id: this.createId(),
            projectId: project.id,
            workspaceId: workspace.id,
            title: `Planning: ${project.displayName}`,
            permissionMode: 'safe_auto',
            lifecycleState: 'idle',
            createdAt: occurredAt,
            updatedAt: occurredAt,
          }),
        );
        current = this.dependencies.plans.appendSession(
          plan.id,
          plan.revision,
          session.id,
          occurredAt,
        );
      }

      const nextStatus =
        current.latestProposalOrdinal > 0 ? 'revising' : 'planning';
      const recovered = this.dependencies.plans.update(
        current.id,
        current.revision,
        {
          status: nextStatus,
          attention: null,
          updatedAt: occurredAt,
          terminalAt: null,
          terminalBy: null,
          terminalReason: null,
        },
      );
      if (!recovered) this.throwRevisionConflict(plan.id);
      const event = this.appendPlanEvent(recovered, occurredAt);
      return { plan: recovered, base, session, events: [event] };
    });
    const { result } = execution;
    if (!execution.executed) return this.reconcileCommandReplay(result);

    this.dependencies.capabilities.invalidatePlan(result.plan.id);
    return this.activate(
      this.prepareRuntime(result),
      mode === 'resume' ? 'resume' : 'create',
    );
  }

  private prepareRuntime(result: PlanningMutationResult): RuntimePreparation {
    const base = result.base ?? this.requireCurrentBase(result.plan);
    const session = result.session ?? this.requireCurrentSession(result.plan);
    const association = this.dependencies.plans.getSessionAssociation(
      result.plan.id,
      session.id,
    );
    if (!association || association.endedAt !== null) {
      throw new PlanningExecutionError(
        'project_plan_repair_required',
        'The current planning session association is unavailable',
      );
    }
    return {
      result,
      base,
      session,
      generation: association.capabilityGeneration,
    };
  }

  private async activate(
    prepared: RuntimePreparation,
    mode: 'create' | 'resume',
  ): Promise<PlanningMutationResult> {
    prepared.result.events.forEach((event) =>
      this.dependencies.registry.publisher.publishProject(event),
    );
    let configuration: PlanningRuntimeConfiguration | undefined;
    try {
      configuration = this.createRuntime(prepared);
      if (mode === 'create') {
        await this.dependencies.registry.create(
          prepared.session.id,
          configuration,
        );
      } else {
        await this.dependencies.registry.resume(
          prepared.session.id,
          {
            workspaceId: prepared.session.workspaceId,
            permissionMode: prepared.session.permissionMode,
          },
          configuration,
        );
      }
      return prepared.result;
    } catch (error) {
      if (configuration) {
        this.dependencies.capabilities.invalidate(configuration.capability);
        this.capabilityContexts.delete(configuration.capability);
      }
      this.recordRuntimeFailure(
        prepared.result.plan.id,
        prepared.session.id,
        error,
      );
      throw new PlanningExecutionError(
        'project_plan_repair_required',
        `PM runtime ${mode === 'create' ? 'startup' : 'resume'} failed`,
        { sessionId: prepared.session.id, error: errorMessage(error) },
      );
    }
  }

  private createRuntime(
    prepared: RuntimePreparation,
  ): PlanningRuntimeConfiguration {
    const binding: PlanningCapabilityBinding = {
      planId: prepared.result.plan.id,
      planRevision: prepared.result.plan.revision,
      sessionId: prepared.session.id,
      baseId: prepared.base.id,
      policyVersion: prepared.result.plan.policyVersion,
      generation: prepared.generation,
      expiresAt: new Date(
        Date.parse(this.now()) + 60 * 60 * 1_000,
      ).toISOString(),
    };
    const capability = this.dependencies.capabilities.issue(binding);
    const context: PlanningCapabilityContext = {
      planId: binding.planId,
      planRevision: binding.planRevision,
      sessionId: binding.sessionId,
      baseId: binding.baseId,
      policyVersion: binding.policyVersion,
      generation: binding.generation,
    };
    this.capabilityContexts.set(capability, context);
    return {
      role: 'pm',
      initialPrompt: buildPmPrompt({
        planId: binding.planId,
        planRevision: binding.planRevision,
        sessionId: binding.sessionId,
        goal: prepared.result.plan.goal,
        constraints: prepared.result.plan.constraints,
        nonGoals: prepared.result.plan.nonGoals,
        base: prepared.base,
        capabilityGeneration: binding.generation,
      }),
      capability,
      capabilityGeneration: binding.generation,
      availableTools: PM_AVAILABLE_TOOLS,
      allowedTools: PM_AVAILABLE_TOOLS,
      submitProposal: (proposalInput) =>
        this.submitProposal({ capability, proposal: proposalInput }),
    };
  }

  private persistProposal(
    proposalInput: ProjectPlanProposalInput,
    binding: PlanningCapabilityBinding,
  ): PlanningMutationResult {
    this.assertAuditAvailable();
    this.dependencies.database.exec('BEGIN IMMEDIATE');
    try {
      const plan = this.dependencies.plans.get(binding.planId);
      if (!plan) {
        throw new PlanningExecutionError(
          'project_plan_not_found',
          `Plan '${binding.planId}' was not found`,
        );
      }
      if (plan.status !== 'planning' && plan.status !== 'revising') {
        this.throwLifecycle(plan, 'submit proposal');
      }
      if (
        plan.revision !== binding.planRevision ||
        plan.currentSessionId !== binding.sessionId ||
        plan.currentBaseId !== binding.baseId ||
        plan.policyVersion !== binding.policyVersion
      ) {
        throw new PlanningCapabilityError(
          'planning_capability_mismatch',
          'Planning capability no longer matches durable plan state.',
        );
      }
      const association = this.dependencies.plans.getSessionAssociation(
        plan.id,
        binding.sessionId,
      );
      if (
        !association ||
        association.endedAt !== null ||
        association.capabilityGeneration !== binding.generation
      ) {
        throw new PlanningCapabilityError(
          'planning_capability_mismatch',
          'Planning capability generation is no longer current.',
        );
      }
      const session = this.requireCurrentSession(plan);
      const base = this.requireCurrentBase(plan);
      this.validateProposalReferences(plan, base, proposalInput);
      const occurredAt = this.now();
      const proposal = this.dependencies.plans.appendProposal({
        ...proposalInput,
        id: this.createId(),
        planId: plan.id,
        expectedRevision: plan.revision,
        baseId: base.id,
        sessionId: session.id,
        submittedAt: occurredAt,
      });
      const afterProposal = this.dependencies.plans.get(plan.id);
      if (!afterProposal) this.throwRepairRequired('The plan disappeared');
      const awaitingReview = this.dependencies.plans.update(
        plan.id,
        afterProposal.revision,
        {
          status: 'awaiting_review',
          attention: null,
          updatedAt: occurredAt,
          terminalAt: null,
          terminalBy: null,
          terminalReason: null,
        },
      );
      if (!awaitingReview) this.throwRevisionConflict(plan.id);
      const event = this.appendPlanEvent(awaitingReview, occurredAt);
      const result = {
        plan: awaitingReview,
        base,
        proposal,
        session,
        events: [event],
      };
      this.dependencies.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      this.reportUnexpectedAuditFailure(error);
      throw error;
    }
  }

  private validateProposalReferences(
    plan: ProjectPlan,
    base: ProjectPlanBase,
    proposalInput: ProjectPlanProposalInput,
  ): void {
    const baseTaskIds = new Set(base.tasks.map((task) => task.id));
    const currentTaskIds = new Set(
      this.dependencies.tasks
        .listByProject(plan.projectId)
        .map((task) => task.id),
    );
    const invalid = proposalInput.dependencies.find(
      (dependency) =>
        dependency.prerequisite.type === 'existing_task' &&
        (!baseTaskIds.has(dependency.prerequisite.taskId) ||
          !currentTaskIds.has(dependency.prerequisite.taskId)),
    );
    if (invalid?.prerequisite.type === 'existing_task') {
      throw new PlanningExecutionError(
        'project_plan_proposal_invalid',
        `Existing prerequisite '${invalid.prerequisite.taskId}' is not in the frozen current project base`,
      );
    }
  }

  private reconcileCommandReplay(
    result: PlanningMutationResult,
  ): PlanningMutationResult {
    const authoritative = this.dependencies.plans.get(result.plan.id);
    if (
      authoritative?.status === 'attention_required' &&
      authoritative.attention?.type === 'runtime_failure'
    ) {
      throw new PlanningExecutionError(
        'project_plan_repair_required',
        'The committed planning command requires explicit runtime recovery',
        {
          planId: authoritative.id,
          sessionId: authoritative.currentSessionId,
          error: authoritative.attention.message,
        },
      );
    }
    return result;
  }

  private executeCommand<Result>(
    commandId: string,
    execute: () => Result,
  ): LifecycleCommandExecution<Result> {
    this.assertAuditAvailable();
    let executed = false;
    try {
      const result =
        this.dependencies.commands.executeOnceInImmediateTransaction(
          commandId,
          () => {
            executed = true;
            return execute();
          },
        );
      return { executed, result };
    } catch (error) {
      this.reportUnexpectedAuditFailure(error);
      throw error;
    }
  }

  private captureBase(
    project: Project,
    planId: string,
    occurredAt: string,
  ): ProjectPlanBase {
    const comparable = this.captureComparableBase(project);
    return projectPlanBaseSchema.parse({
      id: this.createId(),
      planId,
      ordinal: 1,
      repositoryIdentity: project.repositoryIdentity,
      tasks: comparable.tasks,
      dependencies: comparable.dependencies,
      projectArchivedAt: project.archivedAt,
      projectRevision: project.revision,
      policyRevision: project.qaConfiguration.revision,
      createdAt: occurredAt,
    });
  }

  private appendPlanEvent(plan: ProjectPlan, occurredAt: string): ProjectEvent {
    return this.dependencies.projectEvents.appendInTransaction(plan.projectId, {
      protocolVersion: 1,
      id: this.createId(),
      projectId: plan.projectId,
      occurredAt,
      type: 'project.plan_changed',
      payload: { plan },
    });
  }

  private requireSharedWorkspace(
    project: Project,
    identity: RepositoryIdentity,
  ): Workspace {
    const existing = this.dependencies.workspaces
      .listByProject(project.id)
      .find(
        (workspace) =>
          workspace.type === 'shared' &&
          workspace.cleanupState === 'active' &&
          workspace.path === identity.canonicalPath,
      );
    return (
      existing ??
      this.dependencies.workspaces.create(
        workspaceSchema.parse({
          id: this.createId(),
          projectId: project.id,
          type: 'shared',
          path: identity.canonicalPath,
          cleanupState: 'active',
        }),
      )
    );
  }

  private requireControlPlan(input: PlanControlInput): ProjectPlan {
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
    return plan;
  }

  private requireCurrentSession(plan: ProjectPlan): Session {
    const session = plan.currentSessionId
      ? this.dependencies.sessions.get(plan.currentSessionId)
      : undefined;
    if (!session || session.projectId !== plan.projectId) {
      throw new PlanningExecutionError(
        'project_plan_repair_required',
        'The current PM session is unavailable',
      );
    }
    return session;
  }

  private throwRepairRequired(message: string): never {
    throw new PlanningExecutionError('project_plan_repair_required', message);
  }

  private jsonSession(session: Session | undefined): Session | undefined {
    if (!session) return undefined;
    const value = { ...session };
    if (value.claudeResumeId === undefined) delete value.claudeResumeId;
    return value;
  }

  private requireCurrentBase(plan: ProjectPlan): ProjectPlanBase {
    const base = this.dependencies.plans
      .getDetails(plan.id)
      ?.bases.find((item) => item.id === plan.currentBaseId);
    if (!base) {
      throw new PlanningExecutionError(
        'project_plan_repair_required',
        'The current planning base is unavailable',
      );
    }
    return base;
  }

  private assertBaseCurrent(project: Project, base: ProjectPlanBase): void {
    const current = this.captureComparableBase(project);
    if (
      base.repositoryIdentity !== project.repositoryIdentity ||
      base.projectArchivedAt !== project.archivedAt ||
      base.projectRevision !== project.revision ||
      base.policyRevision !== project.qaConfiguration.revision ||
      JSON.stringify(base.tasks) !== JSON.stringify(current.tasks) ||
      JSON.stringify(base.dependencies) !== JSON.stringify(current.dependencies)
    ) {
      throw new PlanningExecutionError(
        'project_plan_stale',
        'The project task or policy base changed while planning required attention',
      );
    }
  }

  private captureComparableBase(project: Project) {
    return {
      tasks: this.dependencies.tasks.listByProject(project.id).map((task) => ({
        id: task.id,
        revision: task.revision,
        lifecycleState: task.lifecycleState,
        blocked: task.blocked,
      })),
      dependencies: this.dependencies.dependencies
        .listByProject(project.id)
        .sort(
          (left, right) =>
            compareText(left.taskId, right.taskId) ||
            compareText(left.prerequisiteTaskId, right.prerequisiteTaskId),
        ),
    };
  }

  private requireActiveProject(projectId: string): Project {
    const id = idSchema.parse(projectId);
    const project = this.dependencies.projects.get(id);
    if (!project) {
      throw new PlanningExecutionError(
        'project_not_found',
        `Project '${id}' was not found`,
      );
    }
    if (project.archivedAt) {
      throw new PlanningExecutionError(
        'project_archived',
        `Project '${id}' is archived`,
      );
    }
    return project;
  }

  private requireHuman(actor: TaskActor): TaskActor & { type: 'human' } {
    const parsed = taskActorSchema.parse(actor);
    if (parsed.type !== 'human') {
      throw new PlanningExecutionError(
        'project_plan_unauthorized',
        'Only a human actor may control planning',
      );
    }
    return parsed as TaskActor & { type: 'human' };
  }

  private assertBillingSafe(): void {
    const conflicts = this.dependencies.billingConflicts ?? [];
    if (conflicts.length > 0) {
      throw new PlanningExecutionError(
        'project_plan_billing_conflict',
        'Planning requires subscription-only Claude billing',
        { variables: conflicts.map(({ variable }) => variable) },
      );
    }
  }

  private assertAuditAvailable(): void {
    if (this.dependencies.registry.auditStatus === 'audit_unavailable') {
      throw new PlanningExecutionError(
        'project_plan_repair_required',
        'Planning audit persistence is unavailable',
      );
    }
  }

  private async resolveProjectIdentity(
    project: Project,
  ): Promise<RepositoryIdentity> {
    try {
      const identity = await this.dependencies.resolveIdentity(
        project.repositoryPath,
        this.dependencies.pathOptions,
      );
      if (
        identity.repositoryIdentity !== project.repositoryIdentity ||
        identity.canonicalPath !== project.repositoryPath ||
        !identity.associatedWorktreePaths.includes(identity.canonicalPath)
      ) {
        throw new PlanningExecutionError(
          'repository_ambiguous',
          'Project repository identity no longer matches its canonical import',
        );
      }
      return identity;
    } catch (error) {
      if (error instanceof PlanningExecutionError) throw error;
      throw new PlanningExecutionError(
        'repository_ambiguous',
        'Project repository identity could not be revalidated',
        { error: errorMessage(error) },
      );
    }
  }

  private assertIdentityCurrent(
    current: Project,
    candidate: Project,
    identity: RepositoryIdentity,
  ): void {
    if (
      current.revision !== candidate.revision ||
      current.repositoryPath !== identity.canonicalPath ||
      current.repositoryIdentity !== identity.repositoryIdentity
    ) {
      throw new PlanningExecutionError(
        'project_plan_stale',
        'Project repository identity changed while planning was prepared',
      );
    }
  }

  private recordRuntimeFailure(
    planId: string,
    sessionId: string,
    error: unknown,
  ): void {
    this.assertAuditAvailable();
    const sessionEvents: SessionEvent[] = [];
    let projectEvent: ProjectEvent | undefined;
    try {
      this.dependencies.database.exec('BEGIN IMMEDIATE');
      const plan = this.dependencies.plans.get(planId);
      const occurredAt = this.now();
      if (!plan || !nonterminalStatuses.has(plan.status)) {
        this.insertRuntimeFailureDiagnostic(sessionId, occurredAt, error);
        this.dependencies.database.exec('COMMIT');
      } else {
        sessionEvents.push(
          ...this.appendSessionFailureEvents(sessionId, error),
        );
        const attention = this.dependencies.plans.update(
          plan.id,
          plan.revision,
          {
            status: 'attention_required',
            attention: {
              type: 'runtime_failure',
              message: errorMessage(error),
            },
            updatedAt: occurredAt,
            terminalAt: null,
            terminalBy: null,
            terminalReason: null,
          },
        );
        if (!attention) {
          throw new Error(`Plan '${plan.id}' runtime repair update failed`);
        }
        projectEvent = this.appendPlanEvent(attention, occurredAt);
        this.dependencies.database.exec('COMMIT');
      }
    } catch (auditError) {
      if (this.dependencies.database.inTransaction) {
        this.dependencies.database.exec('ROLLBACK');
      }
      this.dependencies.registry.reportAuditFailure(auditError);
      throw auditError;
    }
    sessionEvents.forEach((event) =>
      this.dependencies.registry.publisher.publish(event),
    );
    if (projectEvent) {
      this.dependencies.registry.publisher.publishProject(projectEvent);
    }
  }

  private appendSessionFailureEvents(
    sessionId: string,
    error: unknown,
  ): SessionEvent[] {
    const session = this.dependencies.sessions.get(sessionId);
    if (!session) return [];
    const events: SessionEvent[] = [];
    let current = session.lifecycleState;
    const startTrigger =
      current === 'idle'
        ? 'start'
        : current === 'interrupted' || current === 'completed'
          ? 'resume'
          : undefined;
    if (startTrigger) {
      const starting = transition(current, startTrigger);
      events.push(
        appendAuditedSessionEvent(this.dependencies.events, {
          sessionId,
          stableId: this.createId(),
          draft: {
            type: 'session.status',
            payload: { from: current, to: starting },
          },
          raw: {
            kind: 'runtime_transition',
            role: 'pm',
            trigger: startTrigger,
          },
          sessionUpdate: { lifecycleState: starting },
        }),
      );
      current = starting;
    }
    if (current !== 'starting') {
      this.insertRuntimeFailureDiagnostic(sessionId, this.now(), error);
      return events;
    }
    const failed = transition(current, 'driver_failed');
    events.push(
      appendAuditedSessionEvent(this.dependencies.events, {
        sessionId,
        stableId: this.createId(),
        draft: {
          type: 'session.status',
          payload: {
            from: current,
            to: failed,
            reason: 'pm_runtime_failed',
          },
        },
        raw: {
          kind: 'runtime_transition',
          role: 'pm',
          trigger: 'driver_failed',
          error: errorMessage(error),
        },
        sessionUpdate: { lifecycleState: failed },
      }),
    );
    return events;
  }

  private insertRuntimeFailureDiagnostic(
    sessionId: string,
    capturedAt: string,
    error: unknown,
  ): void {
    this.dependencies.diagnostics.insert(
      rawDiagnosticSchema.parse({
        id: this.createId(),
        sessionId,
        capturedAt,
        payload: {
          kind: 'pm_planning_runtime',
          stage: 'startup_or_resume',
          outcome: 'failed',
          error: errorMessage(error),
        },
      }),
    );
  }

  private recordInterruptionFailure(sessionId: string, error: unknown): void {
    try {
      this.dependencies.diagnostics.insert(
        rawDiagnosticSchema.parse({
          id: this.createId(),
          sessionId,
          capturedAt: this.now(),
          payload: {
            kind: 'pm_planning_cancel',
            stage: 'interrupt',
            outcome: 'failed',
            error: errorMessage(error),
          },
        }),
      );
    } catch (auditError) {
      this.dependencies.registry.reportAuditFailure(auditError);
    }
  }

  private reportUnexpectedAuditFailure(error: unknown): void {
    if (
      error instanceof PlanningExecutionError ||
      error instanceof PlanningCapabilityError ||
      error instanceof CommandReconciliationRequiredError ||
      error instanceof z.ZodError
    ) {
      return;
    }
    this.dependencies.registry.reportAuditFailure(error);
  }

  private throwRevisionConflict(planId: string): never {
    throw new PlanningExecutionError(
      'project_plan_revision_conflict',
      `Plan '${planId}' changed concurrently`,
    );
  }

  private throwLifecycle(plan: ProjectPlan, action: string): never {
    throw new PlanningExecutionError(
      'project_plan_lifecycle_invalid',
      `Cannot ${action} while plan '${plan.id}' is ${plan.status}`,
    );
  }
}
