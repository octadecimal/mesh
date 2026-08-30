import { randomUUID } from 'node:crypto';

import {
  abandonPlanningCycleEnvelopeSchema,
  approvePlanningProposalEnvelopeSchema,
  PM_DISCOVERY_REPORT_SCHEMA,
  rejectPlanningProposalEnvelopeSchema,
  startExecutionEnvelopeSchema,
  submitPlanningTurnEnvelopeSchema,
  v2CommandResultSchema,
  type AbandonPlanningCycleEnvelope,
  type ApprovePlanningProposalEnvelope,
  type DomainEvent,
  type PlanningCycle,
  type PlanningTurn,
  type RejectPlanningProposalEnvelope,
  type ResolvedWorkerProfileSnapshot,
  type StartExecutionEnvelope,
  type SubmitPlanningTurnEnvelope,
  type V2CommandResult,
  type WorkerExecution,
  type WorkerExecutionId,
} from '@mesh/v2-contracts';

import { inImmediateTransaction, type V2Database } from '../db/database.js';
import type { AuditBarrier } from '../executions/audit-barrier.js';
import type { ExecutionRepository } from '../executions/execution-repository.js';
import {
  hashV2Command,
  type V2CommandRepository,
} from '../storage/command-repository.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { V2EventStore } from '../storage/event-store.js';
import type { PmReportConsumer } from './pm-report-consumer.js';
import { PlanningRepository } from './planning-repository.js';

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

type LaunchCoordinator = { cancelled: boolean; active?: Promise<void> };

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
        const profile = this.resolvePmProfile(
          envelope.command.profileId,
          envelope.command.profileRevision,
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
          id: randomUUID(),
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
          32
        ) {
          return this.storeFailure(
            envelope,
            requestHash,
            'planning_cycle_history_limit',
            'Planning cycle reached its human-turn limit',
            at,
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
        id: randomUUID(),
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
          payload: { planningCycle },
        },
      );
      const success = v2CommandResultSchema.parse({
        ok: true,
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

  approveProposal(input: ApprovePlanningProposalEnvelope): V2CommandResult {
    return this.decideProposal(
      approvePlanningProposalEnvelopeSchema.parse(input),
      'approved',
    );
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
    coordinator.cancelled = true;
    await coordinator.active;
    const refreshed = this.dependencies.repository.cycle(cycle.id)!;
    const turns = this.dependencies.repository.cycleView(cycle.id)?.turns ?? [];
    const boundTurn = [...turns]
      .reverse()
      .find(
        (candidate) =>
          candidate.actor === 'human' && candidate.executionId !== null,
      );
    const executionId =
      refreshed.activeExecutionId ?? boundTurn?.executionId ?? null;
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
      const execution = this.dependencies.executions.get(executionId);
      if (execution?.lifecycle === 'starting') {
        await this.dependencies.launcher.cancelReserved(execution.id);
      } else if (
        execution?.lifecycle === 'running' ||
        execution?.lifecycle === 'interrupting'
      ) {
        await this.dependencies.launcher.interruptForPlanning(execution.id);
      }
    }

    let event: DomainEvent | undefined;
    const result = this.auditTransaction(() => {
      const current = this.dependencies.repository.cycle(cycle.id)!;
      const at = this.now();
      const view = this.dependencies.repository.cycleView(cycle.id)!;
      const latest = view.proposals.at(-1);
      if (latest?.lifecycle === 'awaiting_approval') {
        this.dependencies.repository.updateProposalInTransaction({
          ...latest,
          lifecycle: 'superseded',
          decidedAt: at,
        });
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
      const planningCycle = this.dependencies.repository.cycleView(cycle.id)!;
      event = this.dependencies.events.appendDomainInTransaction(
        cycle.projectId,
        {
          projectId: cycle.projectId,
          occurredAt: at,
          type: 'planning_cycle.changed',
          payload: { planningCycle },
        },
      );
      const success = v2CommandResultSchema.parse({
        ok: true,
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
    if (event) this.dependencies.publishDomain?.(event);
    return result;
  }

  reconcilePendingReservations(): void {
    for (const turn of this.dependencies.repository.pendingLaunchTurns()) {
      const input = this.launchInput(turn);
      const reservation = this.dependencies.launcher.findReserved(input);
      if (reservation) {
        this.assertReservation(input, reservation);
        this.bindReservation(turn, reservation, true);
      }
    }
  }

  async drainPendingLaunches(): Promise<void> {
    await Promise.all(
      this.dependencies.repository
        .pendingLaunchTurns()
        .map((turn) => this.drainTurn(turn)),
    );
  }

  reconcileBoundCycles(): void {
    for (const turn of this.dependencies.repository.boundOpenTurns()) {
      const execution = this.dependencies.executions.get(turn.executionId!);
      if (execution && !this.dependencies.repository.receipt(execution.id)) {
        const output = this.dependencies.events
          .runtimeAfter(turn.projectId, 0)
          .events.find(
            (event) =>
              event.executionId === execution.id &&
              event.type === 'worker_execution.structured_output',
          );
        if (output?.type === 'worker_execution.structured_output') {
          this.dependencies.reportConsumer.consume(execution, output);
        }
      }
      this.reconcileTerminalExecution(turn.executionId!);
    }
  }

  reconcileTerminalExecution(executionId: WorkerExecutionId): void {
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
          payload: { planningCycle },
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
        intentLedger =
          this.dependencies.repository.applyApprovedProposalInTransaction(
            proposal,
            at,
          );
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
            payload: { planningCycle, intentLedger: intentLedger! },
          },
        );
      } else {
        event = this.dependencies.events.appendDomainInTransaction(
          cycle.projectId,
          {
            projectId: cycle.projectId,
            occurredAt: at,
            type: 'planning_cycle.changed',
            payload: { planningCycle },
          },
        );
      }
      const success = v2CommandResultSchema.parse(
        decision === 'approved'
          ? {
              ok: true,
              commandType: 'planning_proposal.approve',
              planningCycle,
              intentLedger,
            }
          : {
              ok: true,
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

  private async drainTurn(turn: PlanningTurn): Promise<void> {
    const coordinator = this.coordinator(turn.planningCycleId);
    if (coordinator.active) return coordinator.active;
    coordinator.active = (async () => {
      const input = this.launchInput(turn);
      const existing = this.dependencies.launcher.findReserved(input);
      if (existing) {
        this.assertReservation(input, existing);
        this.bindReservation(turn, existing, true);
        return;
      }
      const reservation = await this.dependencies.launcher.reserve(input);
      this.assertReservation(input, reservation);
      if (coordinator.cancelled) {
        if (reservation.execution.lifecycle === 'starting') {
          await this.dependencies.launcher.cancelReserved(
            reservation.execution.id,
          );
        }
        return;
      }
      this.bindReservation(turn, reservation, false);
      if (coordinator.cancelled) {
        const execution = this.dependencies.executions.get(
          reservation.execution.id,
        );
        if (execution?.lifecycle === 'starting') {
          await this.dependencies.launcher.cancelReserved(execution.id);
        }
        return;
      }
      if (reservation.activationRequired) {
        await this.dependencies.launcher.activate(reservation.execution.id);
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
  ): void {
    const current = this.dependencies.repository.turn(turn.id);
    if (!current || current.launchState === 'execution_bound') return;
    let event: DomainEvent | undefined;
    this.auditTransaction(() => {
      this.dependencies.repository.bindTurnInTransaction(
        turn.id,
        reservation.execution.id,
      );
      const cycle = this.dependencies.repository.cycle(turn.planningCycleId)!;
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
          payload: { planningCycle },
        },
      );
    });
    if (event) this.dependencies.publishDomain?.(event);
  }

  private launchInput(turn: PlanningTurn): PmExecutionLaunchInput {
    const view = this.dependencies.repository.cycleView(turn.planningCycleId)!;
    const cycle = view.cycle;
    const targetIndex = view.turns.findIndex(({ id }) => id === turn.id);
    const ledger =
      this.dependencies.repository.approvedIntentLedger(cycle.projectId) ??
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
            conversation: view.turns.slice(0, targetIndex + 1).map((item) => ({
              turnId: item.id,
              actor: item.actor,
              message: item.message,
            })),
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
      spec.assignmentKinds.includes('pm_discovery') &&
      spec.outputSchema === PM_DISCOVERY_REPORT_SCHEMA
      ? profile
      : undefined;
  }

  private coordinator(cycleId: string): LaunchCoordinator {
    let coordinator = this.coordinators.get(cycleId);
    if (!coordinator) {
      coordinator = { cancelled: false };
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
      | ApprovePlanningProposalEnvelope
      | RejectPlanningProposalEnvelope
      | AbandonPlanningCycleEnvelope,
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
    try {
      return inImmediateTransaction(this.dependencies.database, work);
    } catch (error) {
      this.dependencies.barrier.trip(error, this.now());
      throw error;
    }
  }
}
