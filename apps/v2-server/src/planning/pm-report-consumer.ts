import { createHash, randomUUID } from 'node:crypto';

import {
  PM_DISCOVERY_REPORT_SCHEMA,
  PM_PLAN_REPORT_SCHEMA,
  deliveryPlanProposalIdSchema,
  deliveryPlanProposalSchema,
  ledgerRecordIdSchema,
  milestoneIdSchema,
  pmDiscoveryAssignmentSchema,
  pmDiscoveryReportSchema,
  pmPlanAssignmentSchema,
  pmPlanReportSchema,
  planningProposalIdSchema,
  planningQuestionIdSchema,
  planningTurnIdSchema,
  taskDependencyIdSchema,
  taskIdSchema,
  type ApprovedDeliveryPlan,
  type DeliveryPlanProposal,
  type DomainEvent,
  type LedgerRecordContent,
  type PmDiscoveryAssignment,
  type PmDiscoveryReport,
  type PmPlanAssignment,
  type PmPlanReport,
  type PlanningProposal,
  type ProposedLedgerRelationship,
  type WorkerExecution,
  type WorkerExecutionStructuredOutputRuntimeEvent,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { V2EventStore } from '../storage/event-store.js';
import {
  PlanningProposalInvalidError,
  PlanningRepository,
} from './planning-repository.js';

type Dependencies = {
  database: V2Database;
  repository: PlanningRepository;
  events: V2EventStore;
  barrier: AuditBarrier;
  publishDomain?: (event: DomainEvent) => void;
};

type ProposalReport = Extract<
  PmDiscoveryReport['result'],
  { kind: 'proposal' }
>;
type Endpoint = ProposedLedgerRelationship['from'];

const intentFields = [
  'goal',
  'targetUsers',
  'desiredCapabilities',
  'constraints',
  'nonGoals',
  'successConditions',
  'rationale',
  'provenance',
] as const;

const symmetricKinds = new Set(['conflicts_with', 'duplicates']);

const endpointKey = (endpoint: Endpoint): string =>
  'recordId' in endpoint
    ? `record:${endpoint.recordId}`
    : `proposal:${endpoint.proposalKey}`;

const normalizeRelationship = (
  relationship: ProposedLedgerRelationship,
): ProposedLedgerRelationship => {
  if (!symmetricKinds.has(relationship.kind)) return relationship;
  return endpointKey(relationship.from) <= endpointKey(relationship.to)
    ? relationship
    : { ...relationship, from: relationship.to, to: relationship.from };
};

const relationshipKey = (relationship: ProposedLedgerRelationship): string => {
  const normalized = normalizeRelationship(relationship);
  return `${normalized.kind}:${endpointKey(normalized.from)}:${endpointKey(normalized.to)}`;
};

const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

class RejectedReport extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export class PmReportConsumer {
  constructor(private readonly dependencies: Dependencies) {}

  consume(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
  ): void {
    this.dependencies.barrier.assertHealthy();
    const outputDigest = digest(event.payload.value);
    const existing = this.dependencies.repository.receipt(execution.id);
    if (existing) {
      if (existing.outputDigest === outputDigest) return;
      const error = new Error('Conflicting PM output receipt');
      this.dependencies.barrier.trip(error, event.occurredAt);
      throw error;
    }

    let committedEvent: DomainEvent | undefined;
    try {
      inImmediateTransaction(this.dependencies.database, () => {
        const authoritative = this.authoritativeExecution(execution);
        const planAssignment = pmPlanAssignmentSchema.safeParse(
          authoritative.assignment,
        );
        if (planAssignment.success) {
          committedEvent = this.consumePlanInTransaction(
            authoritative,
            event,
            planAssignment.data,
            outputDigest,
          );
          return;
        }
        const assignmentResult = pmDiscoveryAssignmentSchema.safeParse(
          authoritative.assignment,
        );
        if (!assignmentResult.success) return;
        const assignment = assignmentResult.data;
        const at = event.occurredAt;
        try {
          this.assertEnvelopeBinding(authoritative, event, assignment);
          const report = pmDiscoveryReportSchema.parse(event.payload.value);
          this.assertReportBinding(authoritative, assignment, report);
          const view = this.dependencies.repository.cycleView(
            assignment.planningCycleId,
          );
          if (!view) throw new RejectedReport('cycle_not_found');
          const humanTurn = this.dependencies.repository.turn(
            assignment.humanTurnId,
          );
          if (
            view.cycle.lifecycle !== 'execution_active' ||
            view.cycle.activeExecutionId !== authoritative.id ||
            view.cycle.revision !== assignment.expectedCycleRevision ||
            view.cycle.latestProposalRevision + 1 !==
              assignment.expectedProposalRevision ||
            !humanTurn ||
            humanTurn.planningCycleId !== view.cycle.id ||
            humanTurn.executionId !== authoritative.id ||
            humanTurn.launchState !== 'execution_bound'
          ) {
            throw new RejectedReport('authoritative_binding_mismatch');
          }
          if (
            report.result.kind === 'questions' &&
            this.hasDuplicateQuestionKey(
              view.questions.map(({ key }) => key),
              report.result.questions.map(({ key }) => key),
            )
          ) {
            throw new RejectedReport('duplicate_question_key');
          }
          if (
            report.result.kind === 'questions' &&
            view.questions.length + report.result.questions.length > 20
          ) {
            throw new RejectedReport('question_history_limit');
          }
          if (
            report.result.kind === 'proposal' &&
            view.proposals.length >= 16
          ) {
            throw new RejectedReport('proposal_history_limit');
          }

          let proposal: PlanningProposal | undefined;
          if (report.result.kind === 'proposal') {
            proposal = this.projectProposal(
              authoritative,
              assignment,
              report,
              report.result,
              at,
            );
          }

          this.dependencies.repository.insertReceiptInTransaction({
            executionId: authoritative.id,
            projectId: authoritative.projectId,
            planningCycleId: assignment.planningCycleId,
            humanTurnId: assignment.humanTurnId,
            runtimeEventId: event.id,
            outputDigest,
            status: 'accepted',
            rejectionReason: null,
            createdAt: at,
          });
          const pmTurn = this.dependencies.repository.insertTurnInTransaction({
            id: planningTurnIdSchema.parse(randomUUID()),
            projectId: authoritative.projectId,
            planningCycleId: assignment.planningCycleId,
            ordinal: view.turns.length + 1,
            actor: 'pm',
            message: report.assistantMessage,
            launchState: null,
            executionId: authoritative.id,
            createdAt: at,
          });

          if (report.result.kind === 'questions') {
            this.dependencies.repository.insertQuestionsInTransaction(
              report.result.questions.map((question) => ({
                id: planningQuestionIdSchema.parse(randomUUID()),
                projectId: authoritative.projectId,
                planningCycleId: assignment.planningCycleId,
                turnId: pmTurn.id,
                ...question,
              })),
            );
            this.dependencies.repository.updateCycleInTransaction(
              {
                ...view.cycle,
                lifecycle: 'awaiting_human',
                activeExecutionId: null,
                updatedAt: at,
              },
              view.cycle.revision,
            );
          } else {
            const prior = view.proposals.at(-1);
            if (prior?.lifecycle === 'awaiting_approval') {
              this.dependencies.repository.updateProposalInTransaction({
                ...prior,
                lifecycle: 'superseded',
                decidedAt: at,
              });
            }
            this.dependencies.repository.insertProposalInTransaction({
              ...proposal!,
              createdByTurnId: pmTurn.id,
            });
            this.dependencies.repository.updateCycleInTransaction(
              {
                ...view.cycle,
                lifecycle: 'awaiting_approval',
                latestProposalRevision: proposal!.revision,
                activeExecutionId: null,
                updatedAt: at,
              },
              view.cycle.revision,
            );
          }

          const planningCycle = this.dependencies.repository.cycleView(
            assignment.planningCycleId,
          )!;
          committedEvent = this.dependencies.events.appendDomainInTransaction(
            authoritative.projectId,
            {
              projectId: authoritative.projectId,
              occurredAt: at,
              type: 'planning_cycle.changed',
              payload: { schemaVersion: 2, planningCycle },
            },
          );
        } catch (error) {
          if (
            !(error instanceof RejectedReport) &&
            !this.isValidationError(error)
          ) {
            throw error;
          }
          const reason =
            error instanceof RejectedReport ? error.reason : 'invalid_report';
          const cycle = this.dependencies.repository.cycle(
            assignment.planningCycleId,
          );
          if (!cycle) throw error;
          this.dependencies.repository.insertReceiptInTransaction({
            executionId: authoritative.id,
            projectId: authoritative.projectId,
            planningCycleId: assignment.planningCycleId,
            humanTurnId: assignment.humanTurnId,
            runtimeEventId: event.id,
            outputDigest,
            status: 'rejected',
            rejectionReason: reason,
            createdAt: event.occurredAt,
          });
          this.dependencies.repository.updateCycleInTransaction(
            {
              ...cycle,
              lifecycle: 'attention_required',
              activeExecutionId: null,
              updatedAt: event.occurredAt,
            },
            cycle.revision,
          );
          const planningCycle = this.dependencies.repository.cycleView(
            cycle.id,
          )!;
          committedEvent = this.dependencies.events.appendDomainInTransaction(
            authoritative.projectId,
            {
              projectId: authoritative.projectId,
              occurredAt: event.occurredAt,
              type: 'planning_cycle.changed',
              payload: { schemaVersion: 2, planningCycle },
            },
          );
        }
      });
    } catch (error) {
      this.dependencies.barrier.trip(error, event.occurredAt);
      throw error;
    }
    if (committedEvent) this.dependencies.publishDomain?.(committedEvent);
  }

  private consumePlanInTransaction(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
    assignment: PmPlanAssignment,
    outputDigest: string,
  ): DomainEvent {
    try {
      this.assertPlanEnvelopeBinding(execution, event, assignment);
      const report = pmPlanReportSchema.parse(event.payload.value);
      this.assertPlanReportBinding(execution, assignment, report);
      const view = this.dependencies.repository.cycleView(
        assignment.planningCycleId,
      );
      const purpose = this.dependencies.repository.cyclePurpose(
        assignment.planningCycleId,
      );
      const humanTurn = this.dependencies.repository.turn(
        assignment.humanTurnId,
      );
      if (
        !view ||
        purpose?.purpose !== 'delivery_plan' ||
        view.cycle.lifecycle !== 'execution_active' ||
        view.cycle.activeExecutionId !== execution.id ||
        view.cycle.revision !== assignment.expectedCycleRevision ||
        view.cycle.latestProposalRevision + 1 !==
          assignment.expectedProposalRevision ||
        !humanTurn ||
        humanTurn.planningCycleId !== view.cycle.id ||
        humanTurn.executionId !== execution.id ||
        humanTurn.launchState !== 'execution_bound'
      ) {
        throw new RejectedReport('authoritative_binding_mismatch');
      }
      if (
        report.result.kind === 'questions' &&
        this.hasDuplicateQuestionKey(
          view.questions.map(({ key }) => key),
          report.result.questions.map(({ key }) => key),
        )
      ) {
        throw new RejectedReport('duplicate_question_key');
      }
      if (
        report.result.kind === 'questions' &&
        view.questions.length + report.result.questions.length > 20
      ) {
        throw new RejectedReport('question_history_limit');
      }
      if (
        report.result.kind === 'plan_proposal' &&
        this.dependencies.repository.deliveryPlanProposals(view.cycle.id)
          .length >= 16
      ) {
        throw new RejectedReport('proposal_history_limit');
      }

      let proposal: DeliveryPlanProposal | undefined;
      if (report.result.kind === 'plan_proposal') {
        proposal = this.projectDeliveryPlanProposal(
          execution,
          assignment,
          report,
          event.occurredAt,
        );
      }

      this.dependencies.repository.insertReceiptInTransaction({
        executionId: execution.id,
        projectId: execution.projectId,
        planningCycleId: assignment.planningCycleId,
        humanTurnId: assignment.humanTurnId,
        runtimeEventId: event.id,
        outputDigest,
        status: 'accepted',
        rejectionReason: null,
        createdAt: event.occurredAt,
      });
      const pmTurn = this.dependencies.repository.insertTurnInTransaction({
        id: planningTurnIdSchema.parse(randomUUID()),
        projectId: execution.projectId,
        planningCycleId: assignment.planningCycleId,
        ordinal: view.turns.length + 1,
        actor: 'pm',
        message: report.assistantMessage,
        launchState: null,
        executionId: execution.id,
        createdAt: event.occurredAt,
      });

      if (report.result.kind === 'questions') {
        this.dependencies.repository.insertQuestionsInTransaction(
          report.result.questions.map((question) => ({
            id: planningQuestionIdSchema.parse(randomUUID()),
            projectId: execution.projectId,
            planningCycleId: assignment.planningCycleId,
            turnId: pmTurn.id,
            ...question,
          })),
        );
        this.dependencies.repository.updateCycleInTransaction(
          {
            ...view.cycle,
            lifecycle: 'awaiting_human',
            activeExecutionId: null,
            updatedAt: event.occurredAt,
          },
          view.cycle.revision,
        );
      } else {
        const prior = this.dependencies.repository
          .deliveryPlanProposals(view.cycle.id)
          .at(-1);
        const created =
          this.dependencies.repository.insertDeliveryPlanProposalInTransaction({
            ...proposal!,
            createdByTurnId: pmTurn.id,
          });
        if (prior?.decision.kind === 'pending') {
          this.dependencies.repository.settleDeliveryPlanProposalInTransaction(
            prior.id,
            {
              kind: 'superseded',
              reason: 'replacement_accepted',
              supersededByProposalId: created.id,
              decidedAt: event.occurredAt,
            },
          );
        }
        this.dependencies.repository.updateCycleInTransaction(
          {
            ...view.cycle,
            lifecycle: 'awaiting_approval',
            latestProposalRevision: created.revision,
            activeExecutionId: null,
            updatedAt: event.occurredAt,
          },
          view.cycle.revision,
        );
      }

      const planningCycle = this.dependencies.repository.cycleView(
        assignment.planningCycleId,
      )!;
      return this.dependencies.events.appendDomainInTransaction(
        execution.projectId,
        {
          projectId: execution.projectId,
          occurredAt: event.occurredAt,
          type: 'planning_cycle.changed',
          payload: { schemaVersion: 2, planningCycle },
        },
      );
    } catch (error) {
      if (
        !(error instanceof RejectedReport) &&
        !this.isValidationError(error)
      ) {
        throw error;
      }
      const reason =
        error instanceof RejectedReport ? error.reason : 'invalid_report';
      const cycle = this.dependencies.repository.cycle(
        assignment.planningCycleId,
      );
      if (!cycle) throw error;
      this.dependencies.repository.insertReceiptInTransaction({
        executionId: execution.id,
        projectId: execution.projectId,
        planningCycleId: assignment.planningCycleId,
        humanTurnId: assignment.humanTurnId,
        runtimeEventId: event.id,
        outputDigest,
        status: 'rejected',
        rejectionReason: reason,
        createdAt: event.occurredAt,
      });
      this.dependencies.repository.updateCycleInTransaction(
        {
          ...cycle,
          lifecycle: 'attention_required',
          activeExecutionId: null,
          updatedAt: event.occurredAt,
        },
        cycle.revision,
      );
      const planningCycle = this.dependencies.repository.cycleView(cycle.id)!;
      return this.dependencies.events.appendDomainInTransaction(
        execution.projectId,
        {
          projectId: execution.projectId,
          occurredAt: event.occurredAt,
          type: 'planning_cycle.changed',
          payload: { schemaVersion: 2, planningCycle },
        },
      );
    }
  }

  private assertEnvelopeBinding(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
    assignment: PmDiscoveryAssignment,
  ): void {
    if (
      assignment.kind !== 'pm_discovery' ||
      assignment.outputSchema !== PM_DISCOVERY_REPORT_SCHEMA ||
      event.type !== 'worker_execution.structured_output' ||
      event.executionId !== execution.id ||
      event.projectId !== execution.projectId ||
      event.payload.schema !== PM_DISCOVERY_REPORT_SCHEMA ||
      assignment.projectId !== execution.projectId
    ) {
      throw new RejectedReport('event_binding_mismatch');
    }
  }

  private assertPlanEnvelopeBinding(
    execution: WorkerExecution,
    event: WorkerExecutionStructuredOutputRuntimeEvent,
    assignment: PmPlanAssignment,
  ): void {
    if (
      assignment.outputSchema !== PM_PLAN_REPORT_SCHEMA ||
      event.type !== 'worker_execution.structured_output' ||
      event.executionId !== execution.id ||
      event.projectId !== execution.projectId ||
      event.payload.schema !== PM_PLAN_REPORT_SCHEMA ||
      assignment.projectId !== execution.projectId
    ) {
      throw new RejectedReport('event_binding_mismatch');
    }
  }

  private assertPlanReportBinding(
    execution: WorkerExecution,
    assignment: PmPlanAssignment,
    report: PmPlanReport,
  ): void {
    if (
      report.planningCycleId !== assignment.planningCycleId ||
      report.humanTurnId !== assignment.humanTurnId ||
      report.expectedCycleRevision !== assignment.expectedCycleRevision ||
      report.expectedProposalRevision !== assignment.expectedProposalRevision ||
      execution.profileRevision <= 0
    ) {
      throw new RejectedReport('report_binding_mismatch');
    }
  }

  private projectDeliveryPlanProposal(
    execution: WorkerExecution,
    assignment: PmPlanAssignment,
    report: PmPlanReport,
    at: string,
  ): DeliveryPlanProposal {
    if (report.result.kind !== 'plan_proposal') {
      throw new RejectedReport('invalid_report');
    }
    const currentIntent = this.dependencies.repository.approvedIntentLedger(
      execution.projectId,
    );
    const currentPlan =
      this.dependencies.repository.approvedDeliveryPlan(execution.projectId) ??
      null;
    if (
      !currentIntent ||
      currentIntent.projectIntent.id !== assignment.baseProjectIntentId ||
      currentIntent.projectIntent.revision !==
        assignment.baseProjectIntentRevision ||
      currentIntent.ledger.id !== assignment.baseLedgerId ||
      currentIntent.ledger.revision !== assignment.baseLedgerRevision ||
      (currentPlan?.plan.id ?? null) !== assignment.baseDeliveryPlanId ||
      (currentPlan?.plan.revision ?? null) !==
        assignment.baseDeliveryPlanRevision
    ) {
      throw new RejectedReport('canonical_base_mismatch');
    }

    const proposedPlan = report.result.proposal;
    const reservations = {
      milestones: proposedPlan.milestones.flatMap((member) =>
        member.operation === 'create'
          ? [{ key: member.key, id: milestoneIdSchema.parse(randomUUID()) }]
          : [],
      ),
      tasks: proposedPlan.tasks.flatMap((member) =>
        member.operation === 'create'
          ? [{ key: member.key, id: taskIdSchema.parse(randomUUID()) }]
          : [],
      ),
      dependencies: proposedPlan.dependencies.flatMap((member) =>
        member.operation === 'create'
          ? [
              {
                key: member.key,
                id: taskDependencyIdSchema.parse(randomUUID()),
              },
            ]
          : [],
      ),
    };
    const diff = this.deliveryPlanDiff(proposedPlan, reservations, currentPlan);
    return deliveryPlanProposalSchema.parse({
      id: deliveryPlanProposalIdSchema.parse(randomUUID()),
      projectId: execution.projectId,
      planningCycleId: assignment.planningCycleId,
      revision: report.expectedProposalRevision,
      lifecycle: 'awaiting_approval',
      base: {
        projectIntentId: assignment.baseProjectIntentId,
        projectIntentRevision: assignment.baseProjectIntentRevision,
        ledgerId: assignment.baseLedgerId,
        ledgerRevision: assignment.baseLedgerRevision,
        deliveryPlan:
          assignment.baseDeliveryPlanId === null
            ? { id: null, revision: null }
            : {
                id: assignment.baseDeliveryPlanId,
                revision: assignment.baseDeliveryPlanRevision!,
              },
      },
      proposedPlan,
      reservations,
      diff,
      createdByTurnId: assignment.humanTurnId,
      createdByExecutionId: execution.id,
      createdAt: at,
      decision: { kind: 'pending' },
    });
  }

  private deliveryPlanDiff(
    proposedPlan: DeliveryPlanProposal['proposedPlan'],
    reservations: DeliveryPlanProposal['reservations'],
    base: ApprovedDeliveryPlan | null,
  ): DeliveryPlanProposal['diff'] {
    const empty = () => ({
      create: 0,
      reuse: 0,
      revise: 0,
      retire: 0,
      reactivate: 0,
    });
    const result = {
      milestones: empty(),
      tasks: empty(),
      dependencies: empty(),
    };
    const baseCollections = {
      milestones: new Map(base?.milestones.map((value) => [value.id, value])),
      tasks: new Map(base?.taskContracts.map((value) => [value.id, value])),
      dependencies: new Map(
        base?.dependencies.map((value) => [value.id, value]),
      ),
    };
    for (const [name, members] of [
      ['milestones', proposedPlan.milestones],
      ['tasks', proposedPlan.tasks],
      ['dependencies', proposedPlan.dependencies],
    ] as const) {
      for (const member of members) {
        if (member.operation === 'create') {
          result[name].create += 1;
        } else if (member.operation === 'reuse') {
          result[name].reuse += 1;
        } else {
          const id =
            'milestoneId' in member
              ? member.milestoneId
              : 'taskId' in member
                ? member.taskId
                : member.dependencyId;
          const prior = baseCollections[name].get(id as never) as
            | { lifecycle: string }
            | undefined;
          if (!prior) throw new RejectedReport('canonical_base_mismatch');
          if (prior.lifecycle === member.lifecycle) result[name].revise += 1;
          else if (member.lifecycle === 'retired') result[name].retire += 1;
          else result[name].reactivate += 1;
        }
      }
    }

    const milestoneReservations = new Map(
      reservations.milestones.map(({ key, id }) => [key, id]),
    );
    const taskReservations = new Map(
      reservations.tasks.map(({ key, id }) => [key, id]),
    );
    const milestoneRevisions = new Map(
      proposedPlan.milestones.map((member) => [
        member.operation === 'create'
          ? milestoneReservations.get(member.key)
          : member.milestoneId,
        member.operation === 'create'
          ? 1
          : member.expectedRevision + (member.operation === 'revise' ? 1 : 0),
      ]),
    );
    const taskRevisions = new Map(
      proposedPlan.tasks.map((member) => [
        member.operation === 'create'
          ? taskReservations.get(member.key)
          : member.taskId,
        member.operation === 'create'
          ? 1
          : member.operation === 'reuse'
            ? member.expectedContractRevision
            : member.expectedCurrentRevision + 1,
      ]),
    );
    const traceKey = (
      trace: DeliveryPlanProposal['proposedPlan']['traces'][number],
    ) => {
      if (trace.kind === 'milestone_covers') {
        const id =
          trace.milestone.kind === 'canonical'
            ? trace.milestone.milestoneId
            : milestoneReservations.get(trace.milestone.key);
        return `${trace.kind}:${id}:${milestoneRevisions.get(id)}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
      }
      const id =
        trace.task.kind === 'canonical'
          ? trace.task.taskId
          : taskReservations.get(trace.task.key);
      return `${trace.kind}:${id}:${taskRevisions.get(id)}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`;
    };
    const proposedTraceKeys = new Set(proposedPlan.traces.map(traceKey));
    const baseTraceKeys = new Set(
      (base?.traces ?? []).map((trace) =>
        trace.kind === 'milestone_covers'
          ? `${trace.kind}:${trace.milestoneId}:${trace.milestoneRevision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`
          : `${trace.kind}:${trace.taskId}:${trace.taskContractRevision}:${trace.requirement.recordId}:${trace.requirement.recordRevision}`,
      ),
    );
    return {
      ...result,
      traceCreateCount: [...proposedTraceKeys].filter(
        (key) => !baseTraceKeys.has(key),
      ).length,
      traceRemoveCount: [...baseTraceKeys].filter(
        (key) => !proposedTraceKeys.has(key),
      ).length,
    };
  }

  private authoritativeExecution(execution: WorkerExecution): WorkerExecution {
    const row = this.dependencies.database
      .prepare(
        `SELECT project_id, profile_id, profile_revision, assignment_json,
          lifecycle, revision, native_handle, failure_json,
          last_adapter_cursor, last_runtime_sequence, updated_at, ended_at
         FROM worker_executions WHERE id = ?`,
      )
      .get(execution.id) as
      | {
          project_id: string;
          profile_id: string;
          profile_revision: number;
          assignment_json: string;
          lifecycle: WorkerExecution['lifecycle'];
          revision: number;
          native_handle: string | null;
          failure_json: string | null;
          last_adapter_cursor: number;
          last_runtime_sequence: number;
          updated_at: string;
          ended_at: string | null;
        }
      | undefined;
    if (!row) throw new Error('PM execution was not found');
    return {
      ...execution,
      projectId: row.project_id,
      profileId: row.profile_id,
      profileRevision: row.profile_revision,
      assignment: JSON.parse(row.assignment_json),
      lifecycle: row.lifecycle,
      revision: row.revision,
      nativeHandle: row.native_handle,
      failure: row.failure_json === null ? null : JSON.parse(row.failure_json),
      lastAdapterCursor: row.last_adapter_cursor,
      lastRuntimeSequence: row.last_runtime_sequence,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
    } as WorkerExecution;
  }

  private assertReportBinding(
    execution: WorkerExecution,
    assignment: PmDiscoveryAssignment,
    report: PmDiscoveryReport,
  ): void {
    if (
      report.planningCycleId !== assignment.planningCycleId ||
      report.humanTurnId !== assignment.humanTurnId ||
      report.expectedCycleRevision !== assignment.expectedCycleRevision ||
      report.expectedProposalRevision !== assignment.expectedProposalRevision ||
      execution.profileRevision <= 0
    ) {
      throw new RejectedReport('report_binding_mismatch');
    }
  }

  private projectProposal(
    execution: WorkerExecution,
    assignment: PmDiscoveryAssignment,
    report: PmDiscoveryReport,
    result: ProposalReport,
    at: string,
  ): PlanningProposal {
    const view = this.dependencies.repository.cycleView(
      assignment.planningCycleId,
    )!;
    const canonical = this.dependencies.repository.approvedIntentLedger(
      execution.projectId,
    );
    if (
      (canonical?.projectIntent.revision ?? null) !==
        assignment.baseProjectIntentRevision ||
      (canonical?.ledger.revision ?? null) !== assignment.baseLedgerRevision
    ) {
      throw new RejectedReport('canonical_base_mismatch');
    }
    const baseRecords = new Map(
      (canonical?.records ?? []).map((record) => [record.recordId, record]),
    );
    const seenBase = new Set<string>();
    const turnIds = new Set(view.turns.map(({ id }) => id));
    this.assertProvenance(result.projectIntent.provenance, turnIds);

    const records = result.records.map((member) => {
      if (member.operation === 'create') {
        this.assertProvenance(member.provenance, turnIds);
        return {
          ...member,
          recordId: ledgerRecordIdSchema.parse(randomUUID()),
        };
      }
      const current = baseRecords.get(member.recordId);
      if (
        !current ||
        current.revision !== member.expectedRevision ||
        seenBase.has(member.recordId)
      ) {
        throw new RejectedReport('record_revision_mismatch');
      }
      seenBase.add(member.recordId);
      if (member.operation === 'revise') {
        if (current.content.type !== member.content.type) {
          throw new RejectedReport('record_type_mismatch');
        }
        this.assertProvenance(member.provenance, turnIds);
      }
      return member;
    });
    if ([...baseRecords.keys()].some((recordId) => !seenBase.has(recordId))) {
      throw new RejectedReport('incomplete_ledger_membership');
    }

    const normalizedRelationships = result.relationships.map(
      normalizeRelationship,
    );
    const relationKeys = new Set<string>();
    for (const relationship of normalizedRelationships) {
      const key = relationshipKey(relationship);
      if (relationKeys.has(key))
        throw new RejectedReport('duplicate_relationship');
      relationKeys.add(key);
      const fromType = this.endpointType(
        relationship.from,
        records,
        baseRecords,
      );
      const toType = this.endpointType(relationship.to, records, baseRecords);
      if (
        (relationship.kind === 'constrains' &&
          (fromType !== 'decision' || toType !== 'requirement')) ||
        (relationship.kind !== 'constrains' &&
          (fromType !== 'requirement' || toType !== 'requirement'))
      ) {
        throw new RejectedReport('relationship_type_invalid');
      }
    }

    const baseRelationships: ProposedLedgerRelationship[] = (
      canonical?.relationships ?? []
    ).map((relationship) => ({
      kind: relationship.kind,
      from: { recordId: relationship.fromRecordId },
      to: { recordId: relationship.toRecordId },
    }));
    const baseKeys = new Set(baseRelationships.map(relationshipKey));
    const finalKeys = new Set(normalizedRelationships.map(relationshipKey));
    const projectIntentBase = canonical?.projectIntent.content;
    return {
      id: planningProposalIdSchema.parse(randomUUID()),
      projectId: execution.projectId,
      planningCycleId: assignment.planningCycleId,
      revision: report.expectedProposalRevision,
      lifecycle: 'awaiting_approval',
      baseProjectIntentRevision: assignment.baseProjectIntentRevision,
      baseLedgerRevision: assignment.baseLedgerRevision,
      summary: result.summary,
      projectIntent: result.projectIntent,
      records,
      relationships: normalizedRelationships,
      diff: {
        intentChanges: intentFields.filter(
          (field) =>
            canonicalJson(projectIntentBase?.[field]) !==
            canonicalJson(result.projectIntent[field]),
        ),
        recordChanges: {
          create: records.filter(({ operation }) => operation === 'create')
            .length,
          revise: records.filter(({ operation }) => operation === 'revise')
            .length,
          reuse: records.filter(({ operation }) => operation === 'reuse')
            .length,
        },
        relationshipChanges: {
          added: normalizedRelationships.filter(
            (relationship) => !baseKeys.has(relationshipKey(relationship)),
          ),
          removed: baseRelationships.filter(
            (relationship) => !finalKeys.has(relationshipKey(relationship)),
          ),
        },
      },
      createdByTurnId: assignment.humanTurnId,
      createdByExecutionId: execution.id,
      rejectionFeedback: null,
      createdAt: at,
      decidedAt: null,
    };
  }

  private endpointType(
    endpoint: Endpoint,
    records: PlanningProposal['records'],
    base: Map<string, { content: LedgerRecordContent }>,
  ): LedgerRecordContent['type'] | undefined {
    if ('proposalKey' in endpoint) {
      const member = records.find(
        (record) =>
          record.operation === 'create' && record.key === endpoint.proposalKey,
      );
      return member?.operation === 'create' ? member.content.type : undefined;
    }
    const member = records.find(
      (record) =>
        record.operation !== 'create' && record.recordId === endpoint.recordId,
    );
    return member?.operation === 'revise'
      ? member.content.type
      : base.get(endpoint.recordId)?.content.type;
  }

  private assertProvenance(
    provenance: readonly { turnId: string }[],
    turnIds: Set<string>,
  ): void {
    const seen = new Set<string>();
    for (const { turnId } of provenance) {
      if (seen.has(turnId)) {
        throw new RejectedReport('duplicate_provenance_turn');
      }
      seen.add(turnId);
      if (!turnIds.has(turnId)) {
        throw new RejectedReport('provenance_outside_cycle');
      }
    }
  }

  private hasDuplicateQuestionKey(
    existing: readonly string[],
    proposed: readonly string[],
  ): boolean {
    const keys = new Set(existing);
    return proposed.some((key) => {
      if (keys.has(key)) return true;
      keys.add(key);
      return false;
    });
  }

  private isValidationError(error: unknown): boolean {
    if (error instanceof PlanningProposalInvalidError) return true;
    return Boolean(
      error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'ZodError',
    );
  }
}
