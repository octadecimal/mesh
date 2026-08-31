import { randomUUID } from 'node:crypto';

import {
  abandonPlanningCycleEnvelopeSchema,
  approvedDeliveryPlanSchema,
  approvePlanProposalEnvelopeSchema,
  approvePlanningProposalEnvelopeSchema,
  deliveryPlanPlanningCycleViewSchema,
  deliveryPlanIdSchema,
  PM_DISCOVERY_REPORT_SCHEMA,
  PM_PLAN_REPORT_SCHEMA,
  planningCycleIdSchema,
  planningTurnIdSchema,
  rejectPlanProposalEnvelopeSchema,
  rejectPlanningProposalEnvelopeSchema,
  setBoardFilterEnvelopeSchema,
  startExecutionEnvelopeSchema,
  submitPlanTurnEnvelopeSchema,
  submitPlanningTurnEnvelopeSchema,
  v2CommandResultSchema,
  type AbandonPlanningCycleEnvelope,
  type ApprovedDeliveryPlan,
  type ApprovePlanProposalEnvelope,
  type ApprovePlanningProposalEnvelope,
  type DeliveryPlanProposal,
  type DomainEvent,
  type PlanningCycle,
  type PlanningTurn,
  type ProposedMilestoneRef,
  type ProposedTaskRef,
  type RejectPlanProposalEnvelope,
  type RejectPlanningProposalEnvelope,
  type ResolvedWorkerProfileSnapshot,
  type SetBoardFilterEnvelope,
  type StartExecutionEnvelope,
  type SubmitPlanningTurnEnvelope,
  type SubmitPlanTurnEnvelope,
  type V2CommandResult,
  type WorkerExecution,
  type WorkerExecutionId,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import type { ExecutionRepository } from '../executions/execution-repository.js';
import {
  hashV2Command,
  V2IdempotencyConflictError,
  type V2CommandRepository,
} from '../storage/command-repository.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { V2EventStore } from '../storage/event-store.js';
import type { PmReportConsumer } from './pm-report-consumer.js';
import { projectBoard } from './planning-board.js';
import {
  PlanningProposalInvalidError,
  PlanningRepository,
} from './planning-repository.js';

export type PmExecutionReservation = {
  execution: WorkerExecution;
  result: V2CommandResult;
  activationRequired: boolean;
};

export type PmExecutionLaunchInput = StartExecutionEnvelope;

export type PmExecutionLauncher = {
  findReserved(
    input: PmExecutionLaunchInput,
  ): PmExecutionReservation | undefined;
  reserve(input: PmExecutionLaunchInput): Promise<PmExecutionReservation>;
  activate(executionId: WorkerExecutionId): Promise<void>;
  cancelReserved(executionId: WorkerExecutionId): Promise<WorkerExecution>;
  interruptForPlanning(executionId: WorkerExecutionId): Promise<void>;
};

type Dependencies = {
  database: V2Database;
  repository: PlanningRepository;
  commands: V2CommandRepository;
  events: V2EventStore;
  executions: Pick<ExecutionRepository, 'get'>;
  profiles: {
    resolveApproved(
      profileId: string,
      revision: number,
    ): ResolvedWorkerProfileSnapshot;
  };
  launcher: PmExecutionLauncher;
  barrier: AuditBarrier;
  reportConsumer: Pick<PmReportConsumer, 'consume'>;
  now?: () => string;
  publishDomain?: (event: DomainEvent) => void;
};

type LaunchCoordinator = {
  cancelled: boolean;
  cancellationOwners: Set<symbol>;
  active?: Promise<void>;
};

const terminalExecution = new Set<WorkerExecution['lifecycle']>([
  'completed',
  'failed',
  'interrupted',
  'attention_required',
]);

const failure = (
  commandType: V2CommandResult['commandType'],
  code: Extract<V2CommandResult, { ok: false }>['error']['code'],
  message: string,
): V2CommandResult =>
  v2CommandResultSchema.parse({
    ok: false,
    commandType,
    error: { code, message },
  });

export class PlanningService {
  private readonly now: () => string;
  private readonly coordinators = new Map<string, LaunchCoordinator>();

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async submitTurn(
    input: SubmitPlanningTurnEnvelope,
  ): Promise<V2CommandResult> {
    this.dependencies.barrier.assertHealthy();
    const envelope = submitPlanningTurnEnvelopeSchema.parse(input);
    const requestHash = hashV2Command(envelope.command);
    const replay = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;

    let turn: PlanningTurn | undefined;
    let event: DomainEvent | undefined;
    const result = this.auditTransaction(() => {
      const existing = envelope.command.planningCycleId
        ? this.dependencies.repository.cycle(envelope.command.planningCycleId)
        : this.dependencies.repository.activeCycle(envelope.command.projectId);
      let cycle: PlanningCycle;
      let turnOrdinal = 1;
      const at = this.now();

      if (envelope.command.planningCycleId === undefined) {
        if (existing) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_active_conflict',
            'A planning cycle is already active for this project',
            at,
          );
        }
        const { profileId, profileRevision } = envelope.command;
        if (profileId === undefined || profileRevision === undefined) {
          throw new Error('Parsed new planning cycle command lacks a profile');
        }
        const profile = this.resolvePmProfile(
          profileId,
          profileRevision,
          envelope.command.projectId,
        );
        if (!profile) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_profile_incompatible',
            'The selected profile cannot run PM discovery',
            at,
          );
        }
        const ledger = this.dependencies.repository.approvedIntentLedger(
          envelope.command.projectId,
        );
        cycle = this.dependencies.repository.insertCycleInTransaction({
          id: planningCycleIdSchema.parse(randomUUID()),
          projectId: envelope.command.projectId,
          lifecycle: 'launch_pending',
          revision: 1,
          profileId: profile.profileId,
          profileRevision: profile.profileRevision,
          baseProjectIntentRevision: ledger?.projectIntent.revision ?? null,
          baseLedgerRevision: ledger?.ledger.revision ?? null,
          latestProposalRevision: 0,
          activeExecutionId: null,
          createdAt: at,
          updatedAt: at,
          endedAt: null,
        });
      } else {
        if (!existing || existing.projectId !== envelope.command.projectId) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_not_found',
            'Planning cycle was not found',
            at,
          );
        }
        if (
          existing.revision !== envelope.command.expectedCycleRevision ||
          ![
            'discovering',
            'awaiting_human',
            'awaiting_approval',
            'attention_required',
          ].includes(existing.lifecycle)
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_revision_conflict',
            'Planning cycle revision or lifecycle does not accept a turn',
            at,
          );
        }
        const currentView = this.dependencies.repository.cycleView(
          existing.id,
        )!;
        if (
          currentView.turns.filter(({ actor }) => actor === 'human').length >=
            32 ||
          currentView.proposals.length >= 16
        ) {
          return failure(
            envelope.command.type,
            'planning_cycle_history_limit',
            'Planning cycle reached its history limit',
          );
        }
        turnOrdinal = currentView.turns.length + 1;
        cycle = this.dependencies.repository.updateCycleInTransaction(
          {
            ...existing,
            lifecycle: 'launch_pending',
            revision: existing.revision + 1,
            activeExecutionId: null,
            updatedAt: at,
            endedAt: null,
          },
          existing.revision,
        );
      }

      turn = this.dependencies.repository.insertTurnInTransaction({
        id: planningTurnIdSchema.parse(randomUUID()),
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        ordinal: turnOrdinal,
        actor: 'human',
        message: envelope.command.message,
        launchState: 'launch_pending',
        executionId: null,
        createdAt: at,
      });
      const planningCycle = this.dependencies.repository.cycleView(cycle.id)!;
      event = this.dependencies.events.appendDomainInTransaction(
        cycle.projectId,
        {
          projectId: cycle.projectId,
          occurredAt: at,
          type: 'planning_cycle.changed',
          payload: { schemaVersion: 2, planningCycle },
        },
      );
      const success = v2CommandResultSchema.parse({
        ok: true,
        schemaVersion: 2,
        commandType: 'planning_cycle.submit_turn',
        planningCycle,
      });
      this.dependencies.commands.storeInTransaction({
        idempotencyKey: envelope.idempotencyKey,
        commandType: envelope.command.type,
        requestHash,
        result: success,
        createdAt: at,
      });
      return success;
    });

    if (event) this.dependencies.publishDomain?.(event);
    if (result.ok && turn) await this.drainTurn(turn);
    return result;
  }

  async submitPlanTurn(
    input: SubmitPlanTurnEnvelope,
  ): Promise<V2CommandResult> {
    this.dependencies.barrier.assertHealthy();
    const envelope = submitPlanTurnEnvelopeSchema.parse(input);
    const requestHash = hashV2Command(envelope.command);
    const replay = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;

    let turn: PlanningTurn | undefined;
    let event: DomainEvent | undefined;
    const result = this.auditTransaction(() => {
      const at = this.now();
      const existing =
        'planningCycleId' in envelope.command
          ? this.dependencies.repository.cycle(envelope.command.planningCycleId)
          : this.dependencies.repository.activeCycle(
              envelope.command.projectId,
            );
      let cycle: PlanningCycle;
      let turnOrdinal = 1;

      if (!('planningCycleId' in envelope.command)) {
        if (existing) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_active_conflict',
            'A planning cycle is already active for this project',
            at,
          );
        }
        const ledger = this.dependencies.repository.approvedIntentLedger(
          envelope.command.projectId,
        );
        if (!ledger) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_intent_required',
            'Approved intent is required before delivery planning',
            at,
          );
        }
        if (
          !ledger.records.some(
            ({ content }) =>
              content.type === 'requirement' && content.status === 'approved',
          )
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_requirements_required',
            'At least one approved requirement is required before delivery planning',
            at,
          );
        }
        const approvedPlan =
          this.dependencies.repository.approvedDeliveryPlan(
            envelope.command.projectId,
          ) ?? null;
        const expectedPlan = envelope.command.expectedDeliveryPlan;
        if (
          ledger.projectIntent.id !==
            envelope.command.expectedProjectIntentId ||
          ledger.projectIntent.revision !==
            envelope.command.expectedProjectIntentRevision ||
          ledger.ledger.id !== envelope.command.expectedLedgerId ||
          ledger.ledger.revision !== envelope.command.expectedLedgerRevision ||
          (approvedPlan?.plan.id ?? null) !== expectedPlan.id ||
          (approvedPlan?.plan.revision ?? null) !== expectedPlan.revision
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'plan_canonical_base_conflict',
            'Delivery plan canonical base does not match',
            at,
          );
        }
        const profile = this.resolvePlanProfile(
          envelope.command.profileId,
          envelope.command.profileRevision,
          envelope.command.projectId,
        );
        if (!profile) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_profile_incompatible',
            'The selected profile cannot run delivery planning',
            at,
          );
        }
        const cycleId = planningCycleIdSchema.parse(randomUUID());
        cycle = this.dependencies.repository.insertCycleInTransaction(
          {
            id: cycleId,
            projectId: envelope.command.projectId,
            lifecycle: 'launch_pending',
            revision: 1,
            profileId: profile.profileId,
            profileRevision: profile.profileRevision,
            baseProjectIntentRevision: ledger.projectIntent.revision,
            baseLedgerRevision: ledger.ledger.revision,
            latestProposalRevision: 0,
            activeExecutionId: null,
            createdAt: at,
            updatedAt: at,
            endedAt: null,
          },
          {
            planningCycleId: cycleId,
            purpose: 'delivery_plan',
            baseDeliveryPlanId: approvedPlan?.plan.id ?? null,
            baseDeliveryPlanRevision: approvedPlan?.plan.revision ?? null,
          },
        );
      } else {
        if (!existing || existing.projectId !== envelope.command.projectId) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_not_found',
            'Planning cycle was not found',
            at,
          );
        }
        const purpose = this.dependencies.repository.cyclePurpose(existing.id);
        if (
          purpose?.purpose !== 'delivery_plan' ||
          existing.revision !== envelope.command.expectedCycleRevision ||
          ![
            'discovering',
            'awaiting_human',
            'awaiting_approval',
            'attention_required',
          ].includes(existing.lifecycle)
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_revision_conflict',
            'Planning cycle revision or lifecycle does not accept a turn',
            at,
          );
        }
        const ledger = this.dependencies.repository.approvedIntentLedger(
          existing.projectId,
        );
        const approvedPlan =
          this.dependencies.repository.approvedDeliveryPlan(
            existing.projectId,
          ) ?? null;
        if (
          !ledger ||
          ledger.projectIntent.revision !==
            existing.baseProjectIntentRevision ||
          ledger.ledger.revision !== existing.baseLedgerRevision ||
          (approvedPlan?.plan.id ?? null) !== purpose.baseDeliveryPlanId ||
          (approvedPlan?.plan.revision ?? null) !==
            purpose.baseDeliveryPlanRevision
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'plan_canonical_base_conflict',
            'Delivery plan canonical base changed during planning',
            at,
          );
        }
        const view = this.dependencies.repository.cycleView(existing.id)!;
        if (
          view.turns.filter(({ actor }) => actor === 'human').length >= 32 ||
          view.deliveryPlanProposals.length >= 16
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_history_limit',
            'Planning cycle reached its history limit',
            at,
          );
        }
        turnOrdinal = view.turns.length + 1;
        cycle = this.dependencies.repository.updateCycleInTransaction(
          {
            ...existing,
            lifecycle: 'launch_pending',
            revision: existing.revision + 1,
            activeExecutionId: null,
            updatedAt: at,
            endedAt: null,
          },
          existing.revision,
        );
      }

      turn = this.dependencies.repository.insertTurnInTransaction({
        id: planningTurnIdSchema.parse(randomUUID()),
        projectId: cycle.projectId,
        planningCycleId: cycle.id,
        ordinal: turnOrdinal,
        actor: 'human',
        message: envelope.command.message,
        launchState: 'launch_pending',
        executionId: null,
        createdAt: at,
      });
      const planningCycle = this.dependencies.repository.cycleView(cycle.id)!;
      event = this.dependencies.events.appendDomainInTransaction(
        cycle.projectId,
        {
          projectId: cycle.projectId,
          occurredAt: at,
          type: 'planning_cycle.changed',
          payload: { schemaVersion: 2, planningCycle },
        },
      );
      const success = v2CommandResultSchema.parse({
        ok: true,
        schemaVersion: 2,
        commandType: 'planning_cycle.submit_plan_turn',
        planningCycle,
      });
      this.dependencies.commands.storeInTransaction({
        idempotencyKey: envelope.idempotencyKey,
        commandType: envelope.command.type,
        requestHash,
        result: success,
        createdAt: at,
      });
      return success;
    });

    if (event) this.dependencies.publishDomain?.(event);
    if (result.ok && turn) await this.drainTurn(turn);
    return result;
  }

  approveProposal(input: ApprovePlanningProposalEnvelope): V2CommandResult {
    return this.decideProposal(
      approvePlanningProposalEnvelopeSchema.parse(input),
      'approved',
    );
  }

  approvePlanProposal(input: ApprovePlanProposalEnvelope): V2CommandResult {
    return this.decidePlanProposal(
      approvePlanProposalEnvelopeSchema.parse(input),
      'approved',
    );
  }

  rejectPlanProposal(input: RejectPlanProposalEnvelope): V2CommandResult {
    return this.decidePlanProposal(
      rejectPlanProposalEnvelopeSchema.parse(input),
      'rejected',
    );
  }

  setBoardFilter(input: SetBoardFilterEnvelope): V2CommandResult {
    this.dependencies.barrier.assertHealthy();
    const envelope = setBoardFilterEnvelopeSchema.parse(input);
    const requestHash = hashV2Command(envelope.command);
    const replay = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;
    let event: DomainEvent | undefined;
    const result = this.auditTransaction(() => {
      const at = this.now();
      try {
        this.dependencies.repository.replaceBoardFilterInTransaction(
          {
            projectId: envelope.command.projectId,
            revision: envelope.command.expectedFilterRevision + 1,
            ...envelope.command.filter,
            updatedAt: at,
          },
          envelope.command.expectedFilterRevision,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = error.message.includes('revision conflict')
          ? 'board_filter_revision_conflict'
          : error.message.startsWith('Board filter') ||
              error.message === 'Approved delivery plan was not found'
            ? 'board_filter_invalid'
            : undefined;
        if (!code) throw error;
        return this.storeFailure(
          envelope,
          requestHash,
          code,
          code === 'board_filter_revision_conflict'
            ? 'Board filter revision does not match'
            : 'Board filter selection is invalid',
          at,
        );
      }
      const board = this.board(envelope.command.projectId);
      event = this.dependencies.events.appendDomainInTransaction(
        envelope.command.projectId,
        {
          projectId: envelope.command.projectId,
          occurredAt: at,
          type: 'board.filter_changed',
          payload: { schemaVersion: 1, board },
        },
      );
      const success = v2CommandResultSchema.parse({
        ok: true,
        schemaVersion: 2,
        commandType: 'board_filter.set',
        board,
      });
      this.dependencies.commands.storeInTransaction({
        idempotencyKey: envelope.idempotencyKey,
        commandType: envelope.command.type,
        requestHash,
        result: success,
        createdAt: at,
      });
      return success;
    });
    if (event) this.dependencies.publishDomain?.(event);
    return result;
  }

  rejectProposal(input: RejectPlanningProposalEnvelope): V2CommandResult {
    return this.decideProposal(
      rejectPlanningProposalEnvelopeSchema.parse(input),
      'rejected',
    );
  }

  async abandonCycle(
    input: AbandonPlanningCycleEnvelope,
  ): Promise<V2CommandResult> {
    this.dependencies.barrier.assertHealthy();
    const envelope = abandonPlanningCycleEnvelopeSchema.parse(input);
    const requestHash = hashV2Command(envelope.command);
    const replay = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;

    const cycle = this.dependencies.repository.cycle(
      envelope.command.planningCycleId,
    );
    if (!cycle || cycle.projectId !== envelope.command.projectId) {
      return this.storeStandaloneFailure(
        envelope,
        requestHash,
        'planning_cycle_not_found',
        'Planning cycle was not found',
      );
    }
    if (
      cycle.revision !== envelope.command.expectedCycleRevision ||
      ['approved', 'proposal_rejected', 'abandoned'].includes(cycle.lifecycle)
    ) {
      return this.storeStandaloneFailure(
        envelope,
        requestHash,
        'planning_cycle_revision_conflict',
        'Planning cycle revision does not match',
      );
    }

    const coordinator = this.coordinator(cycle.id);
    const cancellationOwner = Symbol();
    coordinator.cancellationOwners.add(cancellationOwner);
    try {
      await coordinator.active;
      this.dependencies.barrier.assertHealthy();
      const refreshed = this.dependencies.repository.cycle(cycle.id)!;
      const turns =
        this.dependencies.repository.cycleView(cycle.id)?.turns ?? [];
      const pendingTurn = [...turns]
        .reverse()
        .find(
          (candidate) =>
            candidate.actor === 'human' &&
            candidate.launchState === 'launch_pending',
        );
      const boundTurn = [...turns]
        .reverse()
        .find(
          (candidate) =>
            candidate.actor === 'human' && candidate.executionId !== null,
        );
      const executionId =
        refreshed.activeExecutionId ?? boundTurn?.executionId ?? null;
      const pendingLaunch = pendingTurn
        ? this.launchInput(pendingTurn)
        : undefined;
      const pendingReservation = pendingLaunch
        ? this.dependencies.launcher.findReserved(pendingLaunch)
        : undefined;
      if (pendingLaunch && pendingReservation) {
        this.assertReservation(pendingLaunch, pendingReservation);
        await this.containExecution(pendingReservation.execution.id);
        this.dependencies.barrier.assertHealthy();
      }
      if (refreshed.lifecycle === 'attention_required' && boundTurn) {
        const launch = this.launchInput(boundTurn);
        const observed = this.dependencies.launcher.findReserved(launch);
        if (!observed) {
          throw new Error('Reconciled planning reservation was not found');
        }
        this.assertReservation(launch, observed);
        if (observed.execution.id !== boundTurn.executionId) {
          throw new Error('Reconciled planning reservation binding changed');
        }
      }
      if (executionId) {
        await this.containExecution(executionId);
        this.dependencies.barrier.assertHealthy();
      }
      if (pendingLaunch) {
        const observed = this.dependencies.launcher.findReserved(pendingLaunch);
        if (observed) {
          this.assertReservation(pendingLaunch, observed);
          const execution = this.dependencies.executions.get(
            observed.execution.id,
          );
          if (!execution || !terminalExecution.has(execution.lifecycle)) {
            throw new Error('Planning reservation remains active');
          }
        }
      }

      let event: DomainEvent | undefined;
      const result = this.auditTransaction(() => {
        const replay = this.dependencies.commands.find(
          envelope.idempotencyKey,
          requestHash,
        );
        if (replay) return replay.result;
        const at = this.now();
        const current = this.dependencies.repository.cycle(cycle.id);
        if (!current || current.projectId !== envelope.command.projectId) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_not_found',
            'Planning cycle was not found',
            at,
          );
        }
        if (
          current.revision !== envelope.command.expectedCycleRevision ||
          ['approved', 'proposal_rejected', 'abandoned'].includes(
            current.lifecycle,
          )
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_revision_conflict',
            'Planning cycle revision does not match',
            at,
          );
        }
        const view = this.dependencies.repository.cycleView(cycle.id)!;
        let pendingPlanProposal: DeliveryPlanProposal | undefined;
        if (view.purpose.kind === 'delivery_plan') {
          const latest = view.deliveryPlanProposals.at(-1);
          if (latest?.decision.kind === 'pending') {
            pendingPlanProposal = latest;
          }
        } else {
          const latest = view.proposals.at(-1);
          if (latest?.lifecycle === 'awaiting_approval') {
            this.dependencies.repository.updateProposalInTransaction({
              ...latest,
              lifecycle: 'superseded',
              decidedAt: at,
            });
          }
        }
        this.dependencies.repository.updateCycleInTransaction(
          {
            ...current,
            lifecycle: 'abandoned',
            revision: current.revision + 1,
            activeExecutionId: null,
            updatedAt: at,
            endedAt: at,
          },
          current.revision,
        );
        if (pendingPlanProposal) {
          this.dependencies.repository.settleDeliveryPlanProposalInTransaction(
            pendingPlanProposal.id,
            {
              kind: 'superseded',
              reason: 'cycle_abandoned',
              supersededByProposalId: null,
              decidedAt: at,
            },
          );
        }
        const planningCycle = this.dependencies.repository.cycleView(cycle.id)!;
        event = this.dependencies.events.appendDomainInTransaction(
          cycle.projectId,
          {
            projectId: cycle.projectId,
            occurredAt: at,
            type: 'planning_cycle.changed',
            payload: { schemaVersion: 2, planningCycle },
          },
        );
        const success = v2CommandResultSchema.parse({
          ok: true,
          schemaVersion: 2,
          commandType: 'planning_cycle.abandon',
          planningCycle,
        });
        this.dependencies.commands.storeInTransaction({
          idempotencyKey: envelope.idempotencyKey,
          commandType: envelope.command.type,
          requestHash,
          result: success,
          createdAt: at,
        });
        return success;
      });
      if (result.ok) coordinator.cancelled = true;
      if (event) this.dependencies.publishDomain?.(event);
      return result;
    } finally {
      coordinator.cancellationOwners.delete(cancellationOwner);
    }
  }

  reconcilePendingReservations(): void {
    this.dependencies.barrier.assertHealthy();
    for (const turn of this.dependencies.repository.pendingLaunchTurns()) {
      this.dependencies.barrier.assertHealthy();
      const coordinator = this.coordinator(turn.planningCycleId);
      if (!this.isLaunchable(turn, coordinator)) continue;
      const input = this.launchInput(turn);
      const reservation = this.dependencies.launcher.findReserved(input);
      if (reservation && this.isLaunchable(turn, coordinator)) {
        this.assertReservation(input, reservation);
        this.bindReservation(turn, reservation, true);
      }
    }
  }

  async drainPendingLaunches(): Promise<void> {
    this.dependencies.barrier.assertHealthy();
    await Promise.all(
      this.dependencies.repository
        .pendingLaunchTurns()
        .map((turn) => this.drainTurn(turn)),
    );
  }

  reconcileBoundCycles(): void {
    this.dependencies.barrier.assertHealthy();
    for (const turn of this.dependencies.repository.boundOpenTurns()) {
      this.dependencies.barrier.assertHealthy();
      const execution = this.dependencies.executions.get(turn.executionId!);
      if (execution) {
        const outputs = this.dependencies.events
          .runtimeAfter(turn.projectId, 0)
          .events.filter(
            (event) =>
              event.executionId === execution.id &&
              event.type === 'worker_execution.structured_output',
          );
        for (const output of outputs) {
          this.dependencies.barrier.assertHealthy();
          if (output.type !== 'worker_execution.structured_output') continue;
          this.dependencies.reportConsumer.consume(execution, output);
        }
      }
      this.dependencies.barrier.assertHealthy();
      this.reconcileTerminalExecution(turn.executionId!);
    }
  }

  reconcileTerminalExecution(executionId: WorkerExecutionId): void {
    this.dependencies.barrier.assertHealthy();
    const execution = this.dependencies.executions.get(executionId);
    if (!execution || !terminalExecution.has(execution.lifecycle)) return;
    const turn = this.dependencies.repository
      .boundOpenTurns()
      .find(({ executionId: id }) => id === executionId);
    if (!turn || this.dependencies.repository.receipt(executionId)) return;
    let event: DomainEvent | undefined;
    this.auditTransaction(() => {
      const cycle = this.dependencies.repository.cycle(turn.planningCycleId)!;
      if (cycle.lifecycle === 'attention_required') return;
      this.dependencies.repository.updateCycleInTransaction(
        {
          ...cycle,
          lifecycle: 'attention_required',
          activeExecutionId: null,
          updatedAt: this.now(),
        },
        cycle.revision,
      );
      const planningCycle = this.dependencies.repository.cycleView(cycle.id)!;
      event = this.dependencies.events.appendDomainInTransaction(
        cycle.projectId,
        {
          projectId: cycle.projectId,
          occurredAt: this.now(),
          type: 'planning_cycle.changed',
          payload: { schemaVersion: 2, planningCycle },
        },
      );
    });
    if (event) this.dependencies.publishDomain?.(event);
  }

  private decideProposal(
    envelope: ApprovePlanningProposalEnvelope | RejectPlanningProposalEnvelope,
    decision: 'approved' | 'rejected',
  ): V2CommandResult {
    this.dependencies.barrier.assertHealthy();
    const requestHash = hashV2Command(envelope.command);
    const replay = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;
    let event: DomainEvent | undefined;
    const result = this.auditTransaction(() => {
      const at = this.now();
      const cycle = this.dependencies.repository.cycle(
        envelope.command.planningCycleId,
      );
      if (!cycle || cycle.projectId !== envelope.command.projectId) {
        return this.storeFailure(
          envelope,
          requestHash,
          'planning_cycle_not_found',
          'Planning cycle was not found',
          at,
        );
      }
      if (
        cycle.revision !== envelope.command.expectedCycleRevision ||
        cycle.lifecycle !== 'awaiting_approval'
      ) {
        return this.storeFailure(
          envelope,
          requestHash,
          'planning_cycle_revision_conflict',
          'Planning cycle revision or lifecycle does not match',
          at,
        );
      }
      const proposal = this.dependencies.repository.proposal(
        envelope.command.proposalId,
      );
      if (!proposal || proposal.planningCycleId !== cycle.id) {
        return this.storeFailure(
          envelope,
          requestHash,
          'planning_proposal_not_found',
          'Planning proposal was not found',
          at,
        );
      }
      if (
        proposal.revision !== envelope.command.expectedProposalRevision ||
        proposal.lifecycle !== 'awaiting_approval'
      ) {
        return this.storeFailure(
          envelope,
          requestHash,
          'planning_proposal_revision_conflict',
          'Planning proposal revision or lifecycle does not match',
          at,
        );
      }

      let intentLedger;
      let board;
      if (decision === 'approved') {
        const command =
          envelope.command as ApprovePlanningProposalEnvelope['command'];
        if (
          command.expectedProjectIntentRevision !==
            proposal.baseProjectIntentRevision ||
          command.expectedLedgerRevision !== proposal.baseLedgerRevision
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_canonical_base_conflict',
            'Canonical intent ledger base does not match',
            at,
          );
        }
        try {
          intentLedger =
            this.dependencies.repository.applyApprovedProposalInTransaction(
              proposal,
              at,
            );
          board = this.board(cycle.projectId);
        } catch (error) {
          if (!(error instanceof PlanningProposalInvalidError)) throw error;
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_proposal_invalid',
            'Planning proposal is not valid for approval',
            at,
          );
        }
      }

      this.dependencies.repository.updateProposalInTransaction({
        ...proposal,
        lifecycle: decision,
        rejectionFeedback:
          decision === 'rejected'
            ? (envelope.command as RejectPlanningProposalEnvelope['command'])
                .feedback
            : null,
        decidedAt: at,
      });
      this.dependencies.repository.updateCycleInTransaction(
        {
          ...cycle,
          lifecycle: decision === 'approved' ? 'approved' : 'proposal_rejected',
          revision: cycle.revision + 1,
          activeExecutionId: null,
          updatedAt: at,
          endedAt: at,
        },
        cycle.revision,
      );
      const planningCycle = this.dependencies.repository.cycleView(cycle.id)!;
      if (decision === 'approved') {
        event = this.dependencies.events.appendDomainInTransaction(
          cycle.projectId,
          {
            projectId: cycle.projectId,
            occurredAt: at,
            type: 'intent_ledger.approved',
            payload: {
              schemaVersion: 2,
              planningCycle,
              intentLedger: intentLedger!,
              board: board!,
            },
          },
        );
      } else {
        event = this.dependencies.events.appendDomainInTransaction(
          cycle.projectId,
          {
            projectId: cycle.projectId,
            occurredAt: at,
            type: 'planning_cycle.changed',
            payload: { schemaVersion: 2, planningCycle },
          },
        );
      }
      const success = v2CommandResultSchema.parse(
        decision === 'approved'
          ? {
              ok: true,
              schemaVersion: 2,
              commandType: 'planning_proposal.approve',
              planningCycle,
              intentLedger,
              board,
            }
          : {
              ok: true,
              schemaVersion: 2,
              commandType: 'planning_proposal.reject',
              planningCycle,
            },
      );
      this.dependencies.commands.storeInTransaction({
        idempotencyKey: envelope.idempotencyKey,
        commandType: envelope.command.type,
        requestHash,
        result: success,
        createdAt: at,
      });
      return success;
    });
    if (event) this.dependencies.publishDomain?.(event);
    return result;
  }

  private decidePlanProposal(
    envelope: ApprovePlanProposalEnvelope | RejectPlanProposalEnvelope,
    decision: 'approved' | 'rejected',
  ): V2CommandResult {
    this.dependencies.barrier.assertHealthy();
    const requestHash = hashV2Command(envelope.command);
    const replay = this.dependencies.commands.find(
      envelope.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;
    let event: DomainEvent | undefined;
    const result = this.auditTransaction(() => {
      const at = this.now();
      const cycle = this.dependencies.repository.cycle(
        envelope.command.planningCycleId,
      );
      if (!cycle || cycle.projectId !== envelope.command.projectId) {
        return this.storeFailure(
          envelope,
          requestHash,
          'planning_cycle_not_found',
          'Planning cycle was not found',
          at,
        );
      }
      if (
        this.dependencies.repository.cyclePurpose(cycle.id)?.purpose !==
          'delivery_plan' ||
        cycle.revision !== envelope.command.expectedCycleRevision ||
        cycle.lifecycle !== 'awaiting_approval'
      ) {
        return this.storeFailure(
          envelope,
          requestHash,
          'planning_cycle_revision_conflict',
          'Planning cycle revision or lifecycle does not match',
          at,
        );
      }
      const proposal = this.dependencies.repository.deliveryPlanProposal(
        envelope.command.proposalId,
      );
      if (!proposal || proposal.planningCycleId !== cycle.id) {
        return this.storeFailure(
          envelope,
          requestHash,
          'plan_proposal_not_found',
          'Delivery plan proposal was not found',
          at,
        );
      }
      if (
        proposal.revision !== envelope.command.expectedProposalRevision ||
        proposal.decision.kind !== 'pending'
      ) {
        return this.storeFailure(
          envelope,
          requestHash,
          'plan_proposal_revision_conflict',
          'Delivery plan proposal revision or lifecycle does not match',
          at,
        );
      }

      let deliveryPlan: ApprovedDeliveryPlan | undefined;
      let board;
      if (decision === 'approved') {
        const command =
          envelope.command as ApprovePlanProposalEnvelope['command'];
        if (
          command.expectedProjectIntentId !== proposal.base.projectIntentId ||
          command.expectedProjectIntentRevision !==
            proposal.base.projectIntentRevision ||
          command.expectedLedgerId !== proposal.base.ledgerId ||
          command.expectedLedgerRevision !== proposal.base.ledgerRevision ||
          command.expectedDeliveryPlan.id !== proposal.base.deliveryPlan.id ||
          command.expectedDeliveryPlan.revision !==
            proposal.base.deliveryPlan.revision
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'plan_canonical_base_conflict',
            'Delivery plan canonical base does not match',
            at,
          );
        }
        try {
          deliveryPlan = this.materializeDeliveryPlan(proposal, at);
          this.dependencies.repository.applyApprovedDeliveryPlanInTransaction(
            proposal,
            deliveryPlan,
          );
        } catch (error) {
          if (!(error instanceof PlanningProposalInvalidError)) throw error;
          return this.storeFailure(
            envelope,
            requestHash,
            'plan_proposal_invalid',
            'Delivery plan proposal is not valid for approval',
            at,
          );
        }
      } else {
        this.dependencies.repository.settleDeliveryPlanProposalInTransaction(
          proposal.id,
          {
            kind: 'rejected',
            decidedBy: 'human',
            feedback: (
              envelope.command as RejectPlanProposalEnvelope['command']
            ).feedback,
            decidedAt: at,
          },
        );
      }
      this.dependencies.repository.updateCycleInTransaction(
        {
          ...cycle,
          lifecycle: decision === 'approved' ? 'approved' : 'proposal_rejected',
          revision: cycle.revision + 1,
          activeExecutionId: null,
          updatedAt: at,
          endedAt: at,
        },
        cycle.revision,
      );
      const planningCycle = deliveryPlanPlanningCycleViewSchema.parse(
        this.dependencies.repository.cycleView(cycle.id),
      );
      if (decision === 'approved') {
        board = this.board(cycle.projectId);
        event = this.dependencies.events.appendDomainInTransaction(
          cycle.projectId,
          {
            projectId: cycle.projectId,
            occurredAt: at,
            type: 'delivery_plan.approved',
            payload: {
              schemaVersion: 1,
              planningCycle,
              deliveryPlan: deliveryPlan!,
              board,
            },
          },
        );
      } else {
        event = this.dependencies.events.appendDomainInTransaction(
          cycle.projectId,
          {
            projectId: cycle.projectId,
            occurredAt: at,
            type: 'planning_cycle.changed',
            payload: { schemaVersion: 2, planningCycle },
          },
        );
      }
      const success = v2CommandResultSchema.parse(
        decision === 'approved'
          ? {
              ok: true,
              schemaVersion: 2,
              commandType: 'plan_proposal.approve',
              planningCycle,
              deliveryPlan,
              board,
            }
          : {
              ok: true,
              schemaVersion: 2,
              commandType: 'plan_proposal.reject',
              planningCycle,
            },
      );
      this.dependencies.commands.storeInTransaction({
        idempotencyKey: envelope.idempotencyKey,
        commandType: envelope.command.type,
        requestHash,
        result: success,
        createdAt: at,
      });
      return success;
    });
    if (event) this.dependencies.publishDomain?.(event);
    return result;
  }

  private materializeDeliveryPlan(
    proposal: DeliveryPlanProposal,
    at: string,
  ): ApprovedDeliveryPlan {
    const base =
      this.dependencies.repository.approvedDeliveryPlan(proposal.projectId) ??
      null;
    const planRevision = (proposal.base.deliveryPlan.revision ?? 0) + 1;
    const milestoneIds = new Map(
      proposal.reservations.milestones.map(({ key, id }) => [key, id]),
    );
    const taskIds = new Map(
      proposal.reservations.tasks.map(({ key, id }) => [key, id]),
    );
    const dependencyIds = new Map(
      proposal.reservations.dependencies.map(({ key, id }) => [key, id]),
    );
    const resolveMilestone = (ref: ProposedMilestoneRef) =>
      ref.kind === 'canonical' ? ref.milestoneId : milestoneIds.get(ref.key)!;
    const resolveTask = (ref: ProposedTaskRef) =>
      ref.kind === 'canonical' ? ref.taskId : taskIds.get(ref.key)!;
    const milestones = proposal.proposedPlan.milestones.map((member) => {
      if (member.operation === 'reuse') {
        return base!.milestones.find(({ id }) => id === member.milestoneId)!;
      }
      return {
        id:
          member.operation === 'create'
            ? milestoneIds.get(member.key)!
            : member.milestoneId,
        projectId: proposal.projectId,
        revision:
          member.operation === 'create' ? 1 : member.expectedRevision + 1,
        lifecycle:
          member.operation === 'create'
            ? ('active' as const)
            : member.lifecycle,
        ...member.content,
        proposalId: proposal.id,
        deliveryPlanRevision: planRevision,
        approvedAt: at,
      };
    });
    const taskContracts = proposal.proposedPlan.tasks.map((member) => {
      if (member.operation === 'reuse') {
        return base!.taskContracts.find(({ id }) => id === member.taskId)!;
      }
      const { milestone, ...content } = member.content;
      const revision =
        member.operation === 'create' ? 1 : member.expectedCurrentRevision + 1;
      return {
        id:
          member.operation === 'create'
            ? taskIds.get(member.key)!
            : member.taskId,
        projectId: proposal.projectId,
        revision,
        contractRevision: revision,
        revisionKind: 'plan_contract' as const,
        lifecycle:
          member.operation === 'create'
            ? ('pending' as const)
            : member.lifecycle,
        milestoneId: resolveMilestone(milestone),
        ...content,
        source: {
          kind: 'plan' as const,
          proposalId: proposal.id,
          deliveryPlanRevision: planRevision,
        },
        createdAt: at,
      };
    });
    const dependencies = proposal.proposedPlan.dependencies
      .map((member) => {
        if (member.operation === 'reuse') {
          return base!.dependencies.find(
            ({ id }) => id === member.dependencyId,
          )!;
        }
        const prior =
          member.operation === 'revise'
            ? base!.dependencies.find(({ id }) => id === member.dependencyId)!
            : undefined;
        return {
          id:
            member.operation === 'create'
              ? dependencyIds.get(member.key)!
              : member.dependencyId,
          projectId: proposal.projectId,
          revision:
            member.operation === 'create' ? 1 : member.expectedRevision + 1,
          prerequisiteTaskId:
            member.operation === 'create'
              ? resolveTask(member.prerequisite)
              : prior!.prerequisiteTaskId,
          dependentTaskId:
            member.operation === 'create'
              ? resolveTask(member.dependent)
              : prior!.dependentTaskId,
          lifecycle:
            member.operation === 'create'
              ? ('active' as const)
              : member.lifecycle,
          proposalId: proposal.id,
          deliveryPlanRevision: planRevision,
          approvedAt: at,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const milestoneRevisions = new Map(
      milestones.map(({ id, revision }) => [id, revision]),
    );
    const taskRevisions = new Map(
      taskContracts.map(({ id, contractRevision }) => [id, contractRevision]),
    );
    const traces = proposal.proposedPlan.traces.map((trace) => {
      if (trace.kind === 'milestone_covers') {
        const milestoneId = resolveMilestone(trace.milestone);
        return {
          kind: trace.kind,
          milestoneId,
          milestoneRevision: milestoneRevisions.get(milestoneId)!,
          requirement: trace.requirement,
        };
      }
      const taskId = resolveTask(trace.task);
      return {
        kind: trace.kind,
        taskId,
        taskContractRevision: taskRevisions.get(taskId)!,
        requirement: trace.requirement,
      };
    });
    const taskById = new Map(taskContracts.map((task) => [task.id, task]));
    const milestoneEdges = new Map<string, string[]>();
    for (const dependency of dependencies) {
      if (dependency.lifecycle !== 'active') continue;
      const prerequisite = taskById.get(dependency.prerequisiteTaskId)!;
      const dependent = taskById.get(dependency.dependentTaskId)!;
      if (prerequisite.milestoneId === dependent.milestoneId) continue;
      const key = `${prerequisite.milestoneId}:${dependent.milestoneId}`;
      const ids = milestoneEdges.get(key) ?? [];
      ids.push(dependency.id);
      milestoneEdges.set(key, ids);
    }
    return approvedDeliveryPlanSchema.parse({
      plan: {
        id:
          proposal.base.deliveryPlan.id ??
          deliveryPlanIdSchema.parse(randomUUID()),
        projectId: proposal.projectId,
        revision: planRevision,
        projectIntentId: proposal.base.projectIntentId,
        projectIntentRevision: proposal.base.projectIntentRevision,
        ledgerId: proposal.base.ledgerId,
        ledgerRevision: proposal.base.ledgerRevision,
        baseDeliveryPlanRevision: proposal.base.deliveryPlan.revision,
        proposalId: proposal.id,
        summary: proposal.proposedPlan.summary,
        approvedBy: 'human',
        approvedAt: at,
      },
      milestones,
      taskContracts,
      dependencies,
      traces,
      milestoneDependencies: [...milestoneEdges]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, ids]) => {
          const [prerequisiteMilestoneId, dependentMilestoneId] =
            key.split(':');
          return {
            prerequisiteMilestoneId,
            dependentMilestoneId,
            throughTaskDependencyIds: ids.sort(),
          };
        }),
    });
  }

  private async drainTurn(turn: PlanningTurn): Promise<void> {
    const coordinator = this.coordinator(turn.planningCycleId);
    if (coordinator.active) return coordinator.active;
    coordinator.active = (async () => {
      this.dependencies.barrier.assertHealthy();
      if (!this.isLaunchable(turn, coordinator)) return;
      const input = this.launchInput(turn);
      const existing = this.dependencies.launcher.findReserved(input);
      if (existing) {
        this.assertReservation(input, existing);
        if (!this.isLaunchable(turn, coordinator)) {
          await this.cancelStartingReservation(existing);
          return;
        }
        this.bindReservation(turn, existing, true);
        return;
      }
      if (!this.isLaunchable(turn, coordinator)) return;
      this.dependencies.barrier.assertHealthy();
      const reservation = await this.dependencies.launcher.reserve(input);
      this.dependencies.barrier.assertHealthy();
      this.assertReservation(input, reservation);
      if (!this.isLaunchable(turn, coordinator)) {
        await this.cancelStartingReservation(reservation);
        return;
      }
      if (!this.bindReservation(turn, reservation, false)) {
        await this.cancelStartingReservation(reservation);
        return;
      }
      if (coordinator.cancelled || coordinator.cancellationOwners.size > 0) {
        await this.cancelStartingReservation(reservation);
        return;
      }
      if (reservation.activationRequired) {
        this.dependencies.barrier.assertHealthy();
        await this.dependencies.launcher.activate(reservation.execution.id);
        this.dependencies.barrier.assertHealthy();
      }
    })();
    try {
      await coordinator.active;
    } finally {
      coordinator.active = undefined;
    }
  }

  private bindReservation(
    turn: PlanningTurn,
    reservation: PmExecutionReservation,
    recovered: boolean,
  ): boolean {
    let event: DomainEvent | undefined;
    let bound = false;
    this.auditTransaction(() => {
      const current = this.dependencies.repository.turn(turn.id);
      const cycle = this.dependencies.repository.cycle(turn.planningCycleId);
      if (
        current?.launchState === 'execution_bound' &&
        current.executionId === reservation.execution.id &&
        cycle?.lifecycle === 'execution_active'
      ) {
        bound = true;
        return;
      }
      if (
        !current ||
        current.launchState !== 'launch_pending' ||
        !cycle ||
        cycle.lifecycle !== 'launch_pending'
      ) {
        return;
      }
      this.dependencies.repository.bindTurnInTransaction(
        turn.id,
        reservation.execution.id,
      );
      const execution =
        this.dependencies.executions.get(reservation.execution.id) ??
        reservation.execution;
      const attention =
        recovered ||
        execution.lifecycle !== 'starting' ||
        !reservation.activationRequired;
      this.dependencies.repository.updateCycleInTransaction(
        {
          ...cycle,
          lifecycle: attention ? 'attention_required' : 'execution_active',
          activeExecutionId: attention ? null : reservation.execution.id,
          updatedAt: this.now(),
        },
        cycle.revision,
      );
      const planningCycle = this.dependencies.repository.cycleView(cycle.id)!;
      event = this.dependencies.events.appendDomainInTransaction(
        cycle.projectId,
        {
          projectId: cycle.projectId,
          occurredAt: this.now(),
          type: 'planning_cycle.changed',
          payload: { schemaVersion: 2, planningCycle },
        },
      );
      bound = true;
    });
    if (event) this.dependencies.publishDomain?.(event);
    return bound;
  }

  private isLaunchable(
    turn: PlanningTurn,
    coordinator: LaunchCoordinator,
  ): boolean {
    if (coordinator.cancelled || coordinator.cancellationOwners.size > 0) {
      return false;
    }
    const current = this.dependencies.repository.turn(turn.id);
    const cycle = this.dependencies.repository.cycle(turn.planningCycleId);
    return (
      current?.launchState === 'launch_pending' &&
      cycle?.lifecycle === 'launch_pending'
    );
  }

  private async cancelStartingReservation(
    reservation: PmExecutionReservation,
  ): Promise<void> {
    const execution =
      this.dependencies.executions.get(reservation.execution.id) ??
      reservation.execution;
    if (execution.lifecycle === 'starting') {
      this.dependencies.barrier.assertHealthy();
      await this.dependencies.launcher.cancelReserved(execution.id);
      this.dependencies.barrier.assertHealthy();
    }
  }

  private async containExecution(
    executionId: WorkerExecutionId,
  ): Promise<void> {
    let execution = this.dependencies.executions.get(executionId);
    if (!execution) throw new Error('Planning execution was not found');
    if (execution.lifecycle === 'starting') {
      this.dependencies.barrier.assertHealthy();
      await this.dependencies.launcher.cancelReserved(execution.id);
      this.dependencies.barrier.assertHealthy();
      execution = this.dependencies.executions.get(executionId);
    }
    if (
      execution?.lifecycle === 'running' ||
      execution?.lifecycle === 'interrupting'
    ) {
      this.dependencies.barrier.assertHealthy();
      await this.dependencies.launcher.interruptForPlanning(execution.id);
      this.dependencies.barrier.assertHealthy();
      execution = this.dependencies.executions.get(executionId);
    }
    if (!execution || !terminalExecution.has(execution.lifecycle)) {
      throw new Error(
        'Planning execution cleanup did not reach a terminal state',
      );
    }
  }

  private launchInput(turn: PlanningTurn): PmExecutionLaunchInput {
    const view = this.dependencies.repository.cycleView(turn.planningCycleId)!;
    const cycle = view.cycle;
    const targetIndex = view.turns.findIndex(({ id }) => id === turn.id);
    const ledger =
      this.dependencies.repository.approvedIntentLedger(cycle.projectId) ??
      null;
    const conversation = view.turns.slice(0, targetIndex + 1).map((item) => ({
      turnId: item.id,
      actor: item.actor,
      message: item.message,
    }));
    if (view.purpose.kind === 'delivery_plan') {
      if (!ledger) throw new Error('Delivery planning ledger is missing');
      const approvedDeliveryPlan =
        this.dependencies.repository.approvedDeliveryPlan(cycle.projectId) ??
        null;
      return startExecutionEnvelopeSchema.parse({
        idempotencyKey: `planning-turn:${turn.id}`,
        actor: { kind: 'human' },
        command: {
          type: 'worker_execution.start',
          projectId: cycle.projectId,
          profileId: cycle.profileId,
          profileRevision: cycle.profileRevision,
          assignment: {
            kind: 'pm_plan',
            projectId: cycle.projectId,
            outputSchema: PM_PLAN_REPORT_SCHEMA,
            planningCycleId: cycle.id,
            humanTurnId: turn.id,
            expectedCycleRevision: cycle.revision,
            expectedProposalRevision:
              (view.deliveryPlanProposals.at(-1)?.revision ?? 0) + 1,
            baseProjectIntentId: ledger.projectIntent.id,
            baseProjectIntentRevision: ledger.projectIntent.revision,
            baseLedgerId: ledger.ledger.id,
            baseLedgerRevision: ledger.ledger.revision,
            baseDeliveryPlanId: view.purpose.baseDeliveryPlanId,
            baseDeliveryPlanRevision: view.purpose.baseDeliveryPlanRevision,
            input: {
              conversation,
              approvedIntentLedger: ledger,
              latestProposal: view.deliveryPlanProposals.at(-1) ?? null,
              approvedDeliveryPlan,
            },
          },
        },
      });
    }
    return startExecutionEnvelopeSchema.parse({
      idempotencyKey: `planning-turn:${turn.id}`,
      actor: { kind: 'human' },
      command: {
        type: 'worker_execution.start',
        projectId: cycle.projectId,
        profileId: cycle.profileId,
        profileRevision: cycle.profileRevision,
        assignment: {
          kind: 'pm_discovery',
          projectId: cycle.projectId,
          outputSchema: PM_DISCOVERY_REPORT_SCHEMA,
          planningCycleId: cycle.id,
          humanTurnId: turn.id,
          expectedCycleRevision: cycle.revision,
          expectedProposalRevision: cycle.latestProposalRevision + 1,
          baseProjectIntentRevision: cycle.baseProjectIntentRevision,
          baseLedgerRevision: cycle.baseLedgerRevision,
          input: {
            conversation,
            latestProposal: view.proposals.at(-1) ?? null,
            approvedIntentLedger: ledger,
          },
        },
      },
    });
  }

  private assertReservation(
    input: PmExecutionLaunchInput,
    reservation: PmExecutionReservation,
  ): void {
    const execution = reservation.execution;
    const resultExecution =
      reservation.result.ok &&
      reservation.result.commandType === 'worker_execution.start'
        ? reservation.result.execution
        : undefined;
    if (
      execution.projectId !== input.command.projectId ||
      execution.profileId !== input.command.profileId ||
      execution.profileRevision !== input.command.profileRevision ||
      canonicalJson(execution.assignment) !==
        canonicalJson(input.command.assignment) ||
      (resultExecution !== undefined && resultExecution.id !== execution.id)
    ) {
      throw new Error(
        'PM execution reservation does not match its launch input',
      );
    }
  }

  private resolvePmProfile(
    profileId: string,
    revision: number,
    projectId: string,
  ): ResolvedWorkerProfileSnapshot | undefined {
    let profile: ResolvedWorkerProfileSnapshot;
    try {
      profile = this.dependencies.profiles.resolveApproved(profileId, revision);
    } catch {
      return undefined;
    }
    const spec = profile.document.spec;
    return profile.profileId === profileId &&
      profile.profileRevision === revision &&
      (profile.projectId === null || profile.projectId === projectId) &&
      spec.assignmentKinds[0] === 'pm_discovery' &&
      spec.outputSchema === PM_DISCOVERY_REPORT_SCHEMA
      ? profile
      : undefined;
  }

  private resolvePlanProfile(
    profileId: string,
    revision: number,
    projectId: string,
  ): ResolvedWorkerProfileSnapshot | undefined {
    let profile: ResolvedWorkerProfileSnapshot;
    try {
      profile = this.dependencies.profiles.resolveApproved(profileId, revision);
    } catch {
      return undefined;
    }
    const spec = profile.document.spec;
    return profile.profileId === profileId &&
      profile.profileRevision === revision &&
      (profile.projectId === null || profile.projectId === projectId) &&
      spec.assignmentKinds[0] === 'pm_plan' &&
      spec.outputSchema === PM_PLAN_REPORT_SCHEMA
      ? profile
      : undefined;
  }

  private board(projectId: string) {
    const intentLedger =
      this.dependencies.repository.approvedIntentLedger(projectId) ?? null;
    const deliveryPlan =
      this.dependencies.repository.approvedDeliveryPlan(projectId) ?? null;
    return projectBoard({
      projectId,
      intentLedger,
      deliveryPlan,
      currentTaskRevisions: deliveryPlan
        ? this.dependencies.repository.currentTaskRevisions(deliveryPlan)
        : [],
      filter: this.dependencies.repository.boardFilter(projectId) ?? null,
    });
  }

  private coordinator(cycleId: string): LaunchCoordinator {
    let coordinator = this.coordinators.get(cycleId);
    if (!coordinator) {
      coordinator = { cancelled: false, cancellationOwners: new Set() };
      this.coordinators.set(cycleId, coordinator);
    }
    return coordinator;
  }

  private storeStandaloneFailure(
    envelope: AbandonPlanningCycleEnvelope,
    requestHash: string,
    code: Extract<V2CommandResult, { ok: false }>['error']['code'],
    message: string,
  ): V2CommandResult {
    return this.auditTransaction(() =>
      this.storeFailure(envelope, requestHash, code, message, this.now()),
    );
  }

  private storeFailure(
    envelope:
      | SubmitPlanningTurnEnvelope
      | SubmitPlanTurnEnvelope
      | ApprovePlanningProposalEnvelope
      | RejectPlanningProposalEnvelope
      | AbandonPlanningCycleEnvelope
      | ApprovePlanProposalEnvelope
      | RejectPlanProposalEnvelope
      | SetBoardFilterEnvelope,
    requestHash: string,
    code: Extract<V2CommandResult, { ok: false }>['error']['code'],
    message: string,
    at: string,
  ): V2CommandResult {
    const result = failure(envelope.command.type, code, message);
    this.dependencies.commands.storeInTransaction({
      idempotencyKey: envelope.idempotencyKey,
      commandType: envelope.command.type,
      requestHash,
      result,
      createdAt: at,
    });
    return result;
  }

  private auditTransaction<T>(work: () => T): T {
    this.dependencies.barrier.assertHealthy();
    try {
      return inImmediateTransaction(this.dependencies.database, work);
    } catch (error) {
      if (error instanceof V2IdempotencyConflictError) throw error;
      this.dependencies.barrier.trip(error, this.now());
      throw error;
    }
  }
}
